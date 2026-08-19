# Running the weekly batch as a GitHub App, not the default token

## The problem this solves

The publish job pushes the update branch and opens the pull request with
`github.token` — the repository's default `GITHUB_TOKEN`. GitHub does not
treat that identity (`github-actions[bot]`) as a collaborator, so the first
time it opens a pull request in a consumer, any workflow with an `on:
pull_request` trigger — a consumer's own CI included — gets queued and held
for manual approval before a single job runs, the same gate GitHub applies to
a first-time external contributor. Confirmed live on `mikelward/mesh#531`
(rust-update, this workflow's sibling): the `pull_request`-triggered run sat
at `action_required` with zero jobs started, while the SAME workflow,
dispatched separately by this job's `ci-workflow` input, ran and passed
normally on the same commit.

There is no workflow-file fix. The gate evaluates before any job or `if:`
condition is read, and `pull_request`'s `branches`/`branches-ignore` filters
match the PR's **base** branch — always the consumer's default branch here —
not its head, so the weekly batch's `deps/update-*` branches can't be
excluded that way either. The one lever is the actor: a GitHub App
installation with write access on the repository *is* a collaborator as far
as this gate is concerned, so a pull request it opens never trips it.

This is a deliberate grant, not a workaround: you install the App on exactly
the repositories you want it to act on, with exactly two permissions, and can
revoke it at any time from the App's settings — an explicit, auditable,
narrowly-scoped credential, not GitHub quietly remembering that a bot's first
run was clicked "approve" and trusting it forever after.

## One-time setup, per GitHub account or organization

The permissions this workflow's publish job needs are identical to
`rust-update`'s (Contents: Read and write, Pull requests: Read and write,
nothing else) — if that App is already registered and installed for
`rust-update`, the same App can simply be installed on this hub's consumer
repositories too rather than registering a second one; there is nothing
Gradle-specific about the grant. If it isn't set up yet, follow
[`rust-update`'s `docs/GITHUB_APP.md`](https://github.com/mikelward/rust-update/blob/main/docs/GITHUB_APP.md)
for the registration steps, then:

1. **Install the App** on each Gradle consumer repository (its settings page
   → Install App → pick the account → select repositories explicitly rather
   than "All repositories", so adding a new repository to the account never
   silently grants this App access to it).
2. **Add two secrets to each consumer repository** (Settings → Secrets and
   variables → Actions → New repository secret):
   - `GRADLE_UPDATE_APP_ID` — the App ID.
   - `GRADLE_UPDATE_APP_PRIVATE_KEY` — the full contents of the App's `.pem`
     private key file, unmodified (`-----BEGIN RSA PRIVATE KEY-----` line and
     all).

   Named `GRADLE_UPDATE_*` here even when it's the same App instance as
   `rust-update`'s: each consumer repository's secrets are independent (a
   personal GitHub account has no account-wide secret store the way an
   organization does), and naming them per-hub keeps a consumer that runs
   both `rust-update` and `gradle-update` from having to reason about which
   hub a shared secret name belongs to.

## What the consumer's caller workflow passes

`gradle-update.yml` accepts these as a `secrets:` block on `workflow_call`. A
consumer opts in by passing them through:

```yaml
jobs:
  update:
    uses: mikelward/gradle-update/.github/workflows/gradle-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    secrets:
      app-id: ${{ secrets.GRADLE_UPDATE_APP_ID }}
      app-private-key: ${{ secrets.GRADLE_UPDATE_APP_PRIVATE_KEY }}
    with:
      # ...existing inputs...
```

Both secrets are optional on the reusable workflow's side: a consumer that
sets neither keeps today's behavior (`github.token`, and the approval prompt
on its first bot-opened pull request each repository). Setting one without
the other is refused — a partial credential can mint no token at all, and
failing loudly beats silently falling back to a weaker one.

## What changes for you, once wired

Nothing about the weekly batch's shape. GitHub's UI shows the App's own name
as the actor once it holds the token, which is the one visible difference:
expect the PR author to read as this App's name rather than
`github-actions[bot]` after the switch. Nothing else — commit author, PR body
content, checks, and the trust model in `README.md` are all unaffected; this
only changes which credential opens the pull request and pushes the branch.
