# Running the weekly batch as a personal access token, not the default token

## The problem this solves

Same problem `docs/GITHUB_APP.md` solves — see that file for the full
explanation, confirmed live on `mikelward/mesh#531` (rust-update, this
workflow's sibling): a pull request opened with the default `GITHUB_TOKEN`
sits at `action_required` on every one of a consumer's own `on:
pull_request` workflows until a human clicks approve, because
`github-actions[bot]` isn't a repository collaborator. A personal access
token fixes it the same way a GitHub App installation does — the actor
becomes a real collaborator (your own account) — with a simpler one-time
setup at the cost of a broader-blast-radius credential and a weekly PR that
reads as authored by you rather than a distinct bot identity.

**This is the currently used path.** `docs/GITHUB_APP.md`'s narrower,
independently-revocable App installation is the better fit once a
repository takes external contributions — see this repository's `TODO.md`
for that reconsideration, not yet needed while every consumer is
single-owner.

## One-time setup, per consumer repository

1. **Create a fine-grained personal access token**
   (https://github.com/settings/personal-access-tokens/new):
   - **Repository access**: "Only select repositories" → pick exactly the
     repositories this token authors weekly PRs in, not "All repositories" —
     the same narrow-grant reasoning as the App's per-repo install.
   - **Permissions**: Repository permissions → Contents: Read and write,
     Pull requests: Read and write. Nothing else — matches
     `docs/GITHUB_APP.md`'s App exactly, so the two paths are interchangeable
     without touching the workflow's own permission use.
   - **Expiration**: pick the shortest option you're willing to renew on;
     GitHub does not offer a non-expiring fine-grained token. Renewing means
     generating a new token and updating the secret below in every
     repository it covers.
2. **Add one secret to each consumer repository's `gradle-update` environment**
   (Settings → Environments → `gradle-update` → Environment secrets; or, from
   mikelward/repo, `repo secrets --name GRADLE_UPDATE_PAT --env gradle-update
   --file token.txt OWNER/REPO...`, which creates the environment when it is
   missing): `GRADLE_UPDATE_PAT` — the token value. An environment secret, not a
   repository secret, on purpose: a repository secret passed to a reusable
   workflow reaches the runner of every job in it, the update job included,
   where plugin and dependency code runs with sudo, while an
   environment secret reaches only the job that declares the environment,
   and only the publish job does. A repository-level `GRADLE_UPDATE_PAT` left
   over from before is deleted once the environment one is set. Named per-hub, matching `docs/GITHUB_APP.md`'s convention,
   even though the same token value can cover a repository that also runs
   `rust-update`'s `RUST_UPDATE_PAT` — each consumer's secrets are
   independent (no account-wide secret store on a personal account), and a
   per-hub name keeps a consumer running both hubs from having to reason
   about which one a shared name belongs to.

## What the consumer's caller workflow passes

The publish job reads `GRADLE_UPDATE_PAT` from the `gradle-update` environment when the
caller passes `secrets: inherit` — the only way an environment secret can reach
a called workflow. A consumer opts in like this:

```yaml
jobs:
  update:
    uses: mikelward/gradle-update/.github/workflows/gradle-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    # `inherit`, not a `secrets:` block naming the token: an environment
    # secret reaches a called workflow no other way. zizmor flags this
    # (secrets-inherit); allow it for this file in .github/zizmor.yml, with
    # this reason. The older `secrets: token: ...` block still works but
    # delivers the token to every job's runner.
    secrets: inherit
    with:
      # ...existing inputs...
```

Optional on the reusable workflow's side, like the App pair: a consumer whose
environment holds none of them keeps today's `github.token` behavior and the
approval prompt on its first bot-opened pull request. If both `GRADLE_UPDATE_PAT` and
the `GRADLE_UPDATE_APP_*` pair are present, the token wins.

## What changes for you, once wired

Nothing about the weekly batch's shape. GitHub's UI shows your own account
as the actor once it holds the token, which is the one visible difference:
expect the PR author to read as you rather than `github-actions[bot]` after
the switch. Nothing else — commit author, PR body content, checks, and the
trust model in `README.md` are all unaffected; this only changes which
credential opens the pull request and pushes the branch.
