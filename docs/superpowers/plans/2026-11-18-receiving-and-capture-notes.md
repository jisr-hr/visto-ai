# Notes: Receiving and Capture plan

These notes record what happened while `2026-11-18-receiving-and-capture.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, and what was put off. Where the plan and these notes differ, the notes say what was built.

## Status

- Before the build, the plan was reviewed by a stronger model than the one that wrote it. Its three critical and eight important findings were applied to the plan.
- Tasks 1 to 9 were built on the branch `stage-4a`, one implementer and one independent reviewer per task. Tasks 5, 7 and 8, the ones that face the network or the database, were reviewed by a stronger model.
- Two tasks needed one fix round each: Task 7 (one finding) and Task 8 (three). Both rounds were re-reviewed.
- Then a review of the whole branch, one fix wave of six items, and one re-review of that wave. Nothing from the reviews is open.
- At the end: 950 tests pass, the type check and the lint are clean, source and tests are ASCII.
- Task 9's real run, under Docker on the builder's machine, passed. What it showed is below.
- Nothing has been checked against a real GitHub App. See "Not verified".

## Decisions taken while building

Each entry says what was decided, why, and what it costs if it is wrong.

**Before the first task**

1. Stage 4 is cut in three plans. The review modes, a pull request's earlier state and the scores carried across reviews move from the second plan to the third, with publishing: a dry run never counts as an earlier run (design 11.1), so they cannot be exercised before something is published. Cost if wrong: the plans are regrouped; nothing built here changes.
2. No implementer was given the predecessor's source. Every rule carried over is written out in the plan under its `PM-` key. Copied fixture text is the known risk of handing the old code over, and nothing in this plan needed it. Cost if wrong: an edge case only the old tests knew is missed.
3. Three minor points of the plan's review were left. `server.port` and `PullRequestAction` stay, the first read by the service entry and the second by the next plan's triggers. A comment its author later deletes stays as stored (call 7). Cost if wrong: one type unused for one plan, and stored text of comments their authors deleted.

**During the tasks**

4. Task 2 changed one test of Task 1, which asserted that no migration was applied, and added a helper the plan does not name, `storableOrNull`, for text that may be null. Cost if wrong: none.
5. Task 4 made four choices the plan left open. A payload that is not an object is `malformed` for every event, `ping` included. An unknown action is reported before the event's fields are checked. A missing `merged` counts as not merged. The owner and the repository name keep the sender's letter case in an event; the `db` part lower-cases them. Cost if wrong: an odd payload is recorded under another reason.
6. Task 7, the 413 for a body that grows past the limit. As first built, leaving the read loop destroyed the request, and with it the connection, before the answer was written. The fix reads the body by calling the iterator by hand and never returns it, and both 413 answers carry `connection: close`. Unit tests could not see the defect, because their requests have no connection. Cost if wrong: none seen; the real run confirmed the answer arrives.
7. Task 7, the memory a caller with no secret can make the service hold. The 25 MB limit and the cap of 20 stand (call 18): the limit is the largest payload the sender documents, and a lower cap answers real bursts `busy` while nothing redelivers them yet. What was added: a request timeout of 30 seconds and a headers timeout of 10 seconds on the server, and a plain statement of the worst case in the README. Cost if wrong: a small host can be pushed out of memory by 20 callers; it restarts under Compose.
8. Task 8, the type of a database client was too narrow. `ClientLike` gained `on` and `off` for the `error` event and `release(destroy?)`. A client checked out for a transaction has no error listener of the pool's, so a connection lost during a transaction would have ended the process; the transaction now attaches its own. A client whose rollback failed is destroyed, not handed back. Cost if wrong: none; a wider type that the library's own client satisfies.
9. Task 8, stopping is bounded twice. After the wait for requests in flight (10 seconds), closing the database waits at most 5 more seconds (`CLOSE_WAIT_MS`), because a pool closes only when every statement in flight has returned. No statement timeout is set on the pool: migrations run through it and may rightly take longer. Cost if wrong: a transaction still running 15 seconds after the stop signal is cut when the process ends; Postgres rolls it back and the sender shows the delivery as failed.
10. The plan was amended twice while it was built, for decisions 7 to 9, so that later tasks were written from text that matched the code.

**In the final fix wave**

11. The README's memory figure was half the real peak: a body is held twice at the moment it is joined into one piece. The README now says about 500 MB while bodies arrive and about twice that at the join, that a slow caller can hold a place for up to about a minute, that twenty such callers take every place, and that Compose publishes the port on every interface.
12. The reader now refuses what the database would refuse. A time whose year is outside 1970 to 9999, and an owner, repository name, review id, comment id, reply-to id or thread id over 200 characters, make an event `malformed`. A delivery id over 200 characters is `no_delivery_id`. Before this, such a delivery passed the reader and was answered 503 on every redelivery, against Review Focus 4. A thread's root comment id has no length check: it is read only as a whole number. Cost if wrong: a real id longer than 200 characters would be recorded as malformed; none is known.
13. `stop` never rejects, as its comment says. A listener that fails to close is logged as `listener_close_failed` and stop goes on; a logger that throws inside stop changes nothing.
14. The test of the migration ledger asserts that `0001_receiving` is among the applied names, not that it is the only one. The next migration would have broken it.
15. The redundant test of Task 6 was deleted, `.dockerignore` gained patterns that match in subdirectories, and the README's layout table gained the new parts.

## What the reviews found that the plan had wrong

Three of the findings were defects of the plan, not of the code written from it.

- The plan's first version put an error listener on the pool only. A connection in use has none. Found by reading the library's source in Task 8's review.
- The plan's stop closed the database without a limit.
- The plan promised that nothing the reader returns can be refused by the database, and gave the reader no check on a year or on the length of an id.

## Text in the plan that these decisions made stale

- Task 7 says every answer has two headers. The two 413 answers have a third, `connection: close`.
- Task 7's log entry: for a bad signature the log's reason is `bad_signature` while the answer's body is `invalid_signature`. The `deliveries` table records `handled` where the log and the answer say `accepted`.
- Task 4's list of what is `malformed` lacks the year range and the length of ids (decision 12).
- Task 8: `stop` also logs `listener_close_failed`, `database_close_timeout` and `database_close_failed`.
- Task 9's sentence for the README gives the memory worst case as about 500 MB. See decision 11.
- Task 9's expected result speaks of "the comments". The sample comment has a fixed id, so sending it several times stores one row.
- The ledger kept during the build said that a stop signal during migrations kills the process. In the container the process is process 1, and the kernel drops a stop signal that has no handler, so the container is killed at the end of the grace period. Nothing is lost.

## What the real run showed

Task 9, Step 5, under its own Compose project on the builder's machine, cleaned up afterwards. This was the first run against a real Postgres and through a real connection.

- A delivery is answered `202 accepted`, the same id again `202 duplicate`. Two with one new id sent together gave one `accepted` and one `duplicate`.
- The tables held the pull request of the sample, one review and one comment, and one row per delivery id.
- A 26 MB body was answered `413 payload_too_large`, both when it declared its length and when it was streamed without one.
- After the database was restarted, the app was still running, had logged two `database_error` entries with a code, and accepted the next delivery.
- The app stopped with exit code 0.
- The log held one JSON line per delivery and no payload text.
- No difference was seen between the two Postgres clients.

## Put off

**Before the next plan (the queue and review jobs) builds on this**

- The in-process database used in tests has one connection. A query made outside an open transaction waits for it, and nothing concurrent, such as claiming a job or keeping one job per pull request, can be tested on it (design 20, item 5). The next plan needs another way to show those queries are right.
- `commit` after a statement error that the work caught and ignored resolves, so the delivery would be answered 202 and not stored. No code does that today. Nothing inside a transaction may catch a statement's error and go on.
- The pool has five clients, no statement timeout and no TCP keep-alive. Jobs will share it with receiving. One statement that never returns holds a client until restart while the health route answers 200. A timeout set inside the receive transaction would leave migrations alone.
- Signal handlers are installed only after the service has started. Start-up recovery will lengthen that window.
- The owner and the repository name are lower-cased only inside `db`. A key per pull request kept in memory must lower-case them too.
- A delivery recorded as ignored, `malformed` included, is marked as seen. After a fix to the reader, a redelivery of it answers `duplicate`.
- `stop` closes the listener first. The drain of design 8.2 keeps accepting webhooks while reviews finish.
- After a database close that timed out, the process ends only when the container is killed, so its exit code is not 0.
- Request timeouts are checked every 30 seconds, so 30 seconds can be about a minute. Nothing bounds a request that is waiting on Postgres.
- An older event that carries the same "updated at" as a newer one and arrives later wins (call 10). It can turn a merged pull request back to open.
- Start-up when the database is ahead of the code logs an error name and no code, so the operator cannot tell why it failed.

**Before memory (stage 8) reads what is captured**

- Dismissed reviews, edits and deletions are not captured (call 7). A comment its author deleted stays stored and unmarked, and memory will quote from stored comments. Live capture and the history importer disagree on a dismissed review: the importer's list says `dismissed`, the live row keeps the state it was submitted with. Those events are acknowledged with only their id kept, so they cannot be replayed later.

**Small, can wait**

- Tests of behaviour that is right but unpinned: that the engine may not import a Postgres client; a secret or a database URL written inline in the config; a signature in upper case or with padding; `captureOf` or the clock throwing; a `begin` or a `commit` that rejects; more forms of URL for the sample tool; the year check on four of the six times that pass through it.
- Reachable only by a sender that holds the secret: a duplicate migration name in the list given to `migrate`; an installation id that is empty or not a whole number; a body with an invalid byte, which is decoded with a replacement character.
- Tidiness: a comparator written twice in `migrate.ts`; two sets of small helpers in `events.ts` and `objects.ts`; a defaults object rebuilt on every call of `captureOf`; one test in `service.test.ts` that checks three things; one test that does not close its in-process database; `why()` in `service.ts` reads an error's name outside a guard.
- Lint does not catch a dynamic import of a Postgres client outside the engine, nor an import of one of its sub-paths. None exists.
- Requests answered `busy`, 413 or 404 write no log line, and Docker's default log driver does not rotate.
- `npm audit` reports advisories of moderate severity in the lint tooling the project already had. None is in the packages this plan added.
- The README tells the reader to switch on the service's three blocks in the config without showing how.

## Not verified

- **Against a real GitHub delivery:** the nested field names of the five events. GitHub's reference lists actions and top-level fields, which were checked, and not the fields inside them. A wrong name means that kind of event is recorded as `malformed` and lost: watch the `reason` column of `deliveries` on the first real deliveries. Also unverified: that a review's state is in lower case in a webhook, that a reply in a thread arrives both as a comment and as a review (call 19), and that a redelivery keeps its delivery id.
- **On a real network:** that the 413 survives when the sender is still uploading, behind a proxy especially; the request timeout on a slow caller.
- **On a real Postgres:** `getPullRequest` and `listActivity` have run only on the in-process database. A connection lost without a reset is untested.
- **On Linux:** CI has not run on this branch.
- **Against the predecessor:** whether a rule known only to its tests was missed (decision 2).
