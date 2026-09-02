/**
 * Turns collected evidence into a short role label and a plain-English
 * behaviour paragraph. Every sentence is built from facts already present
 * on the `FunctionAnalysis`: mutability, access gate, state writes,
 * internal calls, external calls, events, and parameter names. Natspec is
 * never copied in here; it stays in the separate `natspec` field.
 */

import type { FunctionAnalysis } from "../types";

const ROLE_RULES: { test: RegExp; role: string }[] = [
  { test: /^(deposit|mint|supply|allocate|enter)/, role: "deposit / asset movement" },
  { test: /^(withdraw|redeem|deallocate|exit)/, role: "withdrawal" },
  { test: /^(set|update|configure|change)/, role: "admin configuration" },
  { test: /^(add|remove|revoke|grant)/, role: "admin configuration" },
  { test: /^(pause|unpause|freeze|emergency)/, role: "emergency" },
  { test: /^(upgrade|migrate)/, role: "upgrade" },
  { test: /(role|permission|access|owner|guardian)/, role: "access control" },
];

function roleFor(fn: FunctionAnalysis): string {
  if (fn.mutability === "view" || fn.mutability === "pure") return "view / accounting";
  for (const rule of ROLE_RULES) if (rule.test.test(fn.name)) return rule.role;
  if (fn.writes.length > 0) return "state mutation";
  if (fn.externalCalls.length > 0) return "external interaction";
  return "other";
}

function listOf(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length <= 3 ? unique.join(", ") : `${unique.slice(0, 3).join(", ")}, and ${unique.length - 3} more`;
}

function stateSentence(fn: FunctionAnalysis): string | undefined {
  if (fn.writes.length === 0) return undefined;
  return `It writes the ${listOf(fn.writes.map((w) => w.name))} state.`;
}

function readOnlySentence(fn: FunctionAnalysis): string | undefined {
  if (fn.writes.length > 0 || fn.reads.length === 0) return undefined;
  return `It reads ${listOf(fn.reads.map((r) => r.name))} and returns a computed value.`;
}

function externalSentence(fn: FunctionAnalysis): string | undefined {
  if (fn.externalCalls.length === 0) return undefined;
  const parts = fn.externalCalls.slice(0, 3).map((c) => `${c.functionName} on ${c.destination.name ?? c.destExpr}`);
  const extra = fn.externalCalls.length > 3 ? `, and ${fn.externalCalls.length - 3} more call${fn.externalCalls.length - 3 === 1 ? "" : "s"}` : "";
  return `It calls ${parts.join(", ")}${extra}.`;
}

function internalSentence(fn: FunctionAnalysis): string | undefined {
  const direct = fn.internalCalls.filter((c) => c.depth === 1 && c.kind !== "modifier");
  if (direct.length === 0) return undefined;
  return `It runs through ${listOf(direct.map((c) => c.name))}.`;
}

function eventSentence(fn: FunctionAnalysis): string | undefined {
  if (fn.events.length === 0) return undefined;
  return `It emits ${listOf(fn.events.map((e) => e.split("(")[0] ?? e))}.`;
}

function fallbackSentence(fn: FunctionAnalysis): string {
  if (fn.mutability === "view" || fn.mutability === "pure") return "It returns a value with no recorded state access.";
  return "It has no recorded state write, external call, or event in this analysis.";
}

/** Builds `role` and `whatItDoes` for one exposed function, from evidence only, never from natspec. */
export function describeFunction(fn: FunctionAnalysis): { role: string; whatItDoes: string } {
  const role = roleFor(fn);
  const sentences: string[] = [fn.access.detail];
  for (const s of [stateSentence(fn), readOnlySentence(fn), externalSentence(fn), internalSentence(fn), eventSentence(fn)]) {
    if (s) sentences.push(s);
  }
  if (sentences.length === 1) sentences.push(fallbackSentence(fn));
  const whatItDoes = sentences.slice(0, 4).join(" ");
  return { role, whatItDoes };
}
