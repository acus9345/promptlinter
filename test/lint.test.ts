import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lint, type LintOptions } from "../dist/index.js";

/** The rule ids reported for `text`, in order. */
const rules = (text: string, options?: LintOptions) => lint(text, options).map((d) => d.rule);
const only = (text: string, rule: string, options?: LintOptions) => lint(text, options).filter((d) => d.rule === rule);

describe("clean prompts", () => {
  it("reports nothing for a well-formed template", () => {
    const text = [
      "<instructions>",
      "You are a support agent for {{ company }}. Answer the customer's question using the context below.",
      "</instructions>",
      "",
      "<context>",
      "{% for doc in documents %}",
      "- {{ doc.title }}: {{ doc.body | truncate(200) }}",
      "{% endfor %}",
      "</context>",
      "",
      "Question: {{ question }}",
    ].join("\n");
    assert.deepEqual(lint(text, { variables: ["company", "documents", "question"] }), []);
  });
});

describe("syntax rules", () => {
  it("finds unclosed and empty tags", () => {
    assert.deepEqual(rules("Hello {{ name, how are you?"), ["syntax/unclosed-tag"]);
    assert.deepEqual(rules("Hello {{ name {{ other }}"), ["syntax/unclosed-tag"]);
    assert.deepEqual(rules("Hello {{ }} there {{ x }}"), ["syntax/empty-tag"]);
    assert.deepEqual(rules("Total: ${amount"), ["syntax/unclosed-tag"]);
  });

  it("reports positions", () => {
    const [d] = lint("line one\nsay {{ name");
    assert.deepEqual([d!.line, d!.column, d!.endLine], [2, 5, 2]);
  });

  it("checks Handlebars and Mustache blocks", () => {
    assert.deepEqual(rules("{{#if vip}}Hi{{/if}} {{#each items as |item|}}{{item}}{{/each}}"), []);
    assert.deepEqual(rules("{{#if vip}}Hi"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("Hi{{/if}}"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("{{#each a}}{{#if b}}x{{/each}}"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("{{#items}}- {{name}}{{/items}}{{^items}}none{{/items}}"), []);
  });

  it("checks Jinja blocks", () => {
    assert.deepEqual(rules("{% if x %}a{% elif y %}b{% else %}c{% endif %}"), []);
    assert.deepEqual(rules("{% for x in xs %}{{ x }}"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("{% if x %}{% endfor %}{% endif %}"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("{% else %}"), ["syntax/unbalanced-block"]);
    assert.deepEqual(rules("{% raw %}{{ not a var {% if %}{% endraw %}"), []);
    assert.deepEqual(rules("{# a comment #}{% set n = 3 %}{{ n }}"), []);
  });

  it("warns about mixed placeholder styles", () => {
    assert.deepEqual(rules("Hi {{name}}, your order {order_id} shipped."), ["syntax/mixed-delimiters"]);
    assert.deepEqual(rules("Hi ${name}, your order {order_id} shipped."), ["syntax/mixed-delimiters"]);
    // Code examples don't count.
    assert.deepEqual(rules("Hi {{name}}.\n```js\nconst s = `${a}`;\nfn({x})\n```"), []);
    // Unless the syntax is set explicitly.
    assert.deepEqual(rules("Hi {{name}}, order {order_id}.", { syntax: "mustache" }), []);
  });

  it("treats {{ }} as escaped braces in f-string templates", () => {
    const text = 'Return JSON like {{"answer": "..."}} for {question}.';
    assert.deepEqual(rules(text, { syntax: "fstring", variables: ["question"] }), []);
    assert.deepEqual(rules("{question} {other}", { syntax: "fstring", variables: ["question"] }), ["variables/undefined"]);
  });
});

describe("variable rules", () => {
  it("reports undefined variables with a suggestion", () => {
    const [d] = only("Hello {{ user_nme }}!", "variables/undefined", { variables: ["user_name"] });
    assert.match(d!.message, /Did you mean "user_name"\?/);
    const [d2] = only("Hello {{ zzz }}!", "variables/undefined", { variables: ["user_name"] });
    assert.match(d2!.message, /declared: user_name/);
  });

  it("reports unused variables", () => {
    assert.deepEqual(rules("Hello {{ name }}", { variables: ["name", "age"] }), ["variables/unused"]);
  });

  it("skips variable checks when nothing is declared", () => {
    assert.deepEqual(rules("Hello {{ anything }}"), []);
  });

  it("understands loop variables, set, macros, filters and attributes", () => {
    const text = [
      "{% macro row(item, sep=', ') %}{{ item.name }}{{ sep }}{% endmacro %}",
      "{% set total = items | length %}",
      "{% for i in items if i.visible %}{{ row(i) }} {{ loop.index }}{% endfor %}",
      "{{ total }} {{ title | default('Untitled') | upper }} {{ user.name is defined }}",
    ].join("\n");
    assert.deepEqual(rules(text, { variables: ["items", "title", "user"] }), []);
  });

  it("does not guess inside Handlebars context blocks", () => {
    const text = "{{#each people}}{{name}} ({{@index}}){{/each}} {{#with author}}{{first}}{{/with}}";
    assert.deepEqual(rules(text, { variables: ["people", "author"] }), []);
    assert.deepEqual(rules("{{#if vip}}{{discount}}{{/if}}", { variables: ["vip"] }), ["variables/undefined"]);
  });

  it("reads Handlebars helpers and hash arguments", () => {
    assert.deepEqual(rules('{{formatDate created "YYYY" tz=zone}}', { variables: ["created", "zone"] }), []);
  });

  it("reads variables from frontmatter, including Prompty inputs", () => {
    const yamlList = "---\nname: greet\nvariables:\n  - name\n  - city\n---\nHi {{ name }} from {{ town }}";
    const r = lint(yamlList);
    assert.deepEqual(r.map((d) => d.rule), ["variables/unused", "variables/undefined"]);
    assert.equal(r[0]!.line, 5); // points at "city" in the frontmatter
    const prompty = "---\ninputs:\n  question:\n    type: string\n  context:\n    type: string\n---\n{{question}} {{context}}";
    assert.deepEqual(rules(prompty), []);
    assert.deepEqual(rules("---\nvariables: [a, b]\n---\n{{a}}{{b}}"), []);
  });

  it("flags names that differ only in case or separators", () => {
    assert.deepEqual(rules("{{ userName }} and {{ user_name }}"), ["variables/inconsistent-naming", "variables/similar-names"]);
  });

  it("notes mixed camelCase and snake_case", () => {
    assert.deepEqual(rules("{{ firstName }} {{ last_name }} {{ zip_code }}"), ["variables/inconsistent-naming"]);
  });

  it("works with ${js} placeholders", () => {
    assert.deepEqual(rules("Hi ${user.name}, ${count + 1} items", { variables: ["user", "count"] }), []);
  });
});

describe("structure rules", () => {
  it("finds unbalanced XML sections", () => {
    assert.deepEqual(rules("<context>\nnotes\n</contxt>"), ["structure/unbalanced-xml", "structure/unbalanced-xml"]);
    assert.deepEqual(rules("<a_b>x</a_b> <doc id=\"1\">y</doc> line<br> <img src=x/> a < b > c"), []);
    assert.deepEqual(rules("<rules>\n<rule>one</rule>\n"), ["structure/unbalanced-xml"]);
    // Tags inside code blocks are ignored.
    assert.deepEqual(rules("```html\n<div>\n```"), []);
  });

  it("finds unclosed code fences", () => {
    assert.deepEqual(rules("Example:\n```json\n{}\n"), ["structure/unclosed-code-fence"]);
  });

  it("finds duplicate instructions", () => {
    const d = only("- Always answer in English please.\nOther text here.\n* Always answer in English please.", "structure/duplicate-line");
    assert.equal(d.length, 1);
    assert.equal(d[0]!.line, 3);
    assert.match(d[0]!.message, /line 1/);
    assert.deepEqual(rules("Short line\nShort line"), []);
  });
});

describe("content rules", () => {
  it("reports an empty prompt", () => {
    assert.deepEqual(rules("  \n "), ["content/empty"]);
    assert.deepEqual(rules("---\nvariables: [a]\n---\n"), ["content/empty"]);
  });

  it("finds secrets, even in code blocks", () => {
    assert.deepEqual(rules("Use key " + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz".repeat(2)), ["content/secret"]);
    assert.deepEqual(rules("```\nAKIAABCDEFGHIJKLMNOP\n```"), ["content/secret"]);
    assert.deepEqual(rules("ghp_" + "a".repeat(36)), ["content/secret"]);
  });

  it("finds leftover placeholders and TODOs", () => {
    assert.deepEqual(rules("Example: [insert example here]"), ["content/leftover-placeholder"]);
    assert.deepEqual(rules("Sign as <your name>."), ["content/leftover-placeholder"]);
    assert.deepEqual(rules("Key: YOUR_API_KEY"), ["content/leftover-placeholder"]);
    assert.deepEqual(rules("Contact <YOUR_EMAIL>"), ["content/leftover-placeholder"]);
    assert.deepEqual(rules("TODO: add examples"), ["content/todo"]);
    assert.deepEqual(rules("Lorem ipsum dolor"), ["content/todo"]);
    assert.deepEqual(rules("Make a todo list."), []);
  });

  it("checks the token budget", () => {
    assert.deepEqual(rules("word ".repeat(100), { maxTokens: 50 }), ["content/token-budget"]);
    assert.deepEqual(rules("word ".repeat(10), { maxTokens: 50 }), []);
  });
});

describe("style rules", () => {
  it("notes shouting", () => {
    assert.deepEqual(rules("You MUST answer briefly."), ["style/shouting"]);
    assert.deepEqual(rules("PLEASE READ THIS CAREFULLY now"), ["style/shouting"]);
    assert.deepEqual(rules("Return JSON via the API."), []);
  });

  it("notes vague wording", () => {
    assert.deepEqual(rules("Try to be concise and add tags, etc."), ["style/vague", "style/vague"]);
  });

  it("notes negative-only instructions", () => {
    assert.deepEqual(rules("- Don't use markdown."), ["style/negative-instruction"]);
    assert.deepEqual(rules("Never guess; say you don't know instead."), []);
  });
});

describe("configuration", () => {
  it("changes severities and turns rules off", () => {
    const text = "You MUST do it. TODO";
    assert.deepEqual(lint(text, { rules: { "style/shouting": "error", "content/todo": "off" } }).map((d) => [d.rule, d.severity]), [["style/shouting", "error"]]);
  });

  it("honours disable comments", () => {
    assert.deepEqual(rules("<!-- promptcheck-disable-next-line content/todo -->\nTODO later\nTODO now"), ["content/todo"]);
    assert.deepEqual(rules("{# promptcheck-disable-next-line #}\nYou MUST. TODO"), []);
    assert.deepEqual(rules("<!-- promptcheck-disable style/shouting -->\nYou MUST.\nIt is CRITICAL."), []);
    assert.deepEqual(rules("<!-- promptcheck-disable -->\n{{ broken"), []);
  });

  it("ignores everything with syntax: none", () => {
    assert.deepEqual(rules("{{ not a tag", { syntax: "none" }), []);
  });
});

describe("auto-detection", () => {
  it("treats {{json}} as escaped braces in LangChain-style templates", () => {
    const text = 'Translate {input_language} to {output_language}.\nRespond like {{"translation": "..."}}.\nText: {text}';
    assert.deepEqual(rules(text, { variables: ["input_language", "output_language", "text"] }), []);
  });
});
