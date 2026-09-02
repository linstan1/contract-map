/**
 * ABI helpers: canonical signatures, selectors, standard detection, and the
 * bytecode selector scan used when a contract is not verified.
 *
 * Selector arithmetic lives here alone. No other module hashes a signature.
 */

import { keccak256 } from "./keccak";
import type { AbiEntry, AbiParam, EventAnalysis, Selector } from "./types";

/** Canonical ABI type of one parameter, with tuples expanded. */
export function canonicalType(param: AbiParam): string {
  if (param.type.startsWith("tuple")) {
    const inner = (param.components ?? []).map(canonicalType).join(",");
    return `(${inner})${param.type.slice("tuple".length)}`;
  }
  return param.type;
}

/** Canonical signature of a function or event entry, e.g. `deposit(uint256,address)`. */
export function signatureOf(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map(canonicalType).join(",");
  return `${entry.name ?? ""}(${inputs})`;
}

const selectorCache = new Map<string, Selector>();

/** First four bytes of the keccak256 of a canonical signature. */
export function selectorOf(signature: string): Selector {
  const hit = selectorCache.get(signature);
  if (hit) return hit;
  const value = keccak256(signature).slice(0, 10);
  selectorCache.set(signature, value);
  return value;
}

/** Full keccak256 of a canonical event signature, the value of `topics[0]`. */
export function topic0Of(signature: string): string {
  return keccak256(signature);
}

/** Parses an ABI document, dropping entries this application cannot use. */
export function parseAbi(raw: unknown): AbiEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AbiEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as AbiEntry;
    if (typeof entry.type !== "string") continue;
    out.push(entry);
  }
  return out;
}

export function eventsFromAbi(abi: AbiEntry[]): EventAnalysis[] {
  return abi
    .filter((e) => e.type === "event" && e.name)
    .map((e) => {
      const signature = signatureOf(e);
      return { name: e.name as string, signature, topic0: topic0Of(signature) as `0x${string}` };
    });
}

/**
 * Selector sets of the standards this application recognises. A standard is
 * reported only when every selector in its set is present, so the label is a
 * fact about the ABI rather than a guess.
 */
const STANDARDS: { name: string; signatures: string[] }[] = [
  {
    name: "ERC20",
    signatures: [
      "totalSupply()",
      "balanceOf(address)",
      "transfer(address,uint256)",
      "transferFrom(address,address,uint256)",
      "approve(address,uint256)",
      "allowance(address,address)",
    ],
  },
  { name: "ERC20Permit", signatures: ["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", "nonces(address)"] },
  {
    name: "ERC4626",
    signatures: [
      "asset()",
      "totalAssets()",
      "convertToShares(uint256)",
      "convertToAssets(uint256)",
      "deposit(uint256,address)",
      "mint(uint256,address)",
      "withdraw(uint256,address,address)",
      "redeem(uint256,address,address)",
    ],
  },
  { name: "ERC7540 async", signatures: ["requestDeposit(uint256,address,address)"] },
  {
    name: "ERC721",
    signatures: ["ownerOf(uint256)", "safeTransferFrom(address,address,uint256)", "setApprovalForAll(address,bool)", "getApproved(uint256)"],
  },
  { name: "ERC1155", signatures: ["balanceOfBatch(address[],uint256[])", "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"] },
  { name: "Ownable", signatures: ["owner()", "transferOwnership(address)"] },
  { name: "Ownable2Step", signatures: ["pendingOwner()", "acceptOwnership()"] },
  { name: "AccessControl", signatures: ["hasRole(bytes32,address)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)"] },
  { name: "UUPS upgradeable", signatures: ["upgradeToAndCall(address,bytes)", "proxiableUUID()"] },
  { name: "EIP-1967 admin", signatures: ["admin()", "implementation()", "upgradeTo(address)"] },
  { name: "Pausable", signatures: ["paused()"] },
  { name: "Multicall", signatures: ["multicall(bytes[])"] },
  { name: "ERC165", signatures: ["supportsInterface(bytes4)"] },
  { name: "Timelock", signatures: ["getMinDelay()", "schedule(address,uint256,bytes,bytes32,bytes32,uint256)"] },
  { name: "Gnosis Safe", signatures: ["getThreshold()", "getOwners()"] },
  { name: "Uniswap V3 pool", signatures: ["slot0()", "swap(address,bool,int256,uint160,bytes)"] },
  { name: "Uniswap V2 pair", signatures: ["getReserves()", "swap(uint256,uint256,address,bytes)"] },
  { name: "Aave V3 pool", signatures: ["supply(address,uint256,address,uint16)", "borrow(address,uint256,uint256,uint16,address)"] },
  { name: "Morpho Blue", signatures: ["supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"] },
  { name: "Chainlink aggregator", signatures: ["latestRoundData()", "decimals()"] },
];

/** Standards whose whole selector set appears in `selectors`. */
export function detectStandards(selectors: Iterable<Selector>): string[] {
  const have = new Set(selectors);
  const found: string[] = [];
  for (const standard of STANDARDS) {
    if (standard.signatures.every((sig) => have.has(selectorOf(sig)))) found.push(standard.name);
  }
  return found;
}

/**
 * Selectors that appear as `PUSH4` operands in runtime bytecode.
 *
 * A dispatcher compares `calldataload(0) >> 224` against every selector it
 * serves, and solc emits each one as a `PUSH4`. The scan skips the operand
 * bytes of every push instruction, so constants inside code are not mistaken
 * for opcodes. Some `PUSH4` values are ordinary constants, which is why the
 * result is a candidate set that the caller reconciles against an ABI.
 */
export function bytecodeSelectors(runtimeCode: string): Selector[] {
  const hex = runtimeCode.startsWith("0x") ? runtimeCode.slice(2) : runtimeCode;
  const bytes = hex.length >> 1;
  const byteAt = (index: number): number => parseInt(hex.slice(index * 2, index * 2 + 2), 16);

  /* Opcodes that a dispatcher uses right after it pushes a selector: EQ for a
   * linear chain of comparisons, GT and LT for the binary search that solc
   * emits once a contract serves many functions. */
  const COMPARISONS = new Set([0x14, 0x11, 0x10]);
  /* Stack shuffles that may sit between the push and the comparison. */
  const SHUFFLES = new Set([0x80, 0x81, 0x82, 0x90, 0x91, 0x50]);

  const program: { op: number; operand?: string }[] = [];
  for (let pc = 0; pc < bytes; pc++) {
    const op = byteAt(pc);
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f;
      program.push({ op, operand: hex.slice((pc + 1) * 2, (pc + 1 + width) * 2) });
      pc += width;
      continue;
    }
    program.push({ op });
  }

  const found = new Set<Selector>();
  for (let i = 0; i < program.length; i++) {
    const step = program[i];
    if (!step || step.op !== 0x63) continue; // PUSH4
    const operand = step.operand ?? "";
    if (operand.length !== 8 || operand === "00000000" || operand === "ffffffff") continue;
    /* A revert code is also pushed as four bytes, so a bare PUSH4 proves
     * nothing. Only a push that feeds a comparison is a dispatcher entry. */
    for (let ahead = 1; ahead <= 3; ahead++) {
      const next = program[i + ahead];
      if (!next) break;
      if (COMPARISONS.has(next.op)) {
        found.add(`0x${operand}`);
        break;
      }
      if (!SHUFFLES.has(next.op)) break;
    }
  }
  return [...found];
}

/** ERC-1967 implementation slot: `keccak256("eip1967.proxy.implementation") - 1`. */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** ERC-1967 beacon slot: `keccak256("eip1967.proxy.beacon") - 1`. */
export const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** EIP-1822 proxiable slot: `keccak256("PROXIABLE")`. */
export const EIP1822_SLOT = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";
