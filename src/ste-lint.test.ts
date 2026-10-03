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

  test("terse (Brioche 655516): 0 hard -> ONE line of counts; hard -> hard lines only, never an advisory line", () => {
    const advText = "The job was run by the team.";
    const probe = lintSte(advText, { mode: "strict", ...fixture() });
    expect(probe.warnings.length).toBeGreaterThan(0);
    expect(probe.warnings.every((w) => w.level === "advisory")).toBe(true);
    const advOnly = steReport([{ text: advText }], { mode: "strict", ...fixture() }).trim();
    expect(advOnly).toBe(`STE: 0 hard, ${probe.warnings.length} advisory.`);
    const mixed = steReport(["Open the checkout; it was merged by the bot and the robust seamless job was run."], { mode: "strict", ...fixture() });
    expect(mixed).toMatch(/: \d+ hard\.\n/);
    expect(mixed).not.toContain("advisory");
    const mixedProbe = lintSte("Open the checkout; it was merged by the bot and the robust seamless job was run.", { mode: "strict", ...fixture() });
    const hardN = mixedProbe.warnings.filter((w) => w.level === "hard").length;
    expect(mixedProbe.warnings.length).toBeGreaterThan(hardN); // the input DOES carry advisories, so their absence means something
    expect(mixed).toContain(`: ${hardN} hard.\n`);
    expect(mixed.trim().split("\n").slice(1).length).toBe(Math.min(hardN, 8));
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

// Regressions from the adversarial review of 59537c5 (2026-10-02).
const REAL_SHAPED = `| Approved name | Banned synonyms | Meaning |
|---|---|---|
| recycle | restart, reboot (for a context clear), compaction | save state, clear context, boot again |
| reboot | restart (for the host) | the host restart |
| reviewer | seat (when single), board (when single) | one review lane |
| worktree | checkout, clone | a git worktree |
| blank | —, () | nothing |
`;

describe("review regressions", () => {
  test("a mid-list qualifier is parsed per item and makes the row advisory", () => {
    const g = parseGlossary(REAL_SHAPED);
    const recycle = g.filter((e) => e.approved === "recycle");
    expect(recycle.map((e) => e.banned)).toEqual(["restart", "reboot", "compaction"]);
    expect(recycle.every((e) => e.qualifier !== null)).toBe(true);
    expect(g.filter((e) => e.approved === "reviewer").map((e) => e.banned)).toEqual(["seat", "board"]);
  });

  test("'restart' is advisory, never hard", () => {
    const f = fixture(REAL_SHAPED);
    const w = lintSte("I restart the service now.", { mode: "slack", ...f }).warnings.filter((x) => x.rule === "glossary");
    expect(w.length).toBe(1);
    expect(w[0].level).toBe("advisory");
  });

  test("blank and punctuation-only glossary cells are not terms", () => {
    const g = parseGlossary(REAL_SHAPED);
    expect(g.some((e) => e.approved === "blank")).toBe(false);
    const f = fixture(REAL_SHAPED);
    expect(lintSte("Done — next step.", { mode: "slack", ...f }).warnings).toEqual([]);
  });

  test("a blank extra word in the rules config is an error, not a match-everything regex", () => {
    const f = fixture(REAL_SHAPED, "```json ste-lint-config\n{\"extra_phrasal_verbs\": [\"\"]}\n```");
    const r = lintSte("hello there friend", { mode: "slack", ...f });
    expect(r.errors[0]).toContain("extra_phrasal_verbs");
    expect(r.warnings).toEqual([]);
  });

  test("relative paths, refs and file names are not prose", () => {
    const f = fixture(REAL_SHAPED);
    expect(lintSte("Edit scripts/restart.sh and checkout.sh, then push origin/main.", { mode: "slack", ...f }).warnings).toEqual([]);
  });

  test("an unclosed '<' does not eat prose across lines, and is linear", () => {
    const f = fixture(REAL_SHAPED);
    expect(rules(lintSte("x <! a line\nnext; line\n> end", { mode: "slack", ...f }))).toContain("semicolon");
    const t0 = performance.now();
    lintSte("<!".repeat(100_000), { mode: "slack", ...f });
    lintSte("a".repeat(200_000), { mode: "slack", ...f });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("Slack-escaped &amp; is not a semicolon", () => {
    const f = fixture(REAL_SHAPED);
    expect(lintSte("Tom &amp; Jerry left.", { mode: "slack", ...f }).warnings).toEqual([]);
  });

  test("machine-text payload fields are not linted", () => {
    expect(payloadProse({ command: "cd /x; bun test now", text: "I run the tests now." })).toEqual(["I run the tests now."]);
  });

  test("steReport takes raw payloads and survives non-strings", () => {
    const f = fixture(REAL_SHAPED);
    const rep = steReport([42, null, { text: "Open the checkout now." }, undefined], { mode: "slack", ...f });
    expect(rep).toContain('"checkout": write "worktree"');
  });
});

test("when a hard row and an advisory row ban the same word, advisory wins (either order)", () => {
  const hardFirst = "| A | Banned | M |\n|---|---|---|\n| lane | worker | a lane |\n| job | worker (when meaning CI) | a CI job |\n";
  const advFirst = "| A | Banned | M |\n|---|---|---|\n| job | worker (when meaning CI) | a CI job |\n| lane | worker | a lane |\n";
  for (const g of [hardFirst, advFirst]) {
    const f = fixture(g);
    const w = lintSte("The worker stopped.", { mode: "slack", ...f }).warnings.filter((x) => x.rule === "glossary");
    expect(w.map((x) => x.level)).toEqual(["advisory"]);
  }
});
