/**
 * The one shared vocabulary of the application.
 *
 * Every module in `src/` and the browser code in `public/` speak these types.
 * The five analysis stages named in the product brief map onto them like this:
 *
 *   Agent 1  Contract Structure Analyst -> `StaticAnalysis`   (src/solidity)
 *   Agent 2  Function Execution Mapper  -> `FunctionMap`      (src/pipeline.ts)
 *   Agent 3  Outbound Runtime Analyst   -> `RuntimeAnalysis.outbound` (src/runtime)
 *   Agent 4  Inbound Runtime Analyst    -> `RuntimeAnalysis.inbound`  (src/runtime)
 *   Agent 5  Reviewer                   -> `Review`           (src/review.ts)
 *
 * Three concepts stay separate everywhere, exactly as the brief demands, and
 * no code path is allowed to merge them:
 *
 *   internal calls  - functions inside the target implementation
 *   outbound calls  - calls the target makes into another contract
 *   inbound calls   - calls another contract makes into the target
 *
 * A second separation is just as strict: `possible` facts come from code,
 * `observed` facts come from transaction traces. A value of `observedCalls: 0`
 * with `possibleFromCode: true` MUST render as "not observed", never as zero
 * activity of an executed path.
 */

export type Hex = `0x${string}`;
export type Address = string;
export type Selector = string;

/* ------------------------------------------------------------------ chains */

export interface ChainConfig {
  id: number;
  /** URL slug used by the UI, e.g. `ethereum`. */
  key: string;
  label: string;
  /** Alchemy host prefix, e.g. `eth-mainnet`. */
  alchemyHost: string;
  /** Blockscout v2 base URL, or `undefined` when no instance exists. */
  blockscout?: string;
  /** `true` when `trace_filter` answers on this chain. */
  traceFilter: boolean;
  /** `true` when `debug_traceTransaction` with `callTracer` answers. */
  debugTracer: boolean;
  /** Mean seconds per block, used to translate a time span into blocks. */
  blockTimeSec: number;
  /** Native currency symbol. */
  nativeSymbol: string;
  /** `true` when the Sourcify repository serves this chain id. */
  sourcify?: boolean;
  /**
   * Base URL for one transaction on a public explorer, ending in `/tx/`.
   *
   * The interface turns every observed edge into a link here, so a reader can
   * open the transaction that proves it. Blockscout serves as the fallback
   * when a chain has no other public explorer.
   */
  explorerTx?: string;
  /** What the live probe found, for the provenance panel. */
  probeNote?: string;
}

/* ------------------------------------------------- static analysis, agent 1 */

export type Visibility = "public" | "external" | "internal" | "private";
export type Mutability = "pure" | "view" | "nonpayable" | "payable" | "unknown";
export type CallType = "call" | "staticcall" | "delegatecall" | "callcode" | "create" | "selfdestruct" | "transfer" | "dynamic";

export interface SourceFile {
  path: string;
  content: string;
}

export interface SourceRef {
  file: string;
  line: number;
  snippet: string;
}

export interface AbiParam {
  name?: string;
  type: string;
  components?: AbiParam[];
}

export interface AbiEntry {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
  anonymous?: boolean;
}

/** How the destination address of an outbound call is decided in code. */
export interface DestinationHint {
  kind: "immutable" | "state" | "constant" | "literal" | "parameter" | "local" | "unknown";
  /** Variable or parameter name that carries the address. */
  name?: string;
  /** Literal address when the code hard-codes one. */
  address?: Address;
  /** Solidity type of the destination, e.g. `IERC20`, `IMorpho`. */
  contractType?: string;
}

/** One call the code is able to make into another contract. */
export interface StaticExternalCall {
  /** Destination as written in source, e.g. `IERC20(asset)`. */
  destExpr: string;
  destination: DestinationHint;
  functionName: string;
  /** Canonical signature when the interface is known. */
  signature?: string;
  selector?: Selector;
  argCount: number;
  callType: CallType;
  /** Internal functions crossed to reach this call, outermost first. */
  via: string[];
  /** Why the code makes this call, derived from the surrounding statement. */
  reason: string;
  source?: SourceRef;
}

export interface StaticInternalCall {
  name: string;
  signature?: string;
  kind: "internal" | "private" | "public-self" | "library" | "modifier";
  /** Contract or library that declares the callee. */
  declaredIn?: string;
  /** 1 = called directly by the exposed function. */
  depth: number;
  /** Internal functions crossed to reach this call, outermost first. */
  via: string[];
  purpose: string;
}

export interface StateAccess {
  name: string;
  type?: string;
  declaredIn?: string;
  /** Internal functions crossed to reach this access, outermost first. */
  via: string[];
}

export interface AccessControl {
  kind: "open" | "restricted" | "self" | "owner" | "role" | "unknown";
  /** Human sentence: who may call this function. */
  detail: string;
  /** Modifiers or require statements that gate the call. */
  gates: string[];
}

/**
 * What a control-flow walk of compiled code proves about one function.
 *
 * Every field is a fact about opcodes reached from the dispatcher branch of
 * the selector. `truncated` says the walk stopped early, so a `false` field
 * means "not seen", never "cannot happen".
 */
export interface BytecodeFacts {
  readsStorage: boolean;
  writesStorage: boolean;
  makesCall: boolean;
  makesStaticcall: boolean;
  makesDelegatecall: boolean;
  createsContract: boolean;
  selfDestructs: boolean;
  /** Addresses the code holds as constants, lowercase. */
  addressConstants: Address[];
  /** Event topics the code holds as constants. */
  eventTopics: string[];
  /** Storage slots read or written as literal constants. */
  storageSlots: string[];
  /** Basic blocks visited by the walk. */
  blocksWalked: number;
  /** `true` when a dynamic jump or the block cap stopped the walk. */
  truncated: boolean;
}

export interface FunctionAnalysis {
  name: string;
  /** Canonical signature, e.g. `deposit(uint256,address)`. */
  signature: string;
  selector: Selector;
  params: AbiParam[];
  outputs: AbiParam[];
  visibility: Visibility;
  mutability: Mutability;
  modifiers: string[];
  access: AccessControl;
  /** Short classification, e.g. `deposit / asset movement`. */
  role: string;
  /** Generated plain-English behaviour statement. */
  whatItDoes: string;
  /** Author documentation, kept separate from `whatItDoes`. */
  natspec?: string;
  declaredIn?: string;
  reads: StateAccess[];
  writes: StateAccess[];
  internalCalls: StaticInternalCall[];
  externalCalls: StaticExternalCall[];
  /** Events emitted, canonical signatures when known. */
  events: string[];
  /** Facts the reader must know, e.g. an unresolvable low-level call. */
  notes: string[];
  /** `false` when the entry comes from an ABI or from bytecode only. */
  hasSource: boolean;
  /** `true` when the same name exists with other parameters. */
  overloaded: boolean;
  /**
   * Facts read straight from the compiled code of this function.
   *
   * They exist for every contract with code, verified or not, because a
   * control-flow walk of the dispatcher branch needs no source. They answer
   * the reader's first questions about an unverified function: does it write
   * storage, does it call out, does it delegatecall.
   */
  bytecodeFacts?: BytecodeFacts;
}

export interface ProxyInfo {
  isProxy: boolean;
  proxyType?: string;
  implementation?: Address;
  implementationName?: string;
  detectedBy: "blockscout" | "eip1967-slot" | "eip1822-slot" | "beacon" | "none";
  /** Other implementations Blockscout reports, if any. */
  conflicting?: Address[];
}

export interface EventAnalysis {
  name: string;
  signature: string;
  topic0: Hex;
}

export interface StaticAnalysis {
  verified: boolean;
  /** Name of the contract whose code executes, implementation for a proxy. */
  contractName?: string;
  compiler?: string;
  language?: string;
  proxy: ProxyInfo;
  /** e.g. `ERC4626 lending vault`. */
  likelyType: string;
  /** Standards matched by selector, e.g. `ERC20`, `ERC4626`. */
  interfaces: string[];
  inheritance: string[];
  /** Plain-English contract summary. */
  summary: string;
  functions: FunctionAnalysis[];
  events: EventAnalysis[];
  /** Selectors in bytecode that no ABI or database explains. */
  unresolvedSelectors: Selector[];
  /** Source files used, for provenance. */
  sourceFiles: string[];
  /**
   * Where the source came from, when it did not come from the address itself:
   * a verified bytecode twin, or the Sourcify repository. The reader must
   * know that the source belongs to matching code at another address.
   */
  sourceProvenance?: string;
  /** `true` when the analysis of function bodies used Vyper rules. */
  vyper?: boolean;
  warnings: string[];
}

/* ------------------------------------------- runtime analysis, agents 3 + 4 */

/** A normalised call frame, from `trace_transaction` or `debug_traceTransaction`. */
export interface CallFrame {
  from: Address;
  to?: Address;
  input: string;
  callType: CallType;
  value: string;
  error?: string;
  children: CallFrame[];
}

export interface TraceTx {
  hash: string;
  blockNumber: number;
  timestamp?: number;
  root: CallFrame;
}

export interface FunctionCount {
  selector?: Selector;
  signature?: string;
  calls: number;
  /** Transactions that prove these calls, newest first. */
  examples?: TxRef[];
}

/** target function -> destination contract -> destination function. */
export interface OutboundEdge {
  targetSelector?: Selector;
  targetSignature?: string;
  destination: Address;
  destinationLabel: string;
  destinationSelector?: Selector;
  destinationSignature?: string;
  callType: CallType;
  calls: number;
  txs: number;
  lastBlock?: number;
  lastTx?: string;
  /**
   * Transactions that prove this exact edge, newest first.
   *
   * Every observed claim in this application must be checkable by hand, so
   * each edge carries the transactions it was derived from. The interface
   * turns them into links to a block explorer. The list is capped, and the
   * cap never changes `calls` or `txs`.
   */
  examples: TxRef[];
  /** `true` when static analysis also finds this call in code. */
  possibleFromCode?: boolean;
}

/** One transaction that proves an observed claim. */
export interface TxRef {
  hash: string;
  block: number;
  /** Path of the frame inside the trace tree, for example `1,11,1`. */
  path?: string;
}

/** caller contract -> caller function -> target function. */
export interface InboundEdge {
  caller: Address;
  callerLabel: string;
  callerSelector?: Selector;
  callerSignature?: string;
  /** `true` when the call arrives straight from an externally owned account. */
  callerIsEoa: boolean;
  targetSelector?: Selector;
  targetSignature?: string;
  callType: CallType;
  calls: number;
  txs: number;
  lastBlock?: number;
  lastTx?: string;
  /** Transactions that prove this edge, newest first. */
  examples: TxRef[];
}

/** Contract-level roll-up for either direction. */
export interface ContractAggregate {
  address: Address;
  label: string;
  calls: number;
  txs: number;
  /**
   * Counterparty side functions. For an outbound roll-up these are the
   * functions called on the counterparty. For an inbound roll-up these are
   * the caller side functions that generated the calls.
   */
  functions: FunctionCount[];
  /** Target functions involved in those calls. */
  targetFunctions: FunctionCount[];
  /** Transactions that prove calls with this counterparty, newest first. */
  examples: TxRef[];
}

export interface TraceWindow {
  /** First block of the span the scan aimed at. */
  fromBlock: number;
  /** Last block of the span, normally the head. */
  toBlock: number;
  /** Blocks between `fromBlock` and `toBlock`, the span. */
  blocks: number;
  /**
   * Blocks really read. A dense chain cannot answer a whole span inside the
   * budget, so the scan reads slices spread across it. This number is the sum
   * of those slices and is smaller than `blocks`.
   */
  coveredBlocks: number;
  /** The slices really read, in block order. */
  slices: { fromBlock: number; toBlock: number }[];
  /** `contiguous` reads one range. `stratified` spreads slices over the span. */
  strategy: "contiguous" | "stratified";
  /** Days between `fromBlock` and `toBlock`. */
  approxDays: number;
  /** Days really covered by the slices. */
  coveredDays: number;
  /** Transactions found that touch the target. */
  candidateTxs: number;
  /** Transactions actually traced. */
  sampledTxs: number;
  /** `true` when the sample is smaller than the candidate set. */
  sampled: boolean;
  /** How candidates were discovered and traced. */
  method: string;
  note: string;
}

export interface RuntimeAnalysis {
  available: boolean;
  window: TraceWindow;
  outbound: {
    edges: OutboundEdge[];
    contracts: ContractAggregate[];
    totalCalls: number;
  };
  inbound: {
    edges: InboundEdge[];
    contracts: ContractAggregate[];
    totalCalls: number;
  };
  /** Observed entries into the target, by target function. */
  targetFunctionCalls: FunctionCount[];
  /** Delegatecalls out of the target, kept apart from ordinary calls. */
  delegatecalls: OutboundEdge[];
  /** Selectors seen in traces that no signature source explains. */
  unresolvedSelectors: Selector[];
  warnings: string[];
}

/* --------------------------------------------- execution map, agent 2 */

export interface ExecutionNode {
  kind: "entry" | "internal" | "external" | "dynamic";
  /** Display label, e.g. `_convertToShares()` or `USDC.transferFrom()`. */
  label: string;
  detail?: string;
  /** `true` when code analysis finds the step. */
  possibleFromCode: boolean;
  /** `true` when traces show the step. */
  observedOnchain: boolean;
  observedCalls: number;
  children: ExecutionNode[];
}

export interface MergedExternalCall {
  destination?: Address;
  destinationLabel: string;
  destinationSelector?: Selector;
  destinationSignature?: string;
  functionLabel: string;
  callType: CallType;
  reason: string;
  possibleFromCode: boolean;
  observedOnchain: boolean;
  observedCalls: number;
  observedTxs: number;
  /** Transactions that prove the observed part of this row, newest first. */
  examples: TxRef[];
  via: string[];
}

export interface FunctionMap {
  signature: string;
  selector: Selector;
  name: string;
  role: string;
  whatItDoes: string;
  /** Execution tree, entry function at the root. */
  tree: ExecutionNode;
  /** Ordered plain-English account of one execution. */
  narrative: string[];
  externalCalls: MergedExternalCall[];
  observed: { txs: number; calls: number; examples: TxRef[] };
  inbound: InboundEdge[];
}

/* -------------------------------------------------- review, agent 5 */

export interface ReviewCheck {
  id: string;
  title: string;
  status: "ok" | "warn" | "info";
  detail: string;
}

export interface Review {
  checks: ReviewCheck[];
}

/* ------------------------------------------------------------- result */

export interface AnalysisMeta {
  address: Address;
  chainId: number;
  chainKey: string;
  chainLabel: string;
  /** Best known name for the address. */
  label: string;
  analyzedAt: string;
  headBlock: number;
  durationMs: number;
  depth: Depth;
  dataSources: string[];
  /** Explorer base URL for one transaction, so the page can link every proof. */
  explorerTx?: string;
}

export type Depth = "quick" | "standard" | "deep";

export interface TokenInfo {
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface AnalysisResult {
  meta: AnalysisMeta;
  overview: {
    likelyType: string;
    verified: boolean;
    contractName?: string;
    proxy: ProxyInfo;
    summary: string;
    interfaces: string[];
    token?: TokenInfo;
    /** Counts for the header strip. */
    stats: {
      exposedFunctions: number;
      outboundContracts: number;
      inboundContracts: number;
      observedCalls: number;
    };
  };
  static: StaticAnalysis;
  runtime: RuntimeAnalysis;
  functions: FunctionMap[];
  review: Review;
  errors: string[];
}
