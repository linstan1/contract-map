/**
 * Selector resolution: ABI first, then the openchain and 4byte signature
 * databases as a fallback. A database candidate is trusted only after its
 * keccak256 selector is recomputed and matches the selector being resolved,
 * so a spam entry (4byte is full of them) can never mislabel a call.
 */

import { selectorOf, signatureOf } from "./abi";
import { SIGNATURE_SOURCES } from "./config";
import type { AbiEntry } from "./types";

export interface SignatureLookup {
  selector?: string;
  signature?: string;
  name?: string;
  source: string;
}

/** Selectors already resolved from a signature database, kept for the process lifetime. */
const globalResolved = new Map<string, SignatureLookup>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(container: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = container?.[key];
  return typeof value === "string" ? value : undefined;
}

function nameFromSignature(signature: string): string | undefined {
  const openParen = signature.indexOf("(");
  return openParen > 0 ? signature.slice(0, openParen) : undefined;
}

/**
 * Verifies candidate signatures against a requested selector and ranks the
 * survivors shortest first. Pure, so tests can cover selector verification
 * and ambiguity without a network call.
 */
export function verifySelectorCandidates(
  selector: string,
  candidateSignatures: string[],
): { chosen?: string; alternatives: string[] } {
  const verified = [...new Set(candidateSignatures.filter((signature) => selectorOf(signature) === selector))];
  verified.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const [chosen, ...alternatives] = verified;
  return { chosen, alternatives };
}

function chunkOf(items: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

async function fetchJsonQuiet(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

export class SignatureRegistry {
  private readonly store = new Map<string, SignatureLookup>();
  /** Selector -> every ABI signature that collided with the first one registered. */
  private readonly collisions = new Map<string, string[]>();
  /** Selector -> the shorter-losing database candidates, for a UI ambiguity warning. */
  private readonly ambiguous = new Map<string, string[]>();
  private readonly attempted = new Set<string>();

  addAbi(abi: AbiEntry[]): void {
    for (const entry of abi) {
      if (entry.type !== "function" || !entry.name) continue;
      const signature = signatureOf(entry);
      const selector = selectorOf(signature);
      const existing = this.store.get(selector);
      if (existing && existing.source === "abi") {
        if (existing.signature !== signature) {
          const list = this.collisions.get(selector) ?? [existing.signature ?? ""];
          if (!list.includes(signature)) list.push(signature);
          this.collisions.set(selector, list);
        }
        continue;
      }
      this.store.set(selector, { selector, signature, name: nameFromSignature(signature), source: "abi" });
    }
  }

  addSignature(signature: string, source = "manual"): void {
    const selector = selectorOf(signature);
    if (this.store.has(selector)) return;
    this.store.set(selector, { selector, signature, name: nameFromSignature(signature), source });
  }

  lookup(selector?: string): SignatureLookup {
    if (!selector) return { source: "unknown" };
    const hit = this.store.get(selector) ?? globalResolved.get(selector);
    return hit ?? { selector, source: "unknown" };
  }

  /** Selectors this registry could not explain from an ABI or a signature database. */
  unresolved(): string[] {
    return [...this.attempted].filter((selector) => !this.store.has(selector) && !globalResolved.has(selector));
  }

  collisionsFor(selector: string): string[] | undefined {
    return this.collisions.get(selector);
  }

  ambiguousFor(selector: string): string[] | undefined {
    return this.ambiguous.get(selector);
  }

  private accept(selector: string, candidateSignatures: string[], source: string): void {
    const { chosen, alternatives } = verifySelectorCandidates(selector, candidateSignatures);
    if (!chosen) return;
    const entry: SignatureLookup = { selector, signature: chosen, name: nameFromSignature(chosen), source };
    this.store.set(selector, entry);
    globalResolved.set(selector, entry);
    if (alternatives.length > 0) this.ambiguous.set(selector, alternatives);
  }

  /** Bulk-resolves unknown selectors from the signature databases. Never throws. */
  async resolve(selectors: string[]): Promise<void> {
    const requested = [...new Set(selectors.filter((s): s is string => /^0x[0-9a-fA-F]{8}$/.test(s ?? "")))].map((s) =>
      s.toLowerCase(),
    );
    const unknown = requested.filter((s) => !this.store.has(s) && !globalResolved.has(s) && !this.attempted.has(s));
    if (unknown.length === 0) return;

    for (const batch of chunkOf(unknown, 50)) {
      try {
        const url = `${SIGNATURE_SOURCES.openchain}?function=${batch.join(",")}&filter=true`;
        const data = await fetchJsonQuiet(url);
        const fnMap = asRecord(asRecord(asRecord(data)?.result)?.function);
        for (const selector of batch) {
          this.attempted.add(selector);
          const candidates = fnMap?.[selector];
          if (!Array.isArray(candidates)) continue;
          const names = candidates.map((c) => stringField(asRecord(c), "name")).filter((n): n is string => typeof n === "string");
          this.accept(selector, names, "openchain");
        }
      } catch {
        for (const selector of batch) this.attempted.add(selector);
      }
    }

    const stillUnknown = unknown.filter((s) => !this.store.has(s));
    await Promise.all(
      stillUnknown.map(async (selector) => {
        try {
          const url = `${SIGNATURE_SOURCES.fourByte}?hex_signature=${selector}`;
          const data = await fetchJsonQuiet(url);
          const results = asRecord(data)?.results;
          const items = Array.isArray(results) ? results : [];
          const names = items.map((r) => stringField(asRecord(r), "text_signature")).filter((n): n is string => typeof n === "string");
          this.accept(selector, names, "4byte");
        } catch {
          // The selector stays unresolved; `lookup` reports it as `source: "unknown"`.
        }
      }),
    );
  }
}
