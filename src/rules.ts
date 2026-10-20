export type Severity = "error" | "warning" | "info";
export type RuleSetting = Severity | "off";

export interface RuleInfo {
  id: string;
  severity: Severity;
  description: string;
}

/** Every rule, with its default severity. */
export const RULES: readonly RuleInfo[] = [
  { id: "syntax/unclosed-tag", severity: "error", description: "A `{{`, `{%` or `${` placeholder is never closed." },
  { id: "syntax/empty-tag", severity: "error", description: "A placeholder with nothing inside, like `{{ }}`." },
  { id: "syntax/unbalanced-block", severity: "error", description: "`{{#if}}` / `{% for %}` blocks that are never closed, or closed with the wrong tag." },
  { id: "syntax/mixed-delimiters", severity: "warning", description: "The template mixes placeholder styles, like `{{name}}` and `{name}`. Only one of them gets filled in." },
  { id: "variables/undefined", severity: "error", description: "A variable is used but not declared (in the config, `--var` or frontmatter)." },
  { id: "variables/unused", severity: "warning", description: "A declared variable is never used." },
  { id: "variables/similar-names", severity: "warning", description: "Two variables differ only in case or separators, like `userName` and `user_name`: usually a typo." },
  { id: "variables/inconsistent-naming", severity: "info", description: "Variables mix camelCase and snake_case." },
  { id: "structure/unbalanced-xml", severity: "error", description: "An XML-style section like `<context>` is never closed, or closed without being opened." },
  { id: "structure/unclosed-code-fence", severity: "error", description: "A ``` code block is never closed, so the rest of the prompt becomes code." },
  { id: "structure/duplicate-line", severity: "warning", description: "The same instruction appears more than once." },
  { id: "content/empty", severity: "error", description: "The prompt is empty." },
  { id: "content/secret", severity: "error", description: "Something that looks like an API key, token or private key." },
  { id: "content/leftover-placeholder", severity: "warning", description: "Fill-in text left behind, like `[insert example here]` or `<YOUR_NAME>`." },
  { id: "content/todo", severity: "warning", description: "TODO, FIXME, TBD or lorem ipsum left in the prompt." },
  { id: "content/token-budget", severity: "warning", description: "The prompt is estimated to be longer than `maxTokens`." },
  { id: "style/shouting", severity: "info", description: "ALL-CAPS emphasis like IMPORTANT or MUST. Current models follow instructions closely, and shouting tends to make them overdo it." },
  { id: "style/vague", severity: "info", description: "Hedging words like 'try to', 'if possible' or 'etc.' that make an instruction unclear." },
  { id: "style/negative-instruction", severity: "info", description: "An instruction that only says what not to do. Saying what to do instead works better." },
];

export const RULE_IDS: ReadonlySet<string> = new Set(RULES.map((r) => r.id));
