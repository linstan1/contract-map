/**
 * Entry point of the static analyser (agent 1). Parses every provided
 * source file, builds one cross-file type registry, picks the deployed
 * contract, linearises its inheritance, walks the call graph of every
 * exposed function, and reconciles the result against the ABI.
 *
 * The ABI is ground truth for the callable surface. When it is not empty,
 * every returned function carries a selector taken from the ABI: never one
 * this analyser hashed itself. A source function that cannot be matched to
 * exactly one ABI entry by name and parameter count is left out, with a
 * warning naming it, rather than guessing.
 */

import { eventsFromAbi, selectorOf, signatureOf, topic0Of } from "../abi";
import type { AbiEntry, AbiParam, AccessControl, EventAnalysis, FunctionAnalysis, SourceFile } from "../types";
import { stripSource } from "./lex";
import { parseFile, type ParsedFunction, type ParsedUnit } from "./parse";
import { analyzeExposedFunction, type SourceLookup } from "./analyze";
import { describeFunction } from "./describe";
import { buildTypeRegistry, type FileUnits, type TypeRegistry } from "./typeresolve";

export interface SourceAnalysisInput {
  files: SourceFile[];
  contractName?: string;
  abi: AbiEntry[];
  address: string;
}

export interface SourceAnalysisOutput {
  contractName?: string;
  inheritance: string[];
  functions: FunctionAnalysis[];
  events: EventAnalysis[];
  internalFunctionCount: number;
  warnings: string[];
}

interface ExposedFn {
  fn: ParsedFunction;
  file: string;
}

function paramKey(fn: ParsedFunction): string {
  return `${fn.name}(${fn.params.map((p) => p.type).join(",")})`;
}

/** Picks the deployed unit: the named unit, the best ABI match, or the last concrete unit in the main file. */
function pickDeployedUnit(unitsByFile: Map<string, ParsedUnit[]>, files: SourceFile[], contractName: string | undefined, abi: AbiEntry[]): { name: string; file: string } | undefined {
  const allContracts: { unit: ParsedUnit; file: string }[] = [];
  for (const [file, units] of unitsByFile) for (const unit of units) if (unit.kind === "contract") allContracts.push({ unit, file });

  if (contractName) {
    const named = allContracts.find((c) => c.unit.name === contractName);
    if (named) return { name: named.unit.name, file: named.file };
  }

  const abiNames = new Set(abi.filter((e) => e.type === "function" && e.name).map((e) => e.name as string));
  if (abiNames.size > 0) {
    let best: { name: string; file: string } | undefined;
    let bestScore = 0;
    for (const { unit, file } of allContracts) {
      const score = unit.functions.filter((fn) => fn.kind === "function" && fn.name && abiNames.has(fn.name)).length;
      if (score > bestScore) {
        bestScore = score;
        best = { name: unit.name, file };
      }
    }
    if (best) return best;
  }

  const mainFile = files[0]?.path;
  const inMain = allContracts.filter((c) => c.file === mainFile);
  const pick = inMain.length > 0 ? inMain[inMain.length - 1] : allContracts[allContracts.length - 1];
  return pick ? { name: pick.unit.name, file: pick.file } : undefined;
}

/** Collects the exposed (public/external/receive/fallback) functions along a linearised chain, most derived wins. */
function collectExposed(unitsByFile: Map<string, ParsedUnit[]>, chain: { name: string; file: string }[]): ExposedFn[] {
  const byKey = new Map<string, ExposedFn>();
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    if (!c) continue;
    const unit = (unitsByFile.get(c.file) ?? []).find((u) => u.name === c.name);
    if (!unit) continue;
    for (const fn of unit.functions) {
      if (fn.kind === "constructor") continue;
      if (fn.kind === "function" && fn.visibility !== "public" && fn.visibility !== "external") continue;
      const key = fn.kind === "function" ? paramKey(fn) : fn.kind;
      byKey.set(key, { fn, file: c.file });
    }
  }
  return [...byKey.values()];
}

/** A `FunctionAnalysis` built from an ABI entry alone, used when no source declaration matches it. */
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
/** Merges the deployed contract's own event declarations with any ABI-only events, deduped by signature. */
function buildEventAnalyses(memberEvents: Iterable<{ name: string; params: { name?: string; type: string }[] }>, registry: TypeRegistry, callingFile: string, abiEvents: EventAnalysis[]): EventAnalysis[] {
  const out = new Map<string, EventAnalysis>();
  for (const ev of memberEvents) {
    const sig = registry.canonicalSignature(ev.name, ev.params, callingFile);
    if (!sig) continue;
    out.set(sig, { name: ev.name, signature: sig, topic0: topic0Of(sig) as `0x${string}` });
  }
  for (const ev of abiEvents) out.set(ev.signature, ev);
  return [...out.values()];
}

/**
 * Reconciliation result for one exposed source function against the ABI:
 * either an adopted ABI entry (ground-truth signature/selector), a decision
 * to exclude the function (named in a warning), or "keep as-is" when the
 * ABI is empty and the analyser's own best-effort signature stands.
 */
type AbiMatch = { kind: "adopt"; entry: AbiEntry } | { kind: "exclude"; reason: string } | { kind: "keep" };

function matchAgainstAbi(analysis: FunctionAnalysis, declaredSignature: string | undefined, abiByNameArity: Map<string, AbiEntry[]>): AbiMatch {
  const key = `${analysis.name}:${analysis.params.length}`;
  const candidates = abiByNameArity.get(key) ?? [];
  if (candidates.length === 0) {
    return { kind: "exclude", reason: `no ABI entry named '${analysis.name}' with ${analysis.params.length} parameter(s)` };
  }
  if (candidates.length === 1) return { kind: "adopt", entry: candidates[0]! };
  if (!declaredSignature) {
    return { kind: "exclude", reason: `${candidates.length} ABI overloads share the name '${analysis.name}' and arity ${analysis.params.length}, and the source parameter types could not be canonicalised to disambiguate` };
  }
  const exact = candidates.filter((c) => signatureOf(c) === declaredSignature);
  if (exact.length === 1) return { kind: "adopt", entry: exact[0]! };
  return { kind: "exclude", reason: `${candidates.length} ABI overloads share the name '${analysis.name}' and arity ${analysis.params.length}, and none matched the canonicalised source signature '${declaredSignature}'` };
}

/** Parses the given sources and builds the full static analysis of the deployed contract. */
export function analyzeSources(input: SourceAnalysisInput): SourceAnalysisOutput {
  const warnings: string[] = [];
  const unitsByFile = new Map<string, ParsedUnit[]>();
  const sourceByFile = new Map<string, SourceLookup>();
  const fileUnitsForRegistry: FileUnits[] = [];

  for (const file of input.files) {
    const stripped = stripSource(file.content);
    sourceByFile.set(file.path, { clean: stripped.clean, original: stripped.original, lineStarts: stripped.lineStarts, path: file.path });
    const { units, freeTypes, warnings: fileWarnings } = parseFile(file.path, stripped.clean, stripped.natspecByLine, stripped.lineStarts);
    warnings.push(...fileWarnings);
    unitsByFile.set(file.path, units);
    fileUnitsForRegistry.push({ path: file.path, content: file.content, units, freeTypes });
  }

  const totalUnits = [...unitsByFile.values()].reduce((n, list) => n + list.length, 0);
  if (totalUnits === 0) {
    warnings.push("no contract, library, or interface declaration was found in the provided sources");
  }

  const registry = buildTypeRegistry(fileUnitsForRegistry);
  const deployed = pickDeployedUnit(unitsByFile, input.files, input.contractName, input.abi);
  const abiRelevant = input.abi.filter((e) => e.type === "function" || e.type === "receive" || e.type === "fallback");
  const abiByNameArity = new Map<string, AbiEntry[]>();
  for (const e of abiRelevant) {
    if (e.type !== "function") continue;
    const key = `${e.name ?? ""}:${(e.inputs ?? []).length}`;
    const list = abiByNameArity.get(key) ?? [];
    list.push(e);
    abiByNameArity.set(key, list);
  }

  if (!deployed) {
    warnings.push("could not identify the deployed contract among the provided sources; only ABI-derived data is returned");
    const nameCounts = new Map<string, number>();
    for (const e of abiRelevant) nameCounts.set(e.name ?? e.type, (nameCounts.get(e.name ?? e.type) ?? 0) + 1);
    return {
      contractName: undefined,
      inheritance: [],
      functions: abiRelevant.map((e) => fromAbiOnly(e, (nameCounts.get(e.name ?? e.type) ?? 0) > 1)),
      events: eventsFromAbi(input.abi),
      internalFunctionCount: 0,
      warnings,
    };
  }

  const chain = registry.linearize(deployed.name, deployed.file);
  const member = registry.memberTable(deployed.name, deployed.file);
  const exposed = collectExposed(unitsByFile, chain);

  let functions: FunctionAnalysis[] = [];
  for (const { fn, file } of exposed) {
    const analysis = analyzeExposedFunction(fn, file, registry, sourceByFile, member, chain, warnings, false);
    const { role, whatItDoes } = describeFunction(analysis);
    analysis.role = role;
    analysis.whatItDoes = whatItDoes;

    if (abiRelevant.length > 0 && fn.kind === "function") {
      const declaredSignature = registry.canonicalSignature(fn.name, fn.params, file);
      const decision = matchAgainstAbi(analysis, declaredSignature, abiByNameArity);
      if (decision.kind === "exclude") {
        warnings.push(`excluded ${analysis.name}(${fn.params.map((p) => p.type).join(",")}) from the exposed surface: ${decision.reason}`);
        continue;
      }
      if (decision.kind === "adopt") {
        analysis.signature = signatureOf(decision.entry);
        analysis.selector = selectorOf(analysis.signature);
      }
    }
    functions.push(analysis);
  }

  // Reconcile against the ABI: every ABI function/receive/fallback entry must appear in the output.
  const bySelector = new Map<string, FunctionAnalysis>();
  for (const f of functions) if (f.selector) bySelector.set(f.selector, f);
  const receiveFallback = new Set<string>();
  for (const f of functions) if (f.name === "receive" || f.name === "fallback") receiveFallback.add(f.name);

  const abiNameCounts = new Map<string, number>();
  for (const e of abiRelevant) abiNameCounts.set(e.name ?? e.type, (abiNameCounts.get(e.name ?? e.type) ?? 0) + 1);
  let unresolvedAbiCount = 0;
  for (const entry of abiRelevant) {
    if (entry.type === "receive" || entry.type === "fallback") {
      if (!receiveFallback.has(entry.type)) {
        functions.push(fromAbiOnly(entry, false));
        unresolvedAbiCount++;
      }
      continue;
    }
    const sig = signatureOf(entry);
    const sel = selectorOf(sig);
    if (!bySelector.has(sel)) {
      functions.push(fromAbiOnly(entry, (abiNameCounts.get(entry.name ?? "") ?? 0) > 1));
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

  const events = buildEventAnalyses(member.events.values(), registry, deployed.file, eventsFromAbi(input.abi));

  return {
    contractName: deployed.name,
    inheritance: chain.map((c) => c.name),
    functions,
    events,
    internalFunctionCount: member.functions.size,
    warnings,
  };
}
