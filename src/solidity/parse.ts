/**
 * Targeted Solidity parser. This is not a full compiler front end. It finds
 * contract/library/interface bodies by brace matching, then extracts the
 * declarations the analyser needs: inheritance, state variables, `using`
 * directives, modifiers, events, and functions with their raw body text.
 *
 * The parser reads `clean` text only (comments and strings already blanked),
 * so brace and paren counting is never confused by a `{` inside a string or
 * a comment.
 */

import type { Visibility, Mutability } from "../types";

export type UnitKind = "contract" | "library" | "interface";

export interface ParsedParam {
  name?: string;
  type: string;
  location?: string;
  indexed?: boolean;
}

export interface ParsedStruct {
  name: string;
  members: ParsedParam[];
  declaredIn: string;
  file: string;
}

export interface ParsedEnum {
  name: string;
  members: string[];
  declaredIn: string;
  file: string;
}

/** A user defined value type: `type Id is bytes32;`. */
export interface ParsedUserType {
  name: string;
  underlying: string;
  declaredIn: string;
  file: string;
}

export interface ParsedFunction {
  name: string;
  kind: "function" | "constructor" | "receive" | "fallback";
  params: ParsedParam[];
  returns: ParsedParam[];
  visibility: Visibility;
  mutability: Mutability;
  modifierInvocations: string[];
  virtual: boolean;
  override: boolean;
  hasBody: boolean;
  bodyStart: number;
  bodyEnd: number;
  headerLine: number;
  natspec?: string;
  declaredIn: string;
}

export interface ParsedStateVar {
  name: string;
  type: string;
  visibility: Visibility;
  constant: boolean;
  immutable: boolean;
  line: number;
  declaredIn: string;
}

export interface ParsedUsing {
  library: string;
  forType: string;
  declaredIn: string;
}

export interface ParsedModifierDecl {
  name: string;
  params: ParsedParam[];
  bodyStart: number;
  bodyEnd: number;
  headerLine: number;
  declaredIn: string;
}

export interface ParsedEvent {
  name: string;
  params: ParsedParam[];
  anonymous: boolean;
  declaredIn: string;
}

export interface ParsedUnit {
  kind: UnitKind;
  name: string;
  isAbstract: boolean;
  inherits: string[];
  stateVars: ParsedStateVar[];
  using: ParsedUsing[];
  modifiers: ParsedModifierDecl[];
  events: ParsedEvent[];
  functions: ParsedFunction[];
  structs: ParsedStruct[];
  enums: ParsedEnum[];
  userTypes: ParsedUserType[];
  file: string;
}

/** Declared outside any contract/library/interface: a Solidity file-level (free) type or using directive. */
export interface FreeTypes {
  structs: ParsedStruct[];
  enums: ParsedEnum[];
  userTypes: ParsedUserType[];
  using: ParsedUsing[];
}

export interface ParseResult {
  units: ParsedUnit[];
  freeTypes: FreeTypes;
  warnings: string[];
}

/** Index of the character matching `open` (a `{`, `(`, or `[`) in `text`. -1 when unbalanced. */
function findMatching(text: string, open: number): number {
  const openChar = text[open];
  const closeChar = openChar === "{" ? "}" : openChar === "(" ? ")" : "]";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits `text` on top-level commas, respecting `()`, `[]`, and `{}` nesting. */
function splitTopLevel(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseParamList(text: string): ParsedParam[] {
  return splitTopLevel(text).map(parseOneParam);
}

function parseOneParam(raw: string): ParsedParam {
  const words = raw.split(/\s+/).filter(Boolean);
  let location: string | undefined;
  let indexed = false;
  let name: string | undefined;
  const typeWords: string[] = [];
  for (let idx = 0; idx < words.length; idx++) {
    const w = words[idx] ?? "";
    const isLast = idx === words.length - 1;
    if (w === "memory" || w === "calldata" || w === "storage") {
      location = w;
      continue;
    }
    if (w === "indexed") {
      indexed = true;
      continue;
    }
    if (w === "payable" && typeWords[typeWords.length - 1] === "address") {
      typeWords.push(w);
      continue;
    }
    if (isLast && typeWords.length > 0 && /^[A-Za-z_$][\w$]*$/.test(w)) {
      name = w;
      continue;
    }
    typeWords.push(w);
  }
  return { name, type: typeWords.join(" "), location, indexed };
}

interface SpecTokens {
  visibility: Visibility;
  mutability: Mutability;
  virtual: boolean;
  override: boolean;
  modifierInvocations: string[];
  returnsRaw: string;
}

/** Splits the text between a function's `)` and its `{`/`;` into whitespace-delimited tokens. */
function splitSpecTokens(spec: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < spec.length) {
    while (i < spec.length && /\s/.test(spec[i] ?? "")) i++;
    if (i >= spec.length) break;
    const start = i;
    while (i < spec.length && /[A-Za-z0-9_$.]/.test(spec[i] ?? "")) i++;
    if (i === start) {
      i++;
      continue;
    }
    let j = i;
    while (j < spec.length && /\s/.test(spec[j] ?? "")) j++;
    if (spec[j] === "(") {
      const close = findMatching(spec, j);
      const end = close === -1 ? spec.length : close + 1;
      tokens.push(spec.slice(start, end));
      i = end;
    } else {
      tokens.push(spec.slice(start, i));
    }
  }
  return tokens;
}

function parseSpec(spec: string): SpecTokens {
  const tokens = splitSpecTokens(spec);
  let visibility: Visibility = "public";
  let mutability: Mutability = "nonpayable";
  let virtual = false;
  let override = false;
  let returnsRaw = "";
  const modifierInvocations: string[] = [];
  for (const tok of tokens) {
    if (tok === "public" || tok === "external" || tok === "internal" || tok === "private") {
      visibility = tok;
    } else if (tok === "view" || tok === "pure" || tok === "payable") {
      mutability = tok;
    } else if (tok === "virtual") {
      virtual = true;
    } else if (tok.startsWith("override")) {
      override = true;
    } else if (tok.startsWith("returns")) {
      returnsRaw = tok.slice("returns".length).trim().replace(/^\(/, "").replace(/\)$/, "");
    } else {
      modifierInvocations.push(tok);
    }
  }
  return { visibility, mutability, virtual, override, modifierInvocations, returnsRaw };
}

const MEMBER_START = /^(function|constructor|receive|fallback|modifier|struct|enum|error|event|using|type)\b/;

function natspecAt(natspecByLine: Map<number, string>, line: number): string | undefined {
  return natspecByLine.get(line);
}

/** Parses one `contract|library|interface` body into declarations. */
function parseUnitBody(
  unitName: string,
  kind: UnitKind,
  body: string,
  bodyOffset: number,
  lineStarts: (offset: number) => number,
  natspecByLine: Map<number, string>,
  warnings: string[],
): { stateVars: ParsedStateVar[]; using: ParsedUsing[]; modifiers: ParsedModifierDecl[]; events: ParsedEvent[]; functions: ParsedFunction[] } {
  const stateVars: ParsedStateVar[] = [];
  const using: ParsedUsing[] = [];
  const modifiers: ParsedModifierDecl[] = [];
  const events: ParsedEvent[] = [];
  const functions: ParsedFunction[] = [];

  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i] ?? "")) i++;
    if (i >= n) break;
    const rest = body.slice(i);
    const headerLine = lineStarts(bodyOffset + i);

    const m = MEMBER_START.exec(rest);
    if (!m) {
      // Assume a state variable declaration, ending at the first top-level ';'.
      const end = findTopLevelSemicolon(body, i);
      const stop = end === -1 ? n : end;
      const decl = body.slice(i, stop);
      if (decl.trim().length > 0) {
        const v = parseStateVar(decl, unitName, headerLine);
        if (v) stateVars.push(v);
        else warnings.push(`${unitName}: could not parse a member starting at line ${headerLine}`);
      }
      i = stop + 1;
      continue;
    }

    const keyword = m[1] ?? "";
    if (keyword === "using") {
      const end = findTopLevelSemicolon(body, i);
      const stop = end === -1 ? n : end;
      const decl = body.slice(i + "using".length, stop).trim();
      for (const u of parseUsingDecl(decl)) using.push({ ...u, declaredIn: unitName });
      i = stop + 1;
      continue;
    }
    if (keyword === "struct" || keyword === "enum" || keyword === "error") {
      const braceIdx = body.indexOf("{", i);
      const semiIdx = findTopLevelSemicolon(body, i);
      if (keyword === "error" && (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx))) {
        i = semiIdx + 1;
      } else if (braceIdx !== -1) {
        const close = findMatching(body, braceIdx);
        i = close === -1 ? n : close + 1;
      } else {
        i = semiIdx === -1 ? n : semiIdx + 1;
      }
      continue;
    }
    if (keyword === "type") {
      const end = findTopLevelSemicolon(body, i);
      i = (end === -1 ? n : end) + 1;
      continue;
    }
    if (keyword === "event") {
      const end = findTopLevelSemicolon(body, i);
      const stop = end === -1 ? n : end;
      const decl = body.slice(i + "event".length, stop).trim();
      const ev = parseEventDecl(decl, unitName);
      if (ev) events.push(ev);
      else warnings.push(`${unitName}: could not parse an event at line ${headerLine}`);
      i = stop + 1;
      continue;
    }
    if (keyword === "modifier") {
      const nameMatch = /^modifier\s+([A-Za-z_$][\w$]*)/.exec(rest);
      const name = nameMatch?.[1] ?? "";
      let cursor = i + (nameMatch ? nameMatch[0].length : "modifier".length);
      let params: ParsedParam[] = [];
      if (body[cursor] === undefined) {
        i = n;
        continue;
      }
      while (cursor < n && /\s/.test(body[cursor] ?? "")) cursor++;
      if (body[cursor] === "(") {
        const close = findMatching(body, cursor);
        params = parseParamList(body.slice(cursor + 1, close === -1 ? n : close));
        cursor = (close === -1 ? n : close) + 1;
      }
      const braceIdx = body.indexOf("{", cursor);
      const semiIdx = findTopLevelSemicolon(body, cursor);
      if (braceIdx !== -1 && (semiIdx === -1 || braceIdx < semiIdx)) {
        const close = findMatching(body, braceIdx);
        const bodyEnd = close === -1 ? n : close;
        modifiers.push({
          name,
          params,
          bodyStart: bodyOffset + braceIdx + 1,
          bodyEnd: bodyOffset + bodyEnd,
          headerLine,
          declaredIn: unitName,
        });
        i = bodyEnd + 1;
      } else {
        // virtual modifier with no body
        i = semiIdx === -1 ? n : semiIdx + 1;
      }
      continue;
    }

    // function | constructor | receive | fallback
    const fnKeyword = keyword as "function" | "constructor" | "receive" | "fallback";
    let cursor = i + fnKeyword.length;
    let name = fnKeyword === "function" ? "" : fnKeyword;
    if (fnKeyword === "function") {
      const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(body.slice(cursor));
      name = nameMatch?.[1] ?? "";
      cursor += nameMatch ? nameMatch[0].length : 0;
    }
    while (cursor < n && /\s/.test(body[cursor] ?? "")) cursor++;
    let params: ParsedParam[] = [];
    if (body[cursor] === "(") {
      const close = findMatching(body, cursor);
      params = parseParamList(body.slice(cursor + 1, close === -1 ? n : close));
      cursor = (close === -1 ? n : close) + 1;
    } else {
      warnings.push(`${unitName}: expected '(' for ${fnKeyword} at line ${headerLine}`);
    }
    const braceIdx = body.indexOf("{", cursor);
    const semiIdx = findTopLevelSemicolon(body, cursor);
    const specEnd = braceIdx !== -1 && (semiIdx === -1 || braceIdx < semiIdx) ? braceIdx : semiIdx;
    const spec = parseSpec(body.slice(cursor, specEnd === -1 ? n : specEnd));
    const natspec = natspecAt(natspecByLine, headerLine);
    if (braceIdx !== -1 && (semiIdx === -1 || braceIdx < semiIdx)) {
      const close = findMatching(body, braceIdx);
      const bodyEnd = close === -1 ? n : close;
      functions.push({
        name,
        kind: fnKeyword,
        params,
        returns: spec.returnsRaw ? parseParamList(spec.returnsRaw) : [],
        visibility: kind === "interface" ? "external" : spec.visibility,
        mutability: spec.mutability,
        modifierInvocations: spec.modifierInvocations,
        virtual: spec.virtual,
        override: spec.override,
        hasBody: true,
        bodyStart: bodyOffset + braceIdx + 1,
        bodyEnd: bodyOffset + bodyEnd,
        headerLine,
        natspec,
        declaredIn: unitName,
      });
      i = bodyEnd + 1;
    } else {
      const stop = semiIdx === -1 ? n : semiIdx;
      functions.push({
        name,
        kind: fnKeyword,
        params,
        returns: spec.returnsRaw ? parseParamList(spec.returnsRaw) : [],
        visibility: kind === "interface" ? "external" : spec.visibility,
        mutability: spec.mutability,
        modifierInvocations: spec.modifierInvocations,
        virtual: spec.virtual,
        override: spec.override,
        hasBody: false,
        bodyStart: -1,
        bodyEnd: -1,
        headerLine,
        natspec,
        declaredIn: unitName,
      });
      i = stop + 1;
    }
  }

  return { stateVars, using, modifiers, events, functions };
}

function findTopLevelSemicolon(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

/** Finds the first top-level `=` that is a real default-value assignment, not `=>`, `==`, `<=`, `>=`, or `!=`. */
function findTopLevelAssign(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (next === "=" || next === ">") continue;
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">") continue;
      return i;
    }
  }
  return -1;
}

function parseStateVar(decl: string, declaredIn: string, line: number): ParsedStateVar | undefined {
  const eqIdx = findTopLevelAssign(decl);
  const head = (eqIdx === -1 ? decl : decl.slice(0, eqIdx)).trim();
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  let visibility: Visibility = "internal";
  let constant = false;
  let immutable = false;
  const typeWords: string[] = [];
  let name: string | undefined;
  for (let idx = 0; idx < words.length; idx++) {
    const w = words[idx] ?? "";
    const isLast = idx === words.length - 1;
    if (w === "public" || w === "private" || w === "internal") {
      visibility = w;
      continue;
    }
    if (w === "constant") {
      constant = true;
      continue;
    }
    if (w === "immutable" || w === "transient") {
      if (w === "immutable") immutable = true;
      continue;
    }
    if (isLast && typeWords.length > 0 && /^[A-Za-z_$][\w$]*$/.test(w)) {
      name = w;
      continue;
    }
    typeWords.push(w);
  }
  if (!name || typeWords.length === 0) return undefined;
  return { name, type: typeWords.join(" "), visibility, constant, immutable, line, declaredIn };
}

function parseUsingDecl(decl: string): { library: string; forType: string }[] {
  const m = /^(\{[^}]*\}|[A-Za-z_$][\w$.]*)\s+for\s+(.+?)(\s+global)?$/.exec(decl.trim());
  if (!m) return [];
  const libPart = m[1] ?? "";
  const forType = (m[2] ?? "*").trim();
  if (libPart.startsWith("{")) {
    const names = splitTopLevel(libPart.slice(1, -1));
    return names.map((n) => ({ library: n.trim(), forType }));
  }
  return [{ library: libPart.trim(), forType }];
}

function parseEventDecl(decl: string, declaredIn: string): ParsedEvent | undefined {
  const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*(anonymous)?$/.exec(decl.trim());
  if (!m) return undefined;
  const name = m[1] ?? "";
  const params = parseParamList(m[2] ?? "");
  return { name, params, anonymous: Boolean(m[3]), declaredIn };
}

interface TypeDeclMatch {
  kind: "struct" | "enum" | "userType" | "using";
  name: string;
  index: number;
  struct?: { members: ParsedParam[] };
  enum?: { members: string[] };
  userType?: { underlying: string };
  using?: { library: string; forType: string };
}

/** Finds every `struct`, `enum`, `type X is Y`, and `using` declaration anywhere in one file's clean text. */
function scanTypeDecls(clean: string, warnings: string[], path: string): TypeDeclMatch[] {
  const out: TypeDeclMatch[] = [];
  const structRe = /\bstruct\s+([A-Za-z_$][\w$]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = structRe.exec(clean)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const close = findMatching(clean, braceIdx);
    if (close === -1) {
      warnings.push(`${path}: struct '${m[1]}' has an unmatched brace`);
      continue;
    }
    const members = splitTopLevel(clean.slice(braceIdx + 1, close), ";").map(parseOneParam);
    out.push({ kind: "struct", name: m[1] ?? "", index: m.index, struct: { members } });
    structRe.lastIndex = close + 1;
  }
  const enumRe = /\benum\s+([A-Za-z_$][\w$]*)\s*\{/g;
  while ((m = enumRe.exec(clean)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const close = findMatching(clean, braceIdx);
    if (close === -1) {
      warnings.push(`${path}: enum '${m[1]}' has an unmatched brace`);
      continue;
    }
    const members = splitTopLevel(clean.slice(braceIdx + 1, close)).filter((s) => s.length > 0);
    out.push({ kind: "enum", name: m[1] ?? "", index: m.index, enum: { members } });
    enumRe.lastIndex = close + 1;
  }
  const typeRe = /\btype\s+([A-Za-z_$][\w$]*)\s+is\s+([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = typeRe.exec(clean)) !== null) {
    out.push({ kind: "userType", name: m[1] ?? "", index: m.index, userType: { underlying: m[2] ?? "" } });
  }
  const usingRe = /\busing\s+(\{[^}]*\}|[A-Za-z_$][\w$.]*)\s+for\s+([^;]+?)\s*;/g;
  while ((m = usingRe.exec(clean)) !== null) {
    const libPart = m[1] ?? "";
    const rawFor = (m[2] ?? "").trim();
    const forType = rawFor.replace(/\bglobal$/, "").trim() || "*";
    const libs = libPart.startsWith("{") ? splitTopLevel(libPart.slice(1, -1)) : [libPart];
    for (const lib of libs) out.push({ kind: "using", name: lib.trim(), index: m.index, using: { library: lib.trim(), forType } });
  }
  return out;
}

const UNIT_HEADER = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][\w$]*)/g;

/** Finds every contract/library/interface unit in one file, plus every free (file-level) type, and parses their members. */
export function parseFile(path: string, clean: string, natspecByLine: Map<number, string>, lineStartsArr: number[]): ParseResult {
  const warnings: string[] = [];
  const units: ParsedUnit[] = [];
  const spans: { name: string; start: number; end: number }[] = [];
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStartsArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStartsArr[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  UNIT_HEADER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNIT_HEADER.exec(clean)) !== null) {
    const kindWord = match[1] ?? "";
    const isAbstract = kindWord.startsWith("abstract");
    const kind: UnitKind = kindWord.endsWith("library") ? "library" : kindWord.endsWith("interface") ? "interface" : "contract";
    const name = match[2] ?? "";
    const headerEnd = UNIT_HEADER.lastIndex;
    const braceIdx = clean.indexOf("{", headerEnd);
    if (braceIdx === -1) {
      warnings.push(`${path}: unit '${name}' has no body, skipped`);
      continue;
    }
    const headerText = clean.slice(headerEnd, braceIdx);
    const isMatch = /\bis\s+([\s\S]+)$/.exec(headerText);
    const inherits = isMatch
      ? splitTopLevel(isMatch[1] ?? "").map((s) => (s.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? s.trim()))
      : [];
    const close = findMatching(clean, braceIdx);
    if (close === -1) {
      warnings.push(`${path}: unit '${name}' has an unmatched brace, skipped`);
      UNIT_HEADER.lastIndex = braceIdx + 1;
      continue;
    }
    const body = clean.slice(braceIdx + 1, close);
    const members = parseUnitBody(name, kind, body, braceIdx + 1, lineOf, natspecByLine, warnings);
    units.push({ kind, name, isAbstract, inherits, file: path, structs: [], enums: [], userTypes: [], ...members });
    spans.push({ name, start: braceIdx, end: close });
    UNIT_HEADER.lastIndex = close + 1;
  }

  const unitByName = new Map(units.map((u) => [u.name, u]));
  const freeTypes: FreeTypes = { structs: [], enums: [], userTypes: [], using: [] };
  for (const decl of scanTypeDecls(clean, warnings, path)) {
    const span = spans.find((s) => decl.index > s.start && decl.index < s.end);
    const owner = span ? unitByName.get(span.name) : undefined;
    if (decl.kind === "using") {
      if (owner) continue; // already captured by parseUnitBody's own `using` handling.
      if (decl.using) freeTypes.using.push({ ...decl.using, declaredIn: "" });
      continue;
    }
    const declaredIn = owner?.name ?? "";
    if (decl.kind === "struct" && decl.struct) {
      const entry = { name: decl.name, members: decl.struct.members, declaredIn, file: path };
      if (owner) owner.structs.push(entry);
      else freeTypes.structs.push(entry);
    } else if (decl.kind === "enum" && decl.enum) {
      const entry = { name: decl.name, members: decl.enum.members, declaredIn, file: path };
      if (owner) owner.enums.push(entry);
      else freeTypes.enums.push(entry);
    } else if (decl.kind === "userType" && decl.userType) {
      const entry = { name: decl.name, underlying: decl.userType.underlying, declaredIn, file: path };
      if (owner) owner.userTypes.push(entry);
      else freeTypes.userTypes.push(entry);
    }
  }

  return { units, freeTypes, warnings };
}
