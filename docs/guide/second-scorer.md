---
title: A second scorer
description: By default the review model also scores the changed blocks.
---

By default the review model also scores the changed blocks. You can name a separate decision model to score them instead. It is off unless you write the `scorer` block. Once the service has started, an admin can switch it off, change its model and time limit, and, while it is on, its endpoint in the UI's Settings, under Model; whether it is on and its endpoint are read at the next start, its model and time limit at the next review. Switching it on from Settings needs the file to write `scorer.apiKey`, since a key is never set there (see [Configuration](configuration.md)). The scorer answers for blocks only: a file moved to another directory with no content change keeps the review model's score. Its scores have their own history: naming a scorer, or dropping it, scores every open pull request's blocks afresh once (see [Scores kept across reviews](scores-across-reviews.md)). [config.example.yml](../../config.example.yml) shows the keys, with a placeholder model name.

The adapter speaks the decisions endpoint of OpenRouter and was built against the Jev decision model.

- The reviewed code is then also sent to that provider.
- The review model is then not asked for block scores: it gets [contract/review-contract-scorer.md](../../contract/review-contract-scorer.md) in place of the review contract.
- The endpoint is marked alpha by its provider.
- The score threshold must be written, and you should choose it from a backtest.
- A file the scorer fails on goes to a person.
- The scorer's cost counts towards `--max-cost` only when its provider reports a cost with each answer.

`backtest` records which scorer was used, and `score-noise` refuses to compare two runs made with different scorers.
