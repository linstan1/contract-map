import { afterEach, expect, test } from "bun:test";
import { RpcClient } from "./rpc";
import { resetConfigCache } from "./config";
import type { ChainConfig } from "./types";

/**
 * Retry behaviour against a rate limiter.
 *
 * A free public endpoint answers HTTP 429 with an HTML page, not with a
 * JSON-RPC error. The status is then the whole message, and the request MUST
 * be tried again instead of failing the analysis on the first refusal.
 *
 * These tests stub `fetch`, so no request leaves the process. `RPC_URL` is set
 * per test and removed again, so no other suite sees it, and it uses the
 * reserved `.example` namespace, so no real endpoint is ever called.
 */

const CHAIN: ChainConfig = {
  id: 1,
  key: "ethereum",
  label: "Ethereum",
  alchemyHost: "eth-mainnet",
  traceFilter: true,
  debugTracer: true,
  blockTimeSec: 12,
  nativeSymbol: "ETH",
};

const ENDPOINT = "https://rpc.example.com/test";
const realFetch = globalThis.fetch;

/** Points this process at the stub endpoint for one test only. */
function useStubEndpoint(): void {
  process.env.RPC_URL = ENDPOINT;
  resetConfigCache();
}

function stubFetch(handler: (url: string) => Promise<Response>): void {
  globalThis.fetch = ((input: string | URL | Request) => handler(String(input))) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RPC_URL;
  resetConfigCache();
});

test("a rate-limited HTML answer is retried, and the next attempt wins", async () => {
  useStubEndpoint();
  let calls = 0;
  stubFetch(async () => {
    calls++;
    if (calls === 1) return new Response("<html>429 Too Many Requests</html>", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), { status: 200 });
  });

  const rpc = new RpcClient(CHAIN);
  expect(await rpc.blockNumber()).toBe(16);
  expect(calls).toBe(2);
});

test("a permanent HTML answer still fails, and names the status", async () => {
  useStubEndpoint();
  let calls = 0;
  stubFetch(async () => {
    calls++;
    return new Response("<html>not found</html>", { status: 404 });
  });

  const rpc = new RpcClient(CHAIN);
  let message = "";
  try {
    await rpc.blockNumber();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("non-JSON (HTTP 404)");
  /* A 404 is about the URL, not about load, so one attempt is enough. */
  expect(calls).toBe(1);
});

test("the endpoint URL never appears in the error text", async () => {
  useStubEndpoint();
  stubFetch(async (url) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  });

  const rpc = new RpcClient(CHAIN);
  let message = "";
  try {
    /* One attempt only: this test is about the error text, not about the
     * retry ladder, and the backoff would outlive the test timeout. */
    await rpc.call("eth_blockNumber", [], 1);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("***");
  expect(message).not.toContain("rpc.example.com/test");
});
