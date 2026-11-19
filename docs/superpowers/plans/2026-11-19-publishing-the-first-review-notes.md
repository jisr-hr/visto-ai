# Notes: Publishing the First Review plan

These notes record what happened while `2026-11-19-publishing-the-first-review.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, and what was put off. Where the plan and these notes differ, the notes say what was built.

## Status

- Before the build, the plan was reviewed by a stronger model than the one that wrote it. It found three critical and fifteen important defects and about fifteen minor ones. Every critical and important one was applied to the plan before its first commit, which is why the plan has nine tasks and not the ten of its first draft.
- Tasks 1 to 9 were built on the branch `stage-4c`, one implementer and one independent reviewer per task. Tasks 2, 6, 7, 8 and 9, the ones that hold the queue's rules, the money and what is posted, were reviewed by a stronger model, and Tasks 7 and 8 were also built by one.
- Four tasks needed fix rounds, each re-reviewed: Task 1 four (see decision 8: the rule it was given was wrong three times), Task 5 one, Task 7 one (a gap of the plan, decision 14) and Task 9 one (decision 18 and the README).
- Then a review of the whole branch by the strongest model, one fix wave, and one re-review of that wave by the same model. The whole-branch review found one critical defect (decision 19) and one important one (decision 20); both are fixed. The re-review found every point of the wave addressed and nothing critical or important, and left five minor points. One of them was a behaviour the wave itself had made worse, and it was fixed in one more small pass, together with four sentences of the README (decision 26). That pass was checked once more, narrowly, and found sound; one more sentence of the README was then corrected by the builder without a further review. The other minor points are under "Put off".
- At the end: 1,245 tests pass, the type check and the lint are clean, source and tests are ASCII.
- Task 9's real run, under Docker on the builder's machine with the app cut off from the outside, passed. What it showed is below. It was made before Task 9's fix round and before the final fix wave.
- Nothing has been checked against a real GitHub App or a real model call. No review has been posted anywhere by this code. See "Not verified".

## Decisions taken while building

Each entry says what was decided, why, and what it costs if it is wrong.

**Before the first task**

1. What the earlier plans called plan 5 was cut in two. This plan publishes only the first review of a pull request, the `/review` command and the check of the app; threads, later heads, the other review modes, scores across reviews, inline notes and the app manifest are left to a plan 6. A second review cannot be published responsibly without following up the first one's threads, and one plan for all of it would have had over twenty tasks. Cost if wrong: a deployment out of dry run reviews each pull request once until plan 6 is built.
2. The owner's open decision on mentions and links in text the model wrote was taken as: mentions made inert, links left (call 1). The plan publishes for the first time and could not wait on it. Cost if wrong: a mention the model meant is not delivered.
3. No clock is compared to find out whether an earlier attempt already posted a review. Before posting, the job lists the reviews of the app's own account on the pull request: one on this commit is adopted, one on another commit means the pull request has its first review (call 5). The first draft compared the host's clock with GitHub's. Cost if wrong: an old review by the same app, from before a database was reset, stops a new first review.
4. Raw HTML the model wrote is shown as text (call 17). A promise that nothing is hidden cannot be kept by neutralising comment openers alone. Cost if wrong: a table or a details block the model wrote on purpose is shown as its source.
5. What the app lacks is worked out inside the GitHub adapter, so GitHub's names for permissions and events stay in one file.
6. A `/review` whose head moves while it is reviewed starts over once, as a new job; a second move ends it with an answer and leaves the new head to an automatic job.
7. A command from someone without access never pushes another job out (call 18). In the first draft it replaced the waiting job and was then refused, so the head lost its review.

**During the tasks**

8. Task 1, the rule for text the model wrote. The plan first left "code" alone, by a rule of its own for what a code span and a fenced block are. Three reviews in a row each showed, by running the code, another construct for which GitHub's reading differs from that rule and a mention stays live: a fence inside a list item, a run of backticks left open on an earlier line, a backtick in a link's address or title, an address GitHub links by itself. The rule that was built in the end asks no such question: **only a fenced block is code. Outside it nothing is rewritten, and a zero-width space is put after the `@` of a mention, after a `<` that could start HTML, and after the `&` of a character reference.** That reads the same inside an inline span as outside one. Cost: inline code that holds `@name`, `<tag` or `&name;` carries an invisible character, which breaks it when it is copied into a source file or searched for. Code in a fence is untouched.
9. Task 1, fences. A fence's opening and closing lines are honoured when indented by at most three spaces and are written at the first column, where a fence line means the same to GitHub whatever came before it. Leading tabs are written as spaces outside a fence, and inside one on a line that would close it if it were indented less, because under a bullet a tab reaches another column than at the top level. A fence left open is closed. Cost if wrong: a fenced block that sat inside a list item is shown outside the list; a snippet outside a fence loses its leading tabs.
10. Task 1. An underscore before an `@` does not protect it (emphasis takes the underscores of `_x_@name` away). A line of `=` or `-` under a line of text is escaped, since it would make that line a heading; a `#` or such an underline that follows quote or list marks is escaped too. Headings are not escaped inside a fence. Indentation alone, beyond three spaces, escapes nothing, so a heading can still be forged inside a list item whose text starts four or more columns in, where it is indented and visibly not the service's. The wider rule would have put a backslash before every `#` of an indented code block.
11. Task 1. The pattern for a fence's opening line takes every character. JavaScript's `.` does not match the line and paragraph separators (U+2028, U+2029), which do not end a line for GitHub, so a fence whose first line held one was a fence for GitHub and not for the service.
12. Task 5. The receiving path reads the clock once for each delivery; the capture, a push's job and a command's job all use that time.
13. Task 6. `publishRun` posts at most twice in one call, the second time only after GitHub refused the inline comments, and never after any other failure. Whether a failed post created a review is found out by the next start, which lists the app's reviews first.
14. Task 7, a gap of the plan. Out of dry run, a start that has no recorded review to publish asks GitHub for the app's own reviews before the model is called: one on the live head drops the job as `already_reviewed`, one on another commit as `later_head`. Without it, a review that is on the pull request but not marked in the database (a mark lost three times and then a push; a database that was reset) made every later head pay for a review that could then only be answered "already reviewed". Cost: one more request to GitHub for each first review.
15. Task 7, left as it is. A recorded review whose insert was saved while its answer was lost is followed by a second row for the same review. Nothing is posted or paid twice; the daily limit counts that review twice for a day.
16. Task 7. After three failed tries to mark a review as published, the log entry says `published: true` beside `outcome: record_failed`: the review is on GitHub and the database does not know yet. The next start adopts it.
17. Task 8. A command whose review could not be recorded is not answered, since its job is not over and an answer before a finish could be written twice. The automatic job stored when a command's second try meets a moved head has the reason `synchronize`. A refusal whose own finish fails three times is logged as `refuse_failed`. A command that starts over gets its eyes again.
18. Task 9. Dry run is the default: a config that does not write `dryRun` runs in dry run, and the service posts only when the operator wrote `dryRun: false`. The design names no default, and after this plan a missing line would otherwise have been what starts posting in public.

**In the final fix wave**

19. What is recorded is what was rendered. The storage layer removes NUL characters from a text, after the text was made inert, so `@`, a NUL and a name were stored as a live mention, and a later start that posts a recorded review would have posted it. `renderReview` now returns text that storing does not change: a NUL becomes U+FFFD, which is also how GitHub reads it.
20. A refused command stores the automatic job of call 18 only when the pull request's stored head has no recorded run in the service's mode, not counting a run whose own job was dropped as superseded. As first built it stored one always, so a commenter without access could make the service run a review again that had failed after model calls, paid each time. Cost if wrong: a head whose only job ended in failed reads is not tried again by a stranger's comment; the next event does it.
21. Links keep working in two cases that decision 8 had broken. Inside an address (a run of characters with `://` before it) an `@` that could start a mention is written `%40`, so no `@` is emitted and no mention is possible either way. A `<` directly before `http://` or `https://` gets no zero-width space, so a link in angle brackets stays one. Cost: an address that carries a user name before its host stops working; a relative link that holds an `@`, and an address that holds a character reference, still get the invisible character.
22. The service writes its own brackets escaped (`**\[major]**`), so a line of the model's that defines a link named `major` cannot turn the service's tags into links.
23. A `/review` whose job is put back while another job for the pull request is waiting, and is dropped for it, is answered with `superseded`.
24. The writer does not follow redirects: a renamed repository's answer is a failure, not a followed read that counts as a write.
25. The test for a short code, and the set of associations that may give a command, each have one definition.
26. One more small pass after the wave's re-review, beyond the one wave the process allows. The rule of decision 20 was first built without its last clause, and then a refused command that had superseded the head's own job (it arrived while that job ran, and the job was put back) left the head with no job and a recorded review unposted. The clause, and four sentences of the README that were narrower than the code, were changed and checked once more.
27. Left as they are: an app check that could not be made raises no alert (it is logged; redelivery raises one in the same situation); the requester's login is written into the review as GitHub's signed event gave it.

## What the reviews found that the plan had wrong

- Task 7 could not have compiled as first planned: the writer it needs was wired in a later task.
- A stranger's `/review` evicted the waiting job and was then refused (decision 7), and, as built from the corrected plan, could still make the service pay again (decision 20).
- The rule for what counts as code in the model's text (decision 8). The planner wrote it three times; each version was shown wrong by running it.
- The first draft compared two clocks (decision 3), answered a refusal before recording it, and shipped an example config that would have posted from the first start.
- The plan did not ask GitHub before paying (decision 14), and left `dryRun` false when not written (decision 18).
- The storage layer changed a text after it was made safe (decision 19). No task's review could see this; it crosses the renderer, the database and the publication.

## Text in the plan that these decisions made stale

- Task 1: the first test blocks expect `&lt;`, `&amp;` and inline spans left as they were. The plan says so at the section that replaces them. The rule for links (decision 21), the service's escaped brackets (22) and the NUL step (19) are not in the plan.
- Task 2 has no `hasRun` (decision 20).
- Task 7: every start out of dry run that is not resumed begins with one read of the app's own reviews; the plan says so after the task's rules.
- Task 8: step 6 lists `record_failed` among the answers; it is not answered (decision 17), and `superseded` is (decision 23). The refusal's automatic job is conditional (decision 20).
- Task 9: the example config's comment and the README are as built, not as the task's list has them; `dryRun` is true when not written.
- The plan names `HAS_ACCESS` nowhere and a `codeOf` in three places; see decision 25.

## What the real run showed

Task 9, Step 4, under its own Compose project on the builder's machine, on a network with no way out, cleaned up afterwards. It was made at the head before Task 9's fix round and before the final fix wave, with `dryRun: false` written in the config.

- The previous release was built from the `main` branch and started first, in dry run, on a fresh database. It was sent three samples and left two migrations in the ledger, one waiting job and one failed run.
- The new release started on that database. Its ledger then held `0003_publishing`; the old job read back with `trigger = 'automatic'` and no requester, the old run with `published = false`.
- It logged `recovery`, `listening`, a `model_check` whose result was `unknown`, and a `start_step_failed` for `app_check` whose `reason` was `github_network`, since nothing was reachable. It kept running and took up the job the previous release had left.
- An `opened` sample was answered `202 accepted`. Its job failed at `prepare` with `github_network` and was put back. No row of `review_runs` was marked published.
- A `comment` sample with `--body /review` was answered `202 accepted`, and the log entry carried `command: review`. The waiting automatic job became a manual one in place: `trigger = 'manual'`, the requester, the comment's id, the association and the installation stored. Its start failed at `prepare` and was put back. Nothing was written to any pull request.
- With `psql`, on rows made by hand: an automatic job with replace against a waiting manual job returned no row and left it whole; a manual job without replace against a waiting automatic job returned no row and left it whole; a manual job with replace took the automatic job's row; the statement that marks a publication, run twice on one row, wrote it once.
- The whole log was 11 lines of ids, codes and counts. It held no payload text, no key and no address. The app stopped with exit code 0 in under a second.

## Put off

**To plan 6 (later heads and threads)**

- Threads, verdicts, a second review of a pull request, the incremental and recheck modes, scores across reviews, inline notes, the app manifest. Until then a pull request gets one review.
- A posted review whose mark was lost on the job's last start is never adopted: recovery puts the job back with its starts used up and the runner drops it. Nothing is paid or posted twice, since the job asks GitHub first, but `review_runs` never learns that review's id.
- Reviews recorded in dry run are never posted after the switch to `dryRun: false`.

**Known limits, left as they are**

- A manual job the runner gives up on (out of starts, or a day old) gets no answer. A waiting `/review` keeps every push's job out; if it then grows too old, the head has no job until its next event.
- Until a first review is published, every push gets a paid review, and one that lands while a review runs makes that review unpublishable. The daily limit is the only guard. With `pull_requests` write missing, each push pays for a review that cannot be posted; `feature_off` at start is the only warning.
- A heading inside a list item whose text starts four or more columns in is still a heading there (decision 10). A `#` line of a code block that is fenced inside a quote is shown with a backslash, and so is a rule in a quote.
- When the answer of the statement that puts a job back is lost after it was applied, the retry reads the job as superseded: a `/review` is then answered `superseded` although its job is waiting, and the review follows at its next start. It is the one path on which an answer is written before its job is finished.
- An event that brings no new head (a new base, a reopening) and is kept out by a stranger's waiting command, at a head that already has a run, gets no job from the refusal.
- A comment from someone without access, timed to the moment a job is put back, gives that head a fresh job through the refusal, with its starts counted from the beginning. Only starts that cost little or nothing repeat this way (a failed read, a refused key); a recorded review is posted, not computed again.
- The second row for a review whose record's answer was lost (decision 15).
- An invisible character inside inline code (decision 8), and the links that still break (decision 21).
- A check of the app that failed at start is not made again until the next start.
- `issues` write may not be needed where `pull_requests` write is granted; the service asks for both.
- Links the model wrote are left as written and can create cross-reference entries on the issues they name.
- The eval commands keep their own copy of the short-code pattern.

**Small things the reviews left**

- `recordComments` stores one comment at a time with no transaction of its own (safe to repeat).
- The stored comments reach the writer through a cast; the writer copies their four fields one by one.
- An adopted review's comments are read twice.
- A failed run of a manual job whose pull request could not be read has an empty head.
- A `command_retry` job replaces any waiting job, also another member's waiting `/review`, whose comment then gets no answer.
- The request headers for GitHub are written in two places (the read side and the write side).

## Not verified

Nothing here has met a real GitHub App, and no model was called by the service. Each of these needs an app on a scratch repository and the owner's go-ahead:

- Everything in the plan's "To verify with a real app": that a review posted with an installation token appears pinned to its commit with its inline comments, and that a comment off the diff is refused with a 422; that the app's own reviews are listed under `<slug>[bot]` with the account type `Bot`; what `GET /app` answers; that the comment list names each comment's review; which permission a reaction and a general comment need; the association GitHub reports for a commenter; that a zero-width space stops a mention, a tag and a character reference, also inside inline code; that a fence line at the first column opens a fence right after a list item's open fence; one whole first review and one `/review`.
- Added by the final review: what GitHub does with a NUL or an invisible character in a body before it looks for mentions; whether `#12@name` is a mention once GitHub has linked the first part; a line that defines a link named like one of the service's tags; the status GitHub answers to a write on a renamed repository.
- The real run did not reach GitHub or a model, so it shows no publication and no app check with a real answer; and it was made before Task 9's fix round and the final fix wave, which ran only in tests.
- CI on Linux has not run for this branch.
