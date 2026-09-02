/**
 * Live probe for chain support.
 *
 * This script decides, per candidate chain, whether the pipeline can serve
 * it. It answers four questions with a real network call, not a document:
 *
 *   1. Does the configured endpoint reach this chain at all?
 *   2. How long is a real block, measured from two blocks 1000 apart?
 *   3. Does `trace_filter` answer over a small range?
 *   4. Does `debug_traceTransaction` with `callTracer` answer on a real tx?
 *
 * It also resolves a working Blockscout v2 host through the public
 * `chains.blockscout.com` registry, and checks whether Sourcify serves the
 * chain id. Run it with `bun run scripts/probe-chains.ts`. It prints a
 * table and writes the same table to `local://chain-probe.md`.
 *
 * The probe uses the same endpoint resolution as the application, so a
 * `RPC_URL` or `RPC_URL_<CHAIN>` value is probed instead of Alchemy. The
 * answers describe the provider you configured, and a different provider
 * MUST be probed again, because the trace support differs.
 *
 * The probe runs one chain at a time with a pause between chains, so the
 * endpoint does not trip a rate limit while every other user of the same
 * credential is still working.
 */

import { alchemyKey, findCustomRpcUrl, hasRpcEndpoint, MISSING_ENDPOINT_MESSAGE } from "../src/config";

/* The probe spends real requests, so it needs the operator's own endpoint. */
if (!hasRpcEndpoint()) {
  console.error(MISSING_ENDPOINT_MESSAGE);
  process.exit(1);
}

interface Candidate {
  key: string;
  label: string;
  alchemyHost: string;
  id: number;
  nativeSymbol: string;
}

/** Every mainnet worth asking about. Alchemy slugs come from the vendor's own chain list. */
const CANDIDATES: Candidate[] = [
  { key: "ethereum", label: "Ethereum", alchemyHost: "eth-mainnet", id: 1, nativeSymbol: "ETH" },
  { key: "base", label: "Base", alchemyHost: "base-mainnet", id: 8453, nativeSymbol: "ETH" },
  { key: "optimism", label: "Optimism", alchemyHost: "opt-mainnet", id: 10, nativeSymbol: "ETH" },
  { key: "arbitrum", label: "Arbitrum One", alchemyHost: "arb-mainnet", id: 42161, nativeSymbol: "ETH" },
  { key: "arbitrum-nova", label: "Arbitrum Nova", alchemyHost: "arbnova-mainnet", id: 42170, nativeSymbol: "ETH" },
  { key: "polygon", label: "Polygon", alchemyHost: "polygon-mainnet", id: 137, nativeSymbol: "POL" },
  { key: "polygon-zkevm", label: "Polygon zkEVM", alchemyHost: "polygonzkevm-mainnet", id: 1101, nativeSymbol: "ETH" },
  { key: "avalanche", label: "Avalanche C-Chain", alchemyHost: "avax-mainnet", id: 43114, nativeSymbol: "AVAX" },
  { key: "bnb", label: "BNB Smart Chain", alchemyHost: "bnb-mainnet", id: 56, nativeSymbol: "BNB" },
  { key: "opbnb", label: "opBNB", alchemyHost: "opbnb-mainnet", id: 204, nativeSymbol: "BNB" },
  { key: "gnosis", label: "Gnosis", alchemyHost: "gnosis-mainnet", id: 100, nativeSymbol: "xDAI" },
  { key: "celo", label: "Celo", alchemyHost: "celo-mainnet", id: 42220, nativeSymbol: "CELO" },
  { key: "linea", label: "Linea", alchemyHost: "linea-mainnet", id: 59144, nativeSymbol: "ETH" },
  { key: "scroll", label: "Scroll", alchemyHost: "scroll-mainnet", id: 534352, nativeSymbol: "ETH" },
  { key: "zksync", label: "ZKsync Era", alchemyHost: "zksync-mainnet", id: 324, nativeSymbol: "ETH" },
  { key: "blast", label: "Blast", alchemyHost: "blast-mainnet", id: 81457, nativeSymbol: "ETH" },
  { key: "mantle", label: "Mantle", alchemyHost: "mantle-mainnet", id: 5000, nativeSymbol: "MNT" },
  { key: "zora", label: "Zora", alchemyHost: "zora-mainnet", id: 7777777, nativeSymbol: "ETH" },
  { key: "sonic", label: "Sonic", alchemyHost: "sonic-mainnet", id: 146, nativeSymbol: "S" },
  { key: "unichain", label: "Unichain", alchemyHost: "unichain-mainnet", id: 130, nativeSymbol: "ETH" },
  { key: "ink", label: "Ink", alchemyHost: "ink-mainnet", id: 57073, nativeSymbol: "ETH" },
  { key: "berachain", label: "Berachain", alchemyHost: "berachain-mainnet", id: 80094, nativeSymbol: "BERA" },
  { key: "worldchain", label: "World Chain", alchemyHost: "worldchain-mainnet", id: 480, nativeSymbol: "ETH" },
  { key: "soneium", label: "Soneium", alchemyHost: "soneium-mainnet", id: 1868, nativeSymbol: "ETH" },
  { key: "apechain", label: "ApeChain", alchemyHost: "apechain-mainnet", id: 33139, nativeSymbol: "APE" },
  { key: "fraxtal", label: "Fraxtal", alchemyHost: "frax-mainnet", id: 252, nativeSymbol: "frxETH" },
  { key: "abstract", label: "Abstract", alchemyHost: "abstract-mainnet", id: 2741, nativeSymbol: "ETH" },
  { key: "ronin", label: "Ronin", alchemyHost: "ronin-mainnet", id: 2020, nativeSymbol: "RON" },
  { key: "degen", label: "Degen", alchemyHost: "degen-mainnet", id: 666666666, nativeSymbol: "DEGEN" },
];

interface ProbeResult {
  candidate: Candidate;
  rpcOk: boolean;
  rpcNote?: string;
  blockTimeSec?: number;
  traceFilter: "ok" | string;
  debugTracer: "ok" | string;
  blockscoutHost?: string;
  blockscoutNote?: string;
  sourcify: boolean;
}

const TIMEOUT_MS = 8_000;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: T | undefined;
    try {
      body = (await res.json()) as T;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

interface RpcAnswer {
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; errorText?: string }> {
  try {
    const { status, body } = await fetchJson<RpcAnswer>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!body) return { errorText: `HTTP ${status} with no JSON body` };
    if (body.error) return { errorText: `${body.error.message} (code ${body.error.code})` };
    return { result: body.result };
  } catch (err) {
    return { errorText: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

interface BlockHeader {
  number: string;
  timestamp: string;
}

interface FullBlock extends BlockHeader {
  transactions: { hash: string; to: string | null; input: string }[];
}

/** Resolves the Blockscout host list once, keyed by chain id. */
async function loadBlockscoutRegistry(): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  try {
    const { body } = await fetchJson<Record<string, { explorers?: { url: string; hostedBy: string }[] }>>(
      "https://chains.blockscout.com/api/chains",
    );
    if (!body) return map;
    for (const [idText, entry] of Object.entries(body)) {
      const explorers = entry.explorers ?? [];
      const urls = explorers
        .sort((a, b) => (a.hostedBy === "blockscout" ? -1 : 1) - (b.hostedBy === "blockscout" ? -1 : 1))
        .map((e) => e.url.replace(/\/+$/, ""));
      if (urls.length > 0) map.set(Number(idText), urls);
    }
  } catch (err) {
    console.error(`Blockscout registry fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return map;
}

/** Resolves the set of chain ids Sourcify serves once. */
async function loadSourcifyChains(): Promise<Set<number>> {
  const set = new Set<number>();
  try {
    const { body } = await fetchJson<{ chainId: number; supported: boolean }[]>("https://sourcify.dev/server/chains");
    if (!body) return set;
    for (const entry of body) if (entry.supported) set.add(entry.chainId);
  } catch (err) {
    console.error(`Sourcify chains fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return set;
}

/** Tries every candidate host in order, returns the first that answers the v2 contract endpoint. */
async function probeBlockscoutHost(
  hosts: string[],
  probeAddress: string,
): Promise<{ host?: string; note?: string }> {
  for (const host of hosts) {
    try {
      const contractCheck = await fetchJson(`${host}/api/v2/smart-contracts/${probeAddress}`);
      // 200 (verified) and 404 (unverified or unknown) both prove the host speaks v2.
      // A 5xx, a connection failure, or a non-JSON body means this host does not count.
      if (contractCheck.status !== 200 && contractCheck.status !== 404) continue;
      if (contractCheck.body === undefined && contractCheck.status !== 404) continue;
      const internalCheck = await fetchJson(`${host}/api/v2/addresses/${probeAddress}/internal-transactions?filter=to`);
      if (internalCheck.status >= 500) continue;
      return { host };
    } catch (err) {
      continue;
    }
  }
  return { note: hosts.length === 0 ? "no Blockscout instance listed for this chain id" : "every listed host failed the v2 probe" };
}

async function probeChain(
  candidate: Candidate,
  blockscoutRegistry: Map<number, string[]>,
  sourcifyChains: Set<number>,
): Promise<ProbeResult> {
  const url = findCustomRpcUrl(candidate) ?? `https://${candidate.alchemyHost}.g.alchemy.com/v2/${alchemyKey()}`;

  const headNow = await rpcCall(url, "eth_blockNumber", []);
  if (headNow.errorText || typeof headNow.result !== "string") {
    return {
      candidate,
      rpcOk: false,
      rpcNote: headNow.errorText ?? "eth_blockNumber returned no block number",
      traceFilter: "not attempted, RPC unreachable",
      debugTracer: "not attempted, RPC unreachable",
      sourcify: sourcifyChains.has(candidate.id),
      blockscoutNote: "not attempted, RPC unreachable",
    };
  }

  const headBlock = Number.parseInt(headNow.result, 16);
  const oldBlock = Math.max(headBlock - 1000, 0);

  const [headerNew, headerOld] = await Promise.all([
    rpcCall(url, "eth_getBlockByNumber", [`0x${headBlock.toString(16)}`, false]),
    rpcCall(url, "eth_getBlockByNumber", [`0x${oldBlock.toString(16)}`, false]),
  ]);

  let blockTimeSec: number | undefined;
  const newHeader = headerNew.result as BlockHeader | null;
  const oldHeader = headerOld.result as BlockHeader | null;
  if (newHeader?.timestamp && oldHeader?.timestamp) {
    const tsNew = Number.parseInt(newHeader.timestamp, 16);
    const tsOld = Number.parseInt(oldHeader.timestamp, 16);
    const blockSpan = headBlock - oldBlock;
    if (blockSpan > 0 && tsNew > tsOld) blockTimeSec = Math.round(((tsNew - tsOld) / blockSpan) * 100) / 100;
  }

  // Pick a real, recent contract call to trace and to probe Blockscout with.
  // Scan back a handful of blocks: a thin block can hold no contract calls at all.
  let sampleTx: FullBlock["transactions"][number] | undefined;
  for (let back = 3; back <= 12 && !sampleTx; back += 3) {
    const blockAnswer = await rpcCall(url, "eth_getBlockByNumber", [`0x${Math.max(headBlock - back, 0).toString(16)}`, true]);
    const block = blockAnswer.result as FullBlock | null;
    sampleTx = block?.transactions.find((tx) => tx.to && tx.input && tx.input.length > 2);
  }

  const traceRange = {
    fromBlock: `0x${Math.max(headBlock - 5, 0).toString(16)}`,
    toBlock: `0x${headBlock.toString(16)}`,
    count: 5,
  };
  const traceFilterAnswer = await rpcCall(url, "trace_filter", [traceRange]);
  const traceFilter: string = traceFilterAnswer.errorText ?? (Array.isArray(traceFilterAnswer.result) ? "ok" : "empty result, treated as unsupported");

  let debugTracer = "no recent contract call found to trace";
  if (sampleTx) {
    const debugAnswer = await rpcCall(url, "debug_traceTransaction", [sampleTx.hash, { tracer: "callTracer" }]);
    debugTracer = debugAnswer.errorText ?? (debugAnswer.result ? "ok" : "empty result, treated as unsupported");
  }

  const probeAddress = sampleTx?.to ?? "0x0000000000000000000000000000000000000000";
  const hosts = blockscoutRegistry.get(candidate.id) ?? [];
  const blockscout = await probeBlockscoutHost(hosts, probeAddress);

  return {
    candidate,
    rpcOk: true,
    blockTimeSec,
    traceFilter,
    debugTracer,
    blockscoutHost: blockscout.host,
    blockscoutNote: blockscout.note,
    sourcify: sourcifyChains.has(candidate.id),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function renderTable(results: ProbeResult[]): string {
  const header = ["chain", "id", "block sec", "trace_filter", "debug_traceTransaction", "blockscout", "sourcify"];
  const widths = [16, 10, 10, 42, 42, 34, 8];
  const lines: string[] = [];
  lines.push(header.map((h, i) => pad(h, widths[i]!)).join(" | "));
  lines.push(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const r of results) {
    const row = [
      r.candidate.key,
      String(r.candidate.id),
      r.blockTimeSec !== undefined ? String(r.blockTimeSec) : "n/a",
      r.traceFilter,
      r.debugTracer,
      r.blockscoutHost ?? `none (${r.blockscoutNote ?? "unresolved"})`,
      r.sourcify ? "yes" : "no",
    ];
    lines.push(row.map((cell, i) => pad(cell, widths[i]!)).join(" | "));
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [blockscoutRegistry, sourcifyChains] = await Promise.all([loadBlockscoutRegistry(), loadSourcifyChains()]);

  const results: ProbeResult[] = [];
  for (const candidate of CANDIDATES) {
    console.error(`probing ${candidate.key} ...`);
    try {
      const result = await probeChain(candidate, blockscoutRegistry, sourcifyChains);
      results.push(result);
    } catch (err) {
      results.push({
        candidate,
        rpcOk: false,
        rpcNote: err instanceof Error ? err.message : String(err),
        traceFilter: "not attempted, probe threw",
        debugTracer: "not attempted, probe threw",
        sourcify: sourcifyChains.has(candidate.id),
      });
    }
    // Pace the probe: one chain at a time, with a pause, so the shared key is not throttled.
    await sleep(1_200);
  }

  const table = renderTable(results);
  console.log(table);

  const decided = results.map((r) => {
    const included = r.traceFilter === "ok" || (r.debugTracer === "ok" && Boolean(r.blockscoutHost));
    return { key: r.candidate.key, included };
  });
  const includedKeys = decided.filter((d) => d.included).map((d) => d.key);
  const excludedKeys = decided.filter((d) => !d.included).map((d) => d.key);
  console.log("");
  console.log(`included (${includedKeys.length}): ${includedKeys.join(", ")}`);
  console.log(`excluded (${excludedKeys.length}): ${excludedKeys.join(", ")}`);

  console.log("");
  console.log("Full report written by the caller to local://chain-probe.md.");
}

await main();
