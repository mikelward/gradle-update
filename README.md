# gradle-update

Weekly Gradle dependency batches for mikelward's JVM/Android repos, as a
reusable GitHub Actions workflow — the sibling of
[npm-update](https://github.com/mikelward/npm-update) for repos built on
Gradle version catalogs.

## What it does

Once a week (the consumer owns the cron), the workflow moves every entry in
`gradle/libs.versions.toml` to the newest **stable** release **within its
current major**, runs the consumer's own Gradle checks against the result,
and opens one batched pull request — assigned to the repo owner, with
auto-merge armed so a clean batch lands once the consumer's required checks
pass.

- **No majors.** A major is a deliberate, human-initiated migration. The
  newest major is *reported* in the PR body under "Held back", never taken.
  For calendar versions (the Compose BOM's `2026.05.01`), the year counts as
  the major — conservative on purpose, it holds the batch back once a year.
- **Release-age cooldown.** A release younger than `cooldown-days` (default
  5, matching npm-update's `min-release-age`) is skipped in favor of the
  next-newest eligible one, so a compromised release has time to be yanked
  before an unattended job takes it. Publish dates come from the
  `Last-Modified` header on each version's POM.
- **Shared version keys move together.** A key referenced by several
  libraries only moves to a version published for every one of them.
- **Stable only.** `alpha` / `beta` / `rc` / `M1` / `eap` / `dev` /
  `SNAPSHOT` and friends never enter a batch; stable *variants*
  (guava's `-android` / `-jre`) do.

What it deliberately does not manage: plugin versions pinned outside the
catalog (`id("…") version "…"` in a root build or settings script), rich
versions (`{ strictly = ... }`), ranges, and `[versions]` keys no library or
plugin references (a compiler version read from build files). All of those are
listed in the PR body under "Not managed" rather than silently skipped — the
out-of-catalog pins by reading the root scripts as text, scoped to the
interiors of `plugins { … }` blocks, which is where a plugin declaration lives.

**What stays invisible, because the engine never reads it:**

- A **library** coordinate hard-coded in a build file
  (`implementation("g:a:1.2.3")`).
- A pin in a module script that `--scan` was not pointed at — including the
  case where `settings.gradle[.kts]` renames the root build script via
  `rootProject.buildFileName`, since the default list names the conventional
  files and the reusable workflow does not forward a `--scan` input.
- A version applied by **resolution strategy** rather than declared —
  `pluginManagement { resolutionStrategy { eachPlugin { useVersion("1.2.3") } } }`.
  Gradle applies it with no `id … version` declaration anywhere, so nothing
  the scan looks for is present.
- A **Groovy-only spelling** of a declaration the scan does not model: a bare
  `id pluginId version "1.2"` whose id is not a literal (the parenthesized
  `id(pluginId)` form *is* read), or a `plugins({ … })` method-call block.
  Groovy's optional parentheses and command-expression syntax admit several
  spellings of the same declaration; modelling them one at a time is the
  enumeration this scan deliberately stopped doing, and every consumer today is
  a Kotlin (`.kts`) script.

Each of those is a real way to pin a plugin version this report will not
mention. None of the consumers uses any of them today; if one starts, the
honest fix is to teach the scan that shape deliberately rather than to widen
the pattern until it guesses.

**The transitive gap, honestly:** these repos keep no Gradle lockfile, so a
same-major direct bump can pull a new *transitive* major with nothing in the
catalog diff to show for it. npm-update walks the lockfile to catch that
shape; here the consumer's test suite and CI are the coverage. Read "no
majors" as guaranteed for what the catalog declares, best-effort beneath it.

## Trust model

Inherited from npm-update wholesale. Resolving versions
(`update-versions.mjs`) reads Maven **metadata** over HTTPS from Maven
Central, Google Maven, and the Gradle Plugin Portal — no dependency code
executes while anything is decided. The Gradle checks that validate the
batch *do* execute dependency and plugin code, so:

- the **update job** holds a read-only token, fingerprints the catalog
  before Gradle runs, truncates `$GITHUB_PATH`/`$GITHUB_ENV` afterwards, and
  verifies nothing outside the catalog changed — ignored paths included;
- the **publish job** runs on a fresh runner, executes no dependency code,
  re-validates the diff from a clean context (`check-gradle-update.mjs`:
  only in-place, in-major, stable, upward version bumps in `[versions]`
  pass), re-asks the repositories that every new version exists for every
  module sharing its key with a publish date outside the cooldown (the
  artifact and its fingerprint both originate on the machine that ran the
  batch's own Gradle code, so they alone cannot vouch for that), and is the
  only job that can write.

Read the PR body's check results as evidence, not proof — the catalog diff
is the part that is actually verified.

## Consuming it

A consumer keeps one small caller workflow, e.g.
`.github/workflows/gradle-update.yml`:

```yaml
name: Dependency update
on:
  schedule:
    - cron: '17 6 * * 6'   # Saturdays, off the congested top of the hour
  workflow_dispatch:
permissions: {}
concurrency:
  group: gradle-update
  cancel-in-progress: false
jobs:
  update:
    uses: mikelward/gradle-update/.github/workflows/gradle-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

The called workflow downscopes those permissions per job; the job that runs
Gradle only ever sees `contents: read`.

**A new consumer also needs a repository setting**, not just this caller
file: Settings → Actions → General → Workflow permissions → "Allow GitHub
Actions to create and approve pull requests." Without it, `gh pr create` in
the publish job fails with "GitHub Actions is not permitted to create or
approve pull requests" — `pull-requests: write` above scopes what the
*token* can do, but this setting is the separate, repo-level gate on
whether Actions may open pull requests at all, and it defaults to off.

Inputs (all optional): `catalog`, `cooldown-days`, `java-version`, `checks`
(commands one per line, default `./gradlew test` + `./gradlew lint`),
`review-checks` (commands one per line, default empty — see below),
`commit-prefix` (default empty — the batch commit is bare, like any other
release-worthy change, since a dependency bump does change the shipped
build and its subject ships straight to Play/Firebase release notes on the
Android repos), and `ci-workflow` (default
`android-ci.yml`) — a consumer workflow dispatched against the pushed
branch. A pull request opened under GITHUB_TOKEN's identity DOES trigger a
consumer's own `on: pull_request` workflows, same as any other, but GitHub
gates that run pending manual approval, since that identity is not a
repository collaborator; dispatch sidesteps the gate. It must carry
`workflow_dispatch` with a `pr` input on the consumer's default branch; set
it empty to disable.

An optional `token` secret lets a consumer supply a personal access token
instead of GITHUB_TOKEN — a real user account IS a collaborator, so the pull
requests it opens never hit the approval gate in the first place, and
`ci-workflow` becomes unnecessary. See [`docs/PAT.md`](docs/PAT.md) for the
one-time setup — the currently used path (see `TODO.md`). Two further
optional secrets, `app-id` and `app-private-key`, do the same via a GitHub
App installation instead; see [`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).
`token` takes priority if both are set. Providing `app-id` without
`app-private-key`, or vice versa, is refused: a partial credential mints no
token.

**Unattended landing needs the ruleset to require branches up to date**
(strict required status checks). The publish job verifies that policy
before arming auto-merge and falls back to a manual merge without it:
auto-merge can fire long after the run's own base-freshness check, and
the head-pinned arming closes only the arming-time race, not a later base
advance. The strict policy closes the rest — a moved base blocks the merge
until someone with write access updates the branch, and the merged tree
must then pass the required checks again — so the ruleset must require the
consumer's real CI for that revalidation to mean anything.

**`review-checks` flags a batch for a human** without failing it: any
command exiting nonzero titles the PR `— NEEDS HUMAN REVIEW`, reports the
outcome in a **Review** section, and leaves auto-merge unarmed, so the
batch waits for a person even when every check is green. The motivating
case is license metadata: a consumer whose CI regenerates a bundled-license
list and fails on drift can pass that same regenerate-and-diff command
here, and a batch that changes the license picture stops for review
instead of landing unattended. Review checks run in the same untrusted
window as the checks; tracked files they modify are diffed into the report
as the thing the human reviews, then restored — they observe, they never
publish.

## Depending on a repository you publish yourself

A consumer that publishes its own shared library — and depends on it as a real
Maven coordinate rather than a composite build — declares where to resolve it
and exempts it from the release-age cooldown:

```yaml
    with:
      extra-repositories: https://raw.githubusercontent.com/mikelward/androidlog/maven
      no-cooldown-for: com.mikelward.androidlog:logging-android
```

**`extra-repositories`** is *appended* to Maven Central, Google Maven and the
Gradle Plugin Portal, never replacing them — a consumer still needs those for
everything that is not its own. One URL per line, https only: an entry
reachable over plaintext is where an on-path attacker forges the metadata the
selection stands on. Declare the same repository in the consumer's own
`settings.gradle.kts` too, or the batch will select versions Gradle cannot
resolve. Worth saying plainly: an entry here is trusted for version
*selection* exactly as much as Maven Central is, and the publish job re-asks
that same host rather than an independent one.

**`no-cooldown-for`** names exact `group:artifact` coordinates, one per line.
The cooldown exists so a compromised **third-party** release has time to be
yanked before an unattended job takes it; against a release you cut yourself
an hour ago it guards nothing and only adds latency. A key is exempt only when
**every** coordinate it pins is declared, so a key shared between your own
artifact and a third-party one keeps the full window. A glob or a malformed
entry is refused rather than accepted as a literal that then matches nothing —
silently never matching looks identical to a working configuration. Waived
keys are named in the PR body under *Taken without the release-age cooldown*,
so a batch never skips the guard quietly.

Both inputs are read by **both** jobs. A divergence would make the publish job
reject exactly what the update job produced — fail-closed, but baffling to
whoever read the PR body — so they are driven from one input each.

One thing to get right on the publishing side: **start at `1.0.0`**. Majors are
what this tool refuses to cross, and it reads the major as the leading integer
— so at `0.x` every release you ever cut looks like the same major and is taken
automatically, including one that breaks the API. `0.x` is by convention the
phase where breaking changes are allowed, which is exactly where the guard
would stop working.

## Testing

```
node --test *.test.js
```

No install step: the engine and its suite are dependency-free on purpose, so
what runs inside a consumer's workflow is exactly what a reader reads here.
`workflow.test.js` covers the App-token and Codex-nudge shell logic inside
`gradle-update.yml` itself, the same regex-over-raw-text convention as
`zizmor.test.js`.
