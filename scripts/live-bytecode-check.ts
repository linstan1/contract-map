/**
 * Throwaway live check for the bytecode slice. Not part of the test suite;
 * run manually with `bun run scripts/live-bytecode-check.ts`, then delete.
 */
import { RpcClient } from "../src/rpc";
import { chainByKey } from "../src/config";
import { analyzeBytecode } from "../src/bytecode/index";

async function main() {
  const chain = chainByKey("ethereum");
  if (!chain) throw new Error("ethereum chain missing from registry");
  const rpc = new RpcClient(chain);

  console.log("=== USDC implementation 0x43506849D7C04F9138D1A2050bbF3A0c054402dd ===");
  const usdcCode = await rpc.getCode("0x43506849D7C04F9138D1A2050bbF3A0c054402dd");
  const usdc = analyzeBytecode(usdcCode, ["0xa9059cbb", "0x70a08231"]);
  console.log("warnings:", usdc.warnings);
  console.log("transfer(address,uint256) facts:", usdc.facts["0xa9059cbb"]);
  console.log("balanceOf(address) facts:", usdc.facts["0x70a08231"]);

  console.log("\n=== Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3 ===");
  const permit2Code = await rpc.getCode("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  const permit2Full = analyzeBytecode(permit2Code);
  console.log("warnings:", permit2Full.warnings);
  console.log("dispatcher selector count:", permit2Full.dispatcherSelectors.length);
  const someSelectors = permit2Full.dispatcherSelectors.slice(0, 2);
  console.log("sample selectors:", someSelectors);
  console.log("facts for sample selectors:", someSelectors.map((s) => [s, permit2Full.facts[s]]));
  // permitTransferFrom(...) selector, a permit-transfer function that ends in a CALL
  const PERMIT_TRANSFER_FROM = "0x30f28b7a";
  const permit2Targeted = analyzeBytecode(permit2Code, [PERMIT_TRANSFER_FROM]);
  console.log("permitTransferFrom facts:", permit2Targeted.facts[PERMIT_TRANSFER_FROM]);
  console.log("permitTransferFrom warnings:", permit2Targeted.warnings);

  console.log("\n=== Unverified 0xf73ab00aee56c789f856be3e1ba63e42e508c09e ===");
  const unverifiedCode = await rpc.getCode("0xf73ab00aee56c789f856be3e1ba63e42e508c09e");
  const unverified = analyzeBytecode(unverifiedCode);
  console.log("warnings:", unverified.warnings);
  console.log("dispatcher selectors found:", unverified.dispatcherSelectors);
  console.log("resolved selector count:", Object.keys(unverified.facts).length, "of", unverified.dispatcherSelectors.length);
  for (const sel of unverified.dispatcherSelectors) {
    console.log(sel, "->", unverified.facts[sel] ?? "UNRESOLVED");
  }

  console.log("\n=== Curve 3pool 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7 (Vyper 0.2.8) ===");
  const poolCode = await rpc.getCode("0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7");
  const pool = analyzeBytecode(poolCode, ["0x3df02124", "0xbb7b8b80"]);
  console.log("warnings:", pool.warnings);
  console.log("exchange(int128,int128,uint256,uint256) 0x3df02124 facts:", pool.facts["0x3df02124"]);
  console.log("get_virtual_price() 0xbb7b8b80 facts:", pool.facts["0xbb7b8b80"]);

  console.log("\n=== Yearn V2 Vault impl 0x9c13e225ae007731caa49fd17a41379ab1a489f4 (Vyper 0.3.3) ===");
  const vaultCode = await rpc.getCode("0x9c13e225ae007731caa49fd17a41379ab1a489f4");
  const vault = analyzeBytecode(vaultCode);
  console.log(
    "dispatcher selectors:", vault.dispatcherSelectors.length,
    "resolved:", Object.keys(vault.facts).length,
    "unresolved:", vault.dispatcherSelectors.length - Object.keys(vault.facts).length,
  );

  console.log("\n=== Vyper 0.4 0xE05d0e9eaB8AD581fE5736d8EaA4224dED4Dac7E ===");
  const v4Code = await rpc.getCode("0xE05d0e9eaB8AD581fE5736d8EaA4224dED4Dac7E");
  const v4 = analyzeBytecode(v4Code);
  console.log(
    "dispatcher selectors:", v4.dispatcherSelectors.length,
    "resolved:", Object.keys(v4.facts).length,
    "unresolved:", v4.dispatcherSelectors.length - Object.keys(v4.facts).length,
  );
  console.log("warnings:", v4.warnings);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
