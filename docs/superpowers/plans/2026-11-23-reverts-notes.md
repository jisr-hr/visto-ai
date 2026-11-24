# Notes: The Reverts plan

These notes record what happened while `2026-11-23-reverts.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the runs showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built. This plan is the third for stage 8 of the build order. What is left of the stage is both evals with lessons as of each case, and the measurement of what lessons do.

## Status

- The planner cut the rest of stage 8 in two, under the builder's rule that a plan is about twelve tasks at most: reverts end to end here, the evals with lessons next.
- The plan was drafted from the design, a map of the code written for it and a private study of the predecessor, and reviewed by another model before anything was built. That review ran every statement and the migration on the tests' database and the pattern of a reference on every shape of description it could think of. It found no critical defect, four important ones and eleven minor; all were ruled on and applied before the first line of code (decisions 7 to 12).
- Tasks 1 to 8 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. The reviewers ran the code rather than read it: an oracle of their own written from the plan's rules against generated descriptions, deliveries, databases and history files; the parent's parser, engine, pass and backtest beside the new ones on the same inputs; and one-line changes to the code to see which tests would notice. Every reviewer approved the code of its task. The first review found the plan's own rule for reading a reference unsafe, and the rule was replaced (decision 13); three more rulings changed what was built (decisions 17 to 21); and eighteen rules that no test held were each given one.
- Task 9's documents were written by an implementer from the code as built; the run under Docker was made by an agent of its own with throwaway secrets; the reading of the revert button's text and the count were made by the controller.
- Then a review of the whole branch, on the strongest model the build had left (the first such review stopped at a usage limit and was made again from the start on the next model). It drove the real service, review job, engine, learning pass, nightly judge and database-backed memory through about four thousand random lives of thirty to seventy steps each, with kills and faults inside the webhook's transaction, the pass's transaction and the reads, against an oracle of its own: no failure. With `learning` not written the service was `main`, byte for byte, over twelve hundred pairs, but for the new column and the statement that writes it. It found nothing critical, one important defect and four minor ones. All were fixed in one round, with the item parked from the task reviews (decisions 22 and 23), and that round was checked again: the fit of memory through the real engine over about 680,000 cases of file sizes, budgets and memories against an oracle of its own, with no difference; the engine of the commit before the round beside it, equal in every case with no reverted line; one-line changes to the new code, each failing a test but one; and the backtest's reverts beside the database's read on generated histories, equal. Its points were of wording, and are fixed.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **A revert needs no model, no read of the git service and no key of the config** (call 2). It is recognised from what the delivery of a merge carries. Cost: a revert made on the command line is not recorded.
2. **Capture is not learning** (call 5). The number a description names is stored whether or not learning is on, as the rest of capture is, so that a deployment that switches learning on later has its history. Nothing reads it with learning off.
3. **A reverted line holds nothing a person wrote,** and a pull request is shown no line of a revert it made or that was made of it (call 15).
4. **With a second scorer named, reverts are not shown,** as signals are not (call 16).
5. **The evals use the service's own pure code, a free count comes before any paid run, and data is the owner's** (calls 20, 21).
6. **The work was cut once more** (call 1): the evals with lessons are a plan of their own.

**From the plan's review**

7. **Only the first line of a description that is not blank counts** (call 2). As first written a reference on any line counted, also one inside a comment or a collapsed block that the person who merges never sees. Cost: a description with a sentence above the button's line records nothing.
8. **Only the delivery of the merge decides the stored number** (call 3). As first written an edit after the merge could still set it.
9. **A revert never costs a review a signal** (calls 12, 14, 17): at most one reverted line for a file, beside the signals' lines and after all of them, cut first by the limit of thirty; and when the memory for the score does not fit with its reverted lines it is tried without them (decision 22 later made this stricter).
10. **The files of the reverted pull request are those of its newest completed run that lists any,** and only each file's path and old path are read (call 7).
11. **A reverted pull request that is not stored has a code of its own** in the pass's line.
12. **The design is amended** where it said that a record of memory is made only from a comment by a person with access: a revert record is made from a merge.

**From the reviews of the tasks**

13. **The reference is the button's line, exactly as written.** As first built the text was stripped of invisible characters and only then split into lines, and some of what was stripped is a line end to the git service's page: a reference followed by a lone carriage return and a digit was read as another number than the one a person sees. Now every kind of line end is read as one, nothing is stripped, and the line must be the button's and nothing more. Cost: a reason typed after the number on that line, or an invisible character in it, records nothing.
14. **The pass says how many paths the limit of 300 left out.**
15. **A merge whose expiry cannot be written makes no record.**
16. **The function that gives a path's directory is a module of its own,** so that the webhook parser, which now reads the rule, loads less.
17. **A reverted line belongs to the memory for the score,** the part the signals are in, which is fitted before lessons, extension context and tools. Inside that part it is the first thing left out. Cost: in a narrow band of budgets a reverted line and its rule take the room a lesson or the extension context would have had. The plan had said more than this.
18. **A path that already has its reverted line is taken,** so that the memory hands over one for a path, which is what the engine keeps.
19. **A read of reverts that fails costs the review its memory for the score, with the alert a failed lookup has.** The reads are of one table under one limit, so one failing alone is not a real case, and a failure that is told is better than one that is not.
20. **The importer keeps a description as it was sent,** cut at 4,000 characters, so that a history file made from now on reads a reference as the service reads it. A file made before may hold a stripped description.
21. **The older numbers of the free count count the signals' lines only,** as before this plan: they decide whether a paid run for signals is worth making. Reverted lines have a line of the count of their own.

**From the review of the whole branch**

22. **A reverted line never changes how the files are packed.** As built it could cost a review one more model call, or group its files otherwise, since the fit compared only what was left unreviewed and what was cut. Now the packing without reverted lines is always made, and they are shown only when the files go in the same calls, grouped the same, with them as without them; otherwise the memory is shown without them. A memory of reverted lines alone is held to the packing with no memory: when it would change a batch, nothing is shown. Cost: one more packing, in the service and with no call, for each review whose memory has a reverted line beside a signal's line. Signals keep the rule they had, and may regroup files.
23. **The backtest leaves out a case's own reverts before its bound,** as the database's read does, so that the two read the same reverts.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 7 to 12; and a test that contradicted its own rule about the cut at 4,000 characters.
- **The reviews of the tasks.** Decision 13 above all: the code was the plan's, character for character, and the plan was wrong. A fixture of the plan put signals in a directory that the walk of near lines reaches. Two sentences of the plan's tests could not hold with the helper they were to use. The rest was rules that no test held: that the close time dates a revert, that a record is written under its own repository, that the packing sent after the fallback is the one made without the reverted lines, that repositories are compared without regard to case in a history file.
- **The review of the whole branch.** Decision 22. Four sentences of the README: the reads the pass makes; what has a revert looked at again, and the statement that does it, which left a pull request whose attempts had reached their limit as it was; and that with auto-merge or a merge queue the line the merge carries may be one that no person with access saw. One number of the free count that decides whether a paid run is worth making was held by no test.

## What the run under Docker showed

One run under Docker on the branch's code, against a real Postgres, in a network with no way out, with a key and secrets made for the run and thrown away. The previous release came first, on an empty database.

- The seed command of this branch, run before this branch's service had started on the previous release's database, ended with `database_not_migrated` and wrote nothing. This branch, started on that database with `learning` not written, added the twelfth migration and nothing else: the two columns are there, of the type the migration gives, and the rows stored before are what they were.
- With `learning` not written, deliveries in every order the plan's table names: a reference read at the open and kept at the merge; an edit after the merge that names another pull request changes nothing; a reference changed before the merge follows the description; one added only after the merge is never stored; a sentence as the first line, a zero-width space inside the word, another repository's name: nothing; a reference followed by a lone carriage return and a digit: the number a person sees. A re-delivery of the merge with the same id was answered as a duplicate. Throughout, no record, no row of learning, no line of the pass, and no word of any description in a dump of the database or in the log.
- With `learning: true`, the first pass at the start recorded the revert: one record for each path of the reverted pull request's stored review, a renamed file under both of its paths, each with the reverted pull request's number, dated by the close of the revert and expiring 180 days later, and one `revert` line with numbers, a code and counts. A second revert of the same pull request made its own records. A restart added nothing. While the service ran, a revert of a pull request that is not stored, one that is open, one that has no stored review, and one of itself each logged its code and made no record; one closed without a merge made nothing.
- A lookup through the service's own code on that Postgres: one reverted line for a file of the reverted pull request, with only the fields of a line, and the third rule text once; none for the reverted pull request; for the second revert, the line of the first; none once its records are switched off, and one again when they are switched on. With the table locked from a second connection, the lookup ended at its limit as a failed lookup with a short code and no message, and the session's statement limit was the same before and after. The read of a reverted pull request's files passed over a newer run whose scores are empty and one whose result is damaged.
- The seed on the migrated database, with a history file in which one pull request reverts the other, wrote people's activity and their signals and no record of a revert, as the plan says.
- A stop while idle was orderly. Every log line was one JSON object, with none of the run's secrets, no word of a description, no login and no path. Everything the run made was removed, and the project keeps one image.

Two things the run showed that are left as they are: a pull request closed without a merge still has the number its description names stored, which makes no record because a record needs a merge; and a record is dated by the close as it is stored, whatever delivery last wrote it.

## What the revert button writes

The text was read from the raw descriptions of merged revert pull requests in public repositories. Where the button made the pull request, the whole description is one line, `Reverts <owner>/<name>#<number>`, with the repository's full name and nothing else; the page shows it as a short link, which is why the page alone does not settle it. The rule as built reads the number from those descriptions. Other merged reverts read there had a description written by hand or by a revert on the command line, and name nothing under the rule. A repository that was renamed keeps its old name in such a line, which then names nothing.

Not made: a revert on a repository the app is installed on, to see the delivery of the merge carry that line. It needs writes of a new kind on the git service, which are the owner's to allow.

## The count before a paid run

The free count was run on the one history file at hand. It names no revert. So no run could show what a reverted line does to a score, no paid run was made, and nothing was spent. A longer import is what could make it measurable; it reads the git service and is the owner's call.

## For the owner to decide

- **A revert on the scratch repository** (above), to see the one thing no public page shows.
- **Where a reverted line stands in the fit** (decision 17). The other way is to fit it last, after lessons, extension context and tools.
- **What counts as a revert** (decisions 1, 7, 13). Only the button's line, first in the description. A read of a pull request's commits at night would also catch a revert made on the command line; it needs access the passes do not have today.
- **A pull request that was never reviewed leaves no files to record** (call 7), so a deployment that reviews only when asked records few reverts.
- **The evals with lessons.** A history file holds no finding of this reviewer, so the lessons of an eval can only be made from a deployment's own database. No deployment exists yet. The builder's intention is to leave that plan until one does.
- **The limits are starting values:** 300 paths for a revert, 180 days, 1,000 reverts read, one reverted line for a file, 4,000 characters of a description.

## Known and left as they are

- A person with access who merges a wrong reference can, each time, put up to 300 paths of another merged and reviewed pull request into later reviews for 180 days, as reverted lines and their rule. It sets no score, floor, finding or gate. Past 1,000 live reverts in a repository the oldest leave every review, and the audit says so; no signal is lost.
- A revert of a revert and a partial revert are not told apart. Two reverts of one pull request each make their records; a file is shown one line.
- A reverted pull request that is not stored, not merged, or merged after the revert makes no record, and is not looked at again unless an operator resets the marker with the README's statement. A delivery of its merge that comes late has the same effect as one that is lost.
- A merge delivery refused as older than what is stored leaves the number the last event before the merge named. A pull request first heard of after its merge, through another event, has none.
- The read of the reverted pull request's files is made also when the guards will refuse the revert: one read more.
- Two passes at once can each log the `revert` line; each record is written once.
- The engine drops a second reverted line for a path, and one marked near, without counting them in what was cut; the memory hands it neither.
- The count of names that are not printable counts every such live revert of the repository, as it does for signals. The pass records none: only a row written by hand can be one.
- A history file and a deployment differ: a file holds every file of a pull request and a deployment those of the last stored review; a file holds a description as it read when the file was made; a file has no order of deliveries and no switch for a record; a pull request held twice is read from its first case.
- A description longer than 4,000 characters is cut before the engine strips what it shows, so the backtest's model can be sent a little less of it than before this plan.
- The guard on an expiry that cannot be written, corrected here for a revert, is still dead in the signals' rule of the first plan.
- No test holds that a review whose memory has no reverted line makes no packing more: a change there would cost time and nothing else. The plan's list of tests for Task 4 does not name the tests the last round added.
- The previous release cannot be put back on a database this release has migrated.

## Not verified

- What a reverted line does to a score or to findings: the history at hand names no revert, so no run could show it.
- A revert on a repository the app is installed on, and the delivery of its merge: it needs the owner's word.
- Whether the git service's page ends a line at a vertical tab, a form feed, the next-line character or the Unicode line and paragraph separators. The common rules of Markdown end a line only at a line feed and a carriage return. If the page does not end one there, a reference followed by such a character and a digit shows a longer number than the one read, though its link goes to the one read.
- Statement limits on a real Postgres beyond the one lock of the run under Docker, and an expiry after 180 days inside a running service.
- A real model's answer to a reverted line and to its rule.
- Two services on one database.
