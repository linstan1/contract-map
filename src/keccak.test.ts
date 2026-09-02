import { expect, test } from "bun:test";
import { keccak256 } from "./keccak";
import { bytecodeSelectors, selectorOf, signatureOf } from "./abi";

test("keccak256 matches published vectors", () => {
  expect(keccak256("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  expect(keccak256("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // Longer than the 136 byte rate, so the multi block path is covered.
  // Reference digest from pycryptodome: keccak.new(digest_bits=256).update(b"a" * 200).
  expect(keccak256("a".repeat(200))).toBe("0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
});

test("selectors match well known values", () => {
  expect(selectorOf("transfer(address,uint256)")).toBe("0xa9059cbb");
  expect(selectorOf("transferFrom(address,address,uint256)")).toBe("0x23b872dd");
  expect(selectorOf("deposit(uint256,address)")).toBe("0x6e553f65");
  expect(selectorOf("balanceOf(address)")).toBe("0x70a08231");
  expect(selectorOf("totalAssets()")).toBe("0x01e1d114");
});

test("signatureOf expands tuples and arrays", () => {
  const signature = signatureOf({
    type: "function",
    name: "supply",
    inputs: [
      {
        type: "tuple",
        name: "marketParams",
        components: [
          { type: "address", name: "loanToken" },
          { type: "address", name: "collateralToken" },
          { type: "uint256", name: "lltv" },
        ],
      },
      { type: "uint256[]", name: "amounts" },
    ],
  });
  expect(signature).toBe("supply((address,address,uint256),uint256[])");
});

test("bytecode scan keeps dispatcher selectors and drops other four byte constants", () => {
  // PUSH4 transfer, EQ: a linear dispatcher comparison.
  expect(bytecodeSelectors("0x63a9059cbb14")).toEqual(["0xa9059cbb"]);
  // DUP1 between the push and the comparison, as solc emits it.
  expect(bytecodeSelectors("0x63a9059cbb8014")).toEqual(["0xa9059cbb"]);
  // PUSH4 balanceOf, GT: the binary search form of a large dispatcher.
  expect(bytecodeSelectors("0x6370a0823111")).toEqual(["0x70a08231"]);
  // A custom error code is also pushed as four bytes. It feeds MSTORE and
  // REVERT, never a comparison, so it must not enter the function list.
  expect(bytecodeSelectors("0x639fabe1c15260fd")).toEqual([]);
  // PUSH2 0x63aa: the operand must not be read as an opcode.
  expect(bytecodeSelectors("0x6163aa14")).toEqual([]);
});
