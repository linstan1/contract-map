/**
 * Reads `BytecodeFacts` off the whole contract, in code order, regardless
 * of reachability. Per-selector facts come from `interpreter.ts` instead,
 * which needs a real stack simulation to see past internal calls; this
 * scan is the simpler, path-agnostic union used when there is no resolved
 * entry point to walk from at all.
 */

import type { Instruction } from "./decode";
import type { BytecodeFacts } from "../types";


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
const PUSH32_OP = 0x7f;

const ZERO_ADDRESS = "0".repeat(40);
const FULL_ADDRESS = "f".repeat(40);

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
  /** `PUSH32` values seen since the last `LOG`, most recent last, capped at 4 (the most topics a `LOG4` takes). */
  pendingTopics: string[];
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
    pendingTopics: [],
  };
}

/** Records the literal operand of the instruction right before an `SLOAD`/`SSTORE`, when there is one. */
function recordSlotBefore(state: WalkState, instructions: Instruction[], index: number): void {
  const prev = instructions[index - 1];
  if (!prev) return;
  if (prev.op === 0x5f) { state.storageSlots.add("0x0"); return; } // PUSH0
  if (prev.op < 0x60 || prev.op > 0x7f || prev.operand === undefined) return; // PUSH1-PUSH32 only
  state.storageSlots.add(`0x${BigInt(`0x${prev.operand}`).toString(16)}`);
}

/** Feeds one instruction sequence into `state`, in code order. */
function scan(state: WalkState, instructions: Instruction[]): void {
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (!instr) continue;
    switch (instr.op) {
      case SLOAD_OP:
        state.readsStorage = true;
        recordSlotBefore(state, instructions, i);
        break;
      case SSTORE_OP:
        state.writesStorage = true;
        recordSlotBefore(state, instructions, i);
        break;
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
      case PUSH32_OP:
        if (instr.operand !== undefined) {
          state.pendingTopics.push(`0x${instr.operand}`);
          if (state.pendingTopics.length > 4) state.pendingTopics.shift();
        }
        break;
      case 0xa1: case 0xa2: case 0xa3: case 0xa4: { // LOG1-LOG4
        const topicCount = instr.op - 0xa0;
        const topics = state.pendingTopics.splice(Math.max(0, state.pendingTopics.length - topicCount));
        for (const t of topics) state.eventTopics.add(t);
        break;
      }
      default:
        break;
    }
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

/**
 * Facts over every instruction in the contract, in code order, regardless of
 * reachability. This is what still describes a contract with no resolvable
 * dispatcher: nothing here depends on finding a jump target.
 */
export function factsOverContract(instructions: Instruction[], blockCount: number): BytecodeFacts {
  const state = newState();
  scan(state, instructions);
  return toFacts(state, blockCount, false);
}
