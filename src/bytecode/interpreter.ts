/**
 * A bounded abstract interpreter over decoded instructions.
 *
 * `cfg.ts` resolves a jump only when the instruction right before it is a
 * literal `PUSH` of the target, which covers the dispatcher's own compare
 * chain. A function body is not that simple: solc's internal-call
 * convention stages a return address several instructions before the call,
 * ferries it through `DUP`/`SWAP`, and the callee's own `JUMP` reads it back
 * off the stack. Naive one-instruction lookback cannot see through that, so
 * the walk would give up at the first helper call, before the `SSTORE` that
 * follows it in the caller's body.
 *
 * This interpreter tracks the EVM stack symbolically along one DFS path: a
 * value is a known constant when it demonstrably came from a `PUSH` (through
 * any number of `DUP`/`SWAP`), and `undefined` the moment it touches
 * anything else (arithmetic, `SLOAD`, calldata, a hash, ...). A `JUMP`/
 * `JUMPI` resolves exactly when the value about to be popped as its target
 * is a known constant that is a real `JUMPDEST` — which is true for a
 * dispatcher compare, a forward call, and a callee's dynamic return alike,
 * without needing to special-case any of them.
 */

import type { Instruction } from "./decode";
import type { BytecodeFacts } from "../types";

type StackValue = bigint | undefined;

const CALL_OP = 0xf1;
const CALLCODE_OP = 0xf2; // deprecated, but it is a real external call, so it counts as one
const STATICCALL_OP = 0xfa;
const DELEGATECALL_OP = 0xf4;
const CREATE_OP = 0xf0;
const CREATE2_OP = 0xf5;
const SELFDESTRUCT_OP = 0xff;
const SLOAD_OP = 0x54;
const SSTORE_OP = 0x55;
const PUSH20_OP = 0x73;
const JUMP_OP = 0x56;
const JUMPI_OP = 0x57;
const PUSH0_OP = 0x5f;
const MLOAD_OP = 0x51;
const MSTORE_OP = 0x52;
/** 2**256, EVM's word size, used to wrap folded arithmetic the same way the real machine does. */
const WORD_MODULUS = 1n << 256n;

const ZERO_ADDRESS = "0".repeat(40);
const FULL_ADDRESS = "f".repeat(40);

/** `[itemsPopped, itemsPushed]` for every opcode this interpreter does not special-case. */
const STACK_EFFECT: Record<number, [number, number]> = {
  0x00: [0, 0], 0x04: [2, 1], 0x05: [2, 1], // 0x01 ADD, 0x02 MUL, 0x03 SUB are folded above
  0x06: [2, 1], 0x07: [2, 1], 0x08: [3, 1], 0x09: [3, 1], 0x0a: [2, 1], 0x0b: [2, 1],
  0x10: [2, 1], 0x11: [2, 1], 0x12: [2, 1], 0x13: [2, 1], 0x14: [2, 1], 0x15: [1, 1],
  0x16: [2, 1], 0x17: [2, 1], 0x18: [2, 1], 0x19: [1, 1], 0x1a: [2, 1], 0x1b: [2, 1], 0x1c: [2, 1], 0x1d: [2, 1],
  0x20: [2, 1],
  0x30: [0, 1], 0x31: [1, 1], 0x32: [0, 1], 0x33: [0, 1], 0x34: [0, 1],
  0x35: [1, 1], 0x36: [0, 1], 0x37: [3, 0], 0x38: [0, 1], 0x39: [3, 0],
  0x3a: [0, 1], 0x3b: [1, 1], 0x3c: [4, 0], 0x3d: [0, 1], 0x3e: [3, 0], 0x3f: [1, 1],
  0x40: [1, 1], 0x41: [0, 1], 0x42: [0, 1], 0x43: [0, 1], 0x44: [0, 1],
  0x45: [0, 1], 0x46: [0, 1], 0x47: [0, 1], 0x48: [0, 1], 0x49: [1, 1], 0x4a: [0, 1],
  0x50: [1, 0], 0x53: [2, 0], 0x54: [1, 1], 0x55: [2, 0], // 0x51 MLOAD, 0x52 MSTORE are special-cased below
  0x59: [0, 1], 0x5a: [0, 1], 0x5b: [0, 0], 0x5c: [1, 1], 0x5d: [2, 0], 0x5e: [3, 0], // 0x58 PC is special-cased below
  0xa0: [2, 0], 0xa1: [3, 0], 0xa2: [4, 0], 0xa3: [5, 0], 0xa4: [6, 0],
  0xf0: [3, 1], 0xf1: [7, 1], 0xf2: [7, 1], 0xf3: [2, 0], 0xf4: [6, 1],
  0xf5: [4, 1], 0xfa: [6, 1], 0xfd: [2, 0], 0xfe: [0, 0], 0xff: [1, 0],
};

/** Mutable accumulator threaded through one walk; turned into `BytecodeFacts` at the end. */
interface WalkState {
  readsStorage: boolean;
  writesStorage: boolean;
  makesCall: boolean;
  makesStaticcall: boolean;
  makesDelegatecall: boolean;
  createsContract: boolean;
  selfDestructs: boolean;
  addressConstants: Set<string>;
  eventTopics: Set<string>;
  storageSlots: Set<string>;
}

function newState(): WalkState {
  return {
    readsStorage: false,
    writesStorage: false,
    makesCall: false,
    makesStaticcall: false,
    makesDelegatecall: false,
    createsContract: false,
    selfDestructs: false,
    addressConstants: new Set(),
    eventTopics: new Set(),
    storageSlots: new Set(),
  };
}

/** Records facts for one instruction, reading `stack` before this instruction's own effect is applied. */
function recordInstruction(state: WalkState, instr: Instruction, stack: StackValue[]): void {
  if (instr.op >= 0xa0 && instr.op <= 0xa4) {
    // LOGn stack (top to bottom): offset, size, topic0, ..., topicN-1.
    const topicCount = instr.op - 0xa0;
    for (let t = 0; t < topicCount; t++) {
      const value = stack[stack.length - 3 - t];
      if (value !== undefined) state.eventTopics.add(`0x${value.toString(16).padStart(64, "0")}`);
    }
    return;
  }
  switch (instr.op) {
    case SLOAD_OP: {
      state.readsStorage = true;
      const slot = stack[stack.length - 1];
      if (slot !== undefined) state.storageSlots.add(`0x${slot.toString(16)}`);
      break;
    }
    case SSTORE_OP: {
      state.writesStorage = true;
      const slot = stack[stack.length - 1];
      if (slot !== undefined) state.storageSlots.add(`0x${slot.toString(16)}`);
      break;
    }
    case CALL_OP:
    case CALLCODE_OP:
      state.makesCall = true;
      break;
    case STATICCALL_OP:
      state.makesStaticcall = true;
      break;
    case DELEGATECALL_OP:
      state.makesDelegatecall = true;
      break;
    case CREATE_OP:
    case CREATE2_OP:
      state.createsContract = true;
      break;
    case SELFDESTRUCT_OP:
      state.selfDestructs = true;
      break;
    case PUSH20_OP: {
      const operand = instr.operand;
      if (operand && operand !== ZERO_ADDRESS && operand !== FULL_ADDRESS) state.addressConstants.add(`0x${operand}`);
      break;
    }
    default:
      break;
  }
}

function toFacts(state: WalkState, blocksWalked: number, truncated: boolean): BytecodeFacts {
  return {
    readsStorage: state.readsStorage,
    writesStorage: state.writesStorage,
    makesCall: state.makesCall,
    makesStaticcall: state.makesStaticcall,
    makesDelegatecall: state.makesDelegatecall,
    createsContract: state.createsContract,
    selfDestructs: state.selfDestructs,
    addressConstants: [...state.addressConstants].sort(),
    eventTopics: [...state.eventTopics].sort(),
    storageSlots: [...state.storageSlots].sort(),
    blocksWalked,
    truncated,
  };
}

/** Compact signature of a stack's shape, used to stop revisiting a program point in the same abstract state. */
function signatureOf(stack: StackValue[]): string {
  const depth = 16; // deeper items rarely affect a near-term jump target; capping keeps signatures cheap
  const visible = stack.slice(Math.max(0, stack.length - depth));
  return `${stack.length}:${visible.map((v) => (v === undefined ? "u" : v.toString(16))).join(",")}`;
}

function applyDup(stack: StackValue[], n: number): void {
  const index = stack.length - n;
  stack.push(index >= 0 ? stack[index] : undefined);
}

function applySwap(stack: StackValue[], n: number): void {
  const top = stack.length - 1;
  const other = top - n;
  if (other < 0 || top < 0) return;
  const topValue = stack[top];
  const otherValue = stack[other];
  stack[top] = otherValue;
  stack[other] = topValue;
}

interface Frame {
  /** Index into the shared `instructions` array. */
  index: number;
  stack: StackValue[];
  /**
   * Known-constant 32-byte memory words, keyed by hex offset. Vyper stores
   * an internal call's return address here instead of only on the stack
   * (confirmed on Curve 3pool: `PC; ADD; ...; MSTORE`, read back later
   * with `MLOAD; JUMP`); tracking it is what lets the walk see past that
   * return the same way it already sees past a stack-carried one.
   */
  memory: Map<string, bigint>;
}

/**
 * Walks code reachable from `entryPc`, resolving every jump by tracking the
 * stack instead of only looking at the previous instruction. Distinct
 * program points reached are capped at `blockCap`; `truncated` is set when
 * that cap is hit or a jump's target is genuinely not a known constant.
 */
export function walkFromEntry(instructions: Instruction[], jumpdests: Set<number>, entryPc: number, blockCap = 400): BytecodeFacts {
  const indexByPc = new Map<number, number>();
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (instr) indexByPc.set(instr.pc, i);
  }

  const startIndex = indexByPc.get(entryPc);
  if (startIndex === undefined) return toFacts(newState(), 0, true);

  const state = newState();
  const seenPoints = new Set<number>(); // distinct pcs entered at the top of a straight-line run
  const seenSignatures = new Map<number, Set<string>>(); // per-pc, abstract states already explored
  // A pc entered many times, each with a distinct signature, indicates a
  // loop whose stack never re-settles under this abstract interpretation
  // (e.g. a value this interpreter cannot fold stays "unknown" but still
  // shifts the stack depth on every iteration). Signature dedup alone
  // cannot terminate that; a hard cap per pc does, at the cost of treating
  // the walk as truncated once it fires.
  const visitCountByPc = new Map<number, number>();
  const maxVisitsPerPc = 20;
  const stepCap = blockCap * 64; // bounds total work when a loop keeps producing "new" abstract states
  let steps = 0;
  let truncated = false;

  const stack: Frame[] = [{ index: startIndex, stack: [], memory: new Map() }];

  while (stack.length > 0) {
    if (seenPoints.size >= blockCap) { truncated = true; break; }
    if (steps++ >= stepCap) { truncated = true; break; }
    const frame = stack.pop();
    if (!frame) continue;
    const startInstr = instructions[frame.index];
    if (!startInstr) continue;

    const visits = (visitCountByPc.get(startInstr.pc) ?? 0) + 1;
    visitCountByPc.set(startInstr.pc, visits);
    if (visits > maxVisitsPerPc) { truncated = true; continue; }

    let signatures = seenSignatures.get(startInstr.pc);
    if (!signatures) { signatures = new Set(); seenSignatures.set(startInstr.pc, signatures); }
    const signature = signatureOf(frame.stack);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    seenPoints.add(startInstr.pc);

    let index = frame.index;
    const vstack = frame.stack;
    const memory = frame.memory;
    for (;;) {
      const instr = instructions[index];
      if (!instr) break;
      recordInstruction(state, instr, vstack);

      if (instr.op === JUMP_OP) {
        const dest = vstack.pop();
        const nextIndex = dest !== undefined ? indexByPc.get(Number(dest)) : undefined;
        if (dest !== undefined && jumpdests.has(Number(dest)) && nextIndex !== undefined) {
          stack.push({ index: nextIndex, stack: [...vstack], memory: new Map(memory) });
        } else {
          truncated = true;
        }
        break;
      }
      if (instr.op === JUMPI_OP) {
        const dest = vstack.pop();
        vstack.pop(); // condition; both outcomes are explored statically, so its value does not matter here
        const nextIndex = dest !== undefined ? indexByPc.get(Number(dest)) : undefined;
        if (dest !== undefined && jumpdests.has(Number(dest)) && nextIndex !== undefined) {
          stack.push({ index: nextIndex, stack: [...vstack], memory: new Map(memory) });
        } else {
          truncated = true;
        }
        const fallthroughIndex = index + 1;
        if (instructions[fallthroughIndex]) stack.push({ index: fallthroughIndex, stack: [...vstack], memory: new Map(memory) });
        break;
      }
      if (instr.op === 0x00 || instr.op === 0xf3 || instr.op === 0xfd || instr.op === 0xfe || instr.op === SELFDESTRUCT_OP) {
        break; // STOP / RETURN / REVERT / INVALID / SELFDESTRUCT: this path ends normally
      }
      if (instr.op === PUSH0_OP) { vstack.push(0n); index++; continue; }
      // PC pushes the program counter of this very instruction. It looks
      // dynamic, but solc/Vyper both use `PC; ADD` as a smaller encoding
      // of a literal return-address constant (confirmed on Curve 3pool,
      // `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7`), so its value is
      // always known at analysis time, exactly like a `PUSH`.
      if (instr.op === 0x58) { vstack.push(BigInt(instr.pc)); index++; continue; }
      if (instr.op === MLOAD_OP) {
        const addr = vstack.pop();
        const key = addr !== undefined ? addr.toString(16) : undefined;
        vstack.push(key !== undefined ? memory.get(key) : undefined);
        index++;
        continue;
      }
      if (instr.op === MSTORE_OP) {
        const addr = vstack.pop();
        const value = vstack.pop();
        if (addr === undefined) {
          // A write to an unresolvable address could clobber anything already tracked.
          memory.clear();
        } else {
          const key = addr.toString(16);
          if (value === undefined) memory.delete(key);
          else memory.set(key, value);
        }
        index++;
        continue;
      }
      // ADD/SUB/MUL fold to a known constant when both operands are known.
      // solc/Vyper both compute an internal-call return address as `PC` (or
      // a literal) combined with `ADD`/`SUB`; without folding, the generic
      // opcode table below would discard that constant and turn every such
      // return into an unresolvable dynamic jump.
      if (instr.op === 0x01 || instr.op === 0x02 || instr.op === 0x03) {
        const a = vstack.pop();
        const b = vstack.pop();
        let result: StackValue;
        if (a !== undefined && b !== undefined) {
          const raw = instr.op === 0x01 ? a + b : instr.op === 0x02 ? a * b : a - b;
          result = ((raw % WORD_MODULUS) + WORD_MODULUS) % WORD_MODULUS;
        }
        vstack.push(result);
        index++;
        continue;
      }
      if (instr.op >= 0x60 && instr.op <= 0x7f) { // PUSH1-PUSH32
        vstack.push(instr.operand !== undefined ? BigInt(`0x${instr.operand}`) : undefined);
        index++;
        continue;
      }
      if (instr.op >= 0x80 && instr.op <= 0x8f) { applyDup(vstack, instr.op - 0x7f); index++; continue; } // DUP1-16
      if (instr.op >= 0x90 && instr.op <= 0x9f) { applySwap(vstack, instr.op - 0x8f); index++; continue; } // SWAP1-16

      const [popCount, pushCount] = STACK_EFFECT[instr.op] ?? [0, 0];
      for (let p = 0; p < popCount; p++) vstack.pop();
      for (let p = 0; p < pushCount; p++) vstack.push(undefined);
      index++;
    }
  }

  return toFacts(state, seenPoints.size, truncated);
}
