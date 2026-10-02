import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintSte, parseGlossary, parseRulesConfig, payloadProse, steReport, stripNonProse } from "./ste-lint.js";

const GLOSSARY = `---
title: test
---
Prose with worktree | not | a table row.

| Approved name | Banned synonyms | Meaning |
|---|---|---|
| worktree | checkout, clone, workspace | a git worktree |
| ticket | issue, task, card (when meaning a Linear issue) | a Linear issue |
| cycle | sprint, iteration (for Linear) | the Linear cycle |
| round | pass, iteration, cycle (for review) | one review of one PR head |
| CR | CodeRabbit, the bot | the CodeRabbit review |
`;

const RULES = "# rules\n\n```json ste-lint-config\n{\"max_words_strict\": 20, \"max_words_slack\": 25, \"extra_phrasal_verbs\": [\"loop in\"]}\n```\n";

function fixture(glossary = GLOSSARY, rules = RULES) {
  const dir = mkdtempSync(join(tmpdir(), "ste-lint-"));
  const glossaryPath = join(dir, "glossary.md");
  const rulesPath = join(dir, "rules.md");
  writeFileSync(glossaryPath, glossary);
  writeFileSync(rulesPath, rules);
  return { glossaryPath, rulesPath };
}

const rules = (r: ReturnType<typeof lintSte>) => r.warnings.map((w) => w.rule);

describe("parseGlossary", () => {
  test("parses table rows only, splits banned lists, keeps the qualifier for the whole list", () => {
    const g = parseGlossary(GLOSSARY);
    expect(g.filter((e) => e.approved === "worktree").map((e) => e.banned)).toEqual(["checkout", "clone", "workspace"]);
    const ticket = g.filter((e) => e.approved === "ticket");
    expect(ticket.map((e) => e.banned)).toEqual(["issue", "task", "card"]);
    expect(ticket.every((e) => e.qualifier === "when meaning a Linear issue")).toBe(true);
    expect(g.some((e) => e.approved === "Approved name" || e.approved.startsWith("-"))).toBe(false);
    expect(g.some((e) => e.approved.startsWith("Prose"))).toBe(false);
  });
});

describe("lintSte", () => {
  test("an unqualified banned synonym is a HARD warning naming the approved name", () => {
    const f = fixture();
    const r = lintSte("Open the checkout and run the tests.", { mode: "strict", ...f });
    const g = r.warnings.find((w) => w.rule === "glossary")!;
    expect(g.level).toBe("hard");
    expect(g.message).toContain('"worktree"');
    expect(r.errors).toEqual([]);
  });

  test("a qualified banned synonym is ADVISORY and says when it applies", () => {
    const f = fixture();
    const r = lintSte("I filed the issue today.", { mode: "strict", ...f });
    const g = r.warnings.find((w) => w.rule === "glossary")!;
    expect(g.level).toBe("advisory");
    expect(g.message).toContain("if you mean a Linear issue");
  });

  test("a banned word that is itself an approved name is not flagged", () => {
    const f = fixture();
    const r = lintSte("This cycle ends on Sunday.", { mode: "strict", ...f });
    expect(r.warnings.filter((w) => w.rule === "glossary")).toEqual([]);
  });

  test("multi-word banned term matches", () => {
    const f = fixture();
    const r = lintSte("The bot posted a review.", { mode: "slack", ...f });
    expect(r.warnings.some((w) => w.rule === "glossary" && /the bot/i.test(w.match))).toBe(true);
  });

  test("a 40-word sentence trips the cap in both modes; 22 words trips strict only", () => {
    const f = fixture();
    const forty = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + ".";
    expect(rules(lintSte(forty, { mode: "strict", ...f }))).toContain("long-sentence");
    expect(rules(lintSte(forty, { mode: "slack", ...f }))).toContain("long-sentence");
    const twentyTwo = Array.from({ length: 22 }, (_, i) => `w${i}`).join(" ") + ".";
    expect(rules(lintSte(twentyTwo, { mode: "strict", ...f }))).toContain("long-sentence");
    expect(rules(lintSte(twentyTwo, { mode: "slack", ...f }))).not.toContain("long-sentence");
  });

  test("newlines and list items split sentences", () => {
    const f = fixture();
    const lines = Array.from({ length: 5 }, () => "- " + Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ")).join("\n");
    expect(rules(lintSte(lines, { mode: "strict", ...f }))).not.toContain("long-sentence");
  });

  test("structural hard rules fire; strict adds the advisory ones", () => {
    const f = fixture();
    const bad = "The panel was removed; spin up the job. Perform an analysis of the seamless log. We have received the report.";
    const strict = rules(lintSte(bad, { mode: "strict", ...f }));
    for (const r of ["semicolon", "phrasal-verb", "nominalization", "marketing-adjective", "passive-voice", "present-perfect"]) {
      expect(strict).toContain(r);
    }
    const slack = rules(lintSte(bad, { mode: "slack", ...f }));
    expect(slack).toContain("semicolon");
    expect(slack).not.toContain("passive-voice");
    expect(slack).not.toContain("present-perfect");
  });

  test("hedges are never flagged", () => {
    const f = fixture();
    const r = lintSte("The request may have failed. It could be a timeout.", { mode: "strict", ...f });
    expect(r.warnings).toEqual([]);
  });

  test("a clean message gives no warnings in either mode", () => {
    const f = fixture();
    const clean = "I merged PR 41. CI is green on head 3f2a1b9. Next, I start the staging FV at 14:00Z.";
    expect(lintSte(clean, { mode: "strict", ...f }).warnings).toEqual([]);
    expect(lintSte(clean, { mode: "slack", ...f }).warnings).toEqual([]);
  });

  test("code, URLs, Slack mentions and paths are not prose", () => {
    const f = fixture();
    const r = lintSte("Run `git checkout main; ls` at <@U123> see https://x.io/a;b and /tmp/workspace/clone.", { mode: "strict", ...f });
    expect(r.warnings).toEqual([]);
    expect(stripNonProse("a `b;c` d")).not.toContain(";");
  });

  test("synonym rotation is strict-only and names the keeper", () => {
    const f = fixture();
    const t = "Check the config file. Then verify the output.";
    const w = lintSte(t, { mode: "strict", ...f }).warnings.find((x) => x.rule === "synonym-rotation")!;
    expect(w.message).toContain('"verify" and "check"');
    expect(rules(lintSte(t, { mode: "slack", ...f }))).not.toContain("synonym-rotation");
  });

  test("the rules config is read at call time: an extra phrasal verb and a new cap apply without a reload", () => {
    const f = fixture();
    const text = "Please loop in Brioche.";
    expect(rules(lintSte(text, { mode: "slack", ...f }))).toContain("phrasal-verb");
    writeFileSync(f.rulesPath, RULES.replace('"max_words_slack": 25', '"max_words_slack": 3'));
    expect(rules(lintSte(text, { mode: "slack", ...f }))).toContain("long-sentence");
  });

  test("the glossary is read at call time: a new row applies to the next call", () => {
    const f = fixture();
    expect(lintSte("Restart the lambda.", { mode: "slack", ...f }).warnings).toEqual([]);
    writeFileSync(f.glossaryPath, GLOSSARY + "| function | lambda | a deployed function |\n");
    expect(lintSte("Restart the lambda.", { mode: "slack", ...f }).warnings[0]?.message).toContain('"function"');
  });

  test("missing files become errors, never throws, and the structural rules still run", () => {
    const r = lintSte("a; b c", { mode: "strict", glossaryPath: "/nonexistent/g.md", rulesPath: "/nonexistent/r.md" });
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]).toContain("/nonexistent/g.md");
    expect(rules(r)).toContain("semicolon");
  });

  test("a malformed config block is an error naming the field", () => {
    const f = fixture(GLOSSARY, "```json ste-lint-config\n{\"max_words_strict\": \"twenty\"}\n```");
    const r = lintSte("hello there friend", { mode: "strict", ...f });
    expect(r.errors[0]).toContain("max_words_strict");
  });
});

describe("parseRulesConfig", () => {
  test("no block = defaults", () => {
    expect(parseRulesConfig("# nothing").max_words_strict).toBe(20);
  });
});

describe("payloadProse", () => {
  test("collects prose strings from any JSON shape, skips short tokens and keys", () => {
    const p = { text: "This is prose here.", kind: "help", nested: [{ body: "More prose in a list." }], n: 3 };
    expect(payloadProse(p)).toEqual(["This is prose here.", "More prose in a list."]);
    expect(payloadProse("plain string payload here")).toEqual(["plain string payload here"]);
    expect(payloadProse(null)).toEqual([]);
  });
});

describe("steReport", () => {
  test("empty for a clean message, a headed list otherwise, capped", () => {
    const f = fixture();
    expect(steReport(["I merged PR 41."], { mode: "strict", ...f })).toBe("");
    const rep = steReport(["Open the checkout; spin up the job."], { mode: "strict", ...f });
    expect(rep).toContain("warn-only — the message was sent");
    expect(rep).toContain("[glossary]");
    expect(rep).toContain("[semicolon]");
    const many = steReport(["a; b. spin up. seamless. robust. checkout. clone. workspace. CodeRabbit. the bot."], { mode: "slack", ...f }, 3);
    expect(many).toMatch(/…and \d+ more/);
  });

  test("dedupes the same warning across several payload strings", () => {
    const f = fixture();
    const rep = steReport(["Open the checkout now.", "Close the checkout now."], { mode: "slack", ...f });
    expect(rep.match(/\[glossary\]/g)!.length).toBe(1);
  });

  test("load errors surface in the report", () => {
    const rep = steReport(["hello there friend"], { mode: "slack", glossaryPath: "/nonexistent/g.md", rulesPath: "/nonexistent/r.md" });
    expect(rep).toContain("[ste-lint error] glossary not loaded from /nonexistent/g.md");
  });
});
