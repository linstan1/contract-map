/**
 * Agent 5, the reviewer.
 *
 * The review states what the analysis can and cannot support. It never
 * "passes" or "fails" a contract, because this tool explains execution and
 * does not judge security. Each check reports a fact about the evidence:
 * which address supplied the code, how many selectors resolved, how much of
 * the runtime picture came from a sample, and where a code path was seen in
 * traces but not in source.
 */

import type { FunctionMap, Review, ReviewCheck, RuntimeAnalysis, StaticAnalysis } from "./types";

export interface ReviewInput {
  target: string;
  static: StaticAnalysis;
  runtime: RuntimeAnalysis;
  functions: FunctionMap[];
  unresolvedSignatureCount: number;
  resolvedSignatureCount: number;
  labelledCounterparties: number;
  totalCounterparties: number;
  /** Addresses left unnamed because the lookup budget ran out. */
  labelBudgetSkipped: number;
  /** Label lookups the explorer refused. */
  labelLookupsRefused: number;
  /** Messages from provider lookups that failed, for the refusal check. */
  providerErrors: string[];
}

/** A window length in the largest unit that still reads clearly. */
function span(days: number): string {
  if (days >= 1) return `${days.toFixed(1)} days`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  return `${Math.max(1, Math.round(hours * 60))} minutes`;
}

export function buildReview(input: ReviewInput): Review {
  const checks: ReviewCheck[] = [];
  const { static: statics, runtime, functions } = input;

  /* --- proxy and implementation ------------------------------------------ */
  if (statics.proxy.isProxy) {
    checks.push({
      id: "proxy",
      title: "Proxy handling",
      status: "ok",
      detail:
        `The address is a proxy (${statics.proxy.proxyType ?? "type not reported"}, detected by ${statics.proxy.detectedBy}). ` +
        `The function analysis uses the implementation at ${statics.proxy.implementation ?? "an unknown address"}` +
        `${statics.proxy.implementationName ? ` (${statics.proxy.implementationName})` : ""}. ` +
        "Runtime traces treat the proxy and the implementation as one identity, so a delegatecall does not break the call path.",
    });
    if (statics.proxy.conflicting && statics.proxy.conflicting.length > 1) {
      checks.push({
        id: "proxy-conflict",
        title: "Conflicting implementations",
        status: "warn",
        detail: `The explorer reports more than one implementation: ${statics.proxy.conflicting.join(", ")}. The analysis uses the first one.`,
      });
    }
  } else {
    checks.push({
      id: "proxy",
      title: "Proxy handling",
      status: "info",
      detail: "No proxy pattern was found. The code at the target address is the code that executes.",
    });
  }

  /* --- source -------------------------------------------------------------*/
  const fromSource = statics.functions.filter((f) => f.hasSource).length;
  checks.push({
    id: "source",
    title: "Verified source",
    status: statics.verified ? "ok" : "warn",
    detail: statics.verified
      ? `Verified source is available (${statics.contractName ?? "contract name not reported"}, ${statics.compiler ?? "compiler not reported"}). ` +
        `${fromSource} of ${statics.functions.length} exposed functions have a source body. ` +
        "Reads, writes, internal calls, and possible outbound calls come from that source."
      : "No verified source is available. Functions come from the ABI, from a bytecode selector scan, and from observed execution. " +
        "Reads, writes, and internal calls cannot be derived from source, so the compiled code facts carry that weight.",
  });

  if (statics.sourceProvenance) {
    checks.push({
      id: "source-recovery",
      title: "Recovered source",
      status: "warn",
      detail:
        `${statics.sourceProvenance} The analysed address has no verified source of its own. ` +
        "The recovery was accepted because the dispatcher selectors of this address appear in that ABI. Read every function body statement with that in mind.",
    });
  }

  if (statics.vyper) {
    checks.push({
      id: "vyper",
      title: "Vyper source",
      status: "info",
      detail: "The source is Vyper, so indentation scoped rules produced the reads, the writes, and the calls. Solidity specific patterns were not applied.",
    });
  }

  const withFacts = statics.functions.filter((f) => f.bytecodeFacts);
  if (withFacts.length > 0) {
    const truncated = withFacts.filter((f) => f.bytecodeFacts?.truncated).length;
    checks.push({
      id: "compiled-facts",
      title: "Compiled code facts",
      status: truncated > 0 ? "info" : "ok",
      detail:
        `A control-flow walk of the compiled code reached ${withFacts.length} of ${statics.functions.length} exposed functions. ` +
        (truncated > 0
          ? `${truncated} walks stopped early at a dynamic jump or at the block cap, so a "no" on those functions means "not seen", never "cannot happen".`
          : 'Every walk finished, so a "no" means the opcode was not reachable on the walked paths.'),
    });
  }

  /* An explorer refusal and a truly unverified contract look the same in the
   * output, and they are not the same fact. Name the refusal. */
  const refusals = input.providerErrors.filter((message) => /HTTP 4\d\d|HTTP 5\d\d|timeout|non-JSON/i.test(message));
  if (refusals.length > 0) {
    checks.push({
      id: "provider-refusal",
      title: "Explorer did not answer",
      status: "warn",
      detail:
        `The block explorer refused ${refusals.length} request${refusals.length === 1 ? "" : "s"}: ${refusals.slice(0, 3).join(" ")} ` +
        "The contract may well be verified. This result is thin because the lookup failed, not because the source is missing. Run the analysis again.",
    });
  }

  /* --- selector resolution ------------------------------------------------*/
  const totalSignatures = input.resolvedSignatureCount + input.unresolvedSignatureCount;
  checks.push({
    id: "selectors",
    title: "Selector resolution",
    status: input.unresolvedSignatureCount === 0 ? "ok" : "warn",
    detail:
      `${input.resolvedSignatureCount} of ${totalSignatures} selectors resolved to a signature. ` +
      (input.unresolvedSignatureCount === 0
        ? "Every selector in the analysis has a name from an ABI or from a verified signature database."
        : `${input.unresolvedSignatureCount} selectors stay unresolved and appear as raw four byte values. ` +
          "Every candidate signature was checked by re-hashing it, so no name in this report is a guess.") +
      (statics.unresolvedSelectors.length > 0
        ? ` The bytecode also holds ${statics.unresolvedSelectors.length} selectors that the ABI does not explain.`
        : ""),
  });

  /* --- overloading --------------------------------------------------------*/
  const overloaded = statics.functions.filter((f) => f.overloaded);
  if (overloaded.length > 0) {
    checks.push({
      id: "overloading",
      title: "Function overloading",
      status: "info",
      detail:
        `${overloaded.length} exposed functions share a name with another function: ` +
        `${[...new Set(overloaded.map((f) => f.name))].join(", ")}. ` +
        "Every view keys on the selector, so the overloads stay separate.",
    });
  }

  /* --- static versus observed --------------------------------------------*/
  const possibleOnly = functions.flatMap((f) => f.externalCalls.filter((c) => c.possibleFromCode && !c.observedOnchain));
  const observedOnly = functions.flatMap((f) => f.externalCalls.filter((c) => !c.possibleFromCode && c.observedOnchain));
  checks.push({
    id: "static-vs-observed",
    title: "Possible execution against observed execution",
    status: "info",
    detail:
      `${possibleOnly.length} outbound calls exist in code but were not seen in the traced window. ` +
      "They are marked as possible and not observed. " +
      `${observedOnly.length} outbound calls were observed in traces without a matching call site in source. ` +
      (observedOnly.length > 0
        ? "That happens with dynamic dispatch, with a call inside inline assembly, or when the source is partial."
        : ""),
  });

  const dynamic = statics.functions.flatMap((f) => f.externalCalls.filter((c) => c.callType === "dynamic"));
  if (dynamic.length > 0) {
    checks.push({
      id: "dynamic-calls",
      title: "Dynamic calls",
      status: "warn",
      detail:
        `${dynamic.length} call sites choose the destination or the selector at run time. ` +
        "The destination of such a call cannot be resolved from code. Use the observed calls for those paths.",
    });
  }

  /* --- delegatecalls ------------------------------------------------------*/
  checks.push({
    id: "delegatecall",
    title: "Delegatecalls",
    status: runtime.delegatecalls.length > 0 ? "warn" : "info",
    detail:
      runtime.delegatecalls.length > 0
        ? `${runtime.delegatecalls.length} delegatecall edges were observed out of the target. ` +
          "A delegatecall runs the other contract's code in the state of the target, so it is listed apart from ordinary outbound calls."
        : "No delegatecall out of the target was observed in the traced window, apart from proxy dispatch.",
  });

  /* --- runtime coverage ---------------------------------------------------*/
  if (!runtime.available) {
    checks.push({
      id: "runtime",
      title: "Observed execution",
      status: "warn",
      detail: `No trace source answered for this chain. ${runtime.warnings.join(" ")} Only the code view is available.`,
    });
  } else {
    const w = runtime.window;
    checks.push({
      id: "runtime",
      title: "Observed execution",
      status: w.sampled ? "warn" : "ok",
      detail:
        `Counts come from blocks ${w.fromBlock} to ${w.toBlock} (${w.blocks} blocks, about ${span(w.approxDays)}), by ${w.method}. ` +
        `${w.sampledTxs} of ${w.candidateTxs} candidate transactions were expanded into full call trees. ` +
        (w.sampled
          ? "The counts describe that sample, not the lifetime of the contract. Raise the depth setting to widen the window."
          : "Every candidate transaction in the window was traced."),
    });
  }

  /* --- inbound attribution ----------------------------------------------- */
  const inbound = runtime.inbound.edges;
  const unknownCaller = inbound.filter((e) => !e.callerIsEoa && !e.callerSelector);
  if (inbound.length > 0) {
    checks.push({
      id: "inbound-attribution",
      title: "Caller function resolution",
      status: unknownCaller.length > 0 ? "info" : "ok",
      detail:
        `${inbound.length - unknownCaller.length} of ${inbound.length} inbound edges name the caller function. ` +
        (unknownCaller.length > 0
          ? `${unknownCaller.length} edges show "Unknown caller function", because the parent frame gave no readable selector. No caller name is invented.`
          : "Every caller function came from the parent frame of the call tree."),
    });
  }

  /* --- causality ----------------------------------------------------------*/
  checks.push({
    id: "causality",
    title: "Call path evidence",
    status: "ok",
    detail:
      "Every observed edge comes from a direct parent and child relation in a call tree. " +
      "Two contracts that only appear in the same transaction never produce an edge.",
  });

  /* --- labels -------------------------------------------------------------*/
  if (input.totalCounterparties > 0) {
    checks.push({
      id: "labels",
      title: "Address labels",
      status: input.labelledCounterparties === input.totalCounterparties ? "ok" : "info",
      detail:
        `${input.labelledCounterparties} of ${input.totalCounterparties} counterparty addresses have a name from a token, from a verified contract, or from ENS. ` +
        "The rest show a shortened address. " +
        (input.labelBudgetSkipped > 0
          ? `${input.labelBudgetSkipped} addresses beyond the lookup budget kept a shortened address, and they are the least active ones. `
          : "") +
        (input.labelLookupsRefused > 0
          ? `The explorer refused ${input.labelLookupsRefused} label lookups, so those names are missing for that reason, not because the address is unknown.`
          : ""),
    });
  }

  for (const warning of statics.warnings.slice(0, 6)) {
    checks.push({ id: `static-warning-${checks.length}`, title: "Source analysis limit", status: "info", detail: warning });
  }
  for (const warning of runtime.warnings.slice(0, 6)) {
    checks.push({ id: `runtime-warning-${checks.length}`, title: "Trace analysis limit", status: "info", detail: warning });
  }

  return { checks };
}
