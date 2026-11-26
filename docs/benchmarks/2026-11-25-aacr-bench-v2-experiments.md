# AACR-Bench v2, 2026-11-25: placement by quote, a looser bar for minor findings, and a read tool

Three things were measured on the same benchmark as [the first full run](2026-11-24-aacr-bench-v2.md), each taken from a comparison with [alibaba/open-code-review](https://github.com/alibaba/open-code-review): the new placement rules on the code to be merged, and two experiments that are not merged. How to run the benchmark is in [the Benchmark page](../guide/benchmark.md).

## Setup

- Data, cases, models and judge as on 2026-11-24: `dataset/v2/positive_samples.json` (sha256 `2e83975aba1ca06544ccecdee8d99ab7152bc1d02a3d86bce3022d8d4e3010ba`), 142 cases with 880 comments (case file sha256 starting `ada6cd9fb0a1`); reviewer `openai/gpt-5.6-luna` through OpenRouter, effort medium (high for large or primary-branch pull requests); judge `anthropic/claude-sonnet-5.5`.
- Each run is judged `--with` the plain control of the same round from 2026-11-24 (`replay --plain`), so both are rated on the same cases. No case failed in any run.
- **Baseline**: the reviewer at `17743f4`, which adds secret files and placement by quote (design section 5.6) to `main` at `abb2276`. One round.
- **Experiment 3, a looser bar for minor findings**: the baseline with two sentences of the contract changed, in both contracts. Rule 4 of "What a finding is" became: "It states a failure: a specific input or state, and the wrong outcome it produces. For `major` and `blocker` you must be able to show it from your input. When you can name the input and the wrong outcome but cannot verify from your input that nothing prevents it, report it as `minor` rather than leaving it out." And `minor` became: "a real defect with low impact or an unlikely trigger, or a likely defect whose failure path you cannot fully verify from your input. It still names the input or state and the wrong outcome." Two rounds.
- **Experiment 4, the diff first and a read tool**: the baseline with no full file and no paired test file in the context, and one tool offered through the existing tool loop (8 calls a review, 4 tool turns in each model call): `repo__read_file` reads up to 150 numbered lines of a file of the repository at the commit under review, and refuses secret files. Its rules say that what it returns is evidence like the diff. Two rounds.

## Findings

| | Recall (of 880) | Precision | F1 | Findings | Major / minor / blocker | Cases with none |
| --- | --- | --- | --- | --- | --- | --- |
| First full run, A / B (2026-11-24) | 0.108 / 0.102 | 0.443 / 0.405 | 0.174 / 0.163 | 203 / 200 | 129-57-7 / 122-56-5 | 40 / 35 |
| Baseline | 0.098 | 0.386 | 0.156 | 215 | 124-78-4 | 27 |
| Experiment 3, A / B | 0.114 / 0.109 | 0.404 / 0.408 | 0.177 / 0.172 | 225 / 211 | 131-77-5 / 126-70-6 | 32 / 34 |
| Experiment 4, A / B | 0.100 / 0.100 | 0.440 / 0.474 | 0.163 / 0.165 | 184 / 175 | 122-53-5 / 110-49-7 | 36 / 34 |
| Plain control, A / B (2026-11-24) | 0.151 / 0.152 | 0.453 / 0.436 | 0.227 / 0.226 | 274 / 264 | 207-52-15 / 197-57-10 | 22 / 19 |

Between identical runs on 2026-11-24, recall moved by under 0.01 and precision by about 0.04.

- **The baseline** is within noise of the first full run. Placement by quote changes where a finding sits inside its file, which this judge does not see (it matches findings to comments of the same file), and re-filing could only act on a finding that would not be placed, of which there were 0 or 1 in each run. The data holds no secret file.
- **Experiment 3** raised recall by about 0.01 over the earlier runs, at the edge of the noise, and did not raise the number of minor findings (77 and 70 against the baseline's 78). The bar for a minor finding is not what keeps the reviewer's recall below the control's. It is not adopted.
- **Experiment 4** kept recall where it was (0.100 in both rounds) and precision at the top of its range (0.440 and 0.474). It does not change what is found.
- Neither experiment closes the gap to the plain control, which reports far more major findings (207 and 197 against 110 to 131) at the same precision.

## Cost

| | Model cost, USD | Tokens | Of them cached | Model calls | Median seconds per case |
| --- | --- | --- | --- | --- | --- |
| Baseline | 2.29 | 7.01 M | 0.40 M | 148 | 45 |
| Experiment 3, A / B | 2.29 / 2.30 | 7.01 M / 7.01 M | 0.40 M / 0.40 M | 148 / 147 | 46 / 50 |
| Experiment 4, A / B | 1.49 / 1.50 | 9.09 M / 8.76 M | 5.93 M / 5.61 M | 530 / 510 | 47 / 45 |

- Experiment 4 sends a third more tokens, but most of them are the earlier turns of the same call sent again, which the provider serves from its cache at a lower price; the tokens it does not cache fall from 6.61 M to 3.16 M, and the cost by about a third.
- The saving is on large pull requests: on the fifth of the cases with the most tokens in the baseline, the cost falls from 1.03 to 0.42 USD; on the rest, from 1.27 to 1.07, with nearly twice the tokens.
- The model reads eagerly: 7.3 tool calls a case on average, and 116 and 117 of the 142 cases used all 8.
- The saving depends on the provider caching a repeated prefix. Without that, experiment 4 would cost more than the baseline.

Benchmark spend on 2026-11-25: 14.16 USD, of which 9.90 for the reviewer's runs (with a two-case check of the tool) and 4.26 for the judge.

## What this does not show

- Whether safe pull requests are approved: every pull request in v2 has a problem.
- Precision is a lower bound: a real problem the experts did not list counts against the finding that raised it.
- One reviewer model, and one round of the baseline.
- What a read tool does in the service: a pull request from a fork is given no tool, so without full files it would be reviewed from the diff alone.
- The pull requests are public and may be known to the models.
