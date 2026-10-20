// Pins ci.yml's workflow-level concurrency group. Its failure is silent: a
// group that cancels the wrong run leaves a required check canceled or
// missing on a head, and one that cancels nothing quietly doubles every
// push's runs; neither turns any job red.
//
// Read as regexes over YAML, the same tradeoff workflow-check-rename.test.js
// makes: this repository has no dependencies by design, so the exact lines a
// human wrote are pinned, after asserting the block is there at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("./.github/workflows/ci.yml", import.meta.url), "utf8");
const MAIN =
  "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))";
const block = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m);

test("declares one workflow-level concurrency group", () => {
  assert.ok(block, "ci.yml has no workflow-level concurrency block");
  assert.equal(workflow.match(/^concurrency:/gm).length, 1);
});

test("groups a pull request by its number and main by commit", () => {
  assert.ok(
    block[1].includes(
      `  group: ci-\${{ ${MAIN} && format('main-{0}', github.sha) || github.event.pull_request.number || github.ref }}\n`,
    ),
  );
});

test("cancels on a push, open or reopen, never on main or an edit", () => {
  // An `edited` run carries the head as of the edit, and GitHub doesn't
  // promise to start runs in event order, so a canceling edit could cancel
  // the only run on a newer head; it queues instead.
  assert.ok(
    block[1].includes(`  cancel-in-progress: \${{ !${MAIN} && github.event.action != 'edited' }}\n`),
  );
});

test("still runs on an edit and a push, so a retarget re-runs the lane", () => {
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
});
