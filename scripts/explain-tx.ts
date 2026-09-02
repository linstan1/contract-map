/**
 * Explains one real transaction as a call path, from the chain's own trace.
 *
 * Usage:
 *   bun run scripts/explain-tx.ts <txHash> <targetAddress> [chain] [--json <file>]
 *
 * It prints what `docs/EXAMPLE-TRANSACTION.md` documents, from live data:
 *   1. the transaction header, with scanner links anyone can open
 *   2. the frames that ENTER the target, as inbound edges with the caller
 *      function taken from the parent frame
 *   3. the frames the target MAKES, as outbound edges attributed to the
 *      enclosing target function
 *   4. the pruned call tree around the target
 *
 * The same modules answer here and in the application, so the document and
 * the product cannot drift apart.
 */

import { selectorOfInput, flatTracesToTree, callTracerToTree, RpcClient, type FlatTrace } from "../src/rpc";
import { chainByKey, hasRpcEndpoint, MISSING_ENDPOINT_MESSAGE } from "../src/config";
import { SignatureRegistry } from "../src/signatures";
import { LabelBook } from "../src/labels";
import type { CallFrame } from "../src/types";

const args = Bun.argv.slice(2);
const jsonFlag = args.indexOf("--json");
const jsonPath = jsonFlag >= 0 ? args[jsonFlag + 1] : undefined;
/* Drop the flag and its value only when the flag is present. With no flag
 * the index is -1, and `-1 + 1` would silently drop the first argument. */
const positional = jsonFlag >= 0 ? args.filter((_, i) => i !== jsonFlag && i !== jsonFlag + 1) : args;
const [hash, target, chainKey = "ethereum"] = positional;

if (!hash || !target) {
  console.error("Usage: bun run scripts/explain-tx.ts <txHash> <targetAddress> [chain] [--json <file>]");
  process.exit(1);
}
if (!hasRpcEndpoint()) {
  console.error(MISSING_ENDPOINT_MESSAGE);
  process.exit(1);
}

const chain = chainByKey(chainKey);
if (!chain) {
  console.error(`Unknown chain "${chainKey}".`);
  process.exit(1);
}

const rpc = new RpcClient(chain);
const registry = new SignatureRegistry();
const labels = new LabelBook(chain, rpc, registry);
const identity = new Set([target.toLowerCase()]);

/* ---------------------------------------------------------------- load */

const receipt = await rpc.call<{ status: string; gasUsed: string; blockNumber: string; from: string; to: string }>(
  "eth_getTransactionReceipt",
  [hash],
);
if (!receipt) {
  console.error(`${hash} is unknown to ${chain.label}.`);
  process.exit(1);
}
const block = await rpc.call<{ timestamp: string }>("eth_getBlockByNumber", [receipt.blockNumber, false]);

let root: CallFrame | undefined;
let frameCount = 0;
if (chain.traceFilter) {
  const flat = await rpc.traceTransaction(hash);
  frameCount = flat.length;
  root = flatTracesToTree(flat);
  if (jsonPath) await Bun.write(jsonPath, `${JSON.stringify(flat as FlatTrace[], null, 1)}\n`);
} else {
  const tree = await rpc.debugTraceTransaction(hash);
  if (tree) {
    root = callTracerToTree(tree);
    if (jsonPath) await Bun.write(jsonPath, `${JSON.stringify(tree, null, 1)}\n`);
  }
}
if (!root) {
  console.error(`No trace was returned for ${hash}.`);
  process.exit(1);
}

/* --------------------------------------------------------------- walk */

interface Inbound {
  caller: string;
  callerSelector?: string;
  targetSelector?: string;
  callType: string;
  path: string;
  frames: number;
}
interface Outbound {
  targetSelector?: string;
  destination: string;
  destinationSelector?: string;
  callType: string;
  frames: number;
}

const inbound = new Map<string, Inbound>();
const outbound = new Map<string, Outbound>();
const selectors = new Set<string>();
const addresses = new Set<string>();
/** Frames on a path that touches the target, for the pruned tree. */
const kept: { depth: number; path: string; frame: CallFrame; role: string }[] = [];

function walk(frame: CallFrame, parent: CallFrame | undefined, enclosing: string | undefined, path: number[]): void {
  frameCount = Math.max(frameCount, 0);
  const to = frame.to?.toLowerCase();
  const from = frame.from.toLowerCase();
  const toIsTarget = !!to && identity.has(to);
  const fromIsTarget = identity.has(from);
  const selector = selectorOfInput(frame.input);
  let context = enclosing;

  if (toIsTarget) {
    /* A delegatecall between identity addresses continues the same call. */
    context = fromIsTarget && frame.callType === "delegatecall" ? enclosing : selector;
    if (!fromIsTarget) {
      const callerSelector = parent ? selectorOfInput(parent.input) : undefined;
      const key = `${from}|${callerSelector ?? ""}|${selector ?? ""}|${frame.callType}`;
      const held = inbound.get(key);
      if (held) held.frames++;
      else {
        inbound.set(key, {
          caller: from,
          callerSelector,
          targetSelector: selector,
          callType: frame.callType,
          path: path.join(",") || "root",
          frames: 1,
        });
      }
      if (callerSelector) selectors.add(callerSelector);
      addresses.add(from);
      kept.push({ depth: path.length, path: path.join(",") || "root", frame, role: "inbound" });
    }
  }

  if (fromIsTarget && to && !identity.has(to)) {
    const key = `${context ?? ""}|${to}|${selector ?? ""}|${frame.callType}`;
    const held = outbound.get(key);
    if (held) held.frames++;
    else {
      outbound.set(key, { targetSelector: context, destination: to, destinationSelector: selector, callType: frame.callType, frames: 1 });
    }
    addresses.add(to);
    kept.push({ depth: path.length, path: path.join(",") || "root", frame, role: "outbound" });
  }

  if (selector) selectors.add(selector);
  frame.children.forEach((child, index) => walk(child, frame, context, [...path, index]));
}

walk(root, undefined, undefined, []);

await registry.resolve([...selectors]);
await labels.load([...addresses, target.toLowerCase()]);

const name = (selector?: string): string => {
  if (!selector) return "unknown function";
  const found = registry.lookup(selector);
  return found.signature ?? `${selector} (unresolved)`;
};
const label = (address: string): string => {
  const shown = labels.label(address);
  return shown.includes("…") ? shown : `${shown} ${address.slice(0, 6)}…${address.slice(-4)}`;
};

/* -------------------------------------------------------------- report */

const scanners: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  8453: "https://basescan.org/tx/",
  42161: "https://arbiscan.io/tx/",
  137: "https://polygonscan.com/tx/",
};

console.log(`Transaction   ${hash}`);
console.log(`Chain         ${chain.label} (${chain.id})`);
console.log(`Block         ${parseInt(receipt.blockNumber, 16)}`);
console.log(`Timestamp     ${new Date(parseInt(block.timestamp, 16) * 1000).toISOString()}`);
console.log(`Status        ${receipt.status === "0x1" ? "success" : "reverted"}`);
console.log(`Gas used      ${parseInt(receipt.gasUsed, 16).toLocaleString("en-US")}`);
console.log(`Sender        ${receipt.from}`);
console.log(`First callee  ${receipt.to}`);
console.log(`Target        ${target} (${labels.label(target.toLowerCase())})`);
if (scanners[chain.id]) console.log(`Scanner       ${scanners[chain.id]}${hash}`);
if (chain.blockscout) console.log(`Blockscout    ${chain.blockscout}/tx/${hash}`);
console.log();

console.log(`INBOUND: another contract calls the target (${inbound.size} distinct edge${inbound.size === 1 ? "" : "s"})`);
for (const edge of [...inbound.values()].sort((a, b) => b.frames - a.frames)) {
  const caller = edge.callerSelector ? `${label(edge.caller)}.${name(edge.callerSelector)}` : `${label(edge.caller)} (externally owned account or unreadable calldata)`;
  console.log(`  ${caller}`);
  console.log(`    → ${name(edge.targetSelector)}   [${edge.callType}, ${edge.frames} frame${edge.frames === 1 ? "" : "s"}, trace path ${edge.path}]`);
}
console.log();

console.log(`OUTBOUND: the target calls another contract (${outbound.size} distinct edge${outbound.size === 1 ? "" : "s"})`);
const byFunction = new Map<string, Outbound[]>();
for (const edge of outbound.values()) {
  const key = edge.targetSelector ?? "";
  byFunction.set(key, [...(byFunction.get(key) ?? []), edge]);
}
for (const [selector, edges] of [...byFunction.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${selector ? name(selector) : "unattributed"}`);
  for (const edge of edges.sort((a, b) => b.frames - a.frames)) {
    console.log(`    → ${label(edge.destination)}.${name(edge.destinationSelector)}   [${edge.callType}, ${edge.frames}]`);
  }
}
console.log();

console.log("PRUNED TREE: only frames that enter or leave the target");
for (const entry of kept) {
  const indent = "  ".repeat(Math.min(entry.depth, 8));
  const arrow = entry.role === "inbound" ? "→ into target" : "← out of target";
  const selector = selectorOfInput(entry.frame.input);
  console.log(`  ${indent}[${entry.path}] ${entry.frame.callType} ${label(entry.frame.from)} → ${label(entry.frame.to ?? "")} ${name(selector)} ${arrow}`);
}
if (jsonPath) console.log(`\nRaw trace written to ${jsonPath}`);
