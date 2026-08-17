# TODO

## Decisions needing review

Autopilot guesses (2026-08-17), recorded so they get a human look:

- **The publish job now runs `check-versions-update.mjs --verify-upstream`**,
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
  v6.5.0) to match `dependency-update.yml`'s convention. Undoing is
  reverting to the tags.

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

## Review and merge gates

- [ ] Add `codex-review-check.yml` (mikelward/codex-review's consumer
      check): Codex reviews run here, but nothing verifies the workflow
      pin the ruleset should require.
- [ ] Verify the settings half of the fleet's bar: a ruleset on the
      default branch requiring the CI gate, the `codex` status,
      conversation resolution and up-to-date branches, and the auto-merge
      setting enabled.
