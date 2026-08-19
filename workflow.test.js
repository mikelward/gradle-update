// Tests for shell logic inside .github/workflows/gradle-update.yml itself —
// this repository ships no YAML parser on purpose (see zizmor.test.js), so
// these are regex assertions over the raw file text, the same convention
// rust-update's workflow.test.js established for its sibling workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/gradle-update.yml", "utf8");

test("a half-supplied App credential is refused through env, never secrets, in its if:", () => {
  // The secrets context is unusable directly in a reusable workflow's own
  // if: conditions — referencing secrets.app-id here would silently break
  // the refusal, not just read wrong, so assert the env-based form is what
  // actually ships.
  const refuse = /if: \(env\.APP_ID == ''\) != \(env\.APP_PRIVATE_KEY == ''\)/;
  assert.match(workflow, refuse, "the half-credential refusal step's if: was not found reading env.APP_ID/env.APP_PRIVATE_KEY");
  assert.doesNotMatch(workflow, /if:\s*\(secrets\.app-id/, "the refusal step must not test secrets.app-id directly");
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

test("every GH_TOKEN in the publish job prefers the minted App token over github.token", () => {
  const ghTokenLines = [...workflow.matchAll(/GH_TOKEN: (\$\{\{[^\n]*\}\})/g)].map((m) => m[1]);
  assert.ok(ghTokenLines.length >= 3, "expected at least three GH_TOKEN assignments in the publish job");
  for (const line of ghTokenLines) {
    assert.match(line, /steps\.app-token\.outputs\.token \|\| github\.token/, `GH_TOKEN did not prefer the App token, found: ${line}`);
  }
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

test("the CI dispatch also overrides GH_TOKEN to github.token, never the App-preferring one", () => {
  // This branch runs precisely when an App token was minted but didn't
  // open the PR (app_opened_pr false with APP_TOKEN_USED true — an
  // adopted rerun of a pre-existing non-App PR), so the ambient $GH_TOKEN
  // can still be the App token here. `gh workflow run` is an Actions API
  // write the App's two permissions deliberately exclude, so it must not
  // run under the ambient token either.
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

test("app_opened_pr crosses the resolve/open-PR step split via the adopt output", () => {
  // The publish job is split across two steps purely for GitHub's 21,000-
  // character scalar-node cap (see the comment above "Resolve the branch,
  // then adopt or commit and push"). adopt is decided in the resolve step
  // but app_opened_pr — which needs it — is computed in the open-PR step,
  // so it has to travel as a step output like branch/title/verdict/
  // validated_head already do.
  assert.match(workflow, /echo "adopt<<\$delim"/, "the resolve step must emit adopt as a heredoc output");
  assert.match(workflow, /RESOLVED_ADOPT: \$\{\{ steps\.resolve\.outputs\.adopt \}\}/, "the open-PR step must read RESOLVED_ADOPT from steps.resolve.outputs.adopt");
  assert.match(workflow, /adopt="\$RESOLVED_ADOPT"/, "the open-PR step must assign adopt from $RESOLVED_ADOPT before deriving app_opened_pr");
});

test("the CI dispatch and its PR-body claim key off app_opened_pr, not the raw APP_TOKEN_USED flag", () => {
  assert.match(
    workflow,
    /if \[ "\$app_opened_pr" != 'true' \] && \[ -n "\$CI_WORKFLOW" \]; then/,
    "the dispatch-skip condition was not found keyed on app_opened_pr",
  );
  assert.match(
    workflow,
    /if \[ "\$app_opened_pr" = 'true' \]; then/,
    "the PR-body message-selection branch was not found keyed on app_opened_pr",
  );

  // app_opened_pr must require THIS run to have put the App's identity on
  // the wire (a fresh push in the resolve step, or a fresh `gh pr create`
  // here) — an adopted rerun that reuses an existing PR proves nothing
  // about who opened it, so APP_TOKEN_USED alone (this invocation merely
  // minted a token) must not be sufficient on its own.
  assert.match(
    workflow,
    /if \[ "\$APP_TOKEN_USED" = 'true' \] && \{ \[ "\$adopt" != true \] \|\| \[ "\$pr_opened_here" = true \]; \}; then/,
    "app_opened_pr's derivation must require adopt != true or pr_opened_here, not APP_TOKEN_USED by itself",
  );
});

test("an App-opened PR gets an explicit @codex review nudge, retried like the body edit", () => {
  // mesh#533, the first PR rust-update's copy of this workflow opened
  // under the App's identity, got no automatic Codex review — the
  // connector's webhook trigger apparently doesn't fire the same way it
  // does for a human or GITHUB_TOKEN-authored PR. Gated on app_opened_pr,
  // not unconditional: there's no evidence of the gap for the non-App
  // path, and nudging every PR would just be noise. Retried: a rerun of a
  // failed attempt doesn't get a second chance at this block (a later
  // rerun adopts the existing PR, and app_opened_pr goes false with it),
  // so a transient gh pr comment failure without a retry here would strand
  // the PR with no automatic recovery path.
  const nudge = /if \[ "\$app_opened_pr" = 'true' \]; then\s*\n\s*nudged=false\s*\n\s*for _ in 1 2 3; do\s*\n\s*if gh pr comment "\$pr" --body '@codex review'; then/;
  assert.match(workflow, nudge, "the retried @codex review nudge, gated on app_opened_pr, was not found");
});
