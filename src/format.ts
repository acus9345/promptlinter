import type { Diagnostic } from "./lint.js";

export interface FileResult {
  file: string;
  diagnostics: Diagnostic[];
}

export interface Totals {
  errors: number;
  warnings: number;
  infos: number;
}

export function totals(results: readonly FileResult[]): Totals {
  const t = { errors: 0, warnings: 0, infos: 0 };
  for (const r of results) {
    for (const d of r.diagnostics) {
      if (d.severity === "error") t.errors++;
      else if (d.severity === "warning") t.warnings++;
      else t.infos++;
    }
  }
  return t;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Human-readable output, grouped by file. */
export function formatStylish(results: readonly FileResult[], color = false): string {
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const sev = { error: paint("31", "error"), warning: paint("33", "warning"), info: paint("36", "info") };
  const lines: string[] = [];
  for (const r of results) {
    if (r.diagnostics.length === 0) continue;
    lines.push(paint("4", r.file));
    const loc = r.diagnostics.map((d) => `${d.line}:${d.column}`);
    const width = Math.max(...loc.map((l) => l.length));
    r.diagnostics.forEach((d, i) => {
      const label = d.severity === "warning" ? sev.warning : `${sev[d.severity]}${" ".repeat(7 - d.severity.length)}`;
      lines.push(`  ${paint("2", loc[i]!.padEnd(width))}  ${label}  ${d.message}  ${paint("2", d.rule)}`);
    });
    lines.push("");
  }
  const t = totals(results);
  const count = t.errors + t.warnings + t.infos;
  if (count === 0) {
    lines.push(paint("32", `✔ ${plural(results.length, "prompt")} checked, no problems`));
  } else {
    const summary = `${count === 1 ? "1 problem" : `${count} problems`} (${plural(t.errors, "error")}, ${plural(t.warnings, "warning")}, ${t.infos} info)`;
    lines.push(paint(t.errors ? "31;1" : t.warnings ? "33;1" : "36;1", `${t.errors ? "✖" : "⚠"} ${summary}`));
  }
  return lines.join("\n");
}

/** Machine-readable output. */
export function formatJson(results: readonly FileResult[]): string {
  return JSON.stringify(results, null, 2);
}

const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** GitHub Actions workflow commands, so problems show up as annotations on the pull request. */
export function formatGithub(results: readonly FileResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const d of r.diagnostics) {
      const level = d.severity === "info" ? "notice" : d.severity;
      const props = [
        `file=${escapeProperty(r.file)}`,
        `line=${d.line}`,
        `col=${d.column}`,
        `endLine=${d.endLine}`,
        `endColumn=${d.endColumn}`,
        `title=${escapeProperty(`promptlinter: ${d.rule}`)}`,
      ];
      lines.push(`::${level} ${props.join(",")}::${escapeData(d.message)}`);
    }
  }
  return lines.join("\n");
}
