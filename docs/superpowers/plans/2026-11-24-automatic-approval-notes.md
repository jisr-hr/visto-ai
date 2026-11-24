# Notes: The Automatic Approval plan

These notes record what happened while `2026-11-24-automatic-approval.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the runs showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built; its changes are marked "(as built)". This plan is the first of two for stage 9 of the build order. What is left of the stage is the audit sample (design 6.5, D9), which the next plan builds; until it exists, the configuration refuses automatic approval unless the audit share is written as 0.

## Status

- The planner was told to keep a plan to about twelve tasks; it cut stage 9 in two (approval, its record and its withdrawal here; the audit sample next) and wrote twelve tasks. The plan was drafted from the design and a map of the code written for it, and reviewed by another model before anything was built. That review found one critical defect (a finding whose comment the author of the pull request deleted was read as closed), five important ones and ten minor; all were ruled on and applied before the first line of code, and one task was cut in two (decisions 9 to 14).
- Tasks 1 to 12 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. The reviewers ran the code rather than read it: probes of their own, fuzzing of damaged stored results and thread lists, a comparison of the thread count against the plan's rules written out literally, and one-line changes to the code to see which tests would notice. Six of the twelve needed one round of fixes: three for tests that let a one-line change approve where it should not (the code was right), and three for defects of the plan or the code (decisions 17 to 21).
- Task 13's documents were written by an implementer from the code as built and reviewed against the code; that review found one promise the code did not keep, and the code was changed to keep it (decision 23). The run under Docker was made by an agent of its own with throwaway secrets; the checks against GitHub were made by the controller.
- Then a review of the whole branch, on the strongest model the build had left. It found no path that posts an approval it should not, nothing critical, one important defect (decision 24) and three minor points, and triaged every point the task reviews had left. All that it said must be fixed before the merge was fixed in one round, and that round was checked again, with one-line changes to the new code each failing a test; its points were of wording, and are fixed (decisions 25 to 27).
- Meanwhile `main` gained the benchmark pilot; it was merged into this branch before the pull request, with no conflict, and the suite run again on the merge.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **Two plans** (call 1): approval, its record and its withdrawal here; the audit sample next. Until then `autoApprove: true` is refused unless `auditShare: 0` is written, so that no deployment approves with the 5% sample silently missing.
2. **Off by default, per repository, in the deployment config only** (call 2, D10).
3. **Decided at publish, from live reads; what cannot be read means no approval** (call 3).
4. **`administration: read` in the manifest** (call 4).
5. **Withdrawal is a job of its own lane, stored in the transaction of the pull request's facts, whatever the review filters say** (calls 5, 17).
6. **Access is what GitHub reports for each thread comment; an unknown association is none** (call 6).
7. **No new library, no model call, no dropped idea** (call 32).
8. **The evals with lessons wait for a deployment** (call 31): a history file holds no finding of this reviewer, so the lessons an eval needs can only come from a deployment's own database. The design's build order was corrected.

**On the review of the plan**

9. **A lost thread is open for approval** (call 33): every stored major or blocker of a published run whose comment is no longer the first comment of an app's own thread holds approval back. Cost: a person reviews where a comment was deleted.
10. **A thread this review kept open is open under both rules** (calls 26, 27).
11. **"Settled" is the intersection of the rules in force** (call 7), so a thread the author settled alone, or one held by the gate with clearing by reply off, is judged again.
12. **A review whose commit GitHub collected is never read or listed** (calls 16, 18).
13. **A withdrawal whose pull request could not be read records the read's code on every standing approval and alerts once** (call 19).
14. **A reopening asks for a withdrawal** (call 5); the sweep covers open pull requests only (call 22); a state GitHub reports that is neither approved, commented nor dismissed is a failure, never a dismissal (call 18).

**While building**

15. **The order of the conditions is the code's** (Task 8): the stored conditions, then draft and fork, then the threads, then the branch's rule. The plan's first table listed the threads before draft and fork; the order changes which reason is given, never the decision.
16. **The approval switch reports a bad gate and a bad audit share together, the gate's issues first,** and `auditShare: -0` counts as 0 (Task 1).
17. **Under the strict rule, a reply made before a review kept the thread open no longer closes it** (Task 5, as built). The review of Task 5 found that call 27 held for one review only: a member's "please fix", a review keeping the thread open, then the author resolving it alone closed it at the next review. Now, after a newest `open` verdict, only comments after the ones that review judged count; with that entry's count of replies missing, or the entry damaged, none counts. After `answered`, earlier replies count as before. Cost: a member who replied before the review must reply again after it.
18. **A failed withdrawal is recorded before its job ends, and a record the database refuses still alerts** (Task 10, as built).
19. **A recorded failure ends once a later job finds the approval dismissed or holding** (Task 10, as built). The failure recorded during a short outage, or one a person cleared by dismissing the approval by hand, stayed for ever and kept the gate's check red. Every withdraw job now reads again each standing approval with a recorded failure that is not a target: dismissed is recorded, approved clears the failure (a new statement, `clearDismissFailure`), a read that fails keeps it. Such an approval is never dismissed by this path.
20. **A withdrawal the runner drops is recorded as failed and alerted with its pull request** (Task 11, as built; revised by decision 26): a job dropped as too old (after more than a day down) or out of starts left nothing for the gate or the start's sweep to see.
21. **In dry run a dropped withdrawal is still recorded and alerted, and the gate is not asked** (Task 11): dry run stores no withdrawal, so only a job left from a live run can be dropped there.
22. **Review states are read whatever their case, from one map** (Tasks 3 and 4, applied in the last round): the older code already read a review's state so, and a state read as unknown would have left an adopted approval recorded as a comment.
23. **Every withdraw job reads each standing approval that is neither a target nor failed** (Task 13's review, as built): the README promised that a dismissal by hand or by GitHub's own rule reaches the record within seconds, and the newest approval at the live head was never read. Dismissed is recorded; approved changes nothing; a read that fails is no failure. Cost: one read of GitHub per standing approval per withdraw job, usually one, after every publication.
24. **At a merge, the approvals that no longer hold are read as on an open pull request** (the whole-branch review): an approval a later review of the same head withdrew, or one for a base branch the pull request left, was never read at a merge, so a merge under it was neither recorded nor alerted.
25. **The runner's drop alerts only when it recorded something, and a job dropped as too old is asked for again at once** (the whole-branch review), so that after a long outage the re-check clears within seconds the approvals that hold, instead of leaving red checks until the next event. A job out of starts is not asked again: a crash that repeats would loop.
26. **A reopening is worded as what it does** (the whole-branch review): it withdraws an approval of another head or base branch; an approval of the reopened head and base stands.
27. **The points the reviews left are triaged as the whole-branch review said**: those that could let a one-line change open condition 8, the gate's failed-withdrawal check or a stored refusal got their tests before the merge; the rest are listed below as known.

## What the reviews found that the plan had wrong

- Call 27's protection against an older reply lasted one review (decision 17).
- Call 19's "it ends when any later job finds the approval dismissed" was not true of an approval the rules no longer targeted (decision 19), nor call 21's "a dismissal reaches the record" of the newest approval at the live head (decision 23).
- Call 20 looked only at other heads at a merge, though call 11 had made an approval of the same head stale (decision 24).
- The runner's own drop of a withdrawal had no rule at all (decisions 20, 25).
- Several tests the plan named would have passed with a one-line change that approves: the author passed into the thread count, the gate's clearing by reply, a rule answer of the wrong shape, the thread rule in the review job, the flags read from GitHub as "dismissed". Each now has a test that fails under that change.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the previous release on an empty database, then this branch over it, which added only `0013_approval` (the six columns and the partial index as written; every row stored before reads as no approval); the previous release then refuses to start; a push with no standing approval stores nothing more; `autoApprove` without `auditShare: 0` stops the start with the issue and prints no value; a push of a gated pull request with a standing approval stores a withdrawal in the delivery's transaction, which, with GitHub out of reach, is tried again after about 10 and 60 seconds and gives up at its third start with the read's code recorded, one `dismissal_failed` alert and the gate asked; the next start's sweep asks again, and none once the pull request is stored as closed; a withdrawal older than a day is dropped, recorded and alerted; every statement of the record and of the lane answered as its tests say on a real Postgres. Every log line was one JSON object but the refusal's own line, and none held a secret, a login, a branch or a message. The run was made on the code before the last two rounds of fixes, which changed no statement of the migration.

## What was checked against GitHub

On the private scratch repository of the earlier trials, with its real app: the permission `administration: read`; the thread query with `authorAssociation` is accepted, and a member's reply reads `member`, the app's own comments `none`; both reads of the branch's rule answer 403 on a private repository whose plan holds neither rulesets nor branch protection, for any branch, one that does not exist included, so the reviewer cannot approve there; one review through the service with approval on was posted as a comment ending with the `rule_unreadable` paragraph, and its code was stored; through the adapters, an approval posted with the event `APPROVE` was listed and read as approved, dismissed, then read and listed as dismissed; a second dismissal of it answers 422, which the withdrawal's read after a failed dismissal treats as no failure.

## For the owner to decide

1. **A repository that holds rules, and a webhook.** Nothing here can post an approval through the service on the private scratch repository. A public scratch repository, or a plan that holds rules, with the go-ahead to make a ruleset and a protection rule there, and a deployment GitHub can deliver to, would let these be checked: an app's approval counting toward required approvals; an app dismissing its own approval on a protected branch; a rule written as a pattern; a merge of the base not dismissing; GitHub's own dismissal on a push and its `dismissed` delivery; a slash in a branch name.
2. **Rulings he may want to change**, each a small change: a later review of the same head that does not approve withdraws (call 11); a push that tells nothing new after an approval is posted (call 12); a draft keeps the approval (call 15); a skip does not pass a failed withdrawal (call 19); one reason, in every review of an approval-on repository (call 13); the thread rules made stricter than the design's words (calls 7, 26, 27, 33, and decision 17).
3. **The previous release does not start on a database this release has migrated.**

## Known and left as they are

- A repository name with a line break is printed across lines in the audit-share issue, as in the gate's and the duplicate-name issues; `auditShare: -0` is stored as `-0`.
- Some filters and checks have no test of their own where today's writers make them redundant: the `published` filter of `hasStandingApproval`, the definition of the new index (the run under Docker checked it), `failedDismissal`'s `dismissed_at` filter.
- A few refusals of the GitHub adapter have no test of their own: a dismissing rule on a first page with a full tenth page, the pull request's number on two of the three methods, a branch named `.`.
- A code that is not one of the service's own is looked up in the texts' table without `Object.hasOwn`; the codes are the service's own.
- At a withdrawal's give-up, an approval whose failure was already recorded can raise one more alert when the database refuses to write it again, and the alert's reason can be a re-check's code rather than a target's; a new code over an old one does not ask the gate, so the check shows the older code until its next evaluation.
- A stop between recording an adopted approval and asking for its withdrawal leaves it standing until the next ask; GitHub's own rule has normally dismissed it already.
- The runner's drop of a withdrawal records its reason on the standing approvals of a merged or closed pull request too; such a failure stays recorded, as the start's sweep leaves merged and closed pull requests alone (call 22).

## Not verified

- Everything under "For the owner to decide", item 1.
- A merge under a standing approval, against GitHub.
- A pull request from a fork, against GitHub.
- The run under Docker was made before the last two rounds of fixes; those rounds changed the withdrawal's targets and the runner's drop, which their tests cover, and no statement of the migration.
