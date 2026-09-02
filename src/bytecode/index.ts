/**
 * Reads `BytecodeFacts` straight out of compiled runtime code.
 *
 * This is the only source of truth for an unverified contract, and for a
 * verified one written in Vyper, Huff, or heavy inline assembly: it needs no
 * source, so it works on every contract with code. Precision matters more
 * than recall here: a field is `true` only when its opcode was actually
 * seen on a walked path, and a selector with no resolvable dispatcher branch
 * gets no facts at all, plus a warning naming it.
 */

import { bytecodeSelectors } from "../abi";
import type { BytecodeFacts, Selector } from "../types";
import { buildBlocks } from "./cfg";
import { decodeRuntime } from "./decode";
import { findAllComparisonSelectors, findDispatcherRoot, resolveDispatcherEntry } from "./dispatcher";
import { walkFromEntry } from "./interpreter";
import { factsOverContract } from "./walk";

export interface BytecodeAnalysis {
  /** Per-selector facts, present only for a selector whose dispatcher branch resolved. */
  facts: Record<Selector, BytecodeFacts>;
  /** Union of every opcode fact over the whole runtime code, dispatcher or not. */
  contract: BytecodeFacts;
  /** Every selector this contract's dispatcher actually compares against, whether requested or not. */
  dispatcherSelectors: Selector[];
  /** `contract.addressConstants`, exposed at the top level for convenience. */
  addressConstants: string[];
  warnings: string[];
}

/**
 * Analyses runtime bytecode for the given selectors, or for every selector
 * the dispatcher itself serves when `selectors` is omitted.
 */
export function analyzeBytecode(runtimeCode: string, selectors?: Selector[]): BytecodeAnalysis {
  const { instructions, jumpdests, trailer } = decodeRuntime(runtimeCode);
  const warnings: string[] = [];
  warnings.push(
    trailer
      ? `Excluded ${trailer.length} trailing bytes at offset ${trailer.offset} as the solc metadata trailer (${trailer.detectedBy}).`
      : "No solc metadata trailer was found; the full runtime code was decoded as instructions.",
  );

  const strippedCode = trailer ? runtimeCode.replace(/^0x/, "").slice(0, trailer.offset * 2) : runtimeCode;
  const blocks = buildBlocks(instructions, jumpdests);
  // `abi.ts`'s scan only recognises EQ/GT/LT; unioning in every comparison
  // this module's own shape detection finds picks up Vyper's XOR form too
  // (confirmed missing on Vyper 0.4's CODECOPY-built jump-table buckets).
  const dispatcherSelectors = [
    ...new Set([...bytecodeSelectors(`0x${strippedCode.replace(/^0x/, "")}`), ...findAllComparisonSelectors(blocks)]),
  ];

  const contractFacts = factsOverContract(instructions, blocks.size);

  const dispatcherRoot = findDispatcherRoot(blocks, jumpdests);
  if (dispatcherRoot === undefined) {
    warnings.push("No selector dispatcher was found reachable from the contract entry point.");
  }

  const targets = selectors ?? dispatcherSelectors;
  const facts: Record<Selector, BytecodeFacts> = {};
  for (const selector of targets) {
    const resolved = resolveDispatcherEntry(blocks, jumpdests, dispatcherRoot, selector);
    if ("warning" in resolved) {
      warnings.push(resolved.warning);
      continue;
    }
    facts[selector] = walkFromEntry(instructions, jumpdests, resolved.entry);
  }

  return {
    facts,
    contract: contractFacts,
    dispatcherSelectors,
    addressConstants: contractFacts.addressConstants,
    warnings,
  };
}
