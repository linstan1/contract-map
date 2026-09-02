/**
 * Candidate transaction discovery for one target identity.
 *
 * Two paths exist because providers answer trace questions differently
 * per chain, per `src/config.ts`:
 *
 *   trace path      `chain.traceFilter === true`. Scan the requested span
 *                    with `trace_filter`, so every frame that touches the
 *                    target in the covered blocks is found.
 *   fallback path    `chain.traceFilter === false`. `trace_filter` is
 *                    rejected, so `fetchCandidateTxs` (Blockscout) supplies
 *                    transaction hashes with no calldata visibility.
 *
 * Both paths report the real block ranges scanned. A range that was not
 * scanned is never reported, so the UI window note stays honest.
 *
 * `DEPTH_BUDGETS[depth].spanDays` states the promise to the user in time,
 * not in blocks: "quick" means about one day of history on every chain,
 * whether that chain makes two second blocks or twelve second blocks. The
 * span is turned into a block count with `chain.blockTimeSec`. A dense,
 * fast-blocking chain like Base cannot read a whole day of blocks inside
 * the time budget, so the span is split into up to `maxSlices` slices
 * spread evenly across it, newest first, and each slice is read as far as
 * its own share of the frame cap and the time budget allow. The result is
 * an honest, spread sample of the whole span instead of a large, biased
 * sample of only the last few minutes.
 *
 * The trace path also carries a hard wall clock budget. A fast chain like
 * Ethereum answers `trace_filter` in under a second for a 2,000 block
 * slice; a fast-blocking, dense chain like Base can take many seconds for
 * a slice a tenth of that size, so the same block based budget that works
 * for Ethereum can run for minutes on Base and return nothing. The scan
 * therefore: starts each chain's slice size scaled by its block time,
 * shrinks or grows the slice from measured request latency, stops the
 * instant the wall clock budget is spent, and gives up on `trace_filter`
 * entirely in favour of the Blockscout path when the scan is clearly too
 * slow to finish inside its own time budget.
 */

import { DEPTH_BUDGETS } from "../config";
import type { ChainConfig, Depth } from "../types";
import { meansMethodUnsupported, selectorOfInput, type FlatTrace, type RpcClient } from "../rpc";
import { fetchCandidateTxs } from "../blockscout";

/** One transaction that may involve the target, with coverage hints for ranking. */
export interface CandidateTx {
  hash: string;
  blockNumber: number;
  timestamp?: number;
  /** Index, newest first, of the slice this candidate was found in. */
  sliceIndex: number;
  /** Selectors entered on the target, known only on the trace path. */
  targetSelectors: Set<string>;
  /** Counterparty addresses touched, known only on the trace path. */
  counterparties: Set<string>;
}

/** One block range that was really read, in the order it was scanned. */
export interface DiscoverySlice {
  fromBlock: number;
  toBlock: number;
}

export interface DiscoveryResult {
  txs: CandidateTx[];
  /** First block of the span the scan aimed at. */
  fromBlock: number;
  /** Last block of the span the scan aimed at, normally the head. */
  toBlock: number;
  /** The slices really read, in the order they were scanned (newest first). */
  slices: DiscoverySlice[];
  /** `contiguous` when the slices merge into one unbroken range; `stratified` when gaps remain between them. */
  strategy: "contiguous" | "stratified";
  method: string;
  note: string;
  warnings: string[];
}

/** Wall clock budget for the whole runtime stage (discovery plus tracing), by depth. */
export const TOTAL_BUDGET_MS: Record<Depth, number> = { quick: 45_000, standard: 90_000, deep: 180_000 };
/** Share of the total budget discovery is allowed to spend; the rest is for tracing. */
export const DISCOVERY_BUDGET_SHARE = 0.6;
/** Share of the discovery budget after which a slow `trace_filter` scan is abandoned. */
const ESCAPE_HATCH_SHARE = 1 / 3;

/** Smallest slice a failing or slow window is allowed to shrink to before the scan gives up on it. */
const MIN_SLICE_BLOCKS = 25;
/** Largest slice ever attempted, and the baseline slice size at `BASELINE_BLOCK_TIME_SEC`. */
const MAX_SLICE_BLOCKS = 2_000;
/** Block time the baseline slice size was tuned against, roughly Ethereum. */
const BASELINE_BLOCK_TIME_SEC = 12;
/** trace_filter page size per request. */
const PAGE_SIZE = 500;
/** A slice slower than this halves the next slice size. */
const SLOW_SLICE_MS = 8_000;
/** A slice faster than this, and not page-capped, doubles the next slice size. */
const FAST_SLICE_MS = 1_000;

function elapsedSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

/**
 * The endpoint will never answer `trace_filter`, whatever the block range.
 *
 * A provider without the `trace` namespace, or without an archive plan,
 * rejects every request the same way. Shrinking the slice cannot fix that, so
 * the scan stops and the Blockscout path takes over at once.
 */
class TraceFilterUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TraceFilterUnsupportedError";
  }
}

/** The first slice size for `chain`, scaled so a fast-blocking chain starts with proportionally fewer blocks. */
function initialSliceSize(chain: ChainConfig): number {
  const scaled = Math.round((MAX_SLICE_BLOCKS * chain.blockTimeSec) / BASELINE_BLOCK_TIME_SEC);
  return Math.min(MAX_SLICE_BLOCKS, Math.max(MIN_SLICE_BLOCKS, scaled));
}

/**
 * Highest time a single provider request is allowed before it is treated
 * as failed. `RpcClient` has its own internal retry logic can otherwise
 * block a single call for minutes with no way to cancel it; this caps that
 * risk while staying generous enough for a dense chain's genuinely slow,
 * but working, response, so a slow provider is not confused with a stuck
 * one.
 */
const MAX_REQUEST_MS = 20_000;

/**
 * Caps one provider call at `ms`. `RpcClient` has its own internal retry
 * and timeout logic with no external cancellation, so a single slow or
 * repeatedly erroring call could otherwise block the scan for minutes
 * regardless of how often the deadline is checked between calls. This
 * does not cancel the underlying request; it stops waiting on it and
 * lets the caller treat the wait as a failure, so the adaptive slice
 * shrinking and the wall clock deadline stay effective.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {}); // avoid an unhandled rejection if the timeout wins
  const { promise: timeout, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchDirection(
  rpc: RpcClient,
  identity: string[],
  direction: "from" | "to",
  fromBlock: number,
  toBlock: number,
  frameBudget: number,
  deadline: number,
): Promise<{ frames: FlatTrace[]; incomplete: boolean }> {
  const frames: FlatTrace[] = [];
  let after = 0;
  for (;;) {
    if (Date.now() >= deadline) return { frames, incomplete: true };
    const page = await withTimeout(
      rpc.traceFilter({
        fromBlock,
        toBlock,
        after,
        count: PAGE_SIZE,
        ...(direction === "from" ? { fromAddress: identity } : { toAddress: identity }),
      }),
      Math.min(MAX_REQUEST_MS, Math.max(1_000, deadline - Date.now())),
    );
    frames.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (frames.length >= frameBudget) break;
    after += PAGE_SIZE;
  }
  return { frames, incomplete: false };
}

/**
 * Fetches one block slice in both directions at once, shrinking on
 * failure. Each direction is capped at half the frame budget, so the two
 * together cannot exceed it; running them at once, instead of one after
 * another, matters on a chain where a single request already costs many
 * seconds, since serialising them would double the wall clock cost of
 * every slice for no benefit.
 */
async function fetchSlice(
  rpc: RpcClient,
  identity: string[],
  hi: number,
  lo: number,
  frameBudget: number,
  deadline: number,
  warnings: string[],
): Promise<{ frames: FlatTrace[]; scannedLo: number; gaveUp: boolean; durationMs: number; pageCapped: boolean }> {
  let sliceLo = lo;
  for (;;) {
    if (Date.now() >= deadline) return { frames: [], scannedLo: hi + 1, gaveUp: true, durationMs: 0, pageCapped: false };
    const started = Date.now();
    try {
      const half = Math.max(1, Math.ceil(frameBudget / 2));
      const [to, from] = await Promise.all([
        fetchDirection(rpc, identity, "to", sliceLo, hi, half, deadline),
        fetchDirection(rpc, identity, "from", sliceLo, hi, half, deadline),
      ]);
      const durationMs = Date.now() - started;
      const frames = [...to.frames, ...from.frames];
      if (to.incomplete || from.incomplete) {
        // The deadline landed mid page: keep whatever frames were already
        // fetched as a bonus for candidate discovery, but do not claim this
        // slice's block range was fully scanned.
        return { frames, scannedLo: hi + 1, gaveUp: true, durationMs, pageCapped: false };
      }
      const pageCapped = to.frames.length >= PAGE_SIZE || from.frames.length >= PAGE_SIZE;
      return { frames, scannedLo: sliceLo, gaveUp: false, durationMs, pageCapped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /* A refused method fails the same way at every slice size. Report it
       * once, and let the caller switch discovery paths. */
      if (meansMethodUnsupported(message)) throw new TraceFilterUnsupportedError(message);
      const span = hi - sliceLo + 1;
      if (span <= MIN_SLICE_BLOCKS) {
        warnings.push(`trace_filter failed on blocks ${sliceLo}-${hi}, even at the minimum slice size: ${message}`);
        return { frames: [], scannedLo: hi + 1, gaveUp: true, durationMs: Date.now() - started, pageCapped: false };
      }
      sliceLo = hi - Math.max(MIN_SLICE_BLOCKS, Math.floor(span / 2)) + 1;
    }
  }
}

function distinctTxCount(frames: FlatTrace[]): number {
  return new Set(frames.map((f) => f.transactionHash)).size;
}

interface ScanBudget {
  startedAt: number;
  /** Hard stop for this call; may be a share of the overall discovery deadline when scanning one of several slices. */
  deadline: number;
  /** When set, a struggling request is cut short at this time instead of waiting out the full deadline. */
  escapeAt?: number;
  maxTracedTxs?: number;
}

/** What one backward scan of a block window found. */
interface ScanResult {
  frames: FlatTrace[];
  /** Oldest block really read, or `toBlock + 1` when nothing was read. */
  scannedFrom: number;
  hitCap: boolean;
  timedOut: boolean;
}

/**
 * Scans backwards from `toBlock` down to `floorBlock`, stopping at the
 * frame cap, `budget.deadline`, or a scan failure. The slice size adapts
 * from measured request latency, not only from failures. `priorCandidates`
 * is the distinct transaction count already found in earlier slices of the
 * same scan, so the escape heuristic judges "short of candidates" against
 * the whole scan, not just this one slice.
 */
async function scanWindow(
  rpc: RpcClient,
  chain: ChainConfig,
  identity: string[],
  toBlock: number,
  floorBlock: number,
  frameCap: number,
  warnings: string[],
  budget: ScanBudget,
  priorCandidates: number,
  onProgress?: (stage: string, detail: string) => void,
): Promise<ScanResult> {
  const floor = Math.max(0, floorBlock);
  const frames: FlatTrace[] = [];
  let cur = toBlock;
  let scannedFrom = toBlock + 1;
  let sliceSize = initialSliceSize(chain);
  let hitCap = false;

  while (cur >= floor && frames.length < frameCap && Date.now() < budget.deadline) {
    const sliceLo = Math.max(floor, cur - sliceSize + 1);
    const budgetLeft = frameCap - frames.length;
    // A slice keeps its full retry budget until the scan is already past
    // the escape threshold with too few candidates overall: the first
    // attempt always gets the full deadline, since a dense chain's first
    // real request can legitimately take ten seconds or more and must not
    // be starved before it has a chance to succeed. Only once the scan has
    // already burned past that threshold with nothing to show does a
    // struggling slice get cut short.
    const shortOfCandidates = budget.maxTracedTxs !== undefined && priorCandidates + distinctTxCount(frames) < budget.maxTracedTxs;
    const pastEscapeThreshold = budget.escapeAt !== undefined && Date.now() >= budget.escapeAt;
    const sliceCutoff = pastEscapeThreshold && shortOfCandidates ? Math.min(budget.deadline, budget.escapeAt as number) : budget.deadline;
    const slice = await fetchSlice(rpc, identity, cur, sliceLo, budgetLeft, sliceCutoff, warnings);
    frames.push(...slice.frames);
    if (!slice.gaveUp) scannedFrom = slice.scannedLo;
    onProgress?.("runtime-discover", `[${elapsedSeconds(budget.startedAt)}s] scanned blocks ${slice.scannedLo}-${cur}, ${frames.length} frames so far`);

    if (slice.durationMs > SLOW_SLICE_MS) sliceSize = Math.max(MIN_SLICE_BLOCKS, Math.floor(sliceSize / 2));
    else if (slice.durationMs < FAST_SLICE_MS && !slice.pageCapped) sliceSize = Math.min(MAX_SLICE_BLOCKS, sliceSize * 2);

    if (slice.gaveUp) break;
    if (frames.length >= frameCap) {
      hitCap = true;
      break;
    }
    cur = slice.scannedLo - 1;
  }
  return { frames, scannedFrom, hitCap, timedOut: Date.now() >= budget.deadline };
}

function toCandidates(frames: FlatTrace[], identity: Set<string>, sliceIndex: number): Map<string, CandidateTx> {
  const byHash = new Map<string, CandidateTx>();
  for (const frame of frames) {
    const existing = byHash.get(frame.transactionHash);
    const candidate = existing ?? {
      hash: frame.transactionHash,
      blockNumber: frame.blockNumber,
      sliceIndex,
      targetSelectors: new Set<string>(),
      counterparties: new Set<string>(),
    };
    if (!existing) byHash.set(frame.transactionHash, candidate);
    candidate.blockNumber = Math.min(candidate.blockNumber, frame.blockNumber);
    const from = (frame.action.from ?? "").toLowerCase();
    const to = (frame.action.to ?? frame.result?.address ?? "").toLowerCase();
    if (to && identity.has(to)) {
      const selector = selectorOfInput(frame.action.input);
      if (selector) candidate.targetSelectors.add(selector);
    }
    if (from && !identity.has(from)) candidate.counterparties.add(from);
    if (to && !identity.has(to)) candidate.counterparties.add(to);
  }
  return byHash;
}

/** Splits `[spanFrom, headBlock]` into up to `maxSlices` touching segments, newest first. */
function planSegments(spanFrom: number, headBlock: number, maxSlices: number): DiscoverySlice[] {
  const totalBlocks = headBlock - spanFrom + 1;
  const sliceCount = Math.max(1, Math.min(maxSlices, totalBlocks));
  const segWidth = Math.ceil(totalBlocks / sliceCount);
  const segments: DiscoverySlice[] = [];
  let to = headBlock;
  while (to >= spanFrom) {
    const from = Math.max(spanFrom, to - segWidth + 1);
    segments.push({ fromBlock: from, toBlock: to });
    to = from - 1;
  }
  return segments;
}

/** Merges touching or overlapping slices, sorted newest first, into unbroken ranges. */
function mergeSlices(slices: DiscoverySlice[]): DiscoverySlice[] {
  if (slices.length === 0) return [];
  const sorted = [...slices].sort((a, b) => b.toBlock - a.toBlock);
  const merged: DiscoverySlice[] = [{ ...(sorted[0] as DiscoverySlice) }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as DiscoverySlice;
    const last = merged[merged.length - 1] as DiscoverySlice;
    if (cur.toBlock + 1 >= last.fromBlock) {
      last.fromBlock = Math.min(last.fromBlock, cur.fromBlock);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Formats a duration in days as days, hours, or minutes, whichever reads as a real number instead of "0.0 days". */
function formatDuration(days: number): string {
  if (days >= 1) return `${days.toFixed(1)} days`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  return `${Math.round(hours * 60)} minutes`;
}

function buildNote(
  depth: Depth,
  slices: DiscoverySlice[],
  coveredBlocks: number,
  spanBlocks: number,
  spanDays: number,
  coveredDays: number,
  hitCap: boolean,
  timedOut: boolean,
  discoveryBudgetMs: number,
): string {
  const avgSize = slices.length > 0 ? Math.round(coveredBlocks / slices.length) : 0;
  const plural = slices.length === 1 ? "slice" : "slices";
  const stop = hitCap
    ? `The frame cap for depth "${depth}" stopped the scan.`
    : timedOut
      ? `The ${(discoveryBudgetMs / 1000).toFixed(0)}s discovery time budget stopped the scan.`
      : "The scan covered the full requested span.";
  return `Read ${slices.length} ${plural} of about ${avgSize} blocks spread over the last ${formatDuration(spanDays)}. The slices cover ${coveredBlocks} of ${spanBlocks} blocks, about ${formatDuration(coveredDays)}. ${stop} Counts describe this sample, not lifetime totals.`;
}

async function discoverViaBlockscout(chain: ChainConfig, identity: string[], headBlock: number, depth: Depth): Promise<DiscoveryResult> {
  const budget = DEPTH_BUDGETS[depth];
  const warnings: string[] = [];
  const byHash = new Map<string, CandidateTx>();
  let blockFloor = headBlock;
  let blockCeil = 0;

  // One address at a time would sum each address's own timeout; the
  // identity list is small (a proxy plus its implementation), so this
  // runs every address at once instead.
  const perAddress = await Promise.all(
    identity.map(async (address) => {
      try {
        return await withTimeout(fetchCandidateTxs(chain, address, budget.maxTracedTxs * 3), MAX_REQUEST_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Blockscout candidate lookup failed for ${address}: ${message}`);
        return [];
      }
    }),
  );

  for (const found of perAddress) {
    for (const tx of found) {
      if (!byHash.has(tx.hash)) {
        byHash.set(tx.hash, {
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          timestamp: tx.timestamp,
          sliceIndex: 0,
          targetSelectors: new Set(),
          counterparties: new Set(),
        });
      }
      blockFloor = Math.min(blockFloor, tx.blockNumber);
      blockCeil = Math.max(blockCeil, tx.blockNumber);
    }
  }

  const txs = [...byHash.values()];
  const fromBlock = txs.length > 0 ? blockFloor : headBlock;
  const toBlock = txs.length > 0 ? blockCeil : headBlock;

  return {
    txs,
    fromBlock,
    toBlock,
    slices: txs.length > 0 ? [{ fromBlock, toBlock }] : [],
    strategy: "contiguous",
    method: "Blockscout internal-transactions",
    note:
      txs.length > 0
        ? `Candidates from Blockscout, blocks ${fromBlock}-${toBlock}. No calldata is available from this source, so ranking and unattributed edges rely on the traced sample only.`
        : "Blockscout returned no candidate transactions in range.",
    warnings,
  };
}

async function discoverViaTraceFilter(
  chain: ChainConfig,
  rpc: RpcClient,
  identity: string[],
  headBlock: number,
  depth: Depth,
  startedAt: number,
  totalBudgetMs: number,
  onProgress?: (stage: string, detail: string) => void,
): Promise<DiscoveryResult> {
  const depthBudget = DEPTH_BUDGETS[depth];
  const identitySet = new Set(identity.map((a) => a.toLowerCase()));
  const warnings: string[] = [];

  const discoveryBudgetMs = totalBudgetMs * DISCOVERY_BUDGET_SHARE;
  const budget: ScanBudget = {
    startedAt,
    deadline: startedAt + discoveryBudgetMs,
    escapeAt: startedAt + discoveryBudgetMs * ESCAPE_HATCH_SHARE,
    maxTracedTxs: depthBudget.maxTracedTxs,
  };

  const spanBlocks = Math.max(1, Math.round((depthBudget.spanDays * 86_400) / chain.blockTimeSec));
  const spanFrom = Math.max(0, headBlock - spanBlocks + 1);
  const segments = planSegments(spanFrom, headBlock, depthBudget.maxSlices);
  // Each segment gets a fair share of the frame cap and of the discovery
  // time, so a busy newest segment cannot alone consume the whole budget
  // and leave every older segment unread: that would silently reproduce
  // the old recent-minutes bias the span budget exists to fix.
  const perSegmentFrameCap = Math.max(1, Math.ceil(depthBudget.maxFrames / segments.length));
  const perSegmentBudgetMs = discoveryBudgetMs / segments.length;

  const readSlices: DiscoverySlice[] = [];
  const perSegmentCandidates: Map<string, CandidateTx>[] = [];
  let allFrames: FlatTrace[] = [];
  let escaped = false;
  /* Set when the endpoint refuses `trace_filter` itself. The registry flag
   * describes one provider, and a user may configure another one, so the
   * refusal is discovered here and answered with the Blockscout path. */
  let unsupported: string | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as DiscoverySlice;
    if (allFrames.length >= depthBudget.maxFrames) break;
    if (Date.now() >= budget.deadline) break;

    onProgress?.("runtime-discover", `[${elapsedSeconds(startedAt)}s] scanning slice ${i + 1}/${segments.length}: blocks ${segment.fromBlock}-${segment.toBlock}`);
    const segmentBudget: ScanBudget = { ...budget, deadline: Math.min(budget.deadline, Date.now() + perSegmentBudgetMs) };
    const segmentFrameCap = Math.min(perSegmentFrameCap, depthBudget.maxFrames - allFrames.length);
    const priorCandidates = distinctTxCount(allFrames);
    let scan: ScanResult;
    try {
      scan = await scanWindow(rpc, chain, identity, segment.toBlock, segment.fromBlock, segmentFrameCap, warnings, segmentBudget, priorCandidates, onProgress);
    } catch (error) {
      if (!(error instanceof TraceFilterUnsupportedError)) throw error;
      unsupported = error.reason;
      break;
    }

    if (scan.scannedFrom <= segment.toBlock) {
      readSlices.push({ fromBlock: scan.scannedFrom, toBlock: segment.toBlock });
      allFrames = [...allFrames, ...scan.frames];
      perSegmentCandidates.push(toCandidates(scan.frames, identitySet, i));
    }

    const shouldEscape = Date.now() >= budget.escapeAt! && distinctTxCount(allFrames) < depthBudget.maxTracedTxs;
    if (shouldEscape) {
      escaped = true;
      break;
    }
  }

  if (escaped) {
    const found = distinctTxCount(allFrames);
    onProgress?.("runtime-discover", `[${elapsedSeconds(startedAt)}s] trace_filter too slow (${found}/${depthBudget.maxTracedTxs} candidates); switching to Blockscout`);
    const fallback = await discoverViaBlockscout(chain, identity, headBlock, depth);
    return {
      ...fallback,
      method: `trace_filter abandoned after ${elapsedSeconds(startedAt)}s (found ${found}/${depthBudget.maxTracedTxs} candidates); switched to ${fallback.method}`,
      note: `The trace_filter scan was too slow on ${chain.label} and was abandoned after ${elapsedSeconds(startedAt)}s. ${fallback.note}`,
      warnings: [...warnings, ...fallback.warnings],
    };
  }

  if (unsupported) {
    onProgress?.("runtime-discover", `[${elapsedSeconds(startedAt)}s] this endpoint refuses trace_filter; switching to Blockscout`);
    const fallback = await discoverViaBlockscout(chain, identity, headBlock, depth);
    return {
      ...fallback,
      method: `trace_filter refused by the endpoint; switched to ${fallback.method}`,
      note: `This endpoint does not answer trace_filter on ${chain.label}: ${unsupported} ${fallback.note}`,
      warnings: [...warnings, `trace_filter is not available on the configured endpoint: ${unsupported}`, ...fallback.warnings],
    };
  }

  const merged = mergeSlices(readSlices);
  const strategy: "contiguous" | "stratified" = merged.length <= 1 ? "contiguous" : "stratified";
  const coveredBlocks = readSlices.reduce((sum, s) => sum + (s.toBlock - s.fromBlock + 1), 0);
  const actualSpanBlocks = headBlock - spanFrom + 1;
  const spanDays = (actualSpanBlocks * chain.blockTimeSec) / 86_400;
  const coveredDays = (coveredBlocks * chain.blockTimeSec) / 86_400;
  const hitCap = allFrames.length >= depthBudget.maxFrames;
  const timedOut = Date.now() >= budget.deadline;

  // Flatten every segment's candidates, preserving segment order, so the
  // tracing stage's ranking step can draw from every slice instead of
  // only the newest one.
  const txs = perSegmentCandidates.flatMap((m) => [...m.values()]);

  return {
    txs,
    fromBlock: spanFrom,
    toBlock: headBlock,
    slices: readSlices,
    strategy,
    method: `trace_filter (${strategy === "contiguous" ? "backward-scanning window" : "stratified slices"}, adaptive slice size)`,
    note: buildNote(depth, readSlices, coveredBlocks, actualSpanBlocks, spanDays, coveredDays, hitCap, timedOut, discoveryBudgetMs),
    warnings,
  };
}

/** Picks the discovery path for `chain` and returns the candidates found. */
export async function discoverCandidates(
  chain: ChainConfig,
  rpc: RpcClient,
  identity: string[],
  headBlock: number,
  depth: Depth,
  onProgress?: (stage: string, detail: string) => void,
  startedAt: number = Date.now(),
  /** Overrides `TOTAL_BUDGET_MS[depth]`; a test seam, production always uses the default. */
  totalBudgetMs: number = TOTAL_BUDGET_MS[depth],
): Promise<DiscoveryResult> {
  onProgress?.("runtime-discover", `discovering candidate transactions on ${chain.label}`);
  if (chain.traceFilter) {
    return discoverViaTraceFilter(chain, rpc, identity, headBlock, depth, startedAt, totalBudgetMs, onProgress);
  }
  return discoverViaBlockscout(chain, identity, headBlock, depth);
}
