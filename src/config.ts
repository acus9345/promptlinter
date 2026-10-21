import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { matchesAny } from "./files.js";
import { validateRules, type LintOptions } from "./lint.js";

export interface Override extends LintOptions {
  /** Globs (relative to the config file) this override applies to. */
  files: string | string[];
}

export interface Config extends LintOptions {
  /** Globs to lint when no paths are given on the command line. */
  include?: string[];
  /** Extra globs to skip. */
  ignore?: string[];
  /** Options for specific files, applied in order on top of the base options. */
  overrides?: Override[];
}

/** Config file names, in the order they are looked for. */
export const CONFIG_FILES = [
  "promptlinter.config.json",
  ".promptlinterrc.json",
  ".promptlinterrc",
  "promptlinter.config.js",
  "promptlinter.config.mjs",
] as const;

/** Lets JS config files get type checking: `export default defineConfig({ ... })`. */
export function defineConfig(config: Config): Config {
  return config;
}

function check(config: unknown, from: string): Config {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${from}: the config must be an object.`);
  const c = config as Config;
  if (c.rules) validateRules(c.rules);
  for (const o of c.overrides ?? []) {
    if (!o.files) throw new Error(`${from}: every override needs "files".`);
    if (o.rules) validateRules(o.rules);
  }
  return c;
}

/**
 * Finds and loads the config for `cwd`, searching parent directories up to the
 * filesystem root. Returns an empty config when there is none.
 */
export async function loadConfig(cwd: string, explicit?: string): Promise<{ config: Config; path: string | undefined }> {
  const load = async (path: string): Promise<Config> => {
    if (/\.m?js$/.test(path)) {
      const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
      return check(mod.default, path);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`);
    }
    if (path.endsWith("package.json")) return check((parsed as { promptlinter?: unknown }).promptlinter ?? {}, path);
    return check(parsed, path);
  };
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new Error(`Config file not found: ${explicit}`);
    return { config: await load(path), path };
  }
  let dir = resolve(cwd);
  while (true) {
    for (const name of CONFIG_FILES) {
      const path = join(dir, name);
      if (existsSync(path)) return { config: await load(path), path };
    }
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { promptlinter?: unknown }).promptlinter) return { config: await load(pkg), path: pkg };
      } catch {
        // An unreadable package.json is not our problem.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { config: {}, path: undefined };
    dir = parent;
  }
}

/** The lint options for one file: the base config with matching overrides applied. */
export function optionsFor(config: Config, file: string): LintOptions {
  const { include: _include, ignore: _ignore, overrides, ...base } = config;
  let options: LintOptions = { ...base };
  for (const { files, ...o } of overrides ?? []) {
    if (!matchesAny(file, Array.isArray(files) ? files : [files])) continue;
    options = { ...options, ...o, rules: { ...options.rules, ...o.rules } };
  }
  return options;
}
