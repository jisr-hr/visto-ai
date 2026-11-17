# Notes: Score Engine and Backtest plan

These notes record what happened while `2026-11-17-score-engine-and-backtest.md` was built: the decisions taken where the plan was silent or wrong, what the final review left open, and what was put off. Where the plan and these notes differ, the notes say what was built.

## Status

- Tasks 1 to 15 were built on the branch `stage-3`, one implementer and one independent reviewer per task, then a review of the whole branch, one fix wave of fifteen items, and one re-review of that wave.
- At the end of the wave: 699 tests pass, the type check and the lint are clean, source and tests are ASCII.
- Task 16, the paid measurements, was not run. It needs the owner's go-ahead.
- The re-review left three things open. They are listed under "Open after the final review".

## Decisions taken while building

Each has what it costs if it is wrong.

**Before the first task**

1. `parseAnchor` trims surrounding spaces before matching. The plan's test asked for it and its prose did not. Cost if wrong: an anchor with stray spaces is accepted instead of dropping its part.
2. Task 7 also added one forwarding line for the new source method to `review.ts`, which was not in its file list. The type check needs it. Cost if wrong: none.
3. `read-source.ts` keeps exporting `ReadOnlyViolation` after the transport moved to `http.ts`. Cost if wrong: none.
4. `runPool` took the shape of the loop the findings replay already had, not the signature the plan sketched. Cost if wrong: a helper signature that differs from the plan.

**During the tasks**

5. Tasks 1 and 2 were built and reviewed together. Both are small and independent. Cost if wrong: one review covered two unrelated diffs.
6. The size tie-break test uses the path `tmp/a.rb`, not the plan's `misc/a.rb`. With the plan's value the test passed with the tie-break removed. Cost if wrong: none; the test is stronger.
7. Four wording points of the contract were fixed in the same round as its one important finding, although minor findings normally wait. The contract's wording is what the paid runs measure. Cost if wrong: one fix round was larger than the process allows.
8. Team patterns are matched by a small matcher of the project's own, not by Node's `path.posix.matchesGlob` as the plan said. Node's function does not let `*` or `**` match a name that starts with a dot and does not match `*.rb` below the root, so a protected folder missed its `.env`. The rules follow ignore files: a name with no slash matches at any depth; a slash anywhere but the end ties a pattern to the root; a pattern that names a directory covers everything under it; the wildcards are `*`, `?` and `**`; a leading `!` is refused; `human_review:` with no value is an empty list. No regular expressions, so a pattern cannot make matching slow. Cost if wrong: a pattern may match more than a team expects, which only sends more to a person.
9. On a block of 30 changed lines or fewer that comes with `parts`, the highest part's score stands only when every part is valid and together they cover every changed line. Otherwise the block has no score and counts as 100. The plan claimed the score could never come out lower than the model meant; that was false when a part was dropped or lines were left out. Cost if wrong: more short blocks count as 100 when a model splits sloppily.
10. Links and `@` mentions inside model-written text (a score's reason, like a finding's body) are written as they arrive. Whether to make them inert is a policy question for the owner, to be settled before anything is published (stage 4). Cost if wrong: a model steered by hostile text in a pull request could put a link or a mention in a review body once publishing exists.
11. When the importer picks the head a person first reviewed, a person's reply inside a bot's thread counts. The head only marks where a person first engaged; the labels are what leave such replies out. Cost if wrong: a few cases are replayed at a slightly earlier head.
12. `linesOf` lists a context line on both sides, with its old number on the old side and its new number on the new side. The design counts a comment on a context line, and GitHub records a comment in the left column with the old number. What the model is shown did not change. Cost if wrong: none for the score.
13. In a history file, a thread started by any bot is left out of the labels, not only this project's own bot. Imported history predates the app and cannot tell bots apart. This departs from section 6.6, which names only the bot's own finding threads. The backtest counts the comments left out this way. Cost if wrong: fewer blocks are labelled, and the direction of the effect on Safety is not known.

**In the final fix wave**

14. A file with an added or removed line that holds a character the engine strips before showing the diff gets a file-level 100 (`hidden_characters`) and is not covered. The final review showed a change made only of such characters scored as a rename at 30 with no model call. Cost if wrong: files with a byte order mark, joined emoji or direction marks on a changed line, right-to-left text among them, go to a person. The backtest will show how often.
15. A block that an answer named but scored unusably is voided: it counts as 100 even when the file has a whole-file score. Duplicate items for one block take the highest score, or void the block if any of them is unusable. Duplicate entries for one file are pooled. Cost if wrong: more files count as not scored when a model answers sloppily.
16. For the team's file only a 404 means "no file". Content that is not text or is too large makes the file unusable, which floors every file and says why. A file saved as UTF-16 used to make a team's floors vanish silently. Cost if wrong: none; it fails closed.
17. A team pattern with a backslash, a brace, or a `.` or `..` segment is refused. Brackets stay ordinary characters, because folders such as `app/[id]/` are common. The review result and body carry the reason a file is unusable. Cost if wrong: a team that writes a character class in brackets gets a pattern that matches nothing; the README says brackets are literal.
18. The engine and the labels read every patch through one function, `hunksOf`, so the hashes of the replayed diff and of the final diff are computed alike. Strict labels were wrong for files with `\r\n` line endings. Cost if wrong: none.

## Open after the final review

The process allows one fix wave. The re-review of that wave confirmed thirteen of its fifteen items and left these open. Each is real; none can make the engine say "no person needed" for a change it was shown correctly.

1. **Carriage returns at the end of a patch.** A file with `\r\n` line endings is flagged `hidden_characters` whenever the service's patch ends on an added or removed line, because that last line keeps its carriage return with no line feed after it. Every added or removed file with such line endings therefore counts as 100, with the wrong reason. It fails closed, but it distorts Benefit and Focus in a repository with such files. Fix: when scanning a patch from the service, drop one trailing carriage return from a line unless the next line is the no-newline marker; never drop one for a patch computed from two contents.
2. **A lone carriage return.** A carriage return added at the end of a file's last line, when the file has no final newline, is not flagged: the model is shown two identical lines and its score stands. The same rule as in point 1 closes it.
3. **Five malformed answers that still resolve to the lower score.** An invalid whole-file score with every block scored low; the same across two entries for one file; a long block whose second part overlaps the first and carries the higher score; a split with a rejected part followed by a plain score for the same block; one item that has both a score and parts. Each needs a malformed answer, so it is rare, but it is in the costly direction. Fix, three rules: an invalid whole-file score voids the file; any dropped part voids its whole block, long or short; an item with both a score and parts voids its block.

Until point 1 is fixed, a backtest on a repository with `\r\n` files will over-count what needs a person.

## Text in the plan that these decisions made stale

- Tech Stack, call 5, and Task 7 (the pattern rules and `matchesGlob`): see decisions 8 and 17.
- Call 2 and Task 8 (parts on a short block; the first of two entries; the tie order; what a whole-file score covers): see decisions 9, 14 and 15.
- Shared Types and the Task 3 test (`lines` of a block): see decision 12.
- Task 15 (`runPool`'s signature): see decision 4.
- Task 10 (the text for an unusable team file): see decision 17.
- `HistorySource.listMergedPullRequests` returns the pull requests and a flag saying the listing ran out of pages.
- `ReviewResult` also carries `teamFileInvalid`; `FileContext` also carries `hidden`; the backtest summary also carries the models that answered and a hash of the contract.

## Put off

**Before stage 4 stores blocks or publishes anything**

- `linesOf` returns empty ranges, and `splitBlock` throws, for a block that `blocksOf` did not build. Make both throw.
- Part ids are numbered unevenly after a dropped part. Stage 4 decides the stored keys.
- The `Human review` list sits in the part of the body that is cut first when a body is too long. Only the sentence in `Overall` is protected.
- Link tests for `.` and `..` path segments.
- Replies inside this app's own human-review notes must count as labels once notes exist; the history file has no field to tell a note from a finding.
- A pull request whose comparison returns no files while it has commits should need a person. The source would have to report the commit count.
- The strict label uses the whole hunk's hash, so a later change next to a block that merges into its hunk makes the block strict.
- A comment that spans lines is read on one side only; the history file has no start side.
- After a split, a context line outside every part belongs to no block, so a comment there labels the file only.

**Small, can wait**

- No test for an unknown key inside an override's score block; the review test's token limit is fragile; no test pins the part's required fields in the schema the model sees.
- The author's login is compared with regard to case when deciding who is a person; a review and an inline comment at the same instant resolve to the review with no test.
- `score-noise` on a file that is not valid JSON exits with an unexpected error, not a usage error; its model warning compares lists in first-seen order.
- The findings replay's removal of its result file before writing has no test of its own.
- `PAGE_SIZE` is defined in two files; `"blocks": null` in a file entry still rejects the answer; an empty-string patch on a rename is taken as unchanged without fetching the contents.
- Two sentences of the contract are clumsy though unambiguous. Change the contract only together with another change: each change costs a re-run of the measurements.

## Not verified

- Nothing in this plan has run against a real model or the real git service. Every test uses stubs.
- Two behaviours of the git service the final review could not check offline: whether a merged pull request's recorded base gives the merge base its reviewers saw, and whether a comparison can come back with an empty file list for a very large diff.
- How often a model's answer is cut by an output limit now that it carries one entry per block.
