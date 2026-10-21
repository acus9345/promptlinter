#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, optionsFor } from "./config.js";
import { formatGithub, formatJson, formatStylish, totals, type FileResult } from "./format.js";
import { lintFiles, mergeOptions } from "./index.js";
import { lint, type LintOptions } from "./lint.js";
import { RULES } from "./rules.js";

const HELP = `promptlinter: lint prompt templates

Usage
  promptlinter [files, directories or globs...]

With no paths, checks *.prompt, *.prompty, *.prompt.md (and friends) and files in prompts/ directories.

Options
  --var <name>          A variable the template is rendered with (repeatable). Turns on the variable checks.
  --vars <a,b,c>        Several variables at once.
  --syntax <name>       auto (default), mustache, jinja, fstring, js or none.
  --max-tokens <n>      Warn when a prompt is estimated to be longer than this.
  --format <name>       stylish (default), json or github (default inside GitHub Actions).
  --max-warnings <n>    Exit with an error when there are more warnings than this.
  --quiet               Only report errors.
  --config <path>       Use this config file instead of searching for one.
  --stdin               Read one prompt from standard input.
  --stdin-filename <f>  File name to report (and match overrides) for --stdin.
  --rules               List every rule and exit.
  -h, --help            Show this help.
  -v, --version         Show the version.

Exit codes: 0 no errors, 1 errors (or too many warnings), 2 bad usage or no files found.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      var: { type: "string", multiple: true },
      vars: { type: "string", multiple: true },
      syntax: { type: "string" },
      "max-tokens": { type: "string" },
      format: { type: "string" },
      "max-warnings": { type: "string" },
      quiet: { type: "boolean" },
      config: { type: "string" },
      stdin: { type: "boolean" },
      "stdin-filename": { type: "string" },
      rules: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (values.rules) {
    const width = Math.max(...RULES.map((r) => r.id.length));
    for (const r of RULES) process.stdout.write(`${r.id.padEnd(width)}  ${r.severity.padEnd(7)}  ${r.description}\n`);
    return 0;
  }

  const syntaxes = ["auto", "none", "mustache", "jinja", "fstring", "js"];
  if (values.syntax && !syntaxes.includes(values.syntax)) throw new UsageError(`--syntax must be one of ${syntaxes.join(", ")}.`);
  const number = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a whole number.`);
    return n;
  };
  const maxTokens = number("--max-tokens", values["max-tokens"]);
  const maxWarnings = number("--max-warnings", values["max-warnings"]);
  const format = values.format ?? (process.env.GITHUB_ACTIONS === "true" ? "github" : "stylish");
  if (!["stylish", "json", "github"].includes(format)) throw new UsageError("--format must be stylish, json or github.");

  const variables = [...(values.var ?? []), ...(values.vars ?? []).flatMap((v) => v.split(","))].map((v) => v.trim()).filter(Boolean);
  const overrides: LintOptions = {
    ...(values.syntax ? { syntax: values.syntax as LintOptions["syntax"] } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(variables.length ? { variables } : {}),
  };

  const cwd = process.cwd();
  const { config } = await loadConfig(cwd, values.config);
  let results: FileResult[];
  if (values.stdin) {
    const file = values["stdin-filename"] ?? "<stdin>";
    results = [{ file, diagnostics: lint(readFileSync(0, "utf8"), mergeOptions(optionsFor(config, file), overrides)) }];
  } else {
    const found = await lintFiles(positionals, { cwd, config, overrides });
    for (const p of found.unmatched) process.stderr.write(`promptlinter: no prompt files match "${p}"\n`);
    if (found.length === 0) {
      process.stderr.write(
        positionals.length
          ? "promptlinter: nothing to check.\n"
          : 'promptlinter: no prompt files found. Pass paths or globs, like "promptlinter prompts/" or "promptlinter \'src/**/*.md\'".\n',
      );
      return 2;
    }
    results = [...found];
  }

  if (values.quiet) for (const r of results) r.diagnostics = r.diagnostics.filter((d) => d.severity === "error");

  const color = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || process.stdout.isTTY === true);
  const output = format === "json" ? formatJson(results) : format === "github" ? formatGithub(results) : formatStylish(results, color);
  if (output) process.stdout.write(`${output}\n`);
  if (format === "github") process.stderr.write(`${formatStylish(results, false)}\n`);

  const t = totals(results);
  if (t.errors > 0) return 1;
  if (maxWarnings !== undefined && t.warnings > maxWarnings) {
    process.stderr.write(`promptlinter: ${t.warnings} warnings, more than --max-warnings ${maxWarnings}.\n`);
    return 1;
  }
  return 0;
}

class UsageError extends Error {}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Usage, config and unexpected errors all exit 2: nothing was linted.
    process.stderr.write(`promptlinter: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) process.stderr.write('Run "promptlinter --help" for usage.\n');
    process.exitCode = 2;
  },
);
