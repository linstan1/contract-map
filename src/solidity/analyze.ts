/**
 * Builds the exposed-function call graph for one deployed contract from its
 * parsed units: state reads/writes, internal calls, external calls, events,
 * and access control.
 *
 * This is a targeted resolution, not symbolic execution. Every fact it
 * reports is backed by a source-text match. A signature is only hashed into
 * a selector when every parameter type resolved to a real canonical ABI
 * type through the `TypeRegistry`; an unresolved type never gets guessed
 * and never gets hashed, so a wrong selector is never produced.
 */

import { selectorOf } from "../abi";
import type { AccessControl, AbiParam, CallType, DestinationHint, FunctionAnalysis, Mutability, StateAccess, StaticExternalCall, StaticInternalCall } from "../types";
import type { ParsedFunction, ParsedUnit, ParsedUsing } from "./parse";
import { lineAtOffset, lineTextAt } from "./lex";
import type { MemberTable, TypeRegistry } from "./typeresolve";

const MAX_DEPTH = 12;

export interface SourceLookup {
  clean: string;
  original: string;
  lineStarts: number[];
  path: string;
}

interface WalkCtx {
  registry: TypeRegistry;
  member: MemberTable;
  chain: { name: string; file: string }[];
  sourceByFile: Map<string, SourceLookup>;
  warnings: string[];
}

interface Accumulator {
  reads: Map<string, StateAccess>;
  writes: Map<string, StateAccess>;
  internalCalls: StaticInternalCall[];
  externalCalls: StaticExternalCall[];
  events: Set<string>;
  notes: Set<string>;
}

function newAccumulator(): Accumulator {
  return { reads: new Map(), writes: new Map(), internalCalls: [], externalCalls: [], events: new Set(), notes: new Set() };
}

function sourceRef(ctx: WalkCtx, file: string, offsetInClean: number): { file: string; line: number; snippet: string } | undefined {
  const src = ctx.sourceByFile.get(file);
  if (!src) return undefined;
  const line = lineAtOffset(src.lineStarts, offsetInClean);
  const snippet = lineTextAt(src.original, src.lineStarts, line);
  return { file: src.path, line, snippet };
}

const WRITE_OP = /^\s*(\*\*=|<<=|>>=|&&=|\|\|=|[-+*/%&|^]=|=(?!=))/;
const INCDEC = /^\s*(\+\+|--)/;

/** Consumes a chained `[...]`/`.member` suffix starting at `from`, returns the offset just after it. */
function consumeChain(body: string, from: number): { end: number; lastMember: string } {
  let i = from;
  let lastMember = "";
  for (;;) {
    while (i < body.length && /\s/.test(body[i] ?? "")) i++;
    if (body[i] === "[") {
      const close = findMatchingBracket(body, i);
      if (close === -1) break;
      i = close + 1;
      lastMember = "";
      continue;
    }
    if (body[i] === "." && /[A-Za-z_$]/.test(body[i + 1] ?? "")) {
      const m = /^\.\s*([A-Za-z_$][\w$]*)/.exec(body.slice(i));
      if (!m) break;
      lastMember = m[1] ?? "";
      i += m[0].length;
      continue;
    }
    break;
  }
  return { end: i, lastMember };
}

function findMatchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Scans `body` for occurrences of state variable `name`, classifying each as a read or a write. */
function scanStateAccess(body: string, name: string, member: MemberTable, unitName: string, via: string[], acc: Accumulator): void {
  const re = new RegExp(`(?<![.\\w$])${escapeRegExp(name)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const start = m.index;
    const before = body.slice(Math.max(0, start - 8), start);
    if (/\bdelete\s*$/.test(before)) {
      addAccess(acc.writes, name, member, unitName, via);
      continue;
    }
    const { end, lastMember } = consumeChain(body, start + name.length);
    const after = body.slice(end);
    if (INCDEC.test(after)) {
      addAccess(acc.writes, name, member, unitName, via);
    } else if (WRITE_OP.test(after)) {
      addAccess(acc.writes, name, member, unitName, via);
    } else if ((lastMember === "push" || lastMember === "pop") && /^\s*\(/.test(after)) {
      addAccess(acc.writes, name, member, unitName, via);
    } else {
      addAccess(acc.reads, name, member, unitName, via);
    }
  }
}

function addAccess(map: Map<string, StateAccess>, name: string, member: MemberTable, unitName: string, via: string[]): void {
  const key = `${name}|${via.join(">")}`;
  if (map.has(key)) return;
  const decl = member.stateVars.get(name);
  map.set(key, { name, type: decl?.type, declaredIn: decl?.declaredIn ?? unitName, via: [...via] });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Local/param variable types visible in one function body, for destination resolution. */
function collectLocalTypes(fn: ParsedFunction, body: string, registry: TypeRegistry, unitFile: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const p of fn.params) if (p.name) types.set(p.name, p.type);
  const declRe = /\b([A-Z][\w$]*)\s+(?:memory|storage|calldata)?\s*([A-Za-z_$][\w$]*)\s*(=|;)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(body)) !== null) {
    const type = m[1] ?? "";
    const varName = m[2] ?? "";
    if (registry.isKnownUnit(type, unitFile)) types.set(varName, type);
  }
  return types;
}

function destinationFor(expr: string, member: MemberTable, localTypes: Map<string, string>): DestinationHint {
  const trimmed = expr.trim();
  if (trimmed === "address(this)" || trimmed === "this") return { kind: "literal", address: undefined, name: "this" };
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { kind: "literal", address: trimmed };
  const bare = trimmed.match(/^[A-Za-z_$][\w$]*$/) ? trimmed : undefined;
  if (bare) {
    const stateVar = member.stateVars.get(bare);
    if (stateVar) return { kind: stateVar.immutable ? "immutable" : stateVar.constant ? "constant" : "state", name: bare, contractType: stateVar.type };
    const localType = localTypes.get(bare);
    if (localType) return { kind: "parameter", name: bare, contractType: localType };
  }
  return { kind: "unknown", name: trimmed.length <= 40 ? trimmed : undefined };
}

/**
 * Resolves a destination expression, first checking whether it names a
 * parameter that a caller substituted with its own real destination (a
 * library wraps the caller's argument through its own parameter of the
 * same name), then falling back to normal resolution in the local scope.
 */
function resolveDestination(expr: string, member: MemberTable, localTypes: Map<string, string>, subst: Map<string, DestinationHint>): DestinationHint {
  const bare = expr.trim().match(/^[A-Za-z_$][\w$]*$/) ? expr.trim() : undefined;
  if (bare) {
    const sub = subst.get(bare);
    if (sub) return sub;
  }
  return destinationFor(expr, member, localTypes);
}

interface DotCall {
  receiver: string;
  fnName: string;
  argsStart: number;
  argsEnd: number;
  callOffset: number;
}

/** Finds `Name(expr).fn(` cast-style external calls. */
function findCastCalls(body: string): DotCall[] {
  const out: DotCall[] = [];
  const re = /\b([A-Z][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const close = findMatchingParenAt(body, openIdx);
    if (close === -1) continue;
    let j = close + 1;
    while (j < body.length && /\s/.test(body[j] ?? "")) j++;
    if (body[j] !== ".") {
      re.lastIndex = openIdx + 1;
      continue;
    }
    const dotMatch = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(body.slice(j));
    if (!dotMatch) {
      re.lastIndex = openIdx + 1;
      continue;
    }
    const fnName = dotMatch[1] ?? "";
    const callOffset = j + dotMatch[0].length - 1;
    const argsClose = findMatchingParenAt(body, callOffset);
    out.push({
      receiver: `${m[1]}(${body.slice(openIdx + 1, close)})`,
      fnName,
      argsStart: callOffset + 1,
      argsEnd: argsClose === -1 ? body.length : argsClose,
      callOffset,
    });
    re.lastIndex = (argsClose === -1 ? body.length : argsClose) + 1;
  }
  return out;
}

function findMatchingParenAt(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Finds `var.fn(` calls where `var` is a bare identifier (not a `Name(...)` cast). */
function findDotVarCalls(body: string): DotCall[] {
  const out: DotCall[] = [];
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const receiver = m[1] ?? "";
    const fnName = m[2] ?? "";
    if (["abi", "msg", "block", "tx", "super", "type"].includes(receiver)) continue;
    if (["call", "staticcall", "delegatecall", "transfer", "send"].includes(fnName)) continue;
    const before = body.slice(Math.max(0, m.index - 8), m.index);
    if (/\bemit\s*$/.test(before)) continue;
    const argsStart = m.index + m[0].length;
    const argsClose = findMatchingParenAt(body, argsStart - 1);
    out.push({ receiver, fnName, argsStart, argsEnd: argsClose === -1 ? body.length : argsClose, callOffset: argsStart - 1 });
  }
  return out;
}

interface SuperCall {
  fnName: string;
  argsStart: number;
  argsEnd: number;
  callOffset: number;
}

/** Finds `super.fnName(args)` calls: dispatched to the next unit in the inheritance chain, not to any interface or library. */
function findSuperCalls(body: string): SuperCall[] {
  const out: SuperCall[] = [];
  const re = /(?<![.\w$])super\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const argsStart = m.index + m[0].length;
    const argsClose = findMatchingParenAt(body, argsStart - 1);
    out.push({ fnName: m[1] ?? "", argsStart, argsEnd: argsClose === -1 ? body.length : argsClose, callOffset: argsStart - 1 });
  }
  return out;
}

/**
 * Finds `abi.encodeCall(receiver.fnName, (args))` call-data construction.
 * This is the canonical OpenZeppelin `SafeERC20` pattern: the function
 * reference has no trailing parens (it is not itself a call), so it is
 * invisible to `findDotVarCalls`. Constructing calldata this way names the
 * destination function unambiguously, so it is treated as the external
 * call site, exactly like a direct `receiver.fnName(args)` call.
 */
function findEncodeCallRefs(body: string): DotCall[] {
  const out: DotCall[] = [];
  const re = /\babi\.encodeCall\s*\(\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*,\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const argsStart = m.index + m[0].length;
    const openParenIdx = argsStart - 1;
    const close = findMatchingParenAt(body, openParenIdx);
    out.push({
      receiver: m[1] ?? "",
      fnName: m[2] ?? "",
      argsStart,
      argsEnd: close === -1 ? body.length : close,
      callOffset: m.index,
    });
  }
  return out;
}

function callTypeForMutability(mutability: Mutability | undefined): CallType {
  return mutability === "view" || mutability === "pure" ? "staticcall" : "call";
}

function findUnitFunction(unit: ParsedUnit, name: string): ParsedFunction | undefined {
  return unit.functions.find((f) => f.kind === "function" && f.name === name);
}

/**
 * Resolves `super.fnName(...)`: the next unit after `declaredIn` in the
 * deployed contract's linearised chain that declares `fnName` directly.
 * This mirrors Solidity's own dispatch: `super` always means "the next
 * base in the linearisation from here", never the most-derived override.
 */
function resolveSuperCall(ctx: WalkCtx, declaredIn: string, declaredInFile: string, fnName: string): { fn: ParsedFunction; file: string } | undefined {
  const idx = ctx.chain.findIndex((c) => c.name === declaredIn && c.file === declaredInFile);
  if (idx === -1) return undefined;
  for (let i = idx + 1; i < ctx.chain.length; i++) {
    const c = ctx.chain[i];
    if (!c) continue;
    const unit = ctx.registry.resolveUnit(c.name, c.file);
    const fn = unit?.functions.find((f) => f.kind === "function" && f.name === fnName);
    if (fn && unit) return { fn, file: unit.file };
  }
  return undefined;
}

/**
 * Resolves a `using X for Y` directive offering `fnName`. Tries an exact
 * type match first; when `varType` could not be resolved to a real unit
 * (most likely a primitive local the parser does not track), falls back to
 * any in-scope directive over a non-unit (primitive) type whose library has
 * the function. The fallback is a documented, best-effort simplification:
 * it is still grounded in a real declared `using` directive and a real
 * library function, never a fabricated one.
 */
function findUsingLibrary(ctx: WalkCtx, callingFile: string, unitUsing: ParsedUsing[], varType: string, varTypeIsKnownUnit: boolean, fnName: string): ParsedUnit | undefined {
  const scoped = ctx.registry.usingInScope(unitUsing, callingFile);
  for (const u of scoped) {
    if (u.forType !== "*" && u.forType !== varType && !(varType.length > 0 && varType.startsWith(u.forType))) continue;
    const lib = ctx.registry.resolveUnit(u.library, callingFile);
    if (lib && lib.kind === "library" && findUnitFunction(lib, fnName)) return lib;
  }
  if (varTypeIsKnownUnit) return undefined;
  for (const u of scoped) {
    if (u.forType !== "*" && ctx.registry.isKnownUnit(u.forType, callingFile)) continue;
    const lib = ctx.registry.resolveUnit(u.library, callingFile);
    if (lib && lib.kind === "library" && findUnitFunction(lib, fnName)) return lib;
  }
  return undefined;
}

function argCountOf(argsText: string): number {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return 0;
  return splitArgsTopLevel(trimmed).length;
}

function splitArgsTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function resolveDotCall(
  call: DotCall,
  isCast: boolean,
  ctx: WalkCtx,
  curFile: string,
  unitUsing: ParsedUsing[],
  body: string,
  bodyOffset: number,
  localTypes: Map<string, string>,
  subst: Map<string, DestinationHint>,
  via: string[],
  depth: number,
  acc: Accumulator,
  visited: Set<string>,
): void {
  const argsText = body.slice(call.argsStart, call.argsEnd);
  const argCount = argCountOf(argsText);

  if (isCast) {
    const castMatch = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(call.receiver);
    const typeName = castMatch?.[1] ?? "";
    const innerExpr = castMatch?.[2] ?? "";
    const targetUnit = ctx.registry.resolveUnit(typeName, curFile);
    if (targetUnit && targetUnit.kind === "library") {
      // Not a real cast shape; treat below as unresolved.
    } else if (targetUnit) {
      const found = ctx.registry.findMemberFunction(targetUnit.name, targetUnit.file, call.fnName);
      pushExternalCall(ctx, acc, curFile, bodyOffset, call, via, typeName, resolveDestination(innerExpr, ctx.member, localTypes, subst), found, argCount, `${call.receiver}.${call.fnName}`);
      return;
    } else {
      pushExternalCall(ctx, acc, curFile, bodyOffset, call, via, typeName, resolveDestination(innerExpr, ctx.member, localTypes, subst), undefined, argCount, `${call.receiver}.${call.fnName}`);
      return;
    }
  }

  const localType = localTypes.get(call.receiver);
  const stateVarType = ctx.member.stateVars.get(call.receiver)?.type;
  const receiverType = localType ?? stateVarType ?? call.receiver;
  const receiverTypeIsKnownUnit = ctx.registry.isKnownUnit(receiverType, curFile);
  const targetUnit = receiverTypeIsKnownUnit ? ctx.registry.resolveUnit(receiverType, curFile) : undefined;
  const directLib = ctx.registry.resolveUnit(call.receiver, curFile);
  const lib = directLib && directLib.kind === "library" ? directLib : findUsingLibrary(ctx, curFile, unitUsing, receiverType, receiverTypeIsKnownUnit, call.fnName);

  if (lib) {
    const fn = findUnitFunction(lib, call.fnName);
    if (fn) {
      acc.internalCalls.push({
        name: call.fnName,
        signature: ctx.registry.canonicalSignature(call.fnName, fn.params, lib.file),
        kind: "library",
        declaredIn: lib.name,
        depth: depth + 1,
        via: [...via],
        purpose: `calls the ${lib.name} library`,
      });
      if (fn.hasBody && depth + 1 <= MAX_DEPTH) {
        const calleeSubst = buildCalleeSubstitution(fn, argsText, ctx.member, localTypes, subst);
        walkFunctionBody(fn, lib.file, ctx, [...via, `${lib.name}.${call.fnName}`], depth + 1, acc, visited, calleeSubst);
      } else if (!fn.hasBody) {
        acc.notes.add(`the library function ${lib.name}.${call.fnName} has no available body`);
      }
      return;
    }
  }

  if (targetUnit && (targetUnit.kind === "interface" || targetUnit.kind === "contract")) {
    const found = ctx.registry.findMemberFunction(targetUnit.name, targetUnit.file, call.fnName);
    const dest = resolveDestination(call.receiver, ctx.member, localTypes, subst);
    pushExternalCall(ctx, acc, curFile, bodyOffset, call, via, receiverType, dest, found, argCount, `${call.receiver}.${call.fnName}`);
    return;
  }

  if (/^[A-Z]/.test(call.receiver) && !ctx.registry.isKnownUnit(call.receiver, curFile)) {
    acc.notes.add(`\`${call.receiver}\` looks like a library or interface, but its source was not provided; the call to ${call.fnName} was left unresolved`);
  } else if (unitUsing.some((u) => u.forType !== "*" && !ctx.registry.isKnownUnit(u.forType, curFile))) {
    acc.notes.add(`could not resolve \`${call.receiver}.${call.fnName}\`; a \`using\` library declared for this type was not provided`);
  } else {
    acc.notes.add(`could not resolve \`${call.receiver}.${call.fnName}\`; its declaring type was not found in the provided sources`);
  }
}

/**
 * Builds the destination substitution seen by a callee: for each of its
 * named parameters, the destination of the actual argument expression at
 * this call site, resolved in the caller's own scope (through the
 * caller's own substitution first, so a multi-hop wrapper chain resolves
 * back to the original caller's real argument).
 */
function buildCalleeSubstitution(fn: ParsedFunction, argsText: string, member: MemberTable, localTypes: Map<string, string>, callerSubst: Map<string, DestinationHint>): Map<string, DestinationHint> {
  const calleeSubst = new Map<string, DestinationHint>();
  const argExprs = splitArgsTopLevel(argsText);
  fn.params.forEach((p, idx) => {
    if (!p.name) return;
    const argExpr = (argExprs[idx] ?? "").trim();
    if (!argExpr) return;
    calleeSubst.set(p.name, resolveDestination(argExpr, member, localTypes, callerSubst));
  });
  return calleeSubst;
}

function pushExternalCall(
  ctx: WalkCtx,
  acc: Accumulator,
  curFile: string,
  bodyOffset: number,
  call: DotCall,
  via: string[],
  typeName: string,
  dest: DestinationHint,
  found: { fn: ParsedFunction; file: string } | undefined,
  argCount: number,
  destExpr: string,
): void {
  let signature: string | undefined;
  let selector: string | undefined;
  let callType: CallType = "call";
  if (found) {
    signature = ctx.registry.canonicalSignature(found.fn.name, found.fn.params, found.file);
    callType = callTypeForMutability(found.fn.mutability);
    if (signature) selector = selectorOf(signature);
    else acc.notes.add(`the parameter types of ${typeName}.${call.fnName} include a type this analyser could not canonicalise; selector left unresolved`);
  } else {
    acc.notes.add(`the declaration of ${typeName}.${call.fnName} was not found in the provided sources; signature left unresolved`);
    callType = "dynamic";
  }
  acc.externalCalls.push({
    destExpr,
    destination: dest,
    functionName: call.fnName,
    signature,
    selector,
    argCount,
    callType,
    via: [...via],
    reason: `calls ${call.fnName} on ${typeName}`,
    source: sourceRef(ctx, curFile, bodyOffset + call.callOffset),
  });
}

const LOW_LEVEL_RE = /(?<![.\w$])([A-Za-z_$][\w$]*(?:\s*\([^()]*\))?)\s*\.\s*(call|staticcall|delegatecall|transfer|send)\s*(\{[^{}]*\})?\s*\(/g;

function scanLowLevelCalls(body: string, originalBody: string, bodyOffset: number, ctx: WalkCtx, curFile: string, localTypes: Map<string, string>, subst: Map<string, DestinationHint>, via: string[], acc: Accumulator): void {
  LOW_LEVEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOW_LEVEL_RE.exec(body)) !== null) {
    const receiverRaw = (m[1] ?? "").trim();
    const method = m[2] ?? "";
    const callOffset = m.index + m[0].length - 1;
    const close = findMatchingParenAt(body, callOffset);
    const closeIdx = close === -1 ? body.length : close;
    const argsText = originalBody.slice(callOffset + 1, closeIdx);
    const castMatch = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(receiverRaw);
    const receiverExpr = castMatch ? (castMatch[2] ?? "") : receiverRaw;
    const dest = resolveDestination(receiverExpr, ctx.member, localTypes, subst);

    let callType: CallType;
    let functionName = method;
    let signature: string | undefined;
    let selector: string | undefined;
    if (method === "transfer" || method === "send") {
      callType = "transfer";
      functionName = "transfer";
      acc.notes.add("a plain Ether transfer, not a contract function call");
    } else {
      callType = method === "staticcall" ? "staticcall" : method === "delegatecall" ? "delegatecall" : "dynamic";
      const literalSig = /abi\.encodeWithSignature\s*\(\s*"([^"]+)"/.exec(argsText);
      const encodedCall = /abi\.encodeCall\s*\(\s*([A-Za-z_$][\w$.]*)\.([A-Za-z_$][\w$]*)/.exec(argsText);
      if (literalSig) {
        signature = literalSig[1];
        functionName = (signature ?? "").split("(")[0] ?? method;
        selector = signature ? selectorOf(signature) : undefined;
        if (method === "call") callType = "call";
      } else if (encodedCall) {
        functionName = encodedCall[2] ?? method;
        acc.notes.add(`the selector for a low-level ${method} to ${functionName} could not be fully resolved`);
      } else {
        acc.notes.add(`a low-level ${method} has a dynamic or unresolved selector`);
      }
    }

    acc.externalCalls.push({
      destExpr: receiverExpr,
      destination: dest,
      functionName,
      signature,
      selector,
      argCount: 0,
      callType,
      via: [...via],
      reason: `performs a low-level ${method}`,
      source: sourceRef(ctx, curFile, bodyOffset + callOffset),
    });
  }
}

const GATE_PATTERNS: { test: RegExp; kind: AccessControl["kind"] }[] = [
  { test: /\bonly[Oo]wner\b/, kind: "owner" },
  { test: /require\s*\(\s*msg\.sender\s*==\s*owner\b/, kind: "owner" },
  { test: /\bhasRole\s*\(/, kind: "role" },
  { test: /\bonly.*Role\b/i, kind: "role" },
  { test: /\bmsg\.sender\s*==\s*address\(this\)/, kind: "self" },
  { test: /\bonlySelf\b/i, kind: "self" },
  { test: /\bonly(Governor|Curator|Allocator|Admin|Guardian|Sentinel)\b/i, kind: "restricted" },
  { test: /\bwhenNotPaused\b/i, kind: "restricted" },
];

function classifyGate(text: string): AccessControl["kind"] | undefined {
  for (const g of GATE_PATTERNS) if (g.test.test(text)) return g.kind;
  return undefined;
}

/** Scans one body for `require`/`if (...) revert` guards mentioning `msg.sender`. */
function scanGuards(body: string): string[] {
  const gates: string[] = [];
  const reqRe = /require\s*\([^;]*msg\.sender[^;]*?\)/g;
  let m: RegExpExecArray | null;
  while ((m = reqRe.exec(body)) !== null) gates.push(m[0].slice(0, 160));
  const ifRe = /if\s*\([^)]*msg\.sender[^)]*\)\s*(revert|\{[^}]*revert)/g;
  while ((m = ifRe.exec(body)) !== null) gates.push(m[0].slice(0, 160));
  return gates;
}

function accessControlFor(fn: ParsedFunction, member: MemberTable, sourceByFile: Map<string, SourceLookup>, body: string): AccessControl {
  const gates: string[] = [];
  let kind: AccessControl["kind"] | undefined;
  for (const inv of fn.modifierInvocations) {
    const name = inv.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? inv;
    const modClass = classifyGate(name);
    if (modClass) {
      gates.push(name);
      kind = kind ?? modClass;
      continue;
    }
    const entry = member.modifiers.get(name);
    if (!entry) continue;
    gates.push(name);
    const modSrc = sourceByFile.get(entry.file);
    if (modSrc && entry.decl.bodyStart >= 0) {
      const modBody = modSrc.clean.slice(entry.decl.bodyStart, entry.decl.bodyEnd);
      for (const g of scanGuards(modBody)) {
        const c = classifyGate(g);
        gates.push(g);
        kind = kind ?? c ?? "restricted";
      }
    }
  }
  for (const g of scanGuards(body)) {
    const c = classifyGate(g);
    gates.push(g);
    if (c) kind = kind ?? c;
    else if (/msg\.sender/.test(g)) kind = kind ?? "restricted";
  }
  if (!kind) {
    if (gates.length > 0) kind = "restricted";
    else return { kind: "open", detail: "Any address may call this function.", gates: [] };
  }
  const detail =
    kind === "owner"
      ? "Only the contract owner may call this function."
      : kind === "role"
        ? "Only an address holding the required role may call this function."
        : kind === "self"
          ? "Only the contract itself may call this function."
          : "Calling this function requires passing an internal permission check.";
  return { kind, detail, gates: dedupe(gates) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function scanEvents(body: string, registry: TypeRegistry, member: MemberTable, callingFile: string, acc: Accumulator): void {
  const re = /\bemit\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1] ?? "";
    const bare = raw.includes(".") ? raw.split(".").slice(-1)[0]! : raw;
    const decl = member.events.get(bare);
    if (decl) {
      const sig = registry.canonicalSignature(decl.name, decl.params, callingFile);
      acc.events.add(sig ?? `${decl.name}(${decl.params.map((p) => p.type).join(",")})`);
    } else {
      acc.events.add(raw);
    }
  }
}

function walkFunctionBody(
  fn: ParsedFunction,
  curFile: string,
  ctx: WalkCtx,
  via: string[],
  depth: number,
  acc: Accumulator,
  visited: Set<string>,
  subst: Map<string, DestinationHint> = new Map(),
): void {
  const visitKey = `${fn.declaredIn}@${curFile}.${fn.name}(${fn.params.map((p) => p.type).join(",")})`;
  if (visited.has(visitKey)) {
    acc.notes.add(`a recursive or repeated call to ${fn.name} was not re-walked`);
    return;
  }
  visited.add(visitKey);
  if (!fn.hasBody || fn.bodyStart < 0) return;
  const src = ctx.sourceByFile.get(curFile);
  if (!src) return;
  const body = src.clean.slice(fn.bodyStart, fn.bodyEnd);
  const originalBody = src.original.slice(fn.bodyStart, fn.bodyEnd);

  if (/\bassembly\b/.test(body)) acc.notes.add(`${fn.name} contains inline assembly, which is not analysed for reads or writes`);

  for (const name of ctx.member.stateVars.keys()) scanStateAccess(body, name, ctx.member, fn.declaredIn, via, acc);
  scanEvents(body, ctx.registry, ctx.member, curFile, acc);

  const localTypes = collectLocalTypes(fn, body, ctx.registry, curFile);
  const declUnit = ctx.registry.resolveUnit(fn.declaredIn, curFile);
  const unitUsing = declUnit?.using ?? [];
  const unitMember = ctx.registry.memberTable(fn.declaredIn, curFile);

  for (const call of findCastCalls(body)) {
    resolveDotCall(call, true, ctx, curFile, unitUsing, body, fn.bodyStart, localTypes, subst, via, depth, acc, visited);
  }
  for (const call of findDotVarCalls(body)) {
    resolveDotCall(call, false, ctx, curFile, unitUsing, body, fn.bodyStart, localTypes, subst, via, depth, acc, visited);
  }
  for (const call of findEncodeCallRefs(body)) {
    resolveDotCall(call, false, ctx, curFile, unitUsing, body, fn.bodyStart, localTypes, subst, via, depth, acc, visited);
  }
  scanLowLevelCalls(body, originalBody, fn.bodyStart, ctx, curFile, localTypes, subst, via, acc);
  for (const call of findSuperCalls(body)) {
    const found = resolveSuperCall(ctx, fn.declaredIn, curFile, call.fnName);
    if (!found) {
      acc.notes.add(`could not resolve \`super.${call.fnName}\`; no base of ${fn.declaredIn} in the inheritance chain declares it`);
      continue;
    }
    acc.internalCalls.push({
      name: call.fnName,
      signature: ctx.registry.canonicalSignature(call.fnName, found.fn.params, found.file),
      kind: found.fn.visibility === "internal" || found.fn.visibility === "private" ? found.fn.visibility : "public-self",
      declaredIn: found.fn.declaredIn,
      depth: depth + 1,
      via: [...via],
      purpose: `calls the base implementation of ${call.fnName}`,
    });
    if (found.fn.hasBody && depth + 1 <= MAX_DEPTH) {
      const argsText = body.slice(call.argsStart, call.argsEnd);
      const calleeSubst = buildCalleeSubstitution(found.fn, argsText, ctx.member, localTypes, subst);
      walkFunctionBody(found.fn, found.file, ctx, [...via, `super.${call.fnName}`], depth + 1, acc, visited, calleeSubst);
    } else if (!found.fn.hasBody) {
      acc.notes.add(`super.${call.fnName} has no body in the provided sources`);
    } else {
      acc.notes.add(`the call graph reached the depth cap of ${MAX_DEPTH} before super.${call.fnName}`);
    }
  }

  // Bare internal/private/public-self calls: identifier not preceded by '.'. Checks the deployed
  // contract's own (most-derived-folded) table first, then the current unit's own table, so a
  // library or a non-deployed contract can call its own sibling helpers too.
  const calleeNames = new Set([...ctx.member.functions.keys(), ...unitMember.functions.keys()]);
  for (const calleeName of calleeNames) {
    const overloads = ctx.member.functions.get(calleeName) ?? unitMember.functions.get(calleeName) ?? [];
    if (overloads.length === 0) continue;
    const re = new RegExp(`(?<![.\\w$])${escapeRegExp(calleeName)}\\s*\\(`, "g");
    const match = re.exec(body);
    if (!match) continue;
    if (calleeName === fn.name) continue; // avoid trivially re-matching self header text artefacts
    const callee = overloads[0]!;
    if (overloads.length > 1) acc.notes.add(`${calleeName} is overloaded; the call graph used the first declared overload`);
    if (callee.fn.visibility === "internal" || callee.fn.visibility === "private") {
      acc.internalCalls.push({
        name: calleeName,
        signature: ctx.registry.canonicalSignature(calleeName, callee.fn.params, callee.file),
        kind: callee.fn.visibility,
        declaredIn: callee.fn.declaredIn,
        depth: depth + 1,
        via: [...via],
        purpose: `calls ${calleeName}`,
      });
    } else {
      acc.internalCalls.push({
        name: calleeName,
        signature: ctx.registry.canonicalSignature(calleeName, callee.fn.params, callee.file),
        kind: "public-self",
        declaredIn: callee.fn.declaredIn,
        depth: depth + 1,
        via: [...via],
        purpose: `calls its own ${calleeName}`,
      });
    }
    if (depth + 1 <= MAX_DEPTH) {
      const openParenIdx = match.index + match[0].length - 1;
      const close = findMatchingParenAt(body, openParenIdx);
      const argsText = body.slice(openParenIdx + 1, close === -1 ? body.length : close);
      const calleeSubst = buildCalleeSubstitution(callee.fn, argsText, ctx.member, localTypes, subst);
      walkFunctionBody(callee.fn, callee.file, ctx, [...via, calleeName], depth + 1, acc, visited, calleeSubst);
    } else {
      acc.notes.add(`the call graph reached the depth cap of ${MAX_DEPTH} before ${calleeName}`);
    }
  }

  for (const inv of fn.modifierInvocations) {
    const name = inv.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? inv;
    const entry = ctx.member.modifiers.get(name) ?? unitMember.modifiers.get(name);
    if (!entry) continue;
    acc.internalCalls.push({ name, kind: "modifier", declaredIn: entry.decl.declaredIn, depth: depth + 1, via: [...via], purpose: `applies the ${name} modifier` });
    if (depth + 1 <= MAX_DEPTH) {
      const modSrc = ctx.sourceByFile.get(entry.file);
      if (modSrc && entry.decl.bodyStart >= 0) {
        const modBody = modSrc.clean.slice(entry.decl.bodyStart, entry.decl.bodyEnd);
        for (const svName of ctx.member.stateVars.keys()) scanStateAccess(modBody, svName, ctx.member, entry.decl.declaredIn, [...via, name], acc);
        scanEvents(modBody, ctx.registry, ctx.member, entry.file, acc);
      }
    }
  }
}

/** Fallback ABI parameter for display when the registry could not canonicalise a type: the raw source spelling. */
function displayAbiParam(p: { name?: string; type: string }, registry: TypeRegistry, callingFile: string): AbiParam {
  return registry.resolveAbiParam(p, callingFile) ?? { name: p.name, type: p.type };
}

/** Builds the exposed `FunctionAnalysis` for one public/external function of the deployed unit. */
export function analyzeExposedFunction(
  fn: ParsedFunction,
  unitFile: string,
  registry: TypeRegistry,
  sourceByFile: Map<string, SourceLookup>,
  member: MemberTable,
  chain: { name: string; file: string }[],
  warnings: string[],
  overloaded: boolean,
): FunctionAnalysis {
  const acc = newAccumulator();
  const src = sourceByFile.get(unitFile);
  const body = fn.hasBody && src ? src.clean.slice(fn.bodyStart, fn.bodyEnd) : "";

  const ctx: WalkCtx = { registry, member, chain, sourceByFile, warnings };

  if (fn.hasBody) walkFunctionBody(fn, unitFile, ctx, [], 0, acc, new Set());
  else acc.notes.add(`${fn.name} has no body in the provided sources`);

  const access = accessControlFor(fn, member, sourceByFile, body);
  const canonical = fn.kind === "function" ? registry.canonicalSignature(fn.name, fn.params, unitFile) : undefined;
  const rawJoined = `${fn.name}(${fn.params.map((p) => p.type).join(",")})`;
  const signature = fn.kind === "receive" ? "receive()" : fn.kind === "fallback" ? "fallback()" : (canonical ?? rawJoined);
  const selector = fn.kind === "receive" || fn.kind === "fallback" ? "" : canonical ? selectorOf(canonical) : "";
  if (fn.kind === "function" && !canonical) acc.notes.add(`the signature of ${fn.name} could not be fully canonicalised; no selector was hashed`);

  return {
    name: fn.kind === "function" ? fn.name : fn.kind,
    signature,
    selector,
    params: fn.params.map((p) => displayAbiParam(p, registry, unitFile)),
    outputs: fn.returns.map((p) => displayAbiParam(p, registry, unitFile)),
    visibility: fn.visibility,
    mutability: fn.mutability,
    modifiers: fn.modifierInvocations.map((m) => m.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? m),
    access,
    role: "",
    whatItDoes: "",
    natspec: fn.natspec,
    declaredIn: fn.declaredIn,
    reads: [...acc.reads.values()],
    writes: [...acc.writes.values()],
    internalCalls: acc.internalCalls,
    externalCalls: acc.externalCalls,
    events: [...acc.events],
    notes: [...acc.notes],
    hasSource: true,
    overloaded,
  };
}
