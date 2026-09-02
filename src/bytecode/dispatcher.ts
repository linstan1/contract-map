/**
 * Finds the basic block a selector's dispatcher branch jumps to.
 *
 * A dispatcher block always ends in a `JUMPI` that is gated on some test of
 * `PUSH4 selectorValue` against the live calldata selector. Three compiler
 * shapes have been confirmed on real deployed code, and the resolver
 * follows whichever one a block actually uses:
 *
 * - solc, exact match: `PUSH4 sel; ...; EQ; PUSHdest; JUMPI` — `JUMPI`
 *   fires ON MATCH, jumping straight to the function. Confirmed on USDC
 *   (`0x43506849D7C04F9138D1A2050bbF3A0c054402dd`) and Permit2.
 * - solc, binary search: `PUSH4 pivot; ...; GT`/`LT; PUSHdest; JUMPI` —
 *   splits the remaining selector range around a pivot. Confirmed on USDC.
 * - Vyper, inverted match: `PUSH4 sel; ...; EQ; ISZERO; PUSHdest; JUMPI`
 *   or the equivalent single-instruction `PUSH4 sel; ...; XOR; PUSHdest;
 *   JUMPI` — `JUMPI` fires ON MISMATCH, jumping to the next candidate; a
 *   match falls through directly into the function body. Vyper reads the
 *   selector either by reusing a value already `DUP`ed onto the stack
 *   (confirmed on the Yearn V2 Vault implementation,
 *   `0x9c13e225ae007731caa49fd17a41379ab1a489f4`, Vyper 0.3.3) or by
 *   reloading it with `PUSH 0x00; MLOAD` before every single comparison
 *   (confirmed on Curve 3pool, `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7`,
 *   Vyper 0.2.8). Both read the same selector word: earlier code stores
 *   `calldataload(0)` at memory offset 28, so `MLOAD 0` reads it back
 *   zero-extended, in place of solc's `calldataload(0) >> 224`.
 *
 * Vyper 0.4 (probed on `0xE05d0e9eaB8AD581fE5736d8EaA4224dED4Dac7E`) adds a
 * fourth shape this resolver does NOT follow: a `CODECOPY` of two bytes
 * from a hash-table baked into the contract's own code, at an offset
 * computed from `selector MOD bucketCount`, then an `MLOAD`/`JUMP` on the
 * copied bytes. That jump's target is only defined by a hash computation
 * over code bytes, not by any value the interpreter can trace back to a
 * `PUSH`, so it is a genuine dynamic jump: the walk reports it as
 * unresolved rather than guess at a bucket layout. A selector that happens
 * to land in the one bucket chain reachable in program order still
 * resolves; the rest are honestly reported as unresolved.
 */

import type { Block } from "./cfg";
import type { Instruction } from "./decode";
import { traverseBlocks } from "./traverse";

/** Opcodes that may sit between a `PUSH4` and its comparison: dup, swap, pop. */
const SHUFFLE_OPS = new Set([0x50, 0x80, 0x81, 0x82, 0x90, 0x91]);
const EQ = 0x14;
const GT = 0x11;
const LT = 0x10;
const XOR = 0x18;
const ISZERO = 0x15;
const MLOAD = 0x51;

interface Comparison {
  value: number;
  op: number;
  /** `true` when the `JUMPI` fires on mismatch (Vyper), `false` when it fires on match (solc). */
  inverted: boolean;
}

/**
 * Finds the `PUSH4 value` closest to the block's end that feeds an
 * `EQ`/`GT`/`LT`/`XOR`. Between the push and the test, allows the usual
 * dup/swap/pop shuffles, plus Vyper's `PUSH 0x00; MLOAD` reload of the
 * selector word from memory.
 */
function findComparison(instructions: Instruction[]): Comparison | undefined {
  for (let i = instructions.length - 3; i >= 0; i--) {
    const push = instructions[i];
    if (!push || push.op !== 0x63 || push.operand === undefined) continue; // PUSH4
    let j = i + 1;
    for (let steps = 0; steps < 6; steps++) {
      const cur = instructions[j];
      if (!cur) break;
      if (cur.op === EQ || cur.op === GT || cur.op === LT || cur.op === XOR) {
        // XOR is its own equality test (zero means equal) and Vyper never
        // follows it with ISZERO; EQ/GT/LT need the next instruction
        // checked to tell a solc match-jump from a Vyper mismatch-jump.
        const inverted = cur.op === XOR || instructions[j + 1]?.op === ISZERO;
        return { value: parseInt(push.operand, 16), op: cur.op, inverted };
      }
      const after = instructions[j + 1];
      if (cur.op >= 0x5f && cur.op <= 0x7f && after?.op === MLOAD) { j += 2; continue; } // PUSH<slot> MLOAD reload
      if (!SHUFFLE_OPS.has(cur.op)) break;
      j += 1;
    }
  }
  return undefined;
}

/**
 * Every selector value compared anywhere in the dispatcher, across every
 * block, whether or not that block is reachable from the contract entry.
 *
 * `abi.ts`'s `bytecodeSelectors` only recognises `EQ`/`GT`/`LT`, so it
 * misses Vyper's `XOR`-based comparisons (confirmed on Vyper 0.4, e.g. the
 * per-bucket checks reached through a `CODECOPY`-built jump table). This
 * reuses the same shape detection {@link findComparison} already applies
 * per block, so it stays in sync with every shape this module recognises.
 */
export function findAllComparisonSelectors(blocks: Map<number, Block>): string[] {
  const selectors = new Set<string>();
  for (const block of blocks.values()) {
    const cmp = findComparison(block.instructions);
    if (cmp) selectors.add(`0x${cmp.value.toString(16).padStart(8, "0")}`);
  }
  return [...selectors];
}

/**
 * Finds the block where the dispatcher starts comparing the selector.
 *
 * Runtime code often opens with a payable guard, a free-memory-pointer
 * preamble, or a calldata-decode helper reached through solc's internal
 * call convention before the real dispatcher. The call-aware walk in
 * `traverse.ts` follows all of that, forward calls and their dynamic
 * returns alike, until it finds a block whose `JUMPI` is actually gated on
 * a selector comparison.
 */
function findDispatcherRoot(blocks: Map<number, Block>, jumpdests: Set<number>, entryPc = 0): number | undefined {
  const result = traverseBlocks(blocks, entryPc, jumpdests, 256, (block) =>
    block.terminator === "jumpi" && Boolean(findComparison(block.instructions)),
  );
  if (result.foundAt !== undefined) return result.foundAt;
  // Nothing reachable, even with call/return tracking, resolved to a
  // comparison block. Fall back to the first one anywhere in the code, in
  // program order: dispatcher blocks chain to each other with static edges
  // once inside the dispatcher, so starting there still resolves every
  // selector even when the true entry edge could not be reconstructed.
  const candidates = [...blocks.entries()]
    .filter(([, block]) => block.terminator === "jumpi" && findComparison(block.instructions))
    .map(([pc]) => pc)
    .sort((a, b) => a - b);
  return candidates[0];
}

/**
 * Resolves the entry block for `targetSelector`, or reports why it could not.
 *
 * The caller passes `dispatcherRoot` once per contract, computed by
 * {@link findDispatcherRoot}, so every selector reuses the same starting
 * point instead of re-searching the preamble. When the chain runs into a
 * block with no comparison of its own (Vyper occasionally threads an
 * unrelated guard between two candidates), it bridges forward with the
 * same call-aware search used to find the root, rather than giving up.
 */
export function resolveDispatcherEntry(
  blocks: Map<number, Block>,
  jumpdests: Set<number>,
  dispatcherRoot: number | undefined,
  targetSelector: string,
): { entry: number } | { warning: string } {
  const target = parseInt(targetSelector.replace(/^0x/, ""), 16);
  if (dispatcherRoot === undefined) {
    return { warning: `${targetSelector}: no dispatcher comparison was found anywhere reachable from the contract entry.` };
  }

  const visited = new Set<number>();
  let current: number | undefined = dispatcherRoot;
  const stepCap = 128;
  for (let steps = 0; steps < stepCap; steps++) {
    if (current === undefined) return { warning: `${targetSelector}: the dispatcher chain ended without a matching branch.` };
    if (visited.has(current)) return { warning: `${targetSelector}: the dispatcher chain revisited a block, so it was not followed further.` };
    visited.add(current);
    const block = blocks.get(current);
    if (!block) return { warning: `${targetSelector}: the dispatcher chain pointed at a program counter with no block.` };

    let cmp = findComparison(block.instructions);
    let activeBlock = block;
    if (!cmp) {
      // Vyper sometimes threads an unrelated guard (a payable check, an
      // overflow check) between two selector candidates. Look past it for
      // the next reachable comparison block, the same way the dispatcher
      // root itself is found, instead of giving up on the whole chain.
      const bridge = traverseBlocks(blocks, current, jumpdests, 400, (b) =>
        b.terminator === "jumpi" && Boolean(findComparison(b.instructions)),
      );
      const bridgedPc = bridge.foundAt;
      if (bridgedPc === undefined) {
        return { warning: `${targetSelector}: block at pc ${current} has no selector comparison to follow.` };
      }
      if (visited.has(bridgedPc)) return { warning: `${targetSelector}: the dispatcher chain revisited a block, so it was not followed further.` };
      visited.add(bridgedPc);
      const bridged = blocks.get(bridgedPc);
      cmp = bridged ? findComparison(bridged.instructions) : undefined;
      if (!bridged || !cmp) return { warning: `${targetSelector}: block at pc ${bridgedPc} has no selector comparison to follow.` };
      current = bridgedPc;
      activeBlock = bridged;
    }

    if (cmp.op === EQ || cmp.op === XOR) {
      // solc: JUMPI fires on match, so a match branch is block.jumpTarget.
      // Vyper: JUMPI fires on mismatch, so a match instead falls through,
      // and a mismatch moves on to block.jumpTarget, the next candidate.
      const matchGoesToJumpTarget = !cmp.inverted;
      if (cmp.value === target) {
        const matchTarget = matchGoesToJumpTarget ? activeBlock.jumpTarget : activeBlock.fallthrough;
        if (matchTarget === undefined) return { warning: `${targetSelector}: its matching branch target is not a static jump.` };
        return { entry: matchTarget };
      }
      current = matchGoesToJumpTarget ? activeBlock.fallthrough : activeBlock.jumpTarget;
      continue;
    }
    // The dispatcher duplicates the selector, then pushes the pivot on top of
    // it, so the pivot is the comparison's first (top-of-stack) operand and
    // the selector is its second: `GT` computes `pivot > selector`, and
    // `LT` computes `pivot < selector`. The `JUMPI` fires on a true result.
    const takeBranch = cmp.op === GT ? target < cmp.value : target > cmp.value;
    current = takeBranch ? activeBlock.jumpTarget : activeBlock.fallthrough;
  }
  return { warning: `${targetSelector}: the dispatcher chain did not resolve within ${stepCap} steps.` };
}

export { findDispatcherRoot };
