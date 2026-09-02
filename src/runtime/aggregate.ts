/**
 * Walks traced call trees exactly once and turns them into outbound and
 * inbound edges, plus contract-level roll-ups.
 *
 * Three concepts stay separate everywhere in this file: internal calls
 * (inside the target's own identity, never an edge), outbound calls
 * (identity -> elsewhere, attributed to the target function that made
 * them), and inbound calls (elsewhere -> identity, attributed to the
 * caller's own function when the tree shows one).
 */

import { selectorOfInput } from "../rpc";
import type { CallFrame, CallType, ContractAggregate, FunctionCount, InboundEdge, OutboundEdge, Selector, TraceTx } from "../types";

/** The subset of `SignatureRegistry` this module needs. A real registry satisfies it structurally. */
export interface SelectorResolver {
  lookup(selector?: string): { selector?: string; signature?: string; name?: string; source: string };
  resolve(selectors: string[]): Promise<void>;
}

/** The subset of `LabelBook` this module needs. A real label book satisfies it structurally. */
export interface LabelSource {
  load(addresses: string[]): Promise<void>;
  label(address: string): string;
  info(address: string): { name?: string; isContract: boolean; verified: boolean };
}

export interface AggregateResult {
  outbound: { edges: OutboundEdge[]; contracts: ContractAggregate[]; totalCalls: number };
  inbound: { edges: InboundEdge[]; contracts: ContractAggregate[]; totalCalls: number };
  targetFunctionCalls: FunctionCount[];
  delegatecalls: OutboundEdge[];
  unresolvedSelectors: Selector[];
}

interface OutboundDraft {
  targetSelector?: Selector;
  destination: string;
  destinationSelector?: Selector;
  callType: CallType;
  calls: number;
  txs: Set<string>;
  lastBlock?: number;
  lastTx?: string;
}

interface InboundDraft {
  caller: string;
  callerSelector?: Selector;
  callerIsEoa: boolean;
  targetSelector?: Selector;
  callType: CallType;
  calls: number;
  txs: Set<string>;
  lastBlock?: number;
  lastTx?: string;
}

interface ContractDraft {
  address: string;
  calls: number;
  txs: Set<string>;
  /** Counterparty's own functions: destination selectors (outbound) or caller selectors (inbound). */
  ownFunctions: Map<string, { selector?: Selector; calls: number }>;
  /** The target's own functions involved in these calls. */
  targetFunctions: Map<string, { selector?: Selector; calls: number }>;
}

function bumpFunctionCount(map: Map<string, { selector?: Selector; calls: number }>, selector: Selector | undefined): void {
  const key = selector ?? "";
  const entry = map.get(key);
  if (entry) entry.calls++;
  else map.set(key, { selector, calls: 1 });
}

function bumpContract(
  contracts: Map<string, ContractDraft>,
  address: string,
  txHash: string,
  ownSelector: Selector | undefined,
  targetSelector: Selector | undefined,
): void {
  let draft = contracts.get(address);
  if (!draft) {
    draft = { address, calls: 0, txs: new Set(), ownFunctions: new Map(), targetFunctions: new Map() };
    contracts.set(address, draft);
  }
  draft.calls++;
  draft.txs.add(txHash);
  bumpFunctionCount(draft.ownFunctions, ownSelector);
  bumpFunctionCount(draft.targetFunctions, targetSelector);
}

/**
 * Walks one call tree. `enclosing` is the target selector currently in
 * scope: it is set on entry into the target and preserved across a
 * delegatecall between identity addresses, per the product brief.
 */
function walkFrame(
  frame: CallFrame,
  parent: CallFrame | undefined,
  enclosing: Selector | undefined,
  identity: Set<string>,
  tx: TraceTx,
  outboundEdges: Map<string, OutboundDraft>,
  inboundEdges: Map<string, InboundDraft>,
  delegatecalls: Map<string, OutboundDraft>,
  outboundContracts: Map<string, ContractDraft>,
  inboundContracts: Map<string, ContractDraft>,
  targetFunctionCalls: Map<string, { selector?: Selector; calls: number }>,
  labels: LabelSource,
): void {
  const from = frame.from.toLowerCase();
  const to = frame.to?.toLowerCase();
  const fromIsIdentity = identity.has(from);
  const toIsIdentity = to !== undefined && identity.has(to);

  let childEnclosing = enclosing;
  if (toIsIdentity) {
    childEnclosing = fromIsIdentity && frame.callType === "delegatecall" ? enclosing : selectorOfInput(frame.input);
  }

  if (fromIsIdentity && !toIsIdentity && to !== undefined) {
    const draftMap = frame.callType === "delegatecall" ? delegatecalls : outboundEdges;
    const key = `${enclosing ?? ""}|${to}|${selectorOfInput(frame.input) ?? ""}|${frame.callType}`;
    let draft = draftMap.get(key);
    if (!draft) {
      draft = { targetSelector: enclosing, destination: to, destinationSelector: selectorOfInput(frame.input), callType: frame.callType, calls: 0, txs: new Set() };
      draftMap.set(key, draft);
    }
    draft.calls++;
    draft.txs.add(tx.hash);
    draft.lastBlock = tx.blockNumber;
    draft.lastTx = tx.hash;
    if (frame.callType !== "delegatecall") {
      bumpContract(outboundContracts, to, tx.hash, selectorOfInput(frame.input), enclosing);
    }
  }

  if (!fromIsIdentity && toIsIdentity && to !== undefined) {
    const targetSelector = selectorOfInput(frame.input);
    const callerSelector = parent ? selectorOfInput(parent.input) : undefined;
    const callerIsEoa = parent === undefined ? !labels.info(from).isContract : false;
    const key = `${from}|${callerSelector ?? ""}|${targetSelector ?? ""}|${frame.callType}`;
    let draft = inboundEdges.get(key);
    if (!draft) {
      draft = { caller: from, callerSelector, callerIsEoa, targetSelector, callType: frame.callType, calls: 0, txs: new Set() };
      inboundEdges.set(key, draft);
    }
    draft.calls++;
    draft.txs.add(tx.hash);
    draft.lastBlock = tx.blockNumber;
    draft.lastTx = tx.hash;
    bumpContract(inboundContracts, from, tx.hash, callerSelector, targetSelector);
    bumpFunctionCount(targetFunctionCalls, targetSelector);
  }

  for (const child of frame.children) {
    walkFrame(
      child,
      frame,
      childEnclosing,
      identity,
      tx,
      outboundEdges,
      inboundEdges,
      delegatecalls,
      outboundContracts,
      inboundContracts,
      targetFunctionCalls,
      labels,
    );
  }
}

function collectFunctionCounts(map: Map<string, { selector?: Selector; calls: number }>, registry: SelectorResolver): FunctionCount[] {
  return [...map.values()]
    .map((entry) => ({ selector: entry.selector, signature: registry.lookup(entry.selector).signature, calls: entry.calls }))
    .sort((a, b) => b.calls - a.calls);
}

function finishOutboundEdges(drafts: Map<string, OutboundDraft>, registry: SelectorResolver, labels: LabelSource): OutboundEdge[] {
  return [...drafts.values()]
    .map((d) => ({
      targetSelector: d.targetSelector,
      targetSignature: registry.lookup(d.targetSelector).signature,
      destination: d.destination,
      destinationLabel: labels.label(d.destination),
      destinationSelector: d.destinationSelector,
      destinationSignature: registry.lookup(d.destinationSelector).signature,
      callType: d.callType,
      calls: d.calls,
      txs: d.txs.size,
      lastBlock: d.lastBlock,
      lastTx: d.lastTx,
    }))
    .sort((a, b) => b.calls - a.calls);
}

function finishInboundEdges(drafts: Map<string, InboundDraft>, registry: SelectorResolver, labels: LabelSource): InboundEdge[] {
  return [...drafts.values()]
    .map((d) => ({
      caller: d.caller,
      callerLabel: labels.label(d.caller),
      callerSelector: d.callerSelector,
      callerSignature: registry.lookup(d.callerSelector).signature,
      callerIsEoa: d.callerIsEoa,
      targetSelector: d.targetSelector,
      targetSignature: registry.lookup(d.targetSelector).signature,
      callType: d.callType,
      calls: d.calls,
      txs: d.txs.size,
      lastBlock: d.lastBlock,
      lastTx: d.lastTx,
    }))
    .sort((a, b) => b.calls - a.calls);
}

function finishContracts(drafts: Map<string, ContractDraft>, registry: SelectorResolver, labels: LabelSource): ContractAggregate[] {
  return [...drafts.values()]
    .map((d) => ({
      address: d.address,
      label: labels.label(d.address),
      calls: d.calls,
      txs: d.txs.size,
      functions: collectFunctionCounts(d.ownFunctions, registry),
      targetFunctions: collectFunctionCounts(d.targetFunctions, registry),
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Every selector that appears anywhere in the drafted edges, for one bulk resolve call. */
function collectSelectors(
  outboundEdges: Map<string, OutboundDraft>,
  inboundEdges: Map<string, InboundDraft>,
  delegatecalls: Map<string, OutboundDraft>,
): Set<Selector> {
  const selectors = new Set<Selector>();
  for (const d of outboundEdges.values()) {
    if (d.targetSelector) selectors.add(d.targetSelector);
    if (d.destinationSelector) selectors.add(d.destinationSelector);
  }
  for (const d of delegatecalls.values()) {
    if (d.targetSelector) selectors.add(d.targetSelector);
    if (d.destinationSelector) selectors.add(d.destinationSelector);
  }
  for (const d of inboundEdges.values()) {
    if (d.callerSelector) selectors.add(d.callerSelector);
    if (d.targetSelector) selectors.add(d.targetSelector);
  }
  return selectors;
}

/**
 * Every counterparty address, most active first.
 *
 * A busy token has hundreds of counterparties, and one label lookup costs one
 * explorer request. The reader only ever sees the ranked rows, so the order
 * here decides which addresses get a real name when the label budget runs
 * out. `src/labels.ts` caps the count and shortens the rest.
 */
function collectAddresses(outboundEdges: Map<string, OutboundDraft>, inboundEdges: Map<string, InboundDraft>, delegatecalls: Map<string, OutboundDraft>): string[] {
  const callsByAddress = new Map<string, number>();
  const add = (address: string, calls: number): void => {
    callsByAddress.set(address, (callsByAddress.get(address) ?? 0) + calls);
  };
  for (const d of outboundEdges.values()) add(d.destination, d.calls);
  for (const d of delegatecalls.values()) add(d.destination, d.calls);
  for (const d of inboundEdges.values()) add(d.caller, d.calls);
  return [...callsByAddress.entries()].sort((a, b) => b[1] - a[1]).map(([address]) => address);
}

/**
 * Races `promise` against `deadline`. A provider call (label lookup,
 * signature resolution) that has no deadline of its own could otherwise
 * block the whole runtime stage past its wall clock budget; this lets the
 * aggregation proceed with whatever labels and signatures loaded in time,
 * which is still honest, since unresolved entries already degrade to a
 * shortened address or an unknown selector rather than a guess.
 */
function withDeadline<T>(promise: Promise<T>, deadline: number | undefined, fallback: T): Promise<T> {
  if (deadline === undefined) return promise;
  const { promise: timeout, resolve } = Promise.withResolvers<T>();
  const timeLeft = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => resolve(fallback), timeLeft);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Aggregates a batch of traced transactions into `RuntimeAnalysis` edges.
 * Walks every tree once, resolves every selector once, loads every label
 * once, then fills the final edge and roll-up shapes.
 */
export async function aggregateTraces(
  txs: TraceTx[],
  identity: string[],
  registry: SelectorResolver,
  labels: LabelSource,
  deadline?: number,
): Promise<AggregateResult> {
  const identitySet = new Set(identity.map((a) => a.toLowerCase()));
  const outboundEdges = new Map<string, OutboundDraft>();
  const inboundEdges = new Map<string, InboundDraft>();
  const delegatecalls = new Map<string, OutboundDraft>();
  const outboundContracts = new Map<string, ContractDraft>();
  const inboundContracts = new Map<string, ContractDraft>();
  const targetFunctionCalls = new Map<string, { selector?: Selector; calls: number }>();

  // Callers that arrive with no parent frame default to EOA; verifying
  // that against the label book needs `labels.info`, so counterparty
  // addresses are loaded before the walk that decides `callerIsEoa`.
  const rootCallers = txs.map((tx) => tx.root.from.toLowerCase()).filter((a) => !identitySet.has(a));
  await withDeadline(labels.load(rootCallers), deadline, undefined);

  for (const tx of txs) {
    walkFrame(
      tx.root,
      undefined,
      undefined,
      identitySet,
      tx,
      outboundEdges,
      inboundEdges,
      delegatecalls,
      outboundContracts,
      inboundContracts,
      targetFunctionCalls,
      labels,
    );
  }

  const selectors = collectSelectors(outboundEdges, inboundEdges, delegatecalls);
  const addresses = collectAddresses(outboundEdges, inboundEdges, delegatecalls);
  await withDeadline(Promise.all([registry.resolve([...selectors]), labels.load(addresses)]), deadline, undefined);

  const outbound = finishOutboundEdges(outboundEdges, registry, labels);
  const inbound = finishInboundEdges(inboundEdges, registry, labels);
  const delegatecallEdges = finishOutboundEdges(delegatecalls, registry, labels);
  const outboundContractList = finishContracts(outboundContracts, registry, labels);
  const inboundContractList = finishContracts(inboundContracts, registry, labels);
  const unresolvedSelectors = [...selectors].filter((s) => registry.lookup(s).signature === undefined);

  return {
    outbound: { edges: outbound, contracts: outboundContractList, totalCalls: outbound.reduce((n, e) => n + e.calls, 0) },
    inbound: { edges: inbound, contracts: inboundContractList, totalCalls: inbound.reduce((n, e) => n + e.calls, 0) },
    targetFunctionCalls: collectFunctionCounts(targetFunctionCalls, registry),
    delegatecalls: delegatecallEdges,
    unresolvedSelectors,
  };
}
