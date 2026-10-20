import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, optionsFor, type Config } from "./config.js";
import { DEFAULT_IGNORE, DEFAULT_INCLUDE, findFiles } from "./files.js";
import type { FileResult } from "./format.js";
import { lint, type LintOptions } from "./lint.js";

export { CONFIG_FILES, defineConfig, loadConfig, optionsFor, type Config, type Override } from "./config.js";
export { DEFAULT_IGNORE, DEFAULT_INCLUDE, findFiles, globToRegExp } from "./files.js";
export { formatGithub, formatJson, formatStylish, totals, type FileResult, type Totals } from "./format.js";
export { lint, validateRules, type Diagnostic, type LintOptions } from "./lint.js";
export { RULES, type RuleInfo, type RuleSetting, type Severity } from "./rules.js";
export type { Syntax } from "./syntax.js";

export interface LintFilesOptions {
  /** Directory paths and globs are relative to. Default `process.cwd()`. */
  cwd?: string;
  /** Use this config instead of looking for a config file. */
  config?: Config;
  /** Options applied on top of the config (like `--var` on the command line). */
  overrides?: LintOptions;
}

/** Applies `extra` on top of `base`: variables are added together, rules merged, everything else replaced. */
export function mergeOptions(base: LintOptions, extra: LintOptions = {}): LintOptions {
  return {
    ...base,
    ...extra,
    variables: extra.variables ? [...(base.variables ?? []), ...extra.variables] : base.variables,
    rules: { ...base.rules, ...extra.rules },
  };
}

/** Lints the files matching `patterns` (or the config's `include`, or the defaults) and returns one result per file. */
export async function lintFiles(patterns: readonly string[] = [], options: LintFilesOptions = {}): Promise<FileResult[] & { unmatched: string[] }> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? (await loadConfig(cwd)).config;
  const search = patterns.length ? patterns : (config.include ?? DEFAULT_INCLUDE);
  const { files, unmatched } = findFiles(search, cwd, [...DEFAULT_IGNORE, ...(config.ignore ?? [])]);
  const results = files.map((file): FileResult => {
    const merged = mergeOptions(optionsFor(config, file), options.overrides);
    return { file, diagnostics: lint(readFileSync(resolve(cwd, file), "utf8"), merged) };
  });
  return Object.assign(results, { unmatched: patterns.length ? unmatched : [] });
}
