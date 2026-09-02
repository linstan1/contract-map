/**
 * Line-based parser for Vyper source. Builds the module-level declarations
 * (state variables, events, structs, enums, interfaces, imports) and every
 * `def`, with its decorators, parameters, return type, and body kept as the
 * raw indented lines the analyser walks.
 *
 * Vyper has one declaration per top-level line, so the parser never needs a
 * full expression grammar: it only needs to find block boundaries by
 * indentation and split a handful of well-known statement shapes.
 */

import { extractDocstring, splitTopLevel, type VyperLine } from "./lex";

export interface VyperParam {
  name: string;
  type: string;
  hasDefault: boolean;
}

export interface ParsedFunction {
  name: string;
  decorators: string[];
  params: VyperParam[];
  returns?: string;
  /** Indentation width of the `def` line. */
  defIndent: number;
  /** 1-based line of the `def` keyword. */
  defLine: number;
  /** Body lines, indent strictly greater than `defIndent`, comment/blank lines excluded. */
  body: VyperLine[];
  docstring?: string;
}

export interface StateVar {
  name: string;
  type: string;
  isPublic: boolean;
  isConstant: boolean;
  isImmutable: boolean;
  value?: string;
  line: number;
}

export interface EventDecl {
  name: string;
  fields: { name: string; type: string }[];
  line: number;
}

export interface StructDecl {
  name: string;
  fields: { name: string; type: string }[];
}

export interface InterfaceFn {
  name: string;
  params: { name: string; type: string }[];
  returns?: string;
  mutability: string;
}

export interface InterfaceDecl {
  name: string;
  functions: Map<string, InterfaceFn>;
}

export interface ImportDecl {
  /** Local name the module or symbol is bound to. */
  alias: string;
  /** Dotted module path as written, e.g. `interfaces.IERC20` or `ownable`. */
  module: string;
  /** `true` for `from x import y`; `false` for a bare `import x`. */
  fromImport: boolean;
}

export interface ParsedModule {
  functions: Map<string, ParsedFunction>;
  stateVars: Map<string, StateVar>;
  events: Map<string, EventDecl>;
  structs: Map<string, StructDecl>;
  enums: Map<string, string[]>;
  interfaces: Map<string, InterfaceDecl>;
  imports: ImportDecl[];
  implements: string[];
  exports: string[];
  warnings: string[];
  moduleDocstring?: string;
}

/** True when `text` opens a block that owns every following line with a strictly greater indent. */
function isBlockOpener(text: string): boolean {
  return text.endsWith(":");
}

/** Collects the contiguous lines at `indent > parentIndent`, starting right after `startIdx`. */
function collectBlock(lines: VyperLine[], startIdx: number, parentIndent: number): { body: VyperLine[]; nextIdx: number } {
  const body: VyperLine[] = [];
  let i = startIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.indent === -1) continue;
    if (line.indent <= parentIndent) break;
    body.push(line);
  }
  return { body, nextIdx: i };
}

function parseParamList(raw: string): VyperParam[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return splitTopLevel(trimmed, ",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const eqIdx = splitTopLevel(p, "=");
      const decl = (eqIdx[0] ?? "").trim();
      const hasDefault = eqIdx.length > 1;
      const colonIdx = decl.indexOf(":");
      if (colonIdx === -1) return { name: decl, type: "unknown", hasDefault };
      return { name: decl.slice(0, colonIdx).trim(), type: decl.slice(colonIdx + 1).trim(), hasDefault };
    });
}

/** Parses a `def name(params) -> Returns:` header, already joined into one line. */
function parseDefHeader(text: string): { name: string; params: VyperParam[]; returns?: string } | undefined {
  const m = /^def\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*(->\s*([\s\S]+))?:$/.exec(text.trim());
  if (!m) return undefined;
  const returnsRaw = m[4]?.trim();
  return { name: m[1] as string, params: parseParamList(m[2] ?? ""), returns: returnsRaw && returnsRaw.length > 0 ? returnsRaw : undefined };
}

/** Unwraps `public(...)`, `constant(...)`, `immutable(...)` in any nesting order, e.g. `public(constant(uint256))`. */
function unwrapVarType(typeText: string): { inner: string; isPublic: boolean; isConstant: boolean; isImmutable: boolean } {
  let t = typeText.trim();
  let isPublic = false;
  let isConstant = false;
  let isImmutable = false;
  let changed = true;
  while (changed) {
    changed = false;
    let m = /^public\((.*)\)$/s.exec(t);
    if (m) {
      isPublic = true;
      t = (m[1] ?? "").trim();
      changed = true;
      continue;
    }
    m = /^constant\((.*)\)$/s.exec(t);
    if (m) {
      isConstant = true;
      t = (m[1] ?? "").trim();
      changed = true;
      continue;
    }
    m = /^immutable\((.*)\)$/s.exec(t);
    if (m) {
      isImmutable = true;
      t = (m[1] ?? "").trim();
      changed = true;
      continue;
    }
  }
  return { inner: t, isPublic, isConstant, isImmutable };
}

/** Parses every top-level declaration and every function into a `ParsedModule`. */
export function parseModule(lines: VyperLine[], originalLines: string[], moduleDocstring: string | undefined): ParsedModule {
  const functions = new Map<string, ParsedFunction>();
  const stateVars = new Map<string, StateVar>();
  const events = new Map<string, EventDecl>();
  const structs = new Map<string, StructDecl>();
  const enums = new Map<string, string[]>();
  const interfaces = new Map<string, InterfaceDecl>();
  const imports: ImportDecl[] = [];
  const implementsList: string[] = [];
  const exportsList: string[] = [];
  const warnings: string[] = [];

  const top = lines.filter((l) => l.indent === 0);
  let i = 0;
  while (i < top.length) {
    const line = top[i];
    if (!line) {
      i++;
      continue;
    }
    const text = line.text;

    if (text.startsWith("@")) {
      // Decorators are re-read from the full line list once the `def` line is reached below.
      let j = i;
      while (j < top.length && (top[j] as VyperLine).text.startsWith("@")) j++;
      const defLine = top[j];
      if (!defLine || !defLine.text.startsWith("def ")) {
        warnings.push(`decorator(s) at line ${line.no} are not followed by a def`);
        i = j + 1;
        continue;
      }
      i = j;
      continue;
    }

    if (text.startsWith("def ")) {
      // Recover any decorators directly above this def in the full line list (not just `top`).
      const decorators = collectDecoratorsAbove(lines, line.no);
      const headerJoin = joinWrappedInFull(lines, line.no);
      const header = parseDefHeader(headerJoin.text);
      const headerEndIdxInFull = lines.findIndex((l) => l.no === headerJoin.endLine);
      const { body } = collectBlock(lines, headerEndIdxInFull, line.indent);
      let docstring: string | undefined;
      if (body.length > 0 && body[0]) {
        const docLineIdx = body[0].no - 1;
        const doc = extractDocstring(originalLines, docLineIdx);
        if (doc && doc.text.length > 0) docstring = doc.text;
      }
      if (header) {
        if (functions.has(header.name)) {
          warnings.push(`duplicate def ${header.name} at line ${line.no}; keeping the first declaration`);
        } else {
          functions.set(header.name, {
            name: header.name,
            decorators,
            params: header.params,
            returns: header.returns,
            defIndent: line.indent,
            defLine: line.no,
            body,
            docstring,
          });
        }
      } else {
        warnings.push(`could not parse function header at line ${line.no}: ${headerJoin.text}`);
      }
      // Advance the `top` cursor past this def's top-level lines.
      const bodyEndNo = body.length > 0 ? (body[body.length - 1] as VyperLine).no : line.no;
      while (i < top.length && (top[i] as VyperLine).no <= bodyEndNo) i++;
      continue;
    }

    if (text.startsWith("event ") && isBlockOpener(text)) {
      const name = text.slice("event ".length, text.length - 1).trim();
      const idxInFull = lines.findIndex((l) => l.no === line.no);
      const { body } = collectBlock(lines, idxInFull, line.indent);
      const fields = body.map((b) => parseFieldLine(b.text)).filter((f): f is { name: string; type: string } => f !== undefined);
      events.set(name, { name, fields, line: line.no });
      i++;
      continue;
    }

    if (text.startsWith("struct ") && isBlockOpener(text)) {
      const name = text.slice("struct ".length, text.length - 1).trim();
      const idxInFull = lines.findIndex((l) => l.no === line.no);
      const { body } = collectBlock(lines, idxInFull, line.indent);
      const fields = body.map((b) => parseFieldLine(b.text)).filter((f): f is { name: string; type: string } => f !== undefined);
      structs.set(name, { name, fields });
      i++;
      continue;
    }

    if ((text.startsWith("enum ") || text.startsWith("flag ")) && isBlockOpener(text)) {
      const kw = text.startsWith("enum ") ? "enum " : "flag ";
      const name = text.slice(kw.length, text.length - 1).trim();
      const idxInFull = lines.findIndex((l) => l.no === line.no);
      const { body } = collectBlock(lines, idxInFull, line.indent);
      enums.set(
        name,
        body.map((b) => b.text),
      );
      i++;
      continue;
    }

    if (text.startsWith("interface ") && isBlockOpener(text)) {
      const name = text.slice("interface ".length, text.length - 1).trim();
      const idxInFull = lines.findIndex((l) => l.no === line.no);
      const { body } = collectBlock(lines, idxInFull, line.indent);
      const fns = new Map<string, InterfaceFn>();
      for (const b of body) {
        const m = /^def\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*(->\s*([\s\S]+))?:\s*(view|nonpayable|payable|pure)?$/.exec(b.text);
        if (!m) continue;
        const returnsRaw = m[4]?.trim();
        fns.set(m[1] as string, {
          name: m[1] as string,
          params: parseParamList(m[2] ?? ""),
          returns: returnsRaw && returnsRaw.length > 0 ? returnsRaw : undefined,
          mutability: m[5] ?? "nonpayable",
        });
      }
      interfaces.set(name, { name, functions: fns });
      i++;
      continue;
    }

    if (text.startsWith("implements:")) {
      implementsList.push(text.slice("implements:".length).trim());
      i++;
      continue;
    }

    if (text.startsWith("exports:")) {
      exportsList.push(text.slice("exports:".length).trim());
      i++;
      continue;
    }

    if (text.startsWith("from ") && text.includes(" import ")) {
      const m = /^from\s+([\w.]+)\s+import\s+([\w*]+)(\s+as\s+([\w]+))?$/.exec(text);
      if (m) {
        const symbol = m[2] as string;
        const alias = m[4] ?? symbol;
        imports.push({ alias, module: `${m[1]}.${symbol}`, fromImport: true });
      } else {
        warnings.push(`could not parse import at line ${line.no}: ${text}`);
      }
      i++;
      continue;
    }

    if (text.startsWith("import ")) {
      const m = /^import\s+([\w.]+)(\s+as\s+([\w]+))?$/.exec(text);
      if (m) {
        const mod = m[1] as string;
        const alias = m[3] ?? (mod.split(".").pop() as string);
        imports.push({ alias, module: mod, fromImport: false });
      } else {
        warnings.push(`could not parse import at line ${line.no}: ${text}`);
      }
      i++;
      continue;
    }

    if (text.startsWith("uses:") || text.startsWith("initializes:")) {
      // 0.4 module wiring; not a call target, recorded nowhere but does not warn.
      i++;
      continue;
    }

    // State variable: `name: type` or `name: constant(type) = value` or `name: public(type)`.
    const colonIdx = text.indexOf(":");
    if (colonIdx > 0 && /^[A-Za-z_]\w*$/.test(text.slice(0, colonIdx).trim())) {
      const name = text.slice(0, colonIdx).trim();
      const rest = text.slice(colonIdx + 1).trim();
      const eqParts = splitTopLevel(rest, "=");
      const typeText = (eqParts[0] ?? "").trim();
      const value = eqParts.length > 1 ? eqParts.slice(1).join("=").trim() : undefined;
      const { inner, isPublic, isConstant, isImmutable } = unwrapVarType(typeText);
      stateVars.set(name, { name, type: inner, isPublic, isConstant, isImmutable, value, line: line.no });
      i++;
      continue;
    }

    warnings.push(`unrecognised module-level statement at line ${line.no}: ${text}`);
    i++;
  }

  return { functions, stateVars, events, structs, enums, interfaces, imports, implements: implementsList, exports: exportsList, warnings, moduleDocstring };
}

function parseFieldLine(text: string): { name: string; type: string } | undefined {
  if (text.length === 0 || text.startsWith("#")) return undefined;
  const colonIdx = text.indexOf(":");
  if (colonIdx === -1) return undefined;
  const name = text.slice(0, colonIdx).trim();
  const type = text.slice(colonIdx + 1).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  return { name, type };
}

/** Collects `@decorator` lines directly above a `def` at the same indent, from the full (not top-filtered) line list. */
function collectDecoratorsAbove(lines: VyperLine[], defLineNo: number): string[] {
  const defIdx = lines.findIndex((l) => l.no === defLineNo);
  const defLine = lines[defIdx];
  if (defIdx === -1 || !defLine) return [];
  const decorators: string[] = [];
  let i = defIdx - 1;
  while (i >= 0) {
    const l = lines[i];
    if (!l) {
      i--;
      continue;
    }
    if (l.indent === -1) {
      i--;
      continue;
    }
    if (l.indent !== defLine.indent) break;
    if (!l.text.startsWith("@")) break;
    decorators.unshift(l.text.slice(1));
    i--;
  }
  return decorators;
}

/** Joins a `def ... :` header that may wrap across lines, starting from `startLineNo` in the full line list. */
function joinWrappedInFull(lines: VyperLine[], startLineNo: number): { text: string; endLine: number } {
  const startIdx = lines.findIndex((l) => l.no === startLineNo);
  if (startIdx === -1) return { text: "", endLine: startLineNo };
  let depth = 0;
  let text = "";
  let endLine = startLineNo;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.indent === -1) continue;
    text += (text ? " " : "") + line.text;
    endLine = line.no;
    for (const ch of line.text) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0 && text.trimEnd().endsWith(":")) break;
  }
  return { text, endLine };
}
