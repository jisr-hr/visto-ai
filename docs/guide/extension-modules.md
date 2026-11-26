---
title: Extension modules
description: An extension module is code of your own that the service loads once, at start.
---

An extension module is code of your own that the service loads once, at start. A module can give the reviewer context about a pull request (a ticket's text and its acceptance criteria), be told when a review is published and when an alert is raised, and answer HTTP requests under `/extensions/<name>/`, for example to collect a thumbs up or down on a review. The service ships none, and knows no ticket system or chat tool. With no module named, it does what it does without them. **It was tried only with the example module, [examples/extension-example.ts](../../examples/extension-example.ts), and with no real ticket system or chat tool.**

Name a module in the config's `extensions` block, with a secret by reference inside its `options`:

```yaml
extensions:
  - name: example
    module: ./extensions/extension-example.ts
    options:
      secret: { env: EXAMPLE_FEEDBACK_SECRET }
```

[docs/extensions.md](extension-contract.md) states the contract a module is written against, how it is loaded (under Docker its file must be mounted), and what the service guarantees and what the module must do itself. A module runs inside the service, with its secrets, its database connection and its network; the service does not sandbox it.

What an operator sees:

- **The `Acceptance criteria` section.** When a provider returns criteria (at most 30), the review lists each one, after `Human review` and before `Findings`, with a count line and one of three words: `[met]`, `[not met]` or `[not verified]`. A row kept from an earlier review is tagged `_(kept from an earlier review)_`, and a criterion no review judged `_(not judged in this review)_`. The model gives the rows; the service checks them, merges those of several batches (`not met` wins), and writes each criterion inside a code span, so nothing in it takes effect.
- **Rows decide nothing.** They touch neither the verdict, the score nor the merge gate, and an unmet criterion is not a finding. A pull request that meets none of its criteria can still pass the gate.
- **A kept row can be stale.** In an incremental review and a re-check, a criterion the model does not judge keeps the row of the newest published review that has rows. A kept `met` can be stale when a later push removed the code that met it.
- **A criterion is told apart by its text.** Reworded by one character, it starts again as not verified.
- **Extension text gives way to files.** The text and the criteria are shown only when they cost the files nothing: nothing more cut, no file more left unreviewed. The texts are dropped first, then the criteria; the review's audit says `extension_context_cut`. Every call of a review repeats them.
- **What is posted is public.** Criteria are written in the review, and the model may quote a provider's text in what it writes there, so both are readable by whoever can read the pull request. A pull request from a fork, or one whose origin the service cannot tell, is given no extension context: its providers are recorded as `skipped`, with `from_fork` or `origin_unknown`.
- **Limits.** 8,000 characters of text for one provider, 24,000 for all together, 80 for a label, 300 for one criterion, 30 criteria in all. At about three characters to a token that is up to about 11,000 tokens in every call of a review. Each provider has 30 seconds, all are asked at once, so a slow provider adds up to 30 seconds to every review.
- **Statuses.** Each review records how each provider did (`ok`, `empty`, `skipped` or `error`, with a short code) in `review_runs.result`, under `dependencies.extensions`, and in the `review` log line, as `extensions` (null with no module). A review that ends before the providers are asked, because the pull request has no changed file or its file list cannot be read, records none.
- **Two alerts.** `extension_error` when a part of a module (`context`, `notify` or `route`) starts failing, and `extension_ok` when it works again. A provider that answers `empty` or `skipped` is not failing. A provider that fails for some pull requests and not for others alerts at every change, and a restart raises the alert again.
- **The notice.** Each published review is told to the modules' notifiers once, re-checks included, as the last thing its job does (a run adopted late, before the job reviews the live head). The run's row is stamped (`notified_at`) before the call, so a stop or a failed notifier loses the notice, and it is not sent again. Each notifier has 10 seconds; one that hangs holds a place of the queue that long. Not in dry run.
- **Routes.** Each module holds at most 10 requests at once, apart from the webhook route's 20, and a body of at most 1 MiB. A handler has 10 seconds: its caller is then answered `500`, and the request keeps its place until the handler settles, so a module whose handlers hang answers `503 busy` to its own callers, and to nobody else.
- **Feedback.** A module reports an answer through one function, and it is stored in `visto_ai.review_feedback`: one row for each run and person (the git login, in lower case), the latest winning. Only a published run can be answered. Whoever passes the module's own check can answer for any login, so the number of rows for one run is not bounded. Nothing shows feedback yet. To read it:

```bash
docker compose exec db psql -U postgres -d visto -c "select run, owner, repo, number, login, vote, reason, extension, at from visto_ai.review_feedback order by at desc limit 20"
```

The service adds one migration, `0009_feedback`: the `review_feedback` table and the `notified_at` column. A previous release refuses to start on a database that has it.
