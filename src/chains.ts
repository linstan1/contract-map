/**
 * The chain registry.
 *
 * Every entry records what a live probe found, not what a document promises.
 * `traceFilter` and `debugTracer` decide which discovery path
 * `src/runtime/discover.ts` takes:
 *
 *   traceFilter: true    `trace_filter` finds every frame of the target in a
 *                        block range in one request.
 *   traceFilter: false   the provider rejects `trace_filter`, so candidate
 *                        transactions come from Blockscout and each one is
 *                        expanded with `debug_traceTransaction`.
 *
 * A chain with `debugTracer: false` and `traceFilter: false` has no observed
 * execution at all, so it MUST NOT be listed here.
 *
 * `scripts/probe-chains.ts` re-runs the probe and prints this table. The
 * last run was 2026-09-02, against the shared Alchemy key. The array below
 * is ordered busiest first, by DefiLlama TVL on that date.
 *
 * INCLUSION RULE: a chain is listed when `trace_filter` answers, OR when
 * `debug_traceTransaction` answers AND a working Blockscout v2 host exists.
 * A chain needs one of the two paths for candidate discovery; a chain with
 * neither is not usable and MUST NOT be listed.
 *
 * EXCLUDED, with the exact reason the probe found:
 *
 *   arbitrum-nova   Alchemy has no `arbnova-mainnet` network. The RPC never
 *                   answered `eth_blockNumber`.
 *   polygon-zkevm   Alchemy has no `polygonzkevm-mainnet` network. The RPC
 *                   never answered `eth_blockNumber`.
 *   avalanche       `trace_filter` is rejected, and no Blockscout v2
 *                   instance is listed for chain id 43114.
 *   opbnb           `trace_filter` is rejected, and no Blockscout v2
 *                   instance is listed for chain id 204.
 *   blast           `trace_filter` is rejected, and no Blockscout v2
 *                   instance is listed for chain id 81457.
 *   mantle          `trace_filter` is rejected, and no Blockscout v2
 *                   instance is listed for chain id 5000.
 *   apechain        `trace_filter` is rejected. The listed explorer,
 *                   apechain.calderaexplorer.xyz, is a Caldera rollup
 *                   explorer, not a Blockscout v2 API, so it fails the probe.
 *   fraxtal         `trace_filter` is rejected, and no Blockscout v2
 *                   instance is listed for chain id 252.
 *   abstract        `debug_traceTransaction` answers, but `trace_filter`
 *                   returns "Method not found" and no Blockscout v2 instance
 *                   is listed for chain id 2741, so neither discovery path
 *                   exists.
 *   degen           Alchemy deprecated `degen-mainnet` on 2026-08-31, two
 *                   days before this probe. `eth_blockNumber` never answered.
 */

import type { ChainConfig } from "./types";

export const CHAINS: ChainConfig[] = [
  {
    id: 1,
    key: "ethereum",
    label: "Ethereum",
    alchemyHost: "eth-mainnet",
    blockscout: "https://eth.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 12,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 8453,
    key: "base",
    label: "Base",
    alchemyHost: "base-mainnet",
    blockscout: "https://base.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "ETH",
    sourcify: true,
    probeNote: "The Blockscout instance answers, but it returned HTTP 500 under load during the probe. Repeated analyses of one address can lose the source view for that reason.",
  },
  {
    id: 56,
    key: "bnb",
    label: "BNB Smart Chain",
    alchemyHost: "bnb-mainnet",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 0.45,
    nativeSymbol: "BNB",
    sourcify: true,
    probeNote: "No Blockscout v2 instance is listed for this chain id. trace_filter covers discovery.",
  },
  {
    id: 42161,
    key: "arbitrum",
    label: "Arbitrum One",
    alchemyHost: "arb-mainnet",
    blockscout: "https://arbitrum.blockscout.com",
    traceFilter: false,
    debugTracer: true,
    blockTimeSec: 0.25,
    nativeSymbol: "ETH",
    sourcify: true,
    probeNote: "trace_filter is not available on this chain, so candidates come from Blockscout.",
  },
  {
    id: 137,
    key: "polygon",
    label: "Polygon",
    alchemyHost: "polygon-mainnet",
    blockscout: "https://polygon.blockscout.com",
    traceFilter: false,
    debugTracer: true,
    blockTimeSec: 1.5,
    nativeSymbol: "POL",
    sourcify: true,
    probeNote: "trace_filter stopped working after the Erigon to Bor migration, so candidates come from Blockscout.",
  },
  {
    id: 10,
    key: "optimism",
    label: "Optimism",
    alchemyHost: "opt-mainnet",
    blockscout: "https://explorer.optimism.io",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 57073,
    key: "ink",
    label: "Ink",
    alchemyHost: "ink-mainnet",
    blockscout: "https://explorer.inkonchain.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 1,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 100,
    key: "gnosis",
    label: "Gnosis",
    alchemyHost: "gnosis-mainnet",
    blockscout: "https://gnosis.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 5.12,
    nativeSymbol: "xDAI",
    sourcify: true,
  },
  {
    id: 80094,
    key: "berachain",
    label: "Berachain",
    alchemyHost: "berachain-mainnet",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "BERA",
    sourcify: true,
    probeNote: "No Blockscout v2 instance is listed for this chain id. trace_filter covers discovery.",
  },
  {
    id: 480,
    key: "worldchain",
    label: "World Chain",
    alchemyHost: "worldchain-mainnet",
    blockscout: "https://worldchain-mainnet.explorer.alchemy.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 130,
    key: "unichain",
    label: "Unichain",
    alchemyHost: "unichain-mainnet",
    blockscout: "https://unichain.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 1,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 59144,
    key: "linea",
    label: "Linea",
    alchemyHost: "linea-mainnet",
    blockscout: "https://explorer.linea.build",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 6.78,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 42220,
    key: "celo",
    label: "Celo",
    alchemyHost: "celo-mainnet",
    blockscout: "https://celo.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 1,
    nativeSymbol: "CELO",
    sourcify: true,
  },
  {
    id: 146,
    key: "sonic",
    label: "Sonic",
    alchemyHost: "sonic-mainnet",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 1.56,
    nativeSymbol: "S",
    sourcify: true,
    probeNote: "No Blockscout v2 instance is listed for this chain id. trace_filter covers discovery.",
  },
  {
    id: 324,
    key: "zksync",
    label: "ZKsync Era",
    alchemyHost: "zksync-mainnet",
    blockscout: "https://zksync.blockscout.com",
    traceFilter: false,
    debugTracer: true,
    blockTimeSec: 6.52,
    nativeSymbol: "ETH",
    sourcify: true,
    probeNote: "trace_filter is not available on this chain, so candidates come from Blockscout.",
  },
  {
    id: 2020,
    key: "ronin",
    label: "Ronin",
    alchemyHost: "ronin-mainnet",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "RON",
    sourcify: true,
    probeNote: "The listed explorer is a Conduit-hosted rollup explorer, not a Blockscout v2 API, so it does not count. trace_filter covers discovery.",
  },
  {
    id: 534352,
    key: "scroll",
    label: "Scroll",
    alchemyHost: "scroll-mainnet",
    blockscout: "https://scroll.blockscout.com",
    traceFilter: false,
    debugTracer: true,
    blockTimeSec: 4.95,
    nativeSymbol: "ETH",
    sourcify: true,
    probeNote: "trace_filter is not available on this chain, so candidates come from Blockscout.",
  },
  {
    id: 1868,
    key: "soneium",
    label: "Soneium",
    alchemyHost: "soneium-mainnet",
    blockscout: "https://soneium.blockscout.com",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "ETH",
    sourcify: true,
  },
  {
    id: 7777777,
    key: "zora",
    label: "Zora",
    alchemyHost: "zora-mainnet",
    traceFilter: true,
    debugTracer: true,
    blockTimeSec: 2,
    nativeSymbol: "ETH",
    sourcify: true,
    probeNote: "No Blockscout v2 instance is listed for this chain id. trace_filter covers discovery.",
  },
];

export function chainByKey(key: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.key === key);
}

export function chainById(id: number): ChainConfig | undefined {
  return CHAINS.find((c) => c.id === id);
}
