---
title: Benchmark
description: AACR-Bench is a public set of reviewed pull requests.
---

[AACR-Bench](https://github.com/alibaba/aacr-bench) is a public set of reviewed pull requests. Its version 2 (`dataset/v2/positive_samples.json`) is licensed Apache-2.0 and holds 151 merged pull requests of public repositories, with 944 review comments checked by experts. It is not part of this repository: download it yourself and keep it outside the project folder. These commands read it as untrusted data, never run it, and put nothing made from it in the repository.

`import-aacr` reads GitHub and needs `GITHUB_TOKEN`; it makes no model call and takes no `--max-cost`. `replay` makes paid model calls and reads GitHub, so it needs both tokens and takes `--max-cost`. `judge` makes paid model calls, needs no GitHub token and takes `--max-cost`. All files must be outside the project folder.

```bash
export GITHUB_TOKEN=...        # a read-only token
export OPENROUTER_API_KEY=...  # or the variable your configuration names

# 1. Turn the raw file into a case file and a history file
npm run eval:import-aacr -- --input ../aacr/positive_samples.json --cases-out ../aacr/cases.jsonl --history-out ../aacr/history.jsonl

# 2. Replay the reviewer, then the control, on the same cases
npm run eval:replay -- --cases ../aacr/cases.jsonl --out ../runs/reviewer --label reviewer --config config.local.yml --max-cases 10 --max-cost 3
npm run eval:replay -- --cases ../aacr/cases.jsonl --out ../runs/plain --label plain --config config.local.yml --max-cases 10 --max-cost 3 --plain

# 3. Judge each run against the reference comments, each one on the cases both runs answered
npm run eval:judge -- --cases ../aacr/cases.jsonl --run ../runs/reviewer --with ../runs/plain --config judge.local.yml --max-cost 3
npm run eval:judge -- --cases ../aacr/cases.jsonl --run ../runs/plain --with ../runs/reviewer --config judge.local.yml --max-cost 3

# 4. Replay the score on the history file
npm run eval:backtest -- --history ../aacr/history.jsonl --out ../runs/score --label score --config config.local.yml --max-cases 10 --max-cost 3
```

**The import.** `import-aacr` orders the pull requests by a hash of their address and head, so that `--max-cases 10` takes a spread of repositories whatever the order of the file. It reads each pull request's title and description from GitHub, so that the review sees what the app would see, and takes the merge base from a comparison, as `import-history` does. It prints how many records it read and wrote and how many it skipped, by code: `bad_record`, `bad_comment`, `duplicate`, `pr_unreadable`, `head_unreadable`, `too_many_files`.

**The control.** `replay --plain` asks the same model, with the same configuration, one question for each case: the title, the description and every changed file's patch except a secret file's, with a short plain prompt, answered with a list of findings. It builds no context, packs no batches, places no finding and computes no score. A case whose request would not fit in `limits.inputTokensPerCall` fails with `too_large`. The control shows what the engine adds to the model alone.

**The judge.** `eval:judge` writes `judge.jsonl`, `judge-summary.json` and `judge-summary.md` into the run folder and changes none of the run's own files. It needs no GitHub token. Use a model of another family than the reviewer's, so that the model does not rate its own kind. For each finding, one model call is shown the finding and the reference comments of the same file, and names every reference that raises the same concern about the same code. A finding in a file with no reference comment is unmatched, with no call. The judge reads everything a person would read in the review: findings placed on a line, findings that could not be placed, and findings beyond the diff. The reasons it gives are kept in `judge.jsonl`: read a sample of them by hand before trusting a number.

- **Recall**: the share of reference comments that some finding covers.
- **Precision**: the share of findings that cover a reference comment, counted by a maximum one-to-one matching between findings and references within a case (each finding and each reference is used at most once). For recall, one finding may cover several references. AACR-Bench's own count depends on the order of the findings, and the two arms order them differently, so it is not used here.
- **F1**: the harmonic mean of the two, taken from the raw counts. It is 0 when either is 0 or when only one of the two is undefined, and undefined (printed as an em dash) only when both are.

A failed replay case is left out of all three and counted. A finding whose judge call failed twice counts as unmatched, and is counted. As with `replay`, when the provider reports no cost and the configuration has no prices, `--max-cost` stops nothing. With `--with`, both runs are restricted to the cases that are ok in both, so the control and the reviewer are rated on the same cases; without it, a case one run failed counts for the other. A judge stopped by `--max-cost` rates only the first cases of the case file, in the file's order, and prints how many it did not judge.

**The score.** The backtest on the history file reports Safety, Benefit and Focus as in [Backtest](backtest.md), with these differences:

- Read only the loose Safety. The history file has no later commits, so strict Safety is meaningless here; and do not use `--memory` with it.
- Every pull request in the data has at least one expert comment, so Benefit is the share of pull requests the score would have approved with nothing shown to a person despite a known problem. Lower is better.
- Safety counts expert comments of every weight, nits included, so it understates how well the score keeps defects in view.

**What it does not show.**

- Whether safe pull requests are approved. Every pull request in version 2 has a problem, so the benchmark cannot show a score's false alarms, or whether it approves what is safe.
- Precision is a lower bound. A real problem the experts did not annotate counts against the finding that raised it.
- The pull requests are public, merged and may have been seen by the models during their training.
- It rates one model's judgement of "the same concern", not a person's; the sample of reasons is how you check it.
- Nothing here is a number for your repositories.

Results of runs are kept in `docs/benchmarks/`, one file per run, with the code, data, models and costs they came from. The first is [2026-11-24-aacr-bench-v2.md](../benchmarks/2026-11-24-aacr-bench-v2.md); [2026-11-25-aacr-bench-v2-experiments.md](../benchmarks/2026-11-25-aacr-bench-v2-experiments.md) measures placement by quote and two experiments; [2026-11-26-the-finding-contract.md](../benchmarks/2026-11-26-the-finding-contract.md) measures the finding contract adopted then.
