---
title: Configuration
description: config.example.yml documents every key.
---

[config.example.yml](../../config.example.yml) documents every key. Copy it to `config.local.yml`, which git ignores. A secret is never written in the file; the file names the environment variable that holds it.

The top-level `extensions` block names extension modules, each with a name, a path or package and its options, in which a secret is named by reference as `{ env: VARIABLE }` (see [Extensions](extension-modules.md)).

The top-level key `learning` switches memory on for every repository of the deployment, or off for all: memory for the score, lessons and reverts. It is `false` when not written, and is no key of a repository (see [Memory](memory.md)). The number a description says a pull request reverts is stored either way.

The top-level key `auditKey` names, by reference, the secret the audit sample of automatic approval is drawn with: at least 32 characters, needed while a repository has `autoApprove` true with an `auditShare` above 0, and read, so needed in the environment, whenever it is written (see "The audit key" under [Automatic approval](automatic-approval.md)).

The top-level `mcpServers` block names MCP servers, each with a name, an address, headers (a secret by reference) and the tools the model may be offered (see [MCP tools](mcp-tools.md)).

`model.toolChoice` says how the model is made to answer through `submit_review`. With `forced`, what you get when the key is not written, every request names the tool, as before. Use it unless your endpoint refuses a request that names a tool for your model: every review then fails at the model stage with a provider error. On 2026-11-23 the first endpoint the project supports refused such requests for some newer models, before they reached the model, and accepted `auto`. Then set `toolChoice: auto`: every request leaves the choice to the model, the tools of a request stay what they are, a turn that must end the call says so in a line, and an answer there that does not call `submit_review` is invalid output and takes the one retry. What `auto` costs: the model may answer in prose, which costs one more request, and two such answers in one model call fail that part of the review. With MCP servers named, a model that calls one of their tools again on the closing turn and again on its retry fails that batch the same way (see [MCP tools](mcp-tools.md)). The key changes the requests with no MCP server too, and the eval commands honour it.

The merge gate has its own block, `gate`, under `repositories.defaults` and `repositories.overrides` (see [The merge gate](merge-gate.md)). One repository setting decides how a later head is reviewed: `repositories.defaults.newHead`, which `repositories.overrides` can set for one repository. `incremental` (what you get when it is not written, except on a gated pull request in `enforce` or `bypass`, where not written means `full`) reads only what changed since the last review; `full` reads the whole pull request at every head, and costs what a first review costs. It changes nothing for a first review, for a head on a different base branch (always full), or for a `/review` on the head and base of the last review (always a re-check). See [Reviews after the first](leave-dry-run.md).
