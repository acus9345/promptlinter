/** Maps string offsets to 1-based line and column numbers. */
export class Positions {
  readonly #starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.#starts.push(i + 1);
  }

  at(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.#starts[lo]! + 1 };
  }
}

/** Replaces a range with spaces, keeping newlines so offsets and lines still line up. */
export function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

export interface Frontmatter {
  /** Offset where the body starts (0 when there is no frontmatter). */
  end: number;
  /** Variables declared as `variables`, `input_variables` or Prompty `inputs`. */
  variables: string[] | undefined;
}

/**
 * Reads a leading `---` YAML block. Only the parts promptcheck needs are
 * parsed: `variables: [a, b]`, a `- a` list under `variables:` or
 * `input_variables:`, or the keys of a Prompty `inputs:` mapping.
 */
export function readFrontmatter(text: string): Frontmatter {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { end: 0, variables: undefined };
  const lines = m[1]!.split(/\r?\n/);
  let variables: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const head = /^(variables|input_variables|inputs)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!head) continue;
    variables ??= [];
    const inline = head[2]!.trim();
    if (inline.startsWith("[")) {
      for (const v of inline.replace(/^\[|\]$/g, "").split(",")) {
        const name = v.trim().replace(/^["']|["']$/g, "");
        if (name) variables.push(name);
      }
      continue;
    }
    // Indented block: "- name" items or "name:" mapping keys at the first indent level.
    let indent: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      const lead = /^\s*/.exec(line)![0].length;
      if (lead === 0) break;
      indent ??= lead;
      if (lead !== indent) continue;
      const item = /^\s*-\s*["']?([\w.-]+)["']?\s*$/.exec(line) ?? /^\s*["']?([\w.-]+)["']?\s*:/.exec(line);
      if (item) variables.push(item[1]!);
    }
  }
  return { end: m[0].length, variables };
}

/**
 * Blanks out fenced code blocks and inline code, so prose rules don't fire on
 * code examples. Returns the masked text and the ranges of fenced blocks.
 */
export function maskCode(text: string): { masked: string; fences: Array<[number, number]>; unclosedFence: number | undefined } {
  let masked = text;
  const fences: Array<[number, number]> = [];
  const lineRe = /^.*$/gm;
  let open: { marker: string; start: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text))) {
    const line = m[0].replace(/\r$/, "");
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.marker[0] && close[1]!.length >= open.marker.length) {
        fences.push([open.start, m.index + m[0].length]);
        open = undefined;
      }
    } else {
      const start = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (start) open = { marker: start[1]!, start: m.index };
    }
    if (m[0].length === 0) lineRe.lastIndex++;
  }
  const unclosedFence = open?.start;
  if (open) fences.push([open.start, text.length]);
  for (const [s, e] of fences) masked = blank(masked, s, e);
  masked = masked.replace(/(`+)([^`\n]+?)\1/g, (s) => " ".repeat(s.length));
  return { masked, fences, unclosedFence };
}
