/**
 * The orchestrator, and Agent 2 of the product brief.
 *
 * Order of work:
 *   1. resolve the chain, the head block, and the code at the address
 *   2. resolve the proxy and pick the implementation whose code executes
 *   3. read metadata and verified source for both addresses
 *   4. run the source analysis (Agent 1)
 *   5. run the trace analysis (Agents 3 and 4)
 *   6. merge code facts with trace facts into one `FunctionMap` per function
 *   7. run the review (Agent 5)
 *
 * Step 6 is the product. It is the ONLY place where a static call site and an
 * observed edge meet, and it keeps them labelled: `possibleFromCode` comes
 * from source, `observedOnchain` comes from traces. A merge never turns an
 * unobserved code path into an executed one.
 */

import { bytecodeSelectors, detectStandards, EIP1822_SLOT, EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, parseAbi, selectorOf, signatureOf, topic0Of } from "./abi";
import { fetchContractMetadata, type ContractMetadata } from "./blockscout";
import { chainByKey, STAGE_BUDGET_MS } from "./config";
import { analyzeBytecode } from "./bytecode/index";
import { recoverSources } from "./sourcerecovery";
import { analyzeVyperSources } from "./vyper/index";
import { LabelBook } from "./labels";
import { buildReview } from "./review";
import { RpcClient } from "./rpc";
import { SignatureRegistry } from "./signatures";
import { analyzeSources } from "./solidity/index";
import { analyzeRuntime } from "./runtime/traces";
import type {
  AbiEntry,
  AnalysisResult,
  Depth,
  EventAnalysis,
  ExecutionNode,
  FunctionAnalysis,
  FunctionMap,
  MergedExternalCall,
  OutboundEdge,
  ProxyInfo,
  RuntimeAnalysis,
  Selector,
  StaticAnalysis,
  BytecodeFacts,
  StateAccess,
  StaticExternalCall,
  TokenInfo,
  TxRef,
} from "./types";

export interface AnalyzeOptions {
  address: string;
  chainKey: string;
  depth: Depth;
  onProgress?: (stage: string, detail: string, pct: number) => void;
}

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

export async function analyzeContract(options: AnalyzeOptions): Promise<AnalysisResult> {
  const started = Date.now();
  const chain = chainByKey(options.chainKey);
  if (!chain) throw new Error(`Unknown chain "${options.chainKey}".`);
  if (!ADDRESS_SHAPE.test(options.address)) throw new Error(`"${options.address}" is not a 20 byte address.`);

  const target = options.address.toLowerCase();
  const depth = options.depth;
  const progress = options.onProgress ?? (() => {});
  const errors: string[] = [];
  const dataSources: string[] = [`Alchemy ${chain.alchemyHost}`];

  const rpc = new RpcClient(chain);
  progress("connect", `Read the head block of ${chain.label}.`, 3);
  const headBlock = await rpc.blockNumber();

  progress("code", "Read the deployed code.", 6);
  const targetCode = await rpc.getCode(target);
  if (targetCode === "0x" || targetCode === "0x0") {
    throw new Error(`${target} holds no code on ${chain.label}. This tool explains contracts, so there is nothing to map.`);
  }

  progress("metadata", "Read contract metadata and verified source.", 12);
  const targetMeta = await fetchContractMetadata(chain, target);
  if (targetMeta.provenance.length > 0) dataSources.push(...targetMeta.provenance);
  for (const warning of targetMeta.warnings) errors.push(warning);

  progress("proxy", "Resolve the proxy pattern.", 18);
  const proxy = await resolveProxy(rpc, target, targetMeta);

  let implMeta: ContractMetadata | undefined;
  if (proxy.implementation) {
    progress("implementation", `Read the implementation at ${proxy.implementation}.`, 22);
    implMeta = await fetchContractMetadata(chain, proxy.implementation);
    if (implMeta.provenance.length > 0) dataSources.push(...implMeta.provenance);
    if (!proxy.implementationName) proxy.implementationName = implMeta.name;
  }

  /* The ABI of a proxy explains the proxy only. Both surfaces are callable, so
   * both are merged, with the implementation first because its functions carry
   * the behaviour. */
  const abi = mergeAbi(implMeta?.abi ?? [], targetMeta.abi);
  let codeMeta = implMeta && implMeta.verified ? implMeta : targetMeta;
  const codeAddress = proxy.implementation ?? target;
  const implCode = proxy.implementation ? await rpc.getCode(proxy.implementation) : targetCode;
  const scanned = bytecodeSelectors(implCode);

  /* An unverified address often has verified code elsewhere: a bytecode twin
   * that the explorer knows, or an entry in Sourcify. The recovery is only
   * accepted when the dispatcher selectors of THIS code appear in that ABI,
   * so the reader never sees the source of a different contract. */
  let sourceProvenance: string | undefined;
  if (!codeMeta.verified) {
    progress("recover", "No verified source at the address. Look for a bytecode twin and for Sourcify.", 26);
    const recovered = await recoverSources(chain, codeAddress, codeMeta.twin);
    if (recovered) {
      codeMeta = {
        ...codeMeta,
        verified: true,
        name: recovered.name ?? codeMeta.name,
        compiler: recovered.compiler ?? codeMeta.compiler,
        language: recovered.language ?? codeMeta.language,
        abi: recovered.abi.length > 0 ? recovered.abi : codeMeta.abi,
        sources: recovered.sources,
      };
      sourceProvenance = recovered.provenance;
      for (const warning of recovered.warnings) errors.push(warning);
      dataSources.push(recovered.provenance);
    }
  }

  const recoveredAbi = mergeAbi(codeMeta.abi, abi);
  const isVyper = (codeMeta.language ?? "").toLowerCase().includes("vyper");

  progress("source", codeMeta.verified ? `Analyse the verified ${isVyper ? "Vyper" : "Solidity"} source.` : "No verified source. Read the ABI and the compiled code.", 30);
  const analyseSource = isVyper ? analyzeVyperSources : analyzeSources;
  const sourceResult = codeMeta.verified && codeMeta.sources.length > 0
    ? analyseSource({ files: codeMeta.sources, contractName: codeMeta.name, abi: recoveredAbi, address: target })
    : { contractName: codeMeta.name, inheritance: [], functions: [], events: [], internalFunctionCount: 0, warnings: [] };

  const registry = new SignatureRegistry();
  registry.addAbi(recoveredAbi);

  const abiSelectorSet = new Set(recoveredAbi.filter((e) => e.type === "function" && e.name).map((e) => selectorOf(signatureOf(e))));
  const functions = reconcileFunctions(sourceResult.functions, recoveredAbi, registry, abiSelectorSet, sourceResult.warnings);
  const events = mergeEvents(sourceResult.events, recoveredAbi);

  /* A dispatcher pushes every selector it serves. Selectors that the ABI does
   * not explain point at an ABI that is incomplete, so they are reported. */
  const abiSelectors = new Set(functions.map((f) => f.selector));

  /* Compiled code answers questions that source cannot when there is no
   * source at all, and it confirms the source when there is. */
  const compiled = analyzeBytecode(implCode, [...new Set([...abiSelectors, ...scanned])]);
  for (const fn of functions) fn.bytecodeFacts = compiled.facts[fn.selector];

  const statics: StaticAnalysis = {
    verified: codeMeta.verified,
    contractName: sourceResult.contractName ?? codeMeta.name,
    compiler: codeMeta.compiler,
    language: codeMeta.language,
    proxy,
    likelyType: "",
    interfaces: [],
    inheritance: sourceResult.inheritance,
    summary: "",
    functions,
    events,
    unresolvedSelectors: [],
    sourceFiles: codeMeta.sources.map((s) => s.path),
    sourceProvenance,
    vyper: isVyper || undefined,
    warnings: [...sourceResult.warnings, ...compiled.warnings],
  };

  const labels = new LabelBook(chain, rpc, registry);
  const identity = [target, ...(proxy.implementation ? [proxy.implementation.toLowerCase()] : [])];

  progress("traces", "Scan transaction traces for observed execution.", 40);
  let traceStage = 40;
  let runtime: RuntimeAnalysis;
  /* Hard ceiling for the whole trace stage. `src/runtime` budgets discovery
   * and tracing inside this, and the client cuts any single stalled request,
   * so a slow chain degrades the window instead of hanging the request. */
  rpc.deadlineAt = Date.now() + STAGE_BUDGET_MS[depth];
  try {
    runtime = await analyzeRuntime({
      chain,
      rpc,
      target,
      identity,
      headBlock,
      depth,
      registry,
      labels,
      targetSelectors: abiSelectors.size > 0 ? abiSelectors : new Set(scanned),
      onProgress: (stage: string, detail: string) => {
        traceStage = Math.min(85, traceStage + 6);
        progress(stage, detail, traceStage);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`The trace analysis failed: ${message}`);
    runtime = emptyRuntime(headBlock, `The trace analysis failed: ${message}`);
  } finally {
    rpc.deadlineAt = undefined;
  }
  if (runtime.available) dataSources.push(chain.traceFilter ? "trace_filter and trace_transaction" : "debug_traceTransaction with callTracer");

  /* Two different addresses can carry the same name, for example several
   * adapters of one protocol. A repeated label hides that difference, so the
   * short address is appended when a label is not unique. */
  disambiguateLabels(runtime);

  /* Without an ABI the callable surface has to come from the bytecode and
   * from the selectors that traces show arriving. Both are facts, so the
   * contract still gets an exposed function list, with the provenance named. */
  if (abiSelectors.size === 0) {
    const observed = runtime.targetFunctionCalls.map((c) => c.selector).filter((s): s is Selector => !!s);
    const derived = await functionsFromSelectors(scanned, observed, registry);
    for (const fn of derived) {
      fn.bytecodeFacts = compiled.facts[fn.selector] ?? compiled.contract;
      const sentence = describeFacts(fn.bytecodeFacts);
      if (sentence) fn.whatItDoes = `${fn.whatItDoes} ${sentence}`;
    }
    functions.push(...derived);
  }
  statics.interfaces = detectStandards(abiSelectors.size > 0 ? abiSelectors : new Set(scanned));
  statics.unresolvedSelectors = [...new Set([...scanned, ...runtime.unresolvedSelectors])].filter(
    (selector) => !abiSelectors.has(selector) && !registry.lookup(selector).signature,
  );

  progress("merge", "Merge the code map with the observed execution.", 88);
  const maps = functions.map((fn) => buildFunctionMap(fn, runtime));

  /* An observed edge that matches a call site proves the code path ran. Mark
   * the edge so the outbound views can show both facts at once. */
  for (const map of maps) {
    for (const call of map.externalCalls) {
      if (!call.possibleFromCode || call.observedCalls === 0) continue;
      for (const edge of runtime.outbound.edges) {
        if (edge.targetSelector !== map.selector) continue;
        if (sameDestination(edge, call)) edge.possibleFromCode = true;
      }
    }
  }

  /* The token identity belongs to the address users hold, which is the proxy. */
  const token = targetMeta.token ?? implMeta?.token;
  statics.likelyType = classify(statics, maps, token);
  statics.summary = summarise(statics, runtime, maps, token, target);

  progress("review", "Review the evidence.", 94);
  const counterparties = new Set<string>();
  for (const c of runtime.outbound.contracts) counterparties.add(c.address);
  for (const c of runtime.inbound.contracts) counterparties.add(c.address);
  const labelled = [...counterparties].filter((a) => !labels.label(a).includes("…")).length;

  const review = buildReview({
    target,
    static: statics,
    runtime,
    functions: maps,
    resolvedSignatureCount: countResolved(runtime, maps),
    unresolvedSignatureCount: runtime.unresolvedSelectors.length,
    labelledCounterparties: labelled,
    totalCounterparties: counterparties.size,
    labelBudgetSkipped: labels.coverage().skipped,
    labelLookupsRefused: labels.coverage().refused,
    providerErrors: errors,
  });

  const observedCalls = runtime.outbound.totalCalls + runtime.inbound.totalCalls;
  progress("done", "The map is ready.", 100);

  return {
    meta: {
      address: target,
      chainId: chain.id,
      chainKey: chain.key,
      chainLabel: chain.label,
      label: labels.label(target).includes("…") ? (statics.contractName ?? labels.label(target)) : labels.label(target),
      analyzedAt: new Date().toISOString(),
      headBlock,
      durationMs: Date.now() - started,
      depth,
      dataSources: [...new Set(dataSources)],
      explorerTx: chain.explorerTx,
    },
    overview: {
      likelyType: statics.likelyType,
      verified: statics.verified,
      contractName: statics.contractName,
      proxy,
      summary: statics.summary,
      interfaces: statics.interfaces,
      token,
      stats: {
        exposedFunctions: functions.length,
        outboundContracts: runtime.outbound.contracts.length,
        inboundContracts: runtime.inbound.contracts.length,
        observedCalls,
      },
    },
    static: statics,
    runtime,
    functions: maps,
    review,
    errors,
  };
}

/* ------------------------------------------------------------------ proxies */

const IMPLEMENTATION_SELECTOR = selectorOf("implementation()");

/**
 * Finds the code that really executes.
 *
 * The explorer answer is preferred because it is a verified statement about
 * the pattern. Storage slots are read next, because a slot value is a fact
 * from the chain itself. A candidate counts only when code lives at it.
 */
async function resolveProxy(rpc: RpcClient, target: string, meta: ContractMetadata): Promise<ProxyInfo> {
  const conflicting = meta.conflicting.length > 0 ? meta.conflicting : undefined;
  const first = meta.implementations[0];
  if (first && (await hasCode(rpc, first.address))) {
    return {
      isProxy: true,
      proxyType: meta.proxyType,
      implementation: first.address.toLowerCase(),
      implementationName: first.name,
      detectedBy: "blockscout",
      conflicting,
    };
  }

  const slots: { slot: string; by: ProxyInfo["detectedBy"]; type: string }[] = [
    { slot: EIP1967_IMPLEMENTATION_SLOT, by: "eip1967-slot", type: "EIP-1967 implementation slot" },
    { slot: EIP1822_SLOT, by: "eip1822-slot", type: "EIP-1822 proxiable slot" },
  ];
  for (const entry of slots) {
    const value = await rpc.getStorageAt(target, entry.slot).catch(() => "0x");
    const candidate = addressFromWord(value);
    if (candidate && (await hasCode(rpc, candidate))) {
      return { isProxy: true, proxyType: meta.proxyType ?? entry.type, implementation: candidate, detectedBy: entry.by, conflicting };
    }
  }

  const beaconWord = await rpc.getStorageAt(target, EIP1967_BEACON_SLOT).catch(() => "0x");
  const beacon = addressFromWord(beaconWord);
  if (beacon) {
    const answer = await rpc.ethCall(beacon, IMPLEMENTATION_SELECTOR);
    const candidate = addressFromWord(answer ?? "0x");
    if (candidate && (await hasCode(rpc, candidate))) {
      return { isProxy: true, proxyType: meta.proxyType ?? "EIP-1967 beacon", implementation: candidate, detectedBy: "beacon", conflicting };
    }
  }

  const direct = addressFromWord((await rpc.ethCall(target, IMPLEMENTATION_SELECTOR)) ?? "0x");
  if (direct && direct !== target && (await hasCode(rpc, direct))) {
    return { isProxy: true, proxyType: meta.proxyType ?? "implementation() getter", implementation: direct, detectedBy: "blockscout", conflicting };
  }

  return { isProxy: false, proxyType: meta.proxyType, detectedBy: "none", conflicting };
}

async function hasCode(rpc: RpcClient, address: string): Promise<boolean> {
  const code = await rpc.getCode(address).catch(() => "0x");
  return code.length > 4;
}

/** Reads the low 20 bytes of a 32 byte word as an address, or nothing. */
function addressFromWord(word: string): string | undefined {
  if (!word || !word.startsWith("0x") || word.length < 42) return undefined;
  const tail = word.slice(-40).toLowerCase();
  if (/^0+$/.test(tail)) return undefined;
  return `0x${tail}`;
}

/* --------------------------------------------------------------- ABI merge */

function mergeAbi(first: AbiEntry[], second: AbiEntry[]): AbiEntry[] {
  const out: AbiEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...parseAbi(first), ...parseAbi(second)]) {
    const key = `${entry.type}:${signatureOf(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Guarantees one entry per callable ABI function.
 *
 * The source analysis can miss a function, for example one that a base
 * contract declares in a file the explorer did not return. Such a function
 * still exists on chain, so it is added from the ABI with `hasSource: false`
 * and no invented behaviour.
 */
function reconcileFunctions(
  fromSource: FunctionAnalysis[],
  abi: AbiEntry[],
  registry: SignatureRegistry,
  abiSelectors: Set<Selector>,
  warnings: string[],
): FunctionAnalysis[] {
  const bySelector = new Map<Selector, FunctionAnalysis>();
  /* The ABI is ground truth for the callable surface. A source function whose
   * selector is absent from a non-empty ABI carries an unresolved parameter
   * type, so its selector would be wrong. Report it, never show it. */
  for (const fn of fromSource) {
    if (abiSelectors.size > 0 && !abiSelectors.has(fn.selector)) {
      warnings.push(`The source function ${fn.signature} maps to selector ${fn.selector}, which the ABI does not contain. The entry is dropped because its parameter types stayed unresolved.`);
      continue;
    }
    bySelector.set(fn.selector, fn);
  }

  for (const entry of abi) {
    if (entry.type !== "function" || !entry.name) continue;
    const signature = signatureOf(entry);
    const selector = selectorOf(signature);
    registry.addSignature(signature, "abi");
    if (bySelector.has(selector)) continue;
    const mutability = (entry.stateMutability ?? "nonpayable") as FunctionAnalysis["mutability"];
    bySelector.set(selector, {
      name: entry.name,
      signature,
      selector,
      params: entry.inputs ?? [],
      outputs: entry.outputs ?? [],
      visibility: "external",
      mutability,
      modifiers: [],
      access: { kind: "unknown", detail: "No source body is available, so the caller restriction cannot be read.", gates: [] },
      role: mutability === "view" || mutability === "pure" ? "view / read" : "state change",
      whatItDoes: "No verified source body is available for this function. Only its ABI entry and its observed execution are known.",
      declaredIn: undefined,
      reads: [],
      writes: [],
      internalCalls: [],
      externalCalls: [],
      events: [],
      notes: ["The entry comes from the ABI. No source body was matched."],
      hasSource: false,
      overloaded: false,
    });
  }

  const nameCount = new Map<string, number>();
  for (const fn of bySelector.values()) nameCount.set(fn.name, (nameCount.get(fn.name) ?? 0) + 1);
  /* One state variable can be reached through several internal paths. The
   * reader wants the variable once, on its shortest path. */
  const list = [...bySelector.values()].map((fn) => ({
    ...fn,
    overloaded: (nameCount.get(fn.name) ?? 0) > 1,
    reads: collapseAccesses(fn.reads),
    writes: collapseAccesses(fn.writes),
  }));

  list.sort((a, b) => {
    const aState = a.mutability === "view" || a.mutability === "pure" ? 1 : 0;
    const bState = b.mutability === "view" || b.mutability === "pure" ? 1 : 0;
    if (aState !== bState) return aState - bState;
    return a.name.localeCompare(b.name);
  });
  return list;
}

/** One entry per state variable, on the shortest internal path found. */
function collapseAccesses(accesses: StateAccess[]): StateAccess[] {
  const best = new Map<string, StateAccess>();
  for (const access of accesses) {
    const held = best.get(access.name);
    if (!held || access.via.length < held.via.length) best.set(access.name, access);
  }
  return [...best.values()];
}

/**
 * Builds an exposed function list for a contract with no ABI.
 *
 * Two independent facts feed it: the selectors the dispatcher serves in
 * bytecode, and the selectors that traces show arriving at the address. A
 * name appears only when a signature database answer re-hashes to the same
 * selector, so an unnamed entry keeps its raw four bytes.
 */
async function functionsFromSelectors(scanned: Selector[], observed: Selector[], registry: SignatureRegistry): Promise<FunctionAnalysis[]> {
  const all = [...new Set([...scanned, ...observed])];
  await registry.resolve(all);

  return all
    .map((selector) => {
      const found = registry.lookup(selector);
      const source = observed.includes(selector) ? "traces" : "the bytecode dispatcher";
      const provenance = scanned.includes(selector) && observed.includes(selector) ? "the bytecode dispatcher and traces" : source;
      return {
        name: found.name ?? selector,
        signature: found.signature ?? selector,
        selector,
        params: [],
        outputs: [],
        visibility: "external" as const,
        mutability: "unknown" as const,
        modifiers: [],
        access: { kind: "unknown" as const, detail: "No ABI and no source are available, so the caller restriction cannot be read.", gates: [] },
        role: found.signature ? "unknown / no source" : "unresolved selector",
        whatItDoes:
          `The selector comes from ${provenance}. ` +
          (found.signature
            ? `Its signature ${found.signature} comes from a signature database and re-hashes to this selector. Behaviour cannot be described without source or an ABI.`
            : "No verified signature database answer matches this selector, so its name stays unknown."),
        reads: [],
        writes: [],
        internalCalls: [],
        externalCalls: [],
        events: [],
        notes: [`The entry comes from ${provenance}. The contract is not verified, so reads, writes, and internal calls are unknown.`],
        hasSource: false,
        overloaded: false,
      };
    })
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

/**
 * States what a control-flow walk of the compiled function proved.
 *
 * A `false` field means the walk did not reach that opcode, so the sentence
 * names only what was seen, and it says when the walk stopped early.
 */
function describeFacts(facts: BytecodeFacts | undefined): string {
  if (!facts) return "";
  const seen: string[] = [];
  if (facts.writesStorage) seen.push("writes storage");
  else if (facts.readsStorage) seen.push("reads storage without writing it");
  if (facts.makesDelegatecall) seen.push("runs another contract's code with delegatecall");
  if (facts.makesCall) seen.push("calls another contract");
  else if (facts.makesStaticcall) seen.push("reads another contract with staticcall");
  if (facts.createsContract) seen.push("deploys a contract");
  if (facts.selfDestructs) seen.push("can self destruct");

  const body = seen.length > 0 ? `The compiled code ${listOf(seen)}.` : "The compiled code shows no storage write and no call out on the walked paths.";
  const limit = facts.truncated ? " The walk stopped early, so other behaviour may exist." : "";
  return `${body}${limit}`;
}


/**
 * Makes every counterparty label unique.
 *
 * Protocols deploy several contracts with one name, for example one adapter
 * per vault. Two rows that read `MorphoVaultV1Adapter` look like one
 * counterparty, so the short address is appended when a label repeats.
 */
function disambiguateLabels(runtime: RuntimeAnalysis): void {
  const addressesByLabel = new Map<string, Set<string>>();
  const note = (label: string, address: string): void => {
    const set = addressesByLabel.get(label) ?? new Set<string>();
    set.add(address);
    addressesByLabel.set(label, set);
  };

  for (const edge of [...runtime.outbound.edges, ...runtime.delegatecalls]) note(edge.destinationLabel, edge.destination);
  for (const edge of runtime.inbound.edges) note(edge.callerLabel, edge.caller);
  for (const contract of [...runtime.outbound.contracts, ...runtime.inbound.contracts]) note(contract.label, contract.address);

  const ambiguous = new Set([...addressesByLabel].filter(([, set]) => set.size > 1).map(([label]) => label));
  if (ambiguous.size === 0) return;

  const unique = (label: string, address: string): string => (ambiguous.has(label) ? `${label} ${shortAddress(address)}` : label);
  for (const edge of [...runtime.outbound.edges, ...runtime.delegatecalls]) edge.destinationLabel = unique(edge.destinationLabel, edge.destination);
  for (const edge of runtime.inbound.edges) edge.callerLabel = unique(edge.callerLabel, edge.caller);
  for (const contract of [...runtime.outbound.contracts, ...runtime.inbound.contracts]) contract.label = unique(contract.label, contract.address);
}

function mergeEvents(fromSource: EventAnalysis[], abi: AbiEntry[]): EventAnalysis[] {
  const out = new Map<string, EventAnalysis>();
  for (const event of fromSource) out.set(event.signature, event);
  for (const entry of abi) {
    if (entry.type !== "event" || !entry.name) continue;
    const signature = signatureOf(entry);
    if (!out.has(signature)) out.set(signature, { name: entry.name, signature, topic0: topic0Of(signature) as `0x${string}` });
  }
  return [...out.values()];
}

/* ------------------------------------------------- agent 2, execution maps */

function buildFunctionMap(fn: FunctionAnalysis, runtime: RuntimeAnalysis): FunctionMap {
  const observedEntry = runtime.targetFunctionCalls.find((c) => c.selector === fn.selector);
  const observedEdges = runtime.outbound.edges.filter((e) => e.targetSelector === fn.selector);
  const observedTxs = observedEdges.reduce((max, edge) => Math.max(max, edge.txs), 0);
  const inbound = runtime.inbound.edges.filter((e) => e.targetSelector === fn.selector);

  const externalCalls = mergeExternalCalls(fn, observedEdges);
  const tree = buildTree(fn, externalCalls, observedEntry?.calls ?? 0);
  const narrative = buildNarrative(fn, externalCalls, observedEntry?.calls ?? 0, inbound.length);

  return {
    signature: fn.signature,
    selector: fn.selector,
    name: fn.name,
    role: fn.role,
    whatItDoes: fn.whatItDoes,
    tree,
    narrative,
    externalCalls,
    observed: {
      txs: Math.max(observedTxs, inbound.reduce((sum, e) => sum + e.txs, 0)),
      calls: observedEntry?.calls ?? 0,
      /* Entries into this function come from the target function counts, and
       * from the inbound edges when no count carries a proof. */
      examples: pickProofs([...(observedEntry?.examples ?? []), ...inbound.flatMap((e) => e.examples)]),
    },
    inbound,
  };
}

/** `true` when an observed edge and a static call site name the same target. */
function sameDestination(edge: OutboundEdge, call: MergedExternalCall): boolean {
  if (call.destinationSelector && edge.destinationSelector) return call.destinationSelector === edge.destinationSelector;
  const edgeName = edge.destinationSignature?.split("(")[0];
  if (edgeName && call.functionLabel.startsWith(`${edgeName}(`)) return true;
  return !!call.destination && call.destination === edge.destination;
}

/**
 * Joins the call sites in code with the edges in traces.
 *
 * A call site with no matching edge stays as possible and not observed. An
 * edge with no matching call site is kept as well, marked as observed only,
 * because dynamic dispatch and assembly hide call sites from source.
 */
function mergeExternalCalls(fn: FunctionAnalysis, edges: OutboundEdge[]): MergedExternalCall[] {
  const used = new Set<OutboundEdge>();
  const merged: MergedExternalCall[] = [];

  for (const call of fn.externalCalls) {
    const matches = edges.filter((edge) => !used.has(edge) && matchesCallSite(call, edge));
    for (const match of matches) used.add(match);
    const calls = matches.reduce((sum, e) => sum + e.calls, 0);
    const txs = matches.reduce((max, e) => Math.max(max, e.txs), 0);
    const first = matches[0];
    merged.push({
      destination: first?.destination ?? call.destination.address,
      destinationLabel: first?.destinationLabel ?? staticDestinationLabel(call),
      destinationSelector: call.selector ?? first?.destinationSelector,
      destinationSignature: call.signature ?? first?.destinationSignature,
      functionLabel: call.signature ?? `${call.functionName}(${"?,".repeat(Math.max(0, call.argCount)).slice(0, -1)})`,
      callType: call.callType,
      reason: call.reason,
      possibleFromCode: true,
      observedOnchain: matches.length > 0,
      observedCalls: calls,
      observedTxs: txs,
      examples: pickProofs(matches.flatMap((edge) => edge.examples)),
      via: call.via,
    });
  }

  for (const edge of edges) {
    if (used.has(edge)) continue;
    merged.push({
      destination: edge.destination,
      destinationLabel: edge.destinationLabel,
      destinationSelector: edge.destinationSelector,
      destinationSignature: edge.destinationSignature,
      functionLabel: edge.destinationSignature ?? edge.destinationSelector ?? "unknown function",
      callType: edge.callType,
      reason: "The call appears in traces. No matching call site was found in source, so the destination or the selector is chosen at run time.",
      possibleFromCode: false,
      observedOnchain: true,
      observedCalls: edge.calls,
      observedTxs: edge.txs,
      examples: edge.examples,
      via: [],
    });
  }

  merged.sort((a, b) => b.observedCalls - a.observedCalls || a.functionLabel.localeCompare(b.functionLabel));
  return merged;
}

/**
 * Chooses the proofs a reader sees for one row.
 *
 * Rows can merge several edges, so proofs arrive duplicated and unsorted.
 * Keep the newest block first, one proof per transaction, and at most three,
 * because the row shows links and not a ledger. The cap never changes a
 * count.
 */
function pickProofs(refs: TxRef[]): TxRef[] {
  const byTx = new Map<string, TxRef>();
  for (const ref of refs) {
    const held = byTx.get(ref.hash);
    if (!held || ref.block > held.block) byTx.set(ref.hash, ref);
  }
  return [...byTx.values()].sort((a, b) => b.block - a.block || (a.path ?? "").localeCompare(b.path ?? "")).slice(0, 3);
}

function matchesCallSite(call: StaticExternalCall, edge: OutboundEdge): boolean {
  if (call.selector && edge.destinationSelector) {
    if (call.selector !== edge.destinationSelector) return false;
  } else {
    const edgeName = edge.destinationSignature?.split("(")[0];
    if (!edgeName || edgeName !== call.functionName) return false;
  }
  const literal = call.destination.address?.toLowerCase();
  if (literal && literal !== edge.destination) return false;
  return true;
}

/**
 * Names the destination of a call site that traces did not confirm.
 *
 * The interface type is the most useful name. A hard-coded address comes
 * next. When the code decides the address at run time, say so plainly rather
 * than print the expression that computed it.
 */
function staticDestinationLabel(call: StaticExternalCall): string {
  if (call.destination.contractType) return call.destination.contractType;
  if (call.destination.address) return shortAddress(call.destination.address);
  if (call.destination.kind === "unknown") return "unresolved destination";
  return call.destination.name ?? "unresolved destination";
}

/**
 * Builds the execution tree.
 *
 * Every internal and external finding carries the chain of internal functions
 * it was reached through (`via`), so the tree is that chain replayed as nodes.
 */
function buildTree(fn: FunctionAnalysis, externalCalls: MergedExternalCall[], observedCalls: number): ExecutionNode {
  const root: ExecutionNode = {
    kind: "entry",
    label: `${fn.name}(${fn.params.map((p) => p.type).join(",")})`,
    detail: fn.role,
    possibleFromCode: true,
    observedOnchain: observedCalls > 0,
    observedCalls,
    children: [],
  };

  /* One internal step can arrive twice, once as a bare name and once
   * qualified with its library, for example `safeTransferFrom` and
   * `SafeERC20.safeTransferFrom`. They are the same hop, so children are
   * keyed on the bare name and the qualified label wins. */
  const childrenByName = new Map<ExecutionNode, Map<string, ExecutionNode>>();
  const bareName = (name: string): string => name.split(".").pop() ?? name;

  const childFor = (parent: ExecutionNode, step: string): ExecutionNode => {
    const index = childrenByName.get(parent) ?? new Map<string, ExecutionNode>();
    childrenByName.set(parent, index);
    const key = bareName(step);
    const held = index.get(key);
    if (held) {
      if (step.includes(".") && !held.label.includes(".")) held.label = `${step}()`;
      return held;
    }
    const node: ExecutionNode = { kind: "internal", label: `${step}()`, possibleFromCode: true, observedOnchain: false, observedCalls: 0, children: [] };
    index.set(key, node);
    parent.children.push(node);
    return node;
  };

  const nodeFor = (via: string[]): ExecutionNode => {
    let node = root;
    for (const step of via) node = childFor(node, step);
    return node;
  };

  for (const call of fn.internalCalls) {
    const node = childFor(nodeFor(call.via), call.name);
    if (!node.detail) node.detail = call.purpose;
  }

  for (const call of externalCalls) {
    nodeFor(call.via).children.push({
      kind: call.callType === "dynamic" ? "dynamic" : "external",
      label: `${call.destinationLabel}.${call.functionLabel.split("(")[0]}()`,
      detail: call.reason,
      possibleFromCode: call.possibleFromCode,
      observedOnchain: call.observedOnchain,
      observedCalls: call.observedCalls,
      children: [],
    });
  }

  return root;
}

/** One execution told in order, from the evidence only. */
function buildNarrative(fn: FunctionAnalysis, externalCalls: MergedExternalCall[], observedCalls: number, inboundEdges: number): string[] {
  const lines: string[] = [];
  lines.push(fn.access.detail);

  const readNames = uniqueNames(fn.reads.map((r) => r.name));
  if (readNames.length > 0) lines.push(`The function reads ${listOf(readNames.slice(0, 6))} from storage.`);

  const direct = fn.internalCalls.filter((c) => c.depth === 1);
  if (direct.length > 0) {
    const names = uniqueNames(direct.map((c) => `${c.name}()`));
    lines.push(`It runs the internal ${names.length === 1 ? "function" : "functions"} ${listOf(names.slice(0, 6))}.`);
  }

  for (const call of externalCalls.slice(0, 6)) {
    const label = `${call.destinationLabel}.${call.functionLabel.split("(")[0]}()`;
    const state = call.observedOnchain
      ? `Traces show ${call.observedCalls} such calls.`
      : call.possibleFromCode
        ? "Traces in the window show no such call."
        : "";
    lines.push(`It can call ${label}. ${sentence(call.reason)} ${state}`.trim());
  }

  const writeNames = uniqueNames(fn.writes.map((w) => w.name));
  if (writeNames.length > 0) lines.push(`It writes ${listOf(writeNames.slice(0, 6))}.`);

  const eventNames = uniqueNames(fn.events.map((e) => e.split("(")[0] ?? e));
  if (eventNames.length > 0) lines.push(`It emits ${listOf(eventNames.slice(0, 4))}.`);

  lines.push(
    observedCalls > 0
      ? `The traced window holds ${observedCalls} calls of this function, from ${inboundEdges} distinct caller paths.`
      : "The traced window holds no call of this function.",
  );
  if (fn.notes.length > 0) lines.push(`Limits: ${fn.notes.slice(0, 3).map(sentence).join(" ")}`);
  return lines;
}

/** Keeps the first mention of each name, so one path is not counted twice. */
function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => name.length > 0))];
}

/** Makes a fragment from the analysers read as one sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const capital = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function listOf(items: string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* -------------------------------------------------- contract level wording */

/** A short type statement, built only from matched standards and evidence. */
function classify(statics: StaticAnalysis, maps: FunctionMap[], token?: TokenInfo): string {
  const has = (name: string): boolean => statics.interfaces.includes(name);
  const parts: string[] = [];

  if (has("ERC4626")) parts.push("ERC4626 tokenised vault");
  else if (has("ERC7540 async")) parts.push("asynchronous vault");
  else if (has("Uniswap V3 pool")) parts.push("Uniswap V3 pool");
  else if (has("Uniswap V2 pair")) parts.push("Uniswap V2 pair");
  else if (has("Aave V3 pool")) parts.push("Aave V3 style lending pool");
  else if (has("Morpho Blue")) parts.push("Morpho Blue market contract");
  else if (has("Gnosis Safe")) parts.push("Gnosis Safe multisig");
  else if (has("Timelock")) parts.push("timelock controller");
  else if (has("ERC721")) parts.push("ERC721 collection");
  else if (has("ERC1155")) parts.push("ERC1155 multi token");
  else if (has("ERC20")) parts.push("ERC20 token");
  else if (has("Chainlink aggregator")) parts.push("price feed");

  if (parts.length === 0) {
    const stateChanging = maps.filter((m) => !m.role.startsWith("view")).length;
    parts.push(stateChanging === 0 ? "read-only contract" : "contract with no matched standard");
  }
  if (token?.symbol && !parts[0]?.includes(token.symbol)) parts[0] = `${parts[0]} (${token.symbol})`;
  if (has("Ownable") || has("AccessControl")) parts.push("with an admin role");
  if (statics.proxy.isProxy) parts.push("behind a proxy");
  if (!statics.verified) parts.push("source not verified");
  return parts.join(", ");
}

/** A plain-English contract summary, assembled from counted facts. */
function summarise(statics: StaticAnalysis, runtime: RuntimeAnalysis, maps: FunctionMap[], token: TokenInfo | undefined, target: string): string {
  const sentences: string[] = [];
  const stateChanging = statics.functions.filter((f) => f.mutability === "nonpayable" || f.mutability === "payable");
  const unknownMutability = statics.functions.filter((f) => f.mutability === "unknown").length;
  const gated = stateChanging.filter((f) => f.access.kind !== "open" && f.access.kind !== "unknown");

  sentences.push(
    `${statics.contractName ?? shortAddress(target)} exposes ${statics.functions.length} functions. ` +
      `${stateChanging.length} of them change state and ${gated.length} of those are gated by an access check.`,
  );
  if (unknownMutability > 0) {
    sentences.push(`No ABI is available, so ${unknownMutability} of those functions come from the bytecode dispatcher and from traces, without a known mutability.`);
  }
  if (token?.name) sentences.push(`The contract is a token: ${token.name}${token.symbol ? ` (${token.symbol})` : ""}.`);
  if (statics.interfaces.length > 0) sentences.push(`Its selectors match ${listOf(statics.interfaces)}.`);

  const topOut = runtime.outbound.contracts.slice(0, 3);
  if (topOut.length > 0) {
    sentences.push(
      `In the traced window it calls ${listOf(topOut.map((c) => `${c.label} (${c.calls} calls)`))}. ` +
        `Those calls come from ${listOf([...new Set(topOut.flatMap((c) => c.targetFunctions.map((f) => f.signature ?? f.selector ?? "unattributed")))].slice(0, 4))}.`,
    );
  } else if (runtime.available) {
    sentences.push("The traced window shows no call out of this contract.");
  }

  const topIn = runtime.inbound.contracts.slice(0, 3);
  if (topIn.length > 0) {
    sentences.push(`It is called by ${listOf(topIn.map((c) => `${c.label} (${c.calls} calls)`))}.`);
  } else if (runtime.available) {
    sentences.push("The traced window shows no call into this contract from another contract.");
  }

  const busiest = [...maps].sort((a, b) => b.observed.calls - a.observed.calls)[0];
  if (busiest && busiest.observed.calls > 0) sentences.push(`The busiest exposed function is ${busiest.signature} with ${busiest.observed.calls} observed calls.`);

  return sentences.join(" ");
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function countResolved(runtime: RuntimeAnalysis, maps: FunctionMap[]): number {
  const named = new Set<string>();
  for (const edge of runtime.outbound.edges) if (edge.destinationSignature) named.add(edge.destinationSignature);
  for (const edge of runtime.inbound.edges) if (edge.callerSignature) named.add(edge.callerSignature);
  for (const map of maps) named.add(map.signature);
  return named.size;
}

function emptyRuntime(headBlock: number, warning: string): RuntimeAnalysis {
  return {
    available: false,
    window: {
      fromBlock: headBlock,
      toBlock: headBlock,
      blocks: 0,
      coveredBlocks: 0,
      slices: [],
      strategy: "contiguous",
      approxDays: 0,
      coveredDays: 0,
      candidateTxs: 0,
      sampledTxs: 0,
      sampled: false,
      method: "none",
      note: warning,
    },
    outbound: { edges: [], contracts: [], totalCalls: 0 },
    inbound: { edges: [], contracts: [], totalCalls: 0 },
    targetFunctionCalls: [],
    delegatecalls: [],
    unresolvedSelectors: [],
    warnings: [warning],
  };
}
