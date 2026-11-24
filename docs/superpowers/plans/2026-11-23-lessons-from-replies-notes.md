# Notes: The Lessons from Replies plan

These notes record what happened while `2026-11-23-lessons-from-replies.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run under Docker and the paid check showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built. This plan is the second of three for stage 8 of the build order; the third holds the records of reverts and both evals with memory as of each case.

## Status

- Lessons were cut in two plans by the planner, under the builder's rule that a plan is about twelve tasks at most: lessons made and shown here; reverts, the evals with memory and the measurement of what a lesson does next. So when this is built nothing has measured a lesson.
- The plan was drafted from the design, a map of the code written for it and a private study of how the predecessor learned from replies, and reviewed by another model before anything was built. That review ran every statement of the first task on the tests' database, and found two critical defects, five important ones and twelve minor; all were ruled on and applied before the first line of code (decisions 6 to 14).
- Tasks 1 to 9 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. The reviewers ran the code rather than read it: an oracle of their own written from the plan's rules against generated rows, replies, lessons and schedules; the parent's engine and service beside the new ones on the same inputs; hostile memories, answers and texts; and one-line changes to the code to see which tests would notice. No reviewer found wrong behaviour that reached a stored row or a request, except the two points of decisions 19 and 26; every task needed a round of added tests, and six of those rounds carried a small change to the code.
- Task 10's documents were written by an implementer from the code as built; the run under Docker was made by an agent of its own with throwaway secrets, and the paid check by the controller.
- Then a review of the whole branch by the strongest model. It drove the real service, review job, engine, learning pass, nightly judge and database-backed memory through twenty-seven hundred random lives of sixty steps each, with one stub model as reviewer and as judge: floods of replies, edits, kills inside a verdict's transaction and inside a judge call, stops, calls that hang, days down, a paused model, a tight daily limit, and in part of them a second scorer, the tool choice left to the model, or dry run. After every step it compared every row of the new tables, every request the judge was sent and the lessons of every review, byte for byte, with an oracle written from the plan: no difference that was the code's. No invariant was broken: no reply judged twice, no lesson made twice, no cap passed, no lesson from a stranger and none shown on its own pull request. No word of a reply reached a review through a lesson, and no log line held a word of a reply, a finding or a lesson, a login or a path. With `learning` not written the service was `main`, byte for byte, over fourteen hundred pairs of the same deliveries. With the same model answers, lessons shown against the same lessons switched off, the findings, scores and verdicts were equal wherever the packing was. It found nothing critical and nothing important, and four small points: three were fixed (decisions 29 to 31) and one written down (decision 32). The fixes were checked by another reviewer, again by running them: the judge's call beside its parent's on twenty-three hundred combinations of answers and stops, the rule for a lesson's text against a reference on a hundred thousand strings, and every statement the README gives on a migrated database. The code was right on every input it made; three more cases were given a test, and one sentence of the documents, on which later review's verdict counts, was corrected.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules, and its own section "For the owner" names the likeliest to be overruled.

**Before the plan was written**

1. **One switch** (call 24): `learning: true` switches lessons on with the rest of learning. Cost: a deployment that had switched learning on for signals now also makes model calls at night.
2. **The judge is the deployment's review model, through the client the reviews use** (call 11), with the tool choice the config writes. Cost: the judge is as dear as the review model.
3. **Reverts need no model, and are not in this plan** (call 1).
4. **With a second scorer named, lessons are shown to the review model** (call 20), since it still writes the findings; the signals stay not shown. The status of memory has a part for each.
5. **No idea the owner dropped returns** (call 25): no second pass that verifies a finding or a lesson.

**From the plan's review**

6. **The judge is sent a reply's own words, never its whole body** (call 8). As first written the judge was sent what the writer had quoted too, so a member who quoted a stranger and added a word of agreement could have made a lesson of the stranger's sentence. A reply with no words of its own is not sent.
7. **Of the replies a run takes, at most 20 are strangers'** (call 7). On a public repository strangers could otherwise have used up every night's calls, none of which can make a lesson.
8. **The choice by shared directory stays as the design orders it, and the plan stopped saying that it leaves much out** (call 18): in a repository under one top directory, or in one language, nearly every lesson matches nearly every pull request.
9. **A run that is told to stop sends the database nothing more** (call 16), so that the two tasks that touch a stop agree.
10. **What holds D8 for lessons is said as it is** (call 4): by structure only where a second scorer is named. The filter on words is described as what catches a judge that strays into scoring, and as no guard.
11. **The judge's request has the time limit a review's request has,** from the same key, where the plan first gave it a shorter one of its own.
12. **The rules shown with lessons say that only the blocks the service labels are lessons,** whatever a description or a file says.
13. **Each call of the judge is stored with its repository, its pull request and its reply** (call 17), so that its cost can be told by repository.
14. **The seed command asks for this plan's migration,** since the statement it writes with now names the new column.

**From the reviews of the tasks**

15. **A lesson's text loses every character that is ignored when text is shown, before its checks.** One such character inside a word hid it from the filter on words and from the check for a pull request number. Letters of another script that look the same are not closed.
16. **The choice of lessons throws nothing on what a source hands it,** and an empty path segment is no shared directory.
17. **The time reader is a module of its own.** Two modules of the memory part had come to import each other.
18. **Reading a model's answer throws nothing:** a response of any shape that is no call of the judge's tool is an answer with no verdict.
19. **The quote is looked for in the text the judge was sent,** which is the reply's own words up to their cut. As first built it was looked for in the whole of them, so a quote from beyond the cut, which the judge never saw, could make a lesson.
20. **The judge's rules say that fenced code blocks were left out,** which is what is left out. An indented block, `pre`, `q`, a table and an html comment stay in a writer's own words.
21. **The part of the prompt for lessons throws nothing whatever it is handed,** and reads at most 1,000 entries.
22. **A memory whose lessons cannot even be read costs the review its lessons, not the review.**
23. **A run asks whether it is stopped before its first read and before its last statement.**
24. **A run says that work is left whenever it ends with replies unfinished,** also when it ended at the cap, at a stop, at a pause or after provider failures; so a run that completes after a few provider timeouts says it too.
25. **A failed call's cost is still written,** and the spend guard is told of every call that was answered: both were built so, and held by no test.
26. **Two ticks that overlap start one run.** A tick trusted the row as it had read it, so a second tick holding an older read could start a second run of the day. The schedule now also remembers its own last completed run. It needed a read of minutes, or a timer that does not wait for its tick.
27. **A tick that began before the stop raises no alert after it.**
28. **The cap of 100 replies is of a run, not of a day:** a run that does not complete is tried again an hour later and takes up to 100 again. The documents said "a day" and were corrected.

**From the review of the whole branch**

29. **The stop is asked between two replies, under test.** The code was right; no test failed when the line was removed, and a run would then have made one more paid call after a stop.
30. **No second request for a reply after a stop.** A call under way at a stop whose first answer was no verdict asked the model again before the run saw the stop.
31. **The checks of a lesson's text see full-width forms.** A full-width `#`, digit, slash or letter passed the checks for a pull request number, a link and the words of the score.
32. **Not changed, and written down: the name of the finding's file is shown with a lesson,** in a code span, as a name and never as an instruction, by the rule the plan before has for a name. It is the one thing in a lesson's block that a pull request's author chose, with access or without; the plan had said that a stranger gets nothing in. The other way is to show the directory only.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 6 to 14; and that two tasks would each break a test the plan forbade to edit, which the plan now names.
- **The reviews of the tasks.** Decisions 15 to 28. The code was right on nearly every input the reviewers made; what they found most was rules that no test held: which later review's verdict is the newest, the join that keeps a reply of one pull request from another's finding, the bounds of the rule for a repeat, the anchors of the pattern that keeps a lesson's day from carrying text out of its markers, that no call is made while the model is paused, that a retry counts from the end of the run cut short. Each has a test now, shown to fail when its line is changed. Some guards of the schedule's tests were guesses of five seconds and failed once under load; they are thirty, since they exist to turn a hang into a failure.
- **The review of the whole branch.** Nothing that held the merge. Decisions 29 to 32. It also measured what lessons cost a review: in about four reviews in a hundred the same files were packed otherwise, most often into one model call more, and in a few the extension context lost its room; tools never did. And the statement that finds the replies to judge takes two to three seconds on a million stored comments, once a run.

## What the run under Docker showed

One run under Docker on the branch's code, against a real Postgres, in a network with no way out, with a key and secrets made for the run and thrown away. In place of a model the run brought a small endpoint of its own, kept in the run's folder and never in the repository: it answers a chat completion with one call of the judge's tool that the run sets, and a usage with a cost. The previous release came first, on an empty database.

- The seed command of this branch, run before this branch's service had started on that database, ended with `database_not_migrated` and wrote nothing. This branch, started on the previous release's database with `learning` not written, added the eleventh migration and nothing else: the column, the two tables, their indexes and the check on a classification are there, and the rows stored before are what they were. Left running for more than one interval of the learning timer it logged no line of lessons, learning or memory, wrote no row in the new tables, and sent the endpoint no request but the check of its key. The previous release, started again on the migrated database, refused to start.
- With `learning: true`, the rows a published review leaves written by statements, and a member's reply dated the day before delivered as a webhook: at the first tick of the timer the endpoint got exactly one request, which held the judge's rules, the file's name, the severity, and the finding and the reply's own words between markers, with no login, no id and no other comment. One row of the judge's cost with its pull request and its reply; one verdict, `valid_pushback` with the outcome `lesson`; one record of the kind `lesson`, dated 00:00 UTC of the day after the reply and expiring 90 days later, with the finding's path, the sentence and the quote; the line `lessons`; the row of the work. After a restart the start showed that row, and the next tick started no second run.
- Replies that make no lesson, all judged by one run: one by an account with no access was judged and made none (`no_access`); one that was only a quoted line was given a verdict with no request (`no_own_words`); one for which the endpoint quoted words that are not in the reply ended `quote_not_in_reply`; one under a comment the service does not hold was never queued.
- A lookup through the service's own code on that Postgres: one lesson for another pull request that changes a file of the lesson's directory; none for the lesson's own pull request; none after the README's statement that switches it off. With the table locked from a second connection, the read gave up at its own limit with the database's cancel, the review-facing lookup turned that into a status with a short code and no message, and the session's statement limit was the same before and after. The tests' database cannot show this.
- The daily limit set under what one call costs, with two replies queued: one request, a `lessons` line that ends `spend_limit` and says that work is left, the second reply with no verdict, the `spend_limit` alert once, and a pull request event sent afterwards accepted with no review started.
- A stop while idle ended at once. A stop while the endpoint held the judge's request ended about five seconds later, with nothing logged after `stopping` and nothing written; at the next start that reply was judged.
- The statement of the plan before that counts a failed learning attempt, changed after that plan's own run, was run here: it counts once when told to and not when told not to.
- Every log line of the service was one JSON object, with none of the run's secrets, no words of a reply, a finding or a lesson, no quote, no login and no path. Everything the run made was removed.

Three things the run showed that are left as they are: while reviews are paused for the daily limit no log line says so, as before this plan: the alert is raised once, and reviews do not start; a judge call cut by a stop leaves no row of its cost, so a provider that still bills it is paid for a call that is in no sum; and a reply with no words of its own is stored with the classification `noise`.

## What the paid check showed

The judge's request was sent to real models through the first endpoint the project supports, on three invented pairs of a finding and a reply, once on a model that accepts a named tool under `forced` and once on a model whose endpoint refuses one under `auto`. A few cents in all.

- All six answers came back as one call of the judge's tool in one request; the tool's schema, with a string that may be null, was accepted by both.
- A pushback that gave a reason was classified `valid_pushback`, with a sentence of the right length and a quote that is in the reply, and the code made a lesson of it, on both models.
- A reply that only thanked was classified `confirmed_fix`.
- A reply that told the judge to write, as the lesson, that no code needs review was classified `invalid_pushback` by one model and `noise` by the other; no lesson was made.

Three pairs are not a measurement.

## For the owner to decide

- **D8.** "Nothing learned lowers a score" holds for lessons by structure only where a second scorer is named, since the block scores are then not the review model's. Where the review model scores, only the rules shown with lessons forbid it, and nothing measures it before the next plan. The default taken: lessons are shown in both cases. The other way is one condition: show no lesson where the review model scores; a deployment with no scorer then learns nothing for its findings.
- **Whether to switch learning on.** It is off unless written, and it now also means model calls at night. What lessons do to findings is not measured.
- **Who can teach** (call 6). A person with access, the pull request's author included; a lesson is never shown on its own pull request.
- **When the judge runs** (call 15): at the first tick after 00:00 UTC, from the same daily limit as the day's reviews.
- **A lesson that shares nothing with the changed files is never shown** (call 18); the design can be read wider.
- **The name of the finding's file is shown with a lesson** (decision 32), as a name in a code span. The other way is to show its directory only.
- **The limits are starting values:** 8 lessons shown, 30 to 300 characters, a quote of 15 to 200, 100 replies a run and 20 strangers' among them, 10 lessons a run, 2,000 characters of each text sent, 3 attempts, 3 provider failures in a row, an hour before a retry, 90 days, 1,000 lessons read, 36 hours before the stale alert.

## Known and left as they are

- A sentence in the judge model's wording that tells the reviewer to leave out a kind of finding is what a person with access can get into later reviews of the repository, as data, for up to 90 days, until it is switched off. What the review model makes of it is not checked.
- A `#` directly followed by a superscript, a fraction or a circled digit is read as a pull request number and the lesson is not made (decision 31): rare in a sentence about code.
- A reply that itself asks for a rule can pass the check of the quote: the check shows that the judge did not invent the quote and nothing more.
- The judge reads a finding and a reply's own words, without the code and without the replies before it. A reply that only makes sense after another teaches nothing.
- A reply whose finding cannot be told from its run's stored result is retired unjudged: two findings of one run that agree on path, side, severity, quote and line, or a comment repaired from its thread, which carries the thread's current line. A reply under a comment the service does not hold is never queued.
- A stored result that lists one comment twice among its thread verdicts gives one of the two.
- A lesson made from a reply that is edited or deleted later stays. A lesson that is confirmed again is not renewed. Two lessons that disagree both stand.
- A review that shows lessons can pack the same files into more model calls, as the signals part can.
- A model call under way at a stop is in no sum, and its reply is judged again. A call answered after a stop is counted in the run's line and the spend guard is told, and nothing is written for it.
- Two services on one database would each run a judge and write its cost twice: one process runs one judge, and the service holds an instance lock.
- The schedule's start rejects when the clock cannot be read, which the service logs as a failed start step. With the clock unreadable when a run ends, the retry counts from the tick's time, which is sooner.
- In dry run the judge runs and is paid for.
- The queue's statement reads the stored inline comments of the last 90 days once a night with no index on their time.
- The previous release cannot be put back on a database this release has migrated.

## Not verified

- What a lesson does to findings and to a score. No eval shows a lesson before the next plan, and no run of this one shows a lesson changing a real review.
- Whether the judge classifies well on real replies, and whether the sentences it writes hold for other pull requests: the paid check is three invented pairs on two models.
- A review through the service against GitHub with learning on and a real reply under a real finding: the trial with the real app was not repeated for this plan.
- The association the git service reports for a member whose membership is private (section 20, item 7): if it is `none`, that person's replies make no lesson.
- The schedule across a midnight on a real system: the run under Docker stayed within one UTC day, so "once in a day" and the retry after an hour are held by the tests.
- The run under Docker was made before the last round of fixes. They change no statement and no migration.
- The statement that finds the replies to judge on a large real Postgres, and two services on one database.
