// Tests for this repository's lane policy, .github/lanes.conf.
//
// The engine (mikelward/lanes) is tested in its own repository; what it
// cannot test is THIS repo's policy, and the policy's failure mode is the
// quiet one: a broadened rule makes classify and gate derive the same wrong
// docs verdict, so the Node suite skips under a green required check. So the
// rules are exercised here, both directions, with `path.matchesGlob` — the
// same standard primitive the engine matches with, so this suite cannot
// drift from the engine on glob semantics. The tiny reader below follows the
// policy format the lanes README documents (ordered rules, full-line and
// trailing comments, first match wins, no rule means code); if the engine
// ever refuses a shape this reader accepts, the gate goes red rather than
// green, which is the safe direction for a disagreement.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

const text = readFileSync(new URL("./.github/lanes.conf", import.meta.url), "utf8");

const lines = text
  .split("\n")
  .map((line) => {
    const comment = line.search(/\s#/);
    return (comment === -1 ? line : line.slice(0, comment)).trim();
  })
  .filter((line) => line && !line.startsWith("#"));

const rules = [];
const directives = {};
for (const line of lines) {
  const [word, ...rest] = line.split(/\s+/);
  if (word === "docs" || word === "code") rules.push({ verdict: word, pattern: rest.join(" ") });
  else directives[word] = rest;
}

const classify = (path) => {
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(path, pattern)) return verdict;
  }
  return "code";
};

describe("the lane policy", () => {
  test("parses to the intended shape, nothing wider", () => {
    // A rule this suite has not vetted is a rule nothing here exercises.
    assert.deepEqual(rules, [{ verdict: "docs", pattern: "**/*.md" }]);
    assert.deepEqual(directives.prefixes, ["docs"]);
    assert.deepEqual(directives["dispatch-without-pr"], ["refuse"]);
  });

  test("markdown rides the docs lane, at the root and nested", () => {
    for (const path of ["README.md", "AGENTS.md", "docs/notes.md"]) {
      assert.equal(classify(path), "docs", path);
    }
  });

  test("everything a consumer's weekly run executes is code", () => {
    // The other direction is the one that matters: a pattern loosened to
    // match any of these would skip the suite that validates them.
    for (const path of [
      "check-npm-update.mjs",
      "vitest-shim.mjs",
      "lanes-policy.test.js",
      ".github/workflows/ci.yml",
      ".github/lanes.conf",
      ".gitignore",
    ]) {
      assert.equal(classify(path), "code", path);
    }
  });
});
