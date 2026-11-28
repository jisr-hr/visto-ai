---
title: Replay
description: The replay runs past pull requests through the engine and scores its findings against what human reviewers said on those pull requests.
---

The replay runs past pull requests through the engine and scores its findings against what human reviewers said on those pull requests. It reads from GitHub and calls the model. It posts nothing.

It makes paid model calls. It runs at most `--max-cases` cases (60 by default) and starts no new case once the cost reaches `--max-cost` (10 by default). The cost is the one the provider reports, as OpenRouter does, or else it is computed from the prices in your configuration. With neither, the cost counts as zero and `--max-cost` stops nothing.

```bash
export GITHUB_TOKEN=...        # a read-only token
export OPENROUTER_API_KEY=...  # or the variable your configuration names

npm run eval:replay -- --cases ../cases.jsonl --out ../runs/first --label first --config config.local.yml
npm run eval:compare -- ../runs/baseline/summary.json ../runs/first/summary.json
```

The case file and the output folder must be outside the project folder, so that private data cannot be committed by accident. A case file is JSON Lines: each line names a pull request at a fixed head and base, with the review comments people left, labelled by whether they were valid. `eval:import-aacr` builds one from AACR-Bench (see [Benchmark](benchmark.md)).

The replay loads no extension module, so it runs without extension context and without acceptance rows; what rows cost the findings is therefore not measured. A config that names modules still needs the variables their options name to be set.

The replay opens no MCP server either, so it runs without tools: a replayed pull request is merged, and a documentation server's index may already hold its fix. What tools do to findings is therefore not measured. A config that names servers still needs the variables their headers name to be set. The replay honours `model.toolChoice`.

The replay runs without memory, and takes no `--memory`. Without `--lessons` it is shown no lesson, and it is given the time of the run as its clock.

## The replay with lessons

With `--lessons <lessons.json>`, each case is reviewed as of its date, with the lessons the file holds that were live then (see [Measuring lessons](lessons-and-reverts.md#measuring-lessons)). The file is the one `eval:judge-replies` writes, it must be outside the project folder, and a file that is not whole is refused (`lessons_incomplete`). The date of a case is its `review_at`, the start of the run it was made from; it is the clock the review is given. A case is never shown a lesson made from its own pull request, nor one made from a reply written on its own day, nor one that has expired.

```bash
npm run eval:lesson-cases -- --history ../history.jsonl --findings ../export.jsonl --lessons ../lessons/lessons.json --out ../lesson-cases.jsonl
npm run eval:replay -- --cases ../lesson-cases.jsonl --lessons ../lessons/lessons.json --out ../runs/on-1 --label on-1 --config config.local.yml
```

- **Only a dated case file can be run with lessons.** A case has an optional `review_at`, a time. `eval:lesson-cases` writes it into every case. A replay with `--lessons` refuses a case file in which a case it would run has none (`case_without_date`), so the frozen case file, and any file with no dates, cannot be run with lessons: its cases predate every lesson, and with no date a case could be shown a lesson made from itself or from a reply written after it. `--lessons` cannot be used with `--plain` (`usage: --lessons cannot be used with --plain`).
- **Lessons alone.** The memory of a replay with lessons holds no signal and no revert, and its results hold no block scores. What lessons do to the score is measured in the backtest (see [Backtest](backtest.md#lessons-in-a-backtest)).
- **What it records.** Each row of `results.jsonl` carries `lessons`: the case's status, code and number of lessons shown, or null. `summary.json` names the lessons file and its sha256 and counts the cases by status, and `summary.md` ends with a line `Lessons: as of each case, from <file>. Cases shown a lesson: ...; with none to show: ...; not shown: ...; failed: ...; not asked: ...`.
- **Comparing.** `eval:compare` refuses two runs that both have lessons and were shown different ones (`different_lessons`), and ends with a line `lessons: <file>; <file>` naming each run's file, with `none` for a run without lessons, only when a run has lessons. It needs the same case file for both runs, as it always does: run the baselines on the dated case file, without `--lessons`.
- **Cost and what it cannot show.** A replay with lessons makes the same paid calls as one without, and needs `GITHUB_TOKEN` as any replay does. A lesson a team switched off in the deployment is shown anyway, and the lessons are the eval's own (see [Measuring lessons](lessons-and-reverts.md#measuring-lessons)). Run the count (`eval:lesson-cases`) first: it is free, and says whether the cases hold enough lessons and `invalid` labels to show anything.
