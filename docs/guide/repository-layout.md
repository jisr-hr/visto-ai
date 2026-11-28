---
title: Repository layout
description: What each path in the repository holds.
---

| Path | What |
|---|---|
| `src/engine` | The review engine: context, model call, checks on the answer, rendering |
| `src/engine/scorer` | The optional decision-model scorer and its client |
| `src/engine/score` | Blocks, the rules that score without the model, and the floors from `.visto-ai.yml` |
| `src/forge` | The boundary to git services. `forge/github` holds the GitHub sources, the webhook reader and the writer that posts |
| `src/eval` | The `replay` and `compare` commands, and the commands' entry point (`cli.ts`) |
| `src/eval/history` | The `import-history` command and the history file it writes; `seed.ts`, the `seed-memory` command's writes |
| `src/eval/lessons` | The evals' lessons: the operator's export of a deployment's findings (`export.ts`, the only file of the eval besides the CLI and the seed that reaches a database), the nights over it (`nights.ts`), the kept answers of the judge (`answers.ts`), the lessons file (`lessons-file.ts`) and the dated, labelled replay cases (`cases.ts`) |
| `src/eval/backtest` | The `backtest`, `score-noise`, `memory-count` and `score-compare` commands: labels, the three numbers, the noise and the moves between runs, and memory as of each case (`memory.ts`) |
| `src/memory` | The rules memory shares between the service and the eval: the one that makes signals from comments (`signals.ts`), the one that chooses what a review is shown of them (`select.ts`), the one that chooses its lessons (`lessons.ts`), the judge of a reply and what makes a lesson (`judge.ts`), the night's rules that the service and the eval both run (`night.ts`), the rule of a revert and the records it makes (`reverts.ts`), and the one reader of a time (`time.ts`) |
| `src/db` | The Postgres client, migrations, the queue's statements, the recorded runs, memory's records, the learning work's rows, and the judge's verdicts and calls |
| `src/shell` | Receiving a webhook, the queue of review jobs, running a review, publishing it, following up its threads, the daily limit and the model's health; the notices, routes, feedback and health of extension modules; the health of MCP servers; the learning pass (`learning.ts`), the nightly judge of lessons (`judge.ts`), memory from the database (`memory.ts`) and its health (`memory-health.ts`) |
| `src/approval` | Automatic approval: which threads are closed for it (`threads.ts`), the decision from what is stored and what the pull request is now (`rule.ts`), the audit sample's draw (`audit.ts`), every sentence it writes (`text.ts`), and the withdrawal job (`withdraw.ts`) |
| `src/extensions` | The contract of an extension module, its loader and its time limit |
| `src/mcp` | The MCP client: an event-stream reader, one JSON-RPC exchange over Streamable HTTP, and a session that lists and calls tools |
| `src/ui` | The UI's part of the service: the built files read once and served with their headers (`files.ts`, `headers.ts`), sign-in through GitHub, sessions and the token for changes (`auth.ts`), passwords and one-time passwords (`passwords.ts`), password sign-in and changing one's own (`password-auth.ts`), making, re-roling, resetting and removing accounts (`accounts.ts`), the JSON reads (`api.ts`), the shapes of their answers (`api-types.ts`, the one file the frontend reads, as types), and the route that joins them (`route.ts`); beside them the command `npm run accounts` (`accounts-cli.ts`), which makes the first admin and is the way back in |
| `ui` | The web UI, a package of its own with its own lock file: React, Vite and Tailwind CSS, its components, pages and tests. `npm --prefix ui run build` writes `ui/dist`, which the service serves |
| `examples` | An example extension module |
| `src/service.ts`, `src/main.ts` | Starting and stopping the service |
| `src/config` | Loading and validating configuration |
| `contract` | The rules the model is given |
| `docs/guide/extension-contract.md` | The contract an extension module is written against |
| `docs/superpowers` | The design and the implementation plans |
