import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Files promptlinter looks at when no paths are given. */
export const DEFAULT_INCLUDE: readonly string[] = [
  "**/*.prompt",
  "**/*.prompty",
  "**/*.prompt.{md,txt,hbs,mustache,j2,jinja,jinja2,tmpl}",
  "**/prompts/**/*.{md,txt,prompt,prompty,hbs,mustache,j2,jinja,jinja2,tmpl}",
];

/** Directories that are never searched. */
export const DEFAULT_IGNORE: readonly string[] = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
];

const PROMPT_EXTENSIONS = /\.(?:prompt|prompty|md|txt|hbs|mustache|j2|jinja|jinja2|tmpl)$/i;

/** Converts a glob (`*`, `**`, `?`, `{a,b}`) to a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** True when `path` (relative, `/`-separated) matches any of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(path));
}

function walk(dir: string, root: string, ignore: readonly string[], out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = toPosix(relative(root, full));
    if (entry.isDirectory()) {
      if (!matchesAny(`${rel}/`, ignore) && !matchesAny(`${rel}/x`, ignore)) walk(full, root, ignore, out);
    } else if (entry.isFile() && !matchesAny(rel, ignore)) {
      out.push(rel);
    }
  }
}

/**
 * Expands paths, directories and globs to a sorted list of files relative to `cwd`.
 * Directories expand to the prompt-like files inside them.
 */
export function findFiles(patterns: readonly string[], cwd: string, ignore: readonly string[] = DEFAULT_IGNORE): { files: string[]; unmatched: string[] } {
  const files = new Set<string>();
  const unmatched: string[] = [];
  let all: string[] | undefined;
  for (const pattern of patterns) {
    const abs = resolve(cwd, pattern);
    if (existsSync(abs)) {
      if (statSync(abs).isDirectory()) {
        const found: string[] = [];
        walk(abs, cwd, ignore, found);
        const prompts = found.filter((f) => PROMPT_EXTENSIONS.test(f));
        prompts.forEach((f) => files.add(f));
        if (prompts.length === 0) unmatched.push(pattern);
      } else files.add(toPosix(relative(cwd, abs)));
      continue;
    }
    if (!all) {
      all = [];
      walk(cwd, cwd, ignore, all);
    }
    const re = globToRegExp(toPosix(pattern).replace(/^\.\//, ""));
    const hits = all.filter((f) => re.test(f));
    hits.forEach((f) => files.add(f));
    if (hits.length === 0) unmatched.push(pattern);
  }
  return { files: [...files].sort(), unmatched };
}
