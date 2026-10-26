// Tests for the front matter on AGENTS.md, which tools that load agent rule
// files read to decide when the file applies. A renamed key or a broken
// fence would silently drop the always-on behavior while the prose still
// reads fine, so the keys are asserted here, after first asserting that a
// front matter block was found at all (an empty parse would pass vacuously).

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const text = readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8");
const match = text.match(/^---\n([\s\S]*?)\n---\n/);

test("AGENTS.md opens with a front matter block", () => {
  assert.ok(match, "AGENTS.md must start with a --- fenced front matter block");
});

const lines = (match ? match[1] : "").split("\n").filter((line) => line.trim());
const parsed = lines.map((line) => line.match(/^([A-Za-z_]+): (\S.*)$/));

test("every front matter line is a simple key: value pair", () => {
  assert.ok(lines.length > 0, "front matter must not be empty");
  lines.forEach((line, i) => assert.ok(parsed[i], `unparseable front matter line: ${line}`));
});

const keys = parsed.filter(Boolean).map(([, key]) => key);

test("front matter has exactly the expected keys, each once", () => {
  assert.deepEqual(keys, ["trigger", "alwaysApply", "last_modified"]);
});

const fields = Object.fromEntries(
  parsed.filter(Boolean).map(([, key, value]) => [key, value.trim()]),
);

test("front matter marks the guide always on", () => {
  assert.equal(fields.trigger, "always_on");
  assert.equal(fields.alwaysApply, "true");
});

test("front matter carries a last_modified date", () => {
  const value = fields.last_modified ?? "";
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  // The pattern alone accepts 2026-02-31; a real date round-trips unchanged.
  assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), value);
});

test("the guide tells agents to report the loaded file at session start", () => {
  assert.match(text, /At\s+the\s+start\s+of\s+every\s+session,\s+print\s+the\s+full\s+absolute\s+path\s+of\s+the\s+`AGENTS\.md`\s+you\s+loaded\s+and\s+its\s+`last_modified`\s+date/);
  assert.match(text, /Bump\s+`last_modified`\s+whenever\s+you\s+edit\s+this\s+file/);
});

// Claude Code reads CLAUDE.md and Gemini / Antigravity read GEMINI.md; each
// must stay a symlink to AGENTS.md, or that client loses the shared rules
// while every test above, which reads AGENTS.md directly, still passes.
for (const name of ["CLAUDE.md", "GEMINI.md"]) {
  test(`${name} is a symlink to AGENTS.md`, () => {
    const file = new URL(`./${name}`, import.meta.url);
    assert.ok(lstatSync(file).isSymbolicLink(), `${name} must be a symlink`);
    assert.equal(readlinkSync(file), "AGENTS.md");
  });
}

// Antigravity silently truncates a rule file past 24 KB; the guide holds
// itself to 22,000 bytes so the next rule added can't cut off the tail.
test("AGENTS.md stays under its stated 22,000-byte cap", () => {
  assert.match(text, /under 22,000 bytes/);
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes > 0, "AGENTS.md must not be empty");
  assert.ok(bytes <= 22000, `AGENTS.md is ${bytes} bytes, over the 22,000-byte cap`);
});
