/**
 * Source recovery for unverified contracts.
 *
 * Blockscout marks a contract unverified only when nobody submitted its exact
 * source to that instance. The runtime code often exists, verified, in one of
 * three other places:
 *
 *   1. A bytecode twin that Blockscout already found and named in
 *      `verified_twin_address_hash`. The caller resolves the twin; this
 *      module only fetches its metadata.
 *   2. Blockscout's own eth-bytecode-db search, `POST
 *      /api/v2/bytecodes/sources:search-all`. A live probe against
 *      `eth.blockscout.com` and `base.blockscout.com` on 2026-09-02 found
 *      this route unregistered on both hosted instances: every request,
 *      valid or not, falls through to the legacy v1 handler and answers
 *      `Params 'module' and 'action' are required parameters`. This module
 *      still calls the documented route, so a self-hosted instance that
 *      does register it benefits, and it recognises that exact fallback
 *      message to skip retries and fail fast instead of burning the
 *      timeout budget on a route that is known dead.
 *   3. The Sourcify repository, queried through its v2 API. The legacy
 *      `repo.sourcify.dev/contracts/{full_match|partial_match}/...` file
 *      paths this task was specified against now redirect to a route that
 *      answers 404 for every address tried, full and partial match alike
 *      (confirmed live on 2026-09-02). Sourcify's v2 API
 *      (`sourcify.dev/server/v2/contract/{chainId}/{address}`) replaced
 *      that filesystem layout: one address has at most one stored match, at
 *      `exact_match` (full) or `match` (partial) level, so one request
 *      covers what used to be two directory probes.
 *   4. The same Sourcify lookup run again against the twin address, when
 *      step 1 or step 3 found nothing for the target itself.
 *
 * A recovered ABI is trusted only after it explains most of the target's
 * own dispatcher: `bytecodeSelectors` reads the target's real runtime code
 * over RPC, and a candidate is accepted only when at least two thirds of
 * those selectors appear in the candidate's ABI. This guards against a
 * same-named, differently-coded contract passing as a match. Every network
 * call carries a timeout and every failure becomes a warning; this module
 * never throws.
 */

import { bytecodeSelectors, parseAbi, selectorOf, signatureOf } from "./abi";
import { keccak256 } from "./keccak";
import { fetchContractMetadata } from "./blockscout";
import { shortenAddress } from "./labels";
import { RpcClient } from "./rpc";
import type { AbiEntry, ChainConfig, SourceFile } from "./types";

export interface RecoveredSource {
  sources: SourceFile[];
  abi: AbiEntry[];
  name?: string;
  compiler?: string;
  language?: string;
  /** Plain sentence naming the origin address or repository. */
  provenance: string;
  warnings: string[];
}

const FETCH_TIMEOUT_MS = 15_000;
/** A candidate counts as trustworthy only at or above this share of matched dispatcher selectors. */
const SELECTOR_MATCH_THRESHOLD = 2 / 3;
/** The generic error every unmatched Blockscout v2 POST route answers with. */
const BLOCKSCOUT_UNROUTED_POST = "Params 'module' and 'action' are required parameters";

/** One candidate an origin can hand back before selector verification. */
interface Candidate {
  sources: SourceFile[];
  abi: AbiEntry[];
  name?: string;
  compiler?: string;
  language?: string;
  provenance: string;
}

/** Fetches JSON with a timeout and one retry on a transient failure. Never throws. */
async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  let lastReason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
        if (text.includes(BLOCKSCOUT_UNROUTED_POST)) return { ok: false, reason: "route is not registered on this instance" };
        if (response.status >= 500 && attempt === 1) continue;
        return { ok: false, reason: lastReason };
      }
      try {
        return { ok: true, data: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, reason: "non-JSON response" };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      if (attempt === 1) continue;
    }
  }
  return { ok: false, reason: lastReason || "unknown error" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * EIP-55 mixed-case checksum of a plain hex address. Sourcify's repository
 * layout treats the checksummed address as the canonical file path, and the
 * v2 API accepts it too, so every Sourcify request goes through this.
 */
export function toChecksumAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return address;
  const hashHex = keccak256(hex).slice(2);
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i]!;
    out += /[0-9]/.test(c) ? c : (parseInt(hashHex[i]!, 16) >= 8 ? c.toUpperCase() : c);
  }
  return out;
}

/**
 * Share of the target's own dispatcher selectors that a candidate ABI
 * explains. `undefined` when the target's runtime code offers no dispatcher
 * to check against, for example a minimal proxy that only forwards calls:
 * the heuristic has nothing to verify, so the caller must reject rather than
 * guess.
 */
function selectorMatchRatio(abi: AbiEntry[], dispatcherSelectors: string[]): number | undefined {
  if (dispatcherSelectors.length === 0) return undefined;
  const abiSelectors = new Set<string>();
  for (const entry of abi) {
    if (entry.type !== "function") continue;
    abiSelectors.add(selectorOf(signatureOf(entry)));
  }
  const matched = dispatcherSelectors.filter((s) => abiSelectors.has(s)).length;
  return matched / dispatcherSelectors.length;
}

/** Step 1: the bytecode twin Blockscout already resolved. */
async function twinCandidate(chain: ChainConfig, twinAddress: string, warnings: string[]): Promise<Candidate | undefined> {
  const metadata = await fetchContractMetadata(chain, twinAddress);
  if (!metadata.verified || (metadata.sources.length === 0 && metadata.abi.length === 0)) {
    warnings.push(`Blockscout named a verified twin at ${twinAddress}, but its own metadata carries no usable source or ABI.`);
    return undefined;
  }
  return {
    sources: metadata.sources,
    abi: metadata.abi,
    name: metadata.name,
    compiler: metadata.compiler,
    language: metadata.language,
    provenance: `Source from the verified bytecode twin at ${shortenAddress(twinAddress)}, which shares this runtime code.`,
  };
}

/** A best-effort attempt at Blockscout's own bytecode source search. */
function bytecodeMatchLevelFrom(raw: Record<string, unknown>): "exact_match" | "match" | undefined {
  const level = asString(raw.matchType) ?? asString(raw.match_type) ?? asString(raw.match);
  if (level === "PARTIAL" || level === "partial" || level === "match") return "match";
  if (level === "FULL" || level === "PERFECT" || level === "full" || level === "exact_match") return "exact_match";
  return undefined;
}

function sourceFilesFrom(raw: Record<string, unknown>): SourceFile[] {
  const list = raw.sourceFiles ?? raw.source_files ?? raw.files;
  const out: SourceFile[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const rec = asRecord(entry);
      const path = rec ? asString(rec.fileName) ?? asString(rec.file_name) ?? asString(rec.path) : undefined;
      const content = rec ? asString(rec.fileContent) ?? asString(rec.file_content) ?? asString(rec.content) : undefined;
      if (path && content) out.push({ path, content });
    }
  } else {
    const rec = asRecord(list);
    if (rec) {
      for (const [path, value] of Object.entries(rec)) {
        const content = typeof value === "string" ? value : asString(asRecord(value)?.content);
        if (content) out.push({ path, content });
      }
    }
  }
  return out;
}

/**
 * Step 2: Blockscout's eth-bytecode-db search. See the module comment for
 * the live-probe result: this route answered nowhere it was tried, so this
 * function degrades to a warning on every hosted instance today. It stays
 * implemented against the documented request shape for a self-hosted
 * instance that does register it.
 */
async function bytecodeSearchCandidate(
  chain: ChainConfig,
  runtimeCode: string,
  warnings: string[],
): Promise<Candidate | undefined> {
  if (!chain.blockscout) return undefined;
  const url = `${chain.blockscout}/api/v2/bytecodes/sources:search-all`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bytecode: runtimeCode, bytecodeType: "DEPLOYED_BYTECODE" }),
  });
  if (!result.ok) {
    warnings.push(`Blockscout bytecode search on ${chain.label} did not answer: ${result.reason}.`);
    return undefined;
  }
  const raw = asRecord(result.data);
  const matches = raw ? (raw.sources ?? raw.matches ?? raw.results) : undefined;
  const first = Array.isArray(matches) ? asRecord(matches[0]) : asRecord(matches);
  if (!first) {
    warnings.push(`Blockscout bytecode search on ${chain.label} returned no candidate source.`);
    return undefined;
  }
  const sources = sourceFilesFrom(first);
  const abi = parseAbi(first.abi);
  if (sources.length === 0 && abi.length === 0) {
    warnings.push(`Blockscout bytecode search on ${chain.label} returned a match with no usable source or ABI.`);
    return undefined;
  }
  const level = bytecodeMatchLevelFrom(first) === "match" ? "partial match" : "full match";
  return {
    sources,
    abi,
    name: asString(first.contractName) ?? asString(first.contract_name),
    compiler: asString(first.compilerVersion) ?? asString(first.compiler_version),
    language: asString(first.language),
    provenance: `Source from Blockscout's bytecode search on ${chain.label}, ${level}.`,
  };
}

interface SourcifyContract {
  abi: unknown;
  sources: Record<string, { content?: string } | string> | undefined;
  compilation: { name?: string; compilerVersion?: string; language?: string } | undefined;
  runtimeMatch: string | null | undefined;
}

/** One Sourcify v2 lookup. `undefined` on any failure, including a genuine 404. */
async function sourcifyLookup(chain: ChainConfig, address: string, warnings: string[]): Promise<SourcifyContract | undefined> {
  if (!chain.sourcify) return undefined;
  const checksummed = toChecksumAddress(address);
  const url = `https://sourcify.dev/server/v2/contract/${chain.id}/${checksummed}?fields=abi,sources,compilation,runtimeMatch`;
  const result = await fetchJson(url);
  if (!result.ok) {
    warnings.push(`Sourcify lookup for ${shortenAddress(address)} on chain ${chain.id} failed: ${result.reason}.`);
    return undefined;
  }
  const raw = asRecord(result.data);
  if (!raw || !raw.runtimeMatch) return undefined; // no stored match; not a failure worth a warning
  return raw as unknown as SourcifyContract;
}

/** Builds a candidate from a resolved Sourcify contract, for the target address or its twin. */
function sourcifyCandidate(chain: ChainConfig, contract: SourcifyContract, viaAddress?: string): Candidate | undefined {
  const sourcesRaw = contract.sources ?? {};
  const sources: SourceFile[] = [];
  for (const [path, value] of Object.entries(sourcesRaw)) {
    const content = typeof value === "string" ? value : value?.content;
    if (content) sources.push({ path, content });
  }
  const abi = parseAbi(contract.abi);
  if (sources.length === 0 && abi.length === 0) return undefined;
  const level = contract.runtimeMatch === "exact_match" ? "full match" : "partial match";
  const levelNote = level === "partial match" ? " The metadata hash differs from the recompiled bytecode." : "";
  const via = viaAddress ? `, recovered through the bytecode twin at ${shortenAddress(viaAddress)}` : "";
  return {
    sources,
    abi,
    name: contract.compilation?.name,
    compiler: contract.compilation?.compilerVersion,
    language: contract.compilation?.language,
    provenance: `Source from the Sourcify repository, ${level}, chain ${chain.id}${via}.${levelNote}`,
  };
}

/**
 * Recovers verified sources for an unverified address from a bytecode twin,
 * Blockscout's bytecode search, or the Sourcify repository, in that order.
 * A recovery is returned only once its ABI explains at least two thirds of
 * the target's own dispatcher selectors.
 */
export async function recoverSources(chain: ChainConfig, address: string, twinAddress?: string): Promise<RecoveredSource | undefined> {
  const warnings: string[] = [];

  let runtimeCode: string;
  let dispatcherSelectors: string[];
  try {
    runtimeCode = await new RpcClient(chain).getCode(address);
    dispatcherSelectors = bytecodeSelectors(runtimeCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not read the runtime code of ${address} to verify a recovered source: ${message}.`);
    return undefined;
  }
  if (dispatcherSelectors.length === 0) {
    warnings.push(`The runtime code of ${address} has no detectable dispatcher selectors, so a recovered source cannot be verified against it.`);
    return undefined;
  }

  const candidates: (() => Promise<Candidate | undefined>)[] = [];
  if (twinAddress) candidates.push(() => twinCandidate(chain, twinAddress, warnings));
  candidates.push(() => bytecodeSearchCandidate(chain, runtimeCode, warnings));
  candidates.push(async () => {
    const contract = await sourcifyLookup(chain, address, warnings);
    return contract ? sourcifyCandidate(chain, contract) : undefined;
  });
  if (twinAddress) {
    candidates.push(async () => {
      const contract = await sourcifyLookup(chain, twinAddress, warnings);
      return contract ? sourcifyCandidate(chain, contract, twinAddress) : undefined;
    });
  }

  for (const fetchCandidate of candidates) {
    const candidate = await fetchCandidate();
    if (!candidate) continue;
    const ratio = selectorMatchRatio(candidate.abi, dispatcherSelectors);
    if (ratio === undefined || ratio < SELECTOR_MATCH_THRESHOLD) {
      warnings.push(
        `Rejected a candidate source (${candidate.provenance}): it explains only ${ratio === undefined ? "an unmeasurable share" : `${Math.round(ratio * 100)}%`} of ${dispatcherSelectors.length} dispatcher selectors, below the two-thirds threshold.`,
      );
      continue;
    }
    return {
      sources: candidate.sources,
      abi: candidate.abi,
      name: candidate.name,
      compiler: candidate.compiler,
      language: candidate.language,
      provenance: candidate.provenance,
      warnings,
    };
  }

  warnings.push(`No verified source could be recovered for ${address} from a bytecode twin, Blockscout's bytecode search, or Sourcify.`);
  return undefined;
}
