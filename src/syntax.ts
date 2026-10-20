/** Placeholder syntaxes promptcheck understands. */
export type Syntax = "mustache" | "jinja" | "fstring" | "js";

export type TagKind = "var" | "open" | "close" | "else" | "comment" | "partial" | "statement";

export interface Tag {
  syntax: Syntax;
  kind: TagKind;
  /** For open/close/else: the block keyword (`if`, `for`, `each`, a Mustache section name...). */
  block?: string;
  /** Variables this tag reads. */
  vars: string[];
  /** Names this tag introduces for its block (loop variables, macro arguments). */
  locals: string[];
  /** Names this tag assigns for the rest of the template (`{% set x = ... %}`). */
  defines: string[];
  raw: string;
  start: number;
  end: number;
}

export interface SyntaxProblem {
  kind: "unclosed" | "empty";
  start: number;
  end: number;
  message: string;
  /** Variables the broken tag seems to read, so they don't also show up as unused. */
  vars?: string[];
}

const JINJA_KEYWORDS = new Set([
  "and", "or", "not", "in", "is", "if", "else", "true", "false", "none", "True", "False", "None", "loop", "self", "super", "varargs", "kwargs",
]);
const HANDLEBARS_BLOCKS = new Set(["if", "each", "unless", "with", "let", "each-in"]);
const JINJA_BLOCKS = new Set(["if", "for", "block", "macro", "call", "filter", "with", "raw", "autoescape", "trans", "set"]);

/**
 * Root variable names an expression reads: `user.name | upper` → `user`,
 * `a + b[0]` → `a`, `b`. Skips strings, attributes, filters, keywords and numbers.
 */
export function expressionVars(expr: string): string[] {
  const vars: string[] = [];
  const re = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$@][\w$]*|\S/g;
  let prev = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const tok = m[0];
    const isIdent = /^[A-Za-z_$][\w$]*$/.test(tok);
    const afterDot = prev === ".";
    const afterPipe = prev === "|";
    // A keyword argument name: `fn(width=80)`.
    const isKwarg = /^\s*=(?!=)/.test(expr.slice(re.lastIndex)) && /[(,]\s*$/.test(expr.slice(0, m.index));
    if (isIdent && !afterDot && !afterPipe && !isKwarg && !JINJA_KEYWORDS.has(tok) && tok !== "this") vars.push(tok);
    // `is defined` tests and filter names are not variables either.
    prev = tok === "is" ? "|" : tok;
  }
  return [...new Set(vars)];
}

/** Variables in a Handlebars argument list: `helper a "lit" b=c` → `a`, `c`. */
function handlebarsArgs(args: string): string[] {
  const vars: string[] = [];
  for (const tok of args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
    if (/^["']/.test(tok) || /^[\d.-]+$/.test(tok) || tok.startsWith("@") || tok.startsWith("..") || tok === "this" || tok === "as") continue;
    if (/^\|.*\|$/.test(tok)) continue;
    const value = tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : tok;
    const root = /^(?:this\.)?([A-Za-z_$][\w$-]*)/.exec(value.replace(/^\(/, ""));
    if (root && !/^["']/.test(value) && root[1] !== "true" && root[1] !== "false" && root[1] !== "null") vars.push(root[1]!);
  }
  return [...new Set(vars)];
}

function mustacheTag(inner: string, start: number, end: number, raw: string): Tag {
  const base = { syntax: "mustache" as const, vars: [] as string[], locals: [] as string[], defines: [] as string[], raw, start, end };
  const body = inner.replace(/^~|~$/g, "").trim();
  if (body.startsWith("!")) return { ...base, kind: "comment" };
  if (body.startsWith(">")) return { ...base, kind: "partial" };
  if (body.startsWith("#") || body.startsWith("^")) {
    const [word = "", ...rest] = body.slice(1).trim().split(/\s+/);
    const args = rest.join(" ");
    if (HANDLEBARS_BLOCKS.has(word) && args) {
      const locals = /\bas\s+\|([^|]+)\|/.exec(args)?.[1]?.trim().split(/\s+/) ?? [];
      return { ...base, kind: "open", block: word, vars: handlebarsArgs(args.replace(/\bas\s+\|[^|]+\|/, "")), locals };
    }
    if (word.startsWith("*")) return { ...base, kind: "open", block: word };
    // A Mustache section: {{#items}}...{{/items}}
    return { ...base, kind: "open", block: word, vars: handlebarsArgs(word) };
  }
  if (body.startsWith("/")) return { ...base, kind: "close", block: body.slice(1).trim() };
  if (body === "else" || body.startsWith("else ") || body === "^") return { ...base, kind: "else", vars: handlebarsArgs(body.replace(/^else\s*(?:if\s+)?/, "")) };
  const expr = body.replace(/^&/, "").trim();
  const tokens = expr.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // `helper arg1 arg2`: the first word is a helper, not a variable.
  const vars = tokens.length > 1 && /^[A-Za-z_$][\w$-]*$/.test(tokens[0]!) ? handlebarsArgs(tokens.slice(1).join(" ")) : handlebarsArgs(expr);
  return { ...base, kind: "var", vars };
}

function jinjaStatement(inner: string, start: number, end: number, raw: string): Tag {
  const base = { syntax: "jinja" as const, vars: [] as string[], locals: [] as string[], defines: [] as string[], raw, start, end };
  const body = inner.replace(/^[-+]|[-+]$/g, "").trim();
  const [word = "", ...restWords] = body.split(/\s+/);
  const rest = restWords.join(" ");
  if (word.startsWith("end")) return { ...base, kind: "close", block: word.slice(3) };
  if (word === "else") return { ...base, kind: "else" };
  if (word === "elif") return { ...base, kind: "else", vars: expressionVars(rest) };
  if (word === "for") {
    const m = /^(.+?)\s+in\s+(.+?)(?:\s+if\s+(.+?))?(?:\s+recursive)?$/.exec(rest);
    const locals = m ? m[1]!.split(",").map((s) => s.trim().replace(/[()]/g, "")) : [];
    const vars = m ? [...expressionVars(m[2]!), ...expressionVars(m[3] ?? "").filter((v) => !locals.includes(v))] : [];
    return { ...base, kind: "open", block: "for", vars, locals: [...locals, "loop"] };
  }
  if (word === "set") {
    const eq = rest.indexOf("=");
    const names = (eq === -1 ? rest : rest.slice(0, eq)).split(",").map((s) => s.trim().replace(/\|.*$/, "").trim());
    if (eq === -1) return { ...base, kind: "open", block: "set", defines: names };
    return { ...base, kind: "statement", vars: expressionVars(rest.slice(eq + 1)), defines: names };
  }
  if (word === "macro") {
    const m = /^(\w+)\s*\(([^)]*)\)/.exec(rest);
    const locals = m ? m[2]!.split(",").map((s) => s.trim().replace(/=.*$/, "").trim()).filter(Boolean) : [];
    return { ...base, kind: "open", block: "macro", locals: [...locals, "caller", "varargs", "kwargs"], defines: m ? [m[1]!] : [] };
  }
  if (word === "with") {
    const locals = [...rest.matchAll(/(\w+)\s*=/g)].map((m) => m[1]!);
    return { ...base, kind: "open", block: "with", vars: expressionVars(rest.replace(/(\w+)\s*=(?!=)/g, " ")), locals };
  }
  if (word === "import" || word === "from") {
    const alias = /\bas\s+(\w+)/.exec(rest)?.[1];
    const names = word === "from" ? (/\bimport\s+(.+)$/.exec(rest)?.[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/).at(-1)!.trim()) : [];
    return { ...base, kind: "statement", defines: [...names, ...(alias ? [alias] : [])].filter(Boolean) };
  }
  if (word === "include" || word === "extends") return { ...base, kind: "statement" };
  if (JINJA_BLOCKS.has(word)) {
    const vars = word === "if" || word === "filter" || word === "call" ? expressionVars(word === "filter" ? "" : rest) : [];
    return { ...base, kind: "open", block: word, vars };
  }
  return { ...base, kind: "statement", vars: expressionVars(rest) };
}

/** Finds `{{ }}`, `{{{ }}}`, `{% %}` and `{# #}` tags, and unclosed ones. */
export function scanDoubleBrace(text: string, jinja: boolean): { tags: Tag[]; problems: SyntaxProblem[] } {
  const tags: Tag[] = [];
  const problems: SyntaxProblem[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.slice(i).search(jinja ? /\{[{%#]/ : /\{\{/);
    if (open === -1) break;
    const start = i + open;
    const kind = text[start + 1]!;
    const triple = kind === "{" && text[start + 2] === "{";
    const close = kind === "{" ? (triple ? "}}}" : "}}") : kind === "%" ? "%}" : "#}";
    const innerStart = start + (triple ? 3 : 2);
    const end = text.indexOf(close, innerStart);
    // A newline or another opener before the close means this tag was never closed.
    const nextOpen = kind === "#" ? -1 : text.slice(innerStart).search(/\{\{|\{%/);
    const nextOpenAt = nextOpen === -1 ? -1 : innerStart + nextOpen;
    if (end === -1 || (nextOpenAt !== -1 && nextOpenAt < end)) {
      const lineEnd = text.indexOf("\n", start);
      problems.push({
        kind: "unclosed",
        start,
        end: lineEnd === -1 ? text.length : lineEnd,
        message: `"${text.slice(start, innerStart)}" is never closed with "${close}".`,
        vars: kind === "{" ? expressionVars(text.slice(innerStart, lineEnd === -1 ? text.length : lineEnd)) : [],
      });
      i = innerStart;
      continue;
    }
    const inner = text.slice(innerStart, end);
    const raw = text.slice(start, end + close.length);
    const tagEnd = end + close.length;
    i = tagEnd;
    if (kind === "#") {
      tags.push({ syntax: "jinja", kind: "comment", vars: [], locals: [], defines: [], raw, start, end: tagEnd });
      continue;
    }
    if (!inner.replace(/^[-~+]|[-~+]$/g, "").trim()) {
      problems.push({ kind: "empty", start, end: tagEnd, message: `Empty tag "${raw}".` });
      continue;
    }
    if (kind === "%") {
      const tag = jinjaStatement(inner, start, tagEnd, raw);
      tags.push(tag);
      // Skip everything inside {% raw %}...{% endraw %}.
      if (tag.kind === "open" && tag.block === "raw") {
        const endRaw = /\{%-?\s*endraw\s*-?%\}/.exec(text.slice(i));
        if (endRaw) {
          const closeStart = i + endRaw.index;
          i = closeStart + endRaw[0].length;
          tags.push({ ...tag, kind: "close", block: "raw", raw: endRaw[0], start: closeStart, end: i });
        }
      }
      continue;
    }
    if (jinja) {
      const body = inner.replace(/^-|-$/g, "");
      tags.push({ syntax: "jinja", kind: "var", vars: expressionVars(body), locals: [], defines: [], raw, start, end: tagEnd });
    } else {
      tags.push(mustacheTag(inner, start, tagEnd, raw));
    }
  }
  return { tags, problems };
}

/** Python `str.format` / LangChain style `{name}` placeholders. `{{` and `}}` are escaped braces. */
export function scanFString(text: string): Tag[] {
  const tags: Tag[] = [];
  const re = /\{\{|\}\}|\{([A-Za-z_]\w*)((?:\.\w+|\[[^\]{}]*\])*)(![rsa])?(:[^{}\n]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[1]) continue;
    if (text[m.index - 1] === "$") continue;
    tags.push({ syntax: "fstring", kind: "var", vars: [m[1]], locals: [], defines: [], raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tags;
}

/** JavaScript template-literal style `${name}` placeholders. */
export function scanJs(text: string): { tags: Tag[]; problems: SyntaxProblem[] } {
  const tags: Tag[] = [];
  const problems: SyntaxProblem[] = [];
  const re = /\$\{([^{}\n]*)(\}?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (!m[2]) {
      problems.push({ kind: "unclosed", start: m.index, end, message: `"\${" is never closed with "}".` });
      continue;
    }
    if (!m[1]!.trim()) {
      problems.push({ kind: "empty", start: m.index, end, message: `Empty placeholder "${m[0]}".` });
      continue;
    }
    tags.push({ syntax: "js", kind: "var", vars: expressionVars(m[1]!), locals: [], defines: [], raw: m[0], start: m.index, end });
  }
  return { tags, problems };
}

/** Which syntaxes appear in a template. `prose` has code blocks masked out. */
export function detectSyntaxes(text: string, prose: string): Set<Syntax> {
  const found = new Set<Syntax>();
  const doubles = [...text.matchAll(/\{\{(?!\{)([\s\S]*?)\}\}/g)].map((m) => m[1]!);
  // A filter (`{{ name | upper }}`) is Jinja; Handlebars only uses pipes in `as |item|` block params.
  const filter = doubles.some((inner) => !/^\s*[#^/!>]/.test(inner) && /(?:^|[^|])\|(?:[^|]|$)/.test(inner));
  if (/\{%/.test(text) || /\{#[\s\S]*?#\}/.test(text) || filter) found.add("jinja");
  else if (doubles.length > 0 || text.includes("{{")) found.add("mustache");
  if (prose.includes("${")) found.add("js");
  const withoutDouble = prose.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (s) => " ".repeat(s.length));
  if (scanFString(withoutDouble).length > 0) {
    found.add("fstring");
    // In f-string templates `{{"key": "..."}}` is an escaped brace, not a tag: drop the
    // double-brace syntax when none of its tags start like an expression.
    if (found.has("mustache") && doubles.length > 0 && doubles.every((inner) => /^\s*["'{[]/.test(inner))) {
      found.delete("mustache");
    }
  }
  return found;
}
