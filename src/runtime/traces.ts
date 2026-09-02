/**
 * Entry point for runtime analysis, agents 3 and 4 of the product brief.
 *
 * `analyzeRuntime` discovers candidate transactions, traces a bounded and
 * honest sample of them into call trees, then hands the trees to
 * `aggregate.ts` for the outbound/inbound edge walk.
 */

import { DEPTH_BUDGETS } from "../config";
import { callTracerToTree, flatTracesToTree, meansMethodUnsupported, type RpcClient } from "../rpc";
import type { ChainConfig, Depth, RuntimeAnalysis, TraceTx, TraceWindow } from "../types";
import { aggregateTraces, type LabelSource, type SelectorResolver } from "./aggregate";
import { discoverCandidates, TOTAL_BUDGET_MS, type CandidateTx } from "./discover";

export interface RuntimeInput {
  chain: ChainConfig;
  rpc: RpcClient;
  target: string;
  /** Proxy plus implementation addresses. All count as the target identity. */
  identity: string[];
  headBlock: number;
  depth: Depth;
  registry: SelectorResolver;
  labels: LabelSource;
  targetSelectors: Set<string>;
  onProgress?: (stage: string, detail: string) => void;
}

/**
 * Ranks candidates for coverage first, recency second: each pick is the
 * transaction that adds the most previously unseen target selectors and
 * counterparties, ties broken by the newest block. The candidate pool is
 * capped before ranking so this stays fast even at the "deep" budget.
 */
function rankWithinSlice(candidates: CandidateTx[], cap: number): CandidateTx[] {
  const pool = [...candidates].sort((a, b) => b.blockNumber - a.blockNumber).slice(0, Math.max(cap * 10, 500));
  const seen = new Set<string>();
  const selected: CandidateTx[] = [];
  const remaining = [...pool];
  while (selected.length < cap && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    let bestBlock = -1;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i] as CandidateTx;
      let score = 0;
      for (const s of candidate.targetSelectors) if (!seen.has(`s:${s}`)) score++;
      for (const a of candidate.counterparties) if (!seen.has(`a:${a}`)) score++;
      if (score > bestScore || (score === bestScore && candidate.blockNumber > bestBlock)) {
        bestScore = score;
        bestIndex = i;
        bestBlock = candidate.blockNumber;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0] as CandidateTx;
    for (const s of chosen.targetSelectors) seen.add(`s:${s}`);
    for (const a of chosen.counterparties) seen.add(`a:${a}`);
    selected.push(chosen);
  }
  return selected;
}

/**
 * A "contiguous" window is one unbroken read: its slices are just the
 * internal chunks of a single scan, not separate time samples, so the
 * whole candidate pool is ranked together, exactly as before slices
 * existed. A "stratified" window has real gaps between slices, each one a
 * genuine sample of a different part of the span: those slices are ranked
 * on their own coverage first, then interleaved round robin, newest
 * slice first, so the traced sample is drawn from every slice instead of
 * only the newest one.
 */
function rankCandidates(candidates: CandidateTx[], cap: number, stratified: boolean): CandidateTx[] {
  if (!stratified) return rankWithinSlice(candidates, cap);

  const bySlice = new Map<number, CandidateTx[]>();
  for (const candidate of candidates) {
    const list = bySlice.get(candidate.sliceIndex) ?? [];
    list.push(candidate);
    bySlice.set(candidate.sliceIndex, list);
  }
  const sliceOrder = [...bySlice.keys()].sort((a, b) => a - b);
  const rankedPerSlice = sliceOrder.map((index) => rankWithinSlice(bySlice.get(index) as CandidateTx[], Math.max(cap, 50)));

  const selected: CandidateTx[] = [];
  let round = 0;
  let addedThisRound = true;
  while (selected.length < cap && addedThisRound) {
    addedThisRound = false;
    for (const list of rankedPerSlice) {
      if (selected.length >= cap) break;
      const candidate = list[round];
      if (!candidate) continue;
      selected.push(candidate);
      addedThisRound = true;
    }
    round++;
  }
  return selected;
}

/** The two ways one transaction is expanded into a call tree. */
type TraceMethod = "trace_transaction" | "debug_traceTransaction";

/** Which method this endpoint answers, learned during the run. */
interface TraceMethodState {
  /** The method used for the next transaction. */
  current: TraceMethod;
  /** Every method this endpoint has already refused. */
  refused: Set<TraceMethod>;
}

const OTHER_METHOD: Record<TraceMethod, TraceMethod> = {
  trace_transaction: "debug_traceTransaction",
  debug_traceTransaction: "trace_transaction",
};

/** One expansion attempt with one named method. */
async function traceWith(method: TraceMethod, rpc: RpcClient, candidate: CandidateTx): Promise<TraceTx | undefined> {
  if (method === "trace_transaction") {
    const flat = await rpc.traceTransaction(candidate.hash);
    const root = flatTracesToTree(flat);
    if (!root) return undefined;
    return { hash: candidate.hash, blockNumber: candidate.blockNumber, timestamp: candidate.timestamp, root };
  }
  const callTracer = await rpc.debugTraceTransaction(candidate.hash);
  if (!callTracer) return undefined;
  return { hash: candidate.hash, blockNumber: candidate.blockNumber, timestamp: candidate.timestamp, root: callTracerToTree(callTracer) };
}

/**
 * Fetches and normalises one transaction's call tree, with the method the
 * endpoint really answers.
 *
 * The chain registry states which method the reference provider answers, and
 * that is the first choice. A user may configure any provider, so a refusal
 * is not fatal: the other method runs at once, and the working method is
 * remembered for every later transaction of the same run.
 */
async function traceOne(rpc: RpcClient, candidate: CandidateTx, state: TraceMethodState, warnings: string[]): Promise<TraceTx | undefined> {
  const order: TraceMethod[] = [state.current, OTHER_METHOD[state.current]].filter((m) => !state.refused.has(m));
  for (const method of order) {
    try {
      const traced = await traceWith(method, rpc, candidate);
      if (method !== state.current) {
        warnings.push(`The endpoint refuses ${state.current}, so ${method} expanded the traces instead.`);
        state.current = method;
      }
      return traced;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (meansMethodUnsupported(message)) {
        state.refused.add(method);
        continue;
      }
      warnings.push(`Failed to trace ${candidate.hash}: ${message}`);
      return undefined;
    }
  }
  warnings.push(`Failed to trace ${candidate.hash}: this endpoint answers neither trace_transaction nor debug_traceTransaction.`);
  return undefined;
}

/**
 * Traces `candidates` with bounded concurrency, like `mapLimit`, but a
 * worker checks the deadline before starting the next transaction instead
 * of after the whole batch. A slow chain then returns whatever was traced
 * inside the budget instead of blocking until every candidate finishes.
 */
async function traceWithDeadline(
  rpc: RpcClient,
  candidates: CandidateTx[],
  deadline: number,
  startedAt: number,
  state: TraceMethodState,
  warnings: string[],
  onProgress?: (stage: string, detail: string) => void,
): Promise<{ txs: TraceTx[]; stoppedForDeadline: boolean }> {
  const results: (TraceTx | undefined)[] = new Array(candidates.length);
  let cursor = 0;
  let traced = 0;
  let stoppedForDeadline = false;
  const runners = Array.from({ length: Math.min(4, candidates.length) }, async () => {
    for (;;) {
      if (Date.now() >= deadline) {
        stoppedForDeadline = true;
        return;
      }
      const index = cursor++;
      if (index >= candidates.length) return;
      const candidate = candidates[index] as CandidateTx;
      results[index] = await traceOne(rpc, candidate, state, warnings);
      traced++;
      onProgress?.("runtime", `[${((Date.now() - startedAt) / 1000).toFixed(1)}s] traced ${traced}/${candidates.length} transactions`);
    }
  });
  await Promise.all(runners);
  return { txs: results.filter((t): t is TraceTx => t !== undefined), stoppedForDeadline };
}

function emptyWindow(headBlock: number, method: string, note: string): TraceWindow {
  return {
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
    method,
    note,
  };
}

function unavailable(headBlock: number, method: string, note: string, warnings: string[]): RuntimeAnalysis {
  return {
    available: false,
    window: emptyWindow(headBlock, method, note),
    outbound: { edges: [], contracts: [], totalCalls: 0 },
    inbound: { edges: [], contracts: [], totalCalls: 0 },
    targetFunctionCalls: [],
    delegatecalls: [],
    unresolvedSelectors: [],
    warnings,
  };
}

export async function analyzeRuntime(input: RuntimeInput): Promise<RuntimeAnalysis> {
  const { chain, rpc, identity, headBlock, depth, registry, labels, onProgress } = input;
  const budget = DEPTH_BUDGETS[depth];
  const warnings: string[] = [];
  const startedAt = Date.now();
  const tracingDeadline = startedAt + TOTAL_BUDGET_MS[depth];
  /* The registry names the method the reference provider answers. It is only
   * the first choice: `traceOne` switches when the configured endpoint
   * refuses it. */
  const traceMethod: TraceMethodState = {
    current: chain.traceFilter ? "trace_transaction" : "debug_traceTransaction",
    refused: new Set(),
  };

  onProgress?.("runtime", "discovering candidate transactions");
  const discovery = await discoverCandidates(chain, rpc, identity, headBlock, depth, onProgress, startedAt);
  warnings.push(...discovery.warnings);

  if (discovery.txs.length === 0) {
    return unavailable(headBlock, discovery.method, discovery.note, [...warnings, "No candidate transactions were found in the sampled window."]);
  }

  const ranked = rankCandidates(discovery.txs, budget.maxTracedTxs, discovery.strategy === "stratified");
  onProgress?.("runtime", `[${((Date.now() - startedAt) / 1000).toFixed(1)}s] tracing ${ranked.length} of ${discovery.txs.length} candidate transactions`);
  const { txs, stoppedForDeadline } = await traceWithDeadline(rpc, ranked, tracingDeadline, startedAt, traceMethod, warnings, onProgress);
  if (stoppedForDeadline) {
    warnings.push(`Stopped tracing after the ${(TOTAL_BUDGET_MS[depth] / 1000).toFixed(0)}s runtime time budget; traced ${txs.length} of ${ranked.length} selected transactions.`);
  }

  if (txs.length === 0) {
    return unavailable(headBlock, discovery.method, discovery.note, [...warnings, "Every candidate transaction failed to trace."]);
  }

  onProgress?.("runtime", `aggregating ${txs.length} traced transactions`);
  const aggregate = await aggregateTraces(txs, identity, registry, labels, tracingDeadline);

  const blocks = discovery.toBlock - discovery.fromBlock + 1;
  const coveredBlocks = discovery.slices.reduce((sum, s) => sum + (s.toBlock - s.fromBlock + 1), 0);
  const window: TraceWindow = {
    fromBlock: discovery.fromBlock,
    toBlock: discovery.toBlock,
    blocks,
    coveredBlocks,
    slices: discovery.slices,
    strategy: discovery.strategy,
    approxDays: (blocks * chain.blockTimeSec) / 86_400,
    coveredDays: (coveredBlocks * chain.blockTimeSec) / 86_400,
    candidateTxs: discovery.txs.length,
    sampledTxs: txs.length,
    sampled: txs.length < discovery.txs.length,
    method: `${discovery.method}; expanded with ${traceMethod.current === "trace_transaction" ? "trace_transaction" : "debug_traceTransaction (callTracer)"}`,
    note: stoppedForDeadline ? `${discovery.note} Tracing itself was also cut short by the time budget.` : discovery.note,
  };

  return {
    available: true,
    window,
    outbound: aggregate.outbound,
    inbound: aggregate.inbound,
    targetFunctionCalls: aggregate.targetFunctionCalls,
    delegatecalls: aggregate.delegatecalls,
    unresolvedSelectors: aggregate.unresolvedSelectors,
    warnings,
  };
}
