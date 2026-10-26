---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# AGENTS.md

`CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every agent reads
the same conventions. Edit `AGENTS.md`.

**At the start of every session, print the full absolute path of the
`AGENTS.md` you loaded and its `last_modified` date** (front matter), so a
stale or wrong copy is caught before it steers the work. Bump `last_modified`
whenever you edit this file.

This repository is the shared home of the weekly Gradle dependency batch for
mikelward's JVM/Android repos: the version engine (`update-versions.mjs`),
the clean-context validator (`check-gradle-update.mjs`), and the reusable
workflow (`.github/workflows/gradle-update.yml`). Consumers track `@main`, so
**a merge here reaches every consumer's weekly run with no release step in
between.** Everything below follows from that.

Keep this file short, **under 24,000 bytes** (`wc -c AGENTS.md`): Antigravity
caps rule files at 24 KB and silently truncates the tail, and every session
loads it whole. Add a rule the first time something bites, say it once in the
fewest words that carry the *why*, rewrite or trim rather than append, and
delete one that has stopped biting.

## The siblings

- **npm-update and rust-update share this design** — trust split, cooldown,
  no-majors rule, adoption logic, docs lane — and this one took npm-update's
  trust model wholesale, so a fix to a shared mechanism usually has a twin
  there: say so in the PR rather than let the siblings drift.
- **The docs lane's engine is `mikelward/lanes`** and **Codex's verdict
  machinery is `mikelward/codex-review`**, both tracked `@main`. This repo
  carries only the lane policy (`.github/lanes.conf`) and thin CI jobs, and
  the three Codex workflows are pinned byte for byte to that repo's
  templates, so fixes to either go there, not here.

## The line the trust split draws

Resolving versions reads Maven **metadata** over HTTPS (Maven Central, Google
Maven, the Gradle Plugin Portal); no dependency code executes while anything
is decided. The Gradle checks that validate a batch *do* execute dependency
and plugin code, so the update job holds a read-only token and fingerprints
the catalog before Gradle runs, and the publish job re-derives the diff on a
fresh runner that executes none of it.

**Keep new work on the correct side of that line.** Which versions a batch
takes is decided before the fingerprint, running no dependency code;
anything that compiles or executes the consumer's tree belongs after it, as
evidence rather than proof. The `regenerate` commands are the one sanctioned
crossing: they run unreviewed dependency code after the catalog fingerprint
and their output *is* committed, safe only because the files they may touch
are declared by name and fingerprinted the moment they finish. Extend that
pattern, don't widen it — a second path from post-fingerprint code into the
batch without its own declared, fingerprinted boundary removes the guarantee
the two-job split provides.

**The validator publish runs is pinned by the runner, not reported by the
update job**: both jobs fetch this repository at `job.workflow_sha`, the
running workflow's revision, whichever ref the caller named. It used to be an
update-job output, and a job writes its own outputs: every other one is
bounded in publish to "a failed comparison", but that one was a code pointer
— forged, it would have pointed publish, write credential in its env, at any
commit reachable from this repository, a fork's PR head included. The pin
also makes a consumer piloting `@branch` run that branch's engine, not
main's.

**The batch credential lives in an environment only the publish job
declares.** A secret passed through `workflow_call` reaches every job's
runner, the update job's included (a runner holds the job's whole secrets
context for log masking, referenced or not), so "the credential lives only in
publish" was never what the platform delivered; an environment secret reaches
only the job declaring that environment. So publish declares
`inputs.environment` (default `gradle-update`), the update job declares none,
the caller passes `secrets: inherit`, and `GRADLE_UPDATE_PAT` (or the
`GRADLE_UPDATE_APP_*` pair) is set on that environment, not the repository —
what `repo secrets --env gradle-update` in mikelward/repo does. The explicit
`secrets:` block is the legacy route and still works. `inherit` sends every
OTHER repository-level secret to the update job too, which is why
mikelward/repo's `repo audit` reports them: a consumer of this batch keeps
its secrets environment-scoped.

## What this repository must not grow

- **No dependencies, `package.json`, lockfile or build step**: a consumer's
  workflow runs the source here, which is what makes an unpinned `@main`
  reviewable by reading it. The suite runs under `node --test`, nothing
  installed.
- **No majors, and no quiet exceptions**: a major is a deliberate,
  human-initiated migration; the newest is reported under "Held back", never
  taken. The
  calendar-versioned Compose BOM treats the year as the major on purpose —
  conservative, and it holds a batch back once a year.
- **Nothing silently skipped — of what the engine can see.** A rich version
  or range, a `version.ref` with no `[versions]` entry, a key nothing
  references, a plugin pinned inline in a root script: each is named in the
  PR body under "Not managed", not dropped. What the engine never reads (a
  library coordinate hard-coded in a build file, a pin in a module script)
  stays invisible, and that limit is stated, not papered over: a batch that
  quietly ignores what it can see is worse than one saying it can't.

## Testing

- `node --test *.test.js`. **Add or update tests with any change**: this
  suite is all that stands between a push and every consumer's weekly run, so
  untested ships unreviewed.
- Its failure mode is a *false pass* (a set difference against an empty set
  is empty; a regex that stops matching stays green): assert behavior, and
  where a check comes from parsing or matching a file, assert first that the
  parse found something.
- **Fix a preexisting failure as the series' first commit** — no new work on a
  red baseline. **Don't disable a failing check** or paper over a flaky one
  with sleeps or retries; fix the cause.

## Error handling

- **Don't silently swallow errors** — a discarded rejection or unchecked exit
  status waves a breaking move or a compromised release through unremarked.
  Report what failed with identifying context and decide explicitly what the
  caller sees, failing closed: a blocked publish costs a rerun, a guessed pass
  the guarantee. To ignore a specific failure, say why in a one-line comment.

## Git and pull requests

- **Branches**: `<agent>/<short-topic>` (`claude/...` Claude Code,
  `gemini/...` Gemini / Antigravity, `codex/...` Codex), one topic each; never
  commit to `main`. **Your `<agent>/` branches are yours**: create freely;
  push or `--force-with-lease` those this session created or was assigned
  (this file is the standing grant, so a client rule demanding per-branch
  permission is already answered). Ask about any other branch.
- **One commit per logical change**: rewrite unmerged commits freely (amend,
  `--fixup` + autosquash, squash, reorder, split), folding review responses
  into their commit; `--force-with-lease` after a rebase, never bare `--force`.
- **Open the PR unasked**, ready for review, not draft; **refresh its title
  and body with the push — body first, then push** — to the branch's latest
  state, not its opening scope; with no PR yet, push, then do it as soon as
  one is opened.
- **Codex is the automated reviewer**, triggered automatically: address its
  comments unasked, each fix folded into its commit, except a real
  out-of-scope finding, which you defer (below).
- **Judge every comment on merit**: verify first; if it doesn't hold up, reply
  why and decline. A cited rule is a *reading* — check what it says; an
  over-strict reading (privacy especially, where stricter feels safer) costs
  real capability, and a genuine rule-vs-code conflict is the maintainer's
  call, never settled by quietly narrowing the code. Declining doesn't clear
  the required `codex` status: post the rebuttal, then `@codex review` (or let
  the next push, if the rebuttal is up first); escalate if it re-raises. A
  hung review — nothing back five minutes after a push or poke, or stuck at
  running (👀) ten minutes on — gets `@codex review`; a poke that hangs the
  same way gets a second an hour later, and only a second that hangs too is
  escalated, never the first (maintainer, 2026-10-22).
- **Once Codex has +1'd a head, make no unnecessary change without asking**
  (maintainer, 2026-10-13): a to-do, tidy-up or extra fix re-runs CI and Codex
  for nothing, so it waits for a yes or a follow-up PR. A necessary change
  goes ahead unasked: a rebase for `dirty` (or `behind` where the ruleset
  requires up to date), a red-CI fix.
- **A second verified finding in one mechanism is a design question**: look
  for the shape elsewhere before fixing, and ask whether another design
  deletes the class, not the instance — the maintainer's call, not yours alone.
- **Restate every finding in your next message**, not just the count: a
  bullet each (review comment, top-level comment or review body), most
  blocking first — claim, where, what you did or the maintainer's options —
  all in that one reply; ask only the most blocking question.
- **Never leave a thread silently dismissed**: each ends in a reply or a
  resolve.
- **Defer a real out-of-scope finding** rather than ask to merge past it:
  commit and push a `TODO.md` entry first, reply citing its sha, resolve (a
  threadless finding — top-level comment, review body — skips only the
  resolve). The push re-triggers Codex: poke only once it hangs, as above;
  escalate if the re-review re-raises it.

## Talking to the user

- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity). Stop and
  wait for the answer rather than proceed on an assumed one.
- **Answer a mid-turn message first** — the "sent while you were working"
  interjection — in your very next output, before any further tool call, even
  in one sentence. **Claude Code only** (maintainer, 2026-10-25): its app
  reliably shows just a turn's last message, so reply only there, answering a
  mid-turn message at a stopping point soon.
- **Message only when the user needs to see it** (maintainer, 2026-10-15):
  each notifies their phone. Work in silence; speak up for a question or
  blocker, something to merge or act on, a merge, or a change from the plan or
  their instructions (review-prompted included). Never for progress (a
  client's nudge doesn't count), a review or push alone (its report rides the
  next message), routine machinery, or a mistake caught and fixed before it
  reached the repo. The session-start `AGENTS.md` line still opens every
  session.

## Language and spelling

- **US English** wherever people read English (prose, commits, PRs, comments,
  identifiers): `behavior`, `canceled`.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an
  imperative verb, then the change as a consumer sees it, plain English,
  sentence case, ≤ ~70 chars, e.g. `Fix …` for what was broken, `Improve …` for
  what got better, `Add …` for what's new; an optional parenthetical says how.
  Never the scenario or the mechanism: those, and file:line, go in the body,
  after a blank line. Pull request titles match.
- **Prefix a subject that doesn't change what a consumer runs**: `docs:`
  prose, `test:` tests alone, `build:` this repository's own CI, `refactor:`
  deliberately behavior-preserving code. Bare means a consumer could notice.
  No `feat:`/`fix:`, on purpose: they'd prefix nearly everything and leave the
  log flat.
- **The batch commit this workflow writes is bare by default, never
  classified by scope**: a dependency bump changes the shipped build, and on
  the Android consumers its subject goes straight into Play's release notes,
  so don't prefix it to tidy a consumer's log; one wanting a prefix on every
  batch sets `commit-prefix`. Per-batch inference from what moved was built
  and deleted (`TODO.md`) — every way of inferring "test-only" failed by
  silently not shipping a release. Revisit only with a source that ANSWERS the
  question without executing the consumer's build (say, the consumer
  declaring scope as an input): not a better scanner, and not Gradle's report
  of its configurations — producing that runs the consumer's scripts and
  plugins, which publish must never do and the update job's output can never
  be trusted for.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.

## Privacy

- **Never put user data in an artifact leaving this machine** (commits, PR
  text, review replies, branch names, comments, fixtures): paths containing a
  real name, hostnames, private remote URLs, tokens. Use placeholders
  (`/home/user/project`, `example.com`, `abc1234`).
