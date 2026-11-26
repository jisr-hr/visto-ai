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

The replay runs without memory, and takes no `--memory`: its cases carry no date for memory to be "as of". So it is shown no lesson either: with no date, a case could be shown a lesson made from itself or from a reply written after it.
