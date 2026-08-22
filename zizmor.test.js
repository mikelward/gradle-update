// Tests for the advisory zizmor scan: the workflow that runs it and the
// policy it loads.
//
// The scan's failure modes are all silent: a dropped version pin floats the
// audit set, so a verdict can change with no change in this repository; a
// dropped --offline puts the GitHub API inside the scan; a widened policy
// exempts refs nobody decided to exempt; a narrowed path filter stops
// re-running the scan on the files it audits. Every one of those leaves the
// rest of the suite green, because zizmor only runs inside its own
// workflow — so the contract is pinned here, by regex over the files: this
// repository ships no YAML parser on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/zizmor.yml", "utf8");
const policy = readFileSync(".github/zizmor.yml", "utf8");

// Strips YAML comments, full-line and inline both: the prose explains the
// exemptions partly by naming the shapes they must NOT take, and an entry
// written as `"foo/bar": ref-pin # rationale` must still be collected, not
// hidden from the table comparison by its trailing comment. A function
// rather than a constant so the inline branch can be proved on a fixture
// below — the committed policy has no inline-commented entries to prove it
// on.
const stripComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const policyRules = stripComments(policy);

// Every pin-policy entry in the text, quoted or not — YAML accepts both,
// so a match that filtered by quoting style would let an unquoted key ride
// in unseen.
const policyEntries = (text) =>
  [...text.matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );

test("the scan pins the zizmor version exactly", () => {
  // An unpinned run takes whatever release is newest, and a new release
  // adds audits. Bumping the pin is a deliberate edit that re-reads the
  // findings, never a side effect.
  assert.match(workflow, /pipx run --spec zizmor==\d+\.\d+\.\d+ zizmor /);
});

test("the scan runs offline", () => {
  // The one scan invocation carries --offline, so the audits that need the
  // GitHub API are skipped deterministically and the only fetch at run
  // time is zizmor itself.
  const runs = [...workflow.matchAll(/pipx run [^\n]+/g)];
  assert.equal(runs.length, 1);
  assert.match(runs[0][0], / --offline /);
});

test("the scan holds read-only permissions, top-level only", () => {
  // Pins the whole grant, and requires the top-level block to be the ONLY
  // one: GitHub lets a job-level mapping replace it wholesale, so a second
  // permissions block anywhere is a widening no matter how it is scoped.
  assert.match(workflow, /\npermissions:\n  contents: read\njobs:/);
  assert.equal([...workflow.matchAll(/^ *permissions:/gm)].length, 1);
});

test("the scan runs on every pull request and push to main, with no paths filter", () => {
  // `zizmor` is slated for the ruleset's required set (TODO.md holds
  // the flip), and a required check must report on every pull request's
  // head: a workflow filtered out by
  // `paths:` creates NO check run at all — unlike a skipped job, which
  // reports "skipped" and satisfies the ruleset — so a filter here would
  // leave any PR not touching the filtered paths unmergeable behind a
  // check nothing reports. Matched as one contiguous block that runs
  // straight from `on:` into `permissions:`, so `pull_request:` provably
  // carries NO nested configuration — not just no `paths:`: a `types:`
  // filter under it would equally stop the check reporting on opened or
  // synchronized heads. The one nested key allowed is the explicit types
  // list, `edited` included: a retarget regenerates the merge ref against
  // the new base while the head — and the green check attached to it —
  // stays put, so the default types (which lack `edited`) would let the
  // old target's scan satisfy the new one. The separate no-paths
  // assertion keeps a filter from riding on any future trigger this
  // block match doesn't cover.
  assert.match(
    workflow,
    /\non:\n  push:\n    branches: \[main\]\n  pull_request:\n    types: \[opened, synchronize, reopened, edited\]\npermissions:\n/,
  );
  assert.doesNotMatch(workflow, /^\s*paths:/m);
});

test("the policy's pin table is exact", () => {
  // `@main` is the release for the enumerated sibling action, official
  // actions may pin tags, and the blanket hash-pin rule has to be restated
  // because supplying policies replaces zizmor's defaults. The table is
  // compared whole: an entry added, dropped, or widened (say, mikelward/*)
  // fails here, whichever shape it takes.
  assert.deepEqual(policyEntries(policyRules), [
    "mikelward/codex-review: ref-pin",
    "mikelward/codex-review/.github/workflows/check-consumer.yml: ref-pin",
    "mikelward/lanes: ref-pin",
    "actions/*: ref-pin",
    "*: hash-pin",
  ]);
});

test("the policy reader collects an entry hidden behind an inline comment", () => {
  // The committed policy carries no inline-commented entries, so the
  // stripping branch is proved on a fixture: were it dropped, an exemption
  // written as `"o/r": ref-pin # rationale` would vanish from the table
  // comparison instead of failing it, and the suite would stay green while
  // the table check quietly stopped seeing such lines.
  const fixture = '        "o/r": ref-pin # rationale';
  assert.deepEqual(policyEntries(stripComments(fixture)), ["o/r: ref-pin"]);
});

test("the policy excuses pull_request_target only for the two codex-review files", () => {
  // The ignore list is why a NEW workflow reaching for pull_request_target
  // is still flagged. The list items are the only `- ` entries in the
  // file; compared whole, so nothing rides in beside the two excused
  // workflows.
  const ignored = [...policyRules.matchAll(/^ +- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(ignored, ["codex-review.yml", "codex-review-check.yml"]);
});
