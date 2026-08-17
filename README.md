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

What it deliberately does not manage: versions written outside the catalog
(a plugin version pinned in `settings.gradle.kts`), rich versions
(`{ strictly = ... }`), ranges, and `[versions]` keys no library or plugin
references (a compiler version read from build files). All of those are
listed in the PR body under "Not managed" rather than silently skipped.

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
  re-validates the diff from a clean context (`check-versions-update.mjs`:
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

Inputs (all optional): `catalog`, `cooldown-days`, `java-version`, `checks`
(commands one per line, default `./gradlew test` + `./gradlew lint`),
`review-checks` (commands one per line, default empty — see below),
`commit-prefix` (default `internal:`, the Android repos' release-notes
filter; the web repos use `deps:`), and `ci-workflow` (default
`android-ci.yml`) — the consumer workflow dispatched against the pushed
branch, needed because a PR opened by `GITHUB_TOKEN` triggers no
`on: pull_request` workflows. It must carry `workflow_dispatch` with a `pr`
input on the consumer's default branch; set it empty to disable.

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

## Testing

```
node --test update-versions.test.js check-versions-update.test.js
```

No install step: the engine and its suite are dependency-free on purpose, so
what runs inside a consumer's workflow is exactly what a reader reads here.
