# TODO

## This repository

- [ ] **Finish the gate → lanes check rename** (mikelward/lanes#9, same
      staged procedure npm-update is mid-way through). The `lanes` job now
      runs alongside `gate` (both green here), but two steps remain,
      outside what a session without ruleset API access can do: flip the
      ruleset to require `lanes` instead of `gate`, then delete the
      now-redundant `gate` job and its parity test
      (`workflow-check-rename.test.js`) in a follow-up PR.

## Reconsider later

- **`docs/PAT.md`'s personal access token is the currently used path for
  authoring the weekly PR, not `docs/GITHUB_APP.md`'s GitHub App** (repo
  owner decision, 2026-08-19): simpler one-time setup while every consumer
  is single-owner, at the cost of a broader-blast-radius credential tied to
  a real user account rather than the App's narrower, independently
  revocable, per-repo installation. **Switch back once a consumer repository
  takes external contributions** — a PAT's blast radius matters more once
  people other than the owner have any access to the repository or its
  Actions logs. Reversible without a workflow change: both paths are
  already wired into `gradle-update.yml` (`token` takes priority over
  `app-id`/`app-private-key` if both are set), so reverting is re-pointing a
  consumer's `secrets:` block, not touching the reusable workflow.

## Decisions needing review

Autopilot guesses (2026-08-17), recorded so they get a human look:

- **The publish job now runs `check-gradle-update.mjs --verify-upstream`**,
  re-asking the repositories that each new version exists (for every module
  sharing its key) outside the cooldown. Rationale: the artifact and its
  fingerprint originate on the runner that executed the batch's Gradle code,
  so compromised within-major code could forge a matching pair naming an
  hours-old release. Cost: the publish job now needs the repositories
  reachable, and a repository outage blocks a publish until rerun (fail
  closed). Undoing it is dropping the flag from the workflow.
- **Timeouts**: `update` 90 min, `publish` 15 min, CI `test` 10 min — chosen
  by rough headroom over expected runtimes, not measurement. A consumer whose
  Gradle checks legitimately exceed 90 minutes needs the number raised.
- **`ci.yml` actions are now SHA-pinned** (checkout v5.0.1, setup-node
  v6.5.0) to match `gradle-update.yml`'s convention. Undoing is
  reverting to the tags.
- **`docs/GITHUB_APP.md` recommends reusing `rust-update`'s App instance**
  rather than registering a separate one for this hub (2026-08-19): the
  permissions are byte-identical (Contents RW + Pull requests RW), so
  there's nothing Gradle-specific to isolate by splitting them, and one
  fewer private key to generate and store. Consumer secrets are still named
  per-hub (`GRADLE_UPDATE_APP_ID` / `GRADLE_UPDATE_APP_PRIVATE_KEY`) so this
  is reversible without a doc rewrite — a later separate App is just a new
  registration plus re-pointing those two secrets, not a workflow change.

## Alternatives considered and parked

The engine is dependency-free JavaScript with a hand-rolled TOML-subset
parser. That was a choice among real alternatives, made 2026-08-17; the
options are recorded here so revisiting one starts from the trade-offs
rather than re-deriving them. Any alternative has to preserve the trust
split (see the workflow header and README): the code that DECIDES updates
must execute no dependency, plugin, or build-script code, and must be
readable in this repo as exactly what runs.

### Language: port the engine to Java

Parked, not rejected. The clean shape is plain Java through the JDK's
source launcher (`java UpdateVersions.java`): no build step, no jar, no
dependencies, and consumers' runners already have a JDK because the Gradle
checks need one — every property of the JS version survives. Kotlin is the
weaker fit: runners do not ship `kotlinc`, so it means a compiler download
per run or a checked-in binary jar nobody can review.

What a port costs, in order of weight:

- A rewrite restarts the review clock. The JS implementation was hardened
  by thirteen Codex review rounds; a fresh port is fresh surface, and most
  of those findings (the TOML shapes, variant/cooldown semantics) need
  re-proving. The test suite ports as specs, which helps.
- The JDK has no test framework. Either a small hand-rolled assert harness
  or JUnit — and JUnit drags a build tool into a repo whose identity is
  "no build step".
- Java's stdlib has no TOML parser either, so the parser question does not
  improve by default (see below for the one thing Java uniquely unlocks).
- It breaks symmetry with npm-update, which shares this design in JS.

### Parsing: alternatives to the hand-rolled TOML subset

The parser is ~150 lines covering every shape Gradle documents for
catalogs, fuzzed by review; misses fail toward "reported as unmanaged" or
a fail-closed validation, never a wrong update. Alternatives if it keeps
costing maintenance:

- **Vendor a TOML 1.0 parser** (e.g. smol-toml, MIT, no deps of its own)
  as a checked-in file, for READING only. Kills the parse-fidelity class
  of findings. Costs: ~1,500 lines of third-party code in a repo built
  around "read what runs", and it does not solve WRITING — the
  format-preserving rewrite (change one version string, keep comments,
  quoting, and order byte-identical) is not something parse→serialize
  round-trips give, so the targeted writer stays hand-rolled regardless.
- **Gradle's own `TomlCatalogFileParser`**, invoked from a
  checksum-pinned Gradle distribution rather than the consumer's build —
  no consumer code executes, and it is the authoritative parse by
  definition. Only reachable from a JVM language, so it pairs with the
  Java port above. Costs: internal Gradle API (unstable across versions),
  a ~130 MB pinned distribution download (cacheable), and JVM boot per
  run.
- **Running the consumer's Gradle to parse** (init script or the
  ben-manes versions plugin) is REJECTED, not parked: evaluating
  `settings.gradle.kts` and resolving plugins executes exactly the
  unreviewed code the trust split exists to keep out of the deciding
  phase.

## Known gaps

- **The App-token support is wired hub-side only** (2026-08-19); no consumer
  repository passes `secrets: app-id/app-private-key` yet, so every one
  still hits the first-time-contributor approval gate on its own `on:
  pull_request` workflows via `ci-workflow`'s dispatch fallback. Follows
  `rust-update`'s `docs/GITHUB_APP.md` setup once a consumer opts in — see
  that document here, adapted for this hub's secret names.
- **The strict-policy probe deliberately stays on `github.token`, never the
  App token**, even when one is minted — added alongside the App-token
  support, so this is a design choice, not a leftover: `GET
  rules/branches/{branch}` isn't covered by the App's two documented
  permissions (Contents + pull requests), and `rust-update` has no analogous
  probe to have already answered whether adding a third (Administration:
  read) would even be safe to ask for. Revisit if the App's grant ever
  changes.
- **Transitive majors.** No Gradle lockfile in the consumer repos, so a
  same-major direct bump can pull a transitive major with nothing in the
  catalog diff. npm-update's lockfile walker has no analog here yet; the
  consumer's test suite and dispatched CI are the coverage. A possible
  closer: diff `./gradlew dependencies` output before/after in the update
  job — it runs in the untrusted phase anyway, so it costs no new trust,
  only wall-clock.
- **Versions outside the catalog** (a plugin version pinned in
  `settings.gradle.kts`, compiler versions read from build files) are
  reported as unmanaged, never updated. Managing them means parsing
  Kotlin script, which is out of scope on purpose.
- **`regenerate` runs after `checks`, not before.** A regenerate command
  that rewrites something the checks exercise (generated source a test
  imports, say — not the license-inventory-style derived file the input
  is meant for) means `checks.md`'s `passed` verdict, and the PR title
  and verdict text built from it, describe the PRE-regeneration tree, not
  the one actually committed. The real safety property survives this: the
  dispatched `ci-workflow` run and the ruleset's required checks (see the
  gate above) test the ACTUAL pushed branch, post-regeneration, so
  auto-merge still waits on real coverage of what's committed — but only
  once that ruleset requirement is actually in place, which is the same
  unverified prerequisite the gate item above already tracks. Independent
  of that, the body's own "All checks passed" text is misleading for this
  specific case regardless of the ruleset. Closing it means a genuine
  trade-off a human should pick: reorder `regenerate` before `checks`
  (touches the fingerprint-ordering assumptions the tree checks and
  reports_sha_before rely on throughout the update job, and the
  pre-regenerate dirty-tree check would need to guard a different set of
  earlier steps instead), or re-run `checks` again after `regenerate` and
  AND the two verdicts together (correct, but doubles check wall-clock
  for every consumer using `regenerate`, and needs `PASSED` rewired
  everywhere it's currently read from the single `checks` step). Neither
  is a small change to make unreviewed in the same pass that introduced
  `regenerate`.

## Review and merge gates

- [ ] **Decide whether to pin `actions/create-github-app-token` by SHA**,
      matching every other third-party action in `gradle-update.yml`
      (`actions/checkout`, `actions/download-artifact`). Left on `@v2` for
      now, mirroring `rust-update`'s same open decision — the repo owner is
      undecided. Worth weighing seriously rather than deferred by default:
      this is the one action in the file that handles a private key and
      mints a write-scoped token, arguably the most sensitive thing here to
      leave unpinned.
- [x] Add `codex-review-check.yml` (mikelward/codex-review's consumer
      check): Codex reviews run here, but nothing verifies the workflow
      pin the ruleset should require.
- [ ] Verify the settings half of the fleet's bar: a ruleset on the
      default branch requiring the CI gate, the `codex` status,
      conversation resolution and up-to-date branches, and the auto-merge
      setting enabled.
- [ ] `update-versions.mjs` / `update-versions.test.js` still carry the
      pre-rename generic name — `check-gradle-update.mjs` and its test file
      already moved to the repo's `check-<name>-update.mjs` scheme (#12),
      and the scratch checkout directory followed (`.jvm-update` →
      `.gradle-update`), but the resolver script didn't. Decide whether it
      becomes `update-gradle.mjs` (or similar) for consistency, or is
      deliberately exempt because it's the engine rather than a checker.
