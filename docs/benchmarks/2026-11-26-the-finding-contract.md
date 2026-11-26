# AACR-Bench v2, 2026-11-26: the finding contract

The reviewer found too little: on [AACR-Bench v2](2026-11-24-aacr-bench-v2.md) it covered about a tenth of the expert comments, fewer than a plain one-prompt review with the same model. This file records what was tried to find more, what moved the numbers, and the contract adopted from it.

## Setup

As on 2026-11-24: `dataset/v2/positive_samples.json` (sha256 `2e83975aba1ca06544ccecdee8d99ab7152bc1d02a3d86bce3022d8d4e3010ba`), 142 cases with 880 reference comments; reviewer `openai/gpt-5.6-luna` through OpenRouter at effort medium, high for large or primary-branch pull requests; judge `anthropic/claude-sonnet-5.5`, each run judged `--with` the plain control of its round. No case failed in any run below.

## The contract adopted

Two changes, both in [the review contract](../../contract/review-contract.md) and its scorer twin, and one thing kept; nothing else changes. Both changes take generation rules from [Mira](https://github.com/miracodeai/mira), in our own words.

- **What a finding is.** A problem a careful reviewer would comment on: a bug, a security issue, a performance problem, or a maintainability problem worth fixing. A mismatch the model can point at in the code it was given is evidence even when it cannot trace every consequence, and is then `minor`. `minor` is everything worth fixing that is not a blocker or a major.
- **How to review.** Every file, one at a time, listing its risks and checking each; three checks that a first reading misses (removed lines are a specification; every caller and consumer of a changed contract; a changed value followed to where it is consumed); no quota; and a last pass asking what was seen and not reported.
- **Unchanged:** a blocker or a major finding must be shown from the code, and the model tries to disprove it before choosing either; a failure path it cannot verify is never one. Style, naming and formatting stay out. So what can hold a merge keeps its bar, although more findings now meet it (below).

| | Recall (of 880) | Precision | F1 | Findings (blocker / major / minor) | Model cost, USD | Median seconds |
| --- | --- | --- | --- | --- | --- | --- |
| Contract before, three runs | 0.098 to 0.108 | 0.386 to 0.443 | 0.156 to 0.174 | 200 to 215 (4 to 7 / 131 to 135 / 61 to 80) | 2.26 to 2.29 | 45 to 55 |
| **Contract adopted, A / B** | **0.141 / 0.139** | **0.422 / 0.426** | **0.211 / 0.209** | 275 / 263 (4 / 154 / 117; 1 / 160 / 102) | 2.33 / 2.30 | 40 / 33 |
| Plain control, A / B | 0.151 / 0.152 | 0.453 / 0.436 | 0.227 / 0.226 | 274 / 264 | 0.65 / 0.67 | 24 / 23 |

- Recall rises by about 40% at the same cost, and precision does not fall; the two rounds agree to within 0.002 of recall.
- The findings a merge waits on stay as precise as before, and there are more of them: 158 and 161 blocker or major findings against 135 to 142 before, of which 0.435 and 0.456 cover an expert comment, against 0.393 to 0.423 before. On the private case file inherited from the predecessor, labelled by engineers, the share of blocker and major findings marked wrong stayed within the range of the contract before.
- The reviewer is still below the plain control on recall. What else was tried, each one run unless said otherwise, and what it gave:

| Tried, with the adopted contract unless said | Recall | Precision |
| --- | --- | --- |
| Only the first change (what a finding is) | 0.126 | 0.397 |
| A minimal contract: the plain control's scope, the output rules and the bar for blocker and major | 0.132 | 0.404 |
| No block scores asked of the review model (the old contract) | 0.098 | 0.428 |
| Batches of about 30k tokens (the old contract) | 0.099 | 0.422 |
| One file per call | 0.142 | 0.406 |
| A plain unified patch in place of the anchored diff (minimal contract) | 0.132 | 0.426 |
| Diff only, no full file or paired test (minimal contract) | 0.108 | 0.448 |
| Per-language defect checklists added | 0.141 | 0.401 |
| Tools that read and search the commit under review, 40 calls a review, with the diff only (the old contract) | 0.089 | 0.431 |
| A separate planning call before each batch | 0.157 | 0.384 |
| Reasoning effort medium everywhere | 0.107 | 0.406 |

The planning call adds about 0.02 of recall at twice the cost and time; it is not adopted. Full files help: without them recall falls from 0.132 to 0.108 with the minimal contract, and the tools row, run with the diff only, mixes that loss with the tools. Lower reasoning effort costs recall, and the first change alone gives less than the three together. The rest moves nothing beyond the noise between identical runs (recall under 0.01, precision about 0.04).

## What this does not show

- Whether safe pull requests are approved: every pull request in v2 has a problem.
- Precision is a lower bound: a real problem the experts did not list counts against the finding that raised it.
- One reviewer model; the pull requests are public and may be known to it.
- What the new findings cost a team that reads them: there are about a third more findings in all, most of them minor.
- What the extra blocker and major findings do to the merge gate and to automatic approval, which count only those: about a sixth more of them, so more pull requests are held, though each one covers an expert comment a little more often than before.

Spend on these runs, the investigation included: about 85 USD over 2026-11-25 and 2026-11-26.
