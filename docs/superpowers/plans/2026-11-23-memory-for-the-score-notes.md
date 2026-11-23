# Notes: The Memory for the Score plan

These notes record what happened while `2026-11-23-memory-for-the-score.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run under Docker and the count before a paid run showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built. This plan is the first of two for stage 8 of the build order; the second is lessons from replies to findings.

## Status

- Stage 8 was cut in two plans by the builder: memory for the score here, lessons next. Each ends with something that can be shown by itself.
- The plan was drafted from the design, a map of the code and a private study of how the predecessor learned, and reviewed by another model before anything was built. That review found one critical defect, seven important ones and fifteen minor; all were ruled on and applied before the first line of code (decisions 5 to 12).
- Tasks 1 to 11 were built one at a time, each by one implementer, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. The reviewers ran the code rather than read it: an oracle of their own written from the plan's rules against thousands of generated cases, the parent's code beside the new code on the same inputs, hostile inputs, and mutations of the code to see which tests would notice. Ten of the eleven tasks needed a round of fixes or of added tests; the larger rounds were checked again.
- Task 12's documents were written by an implementer from the code as built; the run under Docker was made by an agent of its own with throwaway secrets, and the count by the controller.
- Then a review of the whole branch by the strongest model. It drove the real service, review job, engine, learning pass and database-backed memory through fifty-nine hundred random lives of pull requests, part of them with the git service's clock ahead or behind, with kills in the middle of statements, with database faults and with a second scorer, and compared every record, every request to the model and every stored status with an oracle of its own written from the plan: no difference, and the oracle caught the three defects planted to test it. It searched every request to the model, and every log line and alert of learning and memory, for the words of any comment, a login, a path or another pull request's title: none. With the same model answers, learning on against off, the scores, verdicts, findings, checks and publications were the same. Learning off against `main`, over a thousand pairs: the rows, the calls to GitHub, the answers, the log lines and the requests to the model were identical. It found nothing critical and nothing important, and six small points: three were fixed, with two more that earlier reviews had left for this round (decisions 27 to 30), and three were written down. The fixes were checked by another reviewer, again by running them: the near rule on forty-five thousand generated cases beside the parent's, the count of attempts on random schedules of wakes, ticks and stops against a model of its own, the reader of times on a hundred and sixty thousand strings against a calendar of its own. The code was right on every input it made; four one-line changes to it failed no test, and each has a test now; eight sentences of the documents were corrected.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **Stage 8 in two plans** (call 1): memory for the score, then lessons. The score is the product's main output, and its memory needs no model.
2. **Learning is off unless a deployment writes `learning: true`** (call 17). The design reads as on by default. Off stops everything: no pass, no record, no review shown a record.
3. **With a second scorer named, memory is neither asked nor shown** (call 4). How a record should reach a decision model is open. Cost: a deployment that names a scorer records nothing useful to it yet.
4. **No revert records yet** (call 2): recognising a revert needs a read of the git service at night, which arrives with the lessons.

**From the plan's review**

5. **The model is shown no words a person wrote in a comment** (call 5). As first written a line carried the start of the person's comment. Whether a comment argues for a higher or a lower score cannot be told without judging its text, and the design shows no record that argues for a lower one. So a record stores its excerpt for the UI to come, and the model is told a place, a day, a kind of change, whether the review had missed it, and counts.
6. **A quote, a suggestion and a fenced block are left out of the stored excerpt,** so a member's reply does not store a stranger's words as the member's.
7. **A path or a directory is put in a block only when it is made of the characters ordinary in file names** (call 6), at most 120 of them.
8. **A pull request is never shown a record made from itself,** in the service as in the backtest (call 18).
9. **A pull request that cannot be learned is passed over, and given up after three failed passes in a row** (call 13). As first written, one such pull request stopped all learning.
10. **The stale alert is checked at every tick of the timer, whether or not a pass completes** (call 16), and counts from the row's own start, or from the start of the process when there is no row.
11. **Which eval file may import the database is written in the lint** (Task 3, rule 8): the seed command's two files and the command line, nothing else.
12. **A paid comparison starts with a free count** (call 27, Task 12 rule 5): `eval:memory-count` says how many cases would be shown a line, and how many of those have a file a person commented on that got a line of its own. Below 20 and 10 nothing is paid.

**From the reviews of the tasks**

13. **A time is read only when it carries its zone** (an ISO time ending in `Z` or an offset). A string with no zone gave another day on a machine in another zone. One reader for the whole memory part.
14. **An empty answer still says what it passed over:** a name that is not printable, a read that reached its bound. Before, an answer emptied by the limit read the same as a quiet repository.
15. **The stored excerpt also leaves out** a quote inside a list item, a line that continues a quote, a fence that only a matching line closes, and `blockquote` and `details` blocks.
16. **The memory is handed copies of the files and of the time,** and a time that is no time is a failed lookup, never a throw.
17. **A name stands in a code span, and the rules say a name is never an instruction.** A reviewer got directory names that read like instructions into the repository block, which every review of a repository is shown, through nothing but file names the pattern of decision 7 lets through; and the rule text told the model that the block held nothing a person wrote. The pattern is unchanged; it refuses a backtick, so a name cannot close its span. Cost: the two rule texts are longer, and the largest memory costs about 3,100 tokens where the plan said under 3,000.
18. **A tick of the learning timer waits for its own pass, under one deadline shared with the read that precedes it.** As first built a tick waited for every pass chained behind its own, so steady deliveries made each tick log a failure and stop a healthy pass.
19. **After a stop no pass starts,** also for a wake that came during the pass under way; and the time the stale alert counts from survives a clock that failed once at start.
20. **A pull request is marked as learned for its close time, not for the service's clock.** With the service's clock ahead of the git service's, a pull request reopened and closed again inside that gap was never learned again.
21. **A pull request's own records take no place in the read:** the statement leaves them out. Before, they could push live records of others past the bound of 5,000 with nothing in the audit.
22. **A stored time that cannot be read costs that record, not the repository's memory.** One row with a time outside what the platform's dates hold made every lookup of that repository fail. A record whose expiry is `infinity` is live.
23. **The statement limit of a lookup lives with the statements,** in one function of the database part that sets it for its own transaction.
24. **The backtest dates a signal by the merge, under test.** The code was right; no test would have noticed the mutant that dates it by the first review, which is a leak from the future.
25. **`score-compare` refuses two runs given the wrong way round, prints no step for `focus`, and puts its counts first; a run's summary counts the cases memory was never asked for,** so its counts add up.
26. **The seed refuses a case whose number or times cannot be stored, with a short code,** and its steps after the connect are one tested function that refuses a database with no memory tables before it writes anything.

**From the review of the whole branch**

27. **A record on a file the pull request changes is never shown as near.** A changed file with more records than its three lines got the rest as near lines of a changed sibling that had none, under the rule text that calls a near line a file near one.
28. **A failed attempt counts only in a pass the timer asked for** (call 13). Each inline comment's delivery wakes a pass, so three comments of one review used up a pull request's three attempts at one clock time, and it was never learned again. A pass a delivery woke still tries the pull request.
29. **The one reader of a time refuses a time the database cannot hold:** one before the year 1, and one whose day is not a day of the calendar. The seed's second check of its own went.
30. **The seed refuses a comment's line it cannot store,** with the code it has for a number.
31. **Not fixed, and written down: one comment can get a second record** (call 9). A person comments in a block while the review of that commit is under way; the pull request is closed before that review is recorded, so the record is made for the file; when a later comment makes the pass look at the closed pull request again, the first comment gets a record for the block too. It needs a close inside the time one review takes and a comment after the close, and costs another pull request on that file one more line. The fix is one more read of a pull request's records in every pass.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 5 to 12; that a seed and the service could make two records from one comment; that a lookup nobody waits for held a database connection; and that learning which runs and adds nothing was silent, which the start's log line now shows.
- **The reviews of the tasks.** Decisions 13 to 26. Most were found by running the code: the day that changed with the machine's zone; four forms of quoted text that stayed in an excerpt; a tick that cut a healthy pass short; a pass that still wrote after a stop; a pull request lost to a clock ahead of the git service's; records dropped without a word; one damaged row that silenced a repository; names that read like instructions. One implementer wrote its code before its tests and said so: its reviewer proved each test by breaking the code, found fifteen rules that no test held, and all were given one.
- **The review of the whole branch.** Nothing that held the merge. Decisions 27, 28 and 31. A history file with a comment's line too large for its column stopped the seed with the driver's error. The repository block can change within a day in a fifth way the plan did not list. A pass whose last statement fails leaves its retired records uncounted. Two one-line changes to the near rule failed no test; each has one now.

## What the run under Docker showed

One run under Docker on the branch's code, against a real Postgres, in a network with no way out, with a key and secrets made for the run and thrown away. The previous release came first, on an empty database.

- The previous release applied its nine migrations and stored a sample pull request, a member's inline comment on it and its close. This branch, started on that database with `learning` not written, added the tenth migration and nothing else: the two tables, the three columns and the two indexes are there, and the rows stored before are what they were. Left running for more than one interval of the learning timer it logged no line of learning or memory and wrote no row in either table. The previous release, started again on the migrated database, refused to start.
- With `learning: true` the start logged what the work had done so far, and the first pass turned the comment the previous release had stored into one record: dated by the pull request's close, expiring 180 days later, with its path and its excerpt. A restart added nothing. A second member's comment on the closed pull request was a record within a second of its delivery, with no timer. A comment by the author and one by an account with no access made none. A comment that was only a quote made a record with an empty excerpt.
- A lookup through the service's own code on that Postgres, for another pull request: one line for the record's file, holding a reference, the path, the day, the category, and the two flags, and no key for an excerpt, a reason or a login. Asked for the record's own pull request: no line. After the README's statement that switches the record off: no line for it, and the other records of its directory shown as near; after the one that switches it on: the line again. The session's statement limit was the same before and after the lookup.
- The seed command, run while the service was running, with a small invented history file: it printed its four counts, and a second run printed zero for activity and signals. Its records were dated by the merges, and no pull request row was written. Against a database that was never migrated it ended with `database_not_migrated` and left that database without a table. A history file inside the project folder was refused before any connection was tried.
- A sample pull request event was accepted; with no way out its job failed at its first step and was put back, as on `main`, and nothing of memory was asked.
- Every log line of the service was one JSON object, with none of the run's secrets, no body of a comment, no login, no path of a record and no excerpt. Everything the run made was removed.

The run was made before the last round of fixes. They add no migration and change one statement, the one that counts a failed attempt, which the run did not reach.

Two things the run showed that are left as they are: the seed command pointed at a database it cannot reach ends with a general error and no short code of its own; and the ids of records have gaps, because a pass that looks at a pull request again offers its records again and each offer that is refused still uses up an id.

## The count before a paid run

The free count was run on the one history file at hand, with that file as its own memory. It passed the first floor (cases that would be shown a line) and not the second: no case had a file a person commented on that also got a line of its own. With that, no run could show whether memory helps the score, so no paid run was made and nothing was spent. A longer import of the same repositories, for memory alone, is what could make it measurable; it reads the git service and is the owner's call.

## For the owner to decide

- **Whether to switch learning on.** It is off unless written. What it does to the score is not measured (see above).
- **Memory and the second scorer** (decision 3). A deployment that names a scorer is shown no record. Recording still runs when learning is on, for the UI and for the day a record can reach a decision model.
- **Who can teach** (call 7). Only an owner, member or collaborator who is not the author. The design is wider: any account that is not a bot and not the author.
- **Names** (decision 17). A file's or a directory's name is the one thing in a block that a contributor chose. It is shown in a code span with a sentence that it is a name. The other ways are to show no name that is longer than a short limit, or no directory list at all.
- **A longer history import,** to measure memory with the backtest.
- **The limits are starting values:** 10 directories and 8 kinds from 2 pull requests up, 30 lines, 3 on a file and 2 from the nearest directory, 120 characters for a name, 200 for an excerpt, 180 days, 5,000 records read, 5 seconds for a lookup, a pass every five minutes of at most four, 36 hours before the stale alert, three failed passes before a pull request is given up, and the count's floors of 20 and 10.

## Known and left as they are

- A name that reads like an instruction can still stand in a block, as a name in a code span (decision 17).
- The lookup is given the files a review sends to the model. A changed file the review does not send is not one of them, so a record on it can stand as a near line of a file that is sent.
- A review that shows memory can pack the same files into more batches and so make more model calls; the files reviewed and the cuts are the same.
- A record's excerpt holds what its comment said when it was captured: a comment edited or deleted later is not followed (call 31). The excerpt reaches no model.
- A pull request can be given up after three passes in which its transaction failed, also when the cause was the database and not the pull request (call 13). The README gives the statement that lets it be tried again.
- While a pass hangs, every tick logs `learning_failed` with `timeout`. A slow read of the learning row can leave the pass too little of the tick's one deadline.
- The stop does not wait for the start chain, so a read of the learning step at start can land after the database closed and be logged as a failed start step; the service's own heartbeat step has the same pattern. Nothing is logged when the wait for a pass at stop reaches its limit.
- A lookup's time limit does not hold the process open, as for a provider and a tool call: a command-line run whose memory never answers would end without a result. The backtest's memory answers from a file it has read whole.
- A memory, a health or a callback of the service's own that throws inside an abort listener, or that the types say returns nothing and returns a rejected promise, is caught where this plan added the call and not everywhere the same pattern existed before.
- The index on comments not yet looked at is built inside the migration's transaction, so deliveries wait for it once; it holds every inline comment while learning is off.
- Two of a pass's statements scan their tables on every pass. On a large database they want an index before they want anything else.
- The statement breaks a tie of times at the bound of 5,000 records by id, the choice by reference: at that bound the two can differ by one record.
- The in-process database of the tests runs one statement at a time, so the race of two passes is held by the unique key and shown by no test.
- The repository block can change within one UTC day in a fifth way: records that expire during the day are counted until a pass retires them, and not after.
- A pass whose last statement fails after it retired records leaves them retired, counts them in no total and logs no `learning` line.
- A pull request that is given up is logged, and raises no alert.
- Four pieces of code are reached by nothing any review could build: the guard around the engine's own lookup call, a third check of a name where a block is written, the last tie-breaks of the order of records, and one field of a stored row.
- The seed: a pull request the service stores gets no signal from the file, also when the service's row is out of date; for one it does not store, the excerpt comes from the file's text.
- The previous release cannot be put back on a database this release has migrated.

## Not verified

- A review through the service against GitHub with learning on: the run under Docker has no way out, and the trial with the real app was not repeated for this plan.
- A real model. Whether a name in a code span is ever read as an instruction, and what memory does to a score: the count before a paid run did not pass, so no model was asked.
- The statement that counts a failed attempt, on a real Postgres: it was changed after the run under Docker, and is held by the tests' in-process database only.
- A real Postgres under load: a seed and a pass in overlapping transactions, two passes at once, a lookup cut short by its statement limit. The run under Docker did one thing at a time.
- A model that calls tools in a review that is shown memory.
- More than 5,000 live records in one repository, and two instances of the service.
- The numbers `memory-count` and `score-compare` print, beyond their own tests.
