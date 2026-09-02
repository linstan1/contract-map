/**
 * Runtime configuration: the RPC key, the depth budgets, and the stage
 * ceilings. The chain registry lives in `src/chains.ts` and is re-exported
 * here so existing imports keep working.
 */

import { readFileSync } from "node:fs";
import type { ChainConfig, Depth } from "./types";

export { CHAINS, chainById, chainByKey } from "./chains";

/**
 * How much history each depth setting asks for.
 *
 * The span is stated in DAYS, not in blocks, so a chain with two second
 * blocks and a chain with twelve second blocks answer the same question. The
 * discovery code turns the span into blocks with `chain.blockTimeSec`, then
 * reads slices spread across that span when the whole span costs too much.
 */
export interface DepthBudget {
  /** Days of history the scan aims at. */
  spanDays: number;
  /** Highest number of slices used to spread the scan over the span. */
  maxSlices: number;
  /** Highest number of transactions traced in full. */
  maxTracedTxs: number;
  /** Highest number of flat frames pulled from `trace_filter`. */
  maxFrames: number;
}

export const DEPTH_BUDGETS: Record<Depth, DepthBudget> = {
  quick: { spanDays: 1, maxSlices: 4, maxTracedTxs: 25, maxFrames: 4_000 },
  standard: { spanDays: 7, maxSlices: 10, maxTracedTxs: 80, maxFrames: 12_000 },
  deep: { spanDays: 45, maxSlices: 24, maxTracedTxs: 220, maxFrames: 30_000 },
};

/**
 * Hard ceiling for the whole trace stage, per depth.
 *
 * The runtime modules budget discovery and tracing inside this window, and
 * `RpcClient.deadlineAt` cuts any request that outlives it. A busy chain then
 * returns a smaller honest window instead of hanging the request.
 */
export const STAGE_BUDGET_MS: Record<Depth, number> = {
  quick: 60_000,
  standard: 120_000,
  deep: 240_000,
};

let cachedKey: string | undefined;

/** Reads `ALCHEMY_API_KEY` from the environment or from `.env.local`. */
export function alchemyKey(): string {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.ALCHEMY_API_KEY;
  if (fromEnv && fromEnv.length > 0) {
    cachedKey = fromEnv;
    return fromEnv;
  }
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith("ALCHEMY_API_KEY="));
    const value = line?.slice("ALCHEMY_API_KEY=".length).trim();
    if (value) {
      cachedKey = value;
      return value;
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error("ALCHEMY_API_KEY is not set. Put it in contract-map/.env.local");
}

export function rpcUrl(chain: ChainConfig): string {
  return `https://${chain.alchemyHost}.g.alchemy.com/v2/${alchemyKey()}`;
}

/** Signature databases used when an ABI does not explain a selector. */
export const SIGNATURE_SOURCES = {
  openchain: "https://api.openchain.xyz/signature-database/v1/lookup",
  fourByte: "https://www.4byte.directory/api/v1/signatures/",
} as const;

export const PORT = Number(process.env.PORT ?? 8787);
