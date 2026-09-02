import { expect, test } from "bun:test";
import {
  findCustomRpcUrl,
  MISSING_ENDPOINT_MESSAGE,
  hasRpcEndpoint,
  rpcProviderLabel,
  rpcSecrets,
  rpcUrl,
  rpcUrlVar,
  settingsFrom,
} from "./config";
import type { ChainConfig } from "./types";

/**
 * Endpoint resolution and credential scrubbing.
 *
 * Every test passes its own `Settings`, so no test reads the environment or
 * the `.env.local` of the machine that runs it. The suite therefore gives the
 * same answer on a developer machine with a key and in CI with none.
 */

const ETHEREUM: ChainConfig = {
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

const ARBITRUM: ChainConfig = { ...ETHEREUM, id: 42161, key: "arbitrum", label: "Arbitrum One", alchemyHost: "arb-mainnet", traceFilter: false };

test("an Alchemy key still builds the vendor URL, so an existing setup keeps working", () => {
  const settings = settingsFrom({ ALCHEMY_API_KEY: "KEY" });
  expect(rpcUrl(ETHEREUM, settings)).toBe("https://eth-mainnet.g.alchemy.com/v2/KEY");
  expect(rpcProviderLabel(ETHEREUM, settings)).toBe("Alchemy eth-mainnet");
});

test("RPC_URL serves every chain, and no key is needed", () => {
  const settings = settingsFrom({ RPC_URL: "https://rpc.example.com/v1/team-token-9f2c" });
  expect(rpcUrl(ETHEREUM, settings)).toBe("https://rpc.example.com/v1/team-token-9f2c");
  expect(rpcUrl(ARBITRUM, settings)).toBe("https://rpc.example.com/v1/team-token-9f2c");
  expect(rpcProviderLabel(ETHEREUM, settings)).toBe("RPC rpc.example.com");
});

test("a per-chain URL beats the generic URL, and the generic URL covers the rest", () => {
  const settings = settingsFrom({
    RPC_URL: "https://generic.example.com/rpc",
    RPC_URL_ETHEREUM: "https://eth.example.com/rpc",
  });
  expect(rpcUrl(ETHEREUM, settings)).toBe("https://eth.example.com/rpc");
  expect(rpcUrl(ARBITRUM, settings)).toBe("https://generic.example.com/rpc");
});

test("a per-chain URL alone leaves the other chains on the Alchemy key", () => {
  const settings = settingsFrom({ RPC_URL_ARBITRUM: "https://arb.example.com/rpc", ALCHEMY_API_KEY: "KEY" });
  expect(rpcUrl(ARBITRUM, settings)).toBe("https://arb.example.com/rpc");
  expect(rpcUrl(ETHEREUM, settings)).toBe("https://eth-mainnet.g.alchemy.com/v2/KEY");
});

test("the per-chain variable name comes from the chain key", () => {
  expect(rpcUrlVar({ key: "ethereum" })).toBe("RPC_URL_ETHEREUM");
  expect(rpcUrlVar({ key: "arbitrum-nova" })).toBe("RPC_URL_ARBITRUM_NOVA");
});

test("no endpoint at all reports the configuration fault, not a provider fault", () => {
  const settings = settingsFrom({});
  expect(hasRpcEndpoint(settings)).toBe(false);
  expect(() => rpcUrl(ETHEREUM, settings)).toThrow(MISSING_ENDPOINT_MESSAGE);
});

test("a documentation placeholder counts as no endpoint", () => {
  const settings = settingsFrom({ RPC_URL: "your_rpc_url_here", ALCHEMY_API_KEY: "your_key_here" });
  expect(hasRpcEndpoint(settings)).toBe(false);
  expect(findCustomRpcUrl(ETHEREUM, settings)).toBeUndefined();
});

test("either kind of endpoint satisfies the startup guard", () => {
  expect(hasRpcEndpoint(settingsFrom({ ALCHEMY_API_KEY: "KEY" }))).toBe(true);
  expect(hasRpcEndpoint(settingsFrom({ RPC_URL: "https://rpc.example.com/x" }))).toBe(true);
  expect(hasRpcEndpoint(settingsFrom({ RPC_URL_ETHEREUM: "https://eth.example.com/x" }))).toBe(true);
});

test("the secret list covers the whole URL and the credential inside it", () => {
  const secrets = rpcSecrets(settingsFrom({ RPC_URL: "https://rpc.example.com/v1/team-token-9f2c?apikey=super-secret-value" }));
  expect(secrets).toContain("https://rpc.example.com/v1/team-token-9f2c?apikey=super-secret-value");
  expect(secrets).toContain("team-token-9f2c");
  expect(secrets).toContain("super-secret-value");
});

test("the secret list holds the longest string first, so no fragment survives a scrub", () => {
  const secrets = rpcSecrets(settingsFrom({ RPC_URL: "https://rpc.example.com/v1/team-token-9f2c" }));
  const lengths = secrets.map((s) => s.length);
  expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
});

test("a userinfo password is a secret too", () => {
  const secrets = rpcSecrets(settingsFrom({ RPC_URL: "https://user:pass-word-1234@rpc.example.com/" }));
  expect(secrets).toContain("pass-word-1234");
});

test("a short path segment is not treated as a credential", () => {
  const secrets = rpcSecrets(settingsFrom({ RPC_URL: "https://rpc.example.com/eth" }));
  expect(secrets).not.toContain("eth");
});

test("scrubbing a failure message with the secret list hides the credential", () => {
  const url = "https://rpc.example.com/v1/team-token-9f2c";
  const settings = settingsFrom({ RPC_URL: url });
  const raw = `fetch failed for ${url} after 3 attempts (segment team-token-9f2c)`;
  let scrubbed = raw;
  for (const secret of rpcSecrets(settings)) scrubbed = scrubbed.split(secret).join("***");
  expect(scrubbed).not.toContain("team-token-9f2c");
  expect(scrubbed).toBe("fetch failed for *** after 3 attempts (segment ***)");
});
