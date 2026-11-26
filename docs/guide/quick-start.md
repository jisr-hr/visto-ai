---
title: Quick start
description: The service receives GitHub's signed webhooks and records each delivery's id and what it says about people and the pull request (the payload itself is not kept).
---

The service receives GitHub's signed webhooks and records each delivery's id and what it says about people and the pull request (the payload itself is not kept). When a pull request is opened, reopened, made ready for review, pushed to or given a new base branch, it queues a review. A push is reviewed after 180 quiet seconds, so several pushes in a row give one review (see [Leaving dry run](leave-dry-run.md) for what a later review does and [Scores kept across reviews](scores-across-reviews.md) for how scores are kept). The review runs the engine on the pull request as GitHub has it then. In dry run (`dryRun: true` in the config) it is recorded in the database and **nothing is posted to GitHub**; extension modules are still asked for context and serve their routes, and none is told of a review or an alert. Out of dry run (`dryRun: false`) it is also posted, and the threads of the app's earlier reviews are followed up, as described in [Leave dry run](leave-dry-run.md). In a repository that switches on the merge gate, a pull request against a gated branch is not reviewed when it is opened or pushed to: it is reviewed when someone asks (see [The merge gate](merge-gate.md)).

To run it you need a GitHub App (its id, its private key and its webhook secret), a model key and a Postgres. [Creating the app](create-the-github-app.md) says how to make the app with a command, or by hand.

In dry run the service reads pull requests and the files of the repository and writes nothing, so the app needs read access to pull requests and to contents (and to metadata, which GitHub always asks for), and the events `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` and `pull_request_review_thread`. With too little access every read is refused, and every job ends `attempts_exhausted` (or `not_found`, if GitHub answers the pull request itself with 404).

```bash
cp env.example .env                       # then write your own passwords, secret and keys
cp config.example.yml config.local.yml    # then switch on the app and database blocks (dryRun is true in the example)
docker compose up -d --build --wait
```

To try it with invented webhooks, load `.env` and send a sample (it posts only to this machine):

```bash
set -a && . ./.env && set +a
npm run dev:send-webhook -- --url http://localhost:8080/webhooks/github --secret-env WEBHOOK_SECRET --kind review
```

The kinds are `pull_request`, `review` and `comment`. For the `comment` kind, `--body <text>` sets the comment's text, so `--body /review` sends a command; the other kinds refuse it. For the `pull_request` kind, `--action opened|synchronize` (default `opened`) and `--head <sha>` (default `abc123`) choose the action and the head commit, so two pushes can be sent with two heads. The other kinds refuse these options. Stop it with `docker compose down`.
