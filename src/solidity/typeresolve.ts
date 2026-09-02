/**
 * Cross-file type resolution: which unit, struct, enum, or user defined
 * value type a bare name refers to, and the canonical ABI type of any
 * source-level type spelling.
 *
 * Two units may share a name across different files (two `ErrorsLib`
 * libraries is a real, common case). This module keeps every candidate and
 * picks the one reachable through the import graph of the file making the
 * reference; only when that is inconclusive does it fall back to the last
 * declaration seen, which is a documented simplification, never a silent
 * wrong answer.
 */

import { signatureOf } from "../abi";
import type { AbiEntry, AbiParam } from "../types";
import type { FreeTypes, ParsedEvent, ParsedFunction, ParsedModifierDecl, ParsedParam, ParsedStateVar, ParsedStruct, ParsedEnum, ParsedUserType, ParsedUnit, ParsedUsing } from "./parse";

export interface FileUnits {
  path: string;
  content: string;
  units: ParsedUnit[];
  freeTypes: FreeTypes;
}

export interface MemberFn {
  fn: ParsedFunction;
  file: string;
}

export interface MemberModifier {
  decl: ParsedModifierDecl;
  file: string;
}

export interface MemberTable {
  stateVars: Map<string, ParsedStateVar>;
  functions: Map<string, MemberFn[]>;
  modifiers: Map<string, MemberModifier>;
  events: Map<string, ParsedEvent>;
  using: ParsedUsing[];
}

export interface TypeRegistry {
  resolveUnit(name: string, callingFile: string): ParsedUnit | undefined;
  /** Most-derived-first, left-to-right, cross-file inheritance flattening. */
  linearize(unitName: string, unitFile: string): { name: string; file: string }[];
  memberTable(unitName: string, unitFile: string): MemberTable;
  findMemberFunction(unitName: string, unitFile: string, fnName: string): MemberFn | undefined;
  /** `using` directives visible from `callingFile`: the unit's own plus every free/global one. */
  usingInScope(unitUsing: ParsedUsing[], callingFile: string): ParsedUsing[];
  /** Resolves one source-level type to its ABI shape, expanding structs to tuples. `undefined` when unresolvable. */
  resolveAbiParam(p: ParsedParam, callingFile: string): AbiParam | undefined;
  /** Canonical function signature when every parameter resolves; `undefined` otherwise. */
  canonicalSignature(name: string, params: ParsedParam[], callingFile: string): string | undefined;
  isKnownUnit(name: string, callingFile: string): boolean;
}

function pushMulti<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Extracts every `import` target string from raw (un-stripped) source text. */
function extractImportSpecs(content: string): string[] {
  const specs: string[] = [];
  const re = /\bimport\b[^;]*?["']([^"']+)["'][^;]*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) specs.push(m[1] ?? "");
  return specs;
}

/** Resolves one import specifier against the known file paths, relative-first, then by suffix or basename. */
function resolveImportPath(spec: string, ownPath: string, knownPaths: string[]): string | undefined {
  if (spec.startsWith(".")) {
    const ownDir = ownPath.split("/").slice(0, -1);
    const stack = [...ownDir];
    for (const part of spec.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const joined = stack.join("/");
    if (knownPaths.includes(joined)) return joined;
  }
  const bySuffix = knownPaths.find((p) => p.endsWith(`/${spec}`) || p === spec);
  if (bySuffix) return bySuffix;
  const base = spec.split("/").pop();
  return knownPaths.find((p) => p.split("/").pop() === base);
}

/** File -> the set of files transitively reachable through `import`, including itself. */
function buildImportReach(files: FileUnits[]): Map<string, Set<string>> {
  const knownPaths = files.map((f) => f.path);
  const directImports = new Map<string, string[]>();
  for (const f of files) {
    const targets = extractImportSpecs(f.content)
      .map((spec) => resolveImportPath(spec, f.path, knownPaths))
      .filter((p): p is string => p !== undefined);
    directImports.set(f.path, targets);
  }
  const reach = new Map<string, Set<string>>();
  for (const f of files) {
    const seen = new Set<string>([f.path]);
    const queue = [...(directImports.get(f.path) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(directImports.get(next) ?? []));
    }
    reach.set(f.path, seen);
  }
  return reach;
}

function pickCandidate<T extends { file: string }>(candidates: T[] | undefined, callingFile: string, reach: Map<string, Set<string>>): T | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const r = reach.get(callingFile);
  if (r) {
    const inReach = candidates.filter((c) => r.has(c.file));
    if (inReach.length >= 1) return inReach[inReach.length - 1];
  }
  return candidates[candidates.length - 1];
}

const PRIMITIVE_TYPE = /^(address(\s+payable)?|bool|string|bytes\d*|u?int\d*)$/;

function isPrimitiveType(t: string): boolean {
  return PRIMITIVE_TYPE.test(t.trim());
}

function normalizePrimitive(t: string): string {
  const trimmed = t.trim();
  if (trimmed === "address payable") return "address";
  if (/^u?int$/.test(trimmed)) return `${trimmed}256`;
  return trimmed;
}

/** Splits a trailing array suffix, e.g. `MarketParams[3][]` -> `{ base: "MarketParams", suffix: "[3][]" }`. */
function splitArraySuffix(t: string): { base: string; suffix: string } {
  const m = /^(.*?)((?:\s*\[\s*\d*\s*\])+)$/.exec(t.trim());
  if (!m) return { base: t.trim(), suffix: "" };
  return { base: (m[1] ?? "").trim(), suffix: (m[2] ?? "").replace(/\s+/g, "") };
}

/** Builds the registry from every parsed file. Never mutates its inputs. */
export function buildTypeRegistry(files: FileUnits[]): TypeRegistry {
  const unitsByNameAll = new Map<string, ParsedUnit[]>();
  const structsByName = new Map<string, ParsedStruct[]>();
  const enumsByName = new Map<string, ParsedEnum[]>();
  const userTypesByName = new Map<string, ParsedUserType[]>();
  const globalUsing: ParsedUsing[] = [];

  for (const f of files) {
    for (const u of f.units) pushMulti(unitsByNameAll, u.name, u);
    for (const s of f.freeTypes.structs) pushMulti(structsByName, s.name, s);
    for (const e of f.freeTypes.enums) pushMulti(enumsByName, e.name, e);
    for (const t of f.freeTypes.userTypes) pushMulti(userTypesByName, t.name, t);
    for (const u of f.freeTypes.using) globalUsing.push(u);
    for (const u of f.units) {
      for (const s of u.structs) pushMulti(structsByName, s.name, s);
      for (const e of u.enums) pushMulti(enumsByName, e.name, e);
      for (const t of u.userTypes) pushMulti(userTypesByName, t.name, t);
    }
  }

  const reach = buildImportReach(files);

  function resolveUnit(name: string, callingFile: string): ParsedUnit | undefined {
    return pickCandidate(unitsByNameAll.get(name), callingFile, reach);
  }
  function resolveStruct(name: string, callingFile: string): ParsedStruct | undefined {
    return pickCandidate(structsByName.get(name), callingFile, reach);
  }
  function resolveEnum(name: string, callingFile: string): ParsedEnum | undefined {
    return pickCandidate(enumsByName.get(name), callingFile, reach);
  }
  function resolveUserType(name: string, callingFile: string): ParsedUserType | undefined {
    return pickCandidate(userTypesByName.get(name), callingFile, reach);
  }
  function isKnownUnit(name: string, callingFile: string): boolean {
    return resolveUnit(name, callingFile) !== undefined;
  }

  function linearize(unitName: string, unitFile: string): { name: string; file: string }[] {
    const seenKeys = new Set<string>();
    const chain: { name: string; file: string }[] = [];
    const walk = (name: string, file: string): void => {
      const unit = resolveUnit(name, file);
      if (!unit) return;
      const key = `${unit.name}@${unit.file}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      chain.push({ name: unit.name, file: unit.file });
      for (const base of unit.inherits) walk(base, unit.file);
    };
    walk(unitName, unitFile);
    return chain;
  }

  function memberTable(unitName: string, unitFile: string): MemberTable {
    const chain = linearize(unitName, unitFile);
    const stateVars = new Map<string, ParsedStateVar>();
    const functions = new Map<string, MemberFn[]>();
    const modifiers = new Map<string, MemberModifier>();
    const events = new Map<string, ParsedEvent>();
    const using: ParsedUsing[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      const unit = c ? resolveUnit(c.name, c.file) : undefined;
      if (!unit) continue;
      for (const v of unit.stateVars) stateVars.set(v.name, v);
      for (const fn of unit.functions) {
        if (fn.kind !== "function" || fn.name === "") continue;
        const list = functions.get(fn.name) ?? [];
        const existingIdx = list.findIndex((m) => m.fn.params.length === fn.params.length && m.fn.params.every((p, idx) => p.type === fn.params[idx]?.type));
        if (existingIdx === -1) list.push({ fn, file: unit.file });
        else list[existingIdx] = { fn, file: unit.file };
        functions.set(fn.name, list);
      }
      for (const mo of unit.modifiers) modifiers.set(mo.name, { decl: mo, file: unit.file });
      for (const ev of unit.events) events.set(ev.name, ev);
      using.push(...unit.using);
    }
    return { stateVars, functions, modifiers, events, using };
  }

  function findMemberFunction(unitName: string, unitFile: string, fnName: string): MemberFn | undefined {
    for (const c of linearize(unitName, unitFile)) {
      const unit = resolveUnit(c.name, c.file);
      const fn = unit?.functions.find((f) => f.kind === "function" && f.name === fnName);
      if (fn && unit) return { fn, file: unit.file };
    }
    return undefined;
  }

  /** Every free (file-level) `using` directive is treated as reachable: `global` scoping is not tracked precisely, a documented simplification favouring resolution over strict scope. */
  function usingInScope(unitUsing: ParsedUsing[], _callingFile: string): ParsedUsing[] {
    return [...unitUsing, ...globalUsing];
  }
  function resolveAbiParam(p: ParsedParam, callingFile: string, seen: Set<string> = new Set()): AbiParam | undefined {
    const { base, suffix } = splitArraySuffix(p.type);
    if (isPrimitiveType(base)) return { name: p.name, type: normalizePrimitive(base) + suffix };
    const struct = resolveStruct(base, callingFile);
    if (struct) {
      const key = `${struct.name}@${struct.file}`;
      if (seen.has(key)) return undefined;
      const seen2 = new Set(seen);
      seen2.add(key);
      const components: AbiParam[] = [];
      for (const m of struct.members) {
        const c = resolveAbiParam(m, struct.file, seen2);
        if (!c) return undefined;
        components.push(c);
      }
      return { name: p.name, type: `tuple${suffix}`, components };
    }
    const en = resolveEnum(base, callingFile);
    if (en) return { name: p.name, type: `uint8${suffix}` };
    const ut = resolveUserType(base, callingFile);
    if (ut) {
      const underlying = isPrimitiveType(ut.underlying) ? normalizePrimitive(ut.underlying) : ut.underlying;
      return isPrimitiveType(underlying) ? { name: p.name, type: underlying + suffix } : undefined;
    }
    if (isKnownUnit(base, callingFile)) return { name: p.name, type: `address${suffix}` };
    return undefined;
  }

  function canonicalSignature(name: string, params: ParsedParam[], callingFile: string): string | undefined {
    const inputs: AbiParam[] = [];
    for (const p of params) {
      const r = resolveAbiParam(p, callingFile);
      if (!r) return undefined;
      inputs.push(r);
    }
    const entry: AbiEntry = { type: "function", name, inputs };
    return signatureOf(entry);
  }

  return { resolveUnit, linearize, memberTable, findMemberFunction, usingInScope, resolveAbiParam, canonicalSignature, isKnownUnit };
}
