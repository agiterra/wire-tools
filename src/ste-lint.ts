/**
 * ASD-STE100 (Simplified Technical English) linter for agent messages — AGI-154.
 *
 * Tim 2026-10-02 (#ai): "We're going to spin up a shared glossary and rules for IPC and Slack to use this
 * reduced language." One name per thing, short sentences, active voice.
 *
 * WARN-ONLY. The callers (wire-ipc-tools send_message, slack-tools post_message) send the message first and
 * append the warnings to the tool result. Nothing here may block a send, and nothing here throws: a failure to
 * load the glossary or rules becomes a warning line naming the path and the error.
 *
 * Two shared files are read AT CALL TIME, so an edit lands on the next message without a release:
 *   glossary  STE_GLOSSARY_PATH, default /opt/agiterra/pod-tools/share/ste/glossary/glossary.md
 *             (Brioche owns the rows). Only the markdown table is parsed: | approved | banned, … | meaning |.
 *   rules     STE_RULES_PATH, default /opt/agiterra/pod-tools/share/ste/rules.md (Fondant owns it). Only a
 *             fenced ```json ste-lint-config block is parsed — numeric caps and extra word lists. The prose is for
 *             the writer.
 * Neither file is ever executed.
 *
 * Structural rules are ported from danyuchn/asd-ste100-skill @7d4a135 (MIT), scripts/ste-lint.py: regex
 * heuristics, not a parser. Hedges (may/might/could) are never flagged — confidence is content.
 *
 * Modes: "strict" (IPC) caps sentences at 20 words and adds the advisory passive / compound-tense / synonym-
 * rotation checks. "slack" (STE-flavored, humans read it) caps at 25 and keeps only the hard rules + glossary.
 */
import { readFileSync } from "node:fs";

export const DEFAULT_STE_GLOSSARY_PATH = "/opt/agiterra/pod-tools/share/ste/glossary/glossary.md";
export const DEFAULT_STE_RULES_PATH = "/opt/agiterra/pod-tools/share/ste/rules.md";

export type SteMode = "strict" | "slack";

export interface SteWarning {
  rule: string;
  /** "hard" = the rule applies everywhere; "advisory" = context decides (a qualified glossary row, passive voice). */
  level: "hard" | "advisory";
  match: string;
  message: string;
}

export interface SteLintOptions {
  mode: SteMode;
  glossaryPath?: string;
  rulesPath?: string;
}

export interface SteLintResult {
  warnings: SteWarning[];
  /** Load problems with the shared files. Reported, never thrown. */
  errors: string[];
  words: number;
}

export interface GlossaryEntry {
  approved: string;
  banned: string;
  /** The "(when …)" / "(for …)" / "(as …)" qualifier, if the row has one. A qualified ban is context-dependent. */
  qualifier: string | null;
  meaning: string;
}

interface SteConfig {
  max_words_strict: number;
  max_words_slack: number;
  extra_phrasal_verbs: string[];
  extra_marketing_adjectives: string[];
}

const DEFAULT_CONFIG: SteConfig = {
  max_words_strict: 20,
  max_words_slack: 25,
  extra_phrasal_verbs: [],
  extra_marketing_adjectives: [],
};

const PHRASAL =
  "spin(?:ning|s)? up|spun up|reach(?:ing|es|ed)? out|div(?:e|es|ing|ed) into|dove into|kick(?:ing|s|ed)? off|circl(?:e|es|ing|ed) back|touch(?:ing|es|ed)? base";
const MARKETING =
  "seamless(?:ly)?|robust(?:ly)?|cutting-edge|effortless(?:ly)?|blazing[- ]fast|world-class|state-of-the-art|game-chang(?:ing|er)";
const NOMINALIZATION =
  /\b(perform|performs|performed|conduct|conducts|conducted|carry out|carries out|carried out)\s+(?:a|an|the)\s+\w+(?:tion|sion|ment|ance|ence|ysis)\b/gi;
const PASSIVE =
  /\b(is|are|was|were|been|being)\s+(\w+ed|given|taken|made|done|found|seen|known|shown|written|built|sent|set|run|read|kept|held|left|put)\b(?!\s+(?:to|for|by)\s+\w+ing)/gi;
// modal + perfect infinitive ("may have failed") is a protected hedge, not present perfect
const PRESENT_PERFECT =
  /(?<!\bmay )(?<!\bmight )(?<!\bcould )(?<!\bshould )(?<!\bwould )(?<!\bmust )\b(has|have|had)\s+(?:been\s+)?\w+(?:ed|en)\b/gi;

// One word, one meaning: verbs commonly rotated for the same action (from the reference linter).
const SYNONYM_GROUPS: string[][] = [
  ["check", "verify", "confirm", "validate"],
  ["delete", "remove", "erase"],
  ["start", "launch", "begin", "initiate"],
  ["stop", "halt", "terminate"],
  ["show", "display"],
  ["use", "utilize", "employ"],
  ["fix", "repair", "correct"],
  ["send", "transmit"],
  ["get", "retrieve", "fetch", "obtain"],
  ["change", "modify", "alter"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
  return cells.length >= 3 ? cells : null;
}

const isSeparatorRow = (cells: string[] | null) => !!cells && cells.every((c) => /^:?-{3,}:?$/.test(c));
/** A term must carry a letter or digit: "", "—" or "()" would match everywhere or nowhere. */
const isTerm = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Split at commas that are not inside parentheses. */
function splitTopLevel(cell: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of cell) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Parse the glossary's markdown table. The row before a separator row is a header; prose is ignored.
 * A "(when …)" qualifier may sit on any item ("restart, reboot (for a context clear), compaction"). Any qualifier
 * in a row makes the WHOLE row context-dependent: the trailing one scopes the whole list
 * ("issue, task, card (when meaning a Linear issue)"), and a mid-list one leaves the scope of its neighbours
 * unclear — so a row with a qualifier never produces a hard warning.
 */
export function parseGlossary(md: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (!cells || isSeparatorRow(cells) || isSeparatorRow(splitRow(lines[i + 1] ?? ""))) continue;
    const [approved, bannedCell, meaning] = cells;
    if (!isTerm(approved)) continue;
    const items = splitTopLevel(bannedCell).map((item) => {
      const q = item.match(/\(([^()]*)\)\s*$/);
      return { banned: (q ? item.slice(0, q.index) : item).trim(), qualifier: q ? q[1].trim() : null };
    });
    const rowQualifier = items.find((x) => x.qualifier !== null)?.qualifier ?? null;
    for (const it of items) {
      if (!isTerm(it.banned)) continue;
      entries.push({ approved, banned: it.banned, qualifier: it.qualifier ?? rowQualifier, meaning });
    }
  }
  return entries;
}

/** Read the fenced ```json ste-lint-config block from rules.md; absent block = defaults. */
export function parseRulesConfig(md: string): SteConfig {
  const m = md.match(/```json\s+ste-lint-config\s*\n([\s\S]*?)\n```/);
  if (!m) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(m[1]) as Partial<SteConfig>;
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of ["max_words_strict", "max_words_slack"] as const) {
    if (raw[k] !== undefined) {
      if (typeof raw[k] !== "number" || !(raw[k]! > 0)) throw new Error(`${k} must be a positive number, got ${JSON.stringify(raw[k])}`);
      cfg[k] = raw[k]!;
    }
  }
  for (const k of ["extra_phrasal_verbs", "extra_marketing_adjectives"] as const) {
    if (raw[k] !== undefined) {
      if (!Array.isArray(raw[k]) || raw[k]!.some((s) => typeof s !== "string" || !isTerm(s))) {
        throw new Error(`${k} must be an array of non-blank strings, got ${JSON.stringify(raw[k])}`);
      }
      cfg[k] = raw[k]!;
    }
  }
  return cfg;
}

/** Remove what is not prose: code, URLs, Slack mentions/links, file paths. */
export function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " CODE ")
    // Bounded and whitespace-free: an unclosed "<" must not scan (quadratically) to a ">" lines away.
    .replace(/<[@#!][^>\s]{0,200}>/g, " NAME ")
    .replace(/<https?:[^>\s]{0,2000}>/g, " LINK ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\bhttps?:\/\/\S+/g, " LINK ")
    // Per token (linear — no regex backtracking over one long token): a token with a slash is a path, a ref or an
    // id (scripts/restart.sh, origin/main, 3/4); a token ending in a file extension is a file name. Neither is prose.
    .replace(/\S+/g, (tok) => (tok.includes("/") ? " PATH " : FILE_TOKEN.test(tok) ? " FILE " : tok));
}
const FILE_TOKEN = /^[("'`]*[\w.-]+\.(?:sh|ts|tsx|js|mjs|md|json|jsonl|py|ya?ml|txt|log|toml|sql|db|tsv|csv|plist|env|lock)[)"'`,:.]*$/i;

function sentences(prose: string): string[] {
  const out: string[] = [];
  for (const rawLine of prose.split("\n")) {
    // A list marker or heading is layout, not a word. A table row is cells, each its own sentence.
    const line = rawLine.replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, "");
    const parts = /^\s*\|/.test(line) ? line.split("|") : [line];
    for (const p of parts) for (const s of p.split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

const countWords = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function load<T>(path: string, parse: (s: string) => T, label: string, errors: string[]): T | null {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (e) {
    const err = e as Error;
    errors.push(`${label} not loaded from ${path}: ${err.message}`);
    console.error(`[ste-lint] ${label} load failed path=${path}`, err.stack ?? err);
    return null;
  }
}

export function lintSte(text: string, opts: SteLintOptions): SteLintResult {
  const errors: string[] = [];
  const glossaryPath = opts.glossaryPath ?? process.env.STE_GLOSSARY_PATH ?? DEFAULT_STE_GLOSSARY_PATH;
  const rulesPath = opts.rulesPath ?? process.env.STE_RULES_PATH ?? DEFAULT_STE_RULES_PATH;
  const glossary = load(glossaryPath, parseGlossary, "glossary", errors) ?? [];
  const cfg = load(rulesPath, parseRulesConfig, "rules config", errors) ?? { ...DEFAULT_CONFIG };
  const strict = opts.mode === "strict";
  const prose = stripNonProse(text);
  const warnings: SteWarning[] = [];
  const seen = new Set<string>();
  const add = (w: SteWarning) => {
    const key = `${w.rule}:${w.match.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); warnings.push(w); }
  };

  // --- Glossary: one name per thing. ---
  const approvedNames = new Set(
    glossary.flatMap((g) => g.approved.split(/\s*\/\s*/)).map((s) => s.toLowerCase()),
  );
  // When two rows ban the same word, the qualified (advisory) row wins: one context-dependent row is enough doubt.
  const byTerm = new Map<string, GlossaryEntry>();
  for (const g of glossary) {
    const k = g.banned.toLowerCase();
    const prev = byTerm.get(k);
    if (!prev || (prev.qualifier === null && g.qualifier !== null)) byTerm.set(k, g);
  }
  for (const g of byTerm.values()) {
    // A banned word that is itself an approved name ("cycle", "release", "reboot") is legal in its own sense;
    // only the context can tell, and a warning on every use would teach readers to skip the list.
    if (approvedNames.has(g.banned.toLowerCase())) continue;
    const re = new RegExp(`(?<![\\w-])${escapeRe(g.banned)}(?:s|es)?(?![\\w-])`, "i");
    const m = prose.match(re);
    if (!m) continue;
    if (g.qualifier !== null) {
      add({ rule: "glossary", level: "advisory", match: m[0],
        message: `"${m[0]}": if you mean ${g.meaning}, write "${g.approved}" (glossary: ${g.qualifier}).` });
    } else {
      add({ rule: "glossary", level: "hard", match: m[0],
        message: `"${m[0]}": write "${g.approved}" (glossary: ${g.meaning}).` });
    }
  }

  // --- Structural rules. ---
  const hard: Array<[string, RegExp, string]> = [
    ["semicolon", /;/g, "No semicolons (STE 8.1). Write two sentences."],
    ["phrasal-verb", new RegExp(`\\b(?:${[PHRASAL, ...cfg.extra_phrasal_verbs.map(escapeRe)].join("|")})\\b`, "gi"),
      "Phrasal verb. Use one plain verb (start, contact, read, begin)."],
    ["marketing-adjective", new RegExp(`\\b(?:${[MARKETING, ...cfg.extra_marketing_adjectives.map(escapeRe)].join("|")})\\b`, "gi"),
      "Marketing adjective. Delete it, or give the measurement."],
    ["nominalization", NOMINALIZATION, "Action frozen into a noun. Use the verb (analyze, not perform an analysis)."],
  ];
  const advisory: Array<[string, RegExp, string]> = strict
    ? [
        ["passive-voice", PASSIVE, "Possible passive voice. Name who does it, unless that is unknown."],
        ["present-perfect", PRESENT_PERFECT, "Compound tense. Use simple past or present."],
      ]
    : [];
  for (const [rule, re, message] of hard) for (const m of prose.matchAll(re)) add({ rule, level: "hard", match: m[0], message: `"${m[0]}": ${message}` });
  for (const [rule, re, message] of advisory) for (const m of prose.matchAll(re)) add({ rule, level: "advisory", match: m[0], message: `"${m[0]}": ${message}` });

  const cap = strict ? cfg.max_words_strict : cfg.max_words_slack;
  let words = 0;
  for (const s of sentences(prose)) {
    const n = countWords(s);
    words += n;
    if (n > cap) {
      add({ rule: "long-sentence", level: "hard", match: `${s.split(/\s+/).slice(0, 6).join(" ")}… (${n} words)`,
        message: `Sentence has ${n} words (cap ${cap}). Split it.` });
    }
  }

  if (strict) {
    for (const group of SYNONYM_GROUPS) {
      const present = group
        .map((base) => ({ base, at: prose.search(new RegExp(`\\b${base}(?:s|es|ed|d|ing)?\\b`, "i")) }))
        .filter((p) => p.at >= 0)
        .sort((a, b) => a.at - b.at);
      for (const p of present.slice(1)) {
        add({ rule: "synonym-rotation", level: "advisory", match: p.base,
          message: `"${p.base}" and "${present[0].base}" name the same action. Pick one.` });
      }
    }
  }

  return { warnings, errors, words };
}

/** Payload fields that carry machine text, not prose: a semicolon in a shell command is not a style error. */
const NON_PROSE_KEYS = /^(?:command|cmd|argv|args|log|logs|stack|stderr|stdout|output|diff|patch|code|sql|query|script|path|paths|url|urls|sha|hash|id|ids|ts|thread_ts|channel)$/i;

/** Every prose string inside an IPC payload (any JSON shape). Keys are not prose; short tokens are not either. */
export function payloadProse(payload: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof v === "string") { if (countWords(v) >= 3) out.push(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (!NON_PROSE_KEYS.test(k)) walk(x, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
}

/**
 * The text a send tool appends to its result. Empty string when there is nothing to say.
 * Never throws: a linter defect is itself reported as a line, with the stack on stderr.
 */
export function steReport(inputs: unknown[], opts: SteLintOptions, maxLines = 8): string {
  try {
    const all: SteWarning[] = [];
    const errors = new Set<string>();
    const seen = new Set<string>();
    // A string is linted as-is; anything else (an IPC payload, Slack blocks) is walked for prose. Inside the try:
    // the callers have ALREADY sent, so nothing here may surface as a send failure.
    const texts = inputs.flatMap((x) => (typeof x === "string" ? [x] : payloadProse(x)));
    for (const t of texts) {
      const r = lintSte(t, opts);
      r.errors.forEach((e) => errors.add(e));
      for (const w of r.warnings) {
        const k = `${w.rule}:${w.match.toLowerCase()}`;
        if (!seen.has(k)) { seen.add(k); all.push(w); }
      }
    }
    if (!all.length && !errors.size) return "";
    all.sort((a, b) => (a.level === b.level ? 0 : a.level === "hard" ? -1 : 1));
    const lines = all.slice(0, maxLines).map((w) => `- [${w.level === "hard" ? w.rule : w.rule + "?"}] ${w.message}`);
    if (all.length > maxLines) lines.push(`- …and ${all.length - maxLines} more`);
    for (const e of errors) lines.push(`- [ste-lint error] ${e}`);
    const hardN = all.filter((w) => w.level === "hard").length;
    return `\nSTE (${opts.mode}, warn-only — the message was sent): ${hardN} hard, ${all.length - hardN} advisory.\n${lines.join("\n")}`;
  } catch (e) {
    const err = e as Error;
    console.error("[ste-lint] linter failed", { mode: opts.mode, inputs: inputs.length }, err.stack ?? err);
    return `\nSTE linter error (the message was sent): ${err.message}`;
  }
}

/** The core rules, for tool descriptions. Keep it short: every description is in every turn's context. */
export function steToolGuidance(mode: SteMode): string {
  const cap = mode === "strict" ? 20 : 25;
  return (
    `Write in ASD-STE100 style (${mode === "strict" ? "strict" : "STE-flavored"}): ` +
    `one name per thing — use the approved names in ${DEFAULT_STE_GLOSSARY_PATH}, never their synonyms. ` +
    `Sentences of ${cap} words or fewer, one action each. Active voice: say who does what. ` +
    `No semicolons. Numbers as digits. Rules: ${DEFAULT_STE_RULES_PATH}. ` +
    `A warn-only linter appends warnings to the result after the message is sent.`
  );
}
