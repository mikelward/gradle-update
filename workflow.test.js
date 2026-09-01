// Tests for shell logic inside .github/workflows/gradle-update.yml itself —
// this repository ships no YAML parser on purpose (see zizmor.test.js), so
// these are regex assertions over the raw file text, the same convention
// rust-update's workflow.test.js established for its sibling workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(".github/workflows/gradle-update.yml", "utf8");

test("a half-supplied App credential is refused through env, never secrets, in its if:, but only when no PAT is set", () => {
  // The secrets context is unusable directly in a reusable workflow's own
  // if: conditions — referencing secrets.app-id here would silently break
  // the refusal, not just read wrong, so assert the env-based form is what
  // actually ships. Gated on env.PAT == '' too: once a token takes
  // priority, a leftover half-removed app-id from a PAT migration is
  // irrelevant and must not fail the run.
  const refuse = /if: env\.PAT == '' && \(env\.APP_ID == ''\) != \(env\.APP_PRIVATE_KEY == ''\)/;
  assert.match(workflow, refuse, "the half-credential refusal step's if: was not found reading env.PAT/env.APP_ID/env.APP_PRIVATE_KEY");
  assert.doesNotMatch(workflow, /if:\s*\(secrets\.app-id/, "the refusal step must not test secrets.app-id directly");
});

test("the App token mint is skipped once a PAT is set, even with a full App credential", () => {
  // Minting an installation token that GH_TOKEN resolution then discards
  // unused (PAT takes priority) is a needless credential mint — skip the
  // step entirely rather than mint-and-ignore.
  assert.match(workflow, /if: env\.PAT == '' && env\.APP_ID != ''/, "the mint step's if: must require env.PAT == '' before env.APP_ID != ''");
});

test("the App token is minted from env, scoped explicitly to contents and pull-requests", () => {
  const mint = /uses: actions\/create-github-app-token@v2\s*\n\s*with:\s*\n\s*app-id: \$\{\{ env\.APP_ID \}\}\s*\n\s*private-key: \$\{\{ env\.APP_PRIVATE_KEY \}\}/;
  assert.match(workflow, mint, "the mint step's app-id/private-key inputs were not found reading from env.APP_ID/env.APP_PRIVATE_KEY");

  // Without these the minted token silently inherits the App's whole
  // installation grant instead of just what this job uses (zizmor's
  // github-app audit catches this too, but that's advisory — this suite is
  // the one that actually gates the merge).
  assert.match(workflow, /permission-contents: write/, "the minted token must be scoped to permission-contents explicitly");
  assert.match(workflow, /permission-pull-requests: write/, "the minted token must be scoped to permission-pull-requests explicitly");
});

test("every GH_TOKEN in the publish job prefers a PAT, then the minted App token, then github.token", () => {
  const ghTokenLines = [...workflow.matchAll(/GH_TOKEN: (\$\{\{[^\n]*\}\})/g)].map((m) => m[1]);
  assert.ok(ghTokenLines.length >= 3, "expected at least three GH_TOKEN assignments in the publish job");
  for (const line of ghTokenLines) {
    assert.match(line, /env\.PAT \|\| steps\.app-token\.outputs\.token \|\| github\.token/, `GH_TOKEN did not prefer PAT, then the App token, found: ${line}`);
  }
});

test("both jobs fetch the engine at the running workflow's own revision, never at one the update job reported", () => {
  // The update job used to record the engine's sha as a job output and
  // publish checked the validator out at it. Every other output is bounded
  // to "a failed comparison" in publish; that one was a code pointer, and a
  // forged one would have pointed publish — write credential in its env —
  // at any commit reachable from this repository, a fork's PR head
  // included. `job.workflow_sha` comes from the runner's own context, and
  // it is also what makes a consumer piloting `@branch` run that branch's
  // engine rather than main's.
  const pins = [...workflow.matchAll(/repository: mikelward\/gradle-update\n(?:[ \t]*#[^\n]*\n)*[ \t]*ref: ([^\n]*)\n/g)].map((m) => m[1]);
  assert.deepEqual(pins, ["${{ job.workflow_sha }}", "${{ job.workflow_sha }}"], `expected both engine checkouts pinned to job.workflow_sha, found ${JSON.stringify(pins)}`);
  assert.doesNotMatch(workflow, /engine_sha|steps\.engine\b|Record the engine revision/, "no engine revision may travel as a job output");
});

test("the token secret is declared optional and read into env.PAT", () => {
  assert.match(workflow, /^\s*token:\s*$/m, "the reusable workflow must declare a token secret");
  assert.match(workflow, /PAT: \$\{\{ secrets\.GRADLE_UPDATE_PAT \|\| secrets\.token \}\}/, "the publish job must read the environment's GRADLE_UPDATE_PAT into env.PAT, falling back to the legacy secrets.token");
  assert.match(workflow, /APP_ID: \$\{\{ secrets\.GRADLE_UPDATE_APP_ID \|\| secrets\.app-id \}\}/, "APP_ID must prefer the environment's GRADLE_UPDATE_APP_ID");
  assert.match(workflow, /APP_PRIVATE_KEY: \$\{\{ secrets\.GRADLE_UPDATE_APP_PRIVATE_KEY \|\| secrets\.app-private-key \}\}/, "APP_PRIVATE_KEY must prefer the environment's GRADLE_UPDATE_APP_PRIVATE_KEY");
});

test("only the publish job declares the environment the batch credential lives in", () => {
  // A secret passed through workflow_call reaches the runner of every job
  // in the called workflow, the update job included — where dependency
  // code runs with sudo. An environment secret reaches only the job that
  // declares the environment, so publish declares it, from the input, and
  // update never does.
  assert.match(workflow, /^      environment:\n        description: >-[^]*?\n        type: string\n        default: gradle-update\n/m, "the environment input, defaulting to gradle-update, was not found");
  const environments = [...workflow.matchAll(/^    environment: (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(environments, ["${{ inputs.environment }}"], `exactly one job may declare an environment, from the input; found ${JSON.stringify(environments)}`);
  const updateStart = workflow.indexOf("\n  update:\n");
  const publishStart = workflow.indexOf("\n  publish:\n");
  assert.ok(updateStart > -1 && publishStart > updateStart, "expected the update job to precede the publish job");
  assert.doesNotMatch(workflow.slice(updateStart, publishStart), /^\s*environment:/m, "the update job must never declare an environment");
  assert.match(workflow.slice(publishStart), /^    environment: \$\{\{ inputs\.environment \}\}$/m, "the publish job must declare the environment from the input");
});

test("the Actions-API run-timestamp read stays on github.token, never the App-preferring GH_TOKEN", () => {
  // docs/GITHUB_APP.md deliberately grants the App only Contents and pull
  // requests, not Actions — this read would fail under set -e for any
  // consumer that wired up the App, silently before the resolve step even
  // decides the branch name, if it ever went back to reading $GH_TOKEN.
  const defaultTokenAssignments = [...workflow.matchAll(/DEFAULT_TOKEN: (\$\{\{[^\n]*\}\})/g)].map((m) => m[1]);
  assert.ok(defaultTokenAssignments.length >= 2, "expected DEFAULT_TOKEN (always github.token) in both the resolve and open-PR steps");
  for (const line of defaultTokenAssignments) {
    assert.equal(line, "${{ github.token }}", `DEFAULT_TOKEN must always be github.token, found: ${line}`);
  }
  const read = /created=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --jq \.created_at\)/;
  assert.match(workflow, read, "the actions/runs read must override GH_TOKEN to $DEFAULT_TOKEN for just this one command");
});

test("the CI dispatch also overrides GH_TOKEN to github.token, never the PAT/App-preferring one", () => {
  // This branch runs precisely when a PAT or App token was available but
  // didn't open the PR (nondefault_opened_pr false with
  // NONDEFAULT_TOKEN_USED true — an adopted rerun of a pre-existing
  // default-token PR), so the ambient $GH_TOKEN can still be that
  // credential here. `gh workflow run` is an Actions API write neither
  // docs/PAT.md's nor docs/GITHUB_APP.md's two documented permissions
  // cover, so it must not run under the ambient token either.
  const dispatch = /if GH_TOKEN="\$DEFAULT_TOKEN" gh workflow run "\$CI_WORKFLOW" --ref "\$branch" -f pr="\$pr"; then/;
  assert.match(workflow, dispatch, "the CI dispatch must override GH_TOKEN to $DEFAULT_TOKEN, the same way the actions/runs read does");
});

test("the strict-policy probe also overrides GH_TOKEN to github.token, never the App-preferring one", () => {
  // Unlike rust-update (no analogous probe), this hub reads the ruleset's
  // branch rules to decide whether to arm auto-merge — a read the App's
  // two documented permissions (Contents + pull requests) don't cover.
  // Deliberately kept on GITHUB_TOKEN rather than requesting a third
  // permission (Administration: read) just for this diagnostic query.
  const probe = /strict=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api --paginate --slurp "repos\/\$\{GITHUB_REPOSITORY\}\/rules\/branches\//;
  assert.match(workflow, probe, "the strict-policy probe must override GH_TOKEN to $DEFAULT_TOKEN");
});

test("nondefault_opened_pr crosses the resolve/open-PR step split via the adopt output", () => {
  // The publish job is split across two steps purely for GitHub's 21,000-
  // character scalar-node cap (see the comment above "Resolve the branch,
  // then adopt or commit and push"). adopt is decided in the resolve step
  // but nondefault_opened_pr — which needs it — is computed in the open-PR
  // step, so it has to travel as a step output like branch/title/verdict/
  // validated_head already do.
  assert.match(workflow, /echo "adopt<<\$delim"/, "the resolve step must emit adopt as a heredoc output");
  assert.match(workflow, /RESOLVED_ADOPT: \$\{\{ steps\.resolve\.outputs\.adopt \}\}/, "the open-PR step must read RESOLVED_ADOPT from steps.resolve.outputs.adopt");
  assert.match(workflow, /adopt="\$RESOLVED_ADOPT"/, "the open-PR step must assign adopt from $RESOLVED_ADOPT before deriving nondefault_opened_pr");
});

test("the CI dispatch keys off nondefault_opened_pr, not the raw NONDEFAULT_TOKEN_USED flag", () => {
  assert.match(
    workflow,
    /if \[ "\$nondefault_opened_pr" != 'true' \] && \[ -n "\$CI_WORKFLOW" \]; then/,
    "the dispatch-skip condition was not found keyed on nondefault_opened_pr",
  );

  // nondefault_opened_pr must require THIS run to have put the real
  // identity on the wire (a fresh push in the resolve step, or a fresh
  // `gh pr create` here) — an adopted rerun that reuses an existing PR
  // proves nothing about who opened it, so NONDEFAULT_TOKEN_USED alone
  // (this invocation merely had a credential available) must not be
  // sufficient on its own.
  assert.match(
    workflow,
    /if \[ "\$NONDEFAULT_TOKEN_USED" = 'true' \] && \{ \[ "\$adopt" != true \] \|\| \[ "\$pr_opened_here" = true \]; \}; then/,
    "nondefault_opened_pr's derivation must require adopt != true or pr_opened_here, not NONDEFAULT_TOKEN_USED by itself",
  );
});

test("the PR-body only calls out CI when neither a native trigger nor the dispatch started it", () => {
  // The PAT-vs-App-vs-dispatched narration was cut: a reviewer gets no
  // actionable value from being told which identity opened the PR or why
  // `on: pull_request` did or didn't fire. Only the case that leaves the
  // reviewer with something to do — CI genuinely didn't start — still
  // prints a note, and it prints unconditionally on that one guard rather
  // than via a PAT/App/dispatched elif chain.
  assert.match(
    workflow,
    /if \[ "\$nondefault_opened_pr" != 'true' \] && \[ "\$ci_started" != true \]; then/,
    "the collapsed CI-not-started condition was not found",
  );
  assert.doesNotMatch(workflow, /opened under a personal access token/, "the PAT-specific PR-body narration should have been removed");
  assert.doesNotMatch(workflow, /opened under a GitHub App installation/, "the App-specific PR-body narration should have been removed");
  assert.doesNotMatch(workflow, /These ran in the workflow job, not on this PR/, "the dispatched-CI narration should have been removed");
  assert.match(workflow, /CI was not started on this branch by this job/, "the actionable CI-not-started note was not found");
  assert.match(workflow, /push any commit to the branch/, "the actionable push-a-commit fallback was not found");
});

test("a PAT- or App-opened PR gets an explicit @codex review nudge, retried like the body edit", () => {
  // mesh#533, the first PR rust-update's copy of this workflow opened
  // under the App's identity, got no automatic Codex review — the
  // connector's webhook trigger apparently doesn't fire the same way it
  // does for a human or GITHUB_TOKEN-authored PR. A PAT's identity is a
  // real user account rather than an App or a bot, so it likely gets the
  // native trigger, but that's unconfirmed, so the nudge fires for either
  // credential rather than betting the merge gate on an assumption. Gated
  // on nondefault_opened_pr, not unconditional: there's no evidence of the
  // gap on the GITHUB_TOKEN path, and nudging every PR would just be
  // noise. Retried: a rerun of a failed attempt doesn't get a second
  // chance at this block (a later rerun adopts the existing PR, and
  // nondefault_opened_pr goes false with it), so a transient gh pr comment
  // failure without a retry here would strand the PR with no automatic
  // recovery path.
  const nudge = /if \[ "\$nondefault_opened_pr" = 'true' \]; then\s*\n\s*nudged=false\s*\n\s*for _ in 1 2 3; do\s*\n\s*if gh pr comment "\$pr" --body '@codex review'; then/;
  assert.match(workflow, nudge, "the retried @codex review nudge, gated on nondefault_opened_pr, was not found");
});

// The tree-check gates (the regenerate step's pretree check, the review
// checks step's treestate()/preplanted, and the final "Verify only the
// catalog changed" step) all read `git status --porcelain -z` through a
// direct pipe under `shopt -s lastpipe`, classifying each whole
// NUL-terminated record. This guards against bugs earlier forms had, at
// every one of those six call sites: a `tr '\0' '\n'` conversion let an
// untracked filename with an embedded newline split into two lines and
// hide behind an allowlist entry (verified directly: a file named
// "\nXXXchecks.md" vanished completely under that pipeline, `pretree`
// coming back empty even though the file was there); a trailing `|| true`
// swallowed a genuine `git status` failure the same way it swallowed
// grep's ordinary no-matches exit 1; and — the reason these are pipes and
// not scratch files, per Codex's review of an interim mktemp fix —
// reading a scratch file back by NAME reopens a window between the write
// and the read for anything already watching $RUNNER_TEMP to swap its
// content, which mktemp's unpredictable name narrows but does not close.
test("every tree-check reads NUL-terminated records through a direct pipe, not a tr-joined `|| true` pipe or a scratch file", () => {
  const riskyJoin = /git status --porcelain[^\n]*\\\n[^\n]*\| tr '\\\\0'/;
  assert.doesNotMatch(workflow, riskyJoin, "a git-status-into-tr pipeline reappeared — see gradle-update-nul-safety fix");
  assert.doesNotMatch(workflow, /git status --porcelain -z[^\n]*> "\$[A-Za-z_]+"/, "a bare git-status-into-file redirect reappeared — see the direct-pipe fix");

  const readLoops = [...workflow.matchAll(/while IFS= read -r -d '' entry; do/g)];
  assert.equal(readLoops.length, 6, `expected 6 NUL-record read loops, found ${readLoops.length}`);
});

// Extracts the regenerate step's pretree/preplanted block from the real
// file text (not a hand-copied literal) so a future edit that reintroduces
// either bug, or removes the fix, breaks this test rather than drifting
// unnoticed.
function extractPretreeBlock(text) {
  const startMarker = 'allow=("$CATALOG" report.md checks.md deps-stat.txt)';
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "pretree block start marker not found in gradle-update.yml");
  const ifMarker = 'if [ -n "$pretree" ] || [ -n "$preplanted" ]; then';
  const ifStart = text.indexOf(ifMarker, start);
  assert.notEqual(ifStart, -1, "pretree block's closing if not found");
  const fiEnd = text.indexOf("\n          fi\n", ifStart);
  assert.notEqual(fiEnd, -1, "pretree block's closing fi not found");
  const raw = text.slice(start, fiEnd + "\n          fi".length);
  return raw.replace(/^ {10}/gm, "");
}

const pretreeBlock = extractPretreeBlock(workflow);

function runPretreeBlock(repoDir, runnerTemp, catalog, extraPath = "") {
  // shopt -s lastpipe first: the real step sets it one line above where
  // this extraction starts, and the block now pipes git status directly
  // into its read loops — without lastpipe those loops run in a subshell
  // and $pretree/$preplanted never escape it, so this check would always
  // read as empty regardless of what changed.
  const script = `shopt -s lastpipe\nset -euo pipefail\ncd "$1"\nCATALOG="$2"\nRUNNER_TEMP="$3"\n${pretreeBlock}\necho OK\n`;
  const env = { ...process.env, PATH: `${extraPath}${extraPath ? ":" : ""}${process.env.PATH}` };
  return execFileSync("bash", ["-c", script, "bash", repoDir, catalog, runnerTemp], { encoding: "utf8", env });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(join(dir, "gradle"));
  writeFileSync(join(dir, "gradle", "libs.versions.toml"), "x");
  writeFileSync(join(dir, "checks.md"), "x");
  writeFileSync(join(dir, "deps-stat.txt"), "x");
  writeFileSync(join(dir, "report.md"), "x");
  git("add", "gradle/libs.versions.toml", "checks.md", "deps-stat.txt", "report.md");
  git("commit", "-q", "-m", "init");
}

test("the pretree check passes on a clean tree", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-pretree-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const out = runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml");
    assert.match(out, /OK/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("the pretree check catches an untracked file whose name hides a second record behind an embedded newline", () => {
  // Reproduces the false pass the old `tr '\0' '\n'` pipeline had: a file
  // named "\nXXXchecks.md" (a newline, then "XXXchecks.md") splits into
  // "?? " (stripped to empty) and "XXXchecks.md" (stripped to "checks.md",
  // an exact allowlist match) once NUL is joined into newlines and every
  // resulting line has its 3-character status prefix stripped — the old
  // pipeline reported an empty pretree for a tree that was not clean.
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-pretree-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    writeFileSync(join(repoDir, "\nXXXchecks.md"), "x");
    assert.throws(
      () => runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml"),
      /The checks changed the tree/,
      "the adversarial untracked file was not detected — the NUL-safety fix regressed",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("the pretree check fails closed when git status itself fails, instead of the trailing `|| true` swallowing it", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-pretree-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  const binDir = mkdtempSync(join(tmpdir(), "gradle-update-fakegit-"));
  try {
    initRepo(repoDir);
    const realGit = execFileSync("command", ["-v", "git"], { shell: "/bin/bash", encoding: "utf8" }).trim();
    const shim = `#!/bin/sh\nif [ "$1" = status ]; then echo "fatal: fake git status failure" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`;
    const shimPath = join(binDir, "git");
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);
    assert.throws(
      () => runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml", binDir),
      (err) => {
        // A swallowed failure would exit 0 with "OK\n" as stdout; the fix
        // must exit nonzero and never reach that echo.
        assert.notEqual(err.status, 0, "a fake git-status failure did not stop the script — the status-swallow fix regressed");
        assert.doesNotMatch(err.stdout?.toString() ?? "", /OK/, "the script reached its success echo despite git status failing");
        return true;
      },
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

// treestate() (the review-checks step's helper, called via `pre=$(treestate)`
// and `changed=$(treestate)`) needs its own coverage beyond the pretree
// block above: wrapping the NUL-safe git-status read inside a FUNCTION that
// is then invoked through command substitution reopens the status-swallow
// bug in a subtler form. Bash does not propagate a mid-function command
// failure through `set -e` into the assignment that calls the function —
// verified directly (`f() { false; echo after; }; x=$(f)` under `set -e`
// still reaches "after" and exits 0) — so `git status ... || return` inside
// the function is required, not optional; a bare statement identical to the
// other five call sites would silently pass here.
function extractTreestateBlock(text) {
  const startMarker = 'exempt=("$CATALOG" checks.md deps-stat.txt report.md)';
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "treestate block start marker not found in gradle-update.yml");
  // Anchored to the exact top-level-statement indentation (10 spaces): the
  // function's own comment above its git status call mentions
  // "pre=$(treestate)" too, inside a backtick-quoted aside, and a plain
  // indexOf would find that mention first instead of the real call below
  // the function definition.
  const preMarker = '\n          pre=$(treestate "$pre_z")';
  const preIdx = text.indexOf(preMarker, start);
  assert.notEqual(preIdx, -1, 'pre=$(treestate "$pre_z") call not found after the exempt array');
  const raw = text.slice(start, preIdx + preMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

const treestateBlock = extractTreestateBlock(workflow);

test("treestate() propagates a git-status failure through set -e via an explicit `|| return` on the pipe itself", () => {
  assert.match(
    treestateBlock,
    /git status --porcelain -z --untracked-files=all --no-renames \| while IFS= read -r -d '' entry; do[\s\S]*?done \|\| return/,
    "treestate()'s git-status pipe must end in `|| return` — see this test's header comment for why a bare pipeline does not propagate the failure",
  );
});

test("a git-status failure inside treestate() stops the review-checks step instead of being swallowed", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-treestate-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  const binDir = mkdtempSync(join(tmpdir(), "gradle-update-fakegit-"));
  try {
    initRepo(repoDir);
    const realGit = execFileSync("command", ["-v", "git"], { shell: "/bin/bash", encoding: "utf8" }).trim();
    const shim = `#!/bin/sh\nif [ "$1" = status ]; then echo "fatal: fake git status failure" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`;
    const shimPath = join(binDir, "git");
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);
    const script = `shopt -s lastpipe\nset -euo pipefail\ncd "$1"\nCATALOG="$2"\nRUNNER_TEMP="$3"\nREGEN_SHA=""\nREGENERATED_FILES=""\n${treestateBlock}\necho "REACHED pre=[$pre]"\n`;
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    assert.throws(
      () => execFileSync("bash", ["-c", script, "bash", repoDir, "gradle/libs.versions.toml", runnerTemp], { encoding: "utf8", env }),
      (err) => {
        assert.notEqual(err.status, 0, "a fake git-status failure inside treestate() did not stop the step");
        assert.doesNotMatch(err.stdout?.toString() ?? "", /REACHED/, "the step reached past pre=$(treestate) despite git status failing inside it");
        return true;
      },
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

// capture_and_restore() (the per-review-command capture/restore helper)
// consumes treestate()'s changed-file list through two more read loops of
// its own — the diff-report loop and the restore loop. Both needed the same
// NUL-delimited treatment: re-serializing treestate()'s result as a
// newline-joined string and reading it back with `while IFS= read -r f`
// would still split a file with an embedded newline in its name into two
// fragments there, reopening the same failure mode one step downstream of
// where the tree-check gates themselves were fixed (Codex found this on a
// review of the treestate() fix above).
test("capture_and_restore fully restores a file whose name contains an embedded newline, as one record not two", () => {
  const startMarker = 'exempt=("$CATALOG" checks.md deps-stat.txt report.md)';
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, "capture_and_restore block start marker not found");
  const closeMarker = "\n          }\n";
  const closeIdx = workflow.indexOf(closeMarker, workflow.indexOf("capture_and_restore() {", start));
  assert.notEqual(closeIdx, -1, "capture_and_restore's closing brace not found");
  const block = workflow.slice(start, closeIdx + closeMarker.length).replace(/^ {10}/gm, "");

  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-restore-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const script = `shopt -s lastpipe
set -euo pipefail
cd "$1"
CATALOG="$2"
RUNNER_TEMP="$3"
REGEN_SHA=""
REGENERATED_FILES=""
REVIEW_CHECKS=""
${block}
printf 'x' > "$(printf '\\nweirdfile.txt')"
budget=100000
omitted=0
REVIEW_TMP="$RUNNER_TEMP/review.md"
: > "$REVIEW_TMP"
capture_and_restore 'test-command'
echo "DIRTY_BYTES=$(git status --porcelain -z --untracked-files=all | wc -c)"
`;
    const out = execFileSync("bash", ["-c", script, "bash", repoDir, "gradle/libs.versions.toml", runnerTemp], { encoding: "utf8" });
    assert.match(out, /DIRTY_BYTES=0/, `tree was not fully restored after capture_and_restore — got: ${out}`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// Every scratch file this fix writes through `>` (which follows an
// existing symlink) needs an unpredictable name: dependency and plugin
// code ran earlier in the same job and inherits $RUNNER_TEMP, so a FIXED
// name is something that code could pre-create as a symlink before the
// redirect runs — to a workflow-owned report (corrupting it while the
// allowlist still exempts it), or to /dev/null (making the check always
// read as a clean tree). Codex found this on review of the NUL-safety fix
// above; verified directly below with the exact /dev/null shape it
// described.
// Superseded by the direct-pipe redesign below (Codex found a second round:
// even an unpredictable mktemp'd name is still reopened by pathname a
// moment after git status writes it, a window something already watching
// $RUNNER_TEMP could in principle win). The write-once-read-once checks
// (pretree, both preplanted passes, treestate()'s own internal status
// read, unexpected, planted) now pipe directly with no file at all. Only
// two mktemp'd files remain, both for a genuine cross-boundary need a pipe
// can't serve: pre_z and treestate_list are written by treestate() inside
// a `$(...)` subshell and read back afterward by the calling shell (once
// immediately for pre_z, twice at separate points with real work between
// for treestate_list in capture_and_restore) — documented as a narrower
// residual gap in the comment above pre_z's declaration, the same way
// mikelward/npm-update documents its own checks.md/deps-stat.txt gap.
test("every tree-check reads through a direct pipe, not a fixed or mktemp'd scratch file — except the two that must cross a $(...) boundary", () => {
  const fixedName = /_z="\$RUNNER_TEMP\/gradle-update-[a-z-]+\.nul"/;
  assert.doesNotMatch(workflow, fixedName, "a fixed (predictable) scratch-file path reappeared — see the mktemp fix");

  const mktemps = [...workflow.matchAll(/\$\(mktemp "\$RUNNER_TEMP\/gradle-update-[a-z-]+-XXXXXX\.nul"\)/g)];
  assert.equal(mktemps.length, 2, `expected exactly 2 remaining mktemp'd files (pre_z, treestate_list — the two that must survive a $(...) boundary), found ${mktemps.length}`);

  const pipes = [...workflow.matchAll(/git status --porcelain -z [^\n|]*\| while IFS= read -r -d '' entry; do/g)];
  assert.equal(pipes.length, 6, `expected 6 direct git-status-into-while pipes (pretree, preplanted ×2, treestate, unexpected, planted), found ${pipes.length}`);

  const lastpipes = [...workflow.matchAll(/^\s*shopt -s lastpipe\s*$/gm)];
  assert.equal(lastpipes.length, 3, `expected shopt -s lastpipe on all 3 steps with a tree-check pipe, found ${lastpipes.length}`);
});

test("planting a symlink at the OLD fixed pretree path no longer touches checks.md", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-symlink-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const checksPath = join(repoDir, "checks.md");
    const before = readFileSync(checksPath, "utf8");
    // The exact path the pre-mktemp code used, unconditionally, every run.
    symlinkSync(checksPath, join(runnerTemp, "gradle-update-pretree.nul"));
    const out = runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml");
    assert.match(out, /OK/);
    assert.equal(readFileSync(checksPath, "utf8"), before, "checks.md was overwritten through a symlink at the old predictable scratch-file path");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// treestate()'s human-readable stdout return has one more sharp edge
// beyond the ones already covered: command substitution strips ALL
// trailing newlines, not just the single one `${out%$'\n'}` trims — so a
// path made ENTIRELY of newline characters (a legal Linux filename)
// collapses `$(treestate ...)`'s result to the empty string even though a
// real, non-exempt file exists. Verified directly:
// `f() { printf '%s' "$(printf '\n\n')"; }; x=$(f); echo ${#x}` prints 0.
// Codex found this on review of the earlier NUL-safety fix — the emptiness
// checks at both call sites now test the NUL-delimited list file's size
// (`-s`), which never crosses that boundary, instead of the string.
test("the emptiness check at both treestate() call sites tests the NUL list file, not the command-substitution string", () => {
  assert.match(
    workflow,
    /if \[ -s "\$pre_z" \] \|\| \[ -n "\$preplanted" \]; then/,
    "the pre-check gate must test -s \"$pre_z\", not -n \"$pre\"",
  );
  assert.match(
    workflow,
    /if \[ ! -s "\$treestate_list" \]; then/,
    "capture_and_restore's emptiness check must test ! -s \"$treestate_list\", not -z \"$changed\"",
  );
});

test("a file named entirely of newline characters is still caught, even though it collapses treestate()'s string return to empty", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-allnewline-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    // $'\n\n', not $(printf '\n\n'): the latter is itself command
    // substitution and would strip the very newlines this test needs to
    // plant — the same collapse this test exists to catch, one layer up.
    writeFileSync(join(repoDir, "\n\n"), "x");
    assert.throws(
      () => runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml"),
      /The checks changed the tree/,
      "an untracked file named entirely of newlines was not detected",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// A false pipefail trip found on review of the direct-pipe fix (first
// caught on the identical construct in mikelward/rust-update): the loop's
// per-record `[ "$keep" -eq 1 ] && var="$var$path"\n` used the LAST
// record's own test as the loop's own exit status once the git-status pipe
// made it part of a pipeline — an ALLOWLISTED record (keep=0, the common
// case: every normal run's own modified catalog and report files) makes
// that `[ ]` test false, so under `pipefail` the whole pipe — and the
// step, under `set -e` — would exit nonzero on every ordinary run, even
// with nothing actually wrong. Verified directly: `shopt -s lastpipe; set
// -eo pipefail; printf 'a\0' | while IFS= read -r -d '' e; do [ 0 -eq 1 ]
// && x=1; done; echo unreached` never reaches "unreached". Fixed with
// `if`/`fi` (always exits 0 when its condition is false), not
// `[ ... ] &&`.
test("a normal run with only allowlisted changes does not abort the pretree check", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-allowlisted-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    // The two ordinary things a real batch changes: the catalog itself,
    // and the report the earlier checks step already wrote.
    writeFileSync(join(repoDir, "gradle", "libs.versions.toml"), "y");
    writeFileSync(join(repoDir, "checks.md"), "y");
    const out = runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml");
    assert.match(out, /OK/, "a run with only allowlisted changes aborted instead of passing");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("--no-renames is present on every git status -z invocation", () => {
  const calls = [...workflow.matchAll(/git status --porcelain -z [^\n|]*\|/g)].map((m) => m[0]);
  assert.equal(calls.length, 6, `expected 6 git status -z invocations, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /--no-renames/, `git status -z call missing --no-renames: ${call}`);
  }
});

test("a staged rename onto an allowlisted destination doesn't hide the source path going missing", () => {
  // Without --no-renames, `git status --porcelain -z` on a staged rename
  // emits the destination as a normal "XY path" record and the SOURCE as a
  // bare path with no status prefix at all — `${entry:3}` strips the first
  // 3 bytes of every record uniformly, so on that second, prefix-less
  // field it eats 3 bytes of the real old path instead. Renaming
  // "XXXchecks.md" onto "checks.md" corrupts the old-path field into
  // "checks.md" too, landing it on the allowlist and hiding the rename
  // entirely. Found by Codex on mikelward/rust-update's identical
  // construct; ported here since gradle-update's untracked-files passes
  // share the same shape.
  const repoDir = mkdtempSync(join(tmpdir(), "gradle-update-rename-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "gradle-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const git = (...args) => execFileSync("git", args, { cwd: repoDir });
    writeFileSync(join(repoDir, "XXXchecks.md"), "some content long enough for git to treat this as a rename rather than an add+delete pair");
    git("add", "XXXchecks.md");
    git("commit", "-q", "-m", "add XXXchecks.md");
    git("mv", "-f", "XXXchecks.md", "checks.md");
    assert.throws(
      () => runPretreeBlock(repoDir, runnerTemp, "gradle/libs.versions.toml"),
      /The checks changed the tree/,
      "a staged rename was not detected — the source path (XXXchecks.md) went missing without --no-renames",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The three command loops and the publish-side verdict derivation. The
// update job runs unreviewed dependency code, so publish must never read a
// pass/fail or review-flag boolean that job reported about itself — it
// derives both from checks.md and review.md, whose bytes it first verified
// against fingerprints captured in the runner's control plane. Ported from
// the identical fix in mikelward/npm-update (see its AGENTS.md "Trust
// model"); rust-update carries the same pair of fixes.
// ---------------------------------------------------------------------------

test("every eval'd command loop redirects stdin away from its own herestring", () => {
  // The loops feed themselves through herestrings, and each eval'd command
  // used to inherit that herestring as its own stdin — so a command that
  // reads stdin (./gradlew's daemon client forwards and drains it) DRAINED
  // the remaining commands: the loop ended early, unrun checks never
  // reported (a false pass), unrun regenerate commands left stale derived
  // files committed, and a dropped flagging review command left auto-merge
  // armed. Three loops, three redirects.
  const redirected = [...workflow.matchAll(/eval "\$cmd" \) < \/dev\/null/g)];
  assert.equal(redirected.length, 3, `expected all 3 eval loops to redirect stdin, found ${redirected.length}`);
});

function extractChecksLoopBlock(text) {
  const startMarker = ": > checks.md";
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "checks-loop block start marker not found in gradle-update.yml");
  const endMarker = 'done <<< "$CHECKS"';
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, "checks-loop block end marker not found");
  const raw = text.slice(start, end + endMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

test("a check that drains stdin cannot swallow the commands after it", () => {
  // Verified against the exact loop structure before fixing: with the
  // redirect absent, this case records one ✅ line and ends with failed=0.
  const dir = mkdtempSync(join(tmpdir(), "gradle-update-checksloop-"));
  try {
    const script = [
      'cd "$1"',
      "CHECKS=$'cat > /dev/null\\nfalse'",
      "failed=0",
      extractChecksLoopBlock(workflow),
      'echo "failed=$failed"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script, "bash", dir], { encoding: "utf8" });
    const checksMd = readFileSync(join(dir, "checks.md"), "utf8");
    assert.equal(
      checksMd,
      "- ✅ `cat > /dev/null`\n- ❌ `false` (exit 1)\n",
      "the stdin-draining first check swallowed the second — it never ran or never reported",
    );
    assert.match(out, /failed=1/, "the failing second check did not set failed=1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the update job exports no verdict booleans; publish wires both from its own derivation", () => {
  assert.doesNotMatch(workflow, /passed: \$\{\{ steps\.checks\.outputs\.passed \}\}/);
  assert.doesNotMatch(workflow, /review_flagged: \$\{\{ steps\.review\.outputs\.flagged \}\}/);
  assert.doesNotMatch(workflow, /needs\.update\.outputs\.passed/);
  assert.doesNotMatch(workflow, /needs\.update\.outputs\.review_flagged/);
  assert.match(workflow, /checks_sha: \$\{\{ steps\.checks\.outputs\.checks_sha \}\}/);
  assert.match(workflow, /review_verdicts: \$\{\{ steps\.review\.outputs\.verdicts \}\}/);
  assert.match(workflow, /checks_sha=\$\(sha256sum -- checks\.md \| cut -d' ' -f1\)/);
  assert.match(workflow, /CHECKS_SHA: \$\{\{ needs\.update\.outputs\.checks_sha \}\}/);
  assert.match(workflow, /REVIEW_VERDICTS: \$\{\{ needs\.update\.outputs\.review_verdicts \}\}/);
  assert.match(
    workflow,
    /\[ "\$\(sha256sum -- checks\.md \| cut -d' ' -f1\)" = "\$CHECKS_SHA" \]/,
    "publish no longer verifies checks.md against the update job's fingerprint",
  );
  const passedWires = [...workflow.matchAll(/PASSED: \$\{\{ steps\.verdict\.outputs\.passed \}\}/g)];
  const flaggedWires = [...workflow.matchAll(/REVIEW_FLAGGED: \$\{\{ steps\.verdict\.outputs\.flagged \}\}/g)];
  assert.equal(passedWires.length, 2, "both consumer steps must read PASSED from the verdict step");
  assert.equal(flaggedWires.length, 2, "both consumer steps must read REVIEW_FLAGGED from the verdict step");
});

test("verdict lines ride the uncapped verdict-record output; review.md's copies stay budget-capped", () => {
  // Two constraints in tension, both real: the flag publish derives must
  // not depend on what the budget-capped report had room to print (a 🚩
  // capped out of review.md would read back as "nothing flagged"), and an
  // UNconditional review.md write would let a long configured command
  // list grow the PR body past GitHub's 65,536-character limit, failing
  // the body edit and hiding every report at once (Codex review, one
  // round each). So the verdict line is written to review.md only within
  // budget (omittedcmds folds the rest into the closing notice), while
  // EVERY verdict line lands in $RUNNER_TEMP/review-verdicts, which
  // crosses to publish as a step output — the control-plane channel the
  // fingerprints ride.
  const start = workflow.indexOf('line="- 🚩 \\`$cmd\\` (exit $rc) — human review requested"');
  assert.notEqual(start, -1, "the review verdict-line writer was not found");
  const tail = workflow.slice(start, start + 800);
  assert.match(tail, /if \[ "\$budget" -ge 0 \]; then\n\s*printf '%s\\n' "\$line" >> "\$REVIEW_TMP"\n\s*else\n\s*omittedcmds=\$\(\(omittedcmds \+ 1\)\)/);
  assert.match(tail, /printf '%s\\n' "\$line" >> "\$RUNNER_TEMP\/review-verdicts"/);
  assert.match(workflow, /verdicts<<REVIEW_VERDICTS_EOF/, "the verdict record must cross as a heredoc step output");
  assert.doesNotMatch(workflow, /review_sha/, "the review.md fingerprint is gone — the flag derives from the verdict-record output instead");
});

function extractVerdictBlock(text) {
  const startMarker = "declare -A expected_count recorded_count";
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "verdict block start marker not found in gradle-update.yml");
  const endMarker = 'echo "flagged=$flagged" >> "$GITHUB_OUTPUT"';
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, "verdict block end marker not found");
  const raw = text.slice(start, end + endMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

function runVerdictBlock({ checks, reviewChecks, checksMd, reviewVerdicts }) {
  const dir = mkdtempSync(join(tmpdir(), "gradle-update-verdict-"));
  try {
    writeFileSync(join(dir, "checks.md"), checksMd);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    const script = `cd "$1"\nset -euo pipefail\n${extractVerdictBlock(workflow)}\n`;
    execFileSync("bash", ["-c", script, "bash", dir], {
      encoding: "utf8",
      env: {
        ...process.env,
        CHECKS: checks,
        REVIEW_CHECKS: reviewChecks ?? "",
        REVIEW_VERDICTS: reviewVerdicts ?? "",
        GITHUB_OUTPUT: outputFile,
      },
    });
    return readFileSync(outputFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a configured check containing backticks still round-trips through the verdict", () => {
  // Codex review on the rust-update twin: a derivation that parses the
  // command back out of its backtick delimiters with [^`]+ refuses a
  // configured check that itself contains backticks (echo `date`, legal
  // shell) — failing a batch whose check genuinely passed. Lines are
  // matched against the expected renderings built from the trusted
  // config instead, which has no delimiter blind spot.
  const checks = "echo `date`";
  assert.match(
    runVerdictBlock({ checks, reviewChecks: "", checksMd: "- ✅ `echo `date``\n" }),
    /passed=true/,
  );
  assert.match(
    runVerdictBlock({ checks, reviewChecks: "", checksMd: "- ❌ `echo `date`` (exit 1)\n" }),
    /passed=false/,
  );
});

test("the derived verdicts pass a matching all-green checks.md and review.md", () => {
  const checks = "./gradlew test\n./gradlew lint";
  const green = "- ✅ `./gradlew test`\n- ✅ `./gradlew lint`\n";
  const out = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "- ✅ `./gradlew licensee`\n",
  });
  assert.match(out, /passed=true/);
  assert.match(out, /flagged=false/);

  // The record is one canonical line per configured command — review.md's
  // free-form diff content never reaches the derivation at all.

  // No review checks configured: no flag, whatever review.md holds.
  const noReview = runVerdictBlock({ checks, reviewChecks: "", checksMd: green });
  assert.match(noReview, /passed=true/);
  assert.match(noReview, /flagged=false/);
});

test("the derived check verdict fails closed on every malformed, mismatched, or failing checks.md", () => {
  const checks = "./gradlew test\n./gradlew lint";
  const cases = [
    ["- ✅ `./gradlew test`\n- ❌ `./gradlew lint` (exit 1)\n", "a ❌ line"],
    ["", "an empty checks.md"],
    ["- ✅ `./gradlew test`\n", "a missing check record"],
    ["- ✅ `./gradlew test`\n- ✅ `./gradlew test`\n", "a duplicated record standing in for a missing one"],
    ["- ✅ `./gradlew test`\n- ✅ `./gradlew lint`\n- ✅ `true`\n", "an unconfigured check"],
    ["- ✅ `./gradlew test`\n- ✅ `./gradlew lint`\nAll checks passed!\n", "a non-canonical line"],
  ];
  for (const [content, label] of cases) {
    const out = runVerdictBlock({ checks, reviewChecks: "", checksMd: content });
    assert.match(out, /passed=false/, `${label} did not fail closed`);
  }
});

test("the derived review flag flags on a 🚩 line and fails closed toward flagged on a mismatched report", () => {
  const checks = "./gradlew test";
  const green = "- ✅ `./gradlew test`\n";
  const flaggedOut = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "- 🚩 `./gradlew licensee` (exit 1) — human review requested\n",
  });
  assert.match(flaggedOut, /passed=true/);
  assert.match(flaggedOut, /flagged=true/);

  // A configured review command with no verdict line at all: a malformed
  // or forged report, and the safe reading is flagged.
  const missing = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "",
  });
  assert.match(missing, /flagged=true/);

  // The checks.md early-exit paths force the flag too — a report publish
  // could not validate must hold auto-merge, not arm it.
  const malformed = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: "garbage\n",
    reviewVerdicts: "- ✅ `./gradlew licensee`\n",
  });
  assert.match(malformed, /passed=false/);
  assert.match(malformed, /flagged=true/);
});

test("the verdict record fails closed on unknown lines and count mismatches", () => {
  // The record carries only canonical verdict lines (never diff content —
  // that stays in review.md, which the derivation no longer reads), so an
  // unknown line is refused outright, and a configured command recorded a
  // different number of times than configured flags — both toward
  // FLAGGED, the safe reading.
  const checks = "./gradlew test";
  const green = "- ✅ `./gradlew test`\n";
  const unknown = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "- ✅ `./gradlew licensee`\nnot a verdict line\n",
  });
  assert.match(unknown, /flagged=true/);

  const duplicated = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "- ✅ `./gradlew licensee`\n- ✅ `./gradlew licensee`\n",
  });
  assert.match(duplicated, /flagged=true/);

  // A doubled configured command legitimately records twice.
  const doubled = runVerdictBlock({
    checks,
    reviewChecks: "./gradlew licensee\n./gradlew licensee",
    checksMd: green,
    reviewVerdicts: "- ✅ `./gradlew licensee`\n- ✅ `./gradlew licensee`\n",
  });
  assert.match(doubled, /flagged=false/);
});

function extractPrefixTitleBlock(text) {
  const startMarker = 'prefix="$COMMIT_PREFIX"';
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "prefix/title block start marker not found in gradle-update.yml");
  const endMarker = "verdict='All checks passed in the job that produced this branch.'\n          fi";
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, "prefix/title block end marker not found");
  const raw = text.slice(start, end + endMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

function runPrefixTitleBlock({ commitPrefix, passed, reviewFlagged }) {
  const script = `set -euo pipefail\n${extractPrefixTitleBlock(workflow)}\nprintf '%s' "$title"\n`;
  return execFileSync("bash", ["-c", script, "bash"], {
    encoding: "utf8",
    env: {
      ...process.env,
      COMMIT_PREFIX: commitPrefix ?? "",
      PASSED: passed ?? "true",
      REVIEW_FLAGGED: reviewFlagged ?? "false",
      today: "2026-08-22",
    },
  });
}

test("an empty commit-prefix (the default) leaves the title bare, with no leading space", () => {
  // The batch commit ships to Play/Firebase release notes on the Android
  // repos, so it now defaults to no prefix at all — a leading space left
  // over from naively prepending "$COMMIT_PREFIX " would be a visible typo
  // on every "What's new" card and in every commit subject.
  assert.equal(runPrefixTitleBlock({ commitPrefix: "" }), "Update dependencies (2026-08-22)");
  assert.equal(
    runPrefixTitleBlock({ commitPrefix: "", passed: "false" }),
    "Update dependencies (2026-08-22) — CHECKS FAILING",
  );
  assert.equal(
    runPrefixTitleBlock({ commitPrefix: "", passed: "true", reviewFlagged: "true" }),
    "Update dependencies (2026-08-22) — NEEDS HUMAN REVIEW",
  );
});

test("a non-empty commit-prefix still ships with exactly one separating space", () => {
  // A consumer that opts back into a prefix (the Android repos' own
  // `internal:` category, or a bespoke one) gets the same single-space
  // join the hardcoded prefix used to produce — this is a config knob now,
  // not a change in what a supplied prefix looks like.
  assert.equal(runPrefixTitleBlock({ commitPrefix: "internal:" }), "internal: Update dependencies (2026-08-22)");
  assert.equal(
    runPrefixTitleBlock({ commitPrefix: "deps:", passed: "false" }),
    "deps: Update dependencies (2026-08-22) — CHECKS FAILING",
  );
});

test("both jobs read the same extra-repositories and no-cooldown-for inputs", () => {
  // The publish job re-derives the waiver and re-asks the repositories from
  // its own clean context. If the two jobs were ever wired to different
  // inputs, this one would reject exactly what the other produced — a
  // release inside the window, or a version from a repository it was never
  // told about. Fail-closed, so nothing unsafe ships, but the failure lands
  // on a batch whose PR body says every check passed, which is the kind of
  // contradiction nobody debugs quickly. Enforced here because a comment
  // saying "both jobs read the same inputs" cannot fail when it stops
  // being true.
  for (const input of ["extra-repositories", "no-cooldown-for"]) {
    const env = new RegExp(`\\\$\\{\\{ inputs\\.${input} \\}\\}`, "g");
    const uses = [...workflow.matchAll(env)];
    assert.equal(
      uses.length,
      2,
      `inputs.${input} must be read exactly twice — once per job — found ${uses.length}`,
    );
  }
  // And each script actually receives them, rather than the env var being
  // set and then never passed on.
  assert.match(
    workflow,
    /--extra-repositories "\$EXTRA_REPOSITORIES" \\\n\s*--no-cooldown-for "\$NO_COOLDOWN_FOR" \\/,
    "update-versions.mjs must receive both flags",
  );
  assert.match(
    workflow,
    /--extra-repositories "\$EXTRA_REPOSITORIES" \\\n\s*--no-cooldown-for "\$NO_COOLDOWN_FOR"$/m,
    "check-gradle-update.mjs must receive both flags",
  );
});
