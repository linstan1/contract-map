import { describe, expect, test } from "bun:test";
import { analyzeSources } from "./index";
import type { SourceFile } from "../types";

async function load(path: string): Promise<SourceFile> {
  const content = await Bun.file(new URL(path, import.meta.url)).text();
  return { path, content };
}

describe("plain ERC20-like contract", () => {
  test("finds every exposed function with a correct selector", async () => {
    const file = await load("./__fixtures__/erc20.sol");
    const result = analyzeSources({ files: [file], contractName: "SimpleToken", abi: [], address: "0x1" });

    expect(result.contractName).toBe("SimpleToken");
    const names = result.functions.map((f) => f.name).sort();
    expect(names).toEqual(["approve", "transfer", "transferFrom"].sort());

    const transfer = result.functions.find((f) => f.name === "transfer")!;
    expect(transfer.signature).toBe("transfer(address,uint256)");
    expect(transfer.selector).toBe("0xa9059cbb");
    expect(transfer.writes.map((w) => w.name)).toEqual(["balanceOf"]);
    expect(transfer.events).toContain("Transfer(address,address,uint256)");
    expect(transfer.access.kind).toBe("open");
  });
});

describe("ERC4626-style vault", () => {
  test("resolves the library-wrapped transferFrom and the interface-typed external call", async () => {
    const file = await load("./__fixtures__/vault.sol");
    const result = analyzeSources({ files: [file], contractName: "SimpleVault", abi: [], address: "0x2" });

    const deposit = result.functions.find((f) => f.name === "deposit")!;
    expect(deposit).toBeDefined();
    expect(deposit.signature).toBe("deposit(uint256)");

    const transferCall = deposit.externalCalls.find((c) => c.functionName === "transferFrom");
    expect(transferCall).toBeDefined();
    expect(transferCall!.signature).toBe("transferFrom(address,address,uint256)");
    expect(transferCall!.via).toContain("SafeERC20.safeTransferFrom");

    const supplyCall = deposit.externalCalls.find((c) => c.functionName === "supply");
    expect(supplyCall).toBeDefined();
    expect(supplyCall!.signature).toBe("supply(address,uint256)");
    expect(supplyCall!.destination.kind).toBe("state");
    expect(supplyCall!.destination.name).toBe("pool");

    expect(deposit.writes.map((w) => w.name)).toEqual(expect.arrayContaining(["shares", "totalShares"]));
  });
});

describe("inheritance chain", () => {
  test("attributes an exposed function declared in a base contract", async () => {
    const file = await load("./__fixtures__/misc.sol");
    const result = analyzeSources({ files: [file], contractName: "Derived", abi: [], address: "0x3" });

    expect(result.inheritance).toEqual(["Derived", "Base"]);
    const baseValue = result.functions.find((f) => f.name === "baseValue")!;
    expect(baseValue).toBeDefined();
    expect(baseValue.declaredIn).toBe("Base");
    expect(baseValue.mutability).toBe("view");

    const bump = result.functions.find((f) => f.name === "bump")!;
    expect(bump.writes.map((w) => w.name)).toContain("storedValue");
    expect(bump.internalCalls.some((c) => c.name === "_setStored")).toBe(true);
  });
});

describe("access-gated setter", () => {
  test("derives owner-only access control from the modifier", async () => {
    const file = await load("./__fixtures__/misc.sol");
    const result = analyzeSources({ files: [file], contractName: "Access", abi: [], address: "0x4" });

    const setFee = result.functions.find((f) => f.name === "setFee")!;
    expect(setFee.access.kind).toBe("owner");
    expect(setFee.access.gates).toContain("onlyOwner");
    expect(setFee.writes.map((w) => w.name)).toContain("fee");
  });
});

describe("low-level call with a dynamic target", () => {
  test("marks the destination and selector as dynamic without fabricating a signature", async () => {
    const file = await load("./__fixtures__/misc.sol");
    const result = analyzeSources({ files: [file], contractName: "Relay", abi: [], address: "0x5" });

    const forward = result.functions.find((f) => f.name === "forward")!;
    const call = forward.externalCalls.find((c) => c.callType === "dynamic" || c.callType === "call");
    expect(call).toBeDefined();
    expect(call!.destination.kind).toBe("parameter");
    expect(call!.destination.name).toBe("target");
    expect(call!.selector).toBeUndefined();
    expect(call!.signature).toBeUndefined();

    const ping = result.functions.find((f) => f.name === "ping")!;
    const staticCall = ping.externalCalls.find((c) => c.callType === "staticcall");
    expect(staticCall).toBeDefined();
    expect(staticCall!.signature).toBe("ping()");
  });
});

describe("ABI entry with no source", () => {
  test("keeps an ABI-only function and marks it hasSource: false", async () => {
    const file = await load("./__fixtures__/erc20.sol");
    const result = analyzeSources({
      files: [file],
      contractName: "SimpleToken",
      abi: [
        { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
        { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
        { type: "function", name: "transferFrom", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
        { type: "function", name: "permit", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
      ],
      address: "0x6",
    });

    const permit = result.functions.find((f) => f.name === "permit");
    expect(permit).toBeDefined();
    expect(permit!.hasSource).toBe(false);
    expect(permit!.notes.length).toBeGreaterThan(0);
    // Source-backed functions with a matching ABI entry keep their source analysis.
    const transfer = result.functions.find((f) => f.name === "transfer")!;
    expect(transfer.hasSource).toBe(true);
    expect(transfer.selector).toBe("0xa9059cbb");
  });

  test("excludes a source function with no matching ABI entry, and every returned selector is in the ABI", async () => {
    const file = await load("./__fixtures__/erc20.sol");
    const result = analyzeSources({
      files: [file],
      contractName: "SimpleToken",
      abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }],
      address: "0x6",
    });

    expect(result.functions.find((f) => f.name === "approve")).toBeUndefined();
    expect(result.functions.find((f) => f.name === "transferFrom")).toBeUndefined();
    expect(result.functions.find((f) => f.name === "transfer")).toBeDefined();
    expect(result.warnings.some((w) => w.includes("excluded approve"))).toBe(true);
    const abiSelectors = new Set(["0xa9059cbb"]);
    for (const f of result.functions) if (f.selector) expect(abiSelectors.has(f.selector)).toBe(true);
  });
});

describe("real Morpho VaultV2 source", () => {
  test("produces a sane exposed-function surface with no empty list and no fabricated signatures", async () => {
    const content = await Bun.file("C:/tmp/VaultV2.sol").text();
    const result = analyzeSources({ files: [{ path: "VaultV2.sol", content }], contractName: "VaultV2", abi: [], address: "0x7" });

    expect(result.contractName).toBe("VaultV2");
    expect(result.functions.length).toBeGreaterThan(10);

    const deposit = result.functions.find((f) => f.name === "deposit")!;
    expect(deposit.signature).toBe("deposit(uint256,address)");
    expect(deposit.selector).toBe("0x6e553f65");

    for (const fn of result.functions) {
      if (fn.selector) expect(fn.selector).toMatch(/^0x[0-9a-f]{8}$/);
      for (const call of fn.externalCalls) {
        if (call.selector) expect(call.selector).toMatch(/^0x[0-9a-f]{8}$/);
      }
    }
  });
});

describe("type canonicalisation", () => {
  test("canonicalises a struct parameter to a tuple", async () => {
    const file = await load("./__fixtures__/types.sol");
    const result = analyzeSources({ files: [file], contractName: "TypesDemo", abi: [], address: "0x8" });
    const fn = result.functions.find((f) => f.name === "acceptCap")!;
    expect(fn.signature).toBe("acceptCap((address,address,uint256))");
    expect(fn.selector).toBe("0xb646887a");
  });

  test("canonicalises a nested struct inside an array of struct", async () => {
    const file = await load("./__fixtures__/types.sol");
    const result = analyzeSources({ files: [file], contractName: "TypesDemo", abi: [], address: "0x8" });
    const fn = result.functions.find((f) => f.name === "reallocate")!;
    expect(fn.signature).toBe("reallocate(((address,address,uint256),uint256[])[])");
    expect(fn.selector).toBe("0x399cf7ce");
  });

  test("canonicalises a user defined value type to its underlying primitive", async () => {
    const file = await load("./__fixtures__/types.sol");
    const result = analyzeSources({ files: [file], contractName: "TypesDemo", abi: [], address: "0x8" });
    const fn = result.functions.find((f) => f.name === "revokePendingCap")!;
    expect(fn.signature).toBe("revokePendingCap(bytes32)");
    expect(fn.selector).toBe("0x102f7b6c");
  });

  test("canonicalises an enum parameter to uint8", async () => {
    const file = await load("./__fixtures__/types.sol");
    const result = analyzeSources({ files: [file], contractName: "TypesDemo", abi: [], address: "0x8" });
    const fn = result.functions.find((f) => f.name === "setStatus")!;
    expect(fn.signature).toBe("setStatus(uint8)");
    expect(fn.selector).toBe("0x2e49d78b");
  });

  test("canonicalises a contract/interface typed parameter to address", async () => {
    const file = await load("./__fixtures__/types.sol");
    const result = analyzeSources({ files: [file], contractName: "TypesDemo", abi: [], address: "0x8" });
    const fn = result.functions.find((f) => f.name === "setAdapter")!;
    expect(fn.signature).toBe("setAdapter(address)");
    expect(fn.selector).toBe("0xab1da79c");
  });
});

describe("cross-file resolution", () => {
  test("resolves an interface member through a library declared in a third file, and disambiguates a duplicated library name via the import graph", async () => {
    const files: SourceFile[] = await Promise.all(
      ["./__fixtures__/crossfile/IToken.sol", "./__fixtures__/crossfile/WrapLib.sol", "./__fixtures__/crossfile/UtilsA.sol", "./__fixtures__/crossfile/UtilsB.sol", "./__fixtures__/crossfile/Caller.sol"].map(load),
    );
    const result = analyzeSources({ files, contractName: "Caller", abi: [], address: "0x9" });

    const doWrap = result.functions.find((f) => f.name === "doWrap")!;
    expect(doWrap).toBeDefined();
    const wrapCall = doWrap.externalCalls.find((c) => c.functionName === "wrap");
    expect(wrapCall).toBeDefined();
    expect(wrapCall!.signature).toBe("wrap(uint256)");
    expect(wrapCall!.selector).toBe("0xea598cb0");
    expect(wrapCall!.callType).toBe("call");
    expect(doWrap.internalCalls.some((c) => c.kind === "library" && c.declaredIn === "WrapLib")).toBe(true);

    const readTag = result.functions.find((f) => f.name === "readTag")!;
    expect(readTag).toBeDefined();
    expect(readTag.internalCalls.some((c) => c.kind === "library" && c.name === "tag" && c.declaredIn === "Utils")).toBe(true);
    // Caller.sol imports Utils from UtilsA.sol only: the resolved call site must land in UtilsA, not UtilsB.
    expect(readTag.externalCalls.some((c) => c.functionName === "markA")).toBe(true);
    expect(readTag.externalCalls.some((c) => c.functionName === "markB")).toBe(false);
  });
});

describe("explicit library call form", () => {
  test("resolves Lib.fn(receiver, ...) with the destination substituted back to the caller's argument", async () => {
    const files: SourceFile[] = await Promise.all(
      ["./__fixtures__/safelib/IERC20Like.sol", "./__fixtures__/safelib/SafeERC20Like.sol", "./__fixtures__/safelib/Caller.sol"].map(load),
    );
    const result = analyzeSources({ files, contractName: "SafeCaller", abi: [], address: "0xa" });

    const run = result.functions.find((f) => f.name === "run")!;
    expect(run).toBeDefined();
    const call = run.externalCalls.find((c) => c.functionName === "transferFrom");
    expect(call).toBeDefined();
    expect(call!.signature).toBe("transferFrom(address,address,uint256)");
    expect(call!.selector).toBe("0x23b872dd");
    expect(call!.callType).toBe("call");
    expect(call!.destination.kind).toBe("parameter");
    expect(call!.destination.name).toBe("tokenArg");
    expect(run.internalCalls.some((c) => c.kind === "library" && c.declaredIn === "SafeERC20Like")).toBe(true);
  });
});

describe("three hop library chain", () => {
  test("finds an external call three internal hops deep inside one library", async () => {
    const files: SourceFile[] = await Promise.all(["./__fixtures__/chainlib/ChainLib.sol", "./__fixtures__/chainlib/Caller.sol"].map(load));
    const result = analyzeSources({ files, contractName: "ChainCaller", abi: [], address: "0xb" });

    const run = result.functions.find((f) => f.name === "run")!;
    expect(run).toBeDefined();
    const call = run.externalCalls.find((c) => c.functionName === "transferFrom");
    expect(call).toBeDefined();
    expect(call!.signature).toBe("transferFrom(address,address,uint256)");
    expect(call!.selector).toBe("0x23b872dd");
    expect(call!.via).toEqual(["ChainLib.hop1", "hop2", "hop3"]);
    expect(call!.destination.kind).toBe("parameter");
    expect(call!.destination.name).toBe("token");
  });
});
