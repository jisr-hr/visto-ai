# Notes: The Extension Modules plan

These notes record what happened while `2026-11-22-extension-modules.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run on a real Postgres and the trial with a real app showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built. This plan is the first of two for stage 6 of the build order; the second is MCP servers and the model's tool loop.

## Status

- Stage 6 was cut in two plans by the builder: extension modules here, MCP servers and the tool loop next. Each ends with something that can be shown by itself.
- The plan was drafted from the design, a map of the code and a private study of the predecessor's context lookups, notifications and feedback, and reviewed by another model before anything was built. That review found no critical defect, seven important ones and sixteen minor; all were ruled on and applied before the first line of code (decisions 1 to 7).
- Tasks 1 to 10 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer working in a separate checkout of the task's commit. Most reviewers ran the code against inputs of their own rather than reading it: hostile modules through the real loader, an oracle for the rows on a hundred thousand generated cases, the listener against fourteen thousand requests on this branch and on its parent, whole jobs recorded query by query on both. Eight tasks needed a fix round; each was checked again.
- Task 11's documents were written by an implementer from the code as built; its run on a real Postgres and the trial were made by the controller.
- Then a review of the whole branch by the strongest model. It drove the real service and the real loader through fourteen hundred random lives of pull requests, more than eight thousand reviews, with providers, notifiers and routes that answered, failed, hung and lied, with restarts, spells of dry run, forks, lost publications and kills at random points, and judged each life by reading only the fake GitHub, the database, what the modules were handed and the log. It also sent the same deliveries through this branch with no module and through `main`: the rows, the calls to GitHub, the answers, the log lines and every request to the model were the same, byte for byte. It found nothing critical and three things to fix (decisions 18 to 20). One fix wave followed, and a last run of the same lives. That run, four hundred more lives and the same comparison with `main`, found nothing critical and nothing important.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **A context provider is asked once for a review, under 30 seconds, and never fails it.** A throw, a time-out or a wrong shape is a status with a short code.
2. **The core tells a notifier of every published review, a re-check included; whether to send a message is the module's choice.** A notice is sent at most once for a run: a stamp is written before the call, so a crash can lose a notice and never doubles one.
3. **Providers are off in the eval commands.** The replay and the backtest ask none, so the tool variant that takes rows is never exercised there.
4. **Acceptance criteria are numbered by the service and the model answers by number.** The service writes the criterion's text itself, checks the rows, merges them across batches and keeps them across reviews, in code.

**From the plan's review**

5. **A pull request from a fork, or one whose origin is unknown, is given no extension context** (call 32). A stranger could otherwise name a ticket in a branch or a title and have its criteria posted in a public review. Cost: a team that works through forks gets no ticket context until this is loosened.
6. **Module routes have places of their own, ten for each module, and a handler past its limit keeps its place until it settles** (call 23). Before, they shared the webhooks' places, and a `503` given to GitHub is a lost delivery.
7. **A badly shaped row costs that row, and a path under `/extensions/` that names no module is answered as before, with nothing read.**

**The planner's, accepted**

8. **Extension context is shown only when it costs the files nothing** (call 8): the files are packed with it and without it, and it is shown only when nothing more is cut and no file more is left unreviewed. When the texts do not fit, the criteria alone are tried.
9. **Earlier rows come from the newest published run that has any, a re-check included, and a criterion is told apart by its text** (call 16).
10. **The design was amended** in the places Task 11 tables: which results carry no statuses, where earlier rows come from, what the model is told of them, which change of status raises an alert, how repeated request headers arrive, the notice stamp among the columns, and the rule on forks.

**From the reviews of the tasks**

11. **A reference to the environment counts only as a value inside a module's `options`, never as `options` itself.**
12. **A module's import runs under the same limit as its set-up, and its failure line holds no free text:** the error's name only when it is one of the platform's own, its code only when it is shaped like one.
13. **A provider's criteria are read entry by entry inside the guard.** As first built, a list with a method of its own made the review fail, and a list with holes put nothing among the criteria.
14. **An `acceptance` that is no list costs no answer; the first row for a criterion decides, whatever is wrong with it; a stored row is checked and cleaned like a new one, and at most thirty are read; the tool shown to the model lists the three statuses.**
15. **A feedback login holds no hidden character and is measured as stored; a dry run's notice cannot be claimed.**
16. **A notice never rejects, whatever a notifier throws; an alert's time is read once for the webhook and the sinks; a module may not set five more hop-by-hop headers; a route's place is given back when its answer is no object.**
17. **The instance lock is taken by `main`, after the clients are built and before the modules are loaded,** and released when a module fails to load.

**From the review of the whole branch**

18. **A criterion has one cleaner,** used when a provider's answer is read and when a stored row is read, so the two texts cannot differ.
19. **The health is not told of a status the engine wrote itself:** the one a pull request from a fork, or of unknown origin, is given.
20. **With a module loaded, a rejected promise that nobody handles is logged and the service goes on.** With no module loaded nothing changes: the platform ends the process, as before. An exception thrown outside any promise, as in a timer's callback, still ends the service; the module contract says so.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 5 to 7; two time limits that no test could shorten; a route handler with no signal; and that nothing said a provider's criteria are posted.
- **The reviews of the tasks.** A field the plan listed and the implementer reported, which was not there (a string match that failed silently). A module whose top level never settles hung the start for good. A provider could fail a review through its own list's methods. A notifier could make the notice reject through an error whose message throws when read. A route that returned no object leaked its place. Each was found by running the code, fixed and checked again.
- **The review of the whole branch.** A criterion longer than its limit and cut at a space never kept its earlier row: the fresh text kept the space and the stored one lost it. A review of a pull request from a fork told the health that every provider worked, so a failing module was announced as working again. And a module that left a rejected promise behind ended the process; in a provider, the job then ended with no review after its three starts.

## What the run on a real Postgres showed

One run under Docker on the branch's code, against a real Postgres, in a network with no way out, with a key made for the run. The previous release came first, on a fresh database; this branch followed on that database, in dry run, with the example module mounted beside the config.

- The previous release applied its eight migrations. This branch added the ninth and nothing else: the notice stamp exists and is empty on the runs stored before, and the feedback table exists.
- On that Postgres: an answer is stored for a published run; the same person's second answer replaces it, in the same row; an answer for an unpublished run, or for no run, stores nothing; a vote that is neither up nor down is refused by the table; the stamp of the published run is claimed once and a second claim is refused; the stamp of an unpublished run cannot be claimed.
- The example module was loaded from a folder mounted outside the service's own, as a `.ts` file, with its three parts. In dry run the service said that its notifier would not be called.
- Its routes, called inside the container: an unknown path answered by the module; a wrong secret refused; the right one stored an answer, with the login in lower case; an unpublished run refused with a short code; a body over the cap refused; a path that names no module answered at once, a large body unread.
- A second instance on the same database stopped at the lock, before loading any module. A module file that does not exist stopped the start, naming the module, and the next start listened: no lock was left. A secret's variable that is not set stopped the start as a config error.
- A sample event was accepted; with no way out its job failed at its first step and was put back, as on `main`, and no part of the module was called.
- The previous release, started again on the migrated database, refused to start: it found a migration it does not know.
- Every log line was one JSON object, with none of the run's secrets, no login and no reason. Everything the run made was removed.

## Verified with a real app

On 2026-11-23 the branch was tried against the real GitHub App and the private scratch repository of the earlier trials, with a real review model and the example module alone. The app has no webhook, so each event was built from what GitHub's API answers and posted to the service by hand.

- GitHub's answer for a pull request carries the two repositories with an id each, equal for a branch of the repository itself: the provider was asked.
- The first review of a new pull request carried the `Acceptance criteria` section: the count line, and one row for each of the example's two criteria, one met and one not met, each with a note the model wrote. On the pull request's page a row reads as a bold label, the criterion as inline code, then the note.
- The `review` log line named the module's provider and how it did.
- The notifier was told once for the published run.
- A `/review` on the same head was a re-check with no model call. Its rows were the earlier ones, each tagged as kept, and it was told to the notifier too.
- The module's route refused a wrong secret and stored an answer with the right one; the same person's second answer replaced the first.

**Still not verified**

- A pull request from a fork, and a fork that was deleted.
- A provider that fails or hangs, the rule that keeps extension context from costing the files, rows from several batches, and a criterion judged again by an incremental review.
- Alert sinks, and a notifier that fails.
- Everything a real ticket system or chat tool asks of a module: its signature, its deadline, its retries. That is the first deployment's module, in its private repository.
- Whether the limits fit real tickets.

## For the owner to decide

- **Forks get no extension context** (decision 5). A switch for one repository would loosen it.
- **What acceptance rows cost the findings and the scores is not measured.** The replay runs without providers. Measuring it needs a provider in a paid replay.
- **A module's alert sink also hears alerts about its own module's other parts.** Neither the plan nor the design rules on it.
- **With a module loaded, a rejection of the service's own that nobody handles is logged and no longer ends the process** (decision 20). The other way is to leave the platform's default and say in the contract that a careless module ends the service.
- **The limits are starting values:** 8,000 characters of text for one provider and 24,000 in all, thirty criteria of 300 characters, 30 seconds for a provider, 10 for a notice and a route's handler, 5 for a sink, ten places and 1 MiB for a module's routes.

## Known and left as they are

- A careless module lets a caller learn whether a run id is published, and each invented login adds a row for that run (call 25). A route is public: the module checks its caller.
- A client that trickles its body holds a place of the module for up to the server's request timeout, as it can the webhook route's.
- A notifier that hangs holds its job for the limit once for each run adopted late, and once more for the live head's own publication.
- A crash between the stamp and the send loses that notice.
- In a body written whole because GitHub refused the inline comments, thirty long rows take room from the findings.
- A link, an image or an issue reference in a note stays live, as in all text the model writes; a criterion is always inside a code span.
- A kept `met` can go stale when the code changes in a way the later review does not judge; the row is tagged as kept, nothing more.
- The handler of decision 20 is registered after the modules are set up: a set-up that leaves a rejected promise behind and then waits ends the start with the platform's own error, not with the line that names the module.
- A module lives as long as the process: a changed module needs a restart, and nothing closes a module at stop.
- A mounted module file reaches Node's own modules and `fetch`, and no package of the image.
- The eval commands read the same config, so they need the modules' secrets set when the config names modules, though they load none.
- What `startService` builds before it reads the lock runs with the lock held; none of it throws today, and a throw there would leave the release to the process's exit.
- The previous release cannot be put back on a database this release has migrated.

## Not verified

- What the trial did not reach: see "Still not verified" above.
- `main`'s own close of the database when the lock or a load fails, under a test: it needs Postgres, and was seen only in the Docker run.
- Two instances of the service at once beyond the refusal at the lock: the design allows one.
