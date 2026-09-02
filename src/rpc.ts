/**
 * JSON-RPC access and trace normalisation.
 *
 * Two providers answer trace questions and they answer in different shapes:
 *
 *   `trace_filter` / `trace_transaction`  a FLAT list of frames, each carrying
 *                                        a `traceAddress` path.
 *   `debug_traceTransaction` + callTracer a NESTED frame tree.
 *
 * Both are converted to the single `CallFrame` tree of `src/types.ts`, so the
 * aggregation code in `src/runtime` never branches on the provider.
 */

import { rpcSecrets, rpcUrl } from "./config";
import type { CallFrame, CallType, ChainConfig } from "./types";

export interface FlatTraceAction {
  from?: string;
  to?: string;
  callType?: string;
  input?: string;
  value?: string;
  init?: string;
  address?: string;
  refundAddress?: string;
  balance?: string;
}

/** One entry of a `trace_filter` or `trace_transaction` answer. */
export interface FlatTrace {
  action: FlatTraceAction;
  blockNumber: number;
  blockHash?: string;
  result?: { address?: string; gasUsed?: string; output?: string } | null;
  error?: string;
  subtraces: number;
  traceAddress: number[];
  transactionHash: string;
  transactionPosition?: number;
  type: string;
}

/** One frame of a `debug_traceTransaction` answer with the `callTracer`. */
export interface CallTracerFrame {
  from: string;
  to?: string;
  input?: string;
  output?: string;
  value?: string;
  type?: string;
  error?: string;
  revertReason?: string;
  calls?: CallTracerFrame[];
}

export interface TraceFilterParams {
  fromBlock: number;
  toBlock: number;
  fromAddress?: string[];
  toAddress?: string[];
  after?: number;
  count?: number;
}

/**
 * Removes every RPC credential from text that leaves this module.
 *
 * The endpoint URL carries the credential, and a failed `fetch` puts the URL
 * in its message. Those messages reach the browser and the log, so each
 * secret is replaced before any message escapes. `RpcError` is the only error
 * type this module throws, so the scrub in its constructor covers every path.
 */
function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of rpcSecrets()) {
    if (secret.length > 0) out = out.split(secret).join("***");
  }
  return out;
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly code?: number,
  ) {
    super(scrubSecrets(message));
    this.name = "RpcError";
  }
}

/** Errors that a later attempt can still succeed on. */
function isTransient(message: string, status: number): boolean {
  if (status === 429 || status >= 500) return true;
  const lower = message.toLowerCase();
  return lower.includes("timeout") || lower.includes("capacity") || lower.includes("rate limit") || lower.includes("try again");
}

/**
 * Texts that mean the endpoint refuses the method itself, not this request.
 *
 * Any provider may serve the chain, so the trace support is a property of
 * the endpoint, not of the chain. A caller uses this test to stop retrying a
 * method that cannot answer, and to try the other trace method instead.
 */
const UNSUPPORTED_METHOD_PATTERNS = [
  /method not found/i,
  /method .* (?:is )?not (?:supported|available|enabled|allowed)/i,
  /unsupported method/i,
  /does not exist\/is not available/i,
  /not (?:supported|available) on this (?:endpoint|plan|tier|node)/i,
  /requires? (?:a )?(?:personal |paid |archive )?(?:token|plan|tier|subscription|upgrade)/i,
  /archive (?:requests?|data|node) (?:are |is )?(?:not |require)/i,
  /(?:unauthorized|forbidden|invalid api key|access denied)/i,
  /trace namespace/i,
  /debug namespace/i,
];

/** `true` when no retry and no smaller request can ever make this method succeed. */
export function meansMethodUnsupported(message: string): boolean {
  return UNSUPPORTED_METHOD_PATTERNS.some((pattern) => pattern.test(message));
}

export class RpcClient {
  private nextId = 1;
  /** Concurrent in-flight requests, kept low enough not to trip rate limits. */
  private readonly gate = new Semaphore(6);

  /**
   * Wall-clock instant, in epoch milliseconds, after which this client
   * refuses new work and cuts an in-flight request short.
   *
   * A trace call on a busy chain can hang for minutes, and retries multiply
   * that. A stage that owns a time budget sets this field, so no single
   * provider stall can outlive the budget. Clear it when the stage ends.
   */
  deadlineAt?: number;

  /** Highest time one call may spend, retries included. */
  private static readonly CALL_BUDGET_MS = 30_000;
  /** Highest time one attempt may spend. */
  private static readonly ATTEMPT_TIMEOUT_MS = 20_000;

  constructor(readonly chain: ChainConfig) {}

  /** Milliseconds left for one attempt, from the call budget and the deadline. */
  private budgetFor(startedAt: number): number {
    const fromCall = RpcClient.CALL_BUDGET_MS - (Date.now() - startedAt);
    const fromStage = this.deadlineAt ? this.deadlineAt - Date.now() : Number.MAX_SAFE_INTEGER;
    return Math.min(RpcClient.ATTEMPT_TIMEOUT_MS, fromCall, fromStage);
  }

  async call<T>(method: string, params: unknown[], attempts = 4): Promise<T> {
    /* A missing key is a configuration fault, not a transient provider
     * fault. Resolve the endpoint once, before the retry loop, so the caller
     * gets the instructions immediately instead of after several backoffs. */
    let endpoint: string;
    try {
      endpoint = rpcUrl(this.chain);
    } catch (error) {
      throw new RpcError(error instanceof Error ? error.message : String(error), method);
    }

    const startedAt = Date.now();
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const timeout = this.budgetFor(startedAt);
      if (timeout <= 0) throw new RpcError(`${method}: the time budget for this stage ran out`, method);
      const release = await this.gate.acquire();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await response.text();
        let body: { result?: T; error?: { message: string; code?: number } };
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          /* A rate limiter or a proxy answers HTML, not JSON. The status
           * carries the whole meaning here, so a later attempt can still
           * succeed and MUST be tried: a free endpoint answers 429 often. */
          const nonJson = `${method}: provider returned non-JSON (HTTP ${response.status})`;
          if (isTransient("", response.status) && attempt < attempts) {
            lastError = nonJson;
            await sleep(400 * attempt * attempt);
            continue;
          }
          throw new RpcError(nonJson, method);
        }
        if (body.error) {
          if (isTransient(body.error.message, response.status) && attempt < attempts) {
            lastError = body.error.message;
            await sleep(400 * attempt * attempt);
            continue;
          }
          throw new RpcError(body.error.message, method, body.error.code);
        }
        return body.result as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RpcError && !isTransient(message, 0)) throw error;
        lastError = message;
        if (attempt === attempts || this.budgetFor(startedAt) <= 0) throw new RpcError(`${method}: ${message}`, method);
        await sleep(400 * attempt * attempt);
      } finally {
        release();
      }
    }
    throw new RpcError(`${method}: ${lastError}`, method);
  }

  async blockNumber(): Promise<number> {
    return parseInt(await this.call<string>("eth_blockNumber", []), 16);
  }

  async getCode(address: string): Promise<string> {
    return await this.call<string>("eth_getCode", [address, "latest"]);
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    return await this.call<string>("eth_getStorageAt", [address, slot, "latest"]);
  }

  /** Read-only call, used for `implementation()` style probes. */
  async ethCall(to: string, data: string): Promise<string | undefined> {
    try {
      return await this.call<string>("eth_call", [{ to, data }, "latest"], 2);
    } catch {
      return undefined;
    }
  }

  async traceFilter(params: TraceFilterParams): Promise<FlatTrace[]> {
    const filter: Record<string, unknown> = {
      fromBlock: `0x${params.fromBlock.toString(16)}`,
      toBlock: `0x${params.toBlock.toString(16)}`,
    };
    if (params.fromAddress) filter.fromAddress = params.fromAddress;
    if (params.toAddress) filter.toAddress = params.toAddress;
    if (params.after !== undefined) filter.after = params.after;
    if (params.count !== undefined) filter.count = params.count;
    return (await this.call<FlatTrace[]>("trace_filter", [filter])) ?? [];
  }

  async traceTransaction(hash: string): Promise<FlatTrace[]> {
    return (await this.call<FlatTrace[]>("trace_transaction", [hash])) ?? [];
  }

  async debugTraceTransaction(hash: string): Promise<CallTracerFrame | undefined> {
    return await this.call<CallTracerFrame | undefined>("debug_traceTransaction", [
      hash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: false, withLog: false } },
    ]);
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Bounded concurrency, so one analysis cannot open hundreds of sockets. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.queue.push(resolve);
      await promise;
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

/** Runs `worker` over `items` with at most `limit` running at once. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

const CALL_TYPES: Record<string, CallType> = {
  call: "call",
  staticcall: "staticcall",
  delegatecall: "delegatecall",
  callcode: "callcode",
  create: "create",
  create2: "create",
  selfdestruct: "selfdestruct",
  suicide: "selfdestruct",
};

export function normaliseCallType(raw: string | undefined): CallType {
  return CALL_TYPES[(raw ?? "call").toLowerCase()] ?? "call";
}

/**
 * Rebuilds the call tree from flat frames.
 *
 * `traceAddress` is the path from the root: `[]` is the transaction level
 * frame, `[0]` its first child, `[0, 2]` the third child of that child. Frames
 * are sorted by path so a parent always exists before its children.
 */
export function flatTracesToTree(traces: FlatTrace[]): CallFrame | undefined {
  const sorted = [...traces].sort((a, b) => {
    const depth = a.traceAddress.length - b.traceAddress.length;
    if (depth !== 0) return depth;
    for (let i = 0; i < a.traceAddress.length; i++) {
      const diff = (a.traceAddress[i] ?? 0) - (b.traceAddress[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  const byPath = new Map<string, CallFrame>();
  let root: CallFrame | undefined;

  for (const trace of sorted) {
    const frame = frameFromFlat(trace);
    const path = trace.traceAddress.join(".");
    byPath.set(path, frame);
    if (trace.traceAddress.length === 0) {
      root = frame;
      continue;
    }
    const parentPath = trace.traceAddress.slice(0, -1).join(".");
    const parent = byPath.get(parentPath);
    if (parent) parent.children.push(frame);
    else if (!root) root = frame; // orphan: keep the frame rather than lose it
  }
  return root;
}

function frameFromFlat(trace: FlatTrace): CallFrame {
  const action = trace.action;
  const type = trace.type === "call" ? normaliseCallType(action.callType) : normaliseCallType(trace.type);
  return {
    from: (action.from ?? action.address ?? "").toLowerCase(),
    to: (action.to ?? trace.result?.address ?? action.refundAddress)?.toLowerCase(),
    input: action.input ?? action.init ?? "0x",
    callType: type,
    value: action.value ?? "0x0",
    error: trace.error,
    children: [],
  };
}

/** Converts a `callTracer` tree into the shared `CallFrame` tree. */
export function callTracerToTree(frame: CallTracerFrame): CallFrame {
  return {
    from: (frame.from ?? "").toLowerCase(),
    to: frame.to?.toLowerCase(),
    input: frame.input ?? "0x",
    callType: normaliseCallType(frame.type),
    value: frame.value ?? "0x0",
    error: frame.error ?? frame.revertReason,
    children: (frame.calls ?? []).map(callTracerToTree),
  };
}

/** The four byte selector of call data, or `undefined` when there is none. */
export function selectorOfInput(input: string | undefined): string | undefined {
  if (!input || input.length < 10 || !input.startsWith("0x")) return undefined;
  return input.slice(0, 10).toLowerCase();
}
