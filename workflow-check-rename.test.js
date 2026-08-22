// Guards the temporary state introduced while renaming the required check
// from `gate` to `lanes` (mikelward/lanes#9): a duplicate job, kept in sync
// by hand until the ruleset is flipped and `gate` is deleted. Nothing else
// pins the two jobs together, so a hand edit to one that forgets the other
// would drift silently -- exactly the false-pass failure mode this suite is
// meant to catch (see AGENTS.md).
//
// Read as regexes over YAML, same tradeoff lanes' own workflows.test.mjs
// makes: this repository has no dependencies by design, so a real parser is
// off the table, and the risk is bounded by pinning exact strings a human
// wrote and a human will edit.
//
// Delete this file along with the `gate` job once the ruleset requires only
// `lanes` -- it exists to guard the overlap window, not the steady state.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("./.github/workflows/ci.yml", import.meta.url), "utf8");

// A job block runs from its "  <key>:" line to the line before the next
// one at the same (two-space) indent, or EOF.
function jobBlock(text, key) {
  const start = text.indexOf(`\n  ${key}:\n`);
  assert.notEqual(start, -1, `job "${key}" not found in ci.yml`);
  const rest = text.slice(start + 1);
  const next = rest.slice(rest.indexOf("\n") + 1).search(/\n {2}\S/);
  const end = next === -1 ? text.length : start + 1 + rest.indexOf("\n") + 1 + next;
  return text.slice(start + 1, end);
}

describe("the temporary gate/lanes duplicate", () => {
  test("both jobs exist while the rename is in flight", () => {
    assert.match(workflow, /\n {2}gate:\n {4}name: gate\n/);
    assert.match(workflow, /\n {2}lanes:\n {4}name: lanes\n/);
  });

  test("gate and lanes run identically apart from their own name", () => {
    const strip = (block) => block.replace(/^ {2}\S+:\n {4}name: \S+\n/, "");
    assert.equal(
      strip(jobBlock(workflow, "gate")),
      strip(jobBlock(workflow, "lanes")),
      "the gate and lanes jobs have drifted -- keep them identical until gate is deleted",
    );
  });
});
