import { describe, expect, test } from "bun:test";
import { analyzeVyperSources } from "./index";
import { selectorOf, signatureOf } from "../abi";
import type { AbiEntry, SourceFile } from "../types";

async function load(path: string): Promise<SourceFile> {
  const content = await Bun.file(new URL(path, import.meta.url)).text();
  return { path, content };
}

describe("0.3-style token", () => {
  test("walks the internal call graph, resolves the getter, and gates the admin setter", async () => {
    const file = await load("./__fixtures__/token03.vy");
    const result = analyzeVyperSources({ files: [file], contractName: "Token03", abi: [], address: "0x1" });

    const names = result.functions.map((f) => f.name).sort();
    expect(names).toEqual(["balanceOf", "set_owner", "totalSupply", "transfer"].sort());

    const transfer = result.functions.find((f) => f.name === "transfer")!;
    expect(transfer.signature).toBe("transfer(address,uint256)");
    expect(transfer.selector).toBe(selectorOf("transfer(address,uint256)"));
    expect(transfer.access.kind).toBe("open");
    expect(transfer.internalCalls.map((c) => c.name)).toEqual(["_move"]);
    expect(transfer.writes.map((w) => w.name)).toEqual(["balanceOf"]);
    expect(transfer.writes[0]!.via).toEqual(["_move"]);
    expect(transfer.events).toEqual(["Transfer(address,address,uint256)"]);

    const setOwner = result.functions.find((f) => f.name === "set_owner")!;
    expect(setOwner.access.kind).toBe("owner");
    expect(setOwner.access.detail).toContain("self.owner");
    expect(setOwner.writes.map((w) => w.name)).toEqual(["owner"]);

    const balanceOfGetter = result.functions.find((f) => f.name === "balanceOf")!;
    expect(balanceOfGetter.signature).toBe("balanceOf(address)");
    expect(balanceOfGetter.outputs[0]!.type).toBe("uint256");
    expect(balanceOfGetter.notes[0]).toContain("Vyper generated this getter");

    const totalSupplyGetter = result.functions.find((f) => f.name === "totalSupply")!;
    expect(totalSupplyGetter.signature).toBe("totalSupply()");
    expect(totalSupplyGetter.mutability).toBe("view");
  });
});

describe("0.4-style contract", () => {
  test("resolves extcall/staticcall, a state-var interface call, and both raw_call shapes", async () => {
    const file = await load("./__fixtures__/contract04.vy");
    const result = analyzeVyperSources({ files: [file], contractName: "Contract04", abi: [], address: "0x2" });

    const sweep = result.functions.find((f) => f.name === "sweep")!;
    expect(sweep.access.kind).toBe("restricted");
    const sweepCall = sweep.externalCalls.find((c) => c.functionName === "transfer")!;
    expect(sweepCall.callType).toBe("call");
    expect(sweepCall.signature).toBe("transfer(address,uint256)");
    expect(sweepCall.selector).toBe(selectorOf("transfer(address,uint256)"));

    const balance = result.functions.find((f) => f.name === "balance")!;
    const balanceCall = balance.externalCalls.find((c) => c.functionName === "balanceOf")!;
    expect(balanceCall.callType).toBe("staticcall");
    expect(balanceCall.signature).toBe("balanceOf(address)");

    const sweepViaState = result.functions.find((f) => f.name === "sweep_via_state")!;
    const stateCall = sweepViaState.externalCalls.find((c) => c.functionName === "transfer")!;
    expect(stateCall.destination.kind).toBe("state");
    expect(stateCall.destination.name).toBe("vault");
    expect(stateCall.destination.contractType).toBe("ERC20");
    expect(stateCall.signature).toBe("transfer(address,uint256)");

    const rawTransfer = result.functions.find((f) => f.name === "raw_transfer")!;
    const rawCall = rawTransfer.externalCalls.find((c) => c.destExpr === "raw_call(...)")!;
    expect(rawCall.signature).toBe("transfer(address,uint256)");
    expect(rawCall.selector).toBe(selectorOf("transfer(address,uint256)"));
    expect(rawCall.callType).toBe("call");

    const rawDynamic = result.functions.find((f) => f.name === "raw_dynamic")!;
    const dynamicCall = rawDynamic.externalCalls.find((c) => c.destExpr === "raw_call(...)")!;
    expect(dynamicCall.callType).toBe("dynamic");
    expect(dynamicCall.selector).toBeUndefined();
    expect(rawDynamic.notes.some((n) => n.includes("dynamically computed calldata"))).toBe(true);
  });

  test("reconciles against the ABI: adopts real selectors and reports an ABI entry with no source", async () => {
    const file = await load("./__fixtures__/contract04.vy");
    const abi: AbiEntry[] = [
      { type: "function", name: "sweep", inputs: [{ name: "_to", type: "address" }, { name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "balance", inputs: [{ name: "_who", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
      { type: "function", name: "sweep_via_state", inputs: [{ name: "_to", type: "address" }, { name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "raw_transfer", inputs: [{ name: "_target", type: "address" }, { name: "_to", type: "address" }, { name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "raw_dynamic", inputs: [{ name: "_target", type: "address" }, { name: "_data", type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "phantom", inputs: [], outputs: [], stateMutability: "view" },
    ];
    const result = analyzeVyperSources({ files: [file], contractName: "Contract04", abi, address: "0x2" });

    const names = result.functions.map((f) => f.name).sort();
    expect(names).toEqual(["balance", "phantom", "raw_dynamic", "raw_transfer", "sweep", "sweep_via_state", "token"].sort());

    const phantom = result.functions.find((f) => f.name === "phantom")!;
    expect(phantom.hasSource).toBe(false);
    expect(phantom.notes).toContain("no matching source declaration was found for this ABI entry");
    expect(phantom.selector).toBe(selectorOf(signatureOf(abi[6]!)));

    const sweep = result.functions.find((f) => f.name === "sweep")!;
    expect(sweep.hasSource).toBe(true);
    expect(sweep.selector).toBe(selectorOf("sweep(address,uint256)"));

    // Every selector the analyser returns must come from the ABI.
    const abiSelectors = new Set(abi.filter((e) => e.type === "function").map((e) => selectorOf(signatureOf(e))));
    for (const f of result.functions) if (f.selector) expect(abiSelectors.has(f.selector)).toBe(true);
  });
});
