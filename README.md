<img src="assets/icon.svg" width="96" alt="Visto AI icon">

# Visto AI

An open-source, self-hosted AI reviewer for pull requests. It looks for the problems a careful reviewer would comment on, holds the ones that can block a merge to a defect it can demonstrate, and scores which parts of a change still need a human reviewer.

> **Status: early development.** The review engine and an offline evaluation tool are built. The service receives GitHub's webhooks, reads each pull request and runs the review. In dry run it records what it would have posted and posts nothing; out of dry run it posts a review when a pull request is opened and again when its head or base moves, unless the review would say nothing the newest one does not already say, and follows up the threads of its own earlier reviews. The first review, `/review`, a later review with its threads, an incremental review, a re-check, a push that tells nothing new and scores kept across reviews were each tried once against a real GitHub App, on a small private repository. Inline notes (off unless a repository switches them on) are built and were tried once the same way. The merge gate (a required check, off unless a repository switches it on) is built and was tried once against a real GitHub App, in part: not as a required check. A command that creates the app is built and was not tried against GitHub. Extension modules (code of your own that gives the reviewer a ticket's text and acceptance criteria, is told of published reviews and alerts, and answers feedback routes; none unless the config names one) are built and were tried once against a real GitHub App with the example module alone, with no real ticket system or chat tool. MCP tools (tools of servers you name, which the review model may call while it reviews; none unless the config names a server) are built, and were tried once under Docker against a small MCP server made for that run, and once with real models against the same small server; they were not tried with a real documentation server, nor in a review through the service against GitHub with servers named. Memory for the score (records of where people stepped in on earlier pull requests, told to later reviews as context; off unless switched on) is built; what it does to the score is not measured. Lessons from replies to findings (a sentence a model writes from a reply in which a person with access showed that a finding was wrong, shown to later reviews as data; off unless learning is switched on) are built; what they do to findings and to the score is not measured. Automatic approval and its withdrawal (a review posted as an approval when every condition holds, and dismissed when a new commit, a change of the base branch or a later review means it no longer holds; off unless a repository switches it on) are built, and so is its audit sample (a share of the pull requests it would approve, 5% unless the config says otherwise, sent to a person anyway), which was not tried against GitHub. See [Status](#status).

## Documentation

Code used to be written by people and reviewed by people. Now AI writes much of it, and people hand the review to AI as well. Nobody is left deciding which changes still need a person.

The pages are published at https://visto-ai.com/docs once the site is live. Until then, the links below go to the pages in [docs/guide](docs/guide).

### Start here

- [Introduction](docs/guide/index.md)
- [Quick start](docs/guide/quick-start.md)
- [Create the GitHub App](docs/guide/create-the-github-app.md)
- [Leave dry run](docs/guide/leave-dry-run.md)

### Concepts

- [The score](docs/guide/the-score.md)
- [How a review runs](docs/guide/how-a-review-runs.md)
- [Scores across reviews](docs/guide/scores-across-reviews.md)

### Features

- [Automatic approval](docs/guide/automatic-approval.md)
- [The merge gate](docs/guide/merge-gate.md)
- [Inline notes](docs/guide/inline-notes.md)
- [Memory](docs/guide/memory.md)
- [Lessons and reverts](docs/guide/lessons-and-reverts.md)
- [A second scorer](docs/guide/second-scorer.md)
- [The UI](docs/guide/the-ui.md)

### Extend

- [Extension modules](docs/guide/extension-modules.md)
- [The extension contract](docs/guide/extension-contract.md)
- [MCP tools](docs/guide/mcp-tools.md)

### Reference

- [Configuration](docs/guide/configuration.md)
- [.visto-ai.yml](docs/guide/visto-ai-yml.md)
- [Running the service](docs/guide/running-the-service.md)
- [Development](docs/guide/development.md)
- [Repository layout](docs/guide/repository-layout.md)

### Measure

- [Replay](docs/guide/replay.md)
- [Backtest](docs/guide/backtest.md)
- [Benchmark](docs/guide/benchmark.md)

The website is rebuilt from `main` when a release changes `docs/guide/`.

## Status

| Part | State |
|---|---|
| Skeleton: typed configuration, the review contract, a test harness that blocks the network, CI | Built |
| Engine: findings | Built. Compared with the predecessor on a frozen case set |
| Offline replay of past pull requests | Built and run |
| Engine: the score | Built. Measured only where its owner has run the backtest |
| Service: receiving webhooks and recording what people do on pull requests | Built |
| Service: a queue of review jobs, run in dry run and recorded | Built |
| Service: publishing a review, and `/review` | Built. Tried once against a real GitHub App |
| Service: reviewing a pull request again when its head or base moves, unless the review would say nothing the newest one does not already say, and following up the threads of its own earlier reviews | Built. Tried once against a real GitHub App |
| Service: incremental reviews of later heads, `/review` as a re-check, and scores kept across reviews | Built. Tried once against a real GitHub App |
| Service: inline notes on the blocks listed for a person (off unless switched on) | Built. Tried once against a real GitHub App |
| A command that creates the GitHub App from a manifest | Built. Not tried against GitHub |
| Merge gate: a required check, `/done`, a skip by one team, `shadow` and `bypass` (off unless switched on) | Built. Tried once against a real GitHub App, in part: not the skip by a team, `shadow`, `bypass` or the check as a required one |
| Extension modules: context for the reviewer with acceptance criteria, notices, alerts and feedback routes (none unless the config names one) | Built. Tried once against a real GitHub App with the example module alone: no real ticket system or chat tool |
| MCP tools: tools of servers you name, which the review model may call while it reviews (none unless the config names a server) | Built. Tried once under Docker against a small MCP server made for the run, and once with real models against that server: not with a real documentation server, nor through the service against GitHub with servers named |
| Memory for the score: records of where people stepped in, told to later reviews as context (off unless switched on) | Built. What it does to the score is not measured |
| Memory: lessons from replies to findings, shown to later reviews as data (off unless learning is switched on) | Built. What lessons do to findings and to the score is not measured |
| Memory: reverts, told to later reviews as context for the score (off unless learning is switched on) | Built. What it does to the score is not measured |
| Evals with lessons as of each case: the findings replay with memory, lessons in both evals, and what a lesson does to findings and to the score | Planned |
| Automatic approval and its withdrawal (off unless switched on) | Built. Tried in part against a real GitHub App on a private scratch repository, and under Docker (see "What was tried" under [Automatic approval](docs/guide/automatic-approval.md)): not an approval decided and posted by the service, a merge under a standing approval, GitHub's own deliveries, a pull request from a fork, or a branch name with a slash |
| Audit sample: a share of the pull requests automatic approval would approve, sent to a person anyway (5% unless the config says otherwise; 0 switches it off) | Built. Tried under Docker (the start and its key, not the draw's effect on a review); not tried against GitHub: no review on the scratch repository gets past `rule_unreadable` (see "What was tried" under [Automatic approval](docs/guide/automatic-approval.md)) |
| UI: sign-in by password or through the GitHub App, admins and viewers, Accounts in Settings, the Activity screen and the page of one review (off unless the config writes ui) | Built. Tried under Docker with a real Chromium and a real Postgres, against a stub of GitHub (see "What was tried" under [The UI](docs/guide/the-ui.md)); not tried against GitHub |
| UI: Settings, for admins: General, Model, Repositories (the defaults, each override, the merge gate and automatic approval), Secrets by variable name, Access, Changes and the saved settings as `config.yml` text; the settings live in the database once the service has started, kept in step with the config file at each start (the UI never writes the file) | Built. Tried in the tests, and in one run under Docker with a real Chromium and a real Postgres, against stubs of GitHub and the model (see "What was tried" under [The UI](docs/guide/the-ui.md)); not tried against GitHub |
| UI: the overview, repositories and memory | Planned |

What exists today is a library, a command-line tool, and a service that you can run with Docker. The service receives, queues, reviews and records. In dry run it posts nothing; out of dry run it posts a review when a pull request is opened and again when its head or base moves, unless the review would say nothing the newest one does not already say, and writes into the threads of its own earlier reviews. A repository can also switch on inline notes, one short comment in the diff for each block listed for a person, and the merge gate, a check that a repository can require in GitHub (see [The merge gate](docs/guide/merge-gate.md); it was tried against a real GitHub App in part, and never as a required check). With the gate off, the service holds no merge back. It approves a pull request only where a repository switches automatic approval on, and only when, as it posts the review, every file is reviewed, nothing is at or above the threshold, no major or blocker finding is open, the pull request is no draft and not from a fork, the base branch's own rules dismiss stale approvals, and the pull request is not drawn for the audit sample, a share of the pull requests it would approve that goes to a person anyway; a new commit withdraws the approval (see [Automatic approval](docs/guide/automatic-approval.md)). Otherwise the score is only listed for a person.

A deployment can also switch on memory for the score, which records where people stepped in on closed pull requests and tells later reviews of the repository where that was, as context for the score (see [Memory](docs/guide/memory.md)). What it does to the score is not measured: `eval:memory-count` tells you, at no cost, whether your own history has enough cases to measure it (see [Backtest](docs/guide/backtest.md)). With learning on, the service also judges, once in a UTC day, the replies people wrote under the reviewer's findings, with a model call for each, and a reply by a person with access that shows a finding was wrong may become a lesson, which later reviews of the repository are shown as data (see [Lessons](docs/guide/lessons-and-reverts.md#lessons)). What lessons do to findings and to the score is not measured: no eval shows a lesson yet. With learning on, a merged pull request whose description's first line is the line GitHub's revert button writes also has the files of the pull request it reverted recorded, and later reviews of the repository are told that a change to such a file was reverted, as context for the score (see [Reverts](docs/guide/lessons-and-reverts.md#reverts)). What that does to the score is not measured.

Memory was tried under Docker on a real Postgres: the migration over a previous release's database, the learning pass, a lookup, the kill switch and the seed command.

Lessons were tried under Docker on a real Postgres, with a small model endpoint made for the run in place of a real model: the migration over a previous release's database, a night's run of the judge, a lookup, the kill switch and the daily limit.

Reverts were tried under Docker on a real Postgres: the migration over a previous release's database, the number stored with learning off, the learning pass, a lookup, the kill switch and the seed command.

## Licence

[Apache-2.0](LICENSE). Copyright 2026 The Visto AI authors; see [NOTICE](NOTICE).
