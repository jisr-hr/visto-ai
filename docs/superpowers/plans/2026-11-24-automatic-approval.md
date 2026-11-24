# Automatic Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository whose deployment config switches automatic approval on gets its review posted as an approval when, at the moment of posting, every file is covered at the head, nothing is at or above the threshold, no major or blocker finding is open under the thread rule in force (strict by default), no run of the pull request left one without a thread, the pull request is open, no draft, not from a fork and still at the reviewed head, and the base branch's own rules dismiss stale approvals. Otherwise the review is a comment, and its last paragraph says which condition did not hold. Every approval is recorded on its run. A push, a retarget, a reopening, or a later review that does not approve withdraws it, as a job of its own lane; one GitHub already dismissed is no failure; a withdrawal that fails three times raises `dismissal_failed` and, on a gated pull request, fails the gate's check; a merge at another head while an approval of the bot's still stood is recorded and raises `stale_approval_merged`. The audit sample is the next plan: until it is built the config refuses approval unless the audit share is written as 0.

**Architecture:** The decision is pure and lives in a new part, `src/approval/`: `threads.ts` says which threads are closed for approval (strict, or the gate's rule) and which stored findings lost their thread, `rule.ts` reads conditions 2 to 4 from the stored runs and conditions 5 and 7 from the live pull request, `text.ts` holds every sentence. `publishRun` (`src/shell/publish.ts`) decides at the moment of posting, from the run, the stored runs and comments the review job hands it, and three live reads made in order and only when needed (the pull request it already reads, the threads, the branch's rule); it posts with the event `APPROVE` or as a comment, and the body ends with one paragraph after `Overall`. The review job records `approved` and the decision's code with the publication and, in the same transaction, asks for a withdraw job whenever the pull request has an approval of the bot's that is not dismissed. Withdraw jobs are a third lane of the queue (`jobs.kind = 'withdraw'`), with their own runner of 2 places that is never paused; receiving asks for one, in the delivery's transaction, on a push, a retarget, a reopening, a merge and a dismissed review of a pull request that has such an approval, whatever the review filters say. `src/approval/withdraw.ts` reads the live pull request and each standing approval's state, dismisses the ones that no longer hold, and records what it found. The gate reads a recorded failure as a fact and fails the live head's check while it stands. GitHub's branch rules, a review's state and the dismissal sit behind one new interface, `ForgeApprovals`.

**Tech Stack:** Unchanged. No new library, no model call. One migration, `0013_approval`.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 2 (G3, anti-goals 1 and 2); 3 (O9, O15, D4, D9, D10, D12, D14, D15, D18, D22, D23, D24); 5.2 (settled, covered); 5.6 (steps 6 and 7, what a kept verdict does); 6.3; 6.4 whole; 6.5 (the audit sample, for the refusal only); 8.1 to 8.5; 9; 10 with App permissions; 11.1, 11.2; 12; 13; 14; 16; 17; 18 (items 8 and 9); 20 (items 1, 2, 7, 8); 21; 22.

**Notes:** the notes file beside this plan is written when the build ends. This is the first of two plans of stage 9 (call 1); the second builds the audit sample.

**This plan was reviewed before it was built.** The review found one critical defect and five important ones, all ruled on and applied here: a finding whose thread was deleted, or whose thread is no longer the app's, was read as closed (call 33); a thread this review kept `open` could be closed by an older reply (calls 26, 27); under the gate's rule with clearing by reply off a thread could be held for ever (call 7); a review whose commit GitHub collected could never be read (calls 16, 18); a withdrawal whose pull request could not be read recorded nothing (call 19); and a pinned test of the writer was not named. Ten smaller points were applied too, and Task 5 was cut in two.

**Words used below.** *Approval on*: `approvalOf(settingsFor(repo)).enabled` (Task 1). *An approval*: a review of the app's own posted with the event `APPROVE`. *A standing approval*: a row of `review_runs` that is published, not a dry run, `approved`, with `dismissed_at` null. *The rule*: whether the base branch's own rules dismiss an approval when new commits are pushed (6.4, condition 8). *The thread rule*: `strict` or `gate` (D18), the config's `approvalThreads`. *A person*: the author of a thread comment with `byApp` false and `authorIsBot` false, as in the gate. *Access*: an association of `owner`, `member` or `collaborator`, as GitHub reports it for the comment; absent or anything else is none (call 6). *The app's own thread*: a thread whose first comment has `byApp` true. *Closed for approval*: Task 5's rule 3, and Task 6's rules. *Without a thread*: a major or blocker finding a run reported that no later review can clear (Task 7, rule 3). *A lost thread*: a stored major or blocker finding of a published run whose comment is not the first comment of an app's own thread the live read lists (call 33); (as built) a stored row whose severity word is unknown, or whose run is not among the runs read, counts too. *The decision*: the `ApprovalCode` a publication ends with. *Withdraw job*: a job of kind `withdraw`. *Short code*, *the head's review*: as in the gate plan.

## Scope

| In this plan | Left out, and why |
|---|---|
| 6.4 conditions 1 to 5, 7 and 8; "otherwise the review is a comment"; why it did not approve, said in the review | **Condition 6, the audit sample (6.5, D9):** the next plan (call 1). Until it exists the config refuses `autoApprove: true` unless `auditShare: 0` is written, so condition 6 holds because nothing is drawn |
| D18: the strict rule by default, the gate's rule as a setting; access read from what GitHub reports on each thread comment (D23) | **Whether the repository requires an approving review, or code-owner review** (6.3, 6.4 last paragraph): nothing reads it; the README recommends the rule (call 29) |
| D12 and 6.4 Withdrawal: on a push, a retarget and a reopening, stored with the facts and run at once, whatever the filters; an alert and the gate's check on a failure; a merge under a stale approval recorded and alerted | **A conversion to draft** withdraws nothing (call 15) |
| 13: whether a run approved, why it did or did not, when and by whom its approval was dismissed, why a withdrawal failed, whether it stood at a merge | **A record for the UI's count of reverted pull requests the bot had approved** (6.5): `review_runs.approved` is the source; the count is the UI's (stage 10) |
| 10: `administration: read` in the manifest, the feature `approval` in what the app lacks | **A notifier told of an approval**: `ReviewNotice` is unchanged (call 30) |
| 14: `dismissal_failed`, `stale_approval_merged` | **A timer that retries a failed withdrawal**: it is tried again at the next push, retarget, reopening, publication, dismissed review or start (call 22) |
| The documents, a run under Docker, the checks the scratch app allows | **The evals with lessons as of each case** (18, item 8): left until a deployment exists; the design is corrected (Task 13) |

**Dry run:** nothing is decided, nothing is posted as an approval, no withdraw job is stored, and a withdraw job found is dropped as `dry_run`.

## What the map of the code found missing, and where each stands

| # | Gap | Here |
|---|---|---|
| 1 | No approval submit | Task 3: `ReviewDraft.event` |
| 2 | No dismissal, no read of a review's state; a dismissed review's event ignored | Task 4 (`readReview`, `dismissReview`), Task 3 (`state` on the app's own reviews, the event `review_dismissed`) |
| 3 | No read of branch rules, no permission for it, no feature in what the app lacks | Task 4 (call 9) |
| 4 | No record of an approval | Task 2 |
| 5 | Withdrawal has no place to run | Tasks 2, 10, 11 (call 17) |
| 6 | A push between the read and the post, or between the post and its record | Calls 3, 10; Tasks 9 and 10 |
| 7 | The strict rule cannot be evaluated; a thread the author settled is never judged again | Task 3 (access), Task 5 (calls 6, 7) |
| 8 | Condition 4 only partly stored | Task 5 (`closedForApproval` kept with a duplicate), Task 6 (lost threads, call 33), Task 7 (calls 5, 8) |
| 9 | Conditions 5 and 7 not checked at publish | Tasks 7 and 8 (call 3) |
| 10 | Body and event fixed before publishing; a refused approval read as a refused comment | Tasks 7 and 8 (calls 13, 14) |
| 11 | No config keys | Task 1 |
| 12 | No audit sample | Not in this plan (call 1); Task 1's refusal |
| 13 | `nothing_new` and `already_reviewed` after a withdrawal | Call 12; Task 9 |
| 14 | No alerts; no fact for the gate; which commit's check | Calls 19, 24; Tasks 10 and 12 |
| 15 | A conversion to draft | Call 15: it withdraws nothing; no code |
| 16 | Resumed and adopted runs | Call 16; Tasks 8 and 9 |
| 17 | Required approvals and code owners | Not in this plan (call 29) |
| 18 | A merge under a stale approval | Call 20; Tasks 10 and 11 |

## Not in this plan

- **The audit sample** (6.5, D9): its key, its draw, its label, its record and its text. The next plan.
- **Reading required approvals or code owners** (6.3, 6.4): call 29.
- **A notice field, a UI count, a timer for retries**: calls 22, 30; stage 10.
- **The evals with lessons** (18, item 8): until a deployment exists (call 31).
- **Any dropped idea** (call 32).

## Calls made in this plan

"(builder)" marks a call the builder took before the plan was written, restated with its cost; "(ruled after the review)" marks what the builder ruled on the review of this plan; every other call is the planner's. Where the design says otherwise, the call says so.

**The cut and the switch**

1. **(builder) Two plans; this is the first.** It holds the approval, its record and its withdrawal, behind the switch, in thirteen tasks; the audit sample (a key by reference, a keyed draw, a label, a record, a text, the documents: about four tasks) is the next. Until then `parseConfig` refuses, for the defaults and for each repository as merged, `autoApprove: true` with any `auditShare` but 0, the default 5 included (Task 1, rule 3). Cost: a team that wants approval now must write `auditShare: 0` and has reverts as the only outside signal (6.5); the next plan changes the refusal into the draw.
2. **(builder) Off by default, per repository, in the deployment config only** (O9, D10). Three keys in the `score` block: `autoApprove`, `approvalThreads` (`strict` or `gate`), `auditShare` (0 to 100, a percentage). `.visto-ai.yml` still accepts only `human_review`, so it can set none. The loaded settings carry `approval` only when one of the keys is written, so a config that writes none is the object it was. Cost: none known.
3. **(builder) Decided at publish, from live reads; what cannot be read means no approval.** What is read, from where and when:

| Condition | Read | When | Cannot be read |
|---|---|---|---|
| 1 | `approvalOf(settings).enabled` | when the job is about to publish | (config) |
| 2, 3 | this run's stored result: every `scores[]` entry `covered: true`, `coverage.notReviewed` empty, `verdict.needsHuman` false and every score below the threshold in force now | at publish, from the run handed in | `record_unreadable` |
| 4, this review | `findings`, `unplaced`, `unchanged` of this run | at publish | `record_unreadable` |
| 4, every run | every published, non-dry run and this one, from `listRuns` read just before publishing | at publish | `record_unreadable` |
| 5 | the live pull request `publishRun` already reads: open, head and merge base equal to the run's, `draft` | at publish | (as today: `closed`, `moved`) |
| 7 | the same read's `fromFork`: `true` is a fork, absent is not known | at publish | `origin_unknown` |
| 4, threads | `listThreads` live, the stored comments from `listComments` read just before publishing, repaired from the threads; a lost thread counts as open (call 33) | at publish, only when the rows before passed | `threads_unreadable` |
| 8 | `ForgeApprovals.staleApprovals` on the live base branch | at publish, last | `rule_unreadable` |

   (as built) The rows are in the order the decision reads them (Task 8, rule 3): the stored conditions (the record readable, every file covered, nothing at or above the threshold, no blocking finding in this review, none left without a thread by any run), then draft and fork from the live read, then the threads, then the branch's rule. Open, head and merge base are checked first, before any decision, as today. The paragraph names the first that fails in this order.

   A push between the live read and the post leaves an approval pinned to the commit read; the job then asks for a withdraw job in the transaction that records it, which reads the live head and dismisses it (call 10). An approval GitHub refuses falls back to a comment and is never sent again as an approval in that publication (call 14). Cost: an approval-on publication makes up to two more reads of GitHub (the threads and one or two rule reads) and two of the database; an approval can stand for a few seconds on a head it was not decided for, until the withdraw job runs.
4. **(builder) `administration: read`.** It is the permission that reads classic branch protection; the manifest gains it, and the feature table names `approval` for it (Task 4). Cost: an app made from the manifest holds it with approval off; an existing app is given it by hand, each installation accepts it, the service is restarted.
5. **(builder) Withdrawal is a job, stored in the transaction of the pull request's facts,** on `synchronize`, `retargeted` and (ruled after the review) `reopened`, and on a merge, for every pull request with a standing approval, whatever the filters say (draft, ignored author, base filter, gate); due at once; idempotent by the stored review's id; an approval GitHub already dismissed is recorded as dismissed by the git service, not as a failure. (as built) A reopening asks for a withdrawal as a new commit does: it withdraws an approval of another head or base branch, and an approval of the reopened head and base stands (call 10). **The design says "at once, before the new review is queued"**: here it is stored in the same transaction as the review's job and runs at once, a failure is tried again after 10 and 60 seconds, and the alert and the check come after about 70 seconds (Task 13 amends 6.4 and 8.1). Cost: one read of `review_runs` in the transaction of every push, retarget, reopening and merge delivery, in every deployment.
6. **(builder) Access is what GitHub reports for each thread comment** (`authorAssociation` in the thread query), and an unknown association is none. Cost: one more field in each thread page; design 20, item 7 (private membership) applies here as it does to commands.
7. **(ruled after the review) "Settled" is the intersection of the rules in force, under both thread rules.** With approval on, a thread is settled (not judged again, 5.2) only when today's rule (the gate's second half, narrowed by `clearByReply` off on a gated pull request) and the thread rule's second half (Task 5, rule 3) both accept it. So a thread the author replied to and resolved is not settled under the strict rule, and a thread a person replied to and resolved is not settled under the gate's rule with `clearByReply` off; each is judged again by every review, which can close it with a verdict (gap 7). The design says "it is the second half of that rule"; the intersection is equal to it except where today's rule is narrower, and taking it keeps the gate's call 36. Cost: more threads are judged, and their files are read (5.2, priority 1); under the strict rule a thread the app resolved after an `answered` verdict is judged again at every review until someone with access who is not the author replies, and a new `open` verdict on it makes it block the gate again (the gate's second case reads the newest verdict).
8. **Condition 4 across runs counts, for every published non-dry run and this one:** `unplaced` majors and blockers; the placed majors and blockers of a run posted without its inline comments (`inline_dropped`); `unchanged` majors and blockers; and `alreadyDiscussed` entries whose thread was closed for approval when the finding was dropped. That last flag is new (`Discussed.closedForApproval`, copied by the engine from `EarlierThread.closedForApproval`, which the shell sets when approval is on); an entry stored before it has none, and its `settled` stands in. A full later review's findings on unchanged lines were posted inline and have threads, so they count under the thread part. Cost: a major that could not be placed holds approval for the rest of the pull request (the design's words); an entry stored with approval off reads the gate's "settled" in place of the approval's.
9. **The rule, condition 8.** First `GET /repos/{owner}/{repo}/rules/branches/{branch}` (the active rules of every ruleset that applies to the branch, whatever level it is set at): an entry with `type: "pull_request"` whose `parameters.dismiss_stale_reviews_on_push` is `true` means "dismissed", and nothing more is read. Else `GET /repos/{owner}/{repo}/branches/{branch}/protection`: `required_pull_request_reviews.dismiss_stale_reviews === true` means "dismissed"; a 404 is no protection. Either form saying so is enough; both read and neither saying so is "kept" (`rule_off`); a form that could not be read, and the other not saying so, rejects with that read's code (`rule_unreadable`). Rules in `evaluate` or `disabled` enforcement are not returned by the first endpoint. **(ruled after the review) The permissions are settled by GitHub's permissions page:** the rules read needs Metadata read, which every app has; the protection read needs Administration read (call 4). Cost: up to two reads per approval-on publication; a 403 is not read for its message, so a plan that cannot hold protection reads as `rule_unreadable` rather than `rule_off`; what GitHub's documentation does not settle is in "To verify".
10. **The withdraw job decides from the live pull request, and every ask is the same job.** Open: it withdraws every standing approval whose head or base branch is not the live one, or all of them when the newest published run is not an approval that stands (calls 11, 34). Merged: call 20. Closed: nothing. It reads each review's state first and dismisses only an approval GitHub still holds. (as built) On an open pull request it also reads every standing approval it does not withdraw: one with a recorded failure as call 19 says; any other is recorded dismissed by the git service when GitHub holds it as dismissed or commented, and the gate is asked after it as after any dismissal; one held as approved changes nothing; a read that rejects, answers null or answers another state changes nothing and is no failure of the job (such an approval needs no withdrawal: nothing is recorded on it, and the job is not put back for it). A merged or closed pull request is read as before. A job that withdrew nothing, read no recorded failure and recorded nothing ends `kept`. Cost: one live read of the pull request and one read per standing approval; (as built) on an open pull request that is one read of GitHub for each standing approval in each withdraw job, the approval at the live head that is the newest review included; a withdraw job runs after every publication on a pull request with a standing approval, the approving one included, and usually finds nothing to do.
11. **A later review that does not approve withdraws the bot's earlier approvals of the same head.** The design speaks only of new heads; without this a `/review` that finds a thread reopened would leave the older approval standing beside a review that says it does not approve. Cost: a re-check whose thread read or rule read fails takes back an approval that was right; on a protected branch where the app may not dismiss (20, item 2) and no push follows, it becomes a failed withdrawal, with the alert and a red check.
12. **After an approval, a push that tells nothing new is still published; `already_reviewed` stays.** With approval on, a push's review that would end `nothing_new` is recorded and posted, and decided, when the newest published review of the pull request was posted as an approval, dismissed since or not (call 34): an approval belongs to one head, so the new head needs its own. Its scores are stored as any recorded run's are, as a `nothing_new` run's are today. (Ruled after the review.) When that read of the newest review rejects, the review fails closed: it is posted, as a comment whose paragraph gives `record_unreadable`, by the path a failed read of the decision takes (Task 9, rule 4). An automatic job on a head whose review is the newest published one is still dropped as `already_reviewed`. Cost: one more review in the pull request for each such push, with no model call (the review was already computed); a head that returns to the newest review's head after its approval was withdrawn stays unapproved until `/review`.
13. **The body ends with one paragraph, only with approval on.** It is rendered at publish with the stored result (`Meta.approval`), as the body-only fallback already renders it, and stands after the `Overall` line inside the tail that a cut keeps. The texts are Task 7's. One reason is given, the first condition that failed in the order of call 3's table. A body that cannot be rendered again is posted as it was recorded, with the paragraph decided now set after it (`fitBody(run.body, paragraph)`, which keeps the paragraph whole); the decision stands. Cost: every review of an approval-on repository carries one more paragraph; a person fixing the reason given may meet the next one only at the next review; a recorded body near GitHub's limit loses its end to keep the paragraph.
14. **A refused approval.** A 422 on `APPROVE` makes the decision `refused` (`review_rejected`): the same comments are posted once as a comment with the refused paragraph, then the chain as today (without notes, body only), all as comments. Any other failure of the approval's post is a failed publication, as today; the later start decides again. Cost: when the 422 was about an inline comment and not about the approval, the approval is lost for that head; an approval has no notes and no major, so its inline comments are minors only.
15. **A conversion to draft withdraws nothing.** A draft cannot be merged, and marked ready again at the same head it is the code that was approved. A push while it is a draft withdraws as any push. Cost: a draft shows the bot's approval.
16. **A resumed run is decided at its post like any other; an adopted review keeps what GitHub holds.** (Ruled after the review.) A resumed run's text keeps the trigger and requester it was recorded with: a run this job recorded is rendered with this job's (they are its own); a run another job recorded is never rendered with this job's requester: its body is the recorded one with the paragraph decided now (call 13), and its body-only fallback is rendered with the run's own trigger and no requester, with approval on or off. Adoption reads the state `listOwnReviews` now carries: `APPROVED` or `DISMISSED` is an approval (only an approval can be dismissed here), recorded with no decision code; `DISMISSED` is recorded dismissed by the git service; an approval adopted at another head than the live one is withdrawn by the job asked for with it. An entry of the app's reviews whose commit is null (a commit pushed away and collected) is skipped, where today it fails the whole list. Cost: the stored body of an adopted approval-on review lacks the paragraph GitHub's copy has; a resumed run of another job that GitHub refuses inline opens with "requested." and no name; a review on a collected commit is never adopted, which is right, since it is no head's.
17. **A third lane.** `jobs.kind` gains `withdraw`, with its own pending slot per pull request (the index of `0008_gate`), a runner of 2 places that is never paused, retries after 10 and 60 seconds, a give-up at the third start, and the starts handed on when a waiting job supersedes a running one, as the gate's sync does. Cost: one more statement at each tick of the service; a withdraw job, a gate job and a review job of one pull request may run at once (each writes only its own facts).
18. **Read first, then dismiss, with a fixed message.** `readReview` needs only the review's state; its commit, which GitHub may give as null, is never read. `dismissed` or `commented` (no longer an approval) is recorded `git_service`; `approved` is dismissed with `dismissMessage(head)` and recorded `app`; a dismissal that fails is read once more, and dismissed then is no failure. A 404 on the read is a failure (`review_not_found`): a lost repository is not read as a dismissal. (Ruled after the review.) Any other state is a failure (`review_state_other`), never a dismissal. Cost: two or three calls for each approval withdrawn.
19. **A failed withdrawal, on which check and for how long.** After the third failed start the job records the code on each approval it could not dismiss and, (ruled after the review) when the live pull request could not be read at any start, on every standing approval of the pull request, with the read's code; it raises `dismissal_failed` once for the give-up when it recorded a failure that was not recorded before, and asks the gate. (as built) The failure marks are written before the job is finished, and a mark the database refuses counts as new: `dismissal_failed` is raised and the gate asked. (as built) A withdraw job the runner drops as `too_old` or `attempts_exhausted` records that reason as the failure on every standing approval of the pull request, raises `dismissal_failed` once with `reason`, `repo` and `number`, and asks the gate when the repository's gate is on (not in dry run). (as built, the fix wave) It raises `dismissal_failed` only when one of these marks answered true or was refused, or the standing approvals could not be read; and, out of dry run, a job dropped as `too_old` is asked for again at once (`askWithdraw` with the job's installation, then the withdraw runner ticked): the dropped row is finished, so a fresh job re-checks, clearing the approvals that hold (Task 10, rule 3) and withdrawing the others. Not one dropped as `attempts_exhausted`: a crash that repeats would loop. The gate's check of the pull request's live head, every head, then fails (`unwithdrawn`) for as long as a standing approval carries a recorded failure: it outranks a skip and a review, and gives way to bypass. It ends when any later withdraw job finds the approval dismissed, by itself or by anyone; (as built) or, on an open pull request, finds it holding: a standing approval with a recorded failure that is no target is read too, and one GitHub holds as approved has its failure cleared, then the gate is asked (Task 10, rule 3). Cost: a pull request cannot pass the gate until a person dismisses the approval or the service manages to; the design names no check, and this is the head the merge would happen at; an outage of GitHub's pull request read of about 70 seconds turns such a check red.
20. **A merge under a stale approval.** On the merge's delivery of a pull request with a standing approval, a withdraw job reads each standing approval of another head than the merged one: one GitHub still holds as approved is recorded (`stood_at_merge`, never on a dismissed run) and alerted once (`stale_approval_merged`, with the repository and the number); one it holds as dismissed or commented is recorded as dismissed. (as built, the fix wave after the whole-branch review) The targets at a merge are computed as on an open pull request (call 10, Task 10 rule 3): the standing approvals whose head is not the merged head or whose base branch is not the merged pull request's, or every standing approval when `newestApprovalStands` is false. So an approval a later review of the same head did not approve (call 11), and one for a base branch the pull request was retargeted away from, are read too and, held as approved, recorded and alerted; an approval of the merged head and base while the newest published run is an approval that stands is left. None is dismissed at a merge. Cost: one dismissed by a person after the merge reads as never having stood; a read that fails three times records and alerts nothing.
21. **A dismissed review is an event.** `pull_request_review` with the action `dismissed` is parsed (`review_dismissed`), stores no activity, and asks for a withdraw job when it names a standing approval of the app's own. So GitHub's own dismissal on push, and a person's by hand, reach the record and the gate within seconds, if GitHub sends the delivery for each (To verify). (as built) They do because the job the delivery asks for reads every standing approval of an open pull request (call 10): an approval at the live head that is the newest review, which is no target, is recorded dismissed by the git service too, and the gate asked. (as built, the fix wave) On a merged pull request only the targets of call 20 are read, and on a closed one none, so the dismissal of an approval of the merged head and base while the newest published run is an approval that stands, or on a closed pull request, is not recorded. Cost: with approval off such a delivery is recorded as handled where it was ignored as `unknown_action`.
22. **At start, a failed withdrawal is tried again.** Out of dry run, after the gate's sweep and before listening, every pull request stored as open with a standing approval that carries a recorded failure gets a withdraw job (`withdraw_sweep`, logged only when it asks for one). (Ruled after the review.) A closed or merged pull request's failure stays recorded as it is and is not asked for. The stored state is read for each such pull request only, so a deployment with no failure reads no row of `pull_requests` at start. Cost: nothing else retries a failure: no timer.
23. **Migration `0013_approval`:** six columns of `review_runs` and one partial index. Every row stored before reads as no approval. The previous release refuses to start on the migrated database (it finds a migration it does not know), as after every migration.
24. **Logs and alerts.** `dismissal_failed` (details: `reason`, `repo`, `number`), `stale_approval_merged` (`repo`, `number`); one `withdraw` line per job; the `review` line gains `approved` and `approval` only when the publication carried a decision or an adopted approval. Lines hold ids, numbers, repository names, counts and short codes: never a login, a branch, a path, a message or an error's text.
25. **With approval off, what changes:** the columns; one read of `review_runs` in the delivery of each push, retarget, reopening and merge, after each publication, at start, and in each gate evaluation; (as built) one read of `review_runs` in the delivery of a dismissed review (out of dry run), and the withdraw runner's `onLeft` reads on a dropped job; the withdraw runner's poll; `state` on the app's listed reviews and `authorAssociation` in the thread query, read and not stored; an entry of the app's reviews whose commit is null is skipped; a resumed run another job recorded, when GitHub refuses its inline comments, is written in the body naming no requester (call 16); a dismissed review's delivery recorded as handled; an adopted review GitHub holds as an approval recorded as one; the manifest of an app not yet created. Nothing is posted, dismissed, logged or alerted that was not, and the body is what it was (Global Constraints list the pins).
26. **(ruled after the review) The gate's rule for approval is the gate's rule, made stricter in two cases.** A thread counts as open when `evaluateGate`, with this run treated as the head's review and as published and with the repository's `clearByReply`, would block it; and also when this run kept `open` for it, and when it is a lost thread (call 33). The design says "exactly when the gate's rule would clear it". Cost: under the gate's rule a thread a person replied to and resolved, that this review judged `open`, holds approval though the gate lets the merge through.
27. **Strict case 1 is this run's verdict only,** with the gate's test of staleness: a kept `fixed` with `fileChanged: true`, and no comment by anyone but the app after the replies it judged. Strict case 2: resolved, and either the app resolved it and the newest verdict a published run kept for it is `fixed` with `fileChanged: true`, or a person other than the author, with access, replied in it. (Ruled after the review.) A thread this run kept `open` is open, whatever case 2 says. (as built) Nor does a reply made before a review kept the thread open close it at a later review: when the newest verdict a published run kept for a thread is `open`, only comments after the first `1 + replies` comments count as the reply of someone with access; when that entry has no `replies`, or the newest entry is damaged, no reply counts. After a newest `answered`, or `fixed` with no file change, earlier replies count as before. The app's own thread with no stored finding counts, as the gate's `unknown`, and closes only by case 2's reply. Cost: a thread whose fix was verified by an older head's review, and that nobody resolved, is open for approval until a review of the present head verifies it again; (as built) a member who replied before a review kept the thread open must reply again after it, or a review verify a fix.
28. **What is checked against GitHub:** Task 13, rule 6; what cannot be, "For the owner".
29. **Required approvals and code owners are not read** (gap 17). The README recommends the rule that requires an approving review (6.3). Cost: in a repository that requires none, the bot's approval decides nothing and nothing says so; where code owners are required, GitHub still waits for one.
30. **`ReviewNotice` is unchanged.** Cost: a notifier cannot tell an approval from a comment.
31. **(builder) The evals with lessons wait for a deployment** (18, item 8): a history file holds no finding of this reviewer, so lessons for an eval can be made only from a deployment's own database. Task 13 corrects the design.
32. **(builder) No new library, no model call, no dropped idea** (no verifier, no repository-wide packs, no recall-first contract, no lens pass). Approval spends nothing; the paid ceiling is touched only by the trial's reviews on the scratch repository.
33. **(ruled after the review) A lost thread is open for approval, under both thread rules.** Every stored blocker or major finding of a published run that is not a dry run, whose comment id is not the first comment of a thread the live read lists whose first comment is the app's, counts once as open. (as built) So does a stored row whose severity word is unknown, and one whose run is not among the runs read. The author of a pull request from the repository itself has write access and can delete the bot's comment; a thread walked from the live list alone would then read as nothing open. Cost: a finding whose comment anyone deleted, or whose thread GitHub no longer lists as the app's, holds approval for the rest of the pull request, as a finding without a thread does; a person reviews it instead.
34. **(ruled after the review) Two readings of the newest published review.** `newestApprovalStands` (the withdraw job) leaves out a dismissed approval: a dismissed approval is no reason to keep another. `newestWasApproval` (call 12) counts one: by the time a push's review is computed, 180 quiet seconds after the push, the withdraw job has dismissed the approval of the old head, and reading it as no approval would end every such review as `nothing_new`, which is what call 12 exists to avoid. `markStoodAtMerge` leaves out a dismissed run. Cost: none known.

## For the owner

1. **Cannot be undone:** the previous release does not start on a database this release has migrated. The rest can: the six columns only add facts, and `autoApprove` not written posts no approval.
2. **Only he can supply a repository that holds rules, and a webhook.** The scratch repository is private on a plan that offers neither rulesets nor classic protection, so condition 8 refuses there and no approval can be posted through the service; and its app has no webhook, so GitHub's own deliveries are never seen. Until he gives a public scratch repository, where both forms are free, or a plan that holds them, with the go-ahead to make a ruleset and a protection rule there, and a deployment GitHub can deliver to, these stay unverified: design 20 item 1 (an app's approval counts toward required approvals), item 2 (an app may dismiss its own approval on a protected branch), and item 8 on a branch whose rules dismiss; whether a protection rule written as a pattern comes back for a branch it matches; whether "new, reviewable commits" leaves out a merge of the base, so that GitHub's rule does not dismiss on it; whether an approval posted on an older commit after a push counts toward required approvals; and whether GitHub's own dismissal on push, and a dismissal by hand, each send a `dismissed` delivery. The default: not made; Task 13 makes the checks the private repository allows.
3. **Rulings he may want to change** (each a small change): call 11 (a later review of the same head that does not approve withdraws), call 12 (`nothing_new` after an approval is posted), call 15 (a draft keeps the approval), call 19 (a skip does not pass a failed withdrawal), call 13 (one reason, in every review of an approval-on repository), calls 7, 26 and 33 (the thread rules made stricter than the design's words).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task the ASCII check of the plans before prints nothing.
- **No test reaches the network, a real database or a model.** A database is `testDb()`. GitHub is a fetch stubbed by route (`"METHOD path"`) or a literal fake of an interface that pushes `[name, ...args]` for each call. A clock is passed in. Every wait has a bound.
- **With approval off nothing changes but call 25's list.** The pins: Task 1 `approval is off unless the config writes it, and a config that writes none gives the settings it gave`; Task 5 `with approval off the earlier state is what it was`; Task 7 `with no approval paragraph the body is what it was`; Task 8 `with approval off the reads and the post are what they were`; Task 9 `with approval off the job records, posts and logs what it did`; Task 11 `with no standing approval, or in dry run, a push stores nothing more and its line is what it was`; Task 12 `with no failed withdrawal the evaluation is what it was`.
- **Fail closed.** `approved` is the decision only when every condition was read and holds. A field that cannot be read, a read that rejects, an answer of the wrong shape: never "holds".
- **One poster of approvals, one dismisser.** Only `publishRun` posts an approval; only `runWithdrawJob` dismisses; neither in dry run.
- **A stored result may be old or damaged.** Every field read from `review_runs.result` is checked; what cannot be read is `record_unreadable`, never thrown on.
- **Never rejects.** `runWithdrawJob` never rejects, like `runReviewJob` and `runGateJob`. A logger or an alert that throws changes nothing.
- **Boundaries, by the lint as it is.** `src/approval/**` is under the general block: no `**/forge/github/**`, no `pg`, no MCP. It imports from `src/db`, `src/config`, `src/shell`, `src/gate` and `src/forge/types.ts`, and nothing of the engine but its types. `src/engine/**` imports nothing of it; `renderReview` and `fitBody` are called from `src/shell/publish.ts` only. Only `src/forge/github/**` knows GitHub's shapes; `src/main.ts` wires the adapter. No lint rule changes.
- **Logs and texts:** call 24. Every text a person reads on GitHub is one of Task 7's or Task 12's, character for character; a code shown is a short code, else `internal_error`.
- **Migrations:** one file, `src/db/migrations/0013_approval.sql`, plain SQL in the schema `visto_ai`. Owner and repo lower-cased on every write and lookup; outside text through `storable()`; a time as an ISO string with `::timestamptz`. No statement of this plan names `visto_ai.pull_requests` or the word `gate` but where it says so (the service's tests filter statements by those words).
- **No existing test is edited, but for these, each named in its task with the exact change:** `src/forge/github/events.test.ts` `review`, and `src/forge/github/writer.test.ts` `the app's own reviews are listed, newest first: by its own account, with a body` (Task 3); `src/forge/github/app-manifest.test.ts` `an app made from the manifest lacks nothing the service needs`, `the manifest asks for no permission the service does not use` and `the manifest is private, has an active hook and no address to come back to` (Task 4). Every new field of an existing type is optional, so no typed fixture changes. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test`; `REF = acme/shop` number 7; `at(seconds)` from `2026-03-01T10:00:00.000Z`; heads `h1` (reviewed) and `h2` (pushed); merge base `merge000`; review ids `501`, `502`; logins `octo-dev` (the author), `octo-lead` (a member), `octo-guest` (no access); installation `'99'`; the app's account `visto-test[bot]`; branches `main` and `release/1.0`; hosts under `example.test`. Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A push that lands between the decision and the post, or between the post and its record; a redelivered push; GitHub's own dismissal first; a reopening at a new head.** Task 9 `an approval is recorded with its code, and a withdraw job is stored with it`; Task 10 `an approval at another head than the live one is dismissed and recorded as dismissed by the app` and `one GitHub already dismissed is recorded as dismissed by the git service, and no dismissal is sent`; Task 11 `a push, a retarget, a reopening and a merge of a pull request with a standing approval store a withdraw job in the delivery's transaction, whatever the filters say`.
2. **The author, or a stranger, closing a thread alone; a deleted comment; this review's own `open`.** Task 5 `under the strict rule a thread the author replied to and resolved is not closed, and one a member who is not the author replied to is`, `a reply by someone without access, or whose access GitHub did not report, closes nothing under the strict rule`, `with approval on under the strict rule, a thread the author replied to and resolved is not settled, and is due` and `under the gate rule for approval with clearing by reply off, a thread a person replied to and resolved is not settled, and is due`; Task 6 `a stored major whose comment was deleted holds approval back, under both rules`, `a thread whose first comment is no longer the app's holds approval back` and `a thread this review kept open is open for approval under both rules, though a member replied and it is resolved`.
3. **A read that fails or answers the wrong shape:** the threads, the rule (each form), the runs, a stored result, a review's state, a commit that is null, the live pull request at every start. Task 4 `a form that could not be read is no answer: kept only when both were read, dismissed when either says so` and `a review whose commit is null is read with its state`; Task 7 `a stored result that cannot be read is record_unreadable, never approvable`; Task 8 `a thread list that cannot be read is threads_unreadable, never no thread`; Task 9 `a read of the newest approval that fails before a nothing-new push posts the review as a comment with record_unreadable`; Task 10 `a review GitHub does not find is a failure, not a dismissal`, `a review in a state that is neither approved, commented nor dismissed is a failure` and `a pull request whose live read fails three times records the read's code on each standing approval and alerts once`.
4. **GitHub refusing the approval itself.** Task 8 `an approval GitHub refuses is posted once more as a comment with the refused paragraph, and then as today`.
5. **An approval that will not go away:** a failed withdrawal, then one dismissed by hand; a restart between; a merge under it. Task 10 `a dismissal that fails is tried again after 10 and 60 seconds, then recorded, alerted once and asked of the gate` and `at a merge, an approval of another head that still stands is recorded and alerted once; one dismissed is recorded as such; one at the merged head is left`; Task 11 `at start a standing approval whose withdrawal failed is asked for again on an open pull request, and nothing is logged when none is`; Task 12 `a recorded failure to withdraw fails the check, outranks a skip and a review, and gives way to bypass`.
6. **A later review of the same head that does not approve.** Task 10 `a later review that does not approve withdraws the approval of the same head`.
7. **A finding hidden for good:** unplaced, refused inline, on unchanged code, swallowed by a closed thread, in a run before the switch. Task 7 `a major or blocker left without a thread by any published run holds approval`.
8. **A text that names someone who did not ask.** Task 8 `the prefix never names the current job's requester for a run they did not ask for`.
9. **The bytes with approval off.** Global Constraints' pins.

---

### Task 1: The switch, the thread rule and the audit share in the configuration

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`
- Test: `src/config/load.test.ts` (new tests only)

**Interfaces:**
- Consumes: `repoSettingsFor`, `gateBranchIssues`'s pattern, `definedOnly` (`src/config/load.ts`).
- Produces:

```ts
// src/config/load.ts
export type ApprovalThreads = 'strict' | 'gate';
export interface ApprovalSettings {
  enabled: boolean;            // 6.4 condition 1
  threads: ApprovalThreads;    // D18
  auditShare: number;          // 6.5, a percentage from 0 to 100; this release accepts only 0 while enabled
}
export const APPROVAL_OFF: ApprovalSettings = { enabled: false, threads: 'strict', auditShare: 5 };
// RepoSettings gains:  approval?: ApprovalSettings;            absent: APPROVAL_OFF
// RepoOverride becomes: Partial<Omit<RepoSettings, 'gate' | 'approval'>> & { gate?: Partial<GateSettings>; approval?: Partial<ApprovalSettings> }
export function approvalOf(settings: RepoSettings): ApprovalSettings;     // settings.approval ?? APPROVAL_OFF
export function approvalUseOf(config: DeploymentConfig): boolean;         // the defaults or some override, merged, has approval enabled
```

**Rules (6.4, 6.5, 11.1, 11.2, D10; calls 1, 2):**

1. **Schema.** The `score` object of the defaults and of an override gains three optional keys with no default: `autoApprove: z.boolean()`, `approvalThreads: z.enum(['strict', 'gate'])`, `auditShare: z.number().min(0).max(100)`. Both stay `.strict()`.
2. **Loaded.** `repositories.defaults.approval` is set only when the defaults' `score` writes one of the three keys: `{ enabled: autoApprove ?? false, threads: approvalThreads ?? 'strict', auditShare: auditShare ?? 5 }`. An override's `approval` is set only when its `score` writes one of them, and holds only the keys written (`autoApprove` as `enabled`, `approvalThreads` as `threads`). `repoSettingsFor` gives `approval: { ...APPROVAL_OFF, ...defaults.approval, ...override.approval }` only when either has one, and no key otherwise.
3. **The refusal.** For the defaults, and for each override as merged by `repoSettingsFor`, an `approval` that is enabled with an `auditShare` other than 0 is an issue, exactly `repositories.defaults.score.auditShare: must be written as 0 while autoApprove is true: this release does not draw the audit sample yet`, or the same with `repositories.overrides.<name>.score.auditShare`. Bad defaults cover an override that writes neither `autoApprove` nor `auditShare` (reported once), as for the gate's branches. It holds in dry run too. No issue quotes a value. (as built) A config with a bad gate and a bad audit share is refused with both issues in one error, the gate's first. `auditShare: -0` counts as 0.
4. Nothing reads these keys from `.visto-ai.yml` (D10; `floors.ts` is not touched).

- [ ] **Step 1: Write the failing tests.**

```ts
test('approval is off unless the config writes it, and a config that writes none gives the settings it gave', () => {
  /* minimal and SERVICE_YAML: 'approval' in repoSettingsFor(c, 'acme/shop') is false; approvalOf gives APPROVAL_OFF; approvalUseOf false;
     parseConfig(example(), exampleEnv): the same */
});
test('the three keys are read for all repositories and for one, and an override replaces only the keys it writes', () => {
  /* defaults { autoApprove: true, auditShare: 0 }, overrides acme/shop { approvalThreads: gate }, acme/off { autoApprove: false }:
     acme/shop { enabled: true, threads: 'gate', auditShare: 0 }; acme/other { enabled: true, threads: 'strict', auditShare: 0 };
     acme/off { enabled: false, threads: 'strict', auditShare: 0 }; approvalUseOf true. Only an override { autoApprove: true, auditShare: 0 }: that repository on, the others with no key */
});
test('automatic approval is refused while the audit share is not written as 0, for the defaults and for one repository', () => {
  /* defaults { autoApprove: true }, and { autoApprove: true, auditShare: 5 }: exactly the defaults issue;
     override acme/shop { autoApprove: true }: exactly 'repositories.overrides.acme/shop.score.auditShare: must be written as 0 ...';
     defaults { autoApprove: true } with an override { inlineNotes: true }: one issue, the defaults';
     { autoApprove: false, auditShare: 5 }, { auditShare: 0 } and { approvalThreads: gate }: accepted; dryRun true changes nothing */
});
test('an approval key of the wrong kind is refused by name, and the issue quotes no value', () => {
  /* approvalThreads: relaxed, autoApprove: yes, auditShare: -1, auditShare: 101, auditShare: five: each issue starts with
     'repositories.defaults.score', none holds 'relaxed', 'yes' or 'five' */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/config/load.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the switch for automatic approval, its thread rule and the audit share, refused until the share is 0`.

---

### Task 2: The record of an approval, and a lane for withdrawals

**Files:**
- Create: `src/db/migrations/0013_approval.sql`, `src/db/approvals.ts`, `src/db/approvals.test.ts`
- Modify: `src/db/review-runs.ts` (`markPublished`), `src/db/jobs.ts` (`JobKind`, `askWithdraw`, `requeueJob`'s last statement, the `Job.reason` comment)
- Test: `src/db/migrate.test.ts`, `src/db/review-runs.test.ts`, `src/db/jobs.test.ts` (new tests only)

**Interfaces:**
- Produces:

```ts
// src/db/jobs.ts
export type JobKind = 'review' | 'gate' | 'withdraw';
/** Stores a withdraw job for the pull request, due at `now`; a pending one takes this time, and the installation when one is given. Its starts are kept. */
export async function askWithdraw(db: Db, ref: PullRequestRef, now: string, installation?: string | null): Promise<number | null>;
// src/db/review-runs.ts
markPublished(db, runId, p: { reviewId: string; publishedAt: string; body: string; inlineDropped: boolean; approved?: boolean; approvalCode?: string | null }): Promise<boolean>;
// src/db/approvals.ts
export interface Standing { run: number; reviewId: string; headSha: string; baseBranch: string | null; failure: string | null }
export async function standingApprovals(db: Db, ref: PullRequestRef): Promise<Standing[]>;                 // lowest run first
export async function hasStandingApproval(db: Db, ref: PullRequestRef, reviewId?: string): Promise<boolean>;
export async function newestApprovalStands(db: Db, ref: PullRequestRef): Promise<boolean>;   // the newest published run is an approval not dismissed
export async function newestWasApproval(db: Db, ref: PullRequestRef): Promise<boolean>;      // it was posted as an approval, dismissed since or not
export async function markDismissed(db: Db, run: number, at: string, by: 'app' | 'git_service'): Promise<boolean>;   // false when already marked
export async function markDismissFailed(db: Db, run: number, code: string): Promise<boolean>;            // true when no failure was recorded before
export async function clearDismissFailure(db: Db, run: number): Promise<boolean>;                         // (as built) true when a failure was cleared
export async function markStoodAtMerge(db: Db, run: number, at: string): Promise<boolean>;                // true the first time; never on a dismissed run
export async function failedDismissal(db: Db, ref: PullRequestRef): Promise<string | null>;               // the newest such run's code
export async function failedDismissals(db: Db): Promise<PullRequestRef[]>;
```

**Rules (8.5, 13; calls 17, 19, 20, 23, 34):**

1. **The migration**, exactly:

```sql
alter table visto_ai.review_runs add column approved boolean not null default false;
alter table visto_ai.review_runs add column approval_code text;
alter table visto_ai.review_runs add column dismissed_at timestamptz;
alter table visto_ai.review_runs add column dismissed_by text;
alter table visto_ai.review_runs add column dismiss_failure text;
alter table visto_ai.review_runs add column stood_at_merge timestamptz;
create index review_runs_standing on visto_ai.review_runs (service, owner, repo, number) where approved and dismissed_at is null;
```

2. **`markPublished`** becomes, with `$6` `p.approved === true` and `$7` the code through `storableOrNull`:

```sql
update visto_ai.review_runs set published = true, review_id = $2, published_at = $3::timestamptz, body = $4, inline_dropped = $5,
       approved = $6, approval_code = $7
where id = $1 and published = false
returning id
```

3. **The statements of `approvals.ts`**, each with `$1` to `$4` the service, the lower-cased owner and repo, and the number where it names a pull request:

```sql
-- standingApprovals
select id as run, review_id, head_sha, base_branch, dismiss_failure from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4
  and published and not dry_run and approved and dismissed_at is null and review_id is not null
order by id;
-- hasStandingApproval ($5: the review id, or null)
select 1 from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4
  and published and not dry_run and approved and dismissed_at is null and ($5::text is null or review_id = $5)
limit 1;
-- newestApprovalStands: rows[0]?.stands === true
select approved and dismissed_at is null as stands from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4 and published and not dry_run
order by id desc limit 1;
-- newestWasApproval: rows[0]?.approved === true
select approved from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4 and published and not dry_run
order by id desc limit 1;
-- markDismissed
update visto_ai.review_runs set dismissed_at = $2::timestamptz, dismissed_by = $3, dismiss_failure = null
where id = $1 and approved and dismissed_at is null
returning id;
-- markDismissFailed
update visto_ai.review_runs r set dismiss_failure = $2
from (select id, dismiss_failure as old from visto_ai.review_runs where id = $1 and approved and dismissed_at is null) b
where r.id = b.id
returning b.old is null as first;
-- clearDismissFailure (as built)
update visto_ai.review_runs set dismiss_failure = null
where id = $1 and approved and dismissed_at is null and dismiss_failure is not null
returning id;
-- markStoodAtMerge
update visto_ai.review_runs set stood_at_merge = $2::timestamptz
where id = $1 and approved and dismissed_at is null and stood_at_merge is null
returning id;
-- failedDismissal
select dismiss_failure from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4
  and published and not dry_run and approved and dismissed_at is null and dismiss_failure is not null
order by id desc limit 1;
-- failedDismissals
select distinct service, owner, repo, number from visto_ai.review_runs
where published and not dry_run and approved and dismissed_at is null and dismiss_failure is not null
order by service, owner, repo, number;
```

4. **`askWithdraw`**, exactly (`$5` now, `$6` the installation or null):

```sql
insert into visto_ai.jobs (service, owner, repo, number, kind, reason, head_sha, status, run_at, starts, created_at, delivery,
                           trigger, requested_by, comment_id, association, installation)
values ($1, $2, $3, $4, 'withdraw', 'withdraw', '', 'pending', $5::timestamptz, 0, $5::timestamptz, null, 'automatic', null, null, null, $6)
on conflict (service, owner, repo, number, kind) where status = 'pending'
do update set run_at = excluded.run_at, installation = coalesce(excluded.installation, visto_ai.jobs.installation)
returning id
```

5. **`requeueJob`'s last statement** hands the starts on for a withdraw job as for a sync: its `where` becomes `where this.kind in ('gate', 'withdraw') and this.trigger = 'automatic' and p.status = 'pending' and p.kind = this.kind and p.trigger = 'automatic' and p.service = this.service and p.owner = this.owner and p.repo = this.repo and p.number = this.number`. Nothing else of it changes; the gate's lane behaves as before.
6. **Nothing reads the new columns in `listRuns`:** `StoredRun` is unchanged, so `listRuns`'s answers are the objects they were.

- [ ] **Step 1: Write the failing tests.**

```ts
// migrate.test.ts
test('0013_approval comes right after 0012_reverts, and applies over the rows of the release before it', async () => {
  /* as the test of 0012: a run inserted on 0012 keeps every column; after: approved false, the five others null; the index review_runs_standing exists */
});
// review-runs.test.ts
test('an approval is recorded with its publication, and a run published without one reads as no approval', async () => {
  /* markPublished with approved true and approvalCode 'approved': the row's approved and approval_code; with neither: false and null; listRuns deep-equals what it gave before */
});
// approvals.test.ts
test('standing approvals are the published live approvals not dismissed, lowest run first', async () => {
  /* five runs: approved published; approved dry; approved unpublished; published comment; approved dismissed: only the first; hasStandingApproval with and without '501', and with '999': true, true, false */
});
test('a dismissal is marked once and clears the failure, and a failure is first only once', async () => {
  /* markDismissFailed twice: true then false; failedDismissal 'github_403'; failedDismissals [REF]; markDismissed 'app': true, then false;
     failedDismissal null; dismissed_by 'app'; markDismissFailed after it: false */
});
test('a merge under a standing approval is marked once, and a dismissed approval is never marked', async () => { /* markStoodAtMerge true, then false; a dismissed approval: false; a comment run: false */ });
test('the newest published run says whether its approval stands, and whether it was one', async () => {
  /* none: false, false; approval then comment: false, false; comment then approval: true, true; the newest approval dismissed: stands false, was true;
     a dry approval is not read */
});
// jobs.test.ts
test('a withdraw job has its own pending slot beside a review job and a gate job, and a second ask moves its time and keeps its starts', async () => {
  /* enqueueJob review, askGate, askWithdraw: three pending rows; askWithdraw again at a later time with installation '98': one withdraw row, run_at the later, installation '98', starts as they were;
     an ask with no installation keeps '98'; dueJobs of 'withdraw' lists it alone */
});
test('a withdraw job put back while another waits hands it its starts, as a sync does', async () => {
  /* claim a withdraw job twice (starts 2), askWithdraw stores a new pending one, requeueJob the running one: 'superseded'; the pending one has starts 2; a gate sync behaves as before */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the record of an approval and of its withdrawal, and a lane for withdrawals`.

---

### Task 3: An approval, the state of the app's reviews, an author's access, and a dismissed review, at the git boundary

**Files:**
- Modify: `src/forge/types.ts`, `src/forge/github/writer.ts`, `src/forge/github/threads.ts`, `src/forge/github/objects.ts` (export `associationOf` and `idOf`), `src/forge/github/events.ts`, `src/shell/capture.ts`
- Test: `src/forge/github/writer.test.ts` (one edit, below, and new tests), `threads.test.ts`, `events.test.ts` (one edit, below, and new tests), `src/shell/capture.test.ts` (new tests)

**Interfaces:**
- Produces:

```ts
// src/forge/types.ts
export type OwnReviewState = 'approved' | 'dismissed' | 'commented' | 'other';
// ReviewDraft gains:    event?: 'approve';                       absent: a comment
// ForgeWriter.listOwnReviews resolves Array<{ id: string; commit: string; state?: OwnReviewState }>
// ThreadComment gains:  association?: Association;               as the git service reports it for the comment; absent: not reported
// ForgeEvent gains:     | { kind: 'review_dismissed'; ref: PullRequestRef; installation: string | null; review: string }
// src/forge/github/objects.ts: export function idOf(v: unknown): string; export const associationOf: (v: unknown) => Association;   both unchanged
```

**Rules (gaps 1, 2, 7; calls 6, 16, 21):**

1. `publishReview` sends `event: 'APPROVE'` when `draft.event === 'approve'`, else `'COMMENT'`; nothing else of the request changes. The interface's comment says "Posts one review, as a comment, or as an approval when the draft says so".
2. `listOwnReviews` sets `state` from the item's `state` when it is a string: `APPROVED` gives `approved`, `DISMISSED` `dismissed`, `COMMENTED` `commented`, any other `other`; when it is not a string there is no key. (as built, the fix wave) The state is upper-cased first, so `approved` in lower case gives `approved` too; `listOwnReviews` and `readReview` read it through one map, `OWN_REVIEW_STATE` with `ownReviewStateOf`, exported by `src/forge/github/objects.ts` beside `reviewOf`. **A change of today's behaviour:** an item of the app's own whose `commit_id` is null is skipped (it cannot be the review of any head), where today it fails the read with `github_bad_response`; a `commit_id` of any other kind that is no string still fails it. What else is listed, and in what order, is unchanged. **Edit of `writer.test.ts`, test `the app's own reviews are listed, newest first: by its own account, with a body`:** its expected value becomes `[{ id: '5', commit: 'head222', state: 'commented' }, { id: '1', commit: 'head111', state: 'commented' }]` (its fixture carries `state: 'COMMENTED'`); nothing else in it changes.
3. The thread query's `COMMENT_FIELDS` gains `authorAssociation`. A comment gets `association` only when the field is a string, mapped by `associationOf` (`OWNER`, `MEMBER`, `COLLABORATOR`; any other string is `none`); else no key.
4. `pull_request_review` with the action `dismissed` gives `{ kind: 'review_dismissed', ref, installation: installationOf(p), review }`, `review` the review's id read by `idOf` and at most `MAX_ID_CHARS`; any other action but `submitted` stays `unknown_action`. **Edit of `events.test.ts`, test `review`:** its second assertion's expected value becomes `{ kind: 'review_dismissed', ref, installation: null, review: '11' }`; nothing else in it changes.
5. `captureOf` answers `{ outcome: 'handled', pullRequest: null, activity: null }` for `review_dismissed`. Every other switch over `ForgeEvent['kind']` the type check finds handles it the same way.

- [ ] **Step 1: Write the failing tests.**

```ts
// writer.test.ts
test('an approval is posted as the event APPROVE, and a draft without an event is a comment as before', async () => {
  /* the draft with event 'approve': body { commit_id, body, event: 'APPROVE', comments }; one request; the same draft without it: 'COMMENT' */
});
test("the app's own reviews carry their state when GitHub gives one", async () => {
  /* states APPROVED, DISMISSED, COMMENTED, PENDING and none: approved, dismissed, commented, other, and no key */
});
test("an own review whose commit is null is not listed, and one whose commit is no string still rejects", async () => {
  /* reviews 5 (commit null) and 1 (head111): only 1; a review with commit_id 7: github_bad_response */
});
// threads.test.ts
test("a comment carries its author's access when GitHub reports it, and none when it does not", async () => {
  /* OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER, NONE, 5, absent: owner, member, collaborator, none, none, none, no key, no key;
     the query sent holds authorAssociation */
});
// events.test.ts
test('a dismissed review names the pull request, the installation and the review', () => {
  /* reviewPayload({}, 'dismissed') with installation { id: 99 }: { kind: 'review_dismissed', ref, installation: '99', review: '11' }; a review with no id: malformed */
});
// capture.test.ts
test('a dismissed review is handled and stores nothing', () => { /* captureOf gives { outcome: 'handled', pullRequest: null, activity: null } */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: an approval, the state of the app's reviews, an author's access in a thread, and a dismissed review, at the git boundary`.

---

### Task 4: The branch's rule, a review's state, a dismissal, and the permission that reads the rule

**Files:**
- Create: `src/forge/github/approvals.ts`, `src/forge/github/approvals.test.ts`
- Modify: `src/forge/types.ts`, `src/forge/github/app-info.ts`, `src/forge/github/app-manifest.json`, `src/forge/github/app-manifest.test.ts` (three edits, below), `src/shell/dry-writer.ts`
- Test: `src/forge/github/app-info.test.ts`, `src/shell/dry-writer.test.ts` (new tests)

**Interfaces:**
- Produces:

```ts
// src/forge/types.ts
export interface ForgeApprovals {
  /** 'dismissed' when an active ruleset's pull request rule, or the branch protection, dismisses an approval when new commits are pushed;
   *  'kept' when both were read and neither does. Rejects with a short code when neither said so and one could not be read. */
  staleApprovals(ref: PullRequestRef, installation: string, branch: string): Promise<'dismissed' | 'kept'>;
  /** One review as the git service holds it now; its commit is null when the service gives none. null when it answers that there is none. Rejects with a short code. */
  readReview(ref: PullRequestRef, installation: string, reviewId: string): Promise<{ state: OwnReviewState; commit: string | null } | null>;
  /** Dismisses one review. Sent once. Rejects with a short code and says nothing about whether it took effect. */
  dismissReview(ref: PullRequestRef, installation: string, reviewId: string, message: string): Promise<void>;
}
// FeatureOff['feature'] gains 'approval'
// AppIdentity.lacks(dryRun: boolean, gate?: GateNeeds, approval?: boolean): Promise<FeatureOff[]>
// src/forge/github/app-info.ts
export function missingFor(info: AppInfo, dryRun: boolean, gate?: GateNeeds, approval?: boolean): FeatureOff[];
// src/forge/github/approvals.ts
export const MAX_RULE_PAGES = 10;
export function createGithubApprovals(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): ForgeApprovals;
// src/shell/dry-writer.ts
export function dryApprovals(): ForgeApprovals;     // every method rejects Error('dry_run')
```

**Rules (10, 20 item 8; calls 4, 9, 18):**

1. **`staleApprovals`.** The branch is sent through `encodeURIComponent`; an empty branch rejects `github_bad_path` before any request; (as built) so do the branches `.` and `..`, and a branch holding a lone surrogate. Reads go through `createGithubHttp` (GET only, a 5xx tried once more).
   - `http.paged(`${repo}/rules/branches/${branch}`, MAX_RULE_PAGES)` (Metadata read): each item must be an object with a string `type`, else `github_bad_response`. An item with `type === 'pull_request'`, an object `parameters` and `parameters.dismiss_stale_reviews_on_push === true` answers `'dismissed'`, and the protection is not read. (as built) Every item is checked first: a list that holds one item of the wrong shape, or that fills its tenth page (`github_too_many_pages`), gives no answer, whatever its other items say (`rule_unreadable` when the protection does not say dismissed either). A failure (`github_<status>`, `github_too_many_pages`, `github_bad_response`, `github_network`) is kept as the first failure.
   - `GET ${repo}/branches/${branch}/protection` (Administration read): 200 with an object whose `required_pull_request_reviews` is an object with `dismiss_stale_reviews === true` answers `'dismissed'`; 200 otherwise, and 404, say no; an answer that is no object is `github_bad_response`; any other status is `github_<status>`.
   - Then: `'kept'` when both were read; else it rejects with the rulesets' failure, or the protection's when the rulesets were read.
2. **`readReview`.** The id must be digits (`github_bad_path`). `GET ${repo}/pulls/${n}/reviews/${id}`: 404 is null; another non-2xx is `github_<status>`; the answer must be an object with a string `state`, else `github_bad_response`; the state is mapped as `listOwnReviews` maps it; `commit` is `commit_id` when it is a string, else null.
3. **`dismissReview`.** `PUT ${repo}/pulls/${n}/reviews/${id}/dismissals` with `{ message, event: 'DISMISS' }`, sent once, `redirect: 'manual'`, the writer's headers and a JSON content type, through a `put` of this file alone (the read client stays GET only). A non-2xx is `github_<status>`; a 2xx whose answer is not an object with `state` `DISMISSED` is `dismiss_not_taken`. No error holds the token.
4. **`missingFor`**: with `approval` true and not in dry run, `need('approval', 'administration', 'read')`, `need('approval', 'pull_requests', 'write')` and `subscribe('approval', 'pull_request_review')`; nothing in dry run, nothing with `approval` absent or false. `createAppInfo`'s `lacks` passes it on.
5. **The manifest** gains `"administration": "read"`, before `metadata`. **Edits of `app-manifest.test.ts`:** in `an app made from the manifest lacks nothing the service needs`, both calls gain a fourth argument `true`; in `the manifest asks for no permission the service does not use`, the sorted list becomes `['administration', 'checks', 'contents', 'issues', 'members', 'pull_requests', 'statuses']` and the call in the loop gains a fourth argument `true`; in `the manifest is private, has an active hook and no address to come back to`, the expected permissions gain `administration: 'read'` before `metadata`. Nothing else changes.

- [ ] **Step 1: Write the failing tests** (fetch stubbed by route).

```ts
// approvals.test.ts
test("a ruleset's pull request rule that dismisses stale reviews says dismissed, and the protection is not read", async () => { /* one GET, of /rules/branches/main?per_page=100&page=1 */ });
test('with no such rule the protection decides: true says dismissed; false, absent and a 404 say kept', async () => {
  /* rules [] or [{ type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: false } }, { type: 'deletion' }]; protection with true; with false; with no required_pull_request_reviews; 404 */
});
test('a form that could not be read is no answer: kept only when both were read, dismissed when either says so', async () => {
  /* rules 403 + protection true: dismissed; rules 403 + protection 404: rejects github_403; rules [] + protection 403: rejects github_403;
     rules 500 twice: rejects github_500 after two tries, when the protection is 404; an item with no type: github_bad_response */
});
test('a branch with a slash is sent encoded, and a rules list that fills its last page is no answer', async () => { /* release/1.0 as release%2F1.0 on both paths; ten full pages: the protection is read, and 404 rejects github_too_many_pages */ });
test('a review is read with its state and commit, and a 404 is null', async () => { /* APPROVED, DISMISSED; 404 null; 500 twice github_500; no state github_bad_response */ });
test('a review whose commit is null is read with its state', async () => { /* commit_id null and absent: { state: 'approved', commit: null } */ });
test('a dismissal is sent once as a PUT with its message, and an answer that is not dismissed rejects', async () => {
  /* method PUT, path /repos/acme/shop/pulls/7/reviews/501/dismissals, body { message, event: 'DISMISS' }, redirect manual;
     422: github_422 after one request; 200 with state APPROVED: dismiss_not_taken */
});
test('an id or an installation that is not digits is refused before any request, and no error holds the token', async () => {});
// app-info.test.ts
test('with approval on and out of dry run the app needs administration read, pull requests write and the review event', () => {
  /* the permissions of the manifest minus administration: [{ feature: 'approval', missing: 'administration:read' }]; in dry run: []; with approval absent: [] */
});
// dry-writer.test.ts
test('in dry run every call of the approvals is refused', async () => {});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the branch's rule on stale approvals, a review's state and a dismissal, with the permission that reads the rule`.

---

### Task 5: Which threads are closed before a review, and the earlier state it is given

**Files:**
- Create: `src/approval/threads.ts`, `src/approval/threads.test.ts`
- Modify: `src/engine/types.ts`, `src/engine/review.ts` (`discussed`), `src/shell/earlier.ts`, `src/shell/review-job.ts` (the call of `earlierOf`)
- Test: `src/shell/earlier.test.ts`, `src/engine/review.test.ts` (new tests only)

**Interfaces:**
- Consumes: `ApprovalThreads`, `approvalOf` (Task 1); `ThreadComment.association` (Task 3).
- Produces:

```ts
// src/approval/threads.ts
export interface ThreadContext { rule: ApprovalThreads; author: string; clearByReply: boolean; published: StoredRun[] }
/** The second half of the thread rule: resolved, and closed without a further verdict. Pure. */
export function closedBefore(thread: ReviewThread, ctx: ThreadContext): boolean;
/** A person other than `author` (compared without letter case), with access, wrote a reply in the thread. */
export function accessReplied(thread: ReviewThread, author: string): boolean;
/** The verdict the newest published run that has one kept on a thread (rule 1); null when none, 'damaged' when that entry cannot be read. */
export function newestVerdict(published: StoredRun[], threadId: string): { verdict: 'fixed' | 'answered' | 'open'; fileChanged: boolean; replies: number | null } | 'damaged' | null;
// src/engine/types.ts
// EarlierThread gains: closedForApproval?: boolean;   closed under the thread rule before this run; absent with approval off
// Discussed gains:     closedForApproval?: boolean;   that thread's, when the finding was dropped
// src/shell/earlier.ts
earlierOf(args: { last; runs; stored; threads; replySettles?: boolean; approval?: { rule: ApprovalThreads; author: string; clearByReply: boolean } }): EarlierState;
```

**Rules (5.2, 6.4, D18, D23; calls 6, 7):**

1. **`newestVerdict`:** of the published runs, newest first, the first run with an entry decides; the entry is the first object in its `threadVerdicts` with this `threadId` and a known word; `fileChanged` is read only when it is a boolean, else false; an entry whose `replies` is present and not a whole number at or above 0 is `'damaged'`: no verdict, and no older run stands in (as the gate's `verdictOf`).
2. **`accessReplied`:** some comment after the first is by a person, whose login is not `author` (without letter case), and whose `association` is `owner`, `member` or `collaborator`.
3. **`closedBefore`, strict:** `thread.resolved && ((thread.resolvedByApp && newest is fixed with fileChanged) || accessReplied(thread, author))`. (as built, commit fc5551c) When the newest verdict is `open`, the reply must be among the comments after the first `1 + replies`; when that entry has no `replies`, or the newest entry is `'damaged'`, no reply counts. After a newest `answered`, or `fixed` with no file change, `accessReplied` reads every reply, as above. **Gate:** `thread.resolved && ((thread.resolvedByApp && newest is fixed or answered) || (clearByReply && a person replied))`.
4. **`earlierOf` with `approval`:** each thread gets `closedForApproval = closedBefore(t, { ...approval, published: the published runs })`, and `settled` becomes today's value `&& closedForApproval`, under both thread rules (call 7). Without `approval` the state is the object it was, with no `closedForApproval` key.
5. **The engine's `discussed()`** copies `closedForApproval` when the thread's is a boolean, and sets no key otherwise.
6. **The review job** passes `approval: { rule: approvalOf(settings).threads, author: live.info.author, clearByReply: settings.gate.clearByReply }` to `earlierOf` when approval is on, and nothing otherwise.

- [ ] **Step 1: Write the failing tests.** A thread is built as the gate's tests build one, first comment the app's on stored comment `8001` (major).

```ts
// threads.test.ts
test('under the strict rule a thread the author replied to and resolved is not closed, and one a member who is not the author replied to is', () => {});
test('a reply by someone without access, or whose access GitHub did not report, closes nothing under the strict rule', () => {
  /* octo-guest 'none'; octo-lead with no association; a bot with 'member'; the author 'Octo-Dev' as 'owner': none closes */
});
test("the app's resolve closes a thread under the strict rule only after a fixed verdict on a changed file, the newest verdict deciding", () => {
  /* fixed+true: closed; fixed+false; answered; an older fixed+true under a newer open; a damaged newest entry: not closed */
});
test('an unresolved thread is never closed before the run, under either rule', () => {});
test('under the gate rule a thread closes before the run as the gate clears it, with clearing by reply on or off', () => {});
// earlier.test.ts
test('with approval on under the strict rule, a thread the author replied to and resolved is not settled, and is due', () => {});
test('under the gate rule for approval with clearing by reply off, a thread a person replied to and resolved is not settled, and is due', () => {
  /* not gated (replySettles true), approval { rule: 'gate', clearByReply: false }: settled false, closedForApproval false */
});
test('with approval off the earlier state is what it was', () => { /* deepEqual of earlierOf with and without approval undefined, no closedForApproval key */ });
test('under the gate rule for approval each thread carries whether it was closed for approval', () => {});
test("with the gate's clearing by reply off and the strict rule, a thread is settled only when both accept it", () => {});
// review.test.ts (engine)
test('a finding dropped as a duplicate keeps whether its thread was closed for approval', () => {
  /* earlier thread with closedForApproval true: the Discussed entry has it; with the key absent: no key */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: which threads are closed for approval before a review, and a thread settled by one side alone is judged again`.

---

### Task 6: Which threads are open once the review is posted

**Files:**
- Modify: `src/approval/threads.ts`, `src/gate/rule.ts` (the severity map moves into an exported `storedSeverities`, used by `evaluateGate` as before)
- Test: `src/approval/threads.test.ts` (new tests only)

**Interfaces:**
- Consumes: `evaluateGate` (`src/gate/rule.ts`); Task 5's `closedBefore`, `newestVerdict`.
- Produces:

```ts
// src/approval/threads.ts
/** How many threads and lost threads are open for approval once `run` is posted as the head's review. Pure; never throws. */
export function openForApproval(args: {
  threads: ReviewThread[]; stored: Array<StoredComment & { run: number }>; runs: StoredRun[]; run: StoredRun;
  rule: ApprovalThreads; author: string; clearByReply: boolean;
}): number;
// src/gate/rule.ts
export function storedSeverities(stored: Array<StoredComment & { run: number }>): Map<string, 'blocker' | 'major' | 'minor' | 'unknown' | 'note'>;
```

**Rules (6.4, D18; calls 26, 27, 33):**

1. **The threads counted:** each listed thread once (by id), the app's own, with its severity from `storedSeverities(stored)` (`unknown` when its first comment has no row; `note` and `minor` are not counted). `storedSeverities` keeps the gate's rank (blocker 4, major 3, unknown 2, minor 1, note 0); no test of `rule.test.ts` changes.
2. **This run's own verdict** is read from `run.result` as `newestVerdict([run], id)` reads one run. A thread this run kept `open` is open, under both rules.
3. **Gate rule:** otherwise a thread is open when it is among `evaluateGate({ threads, stored, runs: [...runs without run.id, { ...run, published: true }], reviewed: { ...run, published: true }, clearByReply }).blocking`.
4. **Strict rule:** otherwise a thread is closed when this run's verdict is `fixed` with `fileChanged` true and every comment after the first `1 + replies` is the app's (`replies` null: none is checked), or when `closedBefore(thread, { rule: 'strict', author, clearByReply, published: runs.filter((r) => r.published && r.id !== run.id) })`; else it is open.
5. **Lost threads, under both rules:** every row of `stored` of severity `blocker` or `major` whose `run` is the id of a run of `runs` that is published and not a dry run, and whose `commentId` is not the id of the first comment of a listed thread whose first comment is the app's, counts once as open (by comment id). (as built) A row whose severity word is unknown counts as a major does (only `minor` and the note are left out), and so does a row whose `run` is not among `runs`.
6. The count is the threads open plus the lost threads.

- [ ] **Step 1: Write the failing tests.**

```ts
test("this review's fixed verdict on a changed file closes a thread under the strict rule, unless someone wrote after it was judged", () => {
  /* replies 1 and a later comment of octo-dev: open; replies absent: closed; fileChanged false: open */
});
test('a thread this review kept open is open for approval under both rules, though a member replied and it is resolved', () => {
  /* resolved, octo-lead 'member' replied, this run's verdict open: 1 under strict, 1 under gate with clearByReply true */
});
test("the app's own thread with no stored finding is open until a person with access who is not the author replied and it is resolved", () => {});
test('notes and minor threads are not counted, and a thread listed twice counts once', () => {});
test("the gate rule counts what the gate would block with this review as the head's review", () => { /* equal to evaluateGate called by hand on four threads with no verdict of this run */ });
test('a stored major whose comment was deleted holds approval back, under both rules', () => {
  /* stored 8001 (major) of a published run, no thread lists it: 1 under strict and 1 under gate; the same row of a dry run, or of a run not published: 0; a stored minor: 0 */
});
test("a thread whose first comment is no longer the app's holds approval back", () => {
  /* a listed thread whose first comment is 8001 with byApp false: 1 under both rules; the same thread with byApp true and closed: 0 */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: which threads are open for approval once the review is posted, a lost thread included`.

---

### Task 7: The decision from what is stored and what the pull request is, and what the review says

**Files:**
- Create: `src/approval/rule.ts`, `src/approval/rule.test.ts`, `src/approval/text.ts`, `src/approval/text.test.ts`
- Modify: `src/engine/render/body.ts` (`Meta.approval`)
- Test: `src/engine/render/body.test.ts` (new tests only)

**Interfaces:**
- Consumes: `head12` (`src/gate/answers.ts`), `isShortCode` (`src/shell/codes.ts`).
- Produces:

```ts
// src/approval/rule.ts
export type ApprovalCode =
  | 'approved' | 'record_unreadable' | 'not_covered' | 'needs_human' | 'blocking_finding' | 'finding_without_thread'
  | 'draft' | 'from_fork' | 'origin_unknown' | 'threads_unreadable' | 'open_thread' | 'rule_unreadable' | 'rule_off' | 'refused';
/** Conditions 2, 3 and 4 as the stored runs tell them; the first that fails, or null. `runs`: every run of the pull request. Pure. */
export function storedRefusal(run: StoredRun, runs: StoredRun[], threshold: number): ApprovalCode | null;
/** Major and blocker findings these runs left without a thread; null when a result cannot be read. Pure. */
export function withoutThread(runs: StoredRun[]): number | null;
/** Conditions 5 (draft) and 7 (fork), in that order; null when both hold. */
export function liveRefusal(info: PullRequestInfo): ApprovalCode | null;
// src/approval/text.ts
export function dismissMessage(head: string): string;
export function approvalParagraph(decided: ApprovalCode, meta: { head: string; threshold: number; rule: ApprovalThreads; code?: string }): string;
// src/engine/render/body.ts
// Meta gains: approval?: string;   a paragraph the service wrote, set after the Overall line; absent: nothing
```

**Rules (6.4 conditions 2 to 5 and 7, 5.6 steps 6 and 7; calls 3, 8, 13):**

1. **`storedRefusal`, in this order.** (a) `run.result` must be an object whose `scores`, `findings` and `unplaced` are lists, `coverage` an object whose `notReviewed` is a list, and `verdict` an object; else `record_unreadable`. (b) `scores` empty, an entry that is not an object with `covered === true`, or `notReviewed` not empty: `not_covered`. (c) `verdict.needsHuman !== false`, `verdict.highest` not a number below `threshold`, or an entry whose `finalScore` is not a number below `threshold`: `needs_human`. (d) An entry of `findings`, `unplaced` or `unchanged` (absent: none; not a list: `record_unreadable`) that is no object with a string `severity`: `record_unreadable`; one of severity `major` or `blocker`: `blocking_finding`. (e) `withoutThread` of the published, non-dry runs other than `run`, and `run`: null is `record_unreadable`, above 0 `finding_without_thread`. Else null.
2. `beyondDiff` is never read (5.6 step 4).
3. **`withoutThread`**, the sum over the runs given of: `unplaced` entries of severity `major` or `blocker`; for a run with `inlineDropped`, its `findings` entries of those severities; `unchanged` entries of those severities; `alreadyDiscussed` entries whose `closedForApproval` is true, or, when it is absent, whose `settled` is true. A result that is not an object, a field present and not a list, an entry that is not an object, a `findings` that is not a list on a run with `inlineDropped`, and a discussed entry with neither flag a boolean: null.
4. **`liveRefusal`:** `info.draft === true` is `draft`; `info.fromFork === true` is `from_fork`; `info.fromFork !== false` is `origin_unknown`.
5. **The texts,** exactly. `H` is `head12(head)`, `T` the threshold, `C` the code shown: `meta.code` when it is a short code, else `internal_error`.

```text
approved:            **Approved automatically** for commit `H`: every file is reviewed, nothing is at or above T%, and no major or blocker finding is open. A new commit withdraws this approval.
every other code:    **Not approved automatically:** <the sentence below>
record_unreadable:      a stored review of this pull request could not be read.
not_covered:            not every file of this pull request is reviewed and scored at this commit.
needs_human:            a part of this change is at or above T%, so a person should review it.
blocking_finding:       this review has a major or blocker finding.
finding_without_thread: a review of this pull request raised a major or blocker finding that no later review can clear: one not placed on the diff, one whose inline comment GitHub refused, one on code unchanged since an earlier review, or one that repeats a thread already closed. It holds approval for as long as the pull request is open.
draft:                  this pull request is a draft.
from_fork:              its branch is in a fork, and a pull request from a fork is never approved automatically.
origin_unknown:         the reviewer could not tell whether its branch is in this repository.
threads_unreadable:     the review threads of this pull request could not be read (`C`).
open_thread, strict:    a major or blocker thread of this reviewer is still open, or its comment is gone. Here a thread counts as closed when a review verified a fix in changed code, or when it is resolved and someone other than the author, with access to the repository, replied in it.
open_thread, gate:      a major or blocker thread of this reviewer is still open, or its comment is gone.
rule_unreadable:        the reviewer could not read whether the base branch dismisses an approval when new commits are pushed (`C`).
rule_off:               the base branch does not dismiss an approval when new commits are pushed. The reviewer approves only where a ruleset or the branch protection of the base branch dismisses stale approvals.
refused:                GitHub refused this review as an approval (`C`), so it was posted as a comment.
dismissMessage(head):   This approval was for commit H. A new commit, a change of the base branch, or a later review of this reviewer that does not approve means it no longer holds.
```

6. **`Meta.approval`:** in `rendered`, the `Overall` part of the tail becomes `${OVERALL_HEADING}\n\n${overallLine(result)}\n\n${meta.approval}` when it is given, and is what it was otherwise; a failed result ignores it. It is not escaped: it is the service's own text.

- [ ] **Step 1: Write the failing tests.** `approvable()` is a result whose two files are covered at 35 and 20, no finding but a minor, threshold 70.

```ts
// rule.test.ts
test('a covered result under the threshold with no blocking finding is refused by nothing stored', () => {});
test('a file not covered, a file not reviewed, or no file at all is not_covered', () => {});
test('a score at or above the threshold in force is needs_human, whatever threshold the run was scored with', () => { /* verdict threshold 80, highest 75, in force 70 */ });
test('a major or a blocker of this review, placed, unplaced or on unchanged code, is blocking_finding; a minor and a finding beyond the diff are not', () => {});
test('a major or blocker left without a thread by any published run holds approval', () => {
  /* an earlier published run with: an unplaced major; inlineDropped with a placed blocker; an unchanged major; a Discussed with closedForApproval true;
     a Discussed with no closedForApproval and settled true: each finding_without_thread. Not: the same in a dry run, in an unpublished run,
     a Discussed with closedForApproval false and settled true, a minor */
});
test('a stored result that cannot be read is record_unreadable, never approvable', () => {
  /* run.result null, 'x', []; scores not a list; unplaced 'x'; an earlier run's alreadyDiscussed [7]; a discussed entry with neither flag; inlineDropped with findings null */
});
test('the first condition that fails is the one given', () => { /* not covered and over the threshold and a blocker: not_covered */ });
test('a draft, a fork and an origin not known are refused in that order', () => { /* draft and fork: draft; fromFork absent: origin_unknown */ });
// text.test.ts
test('each code has its sentence, pinned whole', () => { /* every line of rule 5, for head 'abcdef1234567890', threshold 70, code 'github_403' */ });
test('a code shown is a short code, else internal_error, and the commit is cut to 12 characters', () => {});
test('the texts are ASCII and hold no mention, link, tag or heading', () => {});
// body.test.ts
test('with no approval paragraph the body is what it was', () => {});
test('the approval paragraph stands after the Overall line and survives a cut from the middle', () => { /* a body over 65,536 characters: the paragraph is its last line */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the decision on automatic approval from what is stored and what the pull request is now, and what the review says about it`.

---

### Task 8: A review is posted as an approval, or says why it is not

**Files:**
- Modify: `src/shell/publish.ts`
- Test: `src/shell/publish.test.ts` (new tests only)

**Interfaces:**
- Consumes: Tasks 3, 4, 6 and 7; `missedComments` (`src/shell/earlier.ts`); `fitBody` (`src/engine/render/body.ts`).
- Produces:

```ts
export interface ApprovalContext {
  rule: ApprovalThreads; clearByReply: boolean; threshold: number;
  runs: StoredRun[] | null;                                      // every run of the pull request, this one included; null: could not be read
  stored: Array<StoredComment & { run: number }> | null;         // the app's stored comments; null: could not be read
}
// PublishDeps gains:        approvals?: ForgeApprovals;
// publishRun's args gain:   approval?: ApprovalContext;          present when approval is on for the repository
//                           ownRun?: boolean;                    false: the run was recorded by another job; absent reads as true
// PublishOutcome 'published' gains: approval?: { approved: boolean; code: ApprovalCode | null; dismissed: boolean };
```

**Rules (6.4; calls 3, 13, 14, 16):**

1. **Adoption,** with or without `approval`: a review adopted at step 2 whose listed `state` is `approved` or `dismissed` gives `approval: { approved: true, code: null, dismissed: state === 'dismissed' }`; any other state, or none, no key.
2. **Without `args.approval`** nothing else changes but rule 5's fallback of a run another job recorded: the same reads, the same drafts with no `event`, the same outcomes.
3. **The decision,** after the head check, the adoption and the hold, each step only when the one before gave nothing: `runs` or `stored` null is `record_unreadable`; `storedRefusal(args.run, runs, threshold)`; `liveRefusal(live.info)`; the threads (`listThreads`: a rejection is `threads_unreadable` with its code, an answer that is no list `threads_unreadable` with `internal_error`), the stored comments completed by `missedComments` (one that throws leaves them as read), and `openForApproval({ ..., author: live.info.author })` above 0 is `open_thread`; the rule (`deps.approvals` absent is `rule_unreadable` with `internal_error`; `'kept'` is `rule_off`; a rejection `rule_unreadable` with its code); else `approved`.
4. **The body** with the paragraph `p = approvalParagraph(decision, { head: run.headSha, threshold, rule, code })`. A run this job recorded (`ownRun` not false): `renderReview(run.result, { trigger, requestedBy, lineUrl, inline: true, commentUrl, approval: p }).body`; when that render throws, `fitBody(run.body, p)`, and the decision stands. A run another job recorded (`ownRun` false): `fitBody(run.body, p)`, never rendered with this job's trigger or requester.
5. **The body-only fallback** renders with `inline: false` and, with approval on, the paragraph; for a run another job recorded it renders with `{ trigger: run.trigger, requestedBy: null }`, with approval on or off (call 16).
6. **The post.** `approved`: `event: 'approve'` with every recorded comment. On `review_rejected` the decision becomes `refused` with `review_rejected`, the paragraph is made again, and the chain of today runs as comments: every comment, then without notes, then body only. Any other failure of the approval's post is `failed` with its code. Every other decision posts as a comment through today's chain.
7. **The outcome:** `approval: { approved: decision === 'approved', code: decision, dismissed: false }`.
8. **The order of calls with approval on:** `readPullRequest`, `listOwnReviews`, then, as needed, `listThreads`, `staleApprovals`, `publishReview`. A held review reads nothing more. Nothing is written to the database.

- [ ] **Step 1: Write the failing tests** (the harness of the file, with an `approvals` fake that records its calls).

```ts
test('with approval off the reads and the post are what they were', async () => { /* the calls list and the draft of a test above, deep-equal; no event; no approval key */ });
test('an approvable review is posted as an approval that ends with the approved paragraph, after the threads and the rule were read', async () => {});
test('each refusal posts a comment that ends with its paragraph, and reads no further than it needed', async () => {
  /* not_covered: no listThreads, no staleApprovals; draft: no listThreads; from_fork; open_thread: no staleApprovals; kept: rule_off; github_403: rule_unreadable with it */
});
test('a thread list that cannot be read is threads_unreadable, never no thread', async () => { /* rejects github_502; answers {} */ });
test('a stored finding whose thread is gone is open_thread, and the rule is not read', async () => {});
test('runs or comments that could not be read are record_unreadable, and the review is still posted', async () => {});
test('an approval GitHub refuses is posted once more as a comment with the refused paragraph, and then as today', async () => {
  /* 422 then ok: two posts, APPROVE then COMMENT with the same comments, code refused; 422, 422, then body only: three posts, the last with no comment */
});
test('an approval that fails for another reason is a failure, as a comment is', async () => { /* github_502: { kind: 'failed', code: 'github_502' }, one post */ });
test('an adopted review keeps what GitHub holds: an approval, a dismissed one, or a comment', async () => { /* with approval on and off */ });
test('a held review is neither decided nor read further', async () => {});
test('when the body cannot be rendered again the recorded body is posted with the paragraph decided now', async () => { /* lineUrl throws: body = fitBody(run.body, approved paragraph), event approve */ });
test("the prefix never names the current job's requester for a run they did not ask for", async () => {
  /* a manual run recorded with 'requested by @octo-lead', ownRun false, requestedBy 'octo-dev': the posted body is the recorded one with the paragraph, no '@octo-dev';
     GitHub refuses inline: the body-only form holds no '@octo-dev', with approval on and off */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a review is posted as an approval when every condition holds, and says why when it is not`.

---

### Task 9: The review job records an approval and asks for the withdrawal of any that no longer holds

**Files:**
- Modify: `src/shell/review-job.ts`
- Test: `src/shell/review-job.test.ts` (new tests only; a test sets `h.deps.approvals` and `h.deps.onWithdraw` on the harness's deps)

**Interfaces:**
- Consumes: Tasks 1, 2, 5 and 8.
- Produces: `ReviewJobDeps` gains `approvals?: ForgeApprovals` and `onWithdraw?: () => void` (called after a withdraw job was stored).

**Rules (6.4, 8.5; calls 10, 11, 12, 16, 24):**

1. **Before `publishRun`,** when approval is on (settings read then): `runs = listRuns(db, ref)` and `stored = listComments(db, ref)`, each null when its read rejects, and `approval: { rule: approvalOf(settings).threads, clearByReply: settings.gate.clearByReply, threshold: settings.scoreThreshold, runs, stored }`; `deps.approvals` goes into `publishRun`'s deps; `ownRun` is `resumed === null || resumed.job === null || resumed.job === job.id` (a row recorded with no job, by an older release, is read as this job's).
2. **On `published`,** in the one transaction that marks it: `markPublished` with `approved: out.approval?.approved === true` and `approvalCode: out.approval?.code ?? null`; `markDismissed(tx, id, now, 'git_service')` when `out.approval?.dismissed`; `finishJob`; then `askWithdraw(tx, ref, now, installation)` when `hasStandingApproval(tx, ref)`. After the commit, `deps.onWithdraw?.()` when one was stored.
3. **An adoption of prepare** (a review at another commit): `markPublished` with `approved` true when the listed state is `approved` or `dismissed`; then `markDismissed(..., 'git_service')` when `dismissed`, else, when approved, `askWithdraw`. Each a statement of its own, as the adoption is today.
4. **A push that tells nothing new,** with approval on and `newestWasApproval(db, ref)` true, is not ended as `nothing_new`: it is recorded, its scores kept as any recorded run's are, and published as any review. When that read rejects, the review is recorded and published the same way, and `publishRun` is given the approval context with `runs: null`, so its decision is `record_unreadable` and the job ends `published`, as after a failed read of rule 1.
5. **The `review` line** gains `approved` and `approval` (the code, or null for an adoption) only when the publication's outcome has `approval`.
6. Nothing of this runs in dry run.

- [ ] **Step 1: Write the failing tests.**

```ts
test('with approval off the job records, posts and logs what it did', async () => { /* no event in the draft; approved false, approval_code null; no withdraw job; the review line has neither key */ });
test('an approval is recorded with its code, and a withdraw job is stored with it', async () => {
  /* approval on, the fake rule 'dismissed', no thread: the draft's event approve; approved true, approval_code 'approved'; one pending withdraw job; onWithdraw called once; the line approved true */
});
test('a review that does not approve, on a pull request with a standing approval, stores a withdraw job; one with none stores nothing', async () => {});
test('an adopted approval is recorded as one, and a dismissed one as dismissed by the git service', async () => {});
test('a later start that adopts an approval at another commit records it and asks for its withdrawal', async () => {});
test('with approval on, a push that tells nothing new after an approval is published and decided; after a comment it ends nothing_new as before', async () => {
  /* the approval of h1 dismissed before the push's review: still published */
});
test('a read of the newest approval that fails before a nothing-new push posts the review as a comment with record_unreadable', async () => { /* failQuery on newestWasApproval's statement; outcome published, approval_code record_unreadable */ });
test('runs that cannot be read before the post give record_unreadable, and the review is still posted', async () => { /* failQuery on the listRuns statement, second call */ });
test('a resumed review is decided at its post like a first one, and one another job recorded is posted with its own text', async () => {});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the review job records an approval and asks for the withdrawal of any that no longer holds`.

---

### Task 10: The withdrawal job

**Files:**
- Create: `src/approval/withdraw.ts`, `src/approval/withdraw.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 7; `askGate`, `askWithdraw`, `finishJob`, `requeueJob` (`src/db/jobs.ts`); `getPullRequest`; `gatingOf`; `MAX_STARTS`; `codeOf`; `Alert`.
- Produces:

```ts
export const WITHDRAW_RETRY_WAITS_MS = [10_000, 60_000];
export interface WithdrawJobDeps {
  db: Db; forge: ForgeAccess; approvals: ForgeApprovals;
  clock: () => Date; log: (entry: Record<string, unknown>) => void; alert: Alert;
  settingsFor: (fullName: string) => RepoSettings;
  dryRun: boolean;
  onQueued: () => void;          // after a gate job was asked for
}
/** Takes one claimed withdraw job to its end. Never rejects. */
export async function runWithdrawJob(job: Job, deps: WithdrawJobDeps): Promise<void>;
/** Asks for a withdraw job for each pull request stored as open with a standing approval whose withdrawal failed. Returns how many. */
export async function sweepWithdraw(db: Db, now: string): Promise<number>;
```

**Rules (6.4 Withdrawal, 14; calls 10, 11, 18, 19, 20, 22, 24, 34):**

1. In dry run: finished `dropped`, `dry_run`. No standing approval: `done`, `none`. No installation (the job's, else the stored pull request's): `dropped`, `no_installation`.
2. The live pull request: a rejection is a failure of the job with its code (rule 5); null is `done`, `not_found`; closed and not merged is `done`, `closed`; nothing is recorded in these two cases.
3. **Open.** The targets are the standing approvals whose head is not the live head or whose base branch is not the live one, or every standing approval when `newestApprovalStands` is false. For each target, in order: `readReview`; null is a failure `review_not_found`; `approved`: `dismissReview(ref, installation, reviewId, dismissMessage(headSha))`, then `markDismissed(..., 'app')`; a dismissal that rejects is read again, and `dismissed` then is `markDismissed(..., 'git_service')`, anything else the dismissal's code as a failure; `dismissed` or `commented`: `markDismissed(..., 'git_service')`; `other`: a failure `review_state_other`; a read that rejects is a failure with its code. The commit of the answer is never read. No target: `done`, `kept`. (as built, commit 7c16d3f) Every standing approval with a recorded failure that is not a target is read as well: `dismissed` or `commented` is `markDismissed(..., 'git_service')`; `approved` is `clearDismissFailure` (the approval holds), and when it answers true the gate is asked as after a dismissal (rule 6); null is a failure `review_not_found`, `other` a failure `review_state_other`, and a read that rejects a failure with its code (the failure stays recorded, and no new alert is raised unless rule 5 records one for the first time). It is never dismissed by this path. No target and no such approval: `done`, `kept`; a job that only re-checked ends `done`, `done`. (as built, the fix after Task 13's review) Every other standing approval, neither a target nor with a recorded failure, is read too, before the targets: `dismissed` or `commented` is `markDismissed(..., 'git_service')`, and the gate is asked after it as in rule 6; `approved` changes nothing; a read that rejects, answers null or answers `other` changes nothing and is no failure (nothing is recorded on it, and the job is not put back for it); a record of it that rejects is a failure with its code, as any record's. With no target, no recorded failure read and no such approval recorded dismissed by this job, the job ends `done`, `kept`; the log line's counts follow what was recorded.
4. **Merged.** The targets are the standing approvals whose head is not the merged head. (as built, the fix wave) They are computed as in rule 3: whose head is not the merged head or whose base branch is not the merged pull request's, or every standing approval when `newestApprovalStands` is false (call 20). For each: `readReview`; `approved`: `markStoodAtMerge`, and when it answers true `alert('stale_approval_merged', { repo, number })`; `dismissed` or `commented`: `markDismissed(..., 'git_service')`; `other`: a failure `review_state_other`; null: nothing; a rejection: a failure.
5. **Failures.** With any failure and `job.starts < MAX_STARTS`, the job is put back after `WITHDRAW_RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]` (`requeueJob`, no start given back). At the third start it is finished `done`, `failed`, and: on an open pull request each target still standing gets `markDismissFailed(run, code)`; when the live pull request was not read at this start, every standing approval gets `markDismissFailed(run, the read's code)`; on a merged one nothing is recorded. When any of these answered true, `alert('dismissal_failed', { reason: the first code, repo, number })`, once for the give-up. (as built, commit 7c16d3f) The marks are written before the job is finished, so a stop between the two leaves the job to run again; a mark the database refuses counts as one answered true, and so does a read of the standing approvals that rejects: `dismissal_failed` is raised and the gate asked.
6. **The gate.** After any `markDismissed`, or a `markDismissFailed` that answered true, when the repository's gate is enabled and the pull request is gated by its live base branch, or by its stored one when the live read failed, `askGate(db, ref, now, undefined, { installation })` and `onQueued()`.
7. **One line per job:** `{ event: 'withdraw', job, repo, number, state, standing, targets, dismissed, by_git_service, failed, code, outcome, requeued }`, with the live state or null, counts, and the first failure's code or null.
8. **`sweepWithdraw`** reads `failedDismissals(db)`, then `getPullRequest` for each, and asks `askWithdraw` (no installation) only for one stored as `open`; a closed or merged one is left with its failure recorded. With no failed withdrawal it reads nothing of `pull_requests`.
9. Each step is caught; a logger or an alert that throws changes nothing.

- [ ] **Step 1: Write the failing tests** (`testDb()`, approvals and access fakes, standing approvals written with `recordRun` and `markPublished`).

```ts
test('in dry run, and with no standing approval, nothing is read', async () => {});
test('an approval at another head than the live one is dismissed and recorded as dismissed by the app', async () => {
  /* standing 501 at h1, live h2: readReview, dismissReview('501', dismissMessage('h1')); dismissed_by 'app'; outcome done */
});
test('one GitHub already dismissed is recorded as dismissed by the git service, and no dismissal is sent', async () => {});
test('a dismissal refused while GitHub dismissed it meanwhile is no failure', async () => { /* dismiss rejects github_403, the second read dismissed */ });
test('an approval at the live head and base stays; one at another base branch is dismissed', async () => {});
test('a later review that does not approve withdraws the approval of the same head', async () => {});
test('a closed pull request, and one GitHub does not find, are left as they are', async () => {});
test('a review GitHub does not find is a failure, not a dismissal', async () => {});
test('a review in a state that is neither approved, commented nor dismissed is a failure', async () => { /* other: review_state_other, open and merged */ });
test('a dismissal that fails is tried again after 10 and 60 seconds, then recorded, alerted once and asked of the gate', async () => {
  /* starts 1 and 2: put back at +10 s and +60 s; start 3: dismiss_failure github_403, one alert dismissal_failed { reason: 'github_403', repo: 'acme/shop', number: 7 },
     a pending gate sync when the gate is on for main, none when it is off; a second give-up raises no second alert */
});
test("a pull request whose live read fails three times records the read's code on each standing approval and alerts once", async () => {
  /* two standing approvals, readPullRequest rejects github_502 at each start: both rows github_502, one alert */
});
test('a dismissal that succeeds after a recorded failure clears it and asks the gate again', async () => {});
test('the same job run twice dismisses once', async () => {});
test('at a merge, an approval of another head that still stands is recorded and alerted once; one dismissed is recorded as such; one at the merged head is left', async () => {});
test('the sweep asks for each open pull request with a failed withdrawal, and leaves a closed or merged one recorded as it is', async () => {});
test('the log line holds ids, counts and codes only', async () => { /* no 'octo-', 'h1', 'main', the message */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the withdrawal of an approval that no longer holds, and the record of a merge under one`.

---

### Task 11: A push, a retarget, a reopening, a merge and a dismissal ask for the withdrawal, in a lane of its own

**Files:**
- Modify: `src/shell/receive.ts`, `src/service.ts`, `src/main.ts`
- Test: `src/shell/receive-jobs.test.ts`, `src/service.test.ts` (new tests only)

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 9 and 10; `approvalUseOf` (Task 1).
- Produces: `ServiceDeps` gains `approvals?: ForgeApprovals`; `export const WITHDRAW_CONCURRENCY = 2;` (`src/service.ts`); (as built) `export function approvalsFor(dryRun: boolean, approvals: ForgeApprovals | undefined): ForgeApprovals;` (`src/service.ts`: `dryApprovals()` in dry run or when none was given, else the ones given).

**Rules (8.1, 8.2, 14, D14; calls 5, 17, 21, 22):**

1. **Receiving,** in the delivery's transaction and not in dry run: a `pull_request` event whose action is `synchronize`, `retargeted` or `reopened`, or `closed` with the facts' state `merged`, asks `askWithdraw(tx, facts.ref, now, facts.installation)` when `hasStandingApproval(tx, facts.ref)`, whatever the trigger decided; a `review_dismissed` event asks it when `hasStandingApproval(tx, ref, review)`. `Queued` gains `withdraw: boolean`; such a delivery wakes the runners; its `accepted` line gains `withdraw: true` only then.
2. **The runner:** `createRunner({ db, kind: 'withdraw', concurrency: WITHDRAW_CONCURRENCY, clock, log, mayStart: async () => true, run: (job) => runWithdrawJob(job, withdrawDeps), onLeft: async (_job, how) => { if (how !== 'ended') alert('dismissal_failed', { reason: how }); } })`; `withdrawDeps` carry `approvals: config.dryRun ? dryApprovals() : deps.approvals ?? dryApprovals()`, `alert`, `settingsFor`, `dryRun` and `onQueued: tickBoth`. The timer, `tickBoth`, the drain at stop and the `drain_timeout` count take it in. (as built, commit 03364b7) `onLeft` does more: when the runner drops a withdraw job as `too_old` or `attempts_exhausted`, the reason is recorded with `markDismissFailed` on every standing approval of the pull request (each step caught), `dismissal_failed` is raised once with `reason`, `repo` and `number`, and, not in dry run, when the repository's gate is enabled, `askGate` is called with the job's installation and the gate runner ticked. (as built, the fix wave) `dismissal_failed` is raised only when a mark answered true or was refused, or the standing approvals could not be read; and, not in dry run, a job dropped as `too_old` is asked for again with `askWithdraw(db, job.ref, now, job.installation)` and the withdraw runner ticked; one dropped as `attempts_exhausted` is not. The service's choice of the approvals adapter, for the review job and the withdraw job alike, is `approvalsFor(config.dryRun, deps.approvals)`.
3. **The review job** is given `approvals` as the runner is, and `onWithdraw: () => { void withdrawRunner.tick(); }`.
4. **At start,** out of dry run, after the gate's sweep and before listening: `sweepWithdraw`; the line `{ event: 'withdraw_sweep', asked }` only when `asked > 0`.
5. **What the app lacks** is asked with `approvalUseOf(config)` as the third argument.
6. **`main.ts`** passes `approvals: createGithubApprovals({ auth, fetch: github })`.

- [ ] **Step 1: Write the failing tests.**

```ts
// receive-jobs.test.ts
test("a push, a retarget, a reopening and a merge of a pull request with a standing approval store a withdraw job in the delivery's transaction, whatever the filters say", async () => {
  /* a draft, an ignored author, a gated base, a filtered base: each one pending withdraw job carrying installation '99'; the line withdraw: true */
});
test('with no standing approval, or in dry run, a push stores nothing more and its line is what it was', async () => {});
test("a dismissed review of the app's own standing approval stores a withdraw job; another review's stores nothing", async () => {});
// service.test.ts
test('a push on an approved pull request withdraws its approval in its own lane', async () => { /* the approvals fake records readReview then dismissReview; the run's dismissed_by 'app' */ });
test('at start a standing approval whose withdrawal failed is asked for again on an open pull request, and nothing is logged when none is', async () => {});
test('the app is asked what it lacks for approval when a repository has it on', async () => {});
test('stop drains the withdraw runner too', async () => {});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a push, a retarget, a reopening, a merge and a dismissal ask for the withdrawal, in a lane of its own`.

---

### Task 12: The gate's check fails while an approval the service could not dismiss stands

**Files:**
- Modify: `src/gate/check.ts`, `src/gate/job.ts`, `src/db/gate.ts` (`GateState`)
- Test: `src/gate/check.test.ts`, `src/gate/job.test.ts` (new tests only)

**Interfaces:**
- Consumes: `failedDismissal` (Task 2).
- Produces:

```ts
// CheckPlan gains:   | { state: 'unwithdrawn'; code: string }
// CheckFacts gains:  unwithdrawn?: string | null;     the code of a standing approval's recorded withdrawal failure; absent or null: none
// GateState gains 'unwithdrawn'
```

**Rules (6.4, 9; call 19):**

1. `planBefore`: after bypass and before the skip, `facts.unwithdrawn` given and not null is `{ state: 'unwithdrawn', code }`. (as built) A recorded code that is no short code is `internal_error`, and the check still fails.
2. `planNow` reads `failedDismissal(db, ref)` beside the skip, before the jobs, and passes it. (as built) A read of it that rejects rejects the evaluation, as a failed read of the skip does: retried, then `gate_check_failed`.
3. `checkText`, exactly, `C` the code shown as a short code: status `completed`, conclusion `failure`, title `Earlier approval not withdrawn (C)`, summary the two paragraphs:

```text
This reviewer approved an earlier commit of this pull request, or gave an approval it no longer stands behind, and could not dismiss it (`C`). While it stands it may count toward the approvals this branch requires, so this check fails.
Dismiss that approval on the pull request's page. The service also tries again at the next commit, the next review of this pull request and its next start, and this check is decided again once the approval is gone.
```

   No skip line: a skip does not pass it.
4. `codeOfPlan` gives its code; `countsOf` gives `NO_COUNTS`; the job ends `synced`, not retried.

- [ ] **Step 1: Write the failing tests.**

```ts
// check.test.ts
test('a recorded failure to withdraw fails the check, outranks a skip and a review, and gives way to bypass', () => {});
test('the text of a failed withdrawal is pinned and has no skip line', () => {});
// job.test.ts
test('a gate job on a pull request whose approval could not be dismissed writes the failing check and records it', async () => {});
test('with no failed withdrawal the evaluation is what it was', async () => {});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the gate's check fails while an approval the service could not dismiss stands`.

---

### Task 13: The documents, the real run, and the checks against GitHub

**Files:**
- Modify: `README.md`, `config.example.yml`, `env.example`, `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built
- Create: `docs/superpowers/plans/2026-11-24-automatic-approval-notes.md`
- Test: `src/config/load.test.ts` (one new test)

**Rules:**

1. **README.** Each sentence states only what the code does, and names its cost where it has one.
   - `## Status`: the row `Automatic approval` becomes `Automatic approval and its withdrawal (off unless switched on; refused while the audit share is not 0)`, built, with what was tried (rule 6); a row `Audit sample`, planned. The paragraph's "It never approves one" says when it does. The feature list's line on approval says the same.
   - A new section `### Automatic approval (optional)` after the merge gate's. What an operator must know: the three keys and the refusal; the eight conditions as call 3's table reads them, a lost thread included, and the order in which the paragraph names the first that fails; the two thread rules, with access as GitHub reports it, the intersection of call 7 and the stricter cases of calls 26, 27 and 33, and what they cost; condition 8's two reads, their fields and their permissions (call 9), and how to switch the rule on in a ruleset or the branch protection; that the setup should require an approving review (6.3), and that code owners are not read; the paragraph and its texts; a refused approval; the withdrawal: when it is asked for, the lane, the read first, the message, the retries, `dismissal_failed`, the failing check and how it ends, a later review of the same head, a draft, a merge under a stale approval and `stale_approval_merged`; `nothing_new` after an approval; resumed and adopted reviews; the permission and the event; what it costs (calls 3, 10, 12); the statements, exactly:

```sql
-- approvals of the app's own that are not known as dismissed
select id, number, head_sha, review_id, approval_code, dismiss_failure, stood_at_merge from visto_ai.review_runs
where owner = 'acme' and repo = 'shop' and approved and dismissed_at is null order by id desc;
-- why the reviews of a pull request did or did not approve
select id, head_sha, published_at, approved, approval_code, dismissed_at, dismissed_by from visto_ai.review_runs
where owner = 'acme' and repo = 'shop' and number = 7 and published order by id;
```

   - The migration `0013_approval`, and that a previous release cannot be put back.
   - `### Creating the app` and "What the app needs": `administration` read, and what it is for. The alert lists gain `dismissal_failed` and `stale_approval_merged`. `## Repository layout`: `src/approval/`.
2. **`config.example.yml`.** Above `    # score:`, after the comment on inline notes, these lines; and after `    #   inlineNotes: false`, `    #   autoApprove: false`, `    #   approvalThreads: strict`, `    #   auditShare: 0`:

```yaml
    # autoApprove posts a review as an approval when every file is reviewed, nothing is at or above the threshold, no major or blocker
    # finding is open, the pull request is no draft and not from a fork, and the base branch dismisses stale approvals (a ruleset's
    # pull request rule, or branch protection). The app then needs Administration read. It is false when not written.
    # approvalThreads: strict, a thread closes for approval when a review verified a fix in changed code, or when someone other than the
    # author, with access, replied and it is resolved; gate, as the merge gate's rule clears it. It is strict when not written.
    # auditShare must be written as 0 while autoApprove is true: this release does not draw the audit sample yet.
```

   The alert list gains the two codes. **Test:** `the example with its score block switched on reads approval as written: off, strict, share 0`.
3. **`env.example`:** the alert list gains the two codes.
4. **The design is amended,** in the same commit, one sentence for each place this plan reads the design narrowly, adds to it or departs from it:

| Section | Where | The sentence | Call |
|---|---|---|---|
| 5.2 | "Where automatic approval is on under the strict rule, it is the second half of that rule (section 6.4)." | It becomes: Where automatic approval is on, a thread is settled only when the second half of its thread rule (section 6.4) accepts it too. | 7 |
| 6.4 | after condition 8 | The rule is read when the review is about to be posted, from the active rulesets that apply to the base branch (readable with Metadata read) and from its branch protection (Administration read): either one that dismisses stale approvals is enough. | 9 |
| 6.4 | after "Otherwise the review is a comment, as in the predecessor." | Where automatic approval is on, the review ends with one paragraph that says it approved, or which condition first did not hold. A review GitHub refuses as an approval is posted as a comment and says so. | 13, 14 |
| 6.4 | the strict rule, after "and a stranger's reply closes nothing." | A thread the newest review kept open, and a finding whose comment is gone from its thread, are open under either rule. | 26, 27, 33 |
| 6.4 | Withdrawal, "the app dismisses its own approval at once, before the new review is queued" | It becomes: the app stores a withdrawal with the pull request's facts, in the transaction that queues the new review, and runs it at once; a dismissal that fails is tried again after 10 and 60 seconds. | 5 |
| 6.4 | Withdrawal, after "...and approves again when every condition above holds." | A reopening withdraws as a new commit does. A later review of the same head that does not approve withdraws the bot's earlier approval of it too. A conversion to draft withdraws nothing. | 5, 11, 15 |
| 6.4 | "If the dismissal fails the app raises an alert, and where the gate is on it fails the check." | It becomes: If the dismissal still fails after about 70 seconds the app raises an alert and, where the gate is on, fails the check of the pull request's head for as long as that approval stands; a skip does not pass it. | 19 |
| 6.5 | the audit sample's bullet, at its end | It is built in the plan after automatic approval; until then automatic approval is refused unless the share is 0. | 1 |
| 8.1 | the rows "Pull request new commits" and "Pull request retargeted to another base branch" | Each "Withdraw any approval" becomes: Store a withdrawal of any approval, run at once (section 6.4). | 5 |
| 8.1 | the row "Pull request opened, reopened, ready for review" | It gains: on a reopening, store a withdrawal of any approval as for new commits. | 5 |
| 8.1 | the row "Pull request closed" | It becomes: Derive learning records. When it is merged, check that no approval of the bot's at another head still stood. | 20 |
| 8.1 | a new row after "Pull request retargeted to another base branch" | Review dismissed: when it is an approval of the app's own, record it. | 21 |
| 10 | the row "Branch rules (the exact permission is to be verified, section 20)" | It becomes: Administration, Read (optional), reading the branch protection, whether the base branch dismisses stale approvals; rulesets are read with Metadata. Needed only for automatic approval. | 4, 9 |
| 13 | `review_runs`, after "whether approved and when dismissed" | , by whom, why a withdrawal failed, whether it stood at a merge of another head, and why the review did or did not approve | 23 |
| 14 | "a dismissal fails;" and the next item | They become: a dismissal fails (`dismissal_failed`); a pull request is merged while a stale approval of the bot's still stood (`stale_approval_merged`, section 6.4); | 24 |
| 18 | stage 8, "and the evals with lessons as of each case, which is next." | It becomes: and the evals with lessons as of each case, which wait for a deployment: a history file holds no finding of this reviewer, so the lessons an eval needs can only be made from a deployment's own database. | 31 |
| 18 | item 9 | It gains: Cut in two plans: approval, its record and its withdrawal, which is built, and the audit sample, which is next. | 1 |
| 20 | item 8 | It becomes: Settled by GitHub's permissions page: the rules of a branch are read with Metadata read, its protection with Administration read, and the fields of call 9 say whether stale approvals are dismissed. Then what rule 6 read on the scratch repository; not settled: the answers on a branch whose rules dismiss, a protection rule written as a pattern, and the other items of the plan's "To verify". | 9, 28 |

5. **A real run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before.
   - **The previous release first,** on an empty database, given a sample pull request and stopped. This branch starts on that database with no approval key: the ledger gains `0013_approval`; the six columns are there, `approved` false and the others null in every row; the service listens; a push delivered stores no withdraw job; the previous release, started again, refuses to start.
   - **The refusal:** a config with `autoApprove: true` and no `auditShare` stops the start with the issue of Task 1, rule 3, and prints no value.
   - **A withdrawal with GitHub out of reach:** with `autoApprove: true` and `auditShare: 0`, a published approval written by statements, then a push delivered: one withdraw job in the delivery's transaction; put back twice, given up at its third start; `dismiss_failure` recorded with the read's code; one `dismissal_failed` alert; a second start's `withdraw_sweep` asks for it again; with the stored pull request closed by a statement, a third start asks for nothing.
   - **The statements of Task 2 on a real Postgres:** each answers as its tests say; three pending jobs of one pull request, one of each kind.
   - **Throughout,** every log line is one JSON object, with no login, branch, path or message. Everything the run made is removed.
6. **Checks against GitHub,** made by the controller on the private scratch repository of the earlier trials, whose app the owner has given `administration: read`, with events built from what GitHub answers and posted by hand, under the standing go-ahead; the reviews it pays for are a few small ones.
   - `GET /app` names `administration` with `read`.
   - Both reads of call 9 on the repository's base branch and on a branch `release/1.0` made for the check, through the adapter and by hand: their statuses and the shape of their answers, written in the notes (whether the protection read answers 404 or 403 on a branch with no protection, and how the slash is taken); what `staleApprovals` answers there.
   - With `autoApprove: true` and `auditShare: 0` for that repository, one review through the service: a comment whose last paragraph is the one for `rule_unreadable` or `rule_off`, and `approval_code` holds it.
   - Through the adapters, by a probe and not the service: an approval posted on a scratch pull request (`event: 'approve'`), `listOwnReviews` and `readReview` say `approved`; `dismissReview` takes it, `readReview` says `dismissed`; a second `dismissReview` on it, and its answer, written in the notes; the same approval recorded by statement as a standing one and a push built by hand: the withdraw job records it dismissed by the git service.
   - A merge under a standing approval: a probe's approval at one head, recorded by statement, a push not delivered, the merge, then its delivery: `stood_at_merge` and one `stale_approval_merged`.
   - A thread with a reply by the owner's account: the association `listThreads` reads, and whether the owner's membership is public, written in the notes.
   - A fork, only when the owner's account can make one of the scratch repository: `fromFork` true and the `from_fork` paragraph; else it stays unverified.
   - If an answer differs from Task 4's rules, the rules and their tests are corrected before the merge.
7. **The notes file,** in the form of the plans before: the status, the decisions taken while building, what the reviews found, what the run under Docker and the checks showed, what is for the owner, what is known and left, and what is not verified.

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 3: Commit** `docs: automatic approval in the README, the config example, the design, and the plan as built`.

---

## To verify

None of these is shown by a test of this plan. Each names the check of Task 13, rule 6, that can show it on the scratch repository, or "For the owner" when it needs a branch whose rules dismiss, or GitHub's own deliveries.

1. **An app's approval counts toward a repository's required approvals** (20, item 1). For the owner.
2. **An app can dismiss its own approval on a protected branch** (20, item 2). For the owner. Where it cannot, GitHub's own rule has dismissed the approval on a push, and the read first finds it (call 18); a later review of the same head that does not approve then cannot withdraw it (call 11).
3. **What the protection read answers on a branch with no protection,** 404 as GitHub documents it or 403 on a private repository whose plan holds none. Rule 6, the reads on `main` and `release/1.0`; on a repository that can hold protection, for the owner.
4. **Whether a protection rule written as a pattern** (`release/*`) comes back from `branches/{branch}/protection` for a branch it matches. For the owner.
5. **How a slash in a branch name is taken** by both reads when it is sent as `%2F`. Rule 6, the reads on `release/1.0`.
6. **What dismissing an already dismissed review answers.** Rule 6, the probe's second dismissal.
7. **Whether "new, reviewable commits" leaves out a merge of the base,** so that GitHub's rule does not dismiss on it. For the owner. The service's own withdrawal dismisses on any push either way.
8. **Whether an approval posted on an older commit, after a push, counts toward required approvals.** For the owner. The withdraw job asked with every approval dismisses it either way (call 10).
9. **The association GitHub reports on a thread comment** for a member whose membership is private (20, item 7). Rule 6 reads the owner's; another member's private membership, for the owner.
10. **Whether GitHub's own dismissal on push, and a dismissal by hand, each send a `pull_request_review` delivery of action `dismissed`** with the review's id. For the owner: the scratch app has no webhook.
11. **Whether a push by a ruleset's bypass actor still dismisses stale approvals.** For the owner.
12. **A pull request from a fork** reads `fromFork` true. Rule 6, when a fork can be made.
13. **The sizes:** 2 places, 10 and 60 seconds, three starts.
14. **That the in-process Postgres and the real one agree** on `markDismissFailed`'s update from a subquery and on three kinds sharing one partial unique index. Rule 5 runs them on a real one.
