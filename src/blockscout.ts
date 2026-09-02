/**
 * Blockscout v2 client.
 *
 * Blockscout supplies verified source, ABI, and proxy metadata for the
 * target and every counterparty address. It never invents data: a chain
 * with no Blockscout instance, or a request that fails or times out,
 * degrades to an unverified result with a warning. It never throws.
 */

import { parseAbi } from "./abi";
import type { AbiEntry, ChainConfig, SourceFile, TokenInfo } from "./types";

export interface ContractMetadata {
  address: string;
  verified: boolean;
  name?: string;
  compiler?: string;
  language?: string;
  abi: AbiEntry[];
  sources: SourceFile[];
  proxyType?: string;
  implementations: { address: string; name?: string }[];
  conflicting: string[];
  /** A verified contract with the same runtime code, when the explorer knows one. */
  twin?: string;
  token?: TokenInfo;
  isContract: boolean;
  provenance: string[];
  warnings: string[];
}

export interface CandidateTx {
  hash: string;
  blockNumber: number;
  timestamp?: number;
  direction: "in" | "out";
}

const FETCH_TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
/**
 * Pause before each retry, in milliseconds.
 *
 * Blockscout answers HTTP 429 under repeated load, and it needs real time,
 * not an immediate retry. A refusal here costs the whole source view of the
 * analysis, so the wait is worth more than the speed.
 */
const RETRY_PAUSE_MS = [0, 1_500, 4_000];

/** Fetches JSON with a timeout and paced retries. Never throws. */
async function fetchJson(url: string): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  let lastReason = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const pause = RETRY_PAUSE_MS[attempt - 1] ?? 0;
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
        /* 429 means "too fast", and 5xx means "not now". Both can pass. */
        if ((response.status === 429 || response.status >= 500) && attempt < ATTEMPTS) continue;
        return { ok: false, reason: lastReason };
      }
      const text = await response.text();
      try {
        return { ok: true, data: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, reason: "non-JSON response" };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      if (attempt === ATTEMPTS) break;
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

function sourcesFromSmartContract(raw: Record<string, unknown>): SourceFile[] {
  const sources: SourceFile[] = [];
  const mainCode = asString(raw.source_code);
  if (mainCode) {
    const filePath = asString(raw.file_path) ?? `${asString(raw.name) ?? "Contract"}.sol`;
    sources.push({ path: filePath, content: mainCode });
  }
  const additional = raw.additional_sources;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const content = asString(rec.source_code);
      const path = asString(rec.file_path);
      if (content && path) sources.push({ path, content });
    }
  }
  return sources;
}

function implementationsFromSmartContract(raw: Record<string, unknown>): { address: string; name?: string }[] {
  const list = raw.implementations;
  if (!Array.isArray(list)) return [];
  const out: { address: string; name?: string }[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    const address = rec ? asString(rec.address_hash) ?? asString(rec.address) : undefined;
    if (!address) continue;
    out.push({ address, name: rec ? asString(rec.name) : undefined });
  }
  return out;
}

function conflictingFromSmartContract(raw: Record<string, unknown>): string[] {
  const list = raw.conflicting_implementations;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    const rec = asRecord(entry);
    const address = rec ? asString(rec.address_hash) ?? asString(rec.address) : undefined;
    if (address) out.push(address);
  }
  return out;
}

function tokenFromAddress(raw: Record<string, unknown>): TokenInfo | undefined {
  const token = asRecord(raw.token);
  if (!token) return undefined;
  const name = asString(token.name);
  const symbol = asString(token.symbol);
  /* A record with neither a name nor a symbol says nothing. It appears on
   * addresses that are not tokens, and printing it invents a token. */
  if (!name && !symbol) return undefined;
  const decimalsRaw = token.decimals;
  const decimals = typeof decimalsRaw === "string" ? Number(decimalsRaw) : typeof decimalsRaw === "number" ? decimalsRaw : undefined;
  return {
    name,
    symbol,
    decimals: decimals !== undefined && Number.isFinite(decimals) ? decimals : undefined,
  };
}

/**
 * Pure mapping from the two Blockscout payloads to `ContractMetadata`.
 * Exported so tests can cover the mapping without a network call.
 */
export function buildContractMetadata(
  address: string,
  smartContractRaw: unknown,
  addressRaw: unknown,
  provenance: string[],
  warnings: string[],
): ContractMetadata {
  const sc = asRecord(smartContractRaw);
  const addr = asRecord(addressRaw);

  const abi = sc ? parseAbi(sc.abi) : [];
  const verified = sc ? sc.is_verified === true : false;

  return {
    address,
    verified,
    name: (sc ? asString(sc.name) : undefined) ?? (addr ? asString(addr.name) : undefined),
    compiler: sc ? asString(sc.compiler_version) : undefined,
    language: sc ? asString(sc.language) : undefined,
    abi,
    sources: sc ? sourcesFromSmartContract(sc) : [],
    proxyType: sc ? asString(sc.proxy_type) : undefined,
    implementations: sc ? implementationsFromSmartContract(sc) : [],
    conflicting: sc ? conflictingFromSmartContract(sc) : [],
    twin: sc ? twinFromSmartContract(sc, address) : undefined,
    token: addr ? tokenFromAddress(addr) : undefined,
    isContract: addr ? addr.is_contract === true : sc !== undefined,
    provenance,
    warnings,
  };
}

/**
 * The address of a verified contract with the same runtime code.
 *
 * The explorer reports it for an unverified address whose code matches a
 * verified one. It is a lead, not a promise: `src/sourcerecovery.ts` accepts
 * it only after the dispatcher selectors of this address appear in that ABI.
 */
function twinFromSmartContract(sc: Record<string, unknown>, address: string): string | undefined {
  const raw = asString(sc.verified_twin_address_hash)?.toLowerCase();
  if (!raw || !/^0x[0-9a-f]{40}$/.test(raw) || raw === address.toLowerCase()) return undefined;
  return raw;
}

function emptyMetadata(address: string, warnings: string[]): ContractMetadata {
  return {
    address,
    verified: false,
    abi: [],
    sources: [],
    implementations: [],
    conflicting: [],
    isContract: false,
    provenance: [],
    warnings,
  };
}

/** Fetches verified metadata for one address. Never throws; degrades to warnings. */
export async function fetchContractMetadata(chain: ChainConfig, address: string): Promise<ContractMetadata> {
  if (!chain.blockscout) {
    return emptyMetadata(address, [`${chain.label} has no configured Blockscout instance.`]);
  }
  const scUrl = `${chain.blockscout}/api/v2/smart-contracts/${address}`;
  const addrUrl = `${chain.blockscout}/api/v2/addresses/${address}`;
  const [scResult, addrResult] = await Promise.all([fetchJson(scUrl), fetchJson(addrUrl)]);

  const provenance: string[] = [];
  const warnings: string[] = [];
  if (scResult.ok) {
    provenance.push(scUrl);
  } else {
    warnings.push(`Blockscout smart-contracts lookup failed for ${address}: ${scResult.reason}.`);
  }
  if (addrResult.ok) {
    provenance.push(addrUrl);
  } else {
    warnings.push(`Blockscout address lookup failed for ${address}: ${addrResult.reason}.`);
  }

  return buildContractMetadata(
    address,
    scResult.ok ? scResult.data : undefined,
    addrResult.ok ? addrResult.data : undefined,
    provenance,
    warnings,
  );
}

/**
 * One request that answers everything a label needs.
 *
 * A counterparty roll-up asks about tens of addresses, and the
 * `smart-contracts` endpoint costs a second request per address. The explorer
 * refuses with HTTP 429 long before that finishes, and a refusal costs the
 * whole source view. This endpoint carries the name, the token, the contract
 * flag, the verified flag, and the proxy, so labels never pay for the heavy
 * call. `src/labels.ts` fetches an ABI only where a name is still missing.
 */
export interface AddressSummary {
  address: string;
  name?: string;
  token?: TokenInfo;
  isContract: boolean;
  isVerified: boolean;
  ens?: string;
  proxyType?: string;
  isScam: boolean;
}

export async function fetchAddressSummary(chain: ChainConfig, address: string): Promise<AddressSummary | undefined> {
  if (!chain.blockscout) return undefined;
  const result = await fetchJson(`${chain.blockscout}/api/v2/addresses/${address}`);
  if (!result.ok) return undefined;
  const record = asRecord(result.data);
  if (!record) return undefined;
  return {
    address,
    name: asString(record.name),
    token: tokenFromAddress(record),
    isContract: record.is_contract === true,
    isVerified: record.is_verified === true,
    ens: asString(record.ens_domain_name),
    proxyType: asString(record.proxy_type),
    isScam: record.is_scam === true,
  };
}

function pageParams(next: unknown): Record<string, string> | undefined {
  const rec = asRecord(next);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function queryString(params: Record<string, string> | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams(params);
  return `&${search.toString()}`;
}

function timestampOf(raw: unknown): number | undefined {
  const text = asString(raw);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}


/**
 * The block of one candidate, from any field the endpoint uses.
 *
 * The internal-transactions endpoint answers `block_number`, and the
 * transactions endpoint has used `block` and string numbers across versions.
 * An unknown block returns `undefined`, never zero.
 */
function blockNumberOf(item: Record<string, unknown>): number | undefined {
  for (const value of [item.block_number, item.block, item.blockNumber]) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return undefined;
}

/** Pulls candidate transaction hashes from one paginated Blockscout endpoint. Never throws. */
async function pullCandidates(
  baseUrl: string,
  direction: (item: Record<string, unknown>) => "in" | "out",
  hashOf: (item: Record<string, unknown>) => string | undefined,
  limit: number,
  seen: Set<string>,
  out: CandidateTx[],
): Promise<void> {
  let params: Record<string, string> | undefined;
  for (let page = 0; page < 10 && out.length < limit; page++) {
    const url = `${baseUrl}${baseUrl.includes("?") ? queryString(params) : params ? `?${new URLSearchParams(params)}` : ""}`;
    const result = await fetchJson(url);
    if (!result.ok) break;
    const data = asRecord(result.data);
    const items = data && Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) break;
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const hash = hashOf(item);
      if (!hash || seen.has(hash)) continue;
      /* A candidate without a block number cannot be placed in a window, and
       * a zero would drag the reported range back to genesis. Drop it. */
      const blockNumber = blockNumberOf(item);
      if (blockNumber === undefined) continue;
      seen.add(hash);
      out.push({
        hash,
        blockNumber,
        timestamp: timestampOf(item.timestamp),
        direction: direction(item),
      });
      if (out.length >= limit) break;
    }
    params = pageParams(data ? data.next_page_params : undefined);
    if (!params) break;
  }
}

/** Discovers candidate transaction hashes that touched `address`. Never throws. */
export async function fetchCandidateTxs(
  chain: ChainConfig,
  address: string,
  limit: number,
): Promise<CandidateTx[]> {
  if (!chain.blockscout || limit <= 0) return [];
  const out: CandidateTx[] = [];
  const seen = new Set<string>();
  const base = `${chain.blockscout}/api/v2/addresses/${address}`;

  await pullCandidates(
    `${base}/internal-transactions?filter=to`,
    () => "in",
    (item) => asString(item.transaction_hash),
    limit,
    seen,
    out,
  );
  if (out.length < limit) {
    await pullCandidates(
      `${base}/internal-transactions?filter=from`,
      () => "out",
      (item) => asString(item.transaction_hash),
      limit,
      seen,
      out,
    );
  }
  if (out.length < limit) {
    const target = address.toLowerCase();
    await pullCandidates(
      `${base}/transactions`,
      (item) => {
        const from = asRecord(item.from);
        const fromHash = from ? asString(from.hash) : undefined;
        return fromHash && fromHash.toLowerCase() === target ? "out" : "in";
      },
      (item) => asString(item.hash),
      limit,
      seen,
      out,
    );
  }

  out.sort((a, b) => b.blockNumber - a.blockNumber);
  return out.slice(0, limit);
}
