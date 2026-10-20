import { RULES, RULE_IDS, type RuleSetting, type Severity } from "./rules.js";
import { detectSyntaxes, scanDoubleBrace, scanFString, scanJs, type Syntax, type SyntaxProblem, type Tag } from "./syntax.js";
import { blank, maskCode, Positions, readFrontmatter } from "./text.js";

export interface LintOptions {
  /** Placeholder syntax. `"auto"` (default) detects it; `"none"` treats the prompt as plain text. */
  syntax?: "auto" | "none" | Syntax;
  /**
   * The variables the template is rendered with. Turns on `variables/undefined`
   * and `variables/unused`. Merged with variables declared in frontmatter.
   */
  variables?: readonly string[];
  /** Change a rule's severity, or turn it `"off"`. */
  rules?: Readonly<Record<string, RuleSetting>>;
  /** Warn when the prompt is estimated to exceed this many tokens. */
  maxTokens?: number;
}

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "col", "embed", "param", "track", "base"]);
const SHOUT_WORDS = /\b(?:IMPORTANT|CRITICAL|CRUCIAL|MUST|NEVER|ALWAYS|REQUIRED|MANDATORY|ABSOLUTELY|UNDER NO CIRCUMSTANCES|DO NOT|DON'T)\b/;
const VAGUE = /\b(?:try to|if possible|where possible|as needed|as appropriate|when appropriate|and so on|and so forth|etc\.|maybe|perhaps|kind of|sort of|somehow|some sort of|stuff|things like that|if you can|feel free to)(?=\W|$)/gi;
const SECRETS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "an Anthropic API key"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, "an OpenAI API key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "an AWS access key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/g, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "a Google API key"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, "a Stripe secret key"],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, "a private key"],
];
const LEFTOVER = [
  /\[(?:insert|add|put|enter|replace|fill in|fill|your|todo)\b[^\]\n]{0,60}\]/gi,
  /<(?:your|insert)[\w\s-]{0,40}>/gi,
  /\b(?:YOUR|INSERT)_[A-Z0-9_]+\b/g,
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = normalizeName(c) === normalizeName(name) ? 0 : distance(name.toLowerCase(), c.toLowerCase());
    if (score < bestScore && score <= Math.max(1, Math.floor(name.length / 4))) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Blocks whose body is rendered with a different context, so bare names may be fields of an item. */
function changesContext(tag: Tag): boolean {
  return tag.syntax === "mustache" && tag.block !== "if" && tag.block !== "unless";
}

/** Lints one prompt template and returns its problems, sorted by position. */
export function lint(text: string, options: LintOptions = {}): Diagnostic[] {
  const positions = new Positions(text);
  const fm = readFrontmatter(text);
  const doc = blank(text, 0, fm.end);
  const out: Array<{ rule: string; message: string; start: number; end: number }> = [];
  const report = (rule: string, start: number, end: number, message: string) => out.push({ rule, start, end, message });

  if (!doc.trim()) {
    report("content/empty", 0, 0, "The prompt is empty.");
    return finish();
  }

  // Prose: code blocks, inline code and HTML comments blanked out.
  const code = maskCode(doc);
  let prose = code.masked.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, " "));

  // --- placeholders -------------------------------------------------------
  const setting = options.syntax ?? "auto";
  const syntaxes: Set<Syntax> =
    setting === "none" ? new Set() : setting === "auto" ? detectSyntaxes(doc, prose) : new Set([setting]);
  const explicit = setting !== "auto";
  const tags: Tag[] = [];
  const problems: SyntaxProblem[] = [];
  if (syntaxes.has("jinja") || syntaxes.has("mustache")) {
    const r = scanDoubleBrace(doc, syntaxes.has("jinja"));
    tags.push(...r.tags);
    problems.push(...r.problems);
  }
  const proseNoDouble = prose.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, (s) => s.replace(/[^\n]/g, " "));
  if (syntaxes.has("fstring")) tags.push(...scanFString(explicit ? doc : proseNoDouble));
  if (syntaxes.has("js")) {
    const r = scanJs(explicit ? doc : prose);
    tags.push(...r.tags);
    problems.push(...r.problems);
  }
  tags.sort((a, b) => a.start - b.start);
  for (const p of problems) report(p.kind === "unclosed" ? "syntax/unclosed-tag" : "syntax/empty-tag", p.start, p.end, p.message);

  if (!explicit) {
    const families = new Map<string, Tag>();
    for (const t of tags) {
      const family = t.syntax === "jinja" || t.syntax === "mustache" ? "{{double}}" : t.syntax === "fstring" ? "{single}" : "${js}";
      if (!families.has(family)) families.set(family, t);
    }
    if (families.size > 1) {
      const [first, ...others] = [...families.entries()];
      for (const [family, t] of others) {
        report("syntax/mixed-delimiters", t.start, t.end, `"${t.raw}" uses ${family} placeholders, but "${first![1].raw}" uses ${first![0]}. Most template engines only fill in one style; set "syntax" if this is intended.`);
      }
    }
  }

  // --- blocks and variable scope -----------------------------------------
  const stack: Tag[] = [];
  const used = new Map<string, Tag>();
  const usedAnywhere = new Set<string>(problems.flatMap((p) => p.vars ?? []));
  const defined = new Set<string>(tags.flatMap((t) => t.defines));
  for (const tag of tags) {
    if (tag.kind === "comment" || tag.kind === "partial") continue;
    const opaque = stack.some(changesContext);
    const locals = new Set(stack.flatMap((t) => t.locals));
    for (const v of tag.vars) {
      usedAnywhere.add(v);
      if (!opaque && !locals.has(v) && !defined.has(v) && !used.has(v)) used.set(v, tag);
    }
    if (tag.kind === "open") stack.push(tag);
    else if (tag.kind === "else") {
      if (!stack.some((t) => t.syntax === tag.syntax)) report("syntax/unbalanced-block", tag.start, tag.end, `"${tag.raw}" is outside any block.`);
    } else if (tag.kind === "close") {
      const at = stack.findLastIndex((t) => t.block === tag.block && t.syntax === tag.syntax);
      if (at === -1) {
        report("syntax/unbalanced-block", tag.start, tag.end, `"${tag.raw}" closes a "${tag.block}" block that was never opened.`);
        continue;
      }
      for (const t of stack.splice(at).slice(1)) {
        report("syntax/unbalanced-block", t.start, t.end, `"${t.raw}" is never closed (expected a close before "${tag.raw}").`);
      }
    }
  }
  for (const t of stack) report("syntax/unbalanced-block", t.start, t.end, `"${t.raw}" is never closed.`);

  // --- variables -----------------------------------------------------------
  const declared = options.variables || fm.variables ? new Set([...(options.variables ?? []), ...(fm.variables ?? [])]) : undefined;
  if (declared) {
    for (const [name, tag] of used) {
      if (declared.has(name)) continue;
      const hint = closest(name, declared);
      report("variables/undefined", tag.start, tag.end, `"${name}" is not a declared variable${hint ? `. Did you mean "${hint}"?` : ` (declared: ${[...declared].join(", ") || "none"}).`}`);
    }
    for (const name of declared) {
      if (usedAnywhere.has(name) || defined.has(name)) continue;
      const at = fm.end > 0 ? text.slice(0, fm.end).search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)) : -1;
      report("variables/unused", Math.max(at, 0), at >= 0 ? at + name.length : 0, `"${name}" is declared but never used.`);
    }
  }
  const allUsed = [...used.keys()];
  const groups = new Map<string, string[]>();
  for (const name of allUsed) groups.set(normalizeName(name), [...(groups.get(normalizeName(name)) ?? []), name]);
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    for (const name of names.slice(1)) {
      const tag = used.get(name)!;
      report("variables/similar-names", tag.start, tag.end, `"${name}" and "${names[0]}" differ only in case or separators. Is one a typo?`);
    }
  }
  const camel = allUsed.filter((n) => /^[a-z][a-z0-9]*[A-Z]/.test(n) && !n.includes("_"));
  const snake = allUsed.filter((n) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(n));
  if (camel.length > 0 && snake.length > 0) {
    const minority = camel.length < snake.length ? camel : snake;
    const tag = used.get(minority[0]!)!;
    report("variables/inconsistent-naming", tag.start, tag.end, `Variables mix camelCase (${camel.slice(0, 3).join(", ")}) and snake_case (${snake.slice(0, 3).join(", ")}).`);
  }

  // From here on, rules look at prose without template tags.
  for (const t of tags) prose = blank(prose, t.start, t.end);

  // --- structure -------------------------------------------------------------
  if (code.unclosedFence !== undefined) {
    const lineEnd = doc.indexOf("\n", code.unclosedFence);
    report("structure/unclosed-code-fence", code.unclosedFence, lineEnd === -1 ? doc.length : lineEnd, "This code block is never closed, so everything after it is treated as code.");
  }

  const xml: Array<{ name: string; start: number; end: number; raw: string }> = [];
  for (const m of prose.matchAll(/<(\/?)([A-Za-z][\w.:-]*)(\s[^<>]*?)?(\/?)>/g)) {
    const [raw, slash, name, , selfClose] = m;
    // <YOUR_NAME> is a leftover placeholder, not a section.
    if (selfClose || name!.length < 2 || VOID_ELEMENTS.has(name!.toLowerCase()) || (/^[A-Z0-9_]+$/.test(name!) && name!.includes("_")) || /^(?:your|insert)$/i.test(name!)) continue;
    const start = m.index!;
    const end = start + raw.length;
    if (!slash) {
      xml.push({ name: name!, start, end, raw });
      continue;
    }
    const at = xml.findLastIndex((t) => t.name === name);
    if (at === -1) {
      report("structure/unbalanced-xml", start, end, `"${raw}" closes a <${name}> section that was never opened.`);
      continue;
    }
    for (const t of xml.splice(at).slice(1)) report("structure/unbalanced-xml", t.start, t.end, `"${t.raw}" is never closed (expected </${t.name}> before "${raw}").`);
  }
  for (const t of xml) report("structure/unbalanced-xml", t.start, t.end, `"${t.raw}" is never closed with </${t.name}>.`);

  const seen = new Map<string, number>();
  for (const m of prose.matchAll(/^.*$/gm)) {
    const key = m[0]
      .trim()
      .replace(/^(?:[-*+>]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (key.length < 20 || key.split(" ").length < 4 || /^[|:\-\s]+$/.test(key)) continue;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, m.index!);
      continue;
    }
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    report("structure/duplicate-line", start, m.index! + m[0].trimEnd().length, `Repeats line ${positions.at(first).line}.`);
  }

  // --- content ---------------------------------------------------------------
  for (const [re, what] of SECRETS) {
    for (const m of doc.matchAll(re)) report("content/secret", m.index!, m.index! + m[0].length, `This looks like ${what}. Don't put secrets in prompts: they end up in logs, traces and model providers' systems.`);
  }
  const leftovers: Array<[number, number]> = [];
  for (const re of LEFTOVER) {
    for (const m of prose.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      // "<YOUR_EMAIL>" matches two patterns; report it once.
      if (leftovers.some(([s, e]) => start < e && end > s)) continue;
      leftovers.push([start, end]);
      report("content/leftover-placeholder", start, end, `"${m[0]}" looks like fill-in text that was never replaced.`);
    }
  }
  for (const m of prose.matchAll(/\b(?:TODO|FIXME|XXX|TBD)\b|\b[Ll]orem ipsum\b/g)) {
    report("content/todo", m.index!, m.index! + m[0].length, `"${m[0]}" left in the prompt.`);
  }
  if (options.maxTokens !== undefined) {
    const tokens = Math.ceil(doc.trim().length / 4);
    if (tokens > options.maxTokens) report("content/token-budget", fm.end, fm.end, `About ${tokens} tokens, over the budget of ${options.maxTokens}.`);
  }

  // --- style -----------------------------------------------------------------
  for (const m of prose.matchAll(/^.*$/gm)) {
    const line = m[0];
    const word = SHOUT_WORDS.exec(line);
    const run = /\b[A-Z]{2,}[A-Z'’]*(?:\s+[A-Z]{2,}[A-Z'’]*){2,}\b/.exec(line);
    const hit = word ?? run;
    if (hit) report("style/shouting", m.index! + hit.index, m.index! + hit.index + hit[0].length, `"${hit[0]}": ALL-CAPS emphasis tends to make current models overreact. Calm, specific wording (and the reason behind the rule) works better.`);
    const neg = /^(\s*(?:[-*+]|\d+[.)])?\s*)((?:don'?t|do not|never|avoid)\b.*)$/i.exec(line);
    if (neg && !/\b(?:instead|rather)\b/i.test(line)) {
      const start = m.index! + neg[1]!.length;
      report("style/negative-instruction", start, m.index! + line.trimEnd().length, "This only says what not to do. Say what to do instead (or add it), so the model has something to aim for.");
    }
  }
  for (const m of prose.matchAll(VAGUE)) {
    report("style/vague", m.index!, m.index! + m[0].length, `"${m[0]}" is vague. Say exactly what you want, or when it applies.`);
  }

  return finish();

  function finish(): Diagnostic[] {
    const disabledFile = new Set<string>();
    const disabledLines = new Map<number, Set<string> | "all">();
    let allOff = false;
    for (const m of text.matchAll(/promptcheck-disable(-next-line)?((?:[ \t,]+[a-z]+\/[a-z-]+)*)/g)) {
      const ids = m[2]!.split(/[\s,]+/).filter(Boolean);
      if (m[1]) disabledLines.set(positions.at(m.index!).line + 1, ids.length ? new Set(ids) : "all");
      else if (ids.length) ids.forEach((id) => disabledFile.add(id));
      else allOff = true;
    }
    if (allOff) return [];
    const defaults = new Map(RULES.map((r) => [r.id, r.severity]));
    const result: Diagnostic[] = [];
    for (const d of out) {
      const configured = options.rules?.[d.rule];
      const severity = configured ?? defaults.get(d.rule)!;
      if (severity === "off" || disabledFile.has(d.rule)) continue;
      const s = positions.at(d.start);
      const e = positions.at(Math.max(d.end, d.start));
      const lineOff = disabledLines.get(s.line);
      if (lineOff === "all" || lineOff?.has(d.rule)) continue;
      result.push({ rule: d.rule, severity, message: d.message, line: s.line, column: s.column, endLine: e.line, endColumn: e.column });
    }
    return result.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  }
}

/** Throws on unknown rule ids or severities, so config typos don't silently do nothing. */
export function validateRules(rules: Readonly<Record<string, unknown>>): void {
  for (const [id, value] of Object.entries(rules)) {
    if (!RULE_IDS.has(id)) throw new Error(`Unknown rule "${id}". Run "promptcheck --rules" to list them.`);
    if (!["error", "warning", "info", "off"].includes(value as string)) throw new Error(`Rule "${id}" must be "error", "warning", "info" or "off", not ${JSON.stringify(value)}.`);
  }
}
