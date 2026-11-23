# Notes: The MCP Servers and Tool Loop plan

These notes record what happened while `2026-11-23-mcp-servers-and-the-tool-loop.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run under Docker and the paid trial showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built. This plan is the second of two for stage 6 of the build order; with it stage 6 is closed.

## Status

- The plan was drafted from the design, the code, a brief of the two protocols written from their official documents, and a private study of how the predecessor gave its model tools. It was reviewed by another model before anything was built. That review found one critical defect, four important ones and fourteen minor; all were ruled on and applied before the first line of code (decisions 5 to 9).
- Tasks 1 to 10 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. The reviewers ran the code rather than read it: the parent's client and engine beside the new ones on the same requests, a fuzzer of event streams against a reference reader, a small MCP server on the local machine, random concurrent schedules against the shared count of calls, a model checker of the loop on twenty-four thousand scripts, six thousand generated reviews with no server against the parent's engine. Every task needed a round of fixes or of added tests; each was checked again.
- Task 11's documents were written by an implementer from the code as built; the run under Docker was made by an agent of its own with throwaway secrets, and the paid trial by the controller.
- Then a review of the whole branch by the strongest model. It drove the real service, the real model client and the real MCP client through thirteen hundred random lives of pull requests, part of them over a listener on the local machine, against a model and servers that misbehaved in every way it could build, and judged each life by reading only the fake GitHub, the database, what its server received, what its model was sent and the log. It also sent the same deliveries through this branch with no server named and through `main`: the rows, the calls to GitHub, the answers, the log lines and every request to the model were the same, byte for byte. It found nothing critical and nothing important, and eleven small points; eight were fixed (decisions 16 to 19), and the same lives were run again. That run found nothing critical and nothing important; what it still found is small and listed under "Known and left".

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **One revision of the protocol** (call 1): the client speaks the revision of 2025-11-25 over Streamable HTTP, with static headers. A server that answers with one of the two revisions before it is used (call 2). Not built: the newest, stateless revision; the older HTTP+SSE transport; servers started as a local process; OAuth. Cost: a server that speaks only the newest revision cannot be used until a second code path is built.
2. **Only tools named in the config are ever offered** (call 6). A server can hold tools that write, and tools whose answers are large.
3. **A deployment trusts an MCP server's tool names, descriptions and schemas as it trusts its own configuration** (call 12). They cannot be wrapped as data, so they are cleaned and bounded, and one sentence of the rules says a description is no instruction. A tool's result is untrusted data like everything else.
4. **`model.toolChoice`** (call 31): `forced`, as before, or `auto`. Measured against the first endpoint the project supports: some newer models are refused when a request names the tool they must call, and accept the same request with the choice left to them. Before this key the engine could not run on such a model at all. Under `auto` a model may answer in prose, which costs the one retry.

**From the plan's review**

5. **An endpoint that refuses the tools costs the tools, not the review** (call 21). A batch's first call that offered tools and ends with a provider error is tried again without them; if that works, the tools are withheld for the rest of the review and each server says why. Cost: a provider error that has nothing to do with the tools, followed by a retry that works, withholds them too, and reads the same.
6. **Only a batch's first call is offered tools.** Every second try, and each half of a split batch, is sent none.
7. **The room for what the loop appends is counted, not guessed** (call 14), and tools are offered only when their definitions and that room cost the files and the extension context nothing.
8. **A turn that sends nothing to a server ends the open turns** (call 17), so a model that keeps calling functions that do not exist cannot keep the loop going.
9. **The closing turn keeps the whole tool list under both tool choices** (call 19): an endpoint wants the tools on every request.

**From the reviews of the tasks**

10. **A dripped answer holds no memory for each chunk.** As first built, a server that answered a byte at a time made the client hold hundreds of megabytes under a cap of one. The readers now collect bytes in one growing buffer and cut lines on the bytes.
11. **The client's own headers replace a given one in any letter case, and the eight names a config may not set are dropped by the client too.**
12. **Under `auto` the answer is the first call to `submit_review`, wherever it stands; an empty answer is sent back as a placeholder, never as an empty message.**
13. **A result's text is stripped before the review's token is deleted from it, until none is left,** and the size the audit reports is of what the model is shown.
14. **Closing a review's sessions stops the calls still under way,** and a server's status does not change after the close.
15. **The eval commands cannot reach the MCP client, by lint,** and nothing but the wiring can import it.

**From the review of the whole branch**

16. **The service's wiring of the servers and the tool choice is one tested function.**
17. **A tool's result loses every character that is ignored when text is shown,** before the review's token is deleted from it, so no look-alike of a marker can be built. Cost: a variation selector inside a result's text is lost.
18. **A reply during `initialize` carries the session id of that answer; an empty answer is never sent back empty when tools are offered; sessions are closed at once when no tool can be called.**
19. **Nothing outside the MCP part and the wiring can import it, by lint, and the MCP part imports only types of the rest.**

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 5 to 9; and that nothing told the model a tool's description is no instruction.
- **The reviews of the tasks.** Decision 10, found by measuring; a header given in another letter case merged with the client's own; a server address stored with white space or a line break in it; a description for a tool with none, built from the config's name without cleaning; a result that held the review's token nested in itself and came out as an empty block reported as full; a call that outlived its review by its own time limit; four rules of the loop and four sentences of the rules text that no test pinned.
- **The review of the whole branch.** Nothing that held the merge. No test failed when the service's entry stopped handing the engine its servers or its tool choice. A reply to a request the server sent during `initialize` went out without the session id. Under `forced` with tools, an empty answer was sent back as an empty message. A result could hold a look-alike of the end marker, built with a character that is ignored when text is shown. The lint held one file of the MCP part and not the rest.

## What the run under Docker showed

One run under Docker on the branch's code, in a network with no way out, with a key and secrets made for the run. The run brought an MCP server of its own: a script in the run's folder, never in the repository, with three tools in two pages, answers as JSON and as event streams, and four more addresses that misbehave.

- The previous release, then this branch on its database: no migration is added.
- A header named by reference whose variable is not set stops the start as a config error that names the key and the variable. With it set, the service listens, and nothing is asked of the server at start.
- The real client against that server: a session id issued and sent back on every later request, with the protocol version and the configured header; the tools read from two pages; one call answered as JSON and one as an event stream with a comment line, a priming event and a progress notification before the answer; a DELETE at the end.
- Only the two tools the config names were offered; the third was refused as unknown. Each result came back inside the review's data markers.
- The misbehaving addresses: a stream that never ends was given up at the limit, and the server saw the connection closed; a redirect was not followed; an `initialize` refused with only a newer revision listed, and a 401, each ended as a status with a short code.
- A pull request from a fork, and one of unknown origin: nothing was asked.
- Whole reviews with a stub model through the real client: two lookups and a review in three requests; a turn of refused calls only, then the closing turn; an endpoint that refused the tools, then a second try without them; nine calls asked, eight sent. Each review ended with its finding, and the server saw one DELETE for each.
- A sample event was accepted; with no way out its job failed at its first step and was put back, as on `main`, and nothing reached the MCP server.
- Every log line of the service was one JSON object, with none of the run's secrets, the header's value, the address's query, a call's arguments or a result's text. Everything the run made was removed.

## What the paid trial showed

On 2026-11-23 the engine was run against real models through the first endpoint the project supports, with the real MCP client and the run's own MCP server on the local machine. Seven small runs.

- **Under `forced`, with a model that accepts a named tool:** three runs, one request each. The model submitted its review without calling a tool. The endpoint accepted the tool definitions, also one whose schema carries `$schema`, a `format` and a `oneOf`.
- **Under `auto`, with a model whose endpoint refuses a named tool:** with no server, one request, answered by a call to `submit_review`. With a server whose calls fail: the model called the search tool, the failure ended the open turns, and the closing turn, with the model's reasoning sent back and the tools still listed, was accepted and answered by `submit_review`. With a working server: the model called the search tool once, was shown the result as data, and submitted a review with a finding that the runs without the lookup did not have.
- No tokens were read from a cache on a second turn for that model.

**Still not verified**

- A real documentation server, and what its answers do to findings and cost: the replay runs without tools.
- A model that keeps calling until the cap, with a real model.
- A review through the service against GitHub with servers named.
- A fallback model that takes over in the middle of a loop and is sent the first model's reasoning.
- What a cache does across the turns of a loop, for a model family that caches by itself.

## For the owner to decide

- **Which models to run on.** The engine now runs on a model that refuses a forced tool call when `toolChoice` is `auto`. Nothing was measured of what such a model's reviews are worth: the replay has not been run on one.
- **The newest protocol revision** (decision 1) is not spoken.
- **What tools cost and gain is not measured** (call 35). It needs a deployment with a real documentation server.
- **The limits are starting values:** 8 calls for a review, 4 open turns for one model call, 8,000 characters for a result, 30,000 tokens of room, 10 seconds to open a server, 30 for a call, 5 servers of 20 tools.

## Known and left as they are

- A review can ask the model 50 times at worst, where it could ask 36 times before. With tools offered, room is kept for what the loop appends, so the same pull request can need more batches even when the model never calls a tool.
- Under `auto`, a model that calls a tool again on the closing turn and on its retry fails that batch as invalid output, where with no server named it would have passed. It is the one way a named server can cost a review, and the record names neither the tools nor the server.
- With an input budget for one call under about 34,000 tokens the tools never fit: every review opens the servers, records that there was no room, and nothing alerts.
- A slow server can add about 10 seconds at the open, 30 for each of the 8 calls and 1 at the close to one review, about four minutes at worst, and the job holds its place for that long. One that hangs at the open adds 10 seconds to every review; one whose call passes its limit is not called again in that review.
- An endpoint that refuses the tools raises one `mcp_error` for each server, and the next good review one `mcp_ok` for each.
- A batch already running with tools when they are withheld ends as it will, at the cost of one more refused request.
- A service stopped in the middle of a review leaves a session open on the server until the server drops it. A session that arrives after the open limit is closed when it arrives, which can be after the review returned.
- A tool named in the config that a server lists after its first thousand tools is not offered.
- A session issued by an `initialize` that then fails is not ended by the client: the server drops it.
- Under `forced` with tools, a closing answer whose arguments are empty text is sent back as an empty message, and an answer of white space only is sent back as it is, under both choices.
- A result can still hold a look-alike of the end marker made of visible characters, such as letters of another script: it needs a hostile server that has learned the review's token.
- No test fails if the one line of the service's entry that calls the tested wiring function is given other arguments.
- The lint does not refuse an import written with a leading `./../` from the MCP part, nor a dynamic import there.
- A config's `url` may hold a query; a secret must not be written there. The address appears in no log.
- A description keeps its line breaks, and a schema keeps `$schema`, `$ref`, `format` and `oneOf`.
- The eval commands read the same config, so they need the variables of a server's headers set, though they open no server.

## Not verified

- What the trial did not reach: see "Still not verified" above.
- The event-stream grammar and the JSON-RPC error numbers were built from the brief's memory of the standards, and checked against a reference reader and a small server of the reviewers' own, not against a server written by someone else.
