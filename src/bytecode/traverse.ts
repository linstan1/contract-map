/**
 * Depth-first block traversal that understands solc's internal call
 * convention well enough to see past it.
 *
 * solc compiles every internal function call as: push a return address (a
 * `JUMPDEST` inside the caller), push the arguments, push the callee's
 * entry point, `JUMP`. The callee ends with a bare, dynamic `JUMP` that
 * pops that same return address back off the stack. A plain reachability
 * walk cannot follow that return `JUMP` — it has no static target — so it
 * would stop at the first helper call a function makes, long before any
 * `SLOAD`/`SSTORE` that follows the call in the caller's own body.
 *
 * This walk keeps a per-path stack of pending return addresses. A `JUMP`
 * block with an earlier `PUSH` of some other valid `JUMPDEST` still on the
 * stack is treated as a call, and that earlier value is pushed as the
 * return address for this path. A dynamic `JUMP` then resumes at the
 * innermost pending return address instead of ending the path. Only a
 * dynamic `JUMP` with nothing pending is a genuine dead end.
 */

import type { Block } from "./cfg";
import type { Instruction } from "./decode";

export interface TraverseResult {
  /** Distinct blocks the walk actually visited. */
  blocksVisited: number;
  /** `true` when the block cap or an unresolved dynamic jump cut a path short. */
  truncated: boolean;
  /** Set when `onVisit` asked the walk to stop by returning `true`. */
  foundAt?: number;
}

/** Nearest `PUSH` before the call-target push whose value is a JUMPDEST other than the call target itself. */
function findReturnCandidate(instructions: Instruction[], jumpdests: Set<number>, callTarget: number): number | undefined {
  for (let i = instructions.length - 3; i >= 0; i--) {
    const instr = instructions[i];
    if (!instr || instr.op < 0x60 || instr.op > 0x7f || instr.operand === undefined) continue; // PUSH1-PUSH32
    const value = parseInt(instr.operand, 16);
    if (value !== callTarget && jumpdests.has(value)) return value;
  }
  return undefined;
}

interface Frame {
  pc: number;
  /** Pending return addresses for this path, innermost call last. */
  returns: number[];
}

/**
 * Walks blocks reachable from `startPc`, up to `cap` distinct blocks.
 * `onVisit` runs once per newly visited block; returning `true` stops the
 * walk early and records `foundAt`.
 */
export function traverseBlocks(
  blocks: Map<number, Block>,
  startPc: number,
  jumpdests: Set<number>,
  cap: number,
  onVisit: (block: Block) => boolean | void,
): TraverseResult {
  const visited = new Set<number>();
  const stack: Frame[] = [{ pc: startPc, returns: [] }];
  let truncated = false;
  let foundAt: number | undefined;
  // A shared helper block (one function called from several call sites)
  // is reached more than once, each time with a different pending return
  // address, and each such visit must still resolve its own return. But a
  // real loop back-edge revisits a block with the SAME empty return stack
  // every time; reprocessing that unconditionally would cycle forever,
  // burning the whole step budget without ever reaching new code. So a
  // revisit is only reprocessed when its (pc, pending-returns) signature
  // has not already been seen.
  const seenSignatures = new Map<number, Set<string>>();
  const frameStepCap = cap * 8;
  let frameSteps = 0;

  while (stack.length > 0) {
    if (visited.size >= cap) { truncated = true; break; }
    if (frameSteps++ >= frameStepCap) { truncated = true; break; }
    const frame = stack.pop();
    if (!frame) continue;
    const block = blocks.get(frame.pc);
    if (!block) continue;

    let signatures = seenSignatures.get(frame.pc);
    if (!signatures) { signatures = new Set(); seenSignatures.set(frame.pc, signatures); }
    const signature = frame.returns.join(",");
    if (signatures.has(signature)) continue;
    signatures.add(signature);

    if (!visited.has(frame.pc)) {
      visited.add(frame.pc);
      if (onVisit(block)) { foundAt = frame.pc; break; }
    }

    const resumeAtReturn = (): boolean => {
      const rest = frame.returns.slice(0, -1);
      const back = frame.returns[frame.returns.length - 1];
      if (back === undefined) return false;
      stack.push({ pc: back, returns: rest });
      return true;
    };

    if (block.terminator === "jump") {
      if (block.jumpTarget !== undefined) {
        const returnCandidate = findReturnCandidate(block.instructions, jumpdests, block.jumpTarget);
        const nextReturns = returnCandidate !== undefined ? [...frame.returns, returnCandidate] : frame.returns;
        stack.push({ pc: block.jumpTarget, returns: nextReturns });
      } else if (!resumeAtReturn()) {
        truncated = true;
      }
    } else if (block.terminator === "jumpi") {
      if (block.jumpTarget !== undefined) stack.push({ pc: block.jumpTarget, returns: frame.returns });
      else if (!resumeAtReturn()) truncated = true;
      if (block.fallthrough !== undefined) stack.push({ pc: block.fallthrough, returns: frame.returns });
    } else if (block.fallthrough !== undefined) {
      stack.push({ pc: block.fallthrough, returns: frame.returns });
    }
    // stop / return / revert / invalid / selfdestruct: the path ends normally, not truncated.
  }

  return { blocksVisited: visited.size, truncated, foundAt };
}
