/**
 * Runtime configuration: the RPC endpoint, the depth budgets, and the stage
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
 * Every user supplies their own RPC endpoint.
 *
 * The repository ships NO key, NO URL and NO default host. `.env.local` is
 * ignored by git, so a credential stays on the machine that created it and is
 * never inherited by a clone or a fork. `scripts/check-secrets.ts` enforces
 * that, and the CI workflow runs it on every push.
 *
 * Two ways to configure an endpoint exist, and the first match wins:
 *
 *   1. A full URL for any provider. `RPC_URL_<CHAIN>` sets one chain, for
 *      example `RPC_URL_ETHEREUM`. `RPC_URL` sets every chain that has no
 *      per-chain entry.
 *   2. `ALCHEMY_API_KEY`. The code then builds the Alchemy URL from
 *      `chain.alchemyHost`.
 *
 * Each value comes from the environment first, then from `.env.local` beside
 * `package.json`.
 */

/** Values people paste from documentation instead of a real credential. */
const PLACEHOLDERS = new Set([
  "your_key_here",
  "your-key-here",
  "changeme",
  "todo",
  "xxx",
  "<key>",
  "alchemy_api_key",
  "your_rpc_url_here",
  "https://",
  "<url>",
]);

let cachedEnvFile: Map<string, string> | undefined;

/** `.env.local` as a name to value map. An absent or unreadable file gives an empty map. */
function envFile(): Map<string, string> {
  if (cachedEnvFile) return cachedEnvFile;
  const entries = new Map<string, string>();
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value) entries.set(name, value);
    }
  } catch {
    /* No file on this machine. The environment is then the only source. */
  }
  cachedEnvFile = entries;
  return entries;
}

/** Forget the parsed `.env.local`, so a later read sees a changed file. */
export function resetConfigCache(): void {
  cachedEnvFile = undefined;
}

/**
 * A source of configured values.
 *
 * `names()` lists every name it holds, and `get()` reads one value. The
 * process source reads the environment first, then `.env.local`. A test
 * passes its own source, so no test depends on the file of the machine that
 * runs it.
 */
export interface Settings {
  names(): string[];
  get(name: string): string | undefined;
}

/** A source over a plain name to value map, for tests and for callers with their own values. */
export function settingsFrom(entries: Record<string, string>): Settings {
  return {
    names: () => Object.keys(entries),
    get: (name) => usable(entries[name]),
  };
}

/** The value, or `undefined` when it is empty or a documentation placeholder. */
function usable(raw: string | undefined): string | undefined {
  const candidate = (raw ?? "").trim();
  if (!candidate || PLACEHOLDERS.has(candidate.toLowerCase())) return undefined;
  return candidate;
}

/** The real source: the environment of this process, then `.env.local`. */
export const processSettings: Settings = {
  names: () => [...new Set([...Object.keys(process.env), ...envFile().keys()])],
  get: (name) => usable(process.env[name]) ?? usable(envFile().get(name)),
};

/** The per-chain variable name for one chain, for example `RPC_URL_ARBITRUM_ONE`. */
export function rpcUrlVar(chain: Pick<ChainConfig, "key">): string {
  return `RPC_URL_${chain.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The configured key, or `undefined` when this machine has none. */
export function findAlchemyKey(settings: Settings = processSettings): string | undefined {
  return settings.get("ALCHEMY_API_KEY");
}

/** The custom endpoint for one chain, or `undefined` when the Alchemy default applies. */
export function findCustomRpcUrl(chain: Pick<ChainConfig, "key">, settings: Settings = processSettings): string | undefined {
  return settings.get(rpcUrlVar(chain)) ?? settings.get("RPC_URL");
}

/** `true` when at least one endpoint is configured, so a startup guard can stop early. */
export function hasRpcEndpoint(settings: Settings = processSettings): boolean {
  if (findAlchemyKey(settings)) return true;
  return settings.names().some((name) => (name === "RPC_URL" || name.startsWith("RPC_URL_")) && settings.get(name));
}

/** The message shown to anyone who runs this without an endpoint of their own. */
export const MISSING_ENDPOINT_MESSAGE = [
  "No RPC endpoint is configured, and this project ships none.",
  "Pick one of these, in .env.local beside package.json or in your shell:",
  "  1. RPC_URL=<full JSON-RPC URL>          any provider, every chain",
  "  2. RPC_URL_ETHEREUM=<full URL>          one chain only, one variable per chain",
  "  3. ALCHEMY_API_KEY=<your key>           the code then builds the Alchemy URL",
  "Observed execution and the proof links need trace_filter and trace_transaction,",
  "or debug_traceTransaction with the callTracer. A provider without them still",
  "answers the static half: bytecode, source, proxy and possible call paths.",
  "The value stays on this machine. It is never committed, and .env.local is ignored by git.",
].join("\n");

export function alchemyKey(settings: Settings = processSettings): string {
  const key = findAlchemyKey(settings);
  if (!key) throw new Error(MISSING_ENDPOINT_MESSAGE);
  return key;
}

/**
 * The JSON-RPC endpoint for one chain.
 *
 * Throws `MISSING_ENDPOINT_MESSAGE` when neither a URL nor a key exists for
 * this chain, because that is a configuration fault and no retry fixes it.
 */
export function rpcUrl(chain: ChainConfig, settings: Settings = processSettings): string {
  const custom = findCustomRpcUrl(chain, settings);
  if (custom) return custom;
  return `https://${chain.alchemyHost}.g.alchemy.com/v2/${alchemyKey(settings)}`;
}

/**
 * A provider name for the data-source list, with no credential in it.
 *
 * A custom URL keeps its host and drops the path, because a provider key
 * usually sits in the path or in the query.
 */
export function rpcProviderLabel(chain: ChainConfig, settings: Settings = processSettings): string {
  const custom = findCustomRpcUrl(chain, settings);
  if (!custom) return `Alchemy ${chain.alchemyHost}`;
  try {
    return `RPC ${new URL(custom).host}`;
  } catch {
    return "RPC custom endpoint";
  }
}

/**
 * Every string that MUST NOT leave this process.
 *
 * A failed `fetch` puts the endpoint URL in its message, and that message
 * reaches the browser and the log. The Alchemy key is one such string. A
 * custom URL carries its credential in the path or the query, so the whole
 * URL, each long path segment, each long query value and the userinfo
 * password join the list.
 */
export function rpcSecrets(settings: Settings = processSettings): string[] {
  const secrets = new Set<string>();
  const key = findAlchemyKey(settings);
  if (key) secrets.add(key);
  for (const name of settings.names()) {
    if (name !== "RPC_URL" && !name.startsWith("RPC_URL_")) continue;
    const url = settings.get(name);
    if (!url) continue;
    secrets.add(url);
    try {
      const parsed = new URL(url);
      for (const segment of parsed.pathname.split("/")) {
        if (segment.length >= 8) secrets.add(segment);
      }
      for (const value of parsed.searchParams.values()) {
        if (value.length >= 8) secrets.add(value);
      }
      if (parsed.password) secrets.add(parsed.password);
    } catch {
      /* Not a parseable URL. The whole value is already on the list. */
    }
  }
  /* Longest first, so a nested value never leaves a fragment of a longer one. */
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Signature databases used when an ABI does not explain a selector. */
export const SIGNATURE_SOURCES = {
  openchain: "https://api.openchain.xyz/signature-database/v1/lookup",
  fourByte: "https://www.4byte.directory/api/v1/signatures/",
} as const;

export const PORT = Number(process.env.PORT ?? 8787);
