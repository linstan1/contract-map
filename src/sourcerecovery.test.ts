import { afterEach, expect, test } from "bun:test";
import { recoverSources, toChecksumAddress } from "./sourcerecovery";
import type { ChainConfig } from "./types";

/**
 * These tests stub `fetch`, so no request leaves the process. A placeholder
 * key still has to exist, because the RPC endpoint URL is built before any
 * request is made. Setting it here keeps the suite runnable on a machine and
 * in CI with no key of its own.
 */
process.env.ALCHEMY_API_KEY = "test-key-not-a-real-credential";

const CHAIN: ChainConfig = {
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
};

const TARGET = "0xF73aB00aEe56C789F856be3E1ba63E42E508c09e";
const TWIN = "0x43506849D7C04F9138D1A2050bbF3A0c054402dd";

/*
 * Synthetic runtime code carrying three real dispatcher entries: the
 * well-known ERC-20 selectors for `transfer`, `balanceOf`, and `approve`,
 * each as `PUSH4 <selector> EQ`. `bytecodeSelectors` scans opcodes
 * structurally, so this need not be a runnable program.
 */
const TARGET_RUNTIME_CODE = "0x63a9059cbb146370a082311463095ea7b314";
const MATCHING_ABI = [
  { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
/** Shares one real selector (`balanceOf`) with the target, the other two do not match. */
const MISMATCHED_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "foo", inputs: [], outputs: [] },
  { type: "function", name: "bar", inputs: [], outputs: [] },
];

const BLOCKSCOUT_UNROUTED = { message: "Params 'module' and 'action' are required parameters", result: null, status: "0" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes a mocked `fetch` call to canned answers, keyed by URL substring. */
function installFetchMock(routes: { match: string; respond: (init?: RequestInit) => Response }[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    return route.respond(init);
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function rpcRoute(code: string) {
  return {
    match: "eth-mainnet.g.alchemy.com",
    respond: () => jsonResponse(200, { jsonrpc: "2.0", id: 1, result: code }),
  };
}

const bytecodeSearchDeadRoute = {
  match: "bytecodes/sources:search-all",
  respond: () => jsonResponse(400, BLOCKSCOUT_UNROUTED),
};

test("toChecksumAddress matches the published EIP-55 vectors", () => {
  const vectors = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];
  for (const vector of vectors) {
    expect(toChecksumAddress(vector.toLowerCase())).toBe(vector);
  }
});

test("toChecksumAddress checksums the live target address correctly", () => {
  expect(toChecksumAddress(TARGET.toLowerCase())).toBe(TARGET);
});

test("recoverSources returns undefined when the runtime code has no dispatcher selectors", async () => {
  // A minimal proxy: no PUSH4/EQ pair, only a delegatecall fallback.
  installFetchMock([rpcRoute("0x365f5f37365f5f345af43d5f5f3e6039573d5ffd5b3d5ff3")]);
  const result = await recoverSources(CHAIN, TARGET);
  expect(result).toBeUndefined();
});

test("recoverSources accepts a verified twin whose ABI explains the dispatcher", async () => {
  installFetchMock([
    rpcRoute(TARGET_RUNTIME_CODE),
    {
      match: `smart-contracts/${TWIN}`,
      respond: () =>
        jsonResponse(200, {
          is_verified: true,
          name: "FiatTokenV2_2",
          compiler_version: "v0.6.12+commit.27d51765",
          language: "solidity",
          file_path: "FiatTokenV2_2.sol",
          source_code: "contract FiatTokenV2_2 {}",
          abi: MATCHING_ABI,
        }),
    },
    { match: `addresses/${TWIN}`, respond: () => jsonResponse(200, { is_contract: true }) },
  ]);

  const result = await recoverSources(CHAIN, TARGET, TWIN);
  expect(result).toBeDefined();
  expect(result?.provenance).toBe(`Source from the verified bytecode twin at ${TWIN.slice(0, 6)}…${TWIN.slice(-4)}, which shares this runtime code.`);
  expect(result?.abi).toHaveLength(3);
  expect(result?.name).toBe("FiatTokenV2_2");
  expect(result?.warnings).toEqual([]);
});

test("recoverSources rejects a twin below the two-thirds selector threshold and falls through to a full Sourcify match", async () => {
  installFetchMock([
    rpcRoute(TARGET_RUNTIME_CODE),
    {
      match: `smart-contracts/${TWIN}`,
      respond: () => jsonResponse(200, { is_verified: true, name: "Decoy", abi: MISMATCHED_ABI, source_code: "contract Decoy {}" }),
    },
    { match: `addresses/${TWIN}`, respond: () => jsonResponse(200, { is_contract: true }) },
    bytecodeSearchDeadRoute,
    {
      match: `sourcify.dev/server/v2/contract/1/${TARGET}`,
      respond: () =>
        jsonResponse(200, {
          runtimeMatch: "exact_match",
          abi: MATCHING_ABI,
          sources: { "Token.sol": { content: "contract Token {}" } },
          compilation: { name: "Token", compilerVersion: "0.8.19", language: "Solidity" },
        }),
    },
  ]);

  const result = await recoverSources(CHAIN, TARGET, TWIN);
  expect(result).toBeDefined();
  expect(result?.provenance).toBe("Source from the Sourcify repository, full match, chain 1.");
  expect(result?.sources).toEqual([{ path: "Token.sol", content: "contract Token {}" }]);
  expect(result?.warnings.some((w) => w.includes("Rejected a candidate source") && w.includes("33%"))).toBe(true);
});

test("recoverSources reports a partial Sourcify match with the metadata-hash caveat", async () => {
  installFetchMock([
    rpcRoute(TARGET_RUNTIME_CODE),
    bytecodeSearchDeadRoute,
    {
      match: `sourcify.dev/server/v2/contract/1/${TARGET}`,
      respond: () =>
        jsonResponse(200, {
          runtimeMatch: "match",
          abi: MATCHING_ABI,
          sources: { "Token.sol": { content: "contract Token {}" } },
          compilation: { name: "Token", compilerVersion: "0.8.19", language: "Solidity" },
        }),
    },
  ]);

  const result = await recoverSources(CHAIN, TARGET);
  expect(result).toBeDefined();
  expect(result?.provenance).toBe(
    "Source from the Sourcify repository, partial match, chain 1. The metadata hash differs from the recompiled bytecode.",
  );
});

test("recoverSources tries Sourcify for the twin when the target itself has no entry", async () => {
  installFetchMock([
    rpcRoute(TARGET_RUNTIME_CODE),
    { match: `smart-contracts/${TWIN}`, respond: () => jsonResponse(200, {}) }, // unverified twin on Blockscout
    { match: `addresses/${TWIN}`, respond: () => jsonResponse(200, { is_contract: true }) },
    bytecodeSearchDeadRoute,
    { match: `sourcify.dev/server/v2/contract/1/${TARGET}`, respond: () => jsonResponse(404, { runtimeMatch: null }) },
    {
      match: `sourcify.dev/server/v2/contract/1/${TWIN}`,
      respond: () =>
        jsonResponse(200, {
          runtimeMatch: "exact_match",
          abi: MATCHING_ABI,
          sources: { "Token.sol": { content: "contract Token {}" } },
          compilation: { name: "Token", compilerVersion: "0.8.19", language: "Solidity" },
        }),
    },
  ]);

  const result = await recoverSources(CHAIN, TARGET, TWIN);
  expect(result).toBeDefined();
  expect(result?.provenance).toBe(
    `Source from the Sourcify repository, full match, chain 1, recovered through the bytecode twin at ${TWIN.slice(0, 6)}…${TWIN.slice(-4)}.`,
  );
});

test("recoverSources returns undefined when every origin fails or is rejected", async () => {
  installFetchMock([
    rpcRoute(TARGET_RUNTIME_CODE),
    bytecodeSearchDeadRoute,
    { match: `sourcify.dev/server/v2/contract/1/${TARGET}`, respond: () => jsonResponse(404, { runtimeMatch: null }) },
  ]);

  const result = await recoverSources(CHAIN, TARGET);
  expect(result).toBeUndefined();
});
