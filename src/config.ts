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

/**
 * Every user supplies their own RPC key.
 *
 * The repository ships NO key and NO default. `.env.local` is ignored by git,
 * so a key stays on the machine that created it and is never inherited by a
 * clone or a fork. `scripts/check-secrets.ts` enforces that, and the CI
 * workflow runs it on every push.
 *
 * Resolution order: the `ALCHEMY_API_KEY` environment variable, then
 * `.env.local` beside `package.json`.
 */
let cachedKey: string | undefined;

/** Values people paste from documentation instead of a real key. */
const PLACEHOLDERS = new Set(["your_key_here", "your-key-here", "changeme", "todo", "xxx", "<key>", "alchemy_api_key"]);

function readKeyFile(): string | undefined {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("ALCHEMY_API_KEY="));
    return line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** The configured key, or `undefined` when this machine has none. */
export function findAlchemyKey(): string | undefined {
  if (cachedKey) return cachedKey;
  const candidate = (process.env.ALCHEMY_API_KEY ?? "").trim() || readKeyFile();
  if (!candidate || PLACEHOLDERS.has(candidate.toLowerCase())) return undefined;
  cachedKey = candidate;
  return candidate;
}

/** The message shown to anyone who runs this without a key of their own. */
export const MISSING_KEY_MESSAGE = [
  "No RPC key is configured, and this project ships none.",
  "Get your own key from https://alchemy.com, then either:",
  "  1. copy .env.example to .env.local and set ALCHEMY_API_KEY, or",
  "  2. export ALCHEMY_API_KEY in your shell.",
  "The key stays on this machine. It is never committed, and .env.local is ignored by git.",
].join("\n");

export function alchemyKey(): string {
  const key = findAlchemyKey();
  if (!key) throw new Error(MISSING_KEY_MESSAGE);
  return key;
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
