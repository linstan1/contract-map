/**
 * Comment and string stripping for Solidity source, with a line index and
 * natspec capture.
 *
 * The parser never reads raw source. It reads `clean`, which has every
 * comment and every string literal blanked to spaces. Blanking keeps the
 * character offsets and the line layout identical to the original text, so
 * an offset found in `clean` still points at the right line and the right
 * snippet in `original`.
 *
 * Doc comments (`///` or `/** ... *\/`) are not part of `clean` either, but
 * their text is kept in `natspecByLine`, keyed by the line number of the
 * declaration that follows them.
 */

export interface StrippedSource {
  /** Original source, unchanged. Used only to render snippets. */
  original: string;
  /** Source with comments and string literals blanked to spaces. Used for parsing. */
  clean: string;
  /** Doc comment text, keyed by the 1-based line of the declaration it documents. */
  natspecByLine: Map<number, string>;
  /** Offset of the first character of each line, 0-based, index 0 unused. */
  lineStarts: number[];
}

interface DocBlock {
  text: string;
  /** Line the block ends on. */
  endLine: number;
}

/** Strips comments and strings, keeps doc comments, and builds the line index. */
export function stripSource(source: string): StrippedSource {
  const n = source.length;
  const clean: string[] = new Array(n);
  const docBlocks: DocBlock[] = [];
  const lineStarts: number[] = [0];
  let line = 1;
  let i = 0;

  while (i < n) {
    const c = source[i];
    if (c === "\n") {
      clean[i] = "\n";
      i++;
      line++;
      lineStarts.push(i);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      const isDoc = source[i + 2] === "/" && source[i + 3] !== "/";
      while (i < n && source[i] !== "\n") {
        clean[i] = " ";
        i++;
      }
      if (isDoc) docBlocks.push({ text: source.slice(start + 3, i).trim(), endLine: line });
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      const isDoc = source[i + 2] === "*" && source[i + 3] !== "/";
      clean[i] = " ";
      clean[i + 1] = " ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          clean[i] = "\n";
          i++;
          line++;
          lineStarts.push(i);
        } else {
          clean[i] = " ";
          i++;
        }
      }
      if (i < n) {
        clean[i] = " ";
        clean[i + 1] = " ";
        i += 2;
      }
      if (isDoc) {
        const body = source
          .slice(start, i)
          .replace(/^\/\*\*/, "")
          .replace(/\*\/$/, "")
          .split("\n")
          .map((l) => l.replace(/^\s*\*\s?/, ""))
          .join("\n")
          .trim();
        docBlocks.push({ text: body, endLine: line });
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      clean[i] = " ";
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") {
          clean[i] = " ";
          i++;
          if (i < n) {
            if (source[i] === "\n") {
              clean[i] = "\n";
              line++;
              lineStarts.push(i + 1);
            } else clean[i] = " ";
            i++;
          }
          continue;
        }
        if (source[i] === "\n") {
          clean[i] = "\n";
          line++;
          lineStarts.push(i + 1);
        } else clean[i] = " ";
        i++;
      }
      if (i < n) {
        clean[i] = " ";
        i++;
      }
      continue;
    }
    if (c !== undefined) clean[i] = c;
    i++;
  }

  const cleanText = clean.join("");
  const natspecByLine = resolveNatspec(docBlocks, cleanText);
  return { original: source, clean: cleanText, natspecByLine, lineStarts };
}

/** Groups adjacent doc-comment lines and attaches each group to the next non-blank line. */
function resolveNatspec(docBlocks: DocBlock[], clean: string): Map<number, string> {
  const lines = clean.split("\n");
  const groups: { texts: string[]; lastLine: number }[] = [];
  for (const block of docBlocks) {
    const last = groups[groups.length - 1];
    if (last && block.endLine === last.lastLine + 1) {
      last.texts.push(block.text);
      last.lastLine = block.endLine;
    } else {
      groups.push({ texts: [block.text], lastLine: block.endLine });
    }
  }
  const out = new Map<number, string>();
  for (const group of groups) {
    let l = group.lastLine + 1;
    while (l <= lines.length && (lines[l - 1] ?? "").trim() === "") l++;
    if (l <= lines.length) {
      const text = group.texts.filter((t) => t.length > 0).join("\n");
      if (text.length === 0) continue;
      const existing = out.get(l);
      out.set(l, existing ? `${existing}\n${text}` : text);
    }
  }
  return out;
}

/** 1-based line number containing `offset`. */
export function lineAtOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Trimmed text of one line, taken from the original source. */
export function lineTextAt(original: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const rest = original.indexOf("\n", start);
  const end = rest === -1 ? original.length : rest;
  return original.slice(start, end).trim();
}
