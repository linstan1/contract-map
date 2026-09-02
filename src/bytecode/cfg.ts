/**
 * Basic-block control-flow graph over decoded EVM instructions.
 *
 * A block starts at program counter 0, at every `JUMPDEST`, and right after
 * every instruction that can end a block (`JUMP`, `JUMPI`, `STOP`, `RETURN`,
 * `REVERT`, `INVALID`, `SELFDESTRUCT`). A jump target resolves only when the
 * instruction right before the jump is a `PUSH` of a program counter that is
 * a real `JUMPDEST`, which is what solc emits for a static jump. Anything
 * else is a dynamic jump: the walk of that path stops there.
 */

import type { Instruction } from "./decode";

const TERMINATOR_OPS = new Set([0x00, 0x56, 0x57, 0xf3, 0xfd, 0xfe, 0xff]); // STOP JUMP JUMPI RETURN REVERT INVALID SELFDESTRUCT

export type Terminator = "jump" | "jumpi" | "stop" | "return" | "revert" | "invalid" | "selfdestruct" | "fallthrough";

export interface Block {
  start: number;
  instructions: Instruction[];
  terminator: Terminator;
  /** Static target of a `JUMP`/`JUMPI`, or the fallthrough target. Absent when there is none. */
  jumpTarget?: number;
  /** `true` when a `JUMP`/`JUMPI` here could not be resolved to a static target. */
  jumpDynamic?: boolean;
  /** Next block for the non-taken path: the `JUMPI` false branch, or plain flow-through. */
  fallthrough?: number;
}

/** Checks whether the instruction right before `at` is a `PUSH` of a valid `JUMPDEST`. */
function resolveStaticTarget(instructions: Instruction[], at: number, jumpdests: Set<number>): number | undefined {
  const prev = instructions[at - 1];
  if (!prev || prev.op < 0x60 || prev.op > 0x7f || prev.operand === undefined) return undefined; // PUSH1-PUSH32 only
  const dest = parseInt(prev.operand, 16);
  return jumpdests.has(dest) ? dest : undefined;
}

/** Builds the basic-block graph, keyed by each block's starting program counter. */
export function buildBlocks(instructions: Instruction[], jumpdests: Set<number>): Map<number, Block> {
  const blocks = new Map<number, Block>();
  if (instructions.length === 0) return blocks;

  const indexByPc = new Map<number, number>();
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (instr) indexByPc.set(instr.pc, i);
  }

  const leaders = new Set<number>([0]);
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    if (!instr) continue;
    if (instr.op === 0x5b) leaders.add(instr.pc); // JUMPDEST
    if (TERMINATOR_OPS.has(instr.op)) {
      const next = instructions[i + 1];
      if (next) leaders.add(next.pc);
    }
  }

  const leaderList = [...leaders].sort((a, b) => a - b);
  for (let li = 0; li < leaderList.length; li++) {
    const start = leaderList[li];
    if (start === undefined) continue;
    const startIndex = indexByPc.get(start);
    if (startIndex === undefined) continue; // a leader pc that landed mid-operand; skip, it is not reachable code
    const nextLeaderPc = leaderList[li + 1];
    const endIndex = nextLeaderPc === undefined ? instructions.length : (indexByPc.get(nextLeaderPc) ?? instructions.length);
    const blockInstructions = instructions.slice(startIndex, endIndex);
    if (blockInstructions.length === 0) continue;

    const lastGlobalIndex = endIndex - 1;
    const last = instructions[lastGlobalIndex];

    const block: Block = { start, instructions: blockInstructions, terminator: "fallthrough" };
    switch (last?.op) {
      case 0x56: // JUMP
        block.terminator = "jump";
        block.jumpTarget = resolveStaticTarget(instructions, lastGlobalIndex, jumpdests);
        block.jumpDynamic = block.jumpTarget === undefined;
        break;
      case 0x57: { // JUMPI
        block.terminator = "jumpi";
        block.jumpTarget = resolveStaticTarget(instructions, lastGlobalIndex, jumpdests);
        block.jumpDynamic = block.jumpTarget === undefined;
        const next = instructions[lastGlobalIndex + 1];
        if (next) block.fallthrough = next.pc;
        break;
      }
      case 0x00: block.terminator = "stop"; break;
      case 0xf3: block.terminator = "return"; break;
      case 0xfd: block.terminator = "revert"; break;
      case 0xfe: block.terminator = "invalid"; break;
      case 0xff: block.terminator = "selfdestruct"; break;
      default: {
        block.terminator = "fallthrough";
        const next = instructions[lastGlobalIndex + 1];
        if (next) block.fallthrough = next.pc;
        break;
      }
    }
    blocks.set(start, block);
  }
  return blocks;
}
