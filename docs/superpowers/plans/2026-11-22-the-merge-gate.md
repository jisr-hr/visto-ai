# The Merge Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository can make the app's check a required check: on a gated pull request no review runs on a push, the check waits for `/done`, and after the review it stays red while a major or blocker finding of the app is neither verified by the review of the current head nor answered by a person in a resolved thread. A person's reply and a resolve turn it green within seconds, with no new review. One named team can skip it for one commit, and an operator can run it in shadow or bypass it.

**Architecture:** The check is never written by an event or by a review job. Every event that can change it stores a *gate job* with the delivery, in a second lane of the queue (`jobs.kind = 'gate'`) that has its own places, is not paused with the reviews and has its own pending slot for each pull request; the review runner stores one too whenever a review job leaves it. A gate job of reason `sync` is the only writer of the check: it reads the pull request as GitHub has it now, computes what the check must say from stored facts (a skip for this head, a review job under way, the runs of this head) and, when the head has its published review, from the live threads joined with the stored findings and the stored verdicts; it writes only when that differs from the check GitHub holds, and records what it found. The commands (`/done`, `/ai-review-skip`, a re-run of the check) are gate jobs too: they decide, record, hand over to a review job when a review is wanted, answer, and end by asking for a `sync`. The rule and every text are pure functions in `src/gate/`. GitHub's check runs, statuses and team membership sit behind one new interface, `ForgeChecks`.

**Tech Stack:** Unchanged. No new library. One migration.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 9 (the merge gate, whole); 3 (O7, O15, O18, D4, D10, D13, D14, D15, D16, D23); 5.2 (threads a run judges; full or incremental); 5.6 (what a kept verdict does); 8.1, 8.2, 8.3, 8.4, 8.5; 10 (permissions); 11.1; 5.4 and 12 (what pauses reviews; "gated checks say why"); 13 (`gate_evaluations`, `gate_overrides`); 14; 20; 21 (settled on 2026-11-22: "goes to human review" does not fail the check).

**Notes:** `docs/superpowers/plans/2026-11-22-the-merge-gate-notes.md` is written when the build ends. This plan is stage 5 of the build order (section 18).

**This plan was reviewed before it was built.** The review found one critical defect and seven important ones, all corrected here: a review whose inline comments GitHub refused turned the check green (call 45); a skip could land on a commit nobody had looked at (call 46); a command that was put back, or cut by a stop, lost its place to a waiting `sync` (Task 2, rule 4); a `/done` review did not start over when the head moved (Task 11, rule 4); threads no review can judge had no stated way out with clearing by reply off (call 47); rewriting a completed check, and the change to design 8.2, were not stated as what they are (calls 48 and 11); and the cost of the `check_run` subscription was understated (call 9). Ten smaller points were applied too.

**Words used below.** *Gated*: `gatingOf(settings, baseBranch)` is not `off` (Task 1). *The check*: the check run named `settings.gate.checkName` that this app wrote on the pull request's head commit. *The head's review*: the newest published run of the pull request whose head and merge base are the live ones (`reviewedRun`, Task 5); a re-check counts. *A person*: the author of a thread comment with `byApp` false and `authorIsBot` false. *The app's own thread*: a thread whose first comment has `byApp` true.

## Scope

| In this plan | Left out, and why |
|---|---|
| 9: which pull requests are gated; the check and its whole life (waiting, reviewing, passed, blocked, failed, skipped, bypassed); the rule; clearing by reply as a setting (O18); `shadow` and `bypass`; fail closed; files not reviewed counted in the title and not failing the check (O15) | **Approving, and withdrawing an approval:** stage 9. Nothing here approves |
| 8.1: `/done`, `/ai-review-skip <reason>`, a re-run of the check, the check evaluated again on a thread event or a reply with no review, no automatic review of a gated pull request | **An edit or a deletion of a comment as a reason to evaluate again:** the service does not take those events in (8.1 lists none). Cost: a deleted reply changes the check only at the next evaluation. **A re-run of a whole check suite:** the `check_suite` event is not taken in; only a re-run of the check itself is |
| 5.2, D4, 8.3: a gated pull request gets a `full` review at a new head unless `newHead` is written; "settled" follows the rule in force; a review asked for by `/done` or a re-run starts over once when the head moved | Nothing |
| 10, 17: `checks`, `statuses`, `members` and the `check_run` event in the manifest and in the table of what each feature needs | **The ruleset that requires the check:** made by the adopter in GitHub; the README says how. **The branch-rules permission:** stage 9 |
| 11.1: the gate block, as a default and for one repository | **A check that the skip team exists:** it needs an installation, which only an event brings. A misspelt team reads as "not a member" for everyone |
| 12, 5.4: a gated check says why when reviews are paused | Nothing |
| 13: `gate_evaluations`, `gate_overrides`, and `jobs.kind` | **The `thread_verdicts` table:** cut. The gate reads verdicts from each run's stored result (call 2), so no reader needs the table yet. Cost: verdicts stay in JSON until a stage that lists them (the UI) builds it. **The `review_runs` column for blocking findings left without a thread:** counted at each evaluation into `gate_evaluations` instead |
| 14: `feature_off` for what a configured gate lacks; two alerts | **A pull request the service has no stored row for** (opened before the app was installed): it gets its check at its next event, not at start. Cost: until then GitHub shows its own "expected" wait for the required check |

**Dry run:** in dry run no gate job is stored and no check is read or written. A gated pull request still gets no review on a push, and `/done` is then a `/review`, recorded like any other dry review; `/ai-review-skip` and a re-run do nothing.

## Calls made in this plan

Calls 1 to 10 are the session lead's, restated with their cost, and so are 45 to 49, which came from the review of this plan. The rest are the planner's. None is in the design unless it says so; each is listed so the owner can overrule it.

1. **Where the design and the predecessor differ, the design wins; where the design is silent, the predecessor's behaviour is carried when it is sound.** Each carry is marked "carried" below. Cost: a carried behaviour was designed for another system.
2. **"Verified" is read from the database.** A thread is verified when the head's review kept a `fixed` or `answered` verdict for it in its stored result. The hidden line in the app's reply is still written and is never read by the gate. Cost: a database that lost a run loses its verifications, and those threads block until the next review.
3. **A thread gates when it is the app's own, its first comment is stored as a major or blocker finding, and it is not cleared.** Notes, minors, findings not placed on the diff and majors listed under `On code unchanged since the last review` have no gating thread.
4. **A thread a person resolved with a click and no reply does not clear.** The check's summary names it, and the next review judges it again (5.2). Cost: an author who fixed the code and resolved in silence has a red check until `/done` or one word in the thread.
5. **The check is written by a job, never in the webhook path;** a gate job does not wait for the pause on reviews nor for a review job of the same pull request; writes for one repository and commit are serialised in the process. Cost: the check follows an event by the time a job takes to start (calls 11 and 12).
6. **Conclusions are `success`, `action_required` and `failure`,** never `neutral` or `skipped`. The design names no conclusion for blocking threads and nothing in it speaks against `action_required`. Cost: how GitHub shows it, and whether it offers a re-run there, is not verified.
7. **A skip is a row for one head commit, and a failed membership lookup is "could not verify".** Cost: a skip does not carry to the next commit.
8. **Dry run writes no check; shadow is not dry run.** Cost: the gate cannot be rehearsed without writing checks; shadow is the rehearsal.
9. **The manifest and the feature table grow with what the gate uses,** and a deployment with no gate configured lacks nothing and is told nothing. Cost: an app made from the manifest holds `checks` write, `statuses` read and organisation `members` read with the gate off; an existing app is given them by hand, each installation accepts them, and the service is restarted. And an app subscribed to `check_run` may be sent the `created` and `completed` events of every check run in its repositories, with the gate on or off. Each is stored as an ignored delivery; the `deliveries` table is never pruned; and the redelivery after a downtime reads at most 10 pages of GitHub's delivery log, so that traffic can push real missed events out of its reach. `check_run` stays in the manifest because the re-run needs it. How many such deliveries arrive is not known ("To verify", item 2).
10. **Nothing in this stage approves a pull request.** Cost: where a repository requires an approving review, a gated pull request with a green check still waits for a person's.
11. **A second lane, not a second queue, and with it a change to design 8.2.** `jobs` gets a `kind`; the pending slot is one for each pull request and kind; a second runner of 4 places takes the gate jobs and never asks whether reviews may start. Section 8.2 says "never two jobs for the same pull request at once". With this plan that is: never two review jobs for one pull request at once, never two gate jobs for one pull request at once, and one gate job may run beside a review job of the same pull request. The session lead amends the design; Task 13 holds the sentence. Cost: a previous release refuses to start on the migrated database (it finds a migration it does not know).
12. **The check is computed from facts each time, not moved by events.** In this order: bypass; a skip stored for the head; a review job of the pull request under way ("Reviewing", or the pause's reason while it waits); the head's review, with the threads and with what GitHub refused to show inline (call 45); a failed try at this head; else "Waiting for /done". The same function answers `/done`'s "already green". Cost: one read of the pull request and one of the check for each job, also when nothing changed.
13. **Only a `sync` job writes the check, and it finds the check by asking GitHub each time** (by name and the app's id), not from a stored id. Cost: one more request for each write. In return a stop between a write and its record cannot lead to a second check, and a restart needs no memory.
14. **"Reviewed" is head and merge base.** A head reviewed against another base (after a retarget) is not reviewed.
15. **A verdict stops verifying when someone other than the app writes in the thread after it was judged,** the test the thread follow-up already makes before it writes. Cost: a "thanks" after the review turns an unresolved thread red again until it is resolved or the next review.
16. **"The app resolved it" is: GitHub names the app as the one who resolved, and the newest verdict any published run kept for the thread is `fixed` or `answered`.** The review planner's "settled" still reads the app's hidden line (plan 6, decision 15); the two agree in every case the service itself produces. A thread the app resolved stays cleared when a person objects in it afterwards and leaves it resolved, also where clearing by reply is off (9: "resolved and the app resolved it"): whoever objects unresolves the thread, and it then blocks until a review judges it again. Cost: an objection written into a resolved thread holds nothing.
17. **The app's own thread with no stored finding blocks, as severity `unknown`.** The stored rows are first completed in memory from the threads, as a review does. What is left unknown cannot be judged by a review (it is in no earlier state): it clears by a person's reply and a resolve, or not at all where clearing by reply is off. Cost: a minor or a note whose record was lost blocks until someone answers it; so does every thread another deployment of the same app left.
18. **A person's reply is not read and not dated** (carried): "will fix" counts, and so does a reply written before the last push. The gate checks no access of the replier (9).
19. **The gate block:** `enabled`, `branches`, `checkName`, `mode`, `clearByReply`, `skipTeam`, `requiredChecks`. `mode` is in the block, so it can be set for all repositories or for one. `branches` must be written when the gate is enabled: no default list. The base-branch filter of reviews (`baseBranches`) has no say.
20. **Only a gated pull request loses its automatic reviews** (the design): a pull request of the same repository against a branch outside `branches` is reviewed on a push as before. The predecessor stopped them for the whole repository.
21. **Every open gated pull request gets its waiting check,** a draft, an ignored author's and one outside the review filter too.
22. **`/done` and `/ai-review-skip` are commands only in a repository whose gate is enabled.** Elsewhere they stay ordinary comments, as on `main`. On a pull request of such a repository that is not gated, `/done` is a `/review` (carried) and the skip is refused.
23. **`/done` is read like `/review`:** from the first line that is not empty, in any case. The predecessor matched the raw body because a workflow of its own matched it too.
24. **"Already green" is what the rule says now, not what the check shows.** A `/done` on a green head gets its eyes and no review; when `requiredChecks` are named and all green it also gets one sentence (carried). Cost: one thread read for each `/done`.
25. **A `/done` or a re-run while a review of the pull request is running, or a requested one waits, joins it** (carried): no second review. It joins only a review that will run: one asked for by a re-run, or by someone D15 lets command, or an automatic one on a pull request that is not reviewed only when asked (shadow, or a branch outside the gate's list). A stranger's `/review` that waits is about to be refused, so a member's `/done` is not hidden behind it: it stores its own review job, which takes the slot as a member's `/review` does today. A push's job on a pull request that is reviewed only when asked is no such review: it is about to be dropped as `gated`, and counts neither for joining nor for "Reviewing". A review asked for by `/done` or a re-run starts over once when the head moved, as a `/review`'s does (the design, 8.3), so a `/done` that joined a review of an older head is still answered by a review of the new one.
26. **The skip needs both D15 and the team.** The team's organisation must be the repository's owner; a pending membership is none. The answer to a skip is the eyes reaction (8.1), not a thumbs up.
27. **A skip outranks a review:** a `/review` or a re-run on a skipped head runs and posts, and the check stays skipped. There is no command to end a skip but a new commit.
28. **A re-run is not checked against D15:** it is no comment and carries no association; GitHub decides who is offered the button, and a tool may ask through the API (O17), so a bot's re-run is honoured. The pull request is the number the check carries (`external_id`), else the first one GitHub lists, so a fork's re-run works. A re-run of a commit that is no longer the head is dropped, and one on a pull request that is no longer gated does nothing and says nothing.
29. **A required check is green when every place that reports its name says `success`:** a commit status, or the newest check run of that name. `neutral` and `skipped` are not green. Cost: the sentence of call 24 is not written for a job GitHub skipped.
30. **A failed evaluation is written at once as `failure` and tried again twice** (after 10 and 60 seconds); the check says that the service tries again only while it does. A job that gives up, or that the runner gives up as too old or out of starts, raises `gate_check_failed`, once for each code in a run of the service, and asks for nothing more. Asking for a check again does not give a waiting `sync` its starts back, and a `sync` that takes over from one that failed takes over its count, so an outage ends in the alert however many events arrive. Cost: a short outage of GitHub's thread query turns green checks red for about a minute.
31. **A thread event and a reply by anyone, the app included, ask for the check,** due 3 seconds later, each new one restarting the wait. Cost: the check follows a reply by a few seconds, and the app's own replies cause one evaluation that changes nothing.
32. **A pull request that stops being gated keeps the check it had.** Nothing writes it again. Cost: "Waiting for /done" can stand on a pull request nobody has to answer.
33. **Two pull requests of one repository with the same head commit share one check;** the one evaluated last decides it.
34. **The check links to the pull request's own page** (`details_url`) and carries the pull request's number (`external_id`).
35. **Shadow changes nothing about reviews:** "settled" is not narrowed in shadow, and a push that told nothing new leaves "Waiting for /done", as it would under the gate before a `/done`.
36. **On a gated pull request with clearing by reply off, a resolved thread with a person's reply is judged again:** it is not settled under the rule in force (5.2). Without this such a thread could never clear.
37. **Reviews are paused under two codes:** `spend_limit` and `model_error` (the alerts' names). For `model_error` the check says only that reviews are paused on the reviewer's side: a public pull request is told nothing about the operator's key or credit. A waiting review's check is brought up to date each time the pause begins, ends or changes. Cost: while a key stays refused, each waiting pull request's check is rewritten twice every five minutes.
38. **At start, each stored open gated pull request whose newest recorded evaluation is absent, was made under another mode, or says a review is under way or paused, is asked for again.** This is what makes leaving bypass take effect, covers a stop between a publication and its check, and gives a newly gated repository its checks. An evaluation that needs no write is still recorded when it differs from the newest record (call 40), so a pull request is not asked for again at every start after a change of mode. Cost: switching the gate on, or bypass on or off, costs one evaluation for each open pull request at the next start.
39. **A deployment that starts with a repository in bypass raises `gate_bypass`,** at each start.
40. **`gate_evaluations` records what the check says, not each request:** one row when the check is written, and one when it needed no write but the newest row of the pull request has another head, mode, state or code. A row that cannot be stored is logged and changes nothing.
41. **No write at the start of a review, and none from inside a review job.** The check says "Reviewing" from the moment a review job exists; the review runner asks for the check once a job has left it, however it left, so a job that was dropped, refused, or left unrecorded is followed by one more evaluation.
42. **What a summary and an answer may show.** A path is shown in printable ASCII, every other character and the backtick as `?`; the finding's own text is not shown; the skip's reason is shown as one line inside a code span, at most 300 characters, with control characters and characters that change the direction of text removed and each backtick written as an apostrophe, so that nothing in it is live (as first built it was only made inert against mentions and tags, and a link or bold text in it stayed live); and the skip team's name is written nowhere on GitHub: the texts say "the team that may skip".
43. **A review job is under way when it waits, or when it runs in this process.** A job the database calls running that no runner holds (its record failed, and it waits for the next start) does not count: the check is decided on what is stored, and a `/done` starts a review. There is one instance (D13), so the process knows. Cost: the review runner answers one more question, whether it holds a job of a pull request.
44. **In the gate's lane a command keeps its place against a `sync`, and loses it only to a later command.** A command that is put back after a failed read, or recovered after a stop, drops the `sync` that was stored meanwhile and asks for the check itself when it ends. A later command of the same pull request (a second `/done`, a re-run) still takes a waiting one's place, as a `/review` can today; the one replaced is not answered. The review lane is unchanged.
45. **A review whose inline comments GitHub refused blocks while it holds a major or blocker that was placed on the diff.** The predecessor's decision that unplaced findings do not gate is about code the pull request did not change, not about comments GitHub would not show. The planner's part: the rule looks at the newest published review of this head and base that was posted without its inline comments, not only at the head's review, because a `/done` on the same head publishes a re-check that holds no findings and would otherwise turn the check green. Cost: such a commit stays blocked until a new commit is reviewed or the team skips it; no reply can clear it, since there is no thread. And with `newHead: incremental` the review of the next commit reads only what changed, so it may not raise those findings again.
46. **A skip lands only on the commit the service knew when the comment arrived.** The head stored for the pull request is stored with the skip's job; when the live head differs, the skip is refused as `stale_head`. The planner's part: a pull request with no stored row is skipped at its live head; and the stored head is the one of the newest event received, so a push whose event arrives before the comment's is the head the skip takes. Cost: a skip typed while a push is in flight has to be typed again.
47. **With clearing by reply off, a thread no review can judge clears only by a skip.** Three kinds: a thread whose file left the pull request's diff, a thread whose file was not sent to the model, and the app's own thread with no stored finding (call 17). The first two are told the same way: the head's review kept no verdict on the thread and did not read its file. The check's summary says so on the thread's line. Cost: such a pull request cannot merge without the team; with clearing by reply on, a reply and a resolve clear it.
48. **A completed check is rewritten in place to `queued` or `in_progress`** (carried: the predecessor did exactly this in production for a long time; old gate map, section 2.2). It is the first thing to verify with a real app. No other way is built: if GitHub refuses the rewrite, or answers it and keeps the old status, the job gives up with a code (`github_<status>` or `check_not_rewritten`) and the alert names it. Cost if GitHub does not allow it: every later evaluation of a commit fails and its check keeps its first conclusion.
49. **A read or a write of GitHub that fails leaves the check GitHub already shows.** That can be a green one that no longer holds: a thread unresolved while the check cannot be written, or a review asked for on a green head. Fail closed bounds what the service writes, not what GitHub keeps. Cost: during an outage of the checks API, or once a job has given up, a merge can pass on a stale check; `gate_check_failed` is the only sign, and the next event or start tries again.
50. **Every call to GitHub has a time limit of 60 seconds,** read as `github_network`. Found while this plan was built: the adapters were handed the platform's `fetch` as it is, whose own limits are minutes long and bound no call as a whole, so a call that hung would hold a commit's lock and a place of the gate's runner. The limit is set where the adapters are wired, so it holds for the review lane too: a call that hangs now fails after a minute and is tried again by the rules that exist. Cost: a slow answer of GitHub that would have come after a minute is now a failure.
51. **A review posted without its inline comments whose stored result cannot be read blocks.** The count of findings GitHub refused cannot be made, so it is not read as none (call 45).

## The predecessor's known gaps

From the old gate map, section 4, by its numbers; the last row is from its section 2.5.

| # | Gap | Here |
|---|---|---|
| 1 | Drafts and ignored authors got no check on a push | Closed (call 21) |
| 2 | The review filter had to list every gated branch | Closed (call 19) |
| 3 | The app could not resolve, so a verified thread needed a marker | Not here: verification is read from the database (call 2) |
| 4, 5 | Stacked confirmations; a confirmation in the wrong thread | Closed in stage 4 |
| 6 | A silent resolve blocked and no review saw it | Closed: it is judged again and the summary names it |
| 7 | New findings at every round | Kept by the owner (D4); not this plan's |
| 8 | A command was acknowledged before it was stored | Closed (D14) |
| 9, 12, 20, 26 | Bodiless review records, a user account treated as the reviewer, a list of bot logins, a window of recent reviews | Not here: runs come from the database, and the app's account is known by its type and name |
| 10, 11 | Precision of blocking findings; the cost of repeated `/done` | Kept: O18 is the way past a wrong finding; O21 |
| 13 | Its recorded decisions | Carried: a check run, no automatic review when gated, a silent resolve never clears, the newest review of the head decides, fail closed, one team may skip, `/done` runs nothing that is green, unplaced majors do not gate |
| 14 | A failed or partial run could clear | Not here: only a published review's kept verdicts count |
| 15 | A loose statement of the rule | Not here |
| 16 | A skipped head stuck in progress | Closed (call 27) |
| 17 | A failed write left the check in progress for ever | Closed in part: retried, then an alert, and the next event or start tries again; until then GitHub keeps what it shows (calls 30, 38 and 49) |
| 18 | Reopening reset a green check or a skip; a retarget gave no check | Closed (call 12) |
| 19 | Bypass only greened what it touched, and leaving it un-greened nothing | Closed for stored pull requests, at the next start (call 38) |
| 21 | Any reply evaluated again; an edit or a deletion did not | Kept (call 31; Scope) |
| 22 | A verification did not carry to a newer review of the same head | Kept: 5.6 says no kept verdict blocks. Softer now, since the app resolves what it cleared |
| 23 | `/done` read commit statuses only | Closed (call 29) |
| 24 | The commands did not ask whether the pull request is gated | Closed (calls 22 and 28) |
| 25 | A fork's re-run never worked; its author cannot `/done` | The re-run is closed (call 28, to verify); D15 stands |
| 27 | The lock and the skips lived in memory | The skip is a row; the lock stays in the process (D13) |
| 28 | No time limit on "in progress" | Closed without a clock: the runner asks for the check whenever a review job leaves it, and a job no runner holds is not under way (calls 41 and 43) |
| 2.5 | A review posted without its inline comments took all its findings out of the gate | Closed (call 45) |

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing. Every text of this plan is ASCII.
- **No test reaches the network or a real database.** Database tests use `testDb()`, a new one for each test. `test/setup.ts` blocks connecting and `fetch`; no test listens.
- **With the gate off nothing changes.** A deployment in which no repository has `gate.enabled: true` gets the reviews, rows, answers and log lines it gets on `main`. The only differences: the `kind` column; the manifest, for an app not yet created; a `check_run` delivery asking for a re-run, which is recorded as handled, stores nothing and starts nothing; and a `check_run` delivery of any other action, which is recorded as ignored with the reason `unknown_action` where it was `unknown_event`.
- **Fail closed.** `success` is written in three cases only: the head's review exists, no thread blocks and no review of this head left a blocking finding without a thread (call 45); a skip is stored for this head; the mode is bypass. A read that fails never reads as "nothing blocks". What GitHub keeps when a write fails is call 49.
- **One writer.** The check is written only by a gate job of reason `sync`, through `ForgeChecks.writeCheck`: never in the webhook path, never by a review job, never in dry run.
- **The gate reads no comment's text to decide:** no severity tag, no hidden line, no reply's words.
- **Never rejects.** `runGateJob` never rejects, like `runReviewJob`: each step is caught, the job is finished, put back or left for the next start, and one line is logged. A logger that throws changes nothing (`try { deps.log(entry) } catch {}`).
- **Boundaries, enforced by lint (`eslint.config.js`):** `src/gate/**` is under the general block: it may not import `**/forge/github/**`, `pg` or `@electric-sql/pglite`. It imports from `src/db`, `src/config`, `src/shell`, `src/forge/types.ts`, and from the engine only `inertInline`. `src/db/**` may not import `**/forge/github/**` or `**/engine/**`. `src/engine/**` imports nothing from `db`, `shell`, `eval`, `forge/github`, and nothing of this plan touches it. Only `src/forge/github/**` knows GitHub's shapes, and `src/main.ts` wires the adapters. No new lint block is added.
- **Logs** carry ids, state names, codes and counts: never a login, a team, a skip's reason, a comment's text, a token or an error's message. An error is logged as its short code (`codeOf`) or as `{ error: name, code }`.
- **Every text a person reads on GitHub is one of this plan's,** character for character (Task 6). A code shown is a short code (`isShortCode`: `/^[a-z][a-z0-9_]*$/`, at most 40 characters), else `internal_error`. No stack trace, no host path, no team's name.
- **A stored result or row may be old or damaged.** Every field read from `review_runs.result` is checked; what cannot be read is skipped, never thrown on.
- **Migrations:** one file, `src/db/migrations/0008_gate.sql`, plain SQL in the schema `visto_ai`, applied once in a transaction; `src/db/migrate.test.ts` pins its place. Owner and repo are lower-cased on every write and lookup; outside text goes through `storable()`; a time is passed as an ISO string with `::timestamptz`.
- **Tests:** `node:test`; `REF = acme/shop` number 7; `at(seconds)` counts from `2026-03-01T10:00:00.000Z`; logins `octo-dev` (author) and `octo-lead` (commands); installation `'99'`; the app's account `visto-test[bot]` and id `'12345'`; the team `acme/release-managers`; hosts under `example.test`. A fake of an interface is a literal that pushes `[name, ...args]` for each call, as the writer fakes do. Fixtures are invented.
- **Secrets:** nothing new. A token is never logged.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A push, a reply or a resolve while a check is being decided or a review runs.** The evaluation reads the live head and writes the check of the commit it read: a new head's check never says what an old head's review said. A `/done` that joined the review of an older head is answered by a review of the new one. Tasks 7, 10, 11 and 12.
2. **A check left "Reviewing".** A review job that is dropped, refused, given up, cut by a stop or left unrecorded is followed by an evaluation, which finds no job and writes what the facts say; a job the database calls running that no runner holds is no job, and neither is a push's job that is about to be dropped as gated. Tasks 2, 7 and 8.
3. **Two evaluations of one commit.** One pull request: one gate job at a time. Two pull requests on one commit: the lock. Task 7.
4. **A command that does not run straight through:** stopped in the middle, put back after a failed read while a reply stored a `sync`, or cut by a stop while a `sync` was stored. Its effect (a skip row, a review job) and the end of its job are one transaction; run again it does nothing twice, and it is never dropped for the `sync`. Tasks 2 and 9.
5. **A pull request that stops being gated, and one that becomes gated with a push's job waiting.** Tasks 7, 10 and 11.
6. **Forged or missing evidence:** the hidden line typed by a person; a thread "resolved by" an account named like the app; a verdict followed by an objection; the app's own thread with no stored finding; a thread whose file the review did not read; a review GitHub refused inline, then a re-check of the same head; a stored result that is not an object. Tasks 5 and 7.
7. **Bypass switched on and off again,** and a change of mode that needs no write. Tasks 7 and 12.
8. **Reviews paused, and GitHub failing:** the check says why reviews wait, a skip still works, and an outage ends in one alert however many events arrive. Tasks 2, 7, 8, 9 and 12.

---

### Task 1: The gate block in the configuration

**Files:**
- Create: `src/gate/gating.ts`
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `config.example.yml`
- Test: `src/config/load.test.ts`, `src/gate/gating.test.ts` (new), `test/boundaries.test.ts` (a pin); the typed fixtures that build a `RepoSettings` by hand gain `gate: GATE_OFF` (`src/config/load.test.ts`, `src/shell/later-review.test.ts`, `src/shell/receive.test.ts`, `src/shell/receive-jobs.test.ts`, `src/shell/triggers.test.ts`, `src/shell/review-job.test.ts`, `src/eval/replay.test.ts`, `src/eval/backtest/run.test.ts`, and any other the type check names)

**Interfaces:**
- Produces:

```ts
// src/config/load.ts
export interface GateSettings {
  enabled: boolean;
  branches: string[];                          // the base branches whose pull requests are gated
  checkName: string;
  mode: 'enforce' | 'shadow' | 'bypass';
  clearByReply: boolean;                       // O18
  skipTeam: string | null;                     // "org/team-slug"
  requiredChecks: string[];                    // the names /done reads
}
export const GATE_OFF: GateSettings = { enabled: false, branches: [], checkName: 'AI Review', mode: 'enforce', clearByReply: true, skipTeam: null, requiredChecks: [] };
// RepoSettings gains gate: GateSettings
export type RepoOverride = Partial<Omit<RepoSettings, 'gate'>> & { gate?: Partial<GateSettings> };
// DeploymentConfig.repositories becomes { defaults: RepoSettings; overrides: Record<string, RepoOverride> }
/** What of the gate some repository switches on. */
export interface GateUse { check: boolean; statuses: boolean; members: boolean; bypass: boolean }
export function gateUseOf(config: DeploymentConfig): GateUse;
// src/gate/gating.ts
export type Gating = 'off' | 'enforce' | 'shadow' | 'bypass';
export function gatingOf(settings: RepoSettings, baseBranch: string): Gating;
/** Whether a pull request with this gating is reviewed only when asked: enforce and bypass. */
export function reviewedOnRequest(gating: Gating): boolean;
```

**Rules (9, 11.1, D10):**

1. **The keys,** under `repositories.defaults.gate` and `repositories.overrides.<name>.gate`, both strict (an unknown key is a config error):

   | Key | Value | When not written |
   |---|---|---|
   | `enabled` | boolean | `false` |
   | `branches` | at most 50 strings of 1 to 200 characters | `[]` |
   | `checkName` | 1 to 100 characters, each printable ASCII (`\x20` to `\x7E`) | `AI Review` |
   | `mode` | `enforce`, `shadow` or `bypass` | `enforce` |
   | `clearByReply` | boolean | `true` |
   | `skipTeam` | `<org>/<team-slug>`: the org 1 to 39 letters, digits or hyphens; the slug 1 to 100 letters, digits, dots, underscores or hyphens; or `null` | `null` |
   | `requiredChecks` | at most 20 strings of 1 to 200 characters | `[]` |

   In an override every key is optional.
2. **An override replaces only the gate keys it sets:** `repoSettingsFor` answers `{ ...defaults, ...override, gate: { ...defaults.gate, ...override.gate } }`.
3. **Half a gate stops the start.** When the defaults, or the settings of an override once merged, have `enabled` true and no branch: a `ConfigError` whose issue is `repositories.defaults.gate.branches: must name at least one branch when the gate is enabled`, or `repositories.overrides.<name>.gate.branches: must name at least one branch when the gate is enabled`. No issue quotes a value.
4. **`gatingOf`** is `off` when `enabled` is false or `baseBranch` is not in `branches` (compared exactly, case and all); else the `mode`.
5. **`gateUseOf`** looks at the defaults and at each override once merged: `check` when one has the gate enabled; `statuses` when one has it enabled with a required check named; `members` when one has it enabled with a skip team; `bypass` when one has it enabled in the mode `bypass`.
6. **The example file** shows the block in the defaults, commented, with `enabled: true`, `branches: [main]` and every other key at its default, `skipTeam: acme/release-managers` and `requiredChecks: [build]`. An empty line stands between the commented `score` block and the gate's comment, because the test's `uncomment` stops only at a line that does not begin with the indent and `#`. The explanation stands above `    # gate:`; inside the block there are only keys. It says in plain words: what gated means; that a gated pull request is reviewed on `/done`, `/review` or a re-run and not on a push; what each mode does; that `clearByReply: false` leaves only a review or a skip as the way past a finding; that the check must also be made required in GitHub; and that none of this can be set from inside a reviewed repository (D10).

- [ ] **Step 1: Write the failing tests.**

```ts
// load.test.ts
test('the gate is off unless a repository switches it on, and an override replaces only the keys it sets', () => {
  /* nothing written: defaults.gate deep-equals GATE_OFF. defaults.gate { enabled: true, branches: [main], mode: bypass } and an override
     acme/shop.gate { branches: [main, release] }: repoSettingsFor(c, 'Acme/Shop').gate has enabled true, both branches and mode bypass; another repository has [main] */
});
test('an enabled gate with no branch is refused, for the defaults and for one repository', () => {
  /* defaults enabled with no branches: the issue of rule 3. An override { gate: { enabled: true } } over defaults with no branches: the override's issue.
     An override { gate: { enabled: true } } over defaults that name a branch: accepted */
});
test('a gate key of the wrong kind, an unknown gate key and a malformed team are refused by name', () => {
  /* mode 'audit'; checkName ''; a checkName with a line feed; skipTeam 'release-managers'; skipTeam 'acme/release managers'; 21 required checks; gate.colour: red.
     Each issue starts with repositories.defaults.gate and holds none of the values */
});
test('what of the gate is in use is read from every repository', () => {
  /* no gate: all four false. One override enabled with requiredChecks: check and statuses. Defaults enabled, mode bypass, with a skipTeam: check, members, bypass.
     A skipTeam named while the gate is not enabled: members false */
});
test('the example with its gate block switched on parses to a gate on main', () => {
  /* uncomment(example(), '    # gate:'): gate enabled, branches [main], checkName 'AI Review', mode enforce, clearByReply true, skipTeam acme/release-managers, requiredChecks [build];
     and uncomment(example(), '    # score:') still leaves the gate off */
});
// gating.test.ts
test('a pull request is gated when its repository has the gate on and its base branch is listed', () => {
  /* off when not enabled; off for base 'feature/x'; off for 'Main' against [main]; enforce, shadow and bypass by the mode */
});
test('enforce and bypass are reviewed only when asked; shadow and off are not', () => { /* reviewedOnRequest */ });
// test/boundaries.test.ts
test('the gate may not import the GitHub adapter or a Postgres client', async () => { /* 'src/gate/x.ts': both give no-restricted-imports */ });
```

- [ ] **Step 2: Run them and see them fail.** The boundaries test holds before and after and is a pin.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a gate block in the deployment config, off by default`.

---

### Task 2: The tables, and a second lane in the queue

**Files:**
- Create: `src/db/migrations/0008_gate.sql`, `src/db/gate.ts`
- Modify: `src/db/jobs.ts`, `src/db/human-activity.ts`, `src/db/pull-requests.ts`, `src/shell/runner.ts`, `src/service.ts` (one argument)
- Test: `src/db/gate.test.ts` (new), `src/db/jobs.test.ts`, `src/db/human-activity.test.ts`, `src/db/pull-requests.test.ts`, `src/db/migrate.test.ts`, `src/shell/runner.test.ts`, `src/shell/recovery.test.ts`

**Interfaces:**
- Consumes, as they are in `src/db/jobs.ts`:

```ts
export async function enqueueJob(db: Db, j: {
  ref: PullRequestRef; reason: string; headSha: string; runAt: string; now: string; delivery: string | null; replace: boolean;
  trigger: 'automatic' | 'manual'; requestedBy: string | null; commentId: string | null; association: string | null; installation: string | null;
}): Promise<number | null>
export async function requeueJob(db: Db, id: number, runAt: string, now: string, giveBackStart: boolean): Promise<'requeued' | 'superseded'>
```

- Produces:

```ts
// src/db/jobs.ts
export type JobKind = 'review' | 'gate';
// Job gains kind: JobKind. The argument of enqueueJob gains kind?: JobKind; absent reads as 'review'.
export async function dueJobs(db: Db, now: string, limit: number, kind: JobKind): Promise<Job[]>;
/** The review jobs of a pull request that are not finished (pending or running), lowest id first. */
export async function reviewJobsOf(db: Db, ref: PullRequestRef): Promise<Job[]>;
/** Stores a gate job of reason `sync` for the pull request, due at `runAt` (at `now` when not given). A pending sync is kept as it is and only takes this time. null when a pending command of the gate stands in the slot: it asks again when it ends. */
export async function askGate(db: Db, ref: PullRequestRef, now: string, runAt?: string): Promise<number | null>;

// src/db/gate.ts
export type GateState = 'waiting' | 'paused' | 'reviewing' | 'passed' | 'blocked' | 'failed' | 'skipped' | 'bypassed';
export interface GateCounts {
  blocking: number; clearedByReview: number; clearedByReply: number; silentResolves: number; unknownThreads: number;
  findings: number; notReviewed: number; withoutThread: number; refusedInline: number;
}
export const NO_COUNTS: GateCounts = { blocking: 0, clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: 0, notReviewed: 0, withoutThread: 0, refusedInline: 0 };
export interface Evaluation {
  ref: PullRequestRef; headSha: string; at: string;
  mode: 'enforce' | 'shadow' | 'bypass'; state: GateState;
  code: string | null;                 // of a failure or a pause
  run: number | null;                  // the review run the check was decided on
  counts: GateCounts;
}
export async function recordEvaluation(db: Db, e: Evaluation): Promise<void>;
/** The newest evaluation of the pull request, or null. */
export async function lastEvaluation(db: Db, ref: PullRequestRef): Promise<{ headSha: string; mode: string; state: string; code: string | null } | null>;
/** The newest evaluation of each pull request that has one. */
export async function lastEvaluations(db: Db): Promise<Array<{ ref: PullRequestRef; mode: string; state: string }>>;
export interface Skip { ref: PullRequestRef; headSha: string; actor: string; reason: string; commentId: string; at: string }
/** false when this comment's skip was already stored. */
export async function recordSkip(db: Db, s: Skip): Promise<boolean>;
/** The newest skip stored for this head of the pull request, or null. */
export async function skipOf(db: Db, ref: PullRequestRef, headSha: string): Promise<{ actor: string; reason: string } | null>;

// src/db/human-activity.ts
/** The text of a general comment a person wrote on the pull request, or null when none is stored under that id. */
export async function commentBody(db: Db, ref: PullRequestRef, commentId: string): Promise<string | null>;
// src/db/pull-requests.ts
/** Every stored pull request whose state is open, with its base branch. */
export async function openPullRequests(db: Db): Promise<Array<{ ref: PullRequestRef; baseBranch: string }>>;

// src/shell/runner.ts
// RunnerDeps gains kind: JobKind, and
//   onLeft?: (job: Job, how: 'ended' | 'too_old' | 'attempts_exhausted') => Promise<void>
// Runner gains holds(ref: PullRequestRef): boolean   -- whether a job of that pull request is running in this process
```

**Rules (8.2, 13, D13):**

1. **The migration,** exactly:

```sql
alter table visto_ai.jobs add column kind text not null default 'review';
drop index visto_ai.jobs_one_pending;
create unique index jobs_one_pending on visto_ai.jobs (service, owner, repo, number, kind) where status = 'pending';

create table visto_ai.gate_evaluations (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  head_sha text not null,
  at timestamptz not null,
  mode text not null,
  state text not null,
  code text,
  run integer,
  blocking integer not null, cleared_by_review integer not null, cleared_by_reply integer not null,
  silent_resolves integer not null, unknown_threads integer not null,
  findings integer not null, not_reviewed integer not null, without_thread integer not null, refused_inline integer not null
);
create index gate_evaluations_pull_request on visto_ai.gate_evaluations (service, owner, repo, number, id);

create table visto_ai.gate_overrides (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  head_sha text not null,
  actor text not null,
  reason text not null,
  comment_id text not null,
  at timestamptz not null,
  unique (service, comment_id)
);
create index gate_overrides_head on visto_ai.gate_overrides (service, owner, repo, number, head_sha);
```

2. **One pending job for each pull request and kind.** `enqueueJob` writes the kind and names it in its conflict target; inside one kind every rule of today holds (a replacing job takes the pending one's place with its starts at 0; an automatic job never replaces a pending manual one; `replace: false` leaves the pending one). A review job and a gate job of one pull request can both be pending.
3. **`dueJobs`** lists the pending jobs of one kind. `claimJob`, `finishJob`, `dropJobIfUnchanged`, `unfinishedJobs`, `getJob` and `deleteFinishedJobs` go by id or take every kind, as today; a job they return carries its kind. `reviewJobsOf` reads the jobs of kind `review` with status `pending` or `running` of that pull request.
4. **`requeueJob`.** A job is superseded only by a pending job of its own kind. A review job is put back exactly as today. For a gate job two things are new:
   - **A command keeps its place.** When the job put back has the trigger `manual` and the pull request's pending gate job has the trigger `automatic` (a `sync`), that pending job is dropped with the outcome `superseded`, finished at `now`, and the command goes back to pending. When a `sync` is stored between the two statements, they are run once more. A pending gate job with the trigger `manual` supersedes the command, as today.
   - **A `sync` hands on its starts.** An automatic gate job put back while an automatic gate job is pending is superseded, as today, and the pending job's count of starts becomes the higher of the two.
   `recoverJobs` calls `requeueJob` and so follows both.
5. **`askGate`** is its own statement, not `enqueueJob` with `replace`, because a replaced job's starts go back to 0. It inserts a pending job with `kind: 'gate'`, `reason: 'sync'`, `headSha: ''`, `trigger: 'automatic'`, starts 0, no delivery and every other field null. When the pull request has a pending gate job: an automatic one keeps every field, its starts and its creation time included, and only takes the new `run_at`; a manual one is left as it is, and null is answered.
6. **`gate.ts`** follows the module conventions of `src/db`. `recordSkip` inserts with `on conflict (service, comment_id) do nothing`. `skipOf` answers the row with the highest id for that head. `lastEvaluation` and `lastEvaluations` answer the row with the highest id of a pull request.
7. **`commentBody`** reads `human_activity` where `kind = 'general_comment'` and `source_id` is the id, for that pull request.
8. **The runner** lists only the due jobs of `deps.kind`. `holds(ref)` is true from the moment a job of that pull request is started until its `run` has ended, the names compared in lower case. `onLeft`, when given, is awaited inside a `try` whose failure is logged as `{ event: 'runner_failed', job, ...describe(err) }`: with `'ended'` after a job's `run` has ended, also when it threw and the job was finished as `failed`, and only once the runner no longer holds its pull request; with `'too_old'` or `'attempts_exhausted'` after the runner dropped a job for that reason. `drain` waits for it.
9. **`src/service.ts`** gives its runner `kind: 'review'`. Nothing else changes in it.

- [ ] **Step 1: Write the failing tests.**

```ts
// migrate.test.ts: '0008_gate' comes right after '0007_score_surroundings'.
// jobs.test.ts
test('a job has a kind, and one stored without it is a review job', async () => { /* enqueue with and without kind; a row inserted by SQL without the column reads 'review' */ });
test('a pull request can have a pending review job and a pending gate job, and one of each at most', async () => {
  /* review then gate: two pending. A second gate job with replace false: null. With replace true: the gate job's fields change and the review job is untouched */
});
test('the due jobs are listed for one kind', async () => { /* one of each due: dueJobs(.., 'gate') has the gate job only */ });
test('a review job put back is superseded by a waiting review job as before, and never by a gate job', async () => {
  /* a pin for the review lane: a running manual review job with a pending automatic review job: superseded; with a pending gate job only: requeued */
});
test('a gate command put back takes the slot of a waiting sync, and loses it only to a later command', async () => {
  /* Review Focus 4: a running manual gate job with a pending sync: requeued, the sync dropped as superseded; with a pending manual gate job: superseded, that job untouched */
});
test('a sync put back beside a waiting sync hands it its starts', async () => {
  /* Review Focus 8: a running sync with 2 starts and a pending sync with 0: superseded, and the pending one now has 2; a pending one with 3 keeps 3 */
});
test('asking for the check stores one sync, moves a waiting sync to the new time without touching its starts, and leaves a waiting command in place', async () => {
  /* askGate twice, the second with runAt 3 s later: one pending job, due at the later time, with the first one's creation time. A sync put back after two starts and asked for again: still 2 starts.
     With a pending manual gate job of reason 'skip': null, and that job unchanged */
});
test('the unfinished review jobs of a pull request are listed, never a gate job, a finished one or another pull request\'s', async () => { /* one running and one pending: both, lowest id first */ });
// gate.test.ts
test('an evaluation is stored with its counts, and the newest is read back for one pull request and for each', async () => {
  /* two rows for #7, one for #8, written with owner 'Acme': lastEvaluation(#7) has the later head, mode, state and code; lastEvaluations has two entries, lower-case; lastEvaluation(#9) is null */
});
test('a skip is stored once for a comment, and the newest skip of a head is the one read', async () => {
  /* recordSkip true then false for the same comment id; two comments on h1: skipOf(h1) is the later; skipOf(h2) null; a reason with a NUL character is stored without it */
});
// human-activity.test.ts
test('the text of a stored general comment is read by its id', async () => { /* found; another pull request's id: null; an inline comment with that id: null */ });
// pull-requests.test.ts
test('the open pull requests are listed with their base branch', async () => { /* one open, one closed, one merged: the open one */ });
// runner.test.ts
test('a runner takes only the jobs of its kind', async () => { /* one review job and one gate job due: the 'gate' runner starts the gate job only */ });
test('the runner says whether it holds a job of a pull request', async () => { /* false before the start; true while the job runs, also asked with owner 'Acme'; false once it ended; false for #8 throughout */ });
test('the runner tells when a job has left it, and by then it no longer holds the pull request', async () => {
  /* Review Focus 2: a run that resolves: onLeft(job, 'ended'), and holds() is false inside the hook; a run that throws: the same, after the job was finished as failed;
     a job a day old: 'too_old'; a job with three starts: 'attempts_exhausted'; an onLeft that rejects is logged as runner_failed and stops nothing; drain waits for the hook */
});
// recovery.test.ts
test('a running gate job and a running review job of one pull request are both put back', async () => { /* requeued 2, dropped 0 */ });
test('a command cut by a stop takes the slot of the sync stored meanwhile', async () => {
  /* Review Focus 4: a running gate job of reason 'done' and a pending sync of the same pull request: after recoverJobs the 'done' job is pending and the sync dropped as superseded */
});
```

- [ ] **Step 2: Run them and see them fail.** The pin holds before and after.
- [ ] **Step 3: Implement.** Every existing call of `dueJobs` and `createRunner` in tests gains the kind `review`; no existing test changes in what it asserts.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: tables for the gate's history and skips, and a lane of the queue for its jobs`.

---

### Task 3: The check run, and what else the gate asks GitHub

**Files:**
- Create: `src/forge/github/checks.ts`
- Modify: `src/forge/types.ts`
- Test: `src/forge/github/checks.test.ts` (new; a stub `fetch` that answers by method and path and records each request, as in `src/forge/github/writer.test.ts`)

**Interfaces:**
- Consumes, as they are: `AppAuth.installationToken(installation: string): Promise<string>` (`src/forge/github/app-auth.ts`); from `src/forge/github/http.ts`, `createGithubHttp(opts: { token: string; fetch: typeof fetch; apiBase?: string })`, whose `send(method: string, url: string, accept: string): Promise<Response>` refuses anything but GET and tries a GET once more after a network failure or a 5xx, and whose `repoUrl(ref: RepoRef): string` rejects odd names with `github_bad_path`; `isObject`; `jsonOf(res: Response): Promise<unknown>`.
- Produces:

```ts
// src/forge/types.ts
export interface OwnCheck {
  id: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;         // as the git service names it; null while the check is not completed
  title: string; summary: string;    // '' when the check has none
}
export interface CheckWrite {
  id: string | null;                 // the check to rewrite; null creates one on `commit`
  commit: string; name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'action_required' | 'failure' | null;   // set exactly when the status is completed
  title: string; summary: string;
}
export interface ForgeChecks {
  /** The app's own check of that name on a commit, the newest when there are several; null when there is none. Rejects with a short code. */
  findCheck(ref: PullRequestRef, installation: string, commit: string, name: string): Promise<OwnCheck | null>;
  /** Creates the check, or rewrites the one named by `id`. Sent once. Rejects with a short code and says nothing about whether it took effect. */
  writeCheck(ref: PullRequestRef, installation: string, check: CheckWrite): Promise<{ id: string }>;
  /** Those of `names` that are green on the commit: every commit status and newest check run of that name says success, and at least one reports it. Rejects with a short code. */
  greenChecks(ref: PullRequestRef, installation: string, commit: string, names: string[]): Promise<string[]>;
  /** Whether `login` is an active member of the team `<org>/<slug>`. Rejects with a short code when the git service did not say. */
  isTeamMember(installation: string, team: string, login: string): Promise<boolean>;
}
// src/forge/github/checks.ts
export const MAX_CHECK_PAGES = 10;
export const MAX_TITLE_CHARS = 255;
export const MAX_SUMMARY_CHARS = 60_000;
export function createGithubChecks(opts: { auth: AppAuth; appId: string; fetch: typeof fetch; apiBase?: string; webBase?: string }): ForgeChecks;
```

**Rules (9, 10):** `apiBase` is `https://api.github.com` and `webBase` `https://github.com` when not given. Every request carries the installation's token and the headers the writer sends. An installation or an app id that is not digits, a commit that is not 1 to 64 letters and digits, or a name `repoUrl` refuses, rejects `github_bad_path` before anything is sent. In every method an answer that is not 2xx rejects `github_<status>` unless a rule says otherwise, a failed network `github_network`, and an answer of another shape than the rule names `github_bad_response`. The reads go through `createGithubHttp`; the two writes have their own sender, as in `src/forge/github/writer.ts`.

1. **`findCheck`:** `GET <repo>/commits/<commit>/check-runs?check_name=<name, percent-encoded>&app_id=<appId>&per_page=100`. The answer must be an object with a list `check_runs`. Kept: the entries whose `name` is the name and whose `app.id`, as text, is `appId`. Of those the one with the highest `id`. Its `id` must be a whole number and its `status` one of the three, else `github_bad_response`; `conclusion` is its text or null; `output.title` and `output.summary` are their text, or `''`.
2. **`writeCheck`:** a status of `completed` with no conclusion, or another status with one, rejects `bad_check` before anything is sent. With `id` null: `POST <repo>/check-runs` with `name`, `head_sha` (the commit), `status`, `output: { title, summary }`, `external_id` (the pull request's number as text), `details_url` (`<webBase>/<owner>/<repo>/pull/<number>`), and `conclusion` when there is one. With an `id` (digits, else `github_bad_path`): `PATCH <repo>/check-runs/<id>` with the same body without `head_sha`; this is also how a completed check goes back to `queued` or `in_progress` (call 48). Sent once, with `redirect: 'manual'`. The answer must hold a whole-number `id`, else `github_bad_response`, and the `status` that was sent: another status rejects `check_not_rewritten`. The title is cut to `MAX_TITLE_CHARS` and the summary to `MAX_SUMMARY_CHARS`, each then made well-formed (`toWellFormed()`).
3. **`greenChecks`:** `GET <repo>/commits/<commit>/status?per_page=100` (an object with a list `statuses`, each entry with a text `context` and `state`), and `GET <repo>/commits/<commit>/check-runs?per_page=100&page=<n>` from page 1 until a page holds fewer than 100 runs; when page `MAX_CHECK_PAGES` is full too, it rejects `github_too_many_pages`. For a name, the places that report it are the status whose `context` is the name, and, among the check runs whose `name` is the name, the one with the highest `id`. The name is green when at least one place reports it, the status (if any) has `state` `success`, and the check run (if any) has `status` `completed` and `conclusion` `success`. The answer keeps the order of `names`. An empty `names` sends nothing and answers `[]`.
4. **`isTeamMember`:** the team must be `<org>/<slug>` and the login 1 to 39 letters, digits or hyphens, else `github_bad_path`. `GET <apiBase>/orgs/<org>/teams/<slug>/memberships/<login>`. 200: true when the answer's `state` is `active`, else false. 404: false.

- [ ] **Step 1: Write the failing tests.**

```ts
test("the app's own check on a commit is found by its name and the app's id, the newest when there are several", async () => {
  /* the request's path and query, with the name 'AI Review' encoded; two runs of app 12345 named 'AI Review' with ids 70 and 71, the lower listed last: id '71' with its status, conclusion, title and summary */
});
test("another app's check of the same name, and the app's check of another name, are not it", async () => { /* null */ });
test('no check gives null; an answer that is no list, and a status GitHub does not have for a check of ours, are refused', async () => { /* null; github_bad_response twice; a 502 twice: github_502 */ });
test('a new check is posted once, with its commit, the pull request number it is for and the pull request page', async () => {
  /* POST /repos/acme/shop/check-runs; body { name, head_sha, status: 'queued', output, external_id: '7', details_url: 'https://github.com/acme/shop/pull/7' }, no conclusion; answers { id: '71' } */
});
test('a known check is rewritten by its id, without the commit', async () => { /* PATCH /repos/acme/shop/check-runs/71; no head_sha; conclusion 'action_required' with status completed */ });
test('a rewrite GitHub answers while keeping the old status is an error with its own code', async () => {
  /* call 48: 'in_progress' is sent and the answer says status 'completed': check_not_rewritten; the answer says 'in_progress': { id: '71' } */
});
test('a completed check with no conclusion, and an open one with a conclusion, are refused before anything is sent', async () => { /* bad_check; no request */ });
test('a write GitHub refuses or that fails has a short code and is never sent twice', async () => { /* 403, 422, 502: github_<status>, one request each; fetch throws: github_network; an answer with no id: github_bad_response */ });
test('a title and a summary too long for GitHub are cut', async () => { /* 300 and 70,000 characters: 255 and 60,000 sent; a cut inside a surrogate pair leaves well-formed text */ });
test('a required check is green when every place that reports it says success', async () => {
  /* statuses: build success, lint pending. check runs: test (ids 5 failure, 9 success), build (success), deploy (in_progress).
     greenChecks([build, test, lint, deploy, docs]) is [build, test]; a status success with a failed check run of the same name is not green; no name sends nothing */
});
test('the check runs of a commit are read page by page, to the cap', async () => { /* 100 then 3: two requests; ten full pages: github_too_many_pages */ });
test('an active member of the team is a member; a pending one, and one GitHub does not find, are not', async () => { /* the path /orgs/acme/teams/release-managers/memberships/octo-lead; true; false; false */ });
test('a lookup GitHub refuses or fails is an error, never "not a member"', async () => { /* 403: github_403; 500 twice: github_500; fetch throws twice: github_network */ });
test('odd names never reach a URL', async () => { /* a team with no slash; a login with a slash; a commit with a slash; an installation 'x'; an id 'x': github_bad_path, no request */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: the app's check run, required checks and team membership, asked of GitHub`.

---

### Task 4: The re-run event, the feature table and the manifest

**Files:**
- Modify: `src/forge/types.ts`, `src/forge/github/events.ts`, `src/shell/capture.ts`, `src/forge/github/app-info.ts`, `src/forge/github/app-manifest.json`, `src/service.ts` (the app check)
- Test: `src/forge/github/events.test.ts`, `src/shell/capture.test.ts`, `src/forge/github/app-info.test.ts`, `src/forge/github/app-manifest.test.ts`, `src/service.test.ts`

**Interfaces:**
- Consumes: `gateUseOf` (Task 1); and, as they are, `eventOf(name: string, payload: unknown): ForgeEvent`, `captureOf(event: ForgeEvent, delivery: string, receivedAt: Date): Capture`, `missingFor(info: AppInfo, dryRun: boolean): FeatureOff[]` and `AppIdentity.lacks(dryRun: boolean): Promise<FeatureOff[]>`.
- Produces:

```ts
// src/forge/types.ts
// ForgeEvent gains:
//   | { kind: 'check_rerun'; ref: PullRequestRef; installation: string | null; app: string; check: string; headSha: string; actor: string }
//   app: the id of the app the check run belongs to; check: its name
export interface GateNeeds { check: boolean; statuses: boolean; members: boolean }
// FeatureOff['feature'] gains 'gate'
// AppIdentity.lacks becomes: lacks(dryRun: boolean, gate?: GateNeeds): Promise<FeatureOff[]>;
// src/forge/github/app-info.ts
export function missingFor(info: AppInfo, dryRun: boolean, gate?: GateNeeds): FeatureOff[];
```

**Rules (8.1, 8.4, 10, 14):**

1. **`check_run`** with the action `rerequested` becomes a `check_rerun` event: `check` is `check_run.name`, `headSha` is `check_run.head_sha`, `app` is `check_run.app.id` as text, `actor` the sender's login, `installation` as other events read it. The pull request's number is `check_run.external_id` when that is 1 to 10 digits and a whole number above 0; else the `number` of the first entry of `check_run.pull_requests`; with neither the event is `{ kind: 'ignored', reason: 'not_a_pull_request' }`. Any other action is `unknown_action`. A payload that lacks one of these, or holds an id longer than `MAX_ID_CHARS`, is `malformed`.
2. **A re-run of a whole check suite is not taken in:** `check_suite` stays an unknown event, whatever its action.
3. **`captureOf`** answers `{ outcome: 'handled', pullRequest: null, activity: null }` for a `check_rerun`: a re-run stores no activity.
4. **What a configured gate needs.** `missingFor` with no `gate`, or with all three false, answers what it answers today. Out of dry run only: with `check`, `need('gate', 'checks', 'write')` and `subscribe('gate', 'check_run')`; with `statuses`, `need('gate', 'statuses', 'read')`; with `members`, `need('gate', 'members', 'read')`. In dry run the gate needs nothing.
5. **The manifest** asks for `pull_requests: write`, `contents: write`, `issues: write`, `checks: write`, `statuses: read`, `members: read`, `metadata: read`, and the events `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`. An app made from it lacks nothing with every gate need true, in dry run and out of it; and taking out any permission but `metadata`, or any event, makes `missingFor` name it when every need is true.
6. **The service** asks `deps.appInfo.lacks(config.dryRun, gateUseOf(config))`. With no gate configured the app is asked for nothing more and told nothing more.

- [ ] **Step 1: Write the failing tests.**

```ts
// events.test.ts
test('a re-run of a check names its pull request by the number the check carries, else by the first one GitHub lists', () => {
  /* external_id '7' and pull_requests [{ number: 9 }]: number 7. external_id '' and pull_requests [{ number: 9 }]: 9. The event holds app '12345', check 'AI Review', headSha, actor, installation '99' */
});
test('a re-run that names no pull request is not one, and another action of a check run is unknown', () => {
  /* external_id 'build-41' and no pull_requests: ignored not_a_pull_request; actions created, completed, requested_action: ignored unknown_action */
});
test('a check run with no name, no app or no head is malformed', () => { /* */ });
test('a re-run of a check suite is not taken in', () => { /* a pin: eventOf('check_suite', { action: 'rerequested', ... }) is ignored as unknown_event */ });
// capture.test.ts
test('a re-run is handled and stores nothing', () => { /* */ });
// app-info.test.ts
test('with no gate configured the app lacks what it lacked before', () => { /* missingFor(info, false) deep-equals missingFor(info, false, { check: false, statuses: false, members: false }), for an app with nothing */ });
test('a configured gate needs the check permission and the check_run event; required checks need statuses; a skip team needs members', () => {
  /* an app with today's manifest: [{gate, checks:write}, {gate, event:check_run}] for check alone; + {gate, statuses:read}; + {gate, members:read}; checks 'read' is still missing write */
});
test('in dry run the gate needs nothing', () => { /* every need true, dryRun true: nothing of the feature gate */ });
// app-manifest.test.ts: the four existing tests are brought to the new list (six permissions without metadata, six events, checks lowered to read is named), each called with every need true.
// service.test.ts
test('the app is asked for what the configured gate needs', async () => { /* a config with the gate on and a skip team: lacks was called with { check: true, statuses: false, members: true, bypass: false }; with no gate: all false */ });
```

- [ ] **Step 2: Run them and see them fail.** The check-suite test holds before and after and is a pin.
- [ ] **Step 3: Implement.** `src/forge/github/create-app.ts` is not changed: it sends whatever the file holds.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: a re-run of the check is an event, and the app's manifest and feature table know the gate`.

---

### Task 5: The rule

**Files:**
- Create: `src/gate/rule.ts`
- Test: `src/gate/rule.test.ts` (new)

**Interfaces:**
- Consumes, as they are: `ReviewThread`, `ThreadComment` (`src/forge/types.ts`); `StoredComment`, `NOTE` (`src/db/review-comments.ts`); `StoredRun` (`src/db/review-runs.ts`).
- Produces:

```ts
// src/gate/rule.ts
export interface Blocking {
  thread: string; commentId: string;            // the thread, and its first comment
  path: string; line: number | null;
  severity: 'blocker' | 'major' | 'unknown';    // unknown: the app's own thread with no stored finding
  why: 'open' | 'resolved_no_reply' | 'resolved_reply_off';
  unread: boolean;                              // the head's review kept no verdict on it and did not read its file
}
export interface GateVerdict {
  blocking: Blocking[];        // the lowest first comment first
  clearedByReview: number; clearedByReply: number;
  silentResolves: number;      // blocking threads that are resolved
  unknownThreads: number;      // blocking threads of unknown severity
  findings: number;            // the app's own threads that are a blocker, a major, a minor or unknown, cleared or not
}
/** The newest published run of these, not a dry run, whose head and base are the ones given; null when there is none. */
export function reviewedRun(runs: StoredRun[], head: string, base: string): StoredRun | null;
/** How many major and blocker findings the newest published review of this head and base that was posted without its inline comments had placed on the diff; 0 when there is no such review. */
export function refusedInline(runs: StoredRun[], head: string, base: string): number;
/** Which threads block the merge. Pure; reads no comment's text; never throws on a damaged run. */
export function evaluateGate(args: {
  threads: ReviewThread[]; stored: Array<StoredComment & { run: number }>; runs: StoredRun[];
  reviewed: StoredRun;         // the head's review
  clearByReply: boolean;
}): GateVerdict;
```

**Rules (9, 5.6, 8.4, O18):**

1. **A run's verdict on a thread** is, in `run.result.threadVerdicts` (when the result is an object and that a list), the first entry that is an object whose `threadId` is the thread's id and whose `verdict` is `fixed`, `answered` or `open`. Its `replies` counts only when it is a whole number at or above 0. Anything else is no verdict.
2. **Which threads are looked at.** The app's own (its first comment has `byApp` true), each id once. The stored comment whose `commentId` is the first comment's `id` gives the severity: `blocker` and `major` gate; `minor` counts among the findings and never gates; `note` is nothing; no stored comment, or any other word, is `unknown` and gates.
3. **Cleared, the first that applies:**
   - **Verified.** `reviewed` has a verdict of `fixed` or `answered` on the thread, and, when that verdict has `replies`, no comment after the first `1 + replies` comments of the thread was written by someone other than the app. Counts as cleared by a review.
   - **Resolved by the app.** The thread is resolved, `resolvedByApp` is true, and the published run with the highest id that has any verdict on the thread has `fixed` or `answered`. Counts as cleared by a review.
   - **Answered by a person.** `clearByReply` is true, the thread is resolved, and a comment after the first is a person's. Counts as cleared by a reply.
4. **Else it blocks.** `why` is `open` when the thread is not resolved; `resolved_reply_off` when it is resolved and a comment after the first is a person's; else `resolved_no_reply`. `unread` is true when the severity is not `unknown`, `reviewed` has no verdict on the thread, and the thread's path is not in `reviewed.result.coverage.reviewed` (when that is a list; when it cannot be read, `unread` is false).
5. A thread of another account never gates, whatever it says. A comment by a bot, by the app or by a deleted account (`authorIsBot` true) is not a person's.
6. **`refusedInline`** (call 45). Among the published runs that are not dry runs and have this head and base, the one with the highest id whose `inlineDropped` is true and whose `result.findings` (when a list) holds an entry with the severity `major` or `blocker`: the number of such entries. With no such run, 0. A newer published run of the same head and base that was posted with its comments, a re-check among them, does not undo it.

- [ ] **Step 1: Write the failing tests.** `thread(over)` builds an open thread of the app at `src/a.ts` line 12 whose first comment is `8001`; `run(id, over)` a published run at `h1` against `b1` whose result says it read `src/a.ts`; `STORED` holds `8001` as a major. The cases carried from the old gate map, section 3.1, are marked (c).

```ts
test('a thread a person opened never blocks, whatever its text says', () => { /* (c) first comment by octo-dev with the text '**[major]** x': no blocking, findings 0 */ });
test('an open major or blocker of the app blocks; a minor and a note never do', () => { /* (c) four threads: blocking has the major and the blocker, in order; findings 3 */ });
test('a fixed or answered verdict of the head\'s review clears the thread, resolved or not', () => { /* (c) clearedByReview 1 in both */ });
test('the verdict of a review of another head, of another base, of an unpublished run or of a dry run clears nothing', () => {
  /* (c) reviewedRun skips each; with reviewed set to the head's review, which kept no verdict, a fixed verdict in the older run of h0 does not clear */
});
test('of two published reviews of the head the newer is the head\'s review, also when it kept no verdict', () => { /* reviewedRun picks the higher id; the thread the older one verified blocks */ });
test('a verdict clears nothing once someone other than the app wrote in the thread after it was judged', () => {
  /* replies 1, and the thread has a second reply by octo-dev: blocks. The second reply by the app: clears. A verdict with no replies field: clears */
});
test('a thread the app resolved after clearing it stays cleared at a later head', () => { /* resolved, resolvedByApp, a fixed verdict in the run of h0, none in the head's review: clearedByReview 1 */ });
test('a thread named as resolved by the app blocks when its newest verdict is open or it has none', () => { /* Review Focus 6: both block as resolved_no_reply */ });
test('a resolved thread with a reply by a person clears, whoever resolved it and whenever the reply was written', () => { /* (c) resolvedByApp false; clearedByReply 1 */ });
test('a resolve with no reply, a reply with no resolve, and a reply by a bot or a deleted account clear nothing', () => {
  /* (c) resolved_no_reply and silentResolves 1; open; a reply with authorIsBot true then a resolve: resolved_no_reply */
});
test('with clearing by reply off only a review clears', () => { /* resolved with a person's reply: blocks as resolved_reply_off; verified: clears */ });
test("the app's own thread with no stored finding blocks as unknown, and clears like any other", () => {
  /* Review Focus 6: stored []: severity unknown, unknownThreads 1, findings 1, unread false; resolved with a person's reply: cleared by reply */
});
test('a thread whose file the head\'s review did not read is told apart', () => {
  /* Review Focus 6, call 47: the head's review read only src/b.ts and kept no verdict: the thread at src/a.ts blocks with unread true; it read src/a.ts and kept no verdict: unread false;
     it kept an open verdict: unread false; coverage that is not an object: unread false; with clearByReply true, a reply and a resolve clear the unread thread */
});
test('the hidden line clears nothing by itself', () => {
  /* Review Focus 6: an open major whose reply by octo-dev ends with '<!-- visto-ai: review=501 head=h1 -->', and one whose first comment ends with it: both block */
});
test('a review posted without its inline comments counts its major and blocker findings, and a later re-check of the head does not undo it', () => {
  /* Review Focus 6, call 45: a run at h1/b1 with inlineDropped and findings [major, blocker, minor]: 2; a newer published re-check at h1/b1 with no findings: still 2;
     inlineDropped with minors only: 0; the same findings in a run posted with its comments: 0; the refused run at h0, or against b0, or unpublished, or a dry run: 0; findings that is not a list: 0 */
});
test('the counts of a mixed pull request', () => {
  /* (c) an open major, a silently resolved blocker, a major the app resolved, a major cleared by reply, a minor, a person's thread:
     blocking 2, silentResolves 1, clearedByReview 1, clearedByReply 1, findings 5 */
});
test('a damaged result, a damaged verdict and a thread listed twice change nothing', () => { /* result 'x'; threadVerdicts 5; a verdict 'maybe'; the same thread id twice: one entry; nothing throws */ });
test('a stored severity that is no severity gates as unknown', () => { /* severity 'critical' */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: the gate's rule: which threads block a merge`.

---

### Task 6: What the check says, and the words of the commands

**Files:**
- Create: `src/gate/check.ts`, `src/gate/answers.ts`
- Modify: `src/shell/commands.ts`
- Test: `src/gate/check.test.ts`, `src/gate/answers.test.ts` (new), `src/shell/commands.test.ts`

**Interfaces:**
- Consumes: `GateVerdict`, `reviewedRun` (Task 5); `GateCounts`, `NO_COUNTS` (Task 2); `OwnCheck`, `CheckWrite` (Task 3); `inertInline` (`src/engine/render/body.ts`); `isShortCode` (`src/shell/codes.ts`).
- Produces:

```ts
// src/shell/commands.ts
export type Command = 'review' | 'done' | 'skip';
export function commandOf(body: string): Command | null;
/** The reason of a skip command: the rest of its line, trimmed; '' when there is none or the body gives no skip. */
export function skipReasonOf(body: string): string;
/** One sentence to the person who gave a command: "@login <text> (`code`)." The login is written only when it can be one; a code that is no short code is written internal_error. */
export function commandText(login: string | null, text: string, code: string): string;

// src/gate/check.ts
export type CheckPlan =
  | { state: 'waiting' }
  | { state: 'paused'; code: string }
  | { state: 'reviewing' }
  | { state: 'passed' | 'blocked'; verdict: GateVerdict; notReviewed: number; withoutThread: number; refused: number }
  | { state: 'failed'; code: string; evaluated: boolean }   // evaluated: the head has its review and the check could not be decided
  | { state: 'skipped'; actor: string; reason: string }
  | { state: 'bypassed' };
export interface CheckFacts {
  gating: 'enforce' | 'shadow' | 'bypass';
  head: string; base: string;                    // the live head, and the merge base
  skip: { actor: string; reason: string } | null;
  job: 'running' | 'pending' | null;             // whether a review of the pull request is under way
  paused: string | null;                         // why reviews are paused, when a job is pending
  runs: StoredRun[];
}
/** What the check says before any thread is read; null when the head has its review and the threads decide. */
export function planBefore(facts: CheckFacts): CheckPlan | null;
/** `refused`: what refusedInline answers for this head and base. */
export function planAfter(verdict: GateVerdict, reviewed: StoredRun, refused: number): CheckPlan;
export interface CheckMeta {
  head: string;
  canSkip: boolean;            // a skip team is named
  clearByReply: boolean;
  retrying: boolean;           // the service will try a failed evaluation again by itself
  threadUrl: (commentId: string) => string;
}
export type CheckText = Pick<CheckWrite, 'status' | 'conclusion' | 'title' | 'summary'>;
export function checkText(plan: CheckPlan, meta: CheckMeta): CheckText;
export function sameCheck(current: OwnCheck | null, wanted: CheckText): boolean;
export function countsOf(plan: CheckPlan): GateCounts;

// src/gate/answers.ts
export type SkipRefusal = 'not_allowed' | 'closed' | 'not_gated' | 'stale_head' | 'missing_reason' | 'no_skip_team' | 'not_team_member' | 'membership_unverified';
export function doneRefused(login: string | null, code: 'not_allowed' | 'closed'): string;
export function doneFailed(login: string | null, code: string): string;
export function nothingLeft(login: string | null, head: string): string;
export function skipRefused(login: string | null, code: SkipRefusal): string;
export function skipFailed(login: string | null, code: string): string;
```

**Rules:**

1. **The commands' grammar.** All three are read from the first line of the comment that is not empty, trimmed, in any letter case. `/review` as today. `/done`: the line is `/done`, alone or followed by a space or a tab. `/ai-review-skip`: the line is `/ai-review-skip`, alone or followed by a space or a tab; its reason is the rest of that line, trimmed. `/donezo`, `/ai-review-skipper`, a command on a later line and a command after other text are no command. `commandText` is today's private `sentence`, exported; `refusalText` and `failureText` are unchanged.
2. **`planBefore`,** the first that applies:
   1. `gating` is `bypass`: `bypassed`.
   2. `skip` is not null: `skipped` with its actor and reason.
   3. `job` is `running`: `reviewing`. `job` is `pending`: `paused` with the code when `paused` is not null, else `reviewing`.
   4. `reviewedRun(runs, head, base)` is not null: null.
   5. With `last` the run with the highest id among those that are not dry runs and have `headSha === head`: no such run, or it is published: `waiting`. Its outcome is `failed`: `failed`, not evaluated, with its `failureCode` when that is a short code, else `review_failed`. Its body is `''` and its result says `nothingToDo: true`: `waiting`. Its body is `''`: `failed` with `render_failed`. Otherwise: `failed` with `not_published`.
3. **`planAfter`:** `blocked` when a thread blocks or `refused` is above 0, else `passed`. `notReviewed` is the length of the run's `result.coverage.notReviewed` when that is a list, else 0. `withoutThread` counts the entries with severity `major` or `blocker` in `result.unplaced` and every entry of `result.unchanged`; a field that is no list counts 0. These do not block (9); what `refused` counts does (call 45).
4. **`checkText`.** Status and conclusion: `waiting` and `paused` are `queued`; `reviewing` is `in_progress`; `passed`, `skipped` and `bypassed` are `completed` with `success`; `blocked` is `completed` with `action_required`; `failed` is `completed` with `failure`. Paragraphs of a summary are joined by one empty line. `<code>` is the code when it is a short code, else `internal_error`. `<head12>` is the first 12 characters of the head with everything but letters and digits removed. `<n>` is the number of blocking threads, `<m>` is `refused`, `<f>` the verdict's `findings`, `<r>` and `<p>` its `clearedByReview` and `clearedByReply`, `<k>` is `notReviewed` and `<w>` is `withoutThread`. The texts, exactly:

```text
waiting    title    Waiting for /done
waiting    summary  Comment `/done` on this pull request when it is ready to be reviewed. The review then decides this check: a finding marked major or blocker has to be fixed or answered before the merge.

reviewing  title    Reviewing
reviewing  summary  A review of this pull request is under way or waiting for its turn. Its findings arrive as inline comments with one review, and this check is decided when the review is posted.

paused     title    Review waiting: reviews are paused (<code>)
paused     summary  spend_limit:    A review of this pull request was asked for and has not started: this deployment has reached its daily spending limit. Reviews start again with the next UTC day, and this one then starts by itself.
                    any other code: A review of this pull request was asked for and has not started: reviews are paused on the reviewer's side. This one starts by itself when they resume.

passed     title    No blocking findings                  when findings is 0
                    1 finding, none blocking              when findings is 1
                    <f> findings, none blocking           otherwise
passed     summary  first paragraph: Nothing blocks this merge.

blocked    title    1 blocking finding is open                                        when m is 0 and n is 1
                    <n> blocking findings are open                                    when m is 0 and n is above 1
                    Blocking findings open: <n + m> (<m> listed in the review only)   when m is above 0
blocked    summary  when n is above 0, three paragraphs:
                        These threads block the merge:
                        the list (rule 5)
                        the way out (rule 6)
                    when m is above 0, two more:
                        GitHub refused the inline comments of the review of this commit, so its findings could not be opened as threads. Major and blocker findings among them: <m>. They are listed in the review, and they block this merge.
                        To clear them, push a fix and comment `/done`: the review of the new commit decides.

both titles end with, when notReviewed is above 0:      "; 1 file not reviewed"   or   "; <k> files not reviewed"
both summaries then get, each only when its number is above 0, in this order:
                    Major and blocker findings cleared: <r> by a review, <p> by a reply in a resolved thread.          (when r + p is above 0)
                    Files not reviewed: <k>. The review lists them under Coverage, and this check is decided on the files that were reviewed.
                    Major and blocker findings the review could not place on the diff, or raised on code unchanged since the last review: <w>. The review lists them, and they do not block.

failed     title    Review failed (<code>): comment /done to retry               when not evaluated
                    Could not evaluate (<code>): comment /done to retry          when evaluated
failed     summary  when not evaluated:              The review of this commit did not finish or was not posted (`<code>`). Comment `/done` to run it again.
                    when evaluated and retrying:     The review was posted, but its threads could not be read to decide this check (`<code>`). The service tries again by itself. You can also comment `/done`.
                    when evaluated and not retrying: The review was posted, but its threads could not be read to decide this check (`<code>`). Comment `/done` to try again.

skipped    title    Skipped by @<login>
skipped    summary  three paragraphs:
                    The review was skipped for commit `<head12>` by `<login>`.
                    Reason: <reason>
                    A new commit ends the skip: its check waits for `/done` again.

bypassed   title    Gate bypassed
bypassed   summary  The merge gate is in bypass mode for this repository, so this check passes without a review. When bypass is switched off, the check goes back to what the gate's rule says.

last paragraph of the paused, the blocked and both failed summaries, when meta.canSkip:
                    The team that may skip can comment `/ai-review-skip <reason>` to let this commit through.
```

   In `skipped`, a login that is not 1 to 39 letters, digits or hyphens is written `a team member`, with no `@` in the title and no code span in the summary; the reason is its white space made single spaces, trimmed, cut to 300 characters and passed through `inertInline`. `inertInline` writes characters outside ASCII (a zero-width space after an `@`, for one): a test that compares its output writes each as an escape, never as the character. No text names the skip team.
5. **The list of a blocked summary:** one line for each blocking thread, in the verdict's order, at most 50; when there are more, a last line `- and <k> more`. A line is ``- **\[<severity>]** [`<where>`](<url>)<notes>``: `<severity>` is `blocker`, `major` or `unknown`; `<where>`, inside the code span, is the thread's path with every character that is not printable ASCII (`\x20` to `\x7E`), and every backtick, written `?`, cut to 200 characters, then `:<line>` when the thread has a line; `<url>` is `meta.threadUrl(commentId)`. So a major at `src/a.ts` line 12 reads ``- **\[major]** [`src/a.ts:12`](https://git.example.test/c/8001)``. The notes, in this order, each when it applies:
   - `why` is `resolved_no_reply`: ` (resolved with no reply from a person, so it still blocks)`
   - `why` is `resolved_reply_off`: ` (resolved; on this repository only a review clears it)`
   - `unread`, with clearing by reply on: ` (the review of this commit did not read this thread's file, so it could not judge it: reply in the thread and resolve it)`
   - `unread`, with it off: ` (the review of this commit did not read this thread's file, so it could not judge it: while that stays so, only a skip lets it through)`
   - severity `unknown`, with clearing by reply on: ` (this app has no record of this finding, so no review can clear it: reply in the thread and resolve it)`
   - severity `unknown`, with it off: ` (this app has no record of this finding, so no review can clear it: only a skip lets it through)`
6. **The way out,** with clearing by reply on: ``To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. You can also reply in the thread and resolve it yourself. Resolving a thread without a reply does not clear it.`` With it off: ``To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. On this repository, resolving a thread yourself does not clear it.``
7. **`sameCheck`:** the current check is there and has the same status, conclusion, title and summary. **`countsOf`:** for `passed` and `blocked`, the verdict's numbers (`blocking` is the length of the list) with `notReviewed`, `withoutThread`, and `refusedInline` from `refused`; `NO_COUNTS` for every other state.
8. **The answers,** each `commandText(login, <text>, <code>)` unless said otherwise:

```text
doneRefused                  `/done` was not accepted
doneFailed                   `/done` could not be handled
skipRefused not_allowed      `/ai-review-skip` was not accepted
skipRefused closed           `/ai-review-skip` was not accepted
skipRefused not_gated        `/ai-review-skip` was not accepted: this pull request is not gated
skipRefused stale_head       `/ai-review-skip` was not accepted: a commit was pushed since you commented. Look at it and comment again
skipRefused missing_reason   `/ai-review-skip` needs a reason on its line, as in `/ai-review-skip urgent fix, checked by hand`
skipRefused no_skip_team     `/ai-review-skip` is not available here: no team is named for it
skipRefused not_team_member  Only a member of the team that may skip can skip the review
skipRefused membership_unverified   Membership of the team that may skip could not be verified just now, so nothing was skipped. Try again in a minute
skipFailed                   `/ai-review-skip` could not be handled
nothingLeft (no code)        @<login> Nothing is left to run on `<head12>`: the required checks and the review's check are green.
```

   `nothingLeft` writes the `@<login> ` only for a login `commandText` would write.

- [ ] **Step 1: Write the failing tests.**

```ts
// commands.test.ts ('anything else is not a command' loses '/done' from its list)
test('/done and /ai-review-skip are commands on the first line that is not empty, in any case', () => {
  /* (carried, old gate map 3.3, in this plan's grammar) '/done', '/DONE', '/Done please', '\n/done', '  /done', '/done\nmore', '/done\r\nmore', '/done\tnow': done.
     '/donezo', 'all good\n/done', '/ done': null. '/ai-review-skip hotfix, checked by hand': skip. '/ai-review-skip': skip. '/ai-review-skipper x': null */
});
test('the reason of a skip is the rest of its line', () => { /* 'hotfix, checked by hand'; '' for the bare command; later lines are not part of it; '' for '/done' and for '/review' */ });
test('the sentence of a command is written with any text', () => { /* commandText('octo-lead', 'X', 'closed') is '@octo-lead X (`closed`).'; refusalText and failureText read as before */ });
// check.test.ts
test('before the threads: bypass, then a skip, then a review under way, then the review of the head, then a failed try, else waiting', () => {
  /* one case for each line of rule 2, and for the order: bypass with a skip is bypassed; a skip with a running job is skipped; a pending job with paused 'spend_limit' is paused, with paused null reviewing;
     a published run at h1/b1 gives null; a published run at h1 against b0 gives waiting; a failed run at h1 with failureCode 'github_502' gives failed github_502, not evaluated;
     a failureCode 'It broke' gives review_failed; an unpublished ok run with no body and nothingToDo gives waiting; with no body gives render_failed; with a body gives not_published;
     a failed dry run and a failed run of h0 give waiting; an older failed run of h1 under a newer published one of h1/b1 gives null */
});
test('after the threads the check is passed or blocked, and counts what the review left out', () => {
  /* coverage.notReviewed of 2; unplaced with a major and a minor, unchanged with one major: withoutThread 2, and the plan is passed;
     refused 1 with no blocking thread: blocked; a result that is not an object: 0 and 0 */
});
test('each state has its status, its conclusion and its words', () => {
  /* the status, the conclusion, the title and the summary of rule 4, each compared whole, for: waiting; reviewing; paused spend_limit with canSkip; paused model_error; paused 'other_thing';
     passed with findings 0, 1 and 3, and with 2 cleared by a review and 1 by a reply; failed not evaluated; failed evaluated, retrying and not, with canSkip; skipped; bypassed */
});
test('a blocked check lists its threads and says how to clear them', () => {
  /* one major at src/a.ts line 12: title '1 blocking finding is open', the summary compared whole with the URL of comment 8001 and the way out of rule 6;
     four threads, one resolved_no_reply at a path with no line, one unread, one unknown: the notes; with clearByReply false: the other way out and the other notes */
});
test('a review GitHub refused inline blocks by itself and beside threads, with its own words', () => {
  /* call 45: refused 2 and no thread: title 'Blocking findings open: 2 (2 listed in the review only)', the summary is the two paragraphs and, with canSkip, the skip line, compared whole;
     refused 1 and two threads: 'Blocking findings open: 3 (1 listed in the review only)', five paragraphs in the order of rule 4; conclusion action_required in both */
});
test('files not reviewed are counted in the title and the summary, and never fail the check', () => { /* passed with notReviewed 1 and 4; blocked with 2: the suffix and the paragraph; conclusion unchanged */ });
test('more than fifty blocking threads are cut to fifty lines and a count', () => { /* 53: 50 lines and '- and 3 more' */ });
test('nothing a person or a file name wrote can leave its place in the summary, and no text names the team', () => {
  /* a path with a backtick, a line feed and a character outside ASCII: '?' for each, one line; a reason '@octo-dev <b>x</b>\n# T' is one line with no live mention and no tag;
     a login 'x y' is written 'a team member'; a code 'It broke: /srv/app' is written internal_error; no summary of this file's tests holds 'release-managers' */
});
test('a check that says the same is not written again', () => { /* sameCheck: equal; another title; another summary; conclusion null against 'success'; current null */ });
test('the counts of a state', () => { /* blocked with two threads and refused 1: blocking 2, refusedInline 1 and the rest from the verdict; waiting: NO_COUNTS */ });
// answers.test.ts
test('each answer is one sentence that opens with the login and ends with its code, and none names the team', () => { /* every line of rule 8 compared whole; a null login */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. `receive.ts` still compares `commandOf` with `'review'`, so nothing else changes yet.
- [ ] **Step 5: Commit** `feat: what the check says in each state, and the words of the gate's commands`.

---

### Task 7: The gate job

**Files:**
- Create: `src/gate/job.ts`, `src/gate/lock.ts`, `src/gate/testing.ts` (the harness of this task's and Task 9's tests)
- Test: `src/gate/job.test.ts`, `src/gate/lock.test.ts` (new)

**Interfaces:**
- Consumes, as they are: `ForgeAccess.readPullRequest(ref: PullRequestRef, installation: string): Promise<LivePullRequest | null>`; `ForgeWriter.listThreads(ref: PullRequestRef, installation: string): Promise<ReviewThread[]>`; `getPullRequest(db: Db, ref: PullRequestRef): Promise<PullRequestFacts | null>`; `listRuns(db: Db, ref: PullRequestRef): Promise<StoredRun[]>`; `listComments(db: Db, ref: PullRequestRef): Promise<Array<StoredComment & { run: number }>>`; `missedComments(args: { runs: StoredRun[]; stored: Stored[]; threads: ReviewThread[] }): Stored[]`, where `Stored` is `StoredComment & { run: number }` (`src/shell/earlier.ts`); `finishJob(db: Db, id: number, status: 'done' | 'dropped', outcome: string, now: string): Promise<boolean>`; `requeueJob` (Task 2 quotes it); `MAX_STARTS = 3` (`src/shell/runner.ts`); `codeOf(error: unknown): string`; `type Alert = (code: string, details?: Record<string, string | number | boolean | null>) => void` (`src/shell/alerts.ts`); and Tasks 1 to 6.
- Produces:

```ts
// src/gate/lock.ts
export interface KeyedLock { run<T>(key: string, work: () => Promise<T>): Promise<T> }
/** Runs the work of one key one at a time, in the order asked. A work that rejects does not hold the next. */
export function createKeyedLock(): KeyedLock;

// src/gate/job.ts
/** The wait before a gate job is tried again: after its first start, then after its second. */
export const GATE_RETRY_WAITS_MS = [10_000, 60_000];
export interface GateJobDeps {
  db: Db; forge: ForgeAccess; checks: ForgeChecks;
  writer: Pick<ForgeWriter, 'listThreads' | 'react' | 'comment'>;
  clock: () => Date; log: (entry: Record<string, unknown>) => void;
  settingsFor: (fullName: string) => RepoSettings;
  dryRun: boolean;
  /** Why reviews do not start now, as a short code; null when they do. */
  paused: () => Promise<string | null>;
  /** Whether a review job of the pull request is running in this process. */
  reviewing: (ref: PullRequestRef) => boolean;
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
  alert: Alert;
  lock: KeyedLock;
  /** Called after a job was stored, so that the runners look at once. */
  onQueued: () => void;
}
/** Whether a review of the pull request is under way, from its unfinished review jobs. `held`: a review job of it is running in this process. */
export function underWay(jobs: Job[], gating: Gating, held: boolean): 'running' | 'pending' | null;
/** What the check of the live head should say now, and the review it was decided on. Rejects only when the database or `paused` does. */
export async function planNow(deps: GateJobDeps, args: {
  ref: PullRequestRef; installation: string; settings: RepoSettings; gating: 'enforce' | 'shadow' | 'bypass'; live: LivePullRequest;
}): Promise<{ plan: CheckPlan; run: StoredRun | null }>;
/** Takes one claimed gate job to its end. Never rejects. */
export async function runGateJob(job: Job, deps: GateJobDeps): Promise<void>;
```

**Rules (9, D13, D14):**

1. **Before anything is asked of GitHub.** In dry run the job is dropped as `dry_run`. A repository whose gate is not enabled: dropped as `gate_off`. The installation is the job's own, else the stored pull request's; with none: dropped as `no_installation`.
2. **The live read of a `sync` job.** `readPullRequest` answers null: dropped as `not_found`. A state that is not open: finished `done` as `closed`. `gatingOf(settings, live.info.baseBranch)` is `off`: finished `done` as `not_gated`. None of these reads or writes a check.
3. **A job of reason `sync`** then does this inside `deps.lock.run('<owner>/<repo>@<head>', ...)`, with the lower-case names of the job's ref and the live head:
   1. `findCheck(ref, installation, head, settings.gate.checkName)`.
   2. `planNow`.
   3. `checkText(plan, { head, canSkip: settings.gate.skipTeam !== null, clearByReply: settings.gate.clearByReply, retrying: job.starts < MAX_STARTS, threadUrl: (id) => deps.commentUrl(ref, id) })`.
   4. Unless `sameCheck(current, text)`: `writeCheck(ref, installation, { id: current?.id ?? null, commit: head, name: settings.gate.checkName, ...text })`.
   5. The evaluation is the head, the clock's time, the gating as `mode`, the plan's state, its code (for `failed` and `paused`, else null), `run` (the id of the run `planNow` answered, else null) and `countsOf(plan)`. It is stored with `recordEvaluation` when the check was written, and also when it was not but `lastEvaluation(db, ref)` is null or has another head, mode, state or code (call 40). A record that cannot be read or stored is logged as `{ event: 'gate_record_failed', job, reason }` and changes nothing.
   Then the job is finished `done` as `synced`.
4. **`underWay`** (calls 25 and 43). A review job counts unless its trigger is `automatic` and `reviewedOnRequest(gating)`: that one is about to be dropped as `gated`. The answer is `running` when a job that counts has the status `running` and `held` is true; else `pending` when a job that counts is pending; else null.
5. **`planNow`.** It reads, in this order, `skipOf(db, ref, head)`, `reviewJobsOf(db, ref)`, `deps.paused()` only when `job` is `pending`, and `listRuns(db, ref)`; `job` is `underWay(<those jobs>, gating, deps.reviewing(ref))`. The jobs are read before the runs, so a review that ends in between is seen with its run, never as ended without it. It answers `planBefore` when that is not null, with `run: null`. Else, with `reviewed` the head's review: `listThreads`, `listComments`, the stored comments completed in memory with `missedComments({ runs, stored, threads })` (a repair that throws leaves them as read), `evaluateGate({ threads, stored, runs, reviewed, clearByReply: settings.gate.clearByReply })`, and `planAfter(verdict, reviewed, refusedInline(runs, head, base))`; `run` is `reviewed`. When any of these rejects or throws, the plan is `{ state: 'failed', code: codeOf(error), evaluated: true }` with `run: reviewed`: a thread list that cannot be read never reads as no thread.
6. **Tried again, then given up.** When `readPullRequest`, `findCheck`, `writeCheck`, the database or anything else in the job rejects or throws (the code is `codeOf(error)`), or when the plan written (or left unwritten because GitHub already says it) is `failed` with `evaluated` true (the code is the plan's): a job on its first or second start is put back with `requeueJob(db, job.id, <now + GATE_RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]>, <now>, false)`; a job on its third start (`job.starts >= MAX_STARTS`) is finished `done` as `failed`, and `deps.alert('gate_check_failed', { reason: <code> })` is raised. When `requeueJob` answers `superseded`, a pending gate job of the pull request takes over, with this job's starts (Task 2, rule 4), and nothing more is done. Nothing else is written when a job gives up: the check keeps what GitHub shows (call 49). A job that cannot be finished or put back because the database rejects is left as it is and runs again after the next start.
7. **A job of another reason** is finished `done` as `unknown_reason`, followed by `askGate(db, job.ref, <now>)` and `deps.onQueued()`. Task 9 takes the reasons `done`, `skip` and `rerun` out of this rule.
8. **The log.** One entry for each job: `{ event: 'gate', job, repo, number, reason, head, mode, state, code, blocking, cleared_by_review, cleared_by_reply, unknown, refused_inline, wrote, outcome, requeued }`, with null for what was not reached. `outcome` is the job's outcome, or `put_back`, or `error` when it was left as it is.
9. **The lock** keeps one chain for each key and forgets the key when nothing waits on it.

- [ ] **Step 1: Write the failing tests.** `harness(options)` in `src/gate/testing.ts` stores the pull request (installation `'99'`, base `main`), stores and claims one gate job, and gives fakes that record every call in `calls`: `forge.readPullRequest`, `checks.findCheck` and `writeCheck` (which keeps the written check, so the next `findCheck` answers it), `writer.listThreads`. Its options: `live`, `settings` (default: the gate enabled on `main`), `check` (the check GitHub holds, or an `Error`), `threads` (a list of answers, each a thread list or an `Error`, the last repeated), `writeFailures`, `paused`, `reviewing` (default: true), `reason`, `dryRun`, `starts`, and `slow` (each fake waits one turn of the event loop before it answers).

```ts
// lock.test.ts
test('the work of one key runs one at a time, in order, and other keys do not wait', async () => { /* works that wait before they end: the second of a key starts only after the first ended; another key's starts at once */ });
test('a work that rejects does not hold the next, and its rejection reaches its caller', async () => { /* */ });
// job.test.ts
test('a gated pull request with no review gets a check that waits for /done', async () => {
  /* one findCheck, one writeCheck { id: null, commit: 'h1', name: 'AI Review', status: 'queued', conclusion: null, title: 'Waiting for /done' };
     one evaluation row: state waiting, mode enforce, code null, run null; the job done as synced; no listThreads */
});
test('a second look that finds nothing changed writes nothing and records nothing', async () => { /* the check GitHub holds is the one wanted and the newest row says the same: no writeCheck, no new row, the job synced, wrote false in the log */ });
test('a look that needs no write is still recorded when the record says something else', async () => {
  /* Review Focus 7, call 40: the check GitHub holds is the one wanted; the newest row was made under shadow and the mode is now enforce: no writeCheck, one new row with mode enforce; with no row at all: one row */
});
test('the head\'s review with an open major gives a blocked check that names the thread', async () => {
  /* a published run at h1/merge000, comment 8001 stored as major, its thread open: the check 71 is rewritten by its id as completed/action_required, '1 blocking finding is open',
     the summary links https://git.example.test/c/8001; the row: state blocked, blocking 1, findings 1, run the run's id */
});
test('a reply by a person and a resolve turn it green with no review', async () => { /* the same, the thread resolved with a reply by octo-dev: completed/success, '1 finding, none blocking'; cleared_by_reply 1 */ });
test('a finding whose row the read-back missed is known from its thread', async () => { /* no stored comment; the thread's first comment belongs to the review and matches its recorded comment: major, blocked, not unknown */ });
test('a review GitHub refused inline blocks the check, and a re-check of the same head does not turn it green', async () => {
  /* Review Focus 6, call 45: the head's review is inlineDropped with a major among its findings and no thread: completed/action_required, 'Blocking findings open: 1 (1 listed in the review only)', refused_inline 1;
     a newer published re-check of h1 with no finding: the same check; the refused review held only a minor: passed; a published review of the new head h2 posted with its comments: h2's check passes */
});
test('a review job that waits or runs shows Reviewing, and one that waits while reviews are paused says why', async () => {
  /* a pending manual review job: in_progress 'Reviewing'; running: the same; pending with paused 'spend_limit': queued 'Review waiting: reviews are paused (spend_limit)'; paused() is not asked when no job is pending */
});
test('a push\'s job that is about to be dropped as gated is no review under way', async () => {
  /* Review Focus 2: a pending automatic review job under enforce: the check is decided on the runs (waiting here); the same job under shadow: Reviewing */
});
test('a review job the database calls running that no runner holds is not under way', async () => {
  /* Review Focus 2: a running review job and reviewing false: the check is decided on the runs (waiting here); with a pending manual job beside it: Reviewing */
});
test('a skip stored for the head outranks a review under way and the threads; one stored for another head does not', async () => { /* Review Focus 2 and call 27 */ });
test('in bypass the check is green whatever the threads say, and no thread is read', async () => { /* Review Focus 7: mode bypass: 'Gate bypassed', mode bypass in the row */ });
test('threads that cannot be read fail the check at once, and the job tries again', async () => {
  /* threads: [Error('github_502'), []]: the check completed/failure 'Could not evaluate (github_502): comment /done to retry', its summary says the service tries again, a row failed with the code,
     the job pending again 10 s later; its second start writes the passed check */
});
test('a job that fails three times ends, stops promising, and the operator is told', async () => {
  /* Review Focus 8: starts 3 and threads always failing: the summary written no longer says the service tries again; the job done as failed; alert('gate_check_failed', { reason: 'github_502' });
     with writeFailures: nothing recorded, no further call, the same end with the write's code (also 'check_not_rewritten'); with a live read that rejects: no check call, put back, then the same end */
});
test('a failed review of this head says so with its code, and a later look does not turn it back to waiting', async () => { /* a failed run at h1 with failureCode 'timeout': 'Review failed (timeout): comment /done to retry'; a second job: unchanged */ });
test('the check is written on the commit that was read', async () => {
  /* Review Focus 1: the runs and threads are of h1 and GitHub says the head is h2: the write is for h2 and says waiting; nothing is written for h1 */
});
test('two pull requests on one commit decide the check one after the other', async () => {
  /* Review Focus 3: two jobs of two pull requests with one head, run together with slow fakes: the calls come as find, write, find, write and the second write names the first one's id.
     The same two jobs given two locks come as find, find, and write two checks: the test fails without the shared lock */
});
test('a pull request that is closed, gone or not gated, a repository with the gate off, no installation and a dry run touch no check', async () => {
  /* Review Focus 5: for each, no findCheck and no writeCheck; outcomes closed, not_found (dropped), not_gated (base 'feature/x'), gate_off (dropped), no_installation (dropped), dry_run (dropped) */
});
test('a record that cannot be stored changes nothing', async () => { /* the insert rejects: the check is written, the job synced, gate_record_failed logged */ });
test('a job of a reason the gate does not know ends and asks for the check', async () => { /* reason 'other': done as unknown_reason, one pending sync */ });
test('the log holds ids, states, codes and counts only', async () => { /* a blocked check, then a skipped one: one gate entry each with the fields of rule 8, and no entry holds 'octo-', a path or the skip's reason */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: a gate job brings a pull request's check up to date`.

---

### Task 8: The second runner in the service

**Files:**
- Modify: `src/service.ts`, `src/main.ts`, `src/shell/dry-writer.ts`
- Test: `src/service.test.ts`, `src/shell/dry-writer.test.ts`

**Interfaces:**
- Consumes: `runGateJob`, `GateJobDeps`, `createKeyedLock` (Task 7); `createRunner` with `kind`, `onLeft` and `holds`, `askGate` (Task 2); `gatingOf` (Task 1); `createGithubChecks` (Task 3); and, as they are, `ModelHealth.paused(now: Date): boolean`, the spend guard's `level(): Promise<SpendLevel>`, `dryWriter(): ForgeWriter`, `getPullRequest`.
- Produces:

```ts
// src/service.ts
export const GATE_CONCURRENCY = 4;
// ServiceDeps gains checks: ForgeChecks
// src/shell/dry-writer.ts
/** Checks for dry run: every method rejects with Error('dry_run'). */
export function dryChecks(): ForgeChecks;
```

**Rules (8.2 as call 11 changes it, 9, D13):**

1. **The second runner:** `createRunner({ kind: 'gate', db, concurrency: GATE_CONCURRENCY, clock, log, mayStart: async () => true, run: (job) => runGateJob(job, gateDeps), onLeft })`. One `KeyedLock` is made for the service.
2. **What the gate job is given.** `paused` answers `'model_error'` when `health.paused(clock())`, else `'spend_limit'` when `(await spend.level()) === 'limit'`, else null. `reviewing` is the review runner's `holds`. `alert` raises `gate_check_failed` once for each `reason` in a run of the service. In dry run the gate is given `dryWriter()` and `dryChecks()`, as the review job is given the dry writer; out of it, the real ones. `onQueued` ticks both runners.
3. **Ticks and the stop.** Every place that ticks the review runner ticks both, `receive`'s `onQueued` included. `stop` drains both within the one `DRAIN_WAIT_MS`, and `drain_timeout` counts the jobs of both.
4. **A review job that has left its runner asks for the check** (call 41). The review runner's `onLeft`, for every `how`: not in dry run, and the repository's `gate.enabled` is true, and the stored pull request is gated or there is none: `askGate(db, job.ref, <now>)`, then the gate runner is ticked. With the gate off it reads nothing and stores nothing.
5. **A gate job the runner gives up is said.** The gate runner's `onLeft`, for `too_old` and `attempts_exhausted`: `alert('gate_check_failed', { reason: <how> })`, through the same once-for-each-reason filter, and nothing is asked again. For `ended` it does nothing.
6. **`src/main.ts`** gives `checks: createGithubChecks({ auth, appId: config.app.id, fetch })`.

- [ ] **Step 1: Write the failing tests.** The harness of `service.test.ts` gains: a config with the gate on for `main` when asked, a recording fake for `checks` that keeps the check it was given, and `dryRun: false` with it.

```ts
// dry-writer.test.ts
test('in dry run every call of the checks is refused', async () => { /* findCheck, writeCheck, greenChecks, isTeamMember: dry_run */ });
// service.test.ts
test('a gate job runs while reviews are paused', async () => { /* Review Focus 8: the daily limit reached, a review job and a sync both due: the review job stays pending, the check is written */ });
test('stop waits for a gate job as it waits for a review', async () => { /* */ });
test('in dry run a stored gate job is dropped, and neither the checks nor the writer it was given can be reached', async () => { /* */ });
test('when a review job has left the runner the check is asked for and decided', async () => {
  /* Review Focus 2: a gated pull request whose /review is published: one gate job ran after it and wrote the check from the review; a review that failed: 'Review failed (...)'.
     With the gate off, and for a pull request against an ungated branch: no gate job, and the log entries of main */
});
test('a review job that is dropped as too old leaves the check to be decided', async () => { /* Review Focus 2: a gated pull request with a day-old review job: after a tick, one gate job ran and the check was written as waiting */ });
test('a review whose record failed leaves no Reviewing behind', async () => {
  /* Review Focus 2: the review's record is refused three times, so its job stays running in the database: the hook still asks, and the check is decided on the runs, not left as Reviewing */
});
test('a gate job the runner gives up raises the alert once and asks for nothing', async () => {
  /* Review Focus 8: a pending sync with three starts: dropped as attempts_exhausted, one alert gate_check_failed with reason attempts_exhausted, no new gate job; a second such job: no second alert */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: the service runs the gate's jobs beside the reviews`.

---

### Task 9: `/done`, `/ai-review-skip` and a re-run of the check

**Files:**
- Create: `src/gate/commands.ts`
- Modify: `src/gate/job.ts` (rule 7 of Task 7 keeps only the reasons this task does not name), `src/gate/testing.ts` (the harness gains what the commands need)
- Test: `src/gate/commands.test.ts` (new), `src/gate/job.test.ts` (its test of an unknown reason stays; nothing else changes)

**Interfaces:**
- Consumes, as they are: `mayCommand(association: string | null): boolean` (`src/shell/commands.ts`); `ForgeWriter.react(ref: PullRequestRef, installation: string, commentId: string, reaction: 'eyes' | 'confused'): Promise<void>` and `ForgeWriter.comment(ref: PullRequestRef, installation: string, body: string): Promise<void>`; and `commentBody`, `recordSkip`, `reviewJobsOf`, `askGate`, `enqueueJob`, `requeueJob` (Task 2); `skipReasonOf` and the answers (Task 6); `planNow`, `underWay`, `GateJobDeps` (Task 7); `ForgeChecks.greenChecks`, `isTeamMember` (Task 3).
- Produces:

```ts
// src/gate/commands.ts
/** A gate job of reason done, skip or rerun, once rule 1 of Task 7 has let it through. Never rejects. */
export async function runGateCommand(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings; now: Date }): Promise<void>;
```

**Rules (8.1, 9, D14, D15).** Rule 1 of Task 7 comes first for every gate job (dry run, the gate off, no installation). Then `runGateJob` hands a job of reason `done`, `skip` or `rerun` to `runGateCommand`.

1. **The end of a command** is one transaction: the job is finished with its outcome, the command's effect is stored (a skip row, or a review job), and `askGate(tx, job.ref, <now>)` is stored, unless the live read showed the pull request not open or not gated: there is then no check to bring up to date. Then `deps.onQueued()`, then the answer. A command never writes the check. A job that is run again after a stop finds the effect stored or not at all.
2. **The answer** is written only when the job has a comment (`job.commentId` is not null), each write once: **accepted** is an eyes reaction on the comment; **refused** is a confused reaction, then one general comment with the refusal's sentence. A write that fails is logged as `{ event: 'answer_failed', job, reason }` and changes nothing.
3. **Tried again.** When `readPullRequest` or the database rejects, the end's transaction included, or anything else throws that no rule names: a job on its first or second start is put back as in Task 7, rule 6, with nothing answered; put back, it takes the slot of a `sync` stored meanwhile (Task 2, rule 4). A job on its third start is finished `done` as `failed` (with `askGate`), and a `/done` or a skip is answered with a confused reaction and `doneFailed` or `skipFailed` with the code.
4. **`/done`** (reason `done`), the first that applies:
   1. `mayCommand(job.association)` is false: refused, `not_allowed`.
   2. The live read is null: dropped as `not_found`, no answer. The pull request is not open: refused, `closed`.
   3. The pull request is not gated: a review is wanted (rule 7); here `/done` is a `/review`.
   4. `planNow` answers `passed`, `skipped` or `bypassed`: accepted as `already_green`. When `settings.gate.requiredChecks` is not empty and `greenChecks` answers every one of them, `nothingLeft(job.requestedBy, head)` is written as a general comment after the eyes. A `greenChecks` that rejects is logged as `{ event: 'gate_checks_unread', job, reason }` and nothing is said.
   5. Otherwise a review is wanted (rule 7).
5. **`/ai-review-skip`** (reason `skip`), the first that applies. Each refusal answers `skipRefused(job.requestedBy, <code>)`:
   1. `mayCommand(job.association)` is false: `not_allowed`.
   2. `skipReasonOf(<the stored comment's text, or ''>)` is empty: `missing_reason`.
   3. No skip team is named, or its organisation is not the repository's owner (compared in lower case): `no_skip_team`.
   4. `isTeamMember(installation, team, job.requestedBy)` rejects: `membership_unverified`. It answers false, or the job names no requester: `not_team_member`.
   5. The live read is null: dropped as `not_found`. Not open: `closed`. Not gated: `not_gated`.
   6. `job.headSha` is not `''` and is not the live head: `stale_head` (call 46). A job with no head stored skips the live head.
   7. Accepted as `skipped`: `recordSkip` with the live head, the requester, the reason, the comment's id and the time, in the end's transaction.
6. **A re-run** (reason `rerun`), with no answer at any end: the live read is null: dropped as `not_found`; not open: finished as `closed`; not gated: `not_gated`, and nothing more happens; the live head is not `job.headSha`: `stale_head`; in bypass: `bypassed`; otherwise a review is wanted (rule 7).
7. **A review is wanted.** With `jobs = await reviewJobsOf(db, job.ref)` and the pull request's gating: when a review job of the pull request that will run is running or waits, the command joins that review (`coalesced`) and stores no job. A job will run when it is manual and either its reason is `rerun` or `rerun_retry` or `mayCommand(job.association)` is true, or when it is automatic and the pull request is not reviewed only when asked; the running one is the job `deps.reviewing(job.ref)` holds, read from `jobs`, and a running job that does not pass this test is not joined. Else the end's transaction stores a review job, which takes the place of a pending automatic one: `enqueueJob(tx, { ref: job.ref, kind: 'review', reason: job.reason, headSha: '', runAt: <now>, now: <now>, delivery: null, replace: true, trigger: 'manual', requestedBy: job.requestedBy, commentId: job.commentId, association: job.association, installation: job.installation })` (`review_queued`).
8. **The log:** `{ event: 'gate', job, repo, number, reason, outcome, code }`, `code` being the refusal's code or null, and `outcome` one of `refused`, `already_green`, `coalesced`, `review_queued`, `skipped`, `stale_head`, `not_gated`, `bypassed`, `closed`, `failed`, `put_back`, `gone` (the job was already finished when its end was stored: nothing is stored and nothing is answered), or a drop's reason. A put-back's entry carries `requeued` as the entry of a `sync` does.

- [ ] **Step 1: Write the failing tests.** The cases carried from the old gate map, section 3.3, are marked (c). The harness gains fakes for `checks.greenChecks`, `checks.isTeamMember`, `writer.react` and `writer.comment`, and the options `association` (default `member`), `comment` (the text stored as the commenter's general comment `31`), `head` (the head stored with the job), `member` (true, false or an `Error`), `green` (the names `greenChecks` answers, or an `Error`) and `answerFails`; its default settings name the team `acme/release-managers`.

```ts
test('/done on a head that is not green stores a review job for the commenter, asks for the check, and gets its eyes', async () => {
  /* (c) a manual review job of reason 'done' with requestedBy octo-lead, comment 31, association member, installation 99; one pending sync; the gate job done as review_queued;
     react eyes after the transaction; no writeCheck by this job */
});
test('/done on a green head starts nothing', async () => { /* (c) the head's review with nothing blocking: already_green, eyes, no review job, no comment; the same on a skipped head and in bypass */ });
test('/done with everything green says so once', async () => {
  /* (c) requiredChecks [build, test] and greenChecks answers both: the sentence 'Nothing is left to run on `h1`: ...' after the eyes; one of them missing: no sentence;
     no required check named: greenChecks is not asked; greenChecks rejects: no sentence, gate_checks_unread logged */
});
test('/done joins a review that is running or was asked for, and takes the place of a push\'s waiting job', async () => {
  /* (c) a manual review the runner holds: coalesced, no new job; a pending manual one: coalesced; a pending automatic one: replaced by the manual job;
     a running automatic job under enforce (about to be dropped as gated): a review job is stored; a job the database calls running that no runner holds: a review job is stored (call 43) */
});
test('/done by someone who may not command, and on a closed pull request, is refused with its code', async () => {
  /* (c) association none: confused, '@octo-lead `/done` was not accepted (`not_allowed`).', no review job, a sync asked; closed: `closed`, and no sync asked */
});
test('/done on a pull request that is not gated is a /review', async () => { /* base 'feature/x' in a repository with the gate on: a review job of reason done; planNow is not asked; no sync asked */ });
test('/done on a head whose review GitHub refused inline is not green', async () => { /* call 45: the plan is blocked: review_queued */ });
test('/done whose threads cannot be read asks for a review', async () => { /* (c) the plan is failed: review_queued */ });
test('/done put back after a failed read keeps its place against a sync stored meanwhile', async () => {
  /* Review Focus 4: while the /done job runs, a reply stores a sync (askGate answers an id); readPullRequest then rejects: the /done job is pending again and that sync is dropped as superseded;
     while it waits, askGate answers null. Run again, the command stores its review job and asks for the check */
});
test('a skip by a member of the team is stored for the head with its reason, and gets its eyes', async () => {
  /* (c) the comment '/ai-review-skip hotfix, checked by hand' stored as activity, the job's head h1: one gate_overrides row (h1, octo-lead, the reason, comment 31); a pending sync; eyes; the next sync writes 'Skipped by @octo-lead' */
});
test('a skip lands only on the commit the service knew when the comment came', async () => {
  /* call 46: the job's head is h1 and GitHub says h2: refused, '... a commit was pushed since you commented. Look at it and comment again (`stale_head`).', no row; a job with no head stored: h2 is skipped */
});
test('a skip with no reason is refused before anyone is looked up', async () => { /* (c) missing_reason; isTeamMember not called; the same when no comment text is stored */ });
test('a skip by someone outside the team is refused, and the answer does not name the team', async () => { /* (c) not_team_member; no row; a job with no requester: the same; the comment holds 'the team that may skip' and not 'release-managers' */ });
test('a membership that cannot be read is "could not verify", never "not a member"', async () => { /* (c) isTeamMember rejects github_403: membership_unverified, its sentence, no row, the job done as refused */ });
test('a skip is refused without a team, for a team of another organisation, by someone who may not command, on a closed and on an ungated pull request', async () => {
  /* no_skip_team twice; not_allowed (isTeamMember not called); closed; not_gated: each sentence compared whole */
});
test('a skip works while reviews are paused', async () => { /* Review Focus 8: paused 'spend_limit': skipped */ });
test('a re-run of the head\'s check stores a review job and says nothing', async () => {
  /* a job of reason rerun, headSha h1, requestedBy octo-dev, no comment, no association: a manual review job of reason 'rerun' with commentId null; no react, no comment, no answer_failed */
});
test('a re-run of an old commit, of a closed pull request and in bypass starts no review, and one on a pull request that is no longer gated does nothing at all', async () => {
  /* stale_head, closed, bypassed: no review job; not_gated: no review job, no sync asked, no write on the pull request */
});
test('a command run again after a stop does nothing twice', async () => {
  /* Review Focus 4: the end's transaction rejects once: no skip row, no review job, the job put back; run again: one row. A job run twice to its end: one row (same comment id) */
});
test('a command GitHub fails three times is answered as failed', async () => { /* readPullRequest rejects github_502 at starts 3: done as failed, confused, '`/done` could not be handled (`github_502`).', a sync asked */ });
test('an answer that cannot be written is logged and changes nothing', async () => { /* react rejects: answer_failed; the review job is stored all the same */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: /done, /ai-review-skip and a re-run of the check`.

---

### Task 10: Receiving

**Files:**
- Modify: `src/shell/receive.ts`, `src/shell/triggers.ts`, `src/service.ts` (two arguments)
- Test: `src/shell/receive-jobs.test.ts`, `src/shell/receive.test.ts`, `src/shell/triggers.test.ts`

**Interfaces:**
- Consumes: `commandOf` (Task 6), `gatingOf`, `reviewedOnRequest` (Task 1), `askGate`, `enqueueJob` with a kind (Task 2), the `check_rerun` event (Task 4); and, as they are in `src/shell/triggers.ts`, `skipReason(pr: { state: 'open' | 'closed' | 'merged'; draft: boolean; author: string; baseBranch: string }, settings: RepoSettings): SkipReason | null` and `triggerOf(action: PullRequestAction, facts: PullRequestFacts, settings: RepoSettings): Trigger`.
- Produces:

```ts
// src/shell/receive.ts
/** How long a thread event or a reply waits for the next one before the check is looked at. */
export const GATE_SETTLE_MS = 3_000;
// ReceiveDeps gains dryRun: boolean and appId: string
// src/shell/triggers.ts
// SkipReason gains 'gated'
```

**Rules (8.1, D14).** Everything below is stored in the delivery's own transaction, before the answer; nothing is asked of GitHub. "The gate is live for a repository" means: not in dry run, and its `gate.enabled` is true. "For a pull request" adds: the base branch is gated, where the base is the event's own for a pull request event and the stored pull request's for any other; a pull request that is not stored counts as gated.

1. **No automatic review of a gated pull request.** `skipReason` answers `gated`, after its other reasons, when `reviewedOnRequest(gatingOf(settings, pr.baseBranch))`. This holds in dry run too. A shadow pull request is reviewed as before.
2. **A pull request event** whose action is `opened`, `reopened`, `ready_for_review`, `synchronize` or `retargeted`, with the gate live for the pull request: `askGate(tx, ref, <now>)`, whatever the trigger decided.
3. **A thread event, and an inline comment that is a reply** (`replyTo` is not null), by anyone, also when capture ignores it as written by a bot, with the gate live for the pull request: `askGate(tx, ref, <now>, <now + GATE_SETTLE_MS>)`.
4. **`/review`** stores its review job as today. With the gate live for the pull request and `mayCommand(comment.association)`: also `askGate(tx, ref, <now>)`.
5. **`/done`.** In a repository whose `gate.enabled` is false it is no command: nothing but the activity is stored. In dry run it stores the review job `/review` would store, with the reason `done`. Otherwise it stores a gate job: `enqueueJob(tx, { ref, kind: 'gate', reason: 'done', headSha: '', runAt: <now>, now: <now>, delivery, replace: mayCommand(comment.association), trigger: 'manual', requestedBy: comment.author, commentId: comment.id, association: comment.association, installation })`.
6. **`/ai-review-skip`,** with the gate live for the repository: the same gate job with the reason `skip`, and with `headSha` the head stored for the pull request, `''` when it is not stored (call 46). Otherwise it is no command.
7. **A re-run** (`check_rerun`), with the gate live for the repository, `event.app === deps.appId` and `event.check === settings.gate.checkName`: a gate job with the reason `rerun`, `headSha: event.headSha`, `replace: true`, `trigger: 'manual'`, `requestedBy: event.actor`, no comment, no association, and the event's installation. Any other re-run stores nothing.
8. **The log and the wake-up.** The entry of a delivery that stored a gate job gains `gate: true`; no other entry changes. A command that was taken is named in `command` (`review`, `done`, `skip` or `rerun`). `onQueued` is called when a review job or a gate job was stored. A bot's thread event is still answered `202 ignored`.
9. **The service** gives `receive` `dryRun: config.dryRun` and `appId: config.app.id`.

- [ ] **Step 1: Write the failing tests.** `deliver` gains the settings, `dryRun` and the event's name; `GATED` is the settings with the gate enabled on `main`.

```ts
// triggers.test.ts
test('a gated pull request is not reviewed on a push, an opening or a retarget; in shadow and against another branch it is', () => {
  /* each of the five actions: { kind: 'skip', reason: 'gated' }; mode shadow: queue; base 'feature/x': queue; mode bypass: skip gated; a draft that is gated: skip draft */
});
// receive-jobs.test.ts
test('a push to a gated pull request stores no review job and asks for its check', async () => { /* no review job; one pending gate job of reason sync due now; the log: skip 'gated', gate true; onQueued called */ });
test('with the gate off, and in dry run, a pull request event stores what it stored before', async () => {
  /* GATE_OFF: one review job, no gate job, and the log entry deep-equals the one of main; dry run with the gate on: no gate job, and no review job either (gated) */
});
test('a push to a pull request of a gated repository against another branch is reviewed and asks for nothing', async () => { /* */ });
test('a resolve, an unresolve and a reply ask for the check three seconds later, whoever made them', async () => {
  /* Review Focus 1: a thread event by octo-dev: a sync due at at(3); a second event at at(2): the same job, due at at(5); a reply by a bot (capture ignores it): answered 202 ignored, the sync stored, gate true;
     a first comment of a new thread (replyTo null): nothing */
});
test('a thread event for a pull request the service does not know asks for the check, and one for an ungated pull request does not', async () => { /* Review Focus 5: the stored base is 'feature/x': nothing; no stored pull request: a sync */ });
test('/review by a member on a gated pull request also asks for the check; by anyone else it does not', async () => { /* the review job as today in both; the sync only for the member */ });
test('/done in a gated repository stores a gate job with the commenter, and with the gate off it is an ordinary comment', async () => {
  /* a gate job: reason done, manual, octo-lead, comment 31, member, installation 99; the log: command 'done', gate true. GATE_OFF: no job, the activity stored, the entry of main */
});
test('/done by someone who may not command does not take a waiting job\'s place', async () => { /* a pending sync and association none: the sync stays, nothing else stored */ });
test('in dry run /done is a /review and the skip is nothing', async () => { /* a review job of reason done; no gate job for either */ });
test('/ai-review-skip stores a gate job with the head the service has stored, and its reason stays in the stored comment', async () => {
  /* call 46: the stored head is h1: reason skip, headSha 'h1'; commentBody(db, REF, '31') is the whole text; no stored pull request: headSha '' */
});
test('a re-run of the app\'s own check stores a gate job for the commit, and another app\'s or another name\'s check stores nothing', async () => {
  /* app '12345' and check 'AI Review': reason rerun, headSha, requestedBy, commentId null; app '777': nothing, answered 202 accepted; check 'CI': nothing; gate off: nothing */
});
test('a delivery seen twice asks once', async () => { /* the second answer is duplicate; one gate job */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every test of `receive` that existed passes with `dryRun` and `appId` added to its dependencies and nothing else changed.
- [ ] **Step 5: Commit** `feat: events ask for the check, and a gated pull request is reviewed only when asked`.

---

### Task 11: The review job on a gated pull request

**Files:**
- Modify: `src/shell/review-job.ts`, `src/shell/earlier.ts`
- Test: `src/shell/review-job.test.ts`, `src/shell/earlier.test.ts`, `src/shell/later-review.test.ts`

**Interfaces:**
- Consumes: `gatingOf`, `reviewedOnRequest` (Task 1), `skipReason` with `gated` (Task 10); and, as it is in `src/shell/earlier.ts`, `earlierOf(args: { last: StoredRun; runs: StoredRun[]; stored: Stored[]; threads: ReviewThread[] }): EarlierState`.
- Produces:

```ts
// src/shell/earlier.ts
// earlierOf's argument gains replySettles?: boolean (absent reads as true): whether a person's reply settles a resolved thread
```

  `ReviewJobDeps` does not change: the review job asks nothing of the gate (call 41).

**Rules (5.2, D4, 8.1, 8.3, 9):**

1. **Dropped as `gated`.** An automatic job for a pull request that is reviewed only when asked is dropped by the check that drops a draft, with the reason `gated` (Task 10's `skipReason` does it). A manual job is not.
2. **D4.** In `modeOf`, where today's last line answers `settings.newHead ?? 'incremental'`: when `newHead` is not written, `full` for a pull request that is reviewed only when asked (`reviewedOnRequest(gatingOf(settings, pr.info.baseBranch))`), else `incremental`. The three rules before it are unchanged. In shadow the answer is today's.
3. **Settled, under the rule in force.** `earlierOf` is given `replySettles: false` when the pull request is reviewed only when asked and `settings.gate.clearByReply` is false; then a thread is settled only when it is resolved, the app resolved it and the app's own reply with its hidden line stands. In every other case `settled` is computed as today.
4. **The reasons of a manual job** are `command`, `done` and `rerun`, and, for a job that started over, `command_retry`, `done_retry` and `rerun_retry`:
   - **Starting over (8.3).** A job of reason `command`, `done` or `rerun` whose publication found the head moved starts over once, as a `command` job does today: a manual job of reason `<reason>_retry` with the same requester, comment, association and installation takes its place. A `_retry` job does not start over again and ends as a `command_retry` does today.
   - A job of reason `rerun` or `rerun_retry` is not checked against D15 (step 1b): GitHub decided who may ask. Every other manual job is, as today.
   - A job of reason `done` or `done_retry` gets no eyes from the review job: the gate job gave them. Its refusals and failures are answered as a `/review`'s are.
   - A job with no comment (a re-run) is given no reaction and no sentence, and nothing is logged for the missing comment.

- [ ] **Step 1: Write the failing tests.** `GATED` is `{ ...SETTINGS, gate: { ...GATE_OFF, enabled: true, branches: ['main'] } }`.

```ts
// review-job.test.ts
test('a push\'s job for a pull request that became gated is dropped', async () => { /* Review Focus 5: outcome dropped 'gated'; no review; no gate job stored by the review job */ });
test('in shadow a push\'s job reviews and publishes as before', async () => { /* published, incremental after a first review; the log entries of main */ });
test('a gated pull request gets a full review at a new head unless the repository says otherwise', async () => {
  /* a last review at h0, a /done job at h1: mode full; with newHead incremental: incremental; in shadow: incremental; with the gate off: incremental (a pin) */
});
test('a /done on the head and base of the last review is a re-check', async () => { /* reason done: mode recheck */ });
test('with clearing by reply off a resolved thread with a person\'s reply is judged again', async () => {
  /* clearByReply false, gated: the earlier state the engine is given has that thread with settled false; with clearByReply true, in shadow, and with the gate off: settled true */
});
test('a /done review and a re-run start over once when the head moved, with the fields of who asked', async () => {
  /* Review Focus 1: a job of reason done whose publication finds the head moved: finished as head_moved, and a pending manual job of reason 'done_retry' with requestedBy octo-lead, comment 31, association member, installation 99;
     reason rerun: 'rerun_retry' with requestedBy and no comment; a 'done_retry' whose head moved again does not start over and ends as a command_retry does today */
});
test('a re-run and its retry are not asked who commented, get no reaction and no sentence, and the review names who asked', async () => {
  /* a manual job of reason rerun, association null, commentId null, requestedBy octo-dev: reviewed and published; no react, no comment; no answer_failed in the log; the body opens with the line of a requested review;
     the same for rerun_retry */
});
test('a /done job and its retry get no second eyes, and a failure is answered', async () => { /* no react eyes for done and done_retry; a failed review: confused and 'The review did not finish (`review_failed`).' */ });
// earlier.test.ts
test('with replies not settling, only a thread the app resolved with its hidden line is settled', () => { /* resolved with a person's reply: false; resolved by the app with its marker reply: true; replySettles absent: today's answer (a pin) */ });
// later-review.test.ts (the real engine under the real job)
test('on a gated pull request a silently resolved major is judged again and its verdict is stored for the gate', async () => {
  /* a first review with a major; the thread resolved with no reply; a /done job at a new head: the request shows the thread as due, the stored result holds the verdict by thread id,
     and evaluateGate over that run and the thread clears it when the verdict is fixed and blocks when it is open */
});
```

- [ ] **Step 2: Run them and see them fail.** The pins hold before and after.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every existing test of the review job passes unchanged.
- [ ] **Step 5: Commit** `feat: the review job on a gated pull request`.

---

### Task 12: The service keeps the checks true

**Files:**
- Create: `src/gate/sweep.ts`
- Modify: `src/service.ts`
- Test: `src/gate/sweep.test.ts` (new), `src/service.test.ts`

**Interfaces:**
- Consumes: `openPullRequests`, `lastEvaluations`, `askGate` (Task 2); `gatingOf`, `gateUseOf` (Task 1); the two runners (Task 8); and, as it is, `unfinishedJobs(db: Db): Promise<Job[]>`.
- Produces:

```ts
// src/gate/sweep.ts
/** Asks for the check of each stored open pull request that is gated and whose newest recorded evaluation is absent, was made under another mode, or says reviewing or paused. Returns how many. */
export async function sweepGate(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number>;
/** Asks for the check of each pull request with a review job waiting, in a repository whose gate is enabled. Returns how many. */
export async function askWaiting(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number>;
```

**Rules (9, 12, 14, D13).** None of these runs in dry run, and none does anything when `gateUseOf(config).check` is false.

1. **At start,** after the recovery of jobs and before listening: `sweepGate`, logged as `{ event: 'gate_sweep', asked }`. It reads the database only; a rejection fails the start as a failed recovery does. A pull request is asked for when `gatingOf(settingsFor(<owner>/<repo>), baseBranch)` is not `off` and its newest evaluation is absent, or has another `mode` than that gating, or has the state `reviewing` or `paused`. Because a `sync` records an evaluation that needed no write when the record says something else (Task 7, rule 3), a pull request is not asked for again at the start after.
2. **Bypass is said.** After listening, with `gateUseOf(config).bypass`: `{ event: 'gate_bypass' }` is logged and `alert('gate_bypass')` raised, once for each start.
3. **A pause that begins, ends or changes.** The review runner's `mayStart` computes the code the gate jobs are given (`model_error`, `spend_limit` or null) and answers whether it is null, as today. When the code differs from the one the pass before saw (null at start), `askWaiting` runs and the gate runner is ticked. A failure of `askWaiting` is logged as `{ event: 'gate_ask_failed', reason }` and `mayStart` answers as if it had worked.

- [ ] **Step 1: Write the failing tests.** The harness of `service.test.ts` gains fakes for GitHub that keep the check and the threads, and lets a test change the head GitHub reports.

```ts
// sweep.test.ts
test('at start the check is asked for where the record and the config disagree, or a review was under way', async () => {
  /* Review Focus 7: five open gated pull requests whose newest rows say: none; passed under enforce; bypassed under bypass; reviewing; paused. With the mode enforce: asked for the first, the third, the fourth and the fifth.
     With the mode bypass: the second too, and not the third. A closed pull request, one against 'feature/x' and one of a repository with the gate off: never */
});
test('the pull requests with a review waiting are asked for, and a running review, a gate job and an ungated repository are not', async () => { /* askWaiting */ });
// service.test.ts
test('the sweep comes after the recovery and before the listener, and not in dry run or with no gate', async () => { /* the order of the log; gate_sweep absent in the two other cases */ });
test('a pull request whose check needed no write after a change of mode is not asked for at every start', async () => {
  /* Review Focus 7, call 38: rows made under shadow, the mode now enforce, the check GitHub holds already the one wanted: the first start asks once and records a row under enforce without a write; a second start asks for nothing */
});
test('a start in bypass says so and raises its alert once', async () => { /* */ });
test('when reviews are paused a waiting review\'s check says why, and says Reviewing again when they resume', async () => {
  /* Review Focus 8: a /done whose review waits; the daily limit is reached: the check 'Review waiting: reviews are paused (spend_limit)'; the next UTC day: 'Reviewing' and then the review runs */
});
test('a /done that joined the review of an older head is answered by a review of the new one', async () => {
  /* Review Focus 1: /done at h1 starts a review that is held; a push makes the head h2 and its check waits for /done; a second /done joins the running review (eyes, no new job);
     the review ends as head_moved and starts over as done_retry: h2 is reviewed and its check decided, with no third /done; nothing was written on h1 after the push */
});
test('a whole round on a gated pull request', async () => {
  /* through the listener, out of dry run, with the gate on for main:
     opened -> no review, the check waits for /done; /done by octo-lead -> eyes, 'Reviewing', one review posted with a major, then '1 blocking finding is open';
     a reply by octo-dev and a resolve -> '1 finding, none blocking' three seconds later with no review call; a push -> the new commit's check waits for /done and the old commit's is not rewritten (Review Focus 1);
     /ai-review-skip by a member of the team -> 'Skipped by @octo-lead'; a re-run of that check -> one more review, and the check still says skipped */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: the service keeps the checks true across pauses, restarts and changes of mode`.

---

### Task 13: The README, the example config, and a real run

**Files:**
- Modify: `README.md`, `config.example.yml` (its comments, if Task 1 left them short; the list of alerts at `alerts.webhook` gains `gate_check_failed` and `gate_bypass`), `env.example` (the same list)

**Rules:**

1. **README.** Each sentence states only what the code does, and names its cost where it has one. A new section `### The merge gate (optional)` under "Run the service", after "Leaving dry run", says:
   - **Setting it up.** The gate block, key by key, with the defaults; that the block lives only in the deployment config (D10); that the adopter also makes the check required in GitHub, by a ruleset or a branch protection that names the check and this app, and that nothing in the service does it; that an **existing app** is given `Checks` read and write, `Commit statuses` read (only when `requiredChecks` are named), the organisation permission `Members` read (only when a skip team is named) and the event `Check run` by hand in its settings, that each installation must accept them, and that the service is restarted afterwards and says `feature_off` with `gate` for what is still missing; a rollout in `shadow` first.
   - **What the `check_run` subscription costs** (call 9): the app may be sent the `created` and `completed` events of every check run of a repository; each is stored as an ignored delivery, in a table that is not pruned; and after a downtime the service reads at most 10 pages of GitHub's delivery log, so that traffic can push missed events out of its reach. This was not measured: do not switch a gate on in a busy repository before the number of these deliveries has been seen on a quiet one.
   - **Which pull requests are gated,** and what changes for one: no review on a push, an opening, a reopening or a retarget; a `full` review at a new head unless `newHead` is written; a draft, an ignored author and a branch outside the review filter get the check too and need `/done` like any other.
   - **The check:** its name; each state with its title; that a new commit gets a new check; that a completed check is rewritten in place when a review is asked for again (not tried against GitHub).
   - **The rule,** as Task 5 states it: which threads block; the three ways one clears; that **a thread resolved with a click and no reply does not clear** (the owner left that case to this stage) and is judged again at the next review; that a reply's words are not read and its author's access is not checked, so on a public repository the author of a fork's pull request can turn the check green alone, while the merge still takes write access (9); that a comment after the review's verdict ends the verification; that the app's own thread with no stored finding blocks; that a finding not placed on the diff, and a major on unchanged code in an incremental review, do not block and are counted in the summary; that **a review whose inline comments GitHub refused blocks** while it holds a major or blocker, with no thread to answer in, until a new commit is reviewed or the team skips (call 45), and that with `newHead: incremental` the next review may not raise those findings again; that files not reviewed are counted in the title and do not fail the check, so a team that wants a person to look requires an approving review in GitHub (21).
   - **With `clearByReply: false`:** only a review clears a thread, and three kinds of thread no review can judge then clear only by a skip: one whose file left the pull request's diff, one whose file was not sent to the model, and the app's own thread with no stored finding (call 47). The check's summary says which.
   - **Evaluated again without a review:** on a resolve, an unresolve and a reply, about three seconds later; not on an edit or a deletion.
   - **`/done`, `/ai-review-skip <reason>` and a re-run:** the grammar; who may; every answer with its code; that `/done` and the skip are commands only where the gate is enabled; that `/done` on a green head starts nothing and that files not yet reviewed are then not read either; that a review asked for by `/done` or a re-run starts over once when the head moved; that a skip holds for one commit, is refused as `stale_head` when a commit was pushed since the comment, and is not undone by a later review; that the skip team is named in the config and in no text on GitHub; that a re-run is honoured from whoever GitHub lets ask, that one on a pull request that is no longer gated does nothing, and that a re-run of a whole check suite is not taken in.
   - **Modes:** `shadow` (reviews as before, the check written, "Waiting for /done" left after a push that told nothing new); `bypass` (every check green at its next evaluation; the alert at each start; leaving it takes effect at the next start, for the pull requests the service has stored).
   - **When it fails:** the two failure titles and the codes; the two retries; the alerts `gate_check_failed` and `gate_bypass`; what the check says while reviews are paused; and that **a failed read or write leaves the check GitHub already shows, which can be a green one that no longer holds** (call 49): the alert is the sign, and the next event or start tries again.
   - **Dry run:** no check; `/done` is a `/review`.
   - **What else it costs and where it ends:** a check follows an event by a job's start; two pull requests on one commit share a check; a pull request that left the gate keeps its last check; a pull request the service never had an event of gets its check at its next event; a command replaced by a later one while it waits is not answered; a previous release cannot run on the migrated database.
   - The `## Status` row for the merge gate: built, not tried against a real GitHub App. Every sentence that says the gate is not built, or that the service does not decide whether a pull request may merge, is corrected wherever it stands; "Creating the app", the by-hand list and "What the app needs" name the new permissions and the event and why each is asked.
2. **The design file is not edited by this task.** The session lead amends section 8.2 (call 11). Its bullet `Fixed concurrency, and never two jobs for the same pull request at once.` becomes: `Fixed concurrency for review jobs, and never two review jobs for the same pull request at once. Gate jobs (section 9) have places of their own: one may run beside a review job of the same pull request, and never two gate jobs for one pull request at once.` The README's "Running it" says the same of the two kinds of job.
3. **A real run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, as in plans 7 and 8: the previous release on a fresh database, with one job left pending; this branch on that database: the ledger gains `0008_gate` and nothing else, the pending job is run as a review job, the index holds five columns; on that Postgres, a review job and a gate job pending for one pull request, a command put back beside a waiting `sync` (the `sync` dropped), a `sync` put back beside a waiting `sync` (its starts handed on), an evaluation and a skip written and read, and the newest evaluation of one pull request and of each; a start out of dry run with the gate on for one repository: the sweep's line, a `/done` sample accepted, its gate job put back with `github_network` and given up after its third start with one alert; a log of ids, states, codes and counts only.
4. **The notes file.**

- [ ] **Step 1: Write the README.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 3: Commit** `docs: the README says what the merge gate does and what it costs`.

---

## To verify with a real app

Nothing in this plan has met GitHub. Each of these needs the owner's go-ahead, and the first thing they need is his: **the trial app has no `Checks` permission**, no `Commit statuses`, no organisation `Members` and no `check_run` subscription. He grants them in the app's settings and accepts them on the installation before any of this can be tried.

1. **A completed check can be rewritten to `queued` and to `in_progress`,** comes back with no conclusion, and the answer names the new status (call 48). Tried first: every later evaluation of a commit depends on it. If GitHub refuses or ignores it, the log shows `gate` entries ending `failed` with `github_<status>` or `check_not_rewritten` and one `gate_check_failed` alert, and the check keeps its first conclusion.
2. **Which `check_run` deliveries the app is sent, and how many,** once it holds `checks` write and the subscription: its own only, or the `created` and `completed` of every check run of the repository (call 9). Until this is seen, no gate is switched on in a busy repository.
3. The app can create a check run on a pull request's head commit, and GitHub lists it by `check_name` and `app_id`.
4. With the check required: `queued`, `in_progress`, `action_required` and `failure` hold the merge; `success` lets it through.
5. How `action_required` reads on the pull request, where its link leads (`details_url`), and whether a re-run is offered on it.
6. A re-run arrives as `check_run` with the action `rerequested`, with the `external_id` and the app's id; what it carries for a pull request from a fork; and who is offered the button.
7. The names `checks`, `statuses` and `members` as `GET /app` gives them, whether `check_run` shows among the events, and that the manifest flow accepts the set (design 20, item 3), also for an app on a personal account.
8. Team membership: the answer for an active member, a pending one, a stranger, a team that does not exist, a secret team, and an app without the permission; and the association GitHub reports for a member whose membership is private (design 20, item 7).
9. The combined status and the check runs of a commit, for a required check that is a status and for one that is a check run.
10. That GitHub sends a thread event for a resolve made in the page and for one made through the API, and a review-comment event for a reply made by the app's own mutation.
11. One whole round on a gated pull request: a push, `/done`, a blocked check, a reply and a resolve, the green check within seconds, a skip, a skip typed after a push (refused), a re-run; then the same in `shadow`, and `bypass` on and off across two starts.
12. How a path with odd characters and a skip's reason read in the check's summary.
