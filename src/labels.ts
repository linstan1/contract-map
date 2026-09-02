/**
 * Display labels and light identity for counterparty addresses.
 *
 * A label is a fact recovered from Blockscout or the chain, never a guess:
 * token symbol first, then a verified contract name, then a shortened
 * address. Loading also feeds every counterparty ABI into the shared
 * `SignatureRegistry`, so a call into a known contract resolves from its
 * real ABI before any signature database guess is attempted.
 */

import { fetchAddressSummary, fetchContractMetadata } from "./blockscout";
import { mapLimit } from "./rpc";
import type { RpcClient } from "./rpc";
import type { SignatureRegistry } from "./signatures";
import type { ChainConfig, TokenInfo } from "./types";

/**
 * Highest number of counterparty ABIs fetched per analysis.
 *
 * The heavy `smart-contracts` endpoint is the request that trips HTTP 429, so
 * it is spent only where it buys function names: on a verified contract whose
 * name the cheap summary did not already give.
 */
const MAX_ABI_FETCHES = 12;

/**
 * Highest number of addresses given a real name per analysis.
 *
 * A busy token shows hundreds of counterparties. The caller passes them most
 * active first, and the reader only ever sees ranked rows, so the tail keeps
 * a shortened address instead of costing one explorer request each.
 */
const MAX_LABEL_LOOKUPS = 60;

/**
 * Highest number of `eth_getCode` probes when the explorer stays silent.
 *
 * The probe decides contract against account. It is cheap on the RPC, but
 * hundreds of probes still cost tens of seconds, so the tail stays unknown.
 */
const MAX_CODE_PROBES = 32;

interface LabelEntry {
  name?: string;
  token?: TokenInfo;
  isContract: boolean;
  verified: boolean;
  ens?: string;
}

/** Shortens an address to `0x1234…cdef` for display when no name is known. */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Picks the display label for one address from its recovered metadata. Never invents a name. */
export function pickLabel(address: string, entry: LabelEntry | undefined): string {
  if (entry?.token?.symbol) return entry.token.symbol;
  if (entry?.name) return entry.name;
  if (entry?.ens) return entry.ens;
  return shortenAddress(address);
}

export class LabelBook {
  private readonly entries = new Map<string, LabelEntry>();
  private readonly loaded = new Set<string>();
  /** Addresses left unnamed because the lookup budget ran out. */
  private skipped = 0;
  /** Addresses the explorer refused to describe. */
  private refused = 0;

  constructor(
    private readonly chain: ChainConfig,
    private readonly rpc: RpcClient,
    private readonly registry: SignatureRegistry,
  ) {}

  /**
   * Loads labels for counterparty addresses.
   *
   * Phase one spends ONE cheap request per address, which answers the name,
   * the token, and the verified flag. Phase two spends the heavy request only
   * on verified contracts that phase one could not name, up to
   * `MAX_ABI_FETCHES`, because that ABI turns a raw selector into a function
   * name. Never throws.
   */
  async load(addresses: string[]): Promise<void> {
    const ordered = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !this.loaded.has(a));
    if (ordered.length === 0) return;

    /* The caller passes addresses most active first, so the budget buys names
     * for the rows the reader actually reads. */
    const targets = ordered.slice(0, MAX_LABEL_LOOKUPS);
    this.skipped += ordered.length - targets.length;
    for (const address of ordered) this.loaded.add(address);

    let probes = 0;
    await mapLimit(targets, 4, async (address) => {
      const summary = await fetchAddressSummary(this.chain, address);
      let isContract = summary?.isContract ?? false;
      if (!summary) {
        this.refused++;
        /* The explorer said nothing, so ask the chain whether code lives here.
         * A mass refusal must not turn into hundreds of probes. */
        if (probes < MAX_CODE_PROBES) {
          probes++;
          try {
            const code = await this.rpc.getCode(address);
            isContract = typeof code === "string" && code !== "0x";
          } catch {
            // The chain refused the probe too. Leave the flag false.
          }
        }
      }
      this.entries.set(address, {
        name: summary?.name,
        token: summary?.token,
        isContract,
        verified: summary?.isVerified ?? false,
        ens: summary?.ens,
      });
    });

    const needAbi = targets
      .filter((address) => {
        const entry = this.entries.get(address);
        return entry?.verified === true && entry.isContract;
      })
      .slice(0, MAX_ABI_FETCHES);

    await mapLimit(needAbi, 3, async (address) => {
      const metadata = await fetchContractMetadata(this.chain, address);
      if (metadata.abi.length > 0) this.registry.addAbi(metadata.abi);
      const entry = this.entries.get(address);
      if (entry && !entry.name && metadata.name) entry.name = metadata.name;
    });
  }

  /**
   * What the label budget and the explorer cost this analysis.
   *
   * A missing name has two very different causes, and the reader must be able
   * to tell them apart: the budget stopped, or the explorer refused.
   */
  coverage(): { skipped: number; refused: number; named: number } {
    let named = 0;
    for (const entry of this.entries.values()) if (entry.name || entry.token?.symbol || entry.ens) named++;
    return { skipped: this.skipped, refused: this.refused, named };
  }

  /** Token symbol, then contract name, then a shortened address. Never invented. */
  label(address: string): string {
    return pickLabel(address, this.entries.get(address.toLowerCase()));
  }

  info(address: string): { name?: string; token?: TokenInfo; isContract: boolean; verified: boolean } {
    const entry = this.entries.get(address.toLowerCase());
    return {
      name: entry?.name,
      token: entry?.token,
      isContract: entry?.isContract ?? false,
      verified: entry?.verified ?? false,
    };
  }
}
