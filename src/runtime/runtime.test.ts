import { expect, test } from "bun:test";
import { DEPTH_BUDGETS } from "../config";
import { RpcClient, type FlatTrace, type TraceFilterParams } from "../rpc";
import type { CallFrame, ChainConfig, TraceTx } from "../types";
import { aggregateTraces, type LabelSource, type SelectorResolver } from "./aggregate";
import { discoverCandidates, TOTAL_BUDGET_MS } from "./discover";

const PROXY = "0xproxy00000000000000000000000000000001";
const IMPL = "0ximpl000000000000000000000000000000002";
const IDENTITY = [PROXY, IMPL];

const SIG = {
  deposit: "0xaaaaaaaa",
  withdraw: "0xbbbbbbbb",
  extTransfer: "0xcccccccc",
  extApprove: "0xdddddddd",
  callerRun: "0xeeeeeeee",
  libCall: "0xffffff01",
};

const SIGNATURES: Record<string, string> = {
  [SIG.deposit]: "deposit(uint256)",
  [SIG.withdraw]: "withdraw(uint256)",
  [SIG.extTransfer]: "transfer(address,uint256)",
  [SIG.extApprove]: "approve(address,uint256)",
  [SIG.callerRun]: "run()",
};

function frame(from: string, to: string | undefined, input: string, callType: CallFrame["callType"], children: CallFrame[] = []): CallFrame {
  return { from, to, input, callType, value: "0x0", children };
}

function fakeRegistry(): SelectorResolver {
  return {
    lookup: (selector) => ({ selector, signature: selector ? SIGNATURES[selector] : undefined, source: "abi" }),
    resolve: async () => {},
  };
}

function fakeLabels(contracts: Set<string>): LabelSource {
  return {
    load: async () => {},
    label: (address) => address,
    info: (address) => ({ isContract: contracts.has(address.toLowerCase()), verified: true }),
  };
}

const EOA1 = "0xeoa10000000000000000000000000000000001";
const EOA2 = "0xeoa20000000000000000000000000000000002";
const EXT1 = "0xext10000000000000000000000000000000001";
const EXT2 = "0xext20000000000000000000000000000000002";
const LIB1 = "0xlib10000000000000000000000000000000001";
const CALLER_A = "0xcallera000000000000000000000000000001";

const CONTRACTS = new Set([PROXY, IMPL, EXT1, EXT2, LIB1, CALLER_A]);

function buildTx1(): TraceTx {
  // Root: EOA calls proxy.deposit(). Covers EOA-direct inbound (req 4).
  const delegateToImpl = frame(
    PROXY,
    IMPL,
    // Delegatecall carries a different raw input on purpose: context must stay
    // "deposit", proving the enclosing target function is preserved (req 1),
    // not reset from this frame's own input.
    SIG.withdraw,
    "delegatecall",
    [
      // Nested two levels deep, inside the delegatecall: still attributed to
      // "deposit" (req 2, nested attribution through delegatecall passthrough).
      frame(PROXY, EXT1, SIG.extTransfer, "call", [
        // ext1 calls ext2: neither endpoint touches identity, so this must
        // create no edge at all, proving co-occurrence is not an edge (req 5).
        frame(EXT1, EXT2, SIG.extApprove, "call"),
      ]),
      // A second call to ext1 with the same shape, in the SAME tx: must bump
      // `calls` to 2 while `txs` stays 1 for this edge (req 7, part one).
      frame(PROXY, EXT1, SIG.extTransfer, "call"),
    ],
  );
  const directToExt2 = frame(PROXY, EXT2, SIG.extApprove, "call");
  const delegateToLib = frame(PROXY, LIB1, SIG.libCall, "delegatecall");
  const root = frame(EOA1, PROXY, SIG.deposit, "call", [delegateToImpl, directToExt2, delegateToLib]);
  return { hash: "0xtx1", blockNumber: 100, root };
}

function buildTx2(): TraceTx {
  // Root: EOA calls callerA.run(). callerA then calls proxy.deposit(): an
  // inbound call from a contract whose parent frame has a resolvable
  // selector (req 3). Also repeats the proxy->ext1 outbound call to prove
  // `txs` climbs to 2 across transactions (req 7, part two).
  const intoProxy = frame(CALLER_A, PROXY, SIG.deposit, "call", [frame(PROXY, EXT1, SIG.extTransfer, "call")]);
  const root = frame(EOA2, CALLER_A, SIG.callerRun, "call", [intoProxy]);
  return { hash: "0xtx2", blockNumber: 101, root };
}

test("proxy delegatecall preserves the enclosing target function", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1);
  expect(toExt1?.targetSelector).toBe(SIG.deposit);
  expect(toExt1?.targetSignature).toBe("deposit(uint256)");
  // The proxy->impl delegatecall itself is internal to the identity: no edge.
  expect(result.outbound.edges.some((e) => e.destination === IMPL)).toBe(false);
  expect(result.inbound.edges.some((e) => e.caller === IMPL)).toBe(false);
});

test("nested frames inside a delegatecall still attribute to the right target function", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1);
  expect(toExt1).toBeDefined();
  expect(toExt1?.targetSelector).toBe(SIG.deposit);
  const toExt2 = result.outbound.edges.find((e) => e.destination === EXT2);
  expect(toExt2?.targetSelector).toBe(SIG.deposit);
});

test("a same-transaction pair with no parent/child relation creates no edge", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  // ext1 calls ext2 inside the tree, but ext1 is never the target and ext2
  // is never the target, so that call must not surface as any edge. The
  // only edge touching ext2 is the direct proxy->ext2 call, counted once.
  const toExt2Edges = result.outbound.edges.filter((e) => e.destination === EXT2);
  expect(toExt2Edges).toHaveLength(1);
  expect(toExt2Edges[0]?.calls).toBe(1);
  expect(result.inbound.edges.some((e) => e.caller === EXT1)).toBe(false);
});

test("delegatecall out of the target is kept apart from ordinary outbound edges", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  expect(result.outbound.edges.some((e) => e.destination === LIB1)).toBe(false);
  const delegate = result.delegatecalls.find((e) => e.destination === LIB1);
  expect(delegate).toBeDefined();
  expect(delegate?.callType).toBe("delegatecall");
  expect(delegate?.targetSelector).toBe(SIG.deposit);
  // Requirement 3: delegatecall edges carry proofs too.
  expect(delegate?.examples).toHaveLength(1);
  expect(delegate?.examples[0]).toEqual({ hash: "0xtx1", block: 100, path: "2" });
});

test("an inbound call straight from an EOA has no caller selector and callerIsEoa true", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const fromEoa = result.inbound.edges.find((e) => e.caller === EOA1);
  expect(fromEoa).toBeDefined();
  expect(fromEoa?.callerIsEoa).toBe(true);
  expect(fromEoa?.callerSelector).toBeUndefined();
  expect(fromEoa?.targetSelector).toBe(SIG.deposit);
});

test("an inbound call from a contract resolves the caller's own selector from the parent frame", async () => {
  const result = await aggregateTraces([buildTx2()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const fromCallerA = result.inbound.edges.find((e) => e.caller === CALLER_A);
  expect(fromCallerA).toBeDefined();
  expect(fromCallerA?.callerIsEoa).toBe(false);
  expect(fromCallerA?.callerSelector).toBe(SIG.callerRun);
  expect(fromCallerA?.callerSignature).toBe("run()");
  expect(fromCallerA?.targetSelector).toBe(SIG.deposit);
});

test("calls counts every occurrence, txs counts distinct transactions", async () => {
  const result = await aggregateTraces([buildTx1(), buildTx2()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1 && e.destinationSelector === SIG.extTransfer);
  expect(toExt1).toBeDefined();
  // Tx1 hits ext1 twice, tx2 hits it once more: 3 calls across 2 transactions.
  expect(toExt1?.calls).toBe(3);
  expect(toExt1?.txs).toBe(2);
  const contract = result.outbound.contracts.find((c) => c.address === EXT1);
  expect(contract?.calls).toBe(3);
  expect(contract?.txs).toBe(2);
  // Requirement 3: contract roll-ups carry proofs, one per distinct transaction here.
  expect(contract?.examples).toHaveLength(2);
});

test("targetFunctionCalls tallies every observed entry into the target", async () => {
  const result = await aggregateTraces([buildTx1(), buildTx2()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const deposit = result.targetFunctionCalls.find((f) => f.selector === SIG.deposit);
  // Entered by: tx1 root (EOA), tx2 callerA->proxy. Two observed entries.
  expect(deposit?.calls).toBe(2);
  // Requirement: targetFunctionCalls carries proofs, newest transaction first.
  expect(deposit?.examples).toEqual([
    { hash: "0xtx2", block: 101, path: "0" },
    { hash: "0xtx1", block: 100, path: "root" },
  ]);
});

test("unresolvedSelectors lists selectors no signature source explains", async () => {
  const registry: SelectorResolver = {
    lookup: (selector) => ({ selector, signature: undefined, source: "unknown" }),
    resolve: async () => {},
  };
  const result = await aggregateTraces([buildTx1()], IDENTITY, registry, fakeLabels(CONTRACTS));
  expect(result.unresolvedSelectors).toContain(SIG.deposit);
  expect(result.unresolvedSelectors).toContain(SIG.extTransfer);
});

test("the frame path recorded for a nested frame is the exact index chain from the root", async () => {
  const result = await aggregateTraces([buildTx1()], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1);
  // proxy->ext1 is reached through delegateToImpl (root child 0) then its own
  // first child (0): the recorded path must be "0,0", not the raw depth.
  const proof = toExt1?.examples.find((e) => e.hash === "0xtx1");
  expect(proof).toEqual({ hash: "0xtx1", block: 100, path: "0,0" });
});

test("three frames of one transaction give one proof, not three", async () => {
  const threeFrames = frame(EOA1, PROXY, SIG.deposit, "call", [
    frame(PROXY, EXT1, SIG.extTransfer, "call"),
    frame(PROXY, EXT1, SIG.extTransfer, "call"),
    frame(PROXY, EXT1, SIG.extTransfer, "call"),
  ]);
  const tx: TraceTx = { hash: "0xtx-three", blockNumber: 200, root: threeFrames };
  const result = await aggregateTraces([tx], IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1);
  expect(toExt1?.calls).toBe(3);
  expect(toExt1?.txs).toBe(1);
  // One transaction contributes at most one proof, no matter how many of
  // its frames match the edge.
  expect(toExt1?.examples).toHaveLength(1);
  expect(toExt1?.examples[0]).toEqual({ hash: "0xtx-three", block: 200, path: "0" });
});

test("proofs from distinct transactions fill the list newest first, capped at three", async () => {
  const singleFrameTx = (hash: string, blockNumber: number): TraceTx => ({
    hash,
    blockNumber,
    root: frame(EOA1, PROXY, SIG.deposit, "call", [frame(PROXY, EXT1, SIG.extTransfer, "call")]),
  });
  const txs = [singleFrameTx("0xtx-a", 300), singleFrameTx("0xtx-b", 301), singleFrameTx("0xtx-c", 302), singleFrameTx("0xtx-d", 303)];
  const result = await aggregateTraces(txs, IDENTITY, fakeRegistry(), fakeLabels(CONTRACTS));
  const toExt1 = result.outbound.edges.find((e) => e.destination === EXT1);
  // The cap is a display limit only: every frame and every transaction is
  // still counted, even though only 3 of the 4 transactions get a proof.
  expect(toExt1?.calls).toBe(4);
  expect(toExt1?.txs).toBe(4);
  expect(toExt1?.examples).toHaveLength(3);
  expect(toExt1?.examples.map((e) => e.hash)).toEqual(["0xtx-d", "0xtx-c", "0xtx-b"]);
  expect(toExt1?.examples.map((e) => e.block)).toEqual([303, 302, 301]);
});

const SLOW_CHAIN: ChainConfig = {
  id: 1,
  key: "slowchain",
  label: "SlowChain",
  alchemyHost: "slow-mainnet",
  traceFilter: true,
  debugTracer: false,
  blockTimeSec: 12,
  nativeSymbol: "ETH",
};

/** A chain with a fast, dense block time, like Base, so a one day span needs several slices. */
const FAST_CHAIN: ChainConfig = {
  id: 8453,
  key: "fastchain",
  label: "FastChain",
  alchemyHost: "fast-mainnet",
  traceFilter: true,
  debugTracer: true,
  blockTimeSec: 2,
  nativeSymbol: "ETH",
};

/**
 * A `trace_filter` provider that always answers, but slowly, and always
 * with plenty of distinct transactions so the discovery scan never runs
 * short of candidates. That isolates the wall clock deadline as the only
 * possible reason the scan stops, per requirement 1 of the runtime brief.
 */
class SlowRpc extends RpcClient {
  calls = 0;
  private seq = 0;

  async traceFilter(params: TraceFilterParams): Promise<FlatTrace[]> {
    this.calls++;
    // A genuine real-time wait, not a fake timer: this test validates the
    // wall clock deadline in discover.ts, which reads `Date.now()`
    // directly. The project has no fake-timer harness (bun:test only,
    // zero runtime dependencies), so the deadline cannot be driven any
    // other way. The 40ms delay keeps the whole test under half a second.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 40);
    await promise;
    this.seq++;
    return Array.from({ length: 40 }, (_, i) => ({
      action: { from: "0xcaller0000000000000000000000000000001", to: PROXY, input: SIG.deposit },
      blockNumber: params.toBlock,
      subtraces: 0,
      traceAddress: [],
      transactionHash: `0xslowtx-${this.seq}-${i}`,
      type: "call",
    }));
  }
}

test("a slow trace_filter chain stops discovery inside its time budget, honestly", async () => {
  const rpc = new SlowRpc(SLOW_CHAIN);
  const startedAt = Date.now();
  // 180ms total budget, well under real depth budgets, so the test stays
  // fast: 60% (108ms) for discovery, split across up to 4 "quick" slices.
  const totalBudgetMs = 180;
  const headBlock = 1_000_000;
  const result = await discoverCandidates(SLOW_CHAIN, rpc, [PROXY], headBlock, "quick", undefined, startedAt, totalBudgetMs);
  const elapsedMs = Date.now() - startedAt;

  // The scan must stop near the discovery share of the budget, not run
  // anywhere close to the full "quick" depth budget (27s of real discovery
  // budget) that a fake test provider would otherwise burn through.
  expect(elapsedMs).toBeLessThan(totalBudgetMs * 3);
  expect(rpc.calls).toBeGreaterThan(0);

  // The span aimed at is fixed by spanDays and the chain's block time, no
  // matter how much of it the deadline let the scan actually read.
  const spanBlocks = Math.round((DEPTH_BUDGETS.quick.spanDays * 86_400) / SLOW_CHAIN.blockTimeSec);
  expect(result.toBlock).toBe(headBlock);
  expect(result.fromBlock).toBe(headBlock - spanBlocks + 1);

  // The slices actually read must be real, honest sub-ranges of that span,
  // and the deadline must have left most of the span unread.
  expect(result.slices.length).toBeGreaterThan(0);
  const coveredBlocks = result.slices.reduce((sum, s) => sum + (s.toBlock - s.fromBlock + 1), 0);
  expect(coveredBlocks).toBeLessThan(spanBlocks);
  for (const slice of result.slices) {
    expect(slice.fromBlock).toBeGreaterThanOrEqual(result.fromBlock);
    expect(slice.toBlock).toBeLessThanOrEqual(result.toBlock);
  }

  // The note must say plainly that the time budget, not the frame cap or
  // the block window, ended the scan.
  expect(result.note.toLowerCase()).toContain("time budget");
  expect(result.txs.length).toBeGreaterThan(0);
});

/** A `trace_filter` provider that answers instantly and always finds nothing, so a full span reads in one pass per slice. */
class InstantRpc extends RpcClient {
  async traceFilter(): Promise<FlatTrace[]> {
    return [];
  }
}

test("slices are planned evenly across the span, newest first, the newest ending at the head", async () => {
  const rpc = new InstantRpc(FAST_CHAIN);
  const headBlock = 1_000_000;
  const result = await discoverCandidates(FAST_CHAIN, rpc, [PROXY], headBlock, "quick", undefined, Date.now(), TOTAL_BUDGET_MS.quick);

  const spanBlocks = Math.round((DEPTH_BUDGETS.quick.spanDays * 86_400) / FAST_CHAIN.blockTimeSec);
  expect(result.toBlock).toBe(headBlock);
  expect(result.fromBlock).toBe(headBlock - spanBlocks + 1);

  // A fast, empty chain reads every slice in full, so up to `maxSlices`
  // slices are used and the sample is spread across the whole span.
  expect(result.slices.length).toBeGreaterThan(1);
  expect(result.slices.length).toBeLessThanOrEqual(DEPTH_BUDGETS.quick.maxSlices);
  expect(result.slices[0]?.toBlock).toBe(headBlock);

  // Consecutive planned slices are roughly the same width and touch, so
  // the sample describes the whole span evenly, not just its newest end.
  const widths = result.slices.map((s) => s.toBlock - s.fromBlock + 1);
  const maxWidth = Math.max(...widths);
  const minWidth = Math.min(...widths);
  expect(maxWidth - minWidth).toBeLessThanOrEqual(1);
  for (let i = 1; i < result.slices.length; i++) {
    const newer = result.slices[i - 1] as { fromBlock: number; toBlock: number };
    const older = result.slices[i] as { fromBlock: number; toBlock: number };
    expect(newer.fromBlock).toBe(older.toBlock + 1);
  }

  // Every slice touches its neighbour with no gap, so the union of slices
  // is one unbroken range: the honest strategy label is "contiguous".
  expect(result.strategy).toBe("contiguous");
  const coveredBlocks = result.slices.reduce((sum, s) => sum + (s.toBlock - s.fromBlock + 1), 0);
  expect(coveredBlocks).toBe(spanBlocks);
});

test("a gap in the middle of the span is reported honestly as a stratified window", async () => {
  const headBlock = 1_000_000;
  const spanBlocks = Math.round((DEPTH_BUDGETS.quick.spanDays * 86_400) / FAST_CHAIN.blockTimeSec);
  const segWidth = Math.ceil(spanBlocks / DEPTH_BUDGETS.quick.maxSlices);
  // The second-newest planned slice, entirely unreadable: every request
  // landing inside it fails even at the minimum slice size, so that whole
  // slice is skipped and a real gap opens in the middle of the span.
  const gapHi = headBlock - segWidth;
  const gapLo = headBlock - 2 * segWidth + 1;

  class GappyRpc extends RpcClient {
    async traceFilter(params: TraceFilterParams): Promise<FlatTrace[]> {
      if (params.toBlock <= gapHi && params.toBlock >= gapLo) throw new Error("provider unavailable for this range");
      return Array.from({ length: 30 }, (_, i) => ({
        action: { from: "0xcaller0000000000000000000000000000003", to: PROXY, input: SIG.deposit },
        blockNumber: params.toBlock,
        subtraces: 0,
        traceAddress: [],
        transactionHash: `0xgaptx-${params.toBlock}-${i}`,
        type: "call",
      }));
    }
  }

  const rpc = new GappyRpc(FAST_CHAIN);
  const result = await discoverCandidates(FAST_CHAIN, rpc, [PROXY], headBlock, "quick", undefined, Date.now(), TOTAL_BUDGET_MS.quick);

  // The failed slice is never claimed as read: no fabricated coverage.
  for (const slice of result.slices) {
    expect(slice.toBlock < gapLo || slice.fromBlock > gapHi).toBe(true);
  }
  // With a real hole in the middle, the slices cannot merge into one
  // unbroken range, so the honest strategy label is "stratified".
  expect(result.strategy).toBe("stratified");
  expect(result.note.toLowerCase()).toContain("blocks");
  expect(result.txs.length).toBeGreaterThan(0);
});
