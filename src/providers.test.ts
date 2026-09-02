import { expect, test } from "bun:test";
import { buildContractMetadata } from "./blockscout";
import { pickLabel, shortenAddress } from "./labels";
import { SignatureRegistry, verifySelectorCandidates } from "./signatures";

test("verifySelectorCandidates rejects a wrong candidate and keeps the verified one", () => {
  // "0xa9059cbb" is a real published collision: transfer(address,uint256) and
  // workMyDirefulOwner(uint256,uint256) both hash to it. Both are valid; a
  // completely unrelated string must be rejected outright.
  const result = verifySelectorCandidates("0xa9059cbb", [
    "transfer(address,uint256)",
    "totallyUnrelated(uint256)",
  ]);
  expect(result.chosen).toBe("transfer(address,uint256)");
  expect(result.alternatives).toEqual([]);
});

test("verifySelectorCandidates picks the shortest verified signature and records the rest as alternatives", () => {
  const result = verifySelectorCandidates("0xa9059cbb", [
    "workMyDirefulOwner(uint256,uint256)",
    "transfer(address,uint256)",
  ]);
  expect(result.chosen).toBe("transfer(address,uint256)");
  expect(result.alternatives).toEqual(["workMyDirefulOwner(uint256,uint256)"]);
});

test("SignatureRegistry.lookup resolves a selector from an ABI", () => {
  const registry = new SignatureRegistry();
  registry.addAbi([{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] }]);
  const hit = registry.lookup("0xa9059cbb");
  expect(hit.signature).toBe("transfer(address,uint256)");
  expect(hit.name).toBe("transfer");
  expect(hit.source).toBe("abi");
});

test("SignatureRegistry.lookup reports an unknown selector without inventing a name", () => {
  const registry = new SignatureRegistry();
  const hit = registry.lookup("0xdeadbeef");
  expect(hit.source).toBe("unknown");
  expect(hit.name).toBeUndefined();
});

test("SignatureRegistry.addAbi keeps the first registration and records a collision", () => {
  const registry = new SignatureRegistry();
  registry.addAbi([{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] }]);
  registry.addAbi([
    { type: "function", name: "workMyDirefulOwner", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  ]);
  const hit = registry.lookup("0xa9059cbb");
  expect(hit.signature).toBe("transfer(address,uint256)");
  expect(registry.collisionsFor("0xa9059cbb")).toEqual([
    "transfer(address,uint256)",
    "workMyDirefulOwner(uint256,uint256)",
  ]);
});

test("shortenAddress keeps a readable head and tail", () => {
  expect(shortenAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe("0xA0b8…eB48");
});

test("pickLabel prefers a token symbol, then a contract name, then a shortened address", () => {
  const address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  expect(pickLabel(address, { token: { symbol: "USDC" }, name: "FiatTokenProxy", isContract: true, verified: true })).toBe(
    "USDC",
  );
  expect(pickLabel(address, { name: "FiatTokenProxy", isContract: true, verified: true })).toBe("FiatTokenProxy");
  expect(pickLabel(address, undefined)).toBe(shortenAddress(address));
});

// A trimmed copy of the live Blockscout answer for the USDC proxy
// (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on ethereum, probed 2026-09-02).
const USDC_PROXY_SMART_CONTRACT = {
  is_verified: true,
  name: "FiatTokenProxy",
  proxy_type: "eip1967_oz",
  compiler_version: "v0.6.12+commit.27d51765",
  language: "solidity",
  file_path: "FiatTokenProxy.sol",
  source_code: "contract FiatTokenProxy is AdminUpgradeabilityProxy {}",
  additional_sources: [
    { file_path: "AdminUpgradeabilityProxy.sol", source_code: "contract AdminUpgradeabilityProxy {}" },
  ],
  implementations: [{ address_hash: "0x43506849D7C04F9138D1A2050bbF3A0c054402dd", name: "FiatTokenV2_2" }],
  conflicting_implementations: null,
  abi: [
    { type: "function", name: "admin", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { type: "function", name: "implementation", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  ],
};

const USDC_ADDRESS_PAYLOAD = {
  is_contract: true,
  name: "USDC",
  token: { name: "USDC", symbol: "USDC", decimals: "6" },
};

test("buildContractMetadata maps a verified proxy payload", () => {
  const metadata = buildContractMetadata(
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDC_PROXY_SMART_CONTRACT,
    USDC_ADDRESS_PAYLOAD,
    ["https://eth.blockscout.com/api/v2/smart-contracts/0xA0..."],
    [],
  );
  expect(metadata.verified).toBe(true);
  expect(metadata.name).toBe("FiatTokenProxy");
  expect(metadata.proxyType).toBe("eip1967_oz");
  expect(metadata.implementations).toEqual([
    { address: "0x43506849D7C04F9138D1A2050bbF3A0c054402dd", name: "FiatTokenV2_2" },
  ]);
  expect(metadata.conflicting).toEqual([]);
  expect(metadata.abi).toHaveLength(2);
  expect(metadata.sources).toEqual([
    { path: "FiatTokenProxy.sol", content: "contract FiatTokenProxy is AdminUpgradeabilityProxy {}" },
    { path: "AdminUpgradeabilityProxy.sol", content: "contract AdminUpgradeabilityProxy {}" },
  ]);
  expect(metadata.token).toEqual({ name: "USDC", symbol: "USDC", decimals: 6 });
  expect(metadata.isContract).toBe(true);
  expect(metadata.warnings).toEqual([]);
});

test("buildContractMetadata degrades to an unverified, empty-ABI result when both payloads are missing", () => {
  const metadata = buildContractMetadata("0xdead", undefined, undefined, [], ["Blockscout lookup failed."]);
  expect(metadata.verified).toBe(false);
  expect(metadata.abi).toEqual([]);
  expect(metadata.sources).toEqual([]);
  expect(metadata.warnings).toEqual(["Blockscout lookup failed."]);
});
