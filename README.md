<img src="assets/icon.svg" width="96" alt="Visto AI icon">

# Visto AI

An open-source, self-hosted AI reviewer for pull requests. It looks for defects it can demonstrate, and it scores which parts of a change still need a human reviewer.

> **Status: early development.** The review engine and an offline evaluation tool are built. The service receives GitHub's webhooks, reads each pull request and runs the review in dry run: it records what it would have posted and posts nothing, so Visto AI cannot yet review a live pull request. See [Status](#status).

## Why

Code used to be written by people and reviewed by people. Now AI writes much of it, and people hand the review to AI as well. Nobody is left deciding which changes still need a person.

Visto AI reviews a pull request and answers two questions:

1. **What is wrong with this change?** Findings the reviewer can demonstrate, each with a concrete failure scenario. No style comments.
2. **Which parts of the change need a human reviewer, and why?** Every changed block of code gets a score from 0% to 100%. Blocks at or above a threshold (70% by default) are listed for a person, with the lines to read. If nothing reaches the threshold, and the team has switched this on, the bot approves the pull request.

The aim is to reduce what people must review, and to be able to show the numbers that justify it.

## The score

The score measures how much a change needs a person's judgement. It does not measure how likely the change is to contain a bug: findings cover bugs.

| Score | Meaning | Examples |
|---|---|---|
| 0% to 19% | No judgement involved | Generated files, formatting, documentation text |
| 20% to 39% | Mechanical | A rename, new tests that mirror existing behaviour |
| 40% to 69% | A local behaviour change that follows an existing pattern | A bug fix inside one function |
| 70% to 89% | A decision | A changed business rule, data model, public contract or permission check. A new dependency. A weakened test |
| 90% to 100% | A decision that is costly to get wrong | Authentication, tenant isolation, an irreversible data migration, billing |

The scored unit is a block: one hunk of the diff. A file with ten changes, of which one is a decision, sends a person to that one change and not to the whole file.

## What it is designed to do

- **Evidence-backed findings**, tagged `[blocker]`, `[major]` or `[minor]`.
- **A human-review score** for every changed block, with a reason for each block that needs a person.
- **Optional automatic approval**, per repository, off by default.
- **Optional merge gate**: a required check that blocks a merge while a major or blocker finding is unanswered.
- **Learning by retrieval**: what people do on pull requests is stored and retrieved into later reviews. The model is never fine-tuned.
- **Self-hosted**: `docker compose up` on one machine, with the app and Postgres. You create your own GitHub App and connect it. The project runs no hosted service.
- **Your choice of model**: built and tested against [OpenRouter](https://openrouter.ai) first. Any OpenAI-compatible endpoint can be configured.
- **Measured before trusted**: findings and scores can be replayed offline against past pull requests, with no side effects.

The full design, with every decision and its reason, is in [docs/superpowers/specs/2026-11-13-visto-ai-design.md](docs/superpowers/specs/2026-11-13-visto-ai-design.md).

## Status

| Part | State |
|---|---|
| Skeleton: typed configuration, the review contract, a test harness that blocks the network, CI | Built |
| Engine: findings | Built. Compared with the predecessor on a frozen case set |
| Offline replay of past pull requests | Built and run |
| Engine: the score | Built. Measured only where its owner has run the backtest |
| Service: receiving webhooks and recording what people do on pull requests | Built |
| Service: a queue of review jobs, run in dry run and recorded | Built |
| Service: publishing a review to GitHub, and commands | Planned |
| Merge gate | Planned |
| Extensions and MCP tools | Planned |
| Memory | Planned |
| Automatic approval | Planned |
| UI | Planned |

What exists today is a library, a command-line tool, and a service that you can run with Docker. The service receives, queues, reviews in dry run and records, and posts nothing.

## How the engine works

The engine is one function, `review(input, deps)`. It reads a pull request and returns a structured review. It writes nowhere: not to GitHub, not to a database. That is what lets the evaluation call it directly.

1. **Read.** The pull request, its changed files and their contents come through a read-only source. The GitHub source only ever sends `GET` requests.
2. **Build context.** The model gets the diff with an anchor on every line (`R142    |+code`), the full contents of changed files where they fit, and the test file that belongs to a changed file. A large pull request is split into batches, up to a limit; what does not fit is reported as not reviewed.
3. **Mark untrusted text.** Everything that comes from the pull request is wrapped in data markers with a random token. The contract tells the model that text inside the markers is data, never instructions.
4. **Ask the model.** The model must answer through one forced tool call, `submit_review`, so the answer is structured data and not prose. The rules it follows are in [contract/review-contract.md](contract/review-contract.md).
5. **Check the answer.** An answer that names no changed file is sent back once, and then rejected. A finding on a file that is not in the pull request is dropped. A finding on a line that cannot take a comment is moved to the nearest line that can, within three lines, or listed separately.
6. **Render.** The service builds the review text from the structured result. The layout, the severity tags and the lists are the service's. The model supplies the overview, the text of each finding, and a score for each changed block, which the service checks before it counts: a score that is not a whole number from 0 to 100 leaves its block counted as 100.

## Development

Requires Node 26 or later. TypeScript files run directly; there is no build step.

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

Tests never reach the network. The test setup blocks sockets and `fetch`, and clears credential variables, so a test that tries to reach GitHub or a model fails.

## Run the service

The service receives GitHub's signed webhooks and records each delivery's id and what it says about people and the pull request (the payload itself is not kept). When a pull request is opened, reopened, made ready for review, pushed to or given a new base branch, it queues a review. A push is reviewed after 180 quiet seconds, so several pushes in a row give one review. The review runs the engine on the pull request as GitHub has it then, in dry run: it is recorded in the database and **nothing is posted to GitHub**. Publishing, commands and the merge gate are not built, so the service starts only with `dryRun: true` in the config.

To run it you need a GitHub App (its id, its private key and its webhook secret), a model key and a Postgres.

What the app needs for a dry run, from what the service calls: read access to pull requests and to contents (and to metadata, which GitHub always asks for), and the events `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` and `pull_request_review_thread`. It reads pull requests and the files of the repository; it writes nothing. This has not yet been tried against a real app. With too little access every read is refused, and every job ends `attempts_exhausted` (or `not_found`, if GitHub answers the pull request itself with 404).

```bash
cp env.example .env                       # then write your own passwords, secret and keys
cp config.example.yml config.local.yml    # then switch on the app and database blocks and write dryRun: true
docker compose up -d --build --wait
```

To try it with invented webhooks, load `.env` and send a sample (it posts only to this machine):

```bash
set -a && . ./.env && set +a
npm run dev:send-webhook -- --url http://localhost:8080/webhooks/github --secret-env WEBHOOK_SECRET --kind review
```

The kinds are `pull_request`, `review` and `comment`. For the `pull_request` kind, `--action opened|synchronize` (default `opened`) and `--head <sha>` (default `abc123`) choose the action and the head commit, so two pushes can be sent with two heads. The other kinds refuse these options. Stop it with `docker compose down`.

### Reading what a review would have posted

Every attempt at a review, finished or failed, is a row of `visto_ai.review_runs`:

```bash
docker compose exec db psql -U postgres -d visto -c "select id, owner, repo, number, outcome, cost, body from visto_ai.review_runs order by id desc limit 5"
```

`body` is the text that would have been posted, `outcome` how the run ended and `cost` what the model calls cost, as recorded (see the daily limit below).

### Running it

- Run one instance per database. A second one stops at once with `another_instance_running`, and the first keeps running.
- If the database restarts, the service notices that it has lost its lock, exits, and Compose starts it again.
- Connect to Postgres directly. The lock and the statement timeout do not work through a pooler in transaction mode.
- Stopping the service (`docker compose stop`) waits up to 10 minutes for the reviews that are running. The Compose file allows 660 seconds for it. A second signal ends it at once.
- Every review costs money. The cost of a run is what the model endpoint reports with each answer; OpenRouter, the default, reports it in US dollars. For an endpoint that reports no cost, it is computed from `model.prices`, in whatever currency those prices are written in. With neither, the cost is recorded as 0.
- The daily limit, `limits.spendPerDay` (50 when not written), is a number in the unit of those recorded costs. The service adds up the cost of the runs recorded since the start of the UTC day, so it can only see what is recorded: with an endpoint that reports no cost and no `prices`, it never stops anything, and it raises the alert `cost_unknown`. At 80% of the limit it raises `spend_80`, and at the limit `spend_limit`. Reviews then stop starting until the next UTC day; the ones already running finish. These three alerts are raised once per run of the service, so a restart can raise them again; `spend_80` and `spend_limit` are also raised once per UTC day. At most `limits.queueConcurrency` reviews run at once (2 when not written).
- When the model's key is refused or its account is out of credit, reviews pause for 5 minutes at a time and the service raises one alert, `model_error`, and `model_ok` when the key works again. The jobs wait, but not for ever: a job that has waited 24 hours is dropped as `too_old`. A review refused after it had already made model calls uses up one of the job's three starts. Alerts go to the log always, and to `alerts.webhook` when you wrote it.
- A job ends without a review when its three starts are used up (`attempts_exhausted`), when it is a day old (`too_old`), or when the pull request has changed by the time it runs: closed, turned into a draft, gone, given a new head (the new head gets a job of its own), or already reviewed at that head and base.
- When GitHub cannot be reached, or refuses a read, before any model call, the run is recorded as failed and the job is tried again a minute later, and then 15 minutes after that: three starts in all.
- A restart of the database, like any restart of the service in the middle of a review, cuts the reviews that are running. They run again afterwards while they have starts left, and their model calls are paid for again.

Setup notes:

- A database password that contains any of `@ : / # ?` must be percent-encoded in the database URL.
- If you change `server.port` in the config, change the port mapping and the health check in the Compose file too.

What to know before you expose it:

- The service holds a request's body in memory before it can check the signature: at most 25 MB for each of at most 20 requests at once. That is about 500 MB while bodies arrive, and about twice that at the moment a body is joined into one piece.
- A caller that sends slowly can hold one of the 20 places for up to about a minute. Twenty such callers, none of whom needs the secret, take every place, and real deliveries are answered `503 busy` meanwhile.
- The Compose file publishes port 8080 on every interface of the host. TLS, and any limit on connections or body size per caller, belong to the proxy in front. Firewall the port, or publish it only where the proxy can reach it.

## Configuration

[config.example.yml](config.example.yml) documents every key. Copy it to `config.local.yml`, which git ignores. A secret is never written in the file; the file names the environment variable that holds it.

### A second scorer (optional)

By default the review model also scores the changed blocks. You can name a separate decision model to score them instead. It is off unless you write the `scorer` block. The scorer answers for blocks only: a file moved to another directory with no content change keeps the review model's score. [config.example.yml](config.example.yml) shows the keys, with a placeholder model name.

The adapter speaks the decisions endpoint of OpenRouter and was built against the Jev decision model.

- The reviewed code is then also sent to that provider.
- The review model is then not asked for block scores: it gets [contract/review-contract-scorer.md](contract/review-contract-scorer.md) in place of the review contract.
- The endpoint is marked alpha by its provider.
- The score threshold must be written, and you should choose it from a backtest.
- A file the scorer fails on goes to a person.
- The scorer's cost counts towards `--max-cost` only when its provider reports a cost with each answer.

`backtest` records which scorer was used, and `score-noise` refuses to compare two runs made with different scorers.

## Replay

The replay runs past pull requests through the engine and scores its findings against what human reviewers said on those pull requests. It reads from GitHub and calls the model. It posts nothing.

It makes paid model calls. It runs at most `--max-cases` cases (60 by default) and starts no new case once the cost reaches `--max-cost` (10 by default). The cost is the one the provider reports, as OpenRouter does, or else it is computed from the prices in your configuration. With neither, the cost counts as zero and `--max-cost` stops nothing.

```bash
export GITHUB_TOKEN=...        # a read-only token
export OPENROUTER_API_KEY=...  # or the variable your configuration names

npm run eval:replay -- --cases ../cases.jsonl --out ../runs/first --label first --config config.local.yml
npm run eval:compare -- ../runs/baseline/summary.json ../runs/first/summary.json
```

The case file and the output folder must be outside the project folder, so that private data cannot be committed by accident. A case file is JSON Lines: each line names a pull request at a fixed head and base, with the review comments people left, labelled by whether they were valid. This repository has no command that builds a case file yet.

## Backtest

The backtest replays the score on past pull requests and measures it against where people actually commented. Like the replay, it reads from GitHub, calls the model, makes paid calls bounded by `--max-cases` and `--max-cost`, and posts nothing. Its input is a history file written by `import-history`, and its files, like the history file, must be outside the project folder: they hold paths and model-written reasons.

```bash
npm run eval:import-history -- --repo owner/name --since 2026-01-01 --until 2026-04-01 --out ../history.jsonl
npm run eval:backtest -- --history ../history.jsonl --out ../runs/score-one --label score-one --config config.local.yml
npm run eval:score-noise -- ../runs/score-one ../runs/score-two
```

- **Safety**: of the blocks and files a person had to look at, the share the score would have left below the threshold; lower is better.
- **Benefit**: the share of pull requests in which nothing in the pull request reaches the threshold: no block and no file as a whole. A person need not be asked about those at all.
- **Focus**: in the pull requests that do go to a person, the share of changed lines flagged. Lower means the person reads less.

A block or file is labelled **loose** when a person who is not the author left an inline comment on it. It is labelled **strict** when, in addition, its lines (for a file, its diff) changed in a later commit before the merge; Safety is reported for both.

`score-noise` compares two runs of the same history file and prints how often a block, and a whole pull request, falls on a different side of each threshold between them.

## The file a team commits

A team may commit `.visto-ai.yml` at the root of its repository, listing paths that always need a human reviewer. It is read from the default branch and can only add protection.

```yaml
# .visto-ai.yml
human_review:
  - db/migrate/
  - "app/**/policy.rb"
```

- A trailing slash is ignored, and a pattern with no slash left matches at any depth: `migrations/` is the same as `migrations`, and covers `migrations/x.sql` and `services/api/migrations/x.sql`.
- A pattern with a slash anywhere but at its end is matched from the repository root. `db/migrate/` therefore covers `db/migrate/001.rb` and never `services/db/migrate/001.rb`.
- A leading slash also ties a pattern to the root: `/docs` matches only the top-level `docs`, while `docs` matches at any depth.
- A pattern that names a directory covers everything under it, dot-files included.
- The wildcards are `*` (any run of characters within one name), `?` (one character) and `**` (any number of directories): `app/**/policy.rb` covers `app/policy.rb` and `app/models/user/policy.rb`.
- `**` is special only as a whole path segment; inside a name, such as `a**b`, it is two `*`.
- Matching is case-sensitive.
- A renamed file is checked by its old path as well as its new one.
- Brackets are ordinary characters: `app/[id]/page.tsx` matches only that path.
- A pattern with a backslash, a brace, a `.` or `..` segment, or a leading `!` is refused, and makes the file unusable.

A file that cannot be used (invalid YAML, an unknown key, a refused pattern, content that is not text, or one that is too large) sends every pull request to a person, and the review says why the file cannot be used.

## Repository layout

| Path | What |
|---|---|
| `src/engine` | The review engine: context, model call, checks on the answer, rendering |
| `src/engine/scorer` | The optional decision-model scorer and its client |
| `src/engine/score` | Blocks, the rules that score without the model, and the floors from `.visto-ai.yml` |
| `src/forge` | The boundary to git services. `forge/github` holds the read-only GitHub sources and the webhook reader |
| `src/eval` | The `replay` and `compare` commands |
| `src/eval/history` | The `import-history` command and the history file it writes |
| `src/eval/backtest` | The `backtest` and `score-noise` commands: labels, the three numbers and the noise between runs |
| `src/db` | The Postgres client, migrations, the queue's statements and the recorded runs |
| `src/shell` | Receiving a webhook, the queue of review jobs, running a review, the daily limit and the model's health |
| `src/service.ts`, `src/main.ts` | Starting and stopping the service |
| `src/config` | Loading and validating configuration |
| `contract` | The rules the model is given |
| `docs/superpowers` | The design and the implementation plans |

## Licence

[Apache-2.0](LICENSE).
