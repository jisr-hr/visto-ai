# Notes: The Merge Gate plan

These notes record what happened while `2026-11-22-the-merge-gate.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run on a real Postgres showed, and what is left. The plan file was corrected as the build went, so it states the rules as built. This plan is stage 5 of the build order.

## Status

- The plan was drafted from the design, a map of the code it builds on and a private map of the predecessor's gate, and reviewed by another model before anything was built. That review found one critical defect, seven important ones and ten minor; all were ruled on and applied before the first line of code (decisions 1 to 7).
- Tasks 1 to 12 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. Four tasks needed a fix round (3, 5, 9, and the small points of 1 and 2), each re-reviewed. The points the reviews called minor were kept in a ledger and applied in two fix waves at the end of the tasks.
- Task 13's documents were written by an implementer; its run on a real Postgres was made by the controller.
- Then a review of the whole branch by the strongest model. It drove the real listener, both runners, the review job and the gate job through more than ten thousand random lives of gated pull requests, with deliveries reordered, held and repeated, calls to GitHub failing, restarts, pauses and changes of mode, and judged each life by reading only the fake GitHub and the database. It also sent the same deliveries through this branch with no gate and through `main`, and the rows, the writes to GitHub, the answers and the log lines were the same. It found no check written green that should not be, four important gaps in which a check was kept stale or missing or a command was lost, and smaller points. One fix wave followed (decisions 17 to 20), and a re-review by the same model.
- The owner granted the trial app the gate's permissions, and the gate was tried once against it, in part. What that showed, and the one fix it led to, are below.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**From the plan's review**

1. **A review whose inline comments GitHub refused, and that holds a major or blocker placed on the diff, blocks the check** (call 45). The predecessor's decision that unplaced findings do not gate was about code the pull request did not change, not about comments GitHub would not show.
2. **A skip lands only on the commit the skipper saw** (call 46): the job refuses with `stale_head` when the head moved since the comment was received.
3. **A gate command that is put back is not dropped because a `sync` waits,** and a review started by `/done` or a re-run starts over once when the head moved, as a `/review` does.
4. **A thread no review can judge clears only by a skip when clearing by reply is off** (call 47). No new mechanism was added for it.
5. **A completed check was to be rewritten to queued or in progress by an update, with no fallback** (call 48), on the evidence that the predecessor did so for a long time and against the advice of the plan's review, which had asked for a new run. The trial showed the review was right (decision 16).
6. **The design's rule on the queue was changed** (section 8.2): never two review jobs for one pull request at once; one gate job may run beside a review job.
7. **The cost of the `check_run` subscription is named, not avoided** (call 9): the app may be sent every check run of the repository.

**From the reviews of the tasks**

8. **A list of commit statuses that GitHub cut short is never read as green.**
9. **The first verdict a review stored for a thread decides, damaged or not** (Task 5). A damaged entry is no verdict; a later entry for the same thread is not read in its place.
10. **A thread the app resolved stays cleared when a person objects in it afterwards and leaves it resolved** (call 16). Whoever objects unresolves the thread.
11. **A command joins only a review that will run** (call 25): a stranger's waiting `/review` does not swallow a member's `/done`.
12. **A skip's reason is shown inside a code span** (call 42), so that nothing in it is live.
13. **Every call to GitHub has a time limit of 60 seconds** (call 50). This also changes the review lane: a call that hangs fails after a minute.
14. **A review posted without its inline comments whose stored result cannot be read blocks** (call 51).
15. **A check the service gave up on is asked for again at the next start, and a pull request found closed is recorded as such** (call 52), so that the sweep at start neither forgets the first nor asks for the second for ever.

**From the trial with a real app**

16. **A completed check that must wait or review again is replaced by a new run of the same name** (call 48, turned round). GitHub answers an update that asks a completed run to be queued or in progress, and changes neither its status nor its conclusion.

**From the review of the whole branch**

17. **The sweep at start asks for every stored open gated pull request** (call 38, rewritten). As first built it asked only where the last recorded check was missing, of another mode, unfinished or failed. A thread unresolved, a push, or clearing by reply switched off while the service was down or in dry run then left a green check, or no check, until an event.
18. **A `sync` carries the installation it was asked with** (call 53). Before, a pull request opened before the app was installed never got a check from a `/done`, a reply or a start.
19. **A manual review that fails while the stored head moved starts over once** (call 54), also with no gate. Before, a `/done` that had joined the running review of an older head was lost when that review failed.
20. **Only a review that will run counts as under way** (calls 25 and 43). Before, a stranger's waiting `/review` made a green check say that a review was waiting.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 1 to 7; a start sweep that would ask again at every start; an alert that an outage with steady events could keep from ever being raised; texts that named the skip team, told the public about the operator's account, or promised a retry after the service had given up.
- **The review of the whole branch.** Decisions 17 to 20; that the README's sentence on an unwritten `newHead` was wrong for a gated pull request; and that the cost of two pull requests sharing one head commit was understated (see "For the owner to decide").
- **The reviews of the tasks.** Two ways a merge could pass that should be held, each found by a reviewer running the code rather than reading it: a list of statuses cut short (decision 8), and a damaged verdict entry skipped in favour of a later one (decision 9; the reviewer compared the rule with its own reading of the plan on several hundred thousand generated inputs). One way a member's `/done` did nothing while it was told accepted (decision 11). And that no call to GitHub had a time limit (decision 13).

## What the run on a real Postgres showed

One run under Docker on the branch's code before the review of the whole branch, against a real Postgres, in a network with no way out, with a key made for the run. The previous release came first, on a fresh database; this branch followed on that database, with a gate enabled for one branch.

- The previous release applied its seven migrations. This branch added the eighth: the jobs stored before read as review jobs, the index that allows one waiting job for a pull request now allows one of each kind, and the two tables of the gate exist.
- On that Postgres: a second waiting review job for a pull request is refused as before; a waiting gate job is stored beside a waiting review job, and asking again keeps the one that waits; an evaluation is recorded and read back; a skip is stored once for a comment and found for its head only.
- At start the sweep asked for the check of the one stored pull request against the gated branch, and not for the one against another branch.
- With GitHub out of reach, the gate job was put back twice, gave up at its third start, raised `gate_check_failed` and recorded the failure. A second start asked for that pull request again.
- The service answered its health check and could not reach the outside. Its log was JSON lines of events, codes and counts, with none of the run's secrets.
- The previous release, started again on the migrated database, refused to start: it found a migration it does not know.
- Everything the run made was removed.

## Verified with a real app

On 2026-11-22 and 23, after the owner had granted the trial app `Checks` write, `Commit statuses` read and organisation `Members` read, the branch was tried against the real GitHub App and the private scratch repository of the earlier trials, with a real review model and a real second scorer. The app has no webhook, so each event was built from what GitHub's API answers and posted to the service by hand. The trial ran on the code before decision 16.

**The check run**

- `GET /app` gives the permissions as `checks`, `statuses` and `members`: the names the service looks for.
- The app created a check run on a head commit, and the service found it again by its name and the app's id.
- An update from queued to in progress, from either to completed, and from one conclusion to another (blocked to passed and back) was accepted as built.
- **An update that asks a completed run to be in progress or queued was answered 200 and changed neither its status nor its conclusion;** it did take the new title, so the check read as completed with the title of a review under way. Sending no conclusion with it was refused. The service's own check on the answer caught it, the job was put back, and the check was right again once the review ended.
- **A new run of the same name on the same commit was accepted and replaced the old one:** GitHub's listing of the commit's check runs showed the new one alone unless asked for all, and the pull request's own status counted the new one alone.

**A whole round on a gated pull request**

- At start the sweep asked for the check of a gated pull request stored by the earlier trial, and the service wrote it: blocked, with the thread named and linked.
- A new pull request, opened: no review, and a check that waits for `/done`.
- `/done`: the eyes reaction; the check said a review was under way within seconds; the review was posted; the check then named two blocking findings.
- A `/review` at that head (a re-check) met the refusal above and ended with the right check.
- A person's reply and a resolve in one thread: one blocking finding fewer within seconds, with no review. A resolve of the other with no reply: it still blocked, and the summary said why. A reply there: the check passed, and the pull request showed it as passed.
- `/done` on the passed head: the eyes reaction, no review, nothing written.
- An unresolve: blocked again.
- `/ai-review-skip` with no team named: the confused reaction and the sentence with `no_skip_team`.
- A push: the new commit got its own waiting check, the old commit's check was left as it was, and no review was queued.
- A re-run, sent as an event built from the real check run: a full review of the new head (the default for a gated pull request), which kept a `fixed` verdict for the thread the push had answered; the check passed, counting one finding cleared by a review and one by a reply.

**A second, short trial on the code after decisions 16 to 20**

- At start the sweep asked for both gated pull requests of the repository; each was evaluated and nothing was written, since both checks were right.
- A `/review` on a head whose check had passed: the service wrote a new run that said a review was under way and, once the re-check was posted, completed it as passed. GitHub listed the new run alone for the name, both when asked for all, and the pull request showed as passed.

**Still not verified**

- The check as a required one: how each state holds a merge, how `action_required` reads on the page, whether a re-run is offered there. The scratch repository is private, and GitHub offers no ruleset and no branch protection for a private repository on its organisation's plan; trying it needs a public repository or another plan, which is the owner's call.
- GitHub's own deliveries: which `check_run` deliveries the app is sent and how many, a thread event for a resolve made in the page, what a real re-run carries, for a fork too.
- A skip by a member of the team, a skip typed after a push, and the answers to a team membership question.
- The required CI checks of `/done`; `shadow`; `bypass` across two starts; a review GitHub refuses inline; a pause of reviews; the manifest flow with the new permissions.

## For the owner to decide

- **Two pull requests of one repository with the same head commit share one check** (call 33): GitHub attaches a check run to a commit. The pull request evaluated last decides it, so one of them can show a green check on the strength of the other's review, or of a skip given for the other. It needs one commit opened against two branches, at least one of them gated. Nothing guards against it; the README says so. A guard would decide the check from every open gated pull request that shares the head and take the worst.
- **Whether the 60-second limit on calls to GitHub should hold for the review lane too** (decision 13). It does as built.

## Known and left as they are

- A read or a write of GitHub that fails leaves the check GitHub already shows, which can be a stale green one (call 49).
- A pause of reviews that begins while every place of the review runner is busy brings the waiting checks up to date only when a place frees.
- A pull request the service has no stored row for gets its check at its next event or command, not at start.
- At each start every stored open gated pull request is evaluated once: reads of GitHub, and a write only where the check differs.
- A gate job the runner gives up on records nothing; the next start asks again.
- A pull request whose check can never be written, as after the app is removed from the repository, is tried three times at each start, with one alert for each code (call 52).
- A command that fails inside the gate job's own first steps ends as a failed gate job with the alert, and is not answered.
- The previous release cannot be put back on a database this release has migrated.
- An objection written into a thread the app resolved holds nothing while the thread stays resolved (decision 10).
- With the gate off, a `check_run` delivery of another action is recorded as ignored with the reason `unknown_action`, where it was `unknown_event`.

## Not verified

- What the trial did not reach: see "Still not verified" above.
- Two instances of the service at once: the design allows one.
- A deployment with hundreds of open gated pull requests at start.
