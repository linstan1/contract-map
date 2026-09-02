/**
 * Entry point of the Vyper static analyser. Parses every provided source
 * file, merges their module-level declarations into one flat symbol space
 * (Vyper inlines an imported module's code into the contract that imports
 * it, so there is no cross-file dispatch to model), analyses every exposed
 * (`@external`) function and every `public(...)` getter, and reconciles the
 * result against the ABI exactly as the Solidity analyser does.
 *
 * The ABI is ground truth for the callable surface. Every returned function
 * carries a selector taken from the ABI when the ABI is not empty. A source
 * function or getter that cannot be matched to at least one ABI entry by
 * name is left out, with a warning naming it, rather than guessing.
 */

import { eventsFromAbi, selectorOf, signatureOf, topic0Of } from "../abi";
import type { AbiEntry, AbiParam, AccessControl, EventAnalysis, FunctionAnalysis, SourceFile } from "../types";
import { describeFunction } from "../solidity/describe";
import { stripVyper } from "./lex";
import { parseModule, type ParsedFunction, type ParsedModule } from "./parse";
import { buildFunctionAnalysis, eventSignatureFor, publicGetterShape } from "./analyze";

export interface VyperAnalysisInput {
  files: SourceFile[];
  contractName?: string;
  abi: AbiEntry[];
  address: string;
}

export interface VyperAnalysisOutput {
  contractName?: string;
  inheritance: string[];
  functions: FunctionAnalysis[];
  events: EventAnalysis[];
  internalFunctionCount: number;
  warnings: string[];
}

/** Merges every file's declarations into one module. Vyper compiles an imported module's code into the caller, so one flat namespace matches how the bytecode actually runs. */
function mergeModules(files: SourceFile[], warnings: string[]): ParsedModule {
  const merged: ParsedModule = {
    functions: new Map(),
    stateVars: new Map(),
    events: new Map(),
    structs: new Map(),
    enums: new Map(),
    interfaces: new Map(),
    imports: [],
    implements: [],
    exports: [],
    warnings: [],
    moduleDocstring: undefined,
  };
  for (const file of files) {
    const stripped = stripVyper(file.content);
    const originalLines = file.content.replace(/\r\n/g, "\n").split("\n");
    const mod = parseModule(stripped.lines, originalLines, stripped.moduleDocstring);
    warnings.push(...mod.warnings.map((w) => `${file.path}: ${w}`));
    if (merged.moduleDocstring === undefined) merged.moduleDocstring = mod.moduleDocstring;
    for (const [name, fn] of mod.functions) {
      if (merged.functions.has(name)) warnings.push(`\`${name}\` is declared in more than one source file; keeping the first declaration`);
      else merged.functions.set(name, fn);
    }
    for (const [name, v] of mod.stateVars) if (!merged.stateVars.has(name)) merged.stateVars.set(name, v);
    for (const [name, e] of mod.events) if (!merged.events.has(name)) merged.events.set(name, e);
    for (const [name, s] of mod.structs) if (!merged.structs.has(name)) merged.structs.set(name, s);
    for (const [name, e] of mod.enums) if (!merged.enums.has(name)) merged.enums.set(name, e);
    for (const [name, iface] of mod.interfaces) if (!merged.interfaces.has(name)) merged.interfaces.set(name, iface);
    merged.imports.push(...mod.imports);
    merged.implements.push(...mod.implements);
    merged.exports.push(...mod.exports);
  }
  return merged;
}

function isExternal(fn: ParsedFunction): boolean {
  return fn.decorators.some((d) => {
    const name = (d.split("(")[0] ?? d).trim();
    return name === "external" || name === "public";
  });
}

/** A `FunctionAnalysis` built from an ABI entry alone, used when no source declaration or getter matches it. */
function fromAbiOnly(entry: AbiEntry, overloaded: boolean): FunctionAnalysis {
  const signature = entry.type === "function" ? signatureOf(entry) : `${entry.type}()`;
  const selector = entry.type === "function" ? selectorOf(signature) : "";
  const access: AccessControl = { kind: "unknown", detail: "Access control could not be determined without matching source.", gates: [] };
  return {
    name: entry.name ?? entry.type,
    signature,
    selector,
    params: (entry.inputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components })),
    outputs: (entry.outputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components })),
    visibility: "external",
    mutability: entry.stateMutability === "view" || entry.stateMutability === "pure" || entry.stateMutability === "payable" ? entry.stateMutability : "nonpayable",
    modifiers: [],
    access,
    role: "unknown / no source",
    whatItDoes: "This function appears in the ABI, but no matching source declaration was found. Its behaviour is unknown.",
    reads: [],
    writes: [],
    internalCalls: [],
    externalCalls: [],
    events: [],
    notes: ["no matching source declaration was found for this ABI entry"],
    hasSource: false,
    overloaded,
  };
}

/** Builds the `FunctionAnalysis` for one `public(...)` state-variable getter, when its shape can be resolved. */
function buildGetter(name: string, type: string, mod: ParsedModule, kind: "storage" | "immutable" | "constant"): FunctionAnalysis | undefined {
  const shape = publicGetterShape(type, mod);
  if (!shape) return undefined;
  const signature = `${name}(${shape.params.map((p) => p.type).join(",")})`;
  const source = kind === "storage" ? `self.${name}` : name;
  return {
    name,
    signature,
    selector: selectorOf(signature),
    params: shape.params,
    outputs: [shape.returns],
    visibility: "external",
    mutability: "view",
    modifiers: [],
    access: { kind: "open", detail: "Any address may call this function.", gates: [] },
    role: "view / accounting",
    whatItDoes: `This is the getter Vyper generated for the public ${kind === "storage" ? "state variable" : kind} \`${name}\`. It reads \`${source}\` and returns its value.`,
    reads: [{ name, type, via: [] }],
    writes: [],
    internalCalls: [],
    externalCalls: [],
    events: [],
    notes: ["Vyper generated this getter from a `public(...)` state variable; it has no function body of its own."],
    hasSource: true,
    overloaded: false,
  };
}

function buildEvents(mod: ParsedModule, abi: AbiEntry[]): EventAnalysis[] {
  const out = new Map<string, EventAnalysis>();
  for (const [name] of mod.events) {
    const sig = eventSignatureFor(name, mod);
    if (sig.endsWith("(...)")) continue;
    out.set(sig, { name, signature: sig, topic0: topic0Of(sig) as `0x${string}` });
  }
  for (const ev of eventsFromAbi(abi)) out.set(ev.signature, ev);
  return [...out.values()];
}

/** Parses the given Vyper sources and builds the full static analysis of the deployed contract. */
export function analyzeVyperSources(input: VyperAnalysisInput): VyperAnalysisOutput {
  const warnings: string[] = [];
  const mod = mergeModules(input.files, warnings);

  if (mod.functions.size === 0) {
    warnings.push("no `def` declaration was found in the provided sources");
  }

  const abiRelevant = input.abi.filter((e) => e.type === "function" || e.type === "receive" || e.type === "fallback");
  const abiByName = new Map<string, AbiEntry[]>();
  for (const e of abiRelevant) {
    if (e.type !== "function" || !e.name) continue;
    const list = abiByName.get(e.name) ?? [];
    list.push(e);
    abiByName.set(e.name, list);
  }

  let functions: FunctionAnalysis[] = [];
  const claimedByName = new Set<string>();
  let hasDefault = false;

  for (const [name, fn] of mod.functions) {
    if (name === "__init__") continue;
    if (!isExternal(fn)) continue;
    if (name === "__default__") {
      hasDefault = true;
      continue;
    }
    const analysis = buildFunctionAnalysis(fn, mod, warnings);
    const { role, whatItDoes } = describeFunction(analysis);
    analysis.role = role;
    analysis.whatItDoes = whatItDoes;

    const abiMatches = abiByName.get(name);
    if (abiRelevant.length > 0) {
      if (!abiMatches || abiMatches.length === 0) {
        warnings.push(`excluded ${name}(...) from the exposed surface: no ABI entry named \`${name}\` was found`);
        continue;
      }
      claimedByName.add(name);
      for (const entry of abiMatches) {
        const clone: FunctionAnalysis = { ...analysis, params: (entry.inputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components })) };
        clone.outputs = (entry.outputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components }));
        clone.signature = signatureOf(entry);
        clone.selector = selectorOf(clone.signature);
        clone.mutability = entry.stateMutability === "view" || entry.stateMutability === "pure" || entry.stateMutability === "payable" ? entry.stateMutability : "nonpayable";
        functions.push(clone);
      }
    } else {
      functions.push(analysis);
    }
  }

  if (hasDefault) {
    const fallbackEntry = abiRelevant.find((e) => e.type === "fallback");
    if (fallbackEntry || abiRelevant.length === 0) {
      const defaultFn = mod.functions.get("__default__") as ParsedFunction;
      const analysis = buildFunctionAnalysis(defaultFn, mod, warnings);
      analysis.name = "fallback";
      analysis.signature = "fallback()";
      analysis.selector = "";
      const { role, whatItDoes } = describeFunction(analysis);
      analysis.role = role;
      analysis.whatItDoes = whatItDoes;
      functions.push(analysis);
    }
  }

  // Getters generated from `public(...)` state variables.
  for (const [name, v] of mod.stateVars) {
    if (!v.isPublic) continue;
    if (abiRelevant.length > 0 && !abiByName.has(name)) continue;
    const getter = buildGetter(name, v.type, mod, v.isImmutable ? "immutable" : v.isConstant ? "constant" : "storage");
    if (!getter) {
      warnings.push(`the getter for public state variable \`${name}\` (type \`${v.type}\`) could not be resolved to a canonical ABI shape`);
      continue;
    }
    claimedByName.add(name);
    if (abiRelevant.length > 0) {
      for (const entry of abiByName.get(name) ?? []) {
        const clone: FunctionAnalysis = { ...getter };
        clone.params = (entry.inputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components }));
        clone.outputs = (entry.outputs ?? []).map((p): AbiParam => ({ name: p.name, type: p.type, components: p.components }));
        clone.signature = signatureOf(entry);
        clone.selector = selectorOf(clone.signature);
        functions.push(clone);
      }
    } else {
      functions.push(getter);
    }
  }

  // Reconcile against the ABI: every ABI function/receive/fallback entry must appear in the output.
  const bySelector = new Map<string, FunctionAnalysis>();
  for (const f of functions) if (f.selector) bySelector.set(f.selector, f);
  const hasFallback = functions.some((f) => f.name === "fallback");
  let unresolvedAbiCount = 0;
  for (const entry of abiRelevant) {
    if (entry.type === "receive" || entry.type === "fallback") {
      if (entry.type === "fallback" && hasFallback) continue;
      functions.push(fromAbiOnly(entry, false));
      unresolvedAbiCount++;
      continue;
    }
    const sig = signatureOf(entry);
    const sel = selectorOf(sig);
    if (!bySelector.has(sel)) {
      functions.push(fromAbiOnly(entry, (abiByName.get(entry.name ?? "")?.length ?? 0) > 1));
      unresolvedAbiCount++;
    }
  }
  if (unresolvedAbiCount > 0) {
    warnings.push(`${unresolvedAbiCount} ABI function entr${unresolvedAbiCount === 1 ? "y has" : "ies have"} no matching source declaration`);
  }

  // Hard invariant: when the ABI is non-empty, never return a function selector the ABI does not contain.
  if (abiRelevant.length > 0) {
    const abiSelectors = new Set(abiRelevant.filter((e) => e.type === "function").map((e) => selectorOf(signatureOf(e))));
    const before = functions.length;
    functions = functions.filter((f) => f.selector === "" || abiSelectors.has(f.selector));
    if (functions.length < before) warnings.push(`dropped ${before - functions.length} function(s) whose selector was not present in the ABI`);
  }

  // Overloaded is a property of the final, reconciled surface.
  const finalNameCounts = new Map<string, number>();
  for (const f of functions) finalNameCounts.set(f.name, (finalNameCounts.get(f.name) ?? 0) + 1);
  for (const f of functions) f.overloaded = (finalNameCounts.get(f.name) ?? 0) > 1;

  const functionsWithNotes = functions.filter((f) => f.notes.length > 0).length;
  if (functionsWithNotes > 0) {
    warnings.push(`${functionsWithNotes} of ${functions.length} exposed functions have at least one unresolved construct; see each function's notes`);
  }

  const internalFunctionCount = [...mod.functions.values()].filter((fn) => !isExternal(fn) && fn.name !== "__init__").length;

  return {
    contractName: input.contractName,
    inheritance: [...mod.implements],
    functions,
    events: buildEvents(mod, input.abi),
    internalFunctionCount,
    warnings,
  };
}
