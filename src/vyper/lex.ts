/**
 * Line-level lexer for Vyper source. Vyper scopes blocks by indentation, not
 * braces, so the parser works one line at a time instead of walking a token
 * stream. This module turns raw source into a list of logical lines: each
 * line keeps its indentation width, its comment-free text, and its original
 * text for snippets.
 *
 * A line inside a triple-quoted docstring carries no code, so its text is
 * blank and it is skipped by every block search. `#` inside a string or a
 * docstring is not a comment; the scanner tracks quote state to tell them
 * apart.
 */

export interface VyperLine {
  /** 1-based source line number. */
  no: number;
  /** Indentation width, tabs counted as 4 spaces. -1 for a blank or comment-only line. */
  indent: number;
  /** Comment-stripped, trimmed text. Empty for a blank or comment-only line. */
  text: string;
  /** Original source line, unchanged, for snippets. */
  original: string;
}

export interface StrippedVyper {
  lines: VyperLine[];
  /** The first module-level triple-quoted string, when the file opens with one. */
  moduleDocstring?: string;
}

const TRIPLE = ['"""', "'''"] as const;

/** Strips comments and blanks docstring bodies, keeping the line/indent layout intact. */
export function stripVyper(content: string): StrippedVyper {
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const lines: VyperLine[] = [];
  let inTriple: string | undefined;
  let inTripleAt = -1;
  const docstringParts: string[] = [];
  let docstringDone = false;
  let sawAnyCode = false;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    let out = "";
    let j = 0;
    let inStr: string | undefined;
    let tripleStartedHere = false;

    while (j < raw.length) {
      if (inTriple) {
        const closeIdx = raw.indexOf(inTriple, j);
        if (!docstringDone && !sawAnyCode) docstringParts.push(closeIdx === -1 ? raw.slice(j) : raw.slice(j, closeIdx));
        if (closeIdx === -1) {
          j = raw.length;
          break;
        }
        j = closeIdx + 3;
        inTriple = undefined;
        if (!sawAnyCode) docstringDone = true;
        continue;
      }
      const ch = raw[j] as string;
      if (inStr) {
        out += ch;
        if (ch === "\\") {
          out += raw[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (ch === inStr) inStr = undefined;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const three = raw.slice(j, j + 3);
        if (three === ch + ch + ch) {
          inTriple = three;
          inTripleAt = i;
          tripleStartedHere = true;
          j += 3;
          continue;
        }
        inStr = ch;
        out += ch;
        j++;
        continue;
      }
      if (ch === "#") break;
      out += ch;
      j++;
    }

    const codeSoFar = out.trim();
    if (codeSoFar.length > 0) sawAnyCode = true;
    if (tripleStartedHere && codeSoFar.length === 0 && !sawAnyCode) {
      // A bare module or function docstring line: keep scanning, contributes no code.
    }
    void inTripleAt;

    const indentMatch = /^[ \t]*/.exec(raw);
    const leading = indentMatch ? indentMatch[0] : "";
    const indentWidth = leading.replace(/\t/g, "    ").length;
    const trimmed = out.trim();
    lines.push({ no: i + 1, indent: trimmed.length === 0 ? -1 : indentWidth, text: trimmed, original: raw });
  }

  const moduleDocstring = docstringParts.length > 0 ? docstringParts.join("\n").trim() : undefined;
  return { lines, moduleDocstring: moduleDocstring && moduleDocstring.length > 0 ? moduleDocstring : undefined };
}

/**
 * Reads a triple-quoted docstring starting at `originalLines[fromIdx]`, when
 * that line's first non-blank token is a triple quote. Returns the text and
 * the 0-based index of the line the docstring closes on, so the caller can
 * skip past it.
 */
export function extractDocstring(originalLines: string[], fromIdx: number): { text: string; endIdx: number } | undefined {
  const first = (originalLines[fromIdx] ?? "").trim();
  let quote: string | undefined;
  for (const q of TRIPLE) if (first.startsWith(q)) quote = q;
  if (!quote) return undefined;
  const parts: string[] = [];
  const rest = first.slice(quote.length);
  for (let i = fromIdx; i < originalLines.length; i++) {
    const line = i === fromIdx ? rest : (originalLines[i] ?? "");
    const closeIdx = line.indexOf(quote);
    if (closeIdx === -1) {
      parts.push(line);
      continue;
    }
    parts.push(line.slice(0, closeIdx));
    return { text: parts.join("\n").trim(), endIdx: i };
  }
  return { text: parts.join("\n").trim(), endIdx: originalLines.length - 1 };
}

/** Depth of `()[]{}` nesting at `index` within `text`, ignoring string contents. */
export function depthAt(text: string, index: number): number {
  let depth = 0;
  let inStr: string | undefined;
  for (let i = 0; i < index && i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/** Splits `text` on top-level occurrences of a single-character separator, ignoring brackets and strings. */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Finds the top-level assignment operator in a statement, e.g. `=`, `+=`.
 * Returns undefined for a non-assignment statement or a comparison like `==`.
 */
export function findAssignment(text: string): { op: string; lhs: string; rhs: string } | undefined {
  const ops = ["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>="];
  let depth = 0;
  let inStr: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0) {
      for (const op of ops) {
        if (text.startsWith(op, i)) return { op, lhs: text.slice(0, i), rhs: text.slice(i + op.length) };
      }
      if (ch === "=" && text[i + 1] !== "=" && text[i - 1] !== "=" && text[i - 1] !== "!" && text[i - 1] !== "<" && text[i - 1] !== ">") {
        return { op: "=", lhs: text.slice(0, i), rhs: text.slice(i + 1) };
      }
    }
  }
  return undefined;
}
