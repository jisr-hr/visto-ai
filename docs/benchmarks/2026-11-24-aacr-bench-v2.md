# AACR-Bench v2, 2026-11-24

The first full run of the reviewer on [AACR-Bench](https://github.com/alibaba/aacr-bench) v2 (Apache-2.0): merged pull requests of public repositories, each with review comments that experts checked. It measures the findings against those comments, and the score against the places they mark. How to run it is in [the Benchmark page](../guide/benchmark.md).

## Setup

- Code: this repository at `e763169`.
- Data: `dataset/v2/positive_samples.json` (sha256 `2e83975aba1ca06544ccecdee8d99ab7152bc1d02a3d86bce3022d8d4e3010ba`): 151 pull requests, 944 comments. `eval:import-aacr` wrote 142 cases with 880 comments (case file sha256 starting `ada6cd9fb0a1`); GitHub could no longer compare the commits of the other 9.
- Reviewer and control: `openai/gpt-5.6-luna` through OpenRouter, effort medium (high for large or primary-branch pull requests), the same model and effort rule for both. The reviewer is the engine with its contract and scoring in the call; the control is `replay --plain`: one call, the whole diff, a three-sentence prompt.
- Judge: `anthropic/claude-sonnet-5.5`, another model family than the reviewer's, tool choice `auto`. Each run judged `--with` the other, so both are rated on the same cases (all 142 were ok in both, in both rounds).
- Two identical rounds, A and B, to see how much the numbers move by chance. No case failed in any run.

## Findings

| | Reviewer A | Reviewer B | Control A | Control B |
| --- | --- | --- | --- | --- |
| Findings | 203 | 200 | 274 | 264 |
| Precision | 0.443 | 0.405 | 0.453 | 0.436 |
| Recall (of 880) | 0.108 | 0.102 | 0.151 | 0.152 |
| F1 | 0.174 | 0.163 | 0.227 | 0.226 |
| Model cost, USD | 2.26 | 2.27 | 0.65 | 0.67 |
| Tokens | 7.2 M | 7.0 M | 1.1 M | 1.1 M |
| Median seconds per case | 55 | 48 | 24 | 23 |

- Recall: the control finds about 45% more of the experts' comments. The gap (about 0.045) is far above the movement between rounds (under 0.01), so it is real.
- Precision: the control is a little higher in both rounds, but the reviewer's own precision moved 0.04 between rounds; the difference cannot be told from noise.
- The reviewer returned no finding on 40 of the 142 cases in round A; the control on 22.

Comments covered in round A, by the category AACR-Bench gives each comment:

| Category | Comments | Reviewer | Control |
| --- | --- | --- | --- |
| Code defect | 569 | 83 | 112 |
| Maintainability and readability | 178 | 2 | 5 |
| Performance | 94 | 6 | 13 |
| Security vulnerability | 39 | 4 | 3 |

The gap is in defects, not in style. The likely cause is the contract's bar for a finding (a concrete failure must be shown, the model must try to disprove a major finding, and no finding is a correct answer), which removes findings here without making the rest more precise. That is a reading, not a measurement: no run with a looser contract was made.

## The score

From `eval:backtest` on the history file the import wrote. Every pull request here has an expert comment, so "approved" means approved despite a known problem.

| Threshold | Blocks with a comment left below it, A / B (of 543 / 542) | Pull requests approved, A / B (of 142) | Changed lines a person reads, A / B |
| --- | --- | --- | --- |
| 20 | 0% / 0% | 0 / 0 | 97% / 98% |
| 40 | 8% / 8% | 1 / 3 | 70% / 69% |
| 70 (the default) | 44% / 41% | 35 / 30 | 58% / 59% |
| 90 | 90% / 94% | 120 / 123 | 42% / 26% |

Between the two rounds, at 70, 19% of blocks and 16% of pull requests fell on the other side of the threshold.

Model cost of the score's backtest: 2.29 and 2.30 USD.

## What this does not show

- Whether safe pull requests are approved: every pull request in v2 has a problem.
- Real problems the experts did not list count against precision. A hand check of the judge on a pilot found its matches right, and several unmatched findings of the reviewer that look like real problems; those were not verified.
- The score is meant to mark where a person's judgement is needed, not where a bug is likely. Expert comments include small suggestions, and Safety counts them as much as defects.
- The pull requests are public and may be known to the models.
- One model. Other models were not run.

## Cost

Reviewer 4.53, control 1.32, judge 3.99, score backtest 4.59: 14.43 USD for both rounds.
