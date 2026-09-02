/**
 * End to end check of the analysis pipeline, without the browser.
 *
 * Usage: bun run scripts/smoke.ts <address> [chain] [depth]
 *
 * It prints the parts a reader must trust: the overview, the exposed
 * functions, one full function map, both runtime directions, and the review.
 */

import { findAlchemyKey, MISSING_KEY_MESSAGE } from "../src/config";
import { analyzeContract } from "../src/pipeline";
import type { Depth } from "../src/types";

const [address, chainKey = "ethereum", depth = "quick"] = Bun.argv.slice(2);
if (!address) {
  console.error("Usage: bun run scripts/smoke.ts <address> [chain] [depth]");
  process.exit(1);
}
/* This project ships no key. Say that plainly instead of failing later
 * inside a provider call. */
if (!findAlchemyKey()) {
  console.error(MISSING_KEY_MESSAGE);
  process.exit(1);
}

const result = await analyzeContract({
  address,
  chainKey,
  depth: depth as Depth,
  onProgress: (stage, detail, pct) => console.error(`  [${String(pct).padStart(3)}%] ${stage}: ${detail}`),
});

const line = (text: string): void => console.log(text);

line("=".repeat(78));
line(`${result.meta.label}  ${result.meta.address}  ${result.meta.chainLabel}`);
line(`likely type      ${result.overview.likelyType}`);
line(`verified         ${result.overview.verified}  source files ${result.static.sourceFiles.length}`);
line(`proxy            ${result.overview.proxy.isProxy} ${result.overview.proxy.implementation ?? ""} (${result.overview.proxy.detectedBy})`);
line(`interfaces       ${result.overview.interfaces.join(", ") || "none matched"}`);
line(`stats            ${JSON.stringify(result.overview.stats)}`);
line(`duration         ${(result.meta.durationMs / 1000).toFixed(1)} s`);
line("");
line("SUMMARY");
line(result.overview.summary);
line("");
line(`WINDOW  ${JSON.stringify(result.runtime.window)}`);
line("");

line(`EXPOSED FUNCTIONS (${result.functions.length})`);
for (const fn of result.functions.slice(0, 25)) {
  const outs = fn.externalCalls
    .slice(0, 3)
    .map((c) => `${c.destinationLabel}.${c.functionLabel.split("(")[0]}${c.observedOnchain ? `[${c.observedCalls}]` : "[not observed]"}`)
    .join(" ");
  line(`  ${fn.selector} ${fn.signature.padEnd(46)} ${String(fn.observed.calls).padStart(6)} obs  ${outs}`);
}
line("");

const busiest = [...result.functions].sort((a, b) => b.observed.calls - a.observed.calls)[0];
if (busiest) {
  line(`FUNCTION DETAIL  ${busiest.signature}`);
  line(`  role           ${busiest.role}`);
  line(`  what it does   ${busiest.whatItDoes}`);
  for (const step of busiest.narrative) line(`  - ${step}`);
  line("  outbound calls");
  for (const call of busiest.externalCalls) {
    line(
      `    ${call.destinationLabel}.${call.functionLabel}  type=${call.callType}` +
        `  possible=${call.possibleFromCode ? "yes" : "no"}  observed=${call.observedOnchain ? `yes (${call.observedCalls})` : "no"}`,
    );
  }
  line("  execution tree");
  const walk = (node: (typeof busiest)["tree"], indent: string): void => {
    line(`    ${indent}${node.label}${node.observedCalls > 0 ? `  [${node.observedCalls} observed]` : node.kind === "external" ? "  [not observed]" : ""}`);
    for (const child of node.children) walk(child, `${indent}  `);
  };
  walk(busiest.tree, "");
  line("");
}

line("OUTBOUND EDGES (target function -> contract -> function)");
for (const edge of result.runtime.outbound.edges.slice(0, 15)) {
  line(
    `  ${(edge.targetSignature ?? edge.targetSelector ?? "unattributed").padEnd(38)} -> ${edge.destinationLabel}.` +
      `${(edge.destinationSignature ?? edge.destinationSelector ?? "unknown").padEnd(30)} ${edge.calls} calls in ${edge.txs} txs`,
  );
}
line("");
line("OUTBOUND CONTRACTS");
for (const contract of result.runtime.outbound.contracts.slice(0, 8)) {
  line(`  ${contract.label} (${contract.address}) ${contract.calls} calls`);
  for (const fn of contract.functions.slice(0, 5)) line(`      ${fn.signature ?? fn.selector}  ${fn.calls}`);
  line(`      from target: ${contract.targetFunctions.map((f) => f.signature ?? f.selector ?? "unattributed").slice(0, 5).join(", ")}`);
}
line("");
line("INBOUND EDGES (caller contract -> caller function -> target function)");
for (const edge of result.runtime.inbound.edges.slice(0, 15)) {
  const callerFn = edge.callerIsEoa ? "externally owned account" : (edge.callerSignature ?? "Unknown caller function");
  line(`  ${edge.callerLabel}.${callerFn} -> ${edge.targetSignature ?? edge.targetSelector ?? "unknown"}  ${edge.calls} calls in ${edge.txs} txs`);
}
line("");
line("INBOUND CONTRACTS");
for (const contract of result.runtime.inbound.contracts.slice(0, 8)) {
  line(`  ${contract.label} (${contract.address}) ${contract.calls} calls`);
  for (const fn of contract.targetFunctions.slice(0, 5)) line(`      ${fn.signature ?? fn.selector}  ${fn.calls}`);
}
line("");
line(`DELEGATECALLS  ${result.runtime.delegatecalls.length}`);
line(`UNRESOLVED SELECTORS  ${result.runtime.unresolvedSelectors.slice(0, 10).join(", ") || "none"}`);
line("");
line("REVIEW");
for (const check of result.review.checks) line(`  [${check.status}] ${check.title}: ${check.detail}`);
if (result.errors.length > 0) {
  line("");
  line("ERRORS");
  for (const error of result.errors) line(`  ${error}`);
}
