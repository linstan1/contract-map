/**
 * Builds the exposed-function call graph for one Vyper contract from its
 * parsed module: state reads/writes, internal calls, outbound calls,
 * events, and access control.
 *
 * Vyper has no implicit external call: every call out of the contract is
 * either `extcall`/`staticcall` on a cast interface value, a call through
 * an interface-typed state variable, or a named builtin (`raw_call`,
 * `send`, `create_from_blueprint`, `create_minimal_proxy_to`). Every fact
 * this module reports is backed by a source-text match; an interface with
 * no local declaration leaves its signature unresolved rather than guessed.
 */

import { selectorOf, signatureOf } from "../abi";
import { depthAt, splitTopLevel, findAssignment, type VyperLine } from "./lex";
import type { InterfaceFn, ParsedFunction, ParsedModule, StructDecl } from "./parse";
import type { AbiParam, AccessControl, CallType, DestinationHint, FunctionAnalysis, Mutability, StateAccess, StaticExternalCall, StaticInternalCall, Visibility } from "../types";

const MAX_DEPTH = 8;

/** Resolves a Vyper type to a canonical ABI type string, or undefined when it cannot be mapped without guessing. */
export function vyperTypeToAbi(rawType: string, mod: ParsedModule, depth = 0): { type: string; components?: AbiParam[] } | undefined {
  const t = rawType.trim();
  if (depth > 6 || t.length === 0) return undefined;
  if (/^HashMap\[/.test(t)) return undefined;
  let m = /^DynArray\[([\s\S]+)\]$/.exec(t);
  if (m) {
    const parts = splitTopLevel(m[1] as string, ",");
    if (parts.length !== 2 || !parts[0]) return undefined;
    const inner = vyperTypeToAbi(parts[0].trim(), mod, depth + 1);
    if (!inner) return undefined;
    return { type: `${inner.type}[]`, components: inner.components };
  }
  if (/^Bytes\[\d+\]$/.test(t)) return { type: "bytes" };
  if (/^String\[\d+\]$/.test(t)) return { type: "string" };
  const fixed = stripFixedArraySuffix(t);
  if (fixed) {
    const inner = vyperTypeToAbi(fixed.base, mod, depth + 1);
    const size = resolveArraySize(fixed.size, mod);
    if (!inner || !size) return undefined;
    return { type: `${inner.type}[${size}]`, components: inner.components };
  }
  if (t === "address" || t === "bool" || t === "string") return { type: t };
  if (/^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)$/.test(t)) return { type: t };
  if (/^bytes([1-9]|[12]\d|3[0-2])$/.test(t)) return { type: t };
  if (mod.interfaces.has(t)) return { type: "address" };
  const struct = mod.structs.get(t);
  if (struct) return structToTuple(struct, mod, depth);
  return undefined;
}

function structToTuple(struct: StructDecl, mod: ParsedModule, depth: number): { type: string; components: AbiParam[] } | undefined {
  const components: AbiParam[] = [];
  for (const f of struct.fields) {
    const r = vyperTypeToAbi(f.type, mod, depth + 1);
    if (!r) return undefined;
    components.push({ name: f.name, type: r.type, components: r.components });
  }
  return { type: "tuple", components };
}

/** Splits a trailing top-level `[N]` fixed-array suffix from a Vyper type, e.g. `uint256[3]` -> `{base:"uint256", size:"3"}`. */
function stripFixedArraySuffix(type: string): { base: string; size: string } | undefined {
  if (!type.endsWith("]")) return undefined;
  let depth = 0;
  for (let i = type.length - 1; i >= 0; i--) {
    const ch = type[i];
    if (ch === "]") depth++;
    else if (ch === "[") {
      depth--;
      if (depth === 0) {
        const base = type.slice(0, i);
        if (base === "HashMap" || base === "DynArray" || base === "Bytes" || base === "String") return undefined;
        return { base, size: type.slice(i + 1, type.length - 1) };
      }
    }
  }
  return undefined;
}

/** Resolves a fixed-array size to a numeric literal: it is either already numeric, or the name of an `int128`/`uint256` module constant. */
function resolveArraySize(raw: string, mod: ParsedModule): string | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const decl = mod.stateVars.get(trimmed);
  if (decl && decl.isConstant && decl.value && /^\d+$/.test(decl.value.trim())) return decl.value.trim();
  return undefined;
}

/** Getter shape Vyper generates for a `public(...)` state variable: subscripts unwrap left to right. */
export function publicGetterShape(varType: string, mod: ParsedModule): { params: AbiParam[]; returns: AbiParam } | undefined {
  let t = varType.trim();
  const params: AbiParam[] = [];
  for (;;) {
    let m = /^HashMap\[([\s\S]+)\]$/.exec(t);
    if (m) {
      const parts = splitTopLevel(m[1] as string, ",");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
      const key = vyperTypeToAbi(parts[0].trim(), mod);
      if (!key) return undefined;
      params.push({ name: `arg${params.length}`, type: key.type });
      t = parts[1].trim();
      continue;
    }
    m = /^DynArray\[([\s\S]+)\]$/.exec(t);
    if (m) {
      const parts = splitTopLevel(m[1] as string, ",");
      if (parts.length !== 2 || !parts[0]) return undefined;
      params.push({ name: `arg${params.length}`, type: "uint256" });
      t = parts[0].trim();
      continue;
    }
    const fixed = stripFixedArraySuffix(t);
    if (fixed) {
      params.push({ name: `arg${params.length}`, type: "uint256" });
      t = fixed.base;
      continue;
    }
    break;
  }
  const ret = vyperTypeToAbi(t, mod);
  if (!ret) return undefined;
  return { params, returns: { type: ret.type, components: ret.components } };
}

export function deriveVisibilityMutability(decorators: string[]): { visibility: Visibility; mutability: Mutability } {
  let visibility: Visibility = "internal";
  let mutability: Mutability = "nonpayable";
  for (const raw of decorators) {
    const name = (raw.split("(")[0] ?? raw).trim();
    if (name === "external" || name === "public") visibility = "external";
    else if (name === "internal") visibility = "internal";
    else if (name === "view" || name === "constant") mutability = "view";
    else if (name === "pure") mutability = "pure";
    else if (name === "payable") mutability = "payable";
  }
  return { visibility, mutability };
}

interface CallSiteBase {
  matchStart: number;
}

interface InterfaceCallSite extends CallSiteBase {
  keyword?: "extcall" | "staticcall";
  interfaceName: string;
  addrExpr: string;
  method: string;
  argsText: string;
}

/** Depth-balanced index of the character matching an open bracket at `openIdx`. */
function matchBracket(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let inStr: string | undefined;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Finds `[extcall|staticcall] Interface(addr).method(args)` call sites, requiring a locally known interface or import. */
function scanInterfaceCalls(text: string, mod: ParsedModule): InterfaceCallSite[] {
  const out: InterfaceCallSite[] = [];
  const re = /(?:\b(extcall|staticcall)\s+)?\b([A-Z][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const interfaceName = m[2] as string;
    const known = mod.interfaces.has(interfaceName) || mod.imports.some((imp) => imp.alias === interfaceName);
    if (!known) continue;
    const parenStart = m.index + m[0].length - 1;
    const closeIdx = matchBracket(text, parenStart);
    if (closeIdx === -1) continue;
    let k = closeIdx + 1;
    while (/\s/.test(text[k] ?? "")) k++;
    if (text[k] !== ".") continue;
    k++;
    const methodMatch = /^([A-Za-z_]\w*)\s*\(/.exec(text.slice(k));
    if (!methodMatch) continue;
    const methodParenStart = k + methodMatch[0].length - 1;
    const methodCloseIdx = matchBracket(text, methodParenStart);
    if (methodCloseIdx === -1) continue;
    out.push({
      keyword: m[1] as "extcall" | "staticcall" | undefined,
      interfaceName,
      addrExpr: text.slice(parenStart + 1, closeIdx).trim(),
      method: methodMatch[1] as string,
      argsText: text.slice(methodParenStart + 1, methodCloseIdx),
      matchStart: m.index,
    });
  }
  return out;
}

/** Finds `self.NAME.method(args)` and bare `NAME.method(args)` call sites through an interface-typed state variable (bare access is how Vyper reads a `constant`/`immutable`). */
function scanSelfInterfaceCalls(text: string, mod: ParsedModule): (InterfaceCallSite & { stateVar: string })[] {
  const out: (InterfaceCallSite & { stateVar: string })[] = [];
  const re = /(?:\b(extcall|staticcall)\s+)?\b(?:(self)\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const isSelf = m[2] === "self";
    const varName = m[3] as string;
    if (!isSelf && !mod.stateVars.has(varName)) continue;
    const parenStart = m.index + m[0].length - 1;
    const closeIdx = matchBracket(text, parenStart);
    if (closeIdx === -1) continue;
    out.push({
      keyword: m[1] as "extcall" | "staticcall" | undefined,
      interfaceName: "",
      stateVar: varName,
      addrExpr: isSelf ? `self.${varName}` : varName,
      method: m[4] as string,
      argsText: text.slice(parenStart + 1, closeIdx),
      matchStart: m.index,
    });
  }
  return out;
}

function argCountOf(argsText: string): number {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return 0;
  return splitTopLevel(trimmed, ",").filter((p) => p.trim().length > 0).length;
}

/**
 * Signatures of `vyper.interfaces.ERC20`, the compiler's bundled interface
 * module. These are fixed by the Vyper compiler release, not by any one
 * contract's source, so using them when a contract imports the module
 * without redeclaring it locally is resolution, not a guess.
 */
const BUILTIN_ERC20: Record<string, { params: { name: string; type: string }[] }> = {
  totalSupply: { params: [] },
  balanceOf: { params: [{ name: "_owner", type: "address" }] },
  allowance: { params: [{ name: "_owner", type: "address" }, { name: "_spender", type: "address" }] },
  transfer: { params: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }] },
  transferFrom: { params: [{ name: "_from", type: "address" }, { name: "_to", type: "address" }, { name: "_value", type: "uint256" }] },
  approve: { params: [{ name: "_spender", type: "address" }, { name: "_value", type: "uint256" }] },
};

/** True when `interfaceName` was imported as the stdlib ERC20 interface, 0.2/0.3's `vyper.interfaces.ERC20` or 0.4's `ethereum.ercs.IERC20`, with no local override. */
const ERC20_MODULE_RE = /^(vyper\.interfaces\.ERC20|ethereum\.ercs\.IERC20)$/;
function isBuiltinErc20Import(interfaceName: string, mod: ParsedModule): boolean {
  return mod.imports.some((imp) => imp.alias === interfaceName && ERC20_MODULE_RE.test(imp.module));
}

function resolveInterfaceSignature(interfaceName: string, method: string, mod: ParsedModule): { signature: string; selector: string } | undefined {
  const iface = mod.interfaces.get(interfaceName);
  const stub: InterfaceFn | undefined = iface?.functions.get(method);
  if (stub) {
    const inputs: AbiParam[] = [];
    for (const p of stub.params) {
      const mapped = vyperTypeToAbi(p.type, mod);
      if (!mapped) return undefined;
      inputs.push({ name: p.name, type: mapped.type, components: mapped.components });
    }
    const signature = signatureOf({ type: "function", name: method, inputs });
    return { signature, selector: selectorOf(signature) };
  }
  if (!iface && isBuiltinErc20Import(interfaceName, mod)) {
    const builtin = BUILTIN_ERC20[method];
    if (!builtin) return undefined;
    const signature = signatureOf({ type: "function", name: method, inputs: builtin.params });
    return { signature, selector: selectorOf(signature) };
  }
  return undefined;
}

const REASON_RULES: { test: RegExp; reason: string }[] = [
  { test: /^(transfer|transferFrom)$/, reason: "moves tokens to or from an external address" },
  { test: /^approve$/, reason: "grants a token allowance to an external address" },
  { test: /^(balanceOf|allowance|decimals|totalSupply|symbol|name)$/, reason: "reads state from an external token contract" },
  { test: /^(mint|burn)$/, reason: "changes the supply of an external token" },
  { test: /^(deposit|withdraw|redeem)$/, reason: "moves value into or out of an external vault" },
];

function reasonFor(method: string): string {
  for (const r of REASON_RULES) if (r.test.test(method)) return r.reason;
  return "invokes a function on an external contract";
}

interface DestContext {
  fnParams: Set<string>;
  localVars: Set<string>;
}

function destinationHintFor(expr: string, mod: ParsedModule, ctx: DestContext, contractType?: string): DestinationHint {
  const trimmed = expr.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { kind: "literal", address: trimmed.toLowerCase(), contractType };
  const selfMatch = /^self\.([A-Za-z_]\w*)$/.exec(trimmed);
  if (selfMatch) return { kind: "state", name: selfMatch[1], contractType };
  const bare = /^[A-Za-z_]\w*$/.exec(trimmed);
  if (bare) {
    const name = trimmed;
    if (ctx.fnParams.has(name)) return { kind: "parameter", name, contractType };
    const stateVar = mod.stateVars.get(name);
    if (stateVar?.isImmutable) return { kind: "immutable", name, contractType };
    if (stateVar?.isConstant) return { kind: "constant", name, contractType };
    if (ctx.localVars.has(name)) return { kind: "local", name, contractType };
  }
  const indexMatch = /^self\.([A-Za-z_]\w*)\[/.exec(trimmed);
  if (indexMatch) return { kind: "state", name: indexMatch[1], contractType };
  return { kind: "unknown", contractType };
}

interface Accumulator {
  reads: Map<string, StateAccess>;
  writes: Map<string, StateAccess>;
  internalCalls: StaticInternalCall[];
  externalCalls: StaticExternalCall[];
  events: Set<string>;
  notes: Set<string>;
  /** Raw statement text visited, for the access-control pass. */
  statements: string[];
}

function newAccumulator(): Accumulator {
  return { reads: new Map(), writes: new Map(), internalCalls: [], externalCalls: [], events: new Set(), notes: new Set(), statements: [] };
}

function recordAccess(target: Map<string, StateAccess>, name: string, mod: ParsedModule, via: string[]): void {
  if (target.has(name)) return;
  const decl = mod.stateVars.get(name);
  target.set(name, { name, type: decl?.type, via: [...via] });
}

/** Joins logical statements in a function body across bracket continuations, into one text blob per statement. */
function joinBodyStatements(body: VyperLine[]): { text: string; firstLine: VyperLine }[] {
  const out: { text: string; firstLine: VyperLine }[] = [];
  let i = 0;
  while (i < body.length) {
    let depth = 0;
    let text = "";
    const first = body[i] as VyperLine;
    let j = i;
    for (; j < body.length; j++) {
      const line = body[j] as VyperLine;
      text += (text ? " " : "") + line.text;
      for (const ch of line.text) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
      }
      if (depth <= 0) {
        j++;
        break;
      }
    }
    out.push({ text, firstLine: first });
    i = j;
  }
  return out;
}

export function eventSignatureFor(name: string, mod: ParsedModule): string {
  const decl = mod.events.get(name);
  if (!decl) return `${name}(...)`;
  const parts: string[] = [];
  for (const f of decl.fields) {
    const indexedMatch = /^indexed\((.*)\)$/s.exec(f.type.trim());
    const bareType = indexedMatch ? (indexedMatch[1] as string).trim() : f.type;
    const mapped = vyperTypeToAbi(bareType, mod);
    if (!mapped) return `${name}(...)`;
    parts.push(mapped.type);
  }
  return `${name}(${parts.join(",")})`;
}

/** Consumes the target and data arguments of `raw_call(...)` and any recognised keyword arguments. */
function parseRawCallArgs(argsText: string): { target?: string; data?: string; isDelegate: boolean; isStatic: boolean; methodId?: string } {
  const parts = splitTopLevel(argsText, ",").map((p) => p.trim());
  const positional = parts.filter((p) => !p.includes("="));
  const target = positional[0];
  const data = positional[1];
  const joined = argsText;
  const isDelegate = /is_delegate_call\s*=\s*True/.test(joined);
  const isStatic = /is_static_call\s*=\s*True/.test(joined);
  const methodIdMatch = /method_id\(\s*["']([^"']+)["']\s*\)/.exec(joined);
  return { target, data, isDelegate, isStatic, methodId: methodIdMatch?.[1] };
}

function pushBuiltinCall(acc: Accumulator, call: StaticExternalCall): void {
  acc.externalCalls.push(call);
}

/** Walks one function body, recording state access, internal calls, outbound calls, and events. Recurses into internal helpers up to `MAX_DEPTH`. */
function walkBody(
  body: VyperLine[],
  mod: ParsedModule,
  via: string[],
  depth: number,
  onPath: Set<string>,
  fnParams: Set<string>,
  acc: Accumulator,
  warnings: string[],
): void {
  const localVars = new Set<string>();
  const ctx: DestContext = { fnParams, localVars };
  const statements = joinBodyStatements(body);

  for (const { text } of statements) {
    if (text.length === 0) continue;
    acc.statements.push(text);

    const assign = findAssignment(text);
    if (assign) {
      const targetName = /^\s*([A-Za-z_]\w*)\s*:?/.exec(assign.lhs)?.[1];
      if (targetName && !assign.lhs.trimStart().startsWith("self.")) localVars.add(targetName);
    }

    // -- self.NAME state access, self.NAME( internal call, self.NAME.method( interface call are all rooted here.
    const selfRe = /self\.([A-Za-z_]\w*)/g;
    let sm: RegExpExecArray | null;
    while ((sm = selfRe.exec(text)) !== null) {
      const name = sm[1] as string;
      const afterIdx = sm.index + sm[0].length;
      let k = afterIdx;
      while (/\s/.test(text[k] ?? "")) k++;
      if (text[k] === "(") continue; // handled as an internal call below
      if (text[k] === "." && /[A-Za-z_]/.test(text[k + 1] ?? "")) {
        const methodMatch = /^\.([A-Za-z_]\w*)\s*\(/.exec(text.slice(k));
        if (methodMatch) continue; // handled as a self.x.method( external call below
      }
      const posDepth = depthAt(text, sm.index);
      const isWrite = assign !== undefined && sm.index < assign.lhs.length && posDepth === 0;
      if (isWrite) {
        recordAccess(acc.writes, name, mod, via);
        if (assign.op !== "=") recordAccess(acc.reads, name, mod, via);
      } else {
        recordAccess(acc.reads, name, mod, via);
      }
    }

    // -- self.NAME( internal calls, and self.NAME.method( external calls through an interface-typed state var.
    const internalRe = /self\.([A-Za-z_]\w*)\s*\(/g;
    let im: RegExpExecArray | null;
    while ((im = internalRe.exec(text)) !== null) {
      const name = im[1] as string;
      const callee = mod.functions.get(name);
      if (!callee) {
        acc.notes.add(`the internal call self.${name}(...) does not match a def in the provided source`);
        continue;
      }
      acc.internalCalls.push({ name, kind: "internal", depth: depth, via: [...via], purpose: `runs the internal ${name} routine` });
      if (onPath.has(name)) {
        acc.notes.add(`the call graph through ${name} was cut short: it recurses back onto its own call path`);
        continue;
      }
      if (depth >= MAX_DEPTH) {
        acc.notes.add(`the call graph was cut off at depth ${MAX_DEPTH} below ${name}`);
        continue;
      }
      onPath.add(name);
      walkBody(callee.body, mod, [...via, name], depth + 1, onPath, new Set([...fnParams, ...callee.params.map((p) => p.name)]), acc, warnings);
      onPath.delete(name);
    }

    for (const site of scanSelfInterfaceCalls(text, mod)) {
      const stateVar = mod.stateVars.get(site.stateVar);
      const contractType = stateVar ? mod.interfaces.has(stateVar.type) ? stateVar.type : undefined : undefined;
      const resolved = contractType ? resolveInterfaceSignature(contractType, site.method, mod) : undefined;
      if (contractType && !resolved) acc.notes.add(`the signature of ${contractType}.${site.method} could not be resolved from its interface declaration`);
      if (!contractType) acc.notes.add(`${site.addrExpr}.${site.method}(...) is called, but ${site.addrExpr} has no locally declared interface type`);
      const callType: CallType = site.keyword === "staticcall" ? "staticcall" : "call";
      const destKind: DestinationHint["kind"] = stateVar?.isImmutable ? "immutable" : stateVar?.isConstant ? "constant" : "state";
      acc.externalCalls.push({
        destExpr: site.addrExpr,
        destination: { kind: destKind, name: site.stateVar, contractType },
        functionName: site.method,
        signature: resolved?.signature,
        selector: resolved?.selector,
        argCount: argCountOf(site.argsText),
        callType,
        via: [...via],
        reason: reasonFor(site.method),
      });
    }

    for (const site of scanInterfaceCalls(text, mod)) {
      const resolved = resolveInterfaceSignature(site.interfaceName, site.method, mod);
      if (!resolved) acc.notes.add(`the signature of ${site.interfaceName}.${site.method} could not be resolved: no local interface declaration matched it`);
      const callType: CallType = site.keyword === "staticcall" ? "staticcall" : "call";
      acc.externalCalls.push({
        destExpr: `${site.interfaceName}(${site.addrExpr})`,
        destination: destinationHintFor(site.addrExpr, mod, ctx, site.interfaceName),
        functionName: site.method,
        signature: resolved?.signature,
        selector: resolved?.selector,
        argCount: argCountOf(site.argsText),
        callType,
        via: [...via],
        reason: reasonFor(site.method),
      });
    }

    // -- raw_call(target, data, ...)
    const rawCallRe = /\braw_call\s*\(/g;
    let rm: RegExpExecArray | null;
    while ((rm = rawCallRe.exec(text)) !== null) {
      const parenStart = rm.index + rm[0].length - 1;
      const closeIdx = matchBracket(text, parenStart);
      if (closeIdx === -1) continue;
      const argsText = text.slice(parenStart + 1, closeIdx);
      const { target, isDelegate, isStatic, methodId } = parseRawCallArgs(argsText);
      const resolved = methodId ? { signature: methodId, selector: selectorOf(methodId) } : undefined;
      if (methodId && !resolved) acc.notes.add(`raw_call method_id("${methodId}") could not be hashed into a selector`);
      const callType: CallType = isDelegate ? "delegatecall" : isStatic ? "staticcall" : resolved ? "call" : "dynamic";
      if (!resolved && !isDelegate && !isStatic) acc.notes.add("raw_call sends dynamically computed calldata; the target function could not be resolved");
      pushBuiltinCall(acc, {
        destExpr: "raw_call(...)",
        destination: target ? destinationHintFor(target, mod, ctx) : { kind: "unknown" },
        functionName: resolved ? (resolved.signature.split("(")[0] as string) : "raw_call",
        signature: resolved?.signature,
        selector: resolved?.selector,
        argCount: argCountOf(argsText),
        callType,
        via: [...via],
        reason: "sends a low-level call with hand-built calldata",
      });
    }

    // -- send(target, value)
    const sendMatch = /\bsend\s*\(([^()]*)\)/.exec(text);
    if (sendMatch) {
      const args = splitTopLevel(sendMatch[1] ?? "", ",").map((a) => a.trim());
      pushBuiltinCall(acc, {
        destExpr: "send(...)",
        destination: args[0] ? destinationHintFor(args[0], mod, ctx) : { kind: "unknown" },
        functionName: "<native ETH transfer>",
        argCount: 0,
        callType: "transfer",
        via: [...via],
        reason: "sends native ETH to an external address",
      });
    }

    // -- create_from_blueprint(...) / create_minimal_proxy_to(...)
    const createMatch = /\b(create_from_blueprint|create_minimal_proxy_to)\s*\(/.exec(text);
    if (createMatch) {
      const parenStart = (createMatch.index as number) + createMatch[0].length - 1;
      const closeIdx = matchBracket(text, parenStart);
      const argsText = closeIdx === -1 ? "" : text.slice(parenStart + 1, closeIdx);
      pushBuiltinCall(acc, {
        destExpr: `${createMatch[1]}(...)`,
        destination: { kind: "unknown" },
        functionName: createMatch[1] as string,
        argCount: argCountOf(argsText),
        callType: "create",
        via: [...via],
        reason: "deploys a new contract instance",
      });
    }

    // -- log EventName(...)
    const logMatch = /\blog\s+([A-Za-z_]\w*)\s*\(/.exec(text);
    if (logMatch) {
      const name = logMatch[1] as string;
      if (!mod.events.has(name)) acc.notes.add(`log ${name}(...) does not match a declared event`);
      acc.events.add(eventSignatureFor(name, mod));
    }
  }
}

const OWNER_RE = /assert\s+msg\.sender\s*==\s*(self\.)?([A-Za-z_]\w*)/;
const OWNER_NEQ_RE = /if\s+msg\.sender\s*!=\s*(self\.)?([A-Za-z_]\w*)\s*:/;
const ROLE_IN_RE = /assert\s+msg\.sender\s*in\s+(self\.)?([A-Za-z_]\w*)/;
const ROLE_MAP_RE = /assert\s+(self\.)?([A-Za-z_]\w*)\s*\[\s*msg\.sender\s*\]/;

/** Derives `AccessControl` from the statements a function's own walk visited, never from a comment. */
function deriveAccessControl(statements: string[]): AccessControl {
  const gates: string[] = [];
  let kind: AccessControl["kind"] | undefined;
  let subject: string | undefined;

  for (const stmt of statements) {
    let m = OWNER_RE.exec(stmt) ?? OWNER_NEQ_RE.exec(stmt);
    if (m) {
      gates.push(stmt);
      const name = m[2] as string;
      subject = m[1] ? `self.${name}` : name;
      kind = name.toLowerCase().includes("owner") ? "owner" : "restricted";
      continue;
    }
    m = ROLE_IN_RE.exec(stmt) ?? ROLE_MAP_RE.exec(stmt);
    if (m) {
      gates.push(stmt);
      subject = m[1] ? `self.${m[2]}` : (m[2] as string);
      kind = "role";
      continue;
    }
    if (/^(assert|if)\b/.test(stmt) && /msg\.sender/.test(stmt) && !gates.includes(stmt)) {
      gates.push(stmt);
      if (!kind) kind = "unknown";
    }
  }

  if (!kind) return { kind: "open", detail: "Any address may call this function.", gates: [] };
  const detail =
    kind === "owner" || kind === "restricted"
      ? `Only the address in \`${subject}\` may call this function.`
      : kind === "role"
        ? `Only an address recorded in \`${subject}\` may call this function.`
        : "This function reads `msg.sender`, but the check's shape was not recognised.";
  return { kind, detail, gates: [...new Set(gates)] };
}

export interface AnalyzedFunction {
  reads: StateAccess[];
  writes: StateAccess[];
  internalCalls: StaticInternalCall[];
  externalCalls: StaticExternalCall[];
  events: string[];
  notes: string[];
  access: AccessControl;
  internalFunctionsTouched: Set<string>;
}

/** Analyses one exposed (`@external`) function: its full call graph, state access, and access control. */
export function analyzeExposedFunction(fn: ParsedFunction, mod: ParsedModule, warnings: string[]): AnalyzedFunction {
  const acc = newAccumulator();
  const fnParams = new Set(fn.params.map((p) => p.name));
  walkBody(fn.body, mod, [], 1, new Set(), fnParams, acc, warnings);
  const access = deriveAccessControl(acc.statements);
  const internalFunctionsTouched = new Set(acc.internalCalls.map((c) => c.name));
  return {
    reads: [...acc.reads.values()],
    writes: [...acc.writes.values()],
    internalCalls: acc.internalCalls,
    externalCalls: acc.externalCalls,
    events: [...acc.events],
    notes: [...acc.notes],
    access,
    internalFunctionsTouched,
  };
}

/** Builds the `FunctionAnalysis` shell for one exposed function, before evidence-based role/description generation. */
export function buildFunctionAnalysis(fn: ParsedFunction, mod: ParsedModule, warnings: string[]): FunctionAnalysis {
  const { visibility, mutability } = deriveVisibilityMutability(fn.decorators);
  const analyzed = analyzeExposedFunction(fn, mod, warnings);
  const params: AbiParam[] = [];
  for (const p of fn.params) {
    const mapped = vyperTypeToAbi(p.type, mod);
    if (mapped) params.push({ name: p.name, type: mapped.type, components: mapped.components });
    else {
      params.push({ name: p.name, type: p.type });
      analyzed.notes.push(`the parameter type \`${p.type}\` of \`${p.name}\` could not be mapped to a canonical ABI type`);
    }
  }
  const outputs: AbiParam[] = [];
  if (fn.returns) {
    const outParts = splitTopLevel(fn.returns.trim(), ",");
    for (const part of outParts) {
      const mapped = vyperTypeToAbi(part.trim(), mod);
      if (mapped) outputs.push({ type: mapped.type, components: mapped.components });
      else {
        outputs.push({ type: part.trim() });
        analyzed.notes.push(`the return type \`${part.trim()}\` could not be mapped to a canonical ABI type`);
      }
    }
  }
  const modifiers = fn.decorators.filter((d) => !/^(external|internal|view|pure|payable|public|constant)(\(|$)/.test(d));
  const signature = `${fn.name}(${params.map((p) => p.type).join(",")})`;
  return {
    name: fn.name,
    signature,
    selector: selectorOf(signature),
    params,
    outputs,
    visibility,
    mutability,
    modifiers,
    access: analyzed.access,
    role: "",
    whatItDoes: "",
    natspec: fn.docstring,
    reads: analyzed.reads,
    writes: analyzed.writes,
    internalCalls: analyzed.internalCalls,
    externalCalls: analyzed.externalCalls,
    events: analyzed.events,
    notes: analyzed.notes,
    hasSource: true,
    overloaded: false,
  };
}
