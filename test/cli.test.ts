import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegExp, lintFiles } from "../dist/index.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function run(args: string[], cwd: string, input?: string) {
  const env = { ...process.env, GITHUB_ACTIONS: "", NO_COLOR: "1" };
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: "utf8", env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let dir: string;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "promptcheck-"));
  write("prompts/good.md", "Summarize {{ text }} in one paragraph.\n");
  write("prompts/bad.md", "Hello {{ name\n");
  write("agent.prompt", "You MUST be helpful to {{ user }}.\n");
  write("notes/readme.md", "Not a prompt {{ broken\n");
  write("node_modules/pkg/x.prompt", "{{ broken\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("globToRegExp()", () => {
  it("supports *, **, ? and braces", () => {
    assert.ok(globToRegExp("**/*.prompt").test("a/b/c.prompt"));
    assert.ok(globToRegExp("**/*.prompt").test("c.prompt"));
    assert.ok(!globToRegExp("*.prompt").test("a/c.prompt"));
    assert.ok(globToRegExp("prompts/**/*.{md,txt}").test("prompts/x/y.txt"));
    assert.ok(globToRegExp("file?.md").test("file1.md"));
    assert.ok(!globToRegExp("file?.md").test("file10.md"));
  });
});

describe("lintFiles()", () => {
  it("finds prompt files by default and skips node_modules", async () => {
    const results = await lintFiles([], { cwd: dir, config: {} });
    assert.deepEqual(results.map((r) => r.file), ["agent.prompt", "prompts/bad.md", "prompts/good.md"]);
    assert.deepEqual(results.find((r) => r.file === "prompts/bad.md")!.diagnostics.map((d) => d.rule), ["syntax/unclosed-tag"]);
  });

  it("applies config overrides per file", async () => {
    const results = await lintFiles(["agent.prompt"], {
      cwd: dir,
      config: { overrides: [{ files: "*.prompt", variables: ["user"], rules: { "style/shouting": "off" } }] },
    });
    assert.deepEqual(results[0]!.diagnostics, []);
  });
});

describe("cli", () => {
  it("exits 1 on errors and prints a stylish report", () => {
    const r = run([], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /prompts\/bad\.md/);
    assert.match(r.stdout, /1:7\s+error\s+"\{\{" is never closed/);
    assert.match(r.stdout, /2 problems \(1 error, 0 warnings, 1 info\)/);
  });

  it("exits 0 when there are only warnings and infos", () => {
    const r = run(["agent.prompt", "prompts/good.md"], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /style\/shouting/);
  });

  it("checks variables from --var and --vars", () => {
    const r = run(["prompts/good.md", "--vars", "txt,extra"], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /"text" is not a declared variable\. Did you mean "txt"\?/);
    assert.match(r.stdout, /"extra" is declared but never used/);
    assert.equal(run(["prompts/good.md", "--var", "text"], dir).code, 0);
  });

  it("supports --max-warnings and --quiet", () => {
    write("warn.prompt", "TODO: finish\n");
    assert.equal(run(["warn.prompt", "--max-warnings", "0"], dir).code, 1);
    assert.equal(run(["warn.prompt", "--max-warnings", "1"], dir).code, 0);
    assert.doesNotMatch(run(["warn.prompt", "--quiet"], dir).stdout, /TODO/);
  });

  it("prints JSON and GitHub annotations", () => {
    const json = JSON.parse(run(["prompts/bad.md", "--format", "json"], dir).stdout);
    assert.equal(json[0].file, "prompts/bad.md");
    assert.equal(json[0].diagnostics[0].rule, "syntax/unclosed-tag");
    const gh = run(["prompts/bad.md", "--format", "github"], dir).stdout;
    assert.match(gh, /^::error file=prompts\/bad\.md,line=1,col=7,endLine=1,endColumn=14,title=promptcheck%3A syntax\/unclosed-tag::/m);
  });

  it("reads stdin", () => {
    const r = run(["--stdin", "--var", "a"], dir, "{{ a }} {{ b }}");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /<stdin>/);
  });

  it("loads the config file", () => {
    const sub = join(dir, "configured");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.prompt"), "You MUST answer.\n");
    writeFileSync(join(sub, ".promptcheckrc.json"), JSON.stringify({ rules: { "style/shouting": "error" } }));
    assert.equal(run(["x.prompt"], sub).code, 1);
    writeFileSync(join(sub, ".promptcheckrc.json"), JSON.stringify({ rules: { "style/shoutin": "error" } }));
    const bad = run(["x.prompt"], sub);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Unknown rule "style\/shoutin"/);
  });

  it("exits 2 for unmatched paths and bad flags", () => {
    assert.equal(run(["nope/*.prompt"], dir).code, 2);
    assert.equal(run(["--format", "xml"], dir).code, 2);
    assert.equal(run(["--nope"], dir).code, 2);
  });

  it("lists rules and prints help and version", () => {
    assert.match(run(["--rules"], dir).stdout, /variables\/undefined\s+error/);
    assert.match(run(["--help"], dir).stdout, /Usage/);
    assert.match(run(["--version"], dir).stdout, /^\d+\.\d+\.\d+/);
  });
});
