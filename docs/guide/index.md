---
title: Introduction
description: An open-source, self-hosted AI reviewer for pull requests.
---

An open-source, self-hosted AI reviewer for pull requests. It looks for the problems a careful reviewer would comment on, holds the ones that can block a merge to a defect it can demonstrate, and scores which parts of a change still need a human reviewer.

> **Status: active development.** Visto AI is released as `0.x`, and every feature in this guide is part of the current release. See [Status](../../README.md#status).

## Why

Code used to be written by people and reviewed by people. Now AI writes much of it, and people hand the review to AI as well. Nobody is left deciding which changes still need a person.

Visto AI reviews a pull request and answers two questions:

1. **What is wrong with this change?** Bugs, security, performance and maintainability problems worth fixing. A blocker or major finding is one the reviewer can demonstrate, with a concrete failure scenario; the rest are minor. No style comments.
2. **Which parts of the change need a human reviewer, and why?** Every changed block of code gets a score from 0% to 100%. Blocks at or above a threshold (70% by default) are listed for a person, with the lines to read. If nothing reaches the threshold, and the team has switched this on, the bot approves the pull request when the other conditions of [Automatic approval](automatic-approval.md) hold too.

The aim is to reduce what people must review, and to be able to show the numbers that justify it.

## What it is designed to do

- **Findings**, tagged `[blocker]`, `[major]` or `[minor]`; only a blocker or major one, which must be demonstrated, can hold a merge. None is asked for, or kept, in a test, documentation, generated, vendored or lock file; such files are still scored. Which files these are is decided by path ([src/engine/context/focus.ts](../../src/engine/context/focus.ts)): a test helper with no test name outside a test directory, such as `src/testing/helpers.ts`, still takes findings.
- **A human-review score** for every changed block, with a reason for each block that needs a person.
- **Optional automatic approval**, per repository, off by default: the review is posted as an approval only when every file is reviewed, nothing is at or above the threshold, no major or blocker finding is open, the pull request is no draft and not from a fork, and the base branch's own rules dismiss stale approvals; a new commit withdraws it. A share of the pull requests it would approve, 5% unless the config says otherwise, is drawn for an audit sample and sent to a person anyway. Built; neither an approval nor an audit decided and posted by the service was tried against GitHub (see [Automatic approval](automatic-approval.md)).
- **Optional merge gate**: a required check that blocks a merge while a major or blocker finding is unanswered. Built; tried once against a real GitHub App, in part (see [The merge gate](merge-gate.md)).
- **Learning by retrieval**: what people do on pull requests is stored and retrieved into later reviews. The model is never fine-tuned. Built: memory for the score, lessons from replies to findings, and reverts, off unless switched on (see [Memory](memory.md)); what lessons do to findings and to the score, and what reverts do to the score, is not measured. The evals with lessons as of each case are built, in the findings replay and in the backtest, from a deployment's export (see [Measuring lessons](lessons-and-reverts.md#measuring-lessons)); what lessons do is measured only once a deployment's data is run through them.
- **Self-hosted**: `docker compose up` on one machine, with the app and Postgres. You create your own GitHub App and connect it. The project runs no hosted service.
- **Your choice of model**: built and tested against [OpenRouter](https://openrouter.ai) first. Any OpenAI-compatible endpoint can be configured.
- **Measured before trusted**: findings and scores can be replayed offline against past pull requests, with no side effects.

The full design, with every decision and its reason, is in [docs/superpowers/specs/2026-11-13-visto-ai-design.md](../superpowers/specs/2026-11-13-visto-ai-design.md).

## Guide

### Start here

- [Quick start](quick-start.md)
- [Create the GitHub App](create-the-github-app.md)
- [Leave dry run](leave-dry-run.md)

### Concepts

- [The score](the-score.md)
- [How a review runs](how-a-review-runs.md)
- [Scores across reviews](scores-across-reviews.md)

### Features

- [Automatic approval](automatic-approval.md)
- [The merge gate](merge-gate.md)
- [Inline notes](inline-notes.md)
- [Memory](memory.md)
- [Lessons and reverts](lessons-and-reverts.md)
- [A second scorer](second-scorer.md)
- [The UI](the-ui.md)

### Extend

- [Extension modules](extension-modules.md)
- [The extension contract](extension-contract.md)
- [MCP tools](mcp-tools.md)

### Reference

- [Configuration](configuration.md)
- [.visto-ai.yml](visto-ai-yml.md)
- [Running the service](running-the-service.md)
- [Development](development.md)
- [Repository layout](repository-layout.md)

### Measure

- [Replay](replay.md)
- [Backtest](backtest.md)
- [Benchmark](benchmark.md)

The current state of the project is in [Status](../../README.md#status) on GitHub.
