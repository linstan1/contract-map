import { describe, expect, test } from "bun:test";
import { decodeRuntime } from "./decode";
import { walkFromEntry } from "./interpreter";
import { analyzeBytecode } from "./index";

/*
 * A minimal two-pass assembler for hand-built EVM fixtures. It exists only
 * in this test file: production code never assembles bytecode, it only
 * reads it. Labels let a fixture reference a jump target by name instead of
 * a hand-counted program counter, which is where real test bugs hide.
 */
type Item =
  | { k: "op"; op: number }
  | { k: "push"; width: number; value: string }
  | { k: "pushLabel"; width: number; label: string }
  | { k: "label"; name: string };

function assemble(items: Item[]): string {
  const labelPc: Record<string, number> = {};
  let pc = 0;
  for (const item of items) {
    if (item.k === "label") { labelPc[item.name] = pc; continue; }
    if (item.k === "op") { pc += 1; continue; }
    pc += 1 + item.width;
  }
  let hex = "";
  for (const item of items) {
    if (item.k === "label") continue;
    if (item.k === "op") { hex += item.op.toString(16).padStart(2, "0"); continue; }
    const opcode = 0x5f + item.width; // PUSH<width>
    hex += opcode.toString(16).padStart(2, "0");
    if (item.k === "push") {
      hex += item.value.padStart(item.width * 2, "0");
    } else {
      const target = labelPc[item.label];
      if (target === undefined) throw new Error(`assemble: unknown label ${item.label}`);
      hex += target.toString(16).padStart(item.width * 2, "0");
    }
  }
  return `0x${hex}`;
}

const OP = (op: number): Item => ({ k: "op", op });
const PUSH = (width: number, value: string): Item => ({ k: "push", width, value });
const PUSHL = (width: number, label: string): Item => ({ k: "pushLabel", width, label });
const LABEL = (name: string): Item => ({ k: "label", name });

const JUMPDEST = 0x5b, JUMP = 0x56, JUMPI = 0x57, DUP1 = 0x80, EQ = 0x14, GT = 0x11;
const SLOAD = 0x54, SSTORE = 0x55, STOP = 0x00, REVERT = 0xfd, POP = 0x50;
const CALLDATALOAD = 0x35, SHR = 0x1c, LOG3 = 0xa3;

describe("decodeRuntime metadata trailer", () => {
  test("excludes a trailing CBOR map from the instruction stream", () => {
    // STOP, then a synthetic trailer: CBOR map header 0xa1 (1 entry), two
    // filler bytes, and the 2-byte big-endian length (3) solc appends.
    const code = "0x00a101020003";
    const { instructions, trailer } = decodeRuntime(code);
    expect(trailer).toBeDefined();
    expect(trailer!.offset).toBe(1);
    expect(trailer!.length).toBe(5);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.mnemonic).toBe("STOP");
  });

  test("decodes the full range when no trailer is present", () => {
    const code = assemble([OP(STOP)]);
    const { instructions, trailer } = decodeRuntime(code);
    expect(trailer).toBeUndefined();
    expect(instructions).toHaveLength(1);
  });
});

describe("walkFromEntry", () => {
  test("follows a chain of static JUMPs and collects facts at the end", () => {
    const code = assemble([
      PUSHL(2, "mid"),
      OP(JUMP),
      LABEL("mid"),
      OP(JUMPDEST),
      PUSHL(2, "end"),
      OP(JUMP),
      LABEL("end"),
      OP(JUMPDEST),
      PUSH(1, "09"), // value
      PUSH(1, "03"), // slot
      OP(SSTORE),
      OP(STOP),
    ]);
    const { instructions, jumpdests } = decodeRuntime(code);
    const facts = walkFromEntry(instructions, jumpdests, 0);
    expect(facts.truncated).toBe(false);
    expect(facts.blocksWalked).toBe(3);
    expect(facts.writesStorage).toBe(true);
    expect(facts.storageSlots).toEqual(["0x3"]);
  });

  test("a dynamic JUMP ends the walk and sets truncated", () => {
    const code = assemble([PUSH(1, "00"), OP(CALLDATALOAD), OP(JUMP)]);
    const { instructions, jumpdests } = decodeRuntime(code);
    const facts = walkFromEntry(instructions, jumpdests, 0);
    expect(facts.truncated).toBe(true);
    expect(facts.blocksWalked).toBe(1);
  });

  test("collects a PUSH20 address constant and drops zero/all-ff placeholders", () => {
    const code = assemble([
      PUSH(20, "1111111111111111111111111111111111111111"),
      OP(POP),
      PUSH(20, "0000000000000000000000000000000000000000"),
      OP(POP),
      PUSH(20, "ffffffffffffffffffffffffffffffffffffffff"),
      OP(POP),
      OP(STOP),
    ]);
    const { instructions, jumpdests } = decodeRuntime(code);
    const facts = walkFromEntry(instructions, jumpdests, 0);
    expect(facts.addressConstants).toEqual(["0x1111111111111111111111111111111111111111"]);
  });

  test("attaches a PUSH32 constant to eventTopics when a LOG3 follows it", () => {
    const topic0 = "11".repeat(32);
    const topic1 = "22".repeat(32);
    const topic2 = "33".repeat(32);
    const code = assemble([
      PUSH(32, topic0),
      PUSH(32, topic1),
      PUSH(32, topic2),
      PUSH(1, "00"), // memory offset
      PUSH(1, "00"), // memory size
      OP(LOG3),
      OP(STOP),
    ]);
    const { instructions, jumpdests } = decodeRuntime(code);
    const facts = walkFromEntry(instructions, jumpdests, 0);
    expect(facts.eventTopics.sort()).toEqual([`0x${topic0}`, `0x${topic1}`, `0x${topic2}`].sort());
  });
});

describe("analyzeBytecode", () => {
  const SEL_A = "0xaaaaaaaa";
  const SEL_B = "0xbbbbbbbb";

  // A linear dispatcher: selector A writes storage only, selector B reads only.
  const linearDispatcher = assemble([
    PUSH(1, "00"),
    OP(CALLDATALOAD),
    PUSH(1, "e0"),
    OP(SHR),
    OP(DUP1),
    PUSH(4, "aaaaaaaa"),
    OP(EQ),
    PUSHL(2, "fnA"),
    OP(JUMPI),
    OP(DUP1),
    PUSH(4, "bbbbbbbb"),
    OP(EQ),
    PUSHL(2, "fnB"),
    OP(JUMPI),
    PUSH(1, "00"),
    PUSH(1, "00"),
    OP(REVERT),
    LABEL("fnA"),
    OP(JUMPDEST),
    PUSH(1, "05"), // value
    PUSH(1, "01"), // slot
    OP(SSTORE),
    OP(STOP),
    LABEL("fnB"),
    OP(JUMPDEST),
    PUSH(1, "02"), // slot
    OP(SLOAD),
    OP(STOP),
  ]);

  test("resolves both linear-dispatcher selectors to disjoint facts", () => {
    const result = analyzeBytecode(linearDispatcher, [SEL_A, SEL_B]);
    expect(result.facts[SEL_A]?.writesStorage).toBe(true);
    expect(result.facts[SEL_A]?.readsStorage).toBe(false);
    expect(result.facts[SEL_A]?.storageSlots).toEqual(["0x1"]);
    expect(result.facts[SEL_B]?.readsStorage).toBe(true);
    expect(result.facts[SEL_B]?.writesStorage).toBe(false);
    expect(result.facts[SEL_B]?.storageSlots).toEqual(["0x2"]);
    expect(result.dispatcherSelectors.sort()).toEqual([SEL_A, SEL_B].sort());
    expect(result.warnings.some((w) => w.includes("Excluded"))).toBe(false);
  });

  test("skips a selector with no dispatcher branch and warns instead of guessing", () => {
    const result = analyzeBytecode(linearDispatcher, [SEL_A, "0xdeadbeef"]);
    expect(result.facts["0xdeadbeef"]).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("0xdeadbeef"))).toBe(true);
  });

  test("resolves a binary-search dispatcher by comparing the target selector against the pivot", () => {
    const SEL_LOW = "0x10000001"; // below the pivot
    const SEL_MID = "0x20000000"; // pivot, never itself an EQ leaf
    const SEL_HIGH = "0x30000000"; // at or above the pivot
    // The dispatcher duplicates the selector, then pushes the pivot on top of
    // it, so `GT` computes `pivot > selector`. Its `JUMPI` therefore fires
    // when the selector is BELOW the pivot; the fallthrough path handles
    // everything at or above it. This mirrors real solc-emitted dispatchers.
    const code = assemble([
      PUSH(1, "00"),
      OP(CALLDATALOAD),
      PUSH(1, "e0"),
      OP(SHR),
      OP(DUP1),
      PUSH(4, "20000000"),
      OP(GT),
      PUSHL(2, "belowPivot"),
      OP(JUMPI),
      // at-or-above-pivot subtree, reached by fallthrough
      OP(DUP1),
      PUSH(4, "30000000"),
      OP(EQ),
      PUSHL(2, "fnHigh"),
      OP(JUMPI),
      PUSH(1, "00"),
      PUSH(1, "00"),
      OP(REVERT),
      LABEL("belowPivot"),
      OP(JUMPDEST),
      OP(DUP1),
      PUSH(4, "10000001"),
      OP(EQ),
      PUSHL(2, "fnLow"),
      OP(JUMPI),
      PUSH(1, "00"),
      PUSH(1, "00"),
      OP(REVERT),
      LABEL("fnLow"),
      OP(JUMPDEST),
      PUSH(1, "07"),
      OP(SLOAD),
      OP(STOP),
      LABEL("fnHigh"),
      OP(JUMPDEST),
      PUSH(1, "08"),
      OP(SLOAD),
      OP(STOP),
    ]);
    const result = analyzeBytecode(code, [SEL_LOW, SEL_HIGH, SEL_MID]);
    expect(result.facts[SEL_LOW]?.storageSlots).toEqual(["0x7"]);
    expect(result.facts[SEL_HIGH]?.storageSlots).toEqual(["0x8"]);
    // the pivot value is never compared with EQ, so it has no leaf to attach to
    expect(result.facts[SEL_MID]).toBeUndefined();
    expect(result.warnings.some((w) => w.includes(SEL_MID))).toBe(true);
  });

  test("still yields contract-wide facts and reports the trailer when a dispatcher has no selectors", () => {
    const code = "0x00a101020003"; // STOP, plus the synthetic trailer from above
    const result = analyzeBytecode(code, []);
    expect(result.warnings.some((w) => w.includes("metadata trailer"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("No selector dispatcher"))).toBe(true);
    expect(result.contract.blocksWalked).toBe(1);
    expect(result.contract.writesStorage).toBe(false);
    expect(result.dispatcherSelectors).toEqual([]);
  });
});
