# Notes: Inline Notes and the App Manifest plan

These notes record what happened while `2026-11-21-inline-notes-and-the-app-manifest.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, what a trial with a real app showed, and what was put off. The plan file was corrected as the build went, so it states the rules as built. This plan closes stage 4 (the shell); the gate is next.

## Status

- Before the build the plan was reviewed by a stronger model than the one that wrote it. It found no critical defect, six important ones and twenty minor. All six, and seventeen of the minor ones, were applied before the first commit (decisions 1 to 4).
- Tasks 1 to 7 were built on the branch `stage-4f`, one implementer and one independent reviewer for each. Tasks 4, 5 and 6, which decide what is posted and handle the app's key, were built by a stronger model; Tasks 3 to 6 were reviewed by one. Task 6 was built before Task 5: it touches none of the same files.
- Two tasks needed a fix round, each re-reviewed: Task 2 (decision 6) and Task 6 (decision 7).
- Then a review of the whole branch by the strongest model. It ran the real engine under the real job through eleven lives of a pull request with notes on and 230 random ones, and found no review or note posted twice, no note judged, answered or counted, and nothing changed with notes off. It found no critical defect, two important ones and nine minor. One fix wave followed (decisions 8 to 11), and a re-review by the same model: ready, everything addressed.
- The re-review left one minor point, and a probe against GitHub had meanwhile shown something the plan had only feared (see "Verified with a real app"). A second, small fix followed, against the rule of one wave (decision 12), and a last re-check.
- At the end: 1,844 tests pass, the type check and the lint are clean, source and tests are ASCII.
- The real run under Docker was made on the final code. What it showed is below.
- Inline notes were tried against a real GitHub App. The command that creates the app was not: it needs a person at a browser.
- After the merge the owner ruled on the first question put to him: the manifest asks for `contents` write, so that an app made from it resolves threads (call 2). The manifest, its tests, the README and the plan were changed in one commit. The suite still counts 1,844 tests.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **A note whose read-back failed is known from its thread.** The blocks that already have a note are taken from the stored comments together with what the repair of missed comments finds at this start, recorded or not. As first written, a failed read-back would have posted up to 50 notes again.
2. **A recorded review that a later start publishes goes without its notes** (call 12). If GitHub will not take a request, sending the same one again must not keep the findings from being posted. Cost: after an outage that review's notes come one review late.
3. **One note GitHub never accepts keeps every note of that pull request from being posted** (call 10). GitHub does not say which comment it refused. Stated as a cost, not bounded.
4. **The command that creates the app was hardened before it was built** (the plan's review): the secrets file is reserved before anything listens; the page is served only at an address with a random part, and only under this machine's own names; the way back is taken once; the exchange is tried once more; a failure after GitHub created the app says so and what to do.
5. **Readings the builders made where a rule left a choice,** each accepted because it errs towards a person or towards doing less: a comment list in a stored run that is not a list is posted as the body alone; an entry of it that is not an object is dropped; a throw while the notes are made leaves the review without notes and is logged by its event name alone; the read-back of a review adopted late says nothing of missing notes; a write of the key that fails ends the command with a code of its own.
6. **A block whose line cannot be a line gets no note** (Task 2's review). A damaged stored block with a first line of 0 would have given a note GitHub refuses, and every note of that review with it.
7. **Stopping the command leaves no file behind, and a damaged answer cannot add a line to the secrets file** (Task 6's review). A key or a secret that does not look like one is refused.
8. **A posted note is recognised by the part of its text the service wrote itself** (call 14): everything up to and including the category, on the same path and side. The model's reason is not compared. Matched by its whole text, a note GitHub gave back changed in one character would have been posted again at every review, with no bound.
9. **The command asks for the app's name** (call 15). GitHub does not let an app take the name of an account that is not its owner's, and the name in the manifest file is this project's own account.
10. **Of two blocks with the same lines, the one that scored higher gets the note** (call 6). As first built it went to the first in the diff.
11. **More care around the key** (the whole-branch review's minor points): it is written through the descriptor the reservation opened, never by the file's path again; what GitHub sent back is printed with anything but printable ASCII replaced; with `--org`, an owner that is another account is said; each try of the exchange has a time limit; a closed terminal is a stop too.
12. **A publication that ended with a network error or a server error is tried again after 15 minutes, not one** (call 16), and **the key never ends in a file without a name.** The first came from the trial: GitHub answers a review that carries many inline comments with an error and creates it all the same, and only time lets the next start find it and adopt it. This is a second fix after the fix wave; both are a few lines.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 1 to 4; a new rule for reading an adopted review that changed behaviour with notes off and contradicted two existing tests (it was put back to today's rule for a run with no note); and two tests that passed before their code without being called pins.
- **Task reviews.** Decisions 6 and 7.
- **Whole-branch review.** Decisions 8 to 11; and the README's "none twice", which was not what a user would see: an edited block, a block whose hunk merged or split, and every flagged block of a renamed file get a new note, and the old threads stay.
- **Its re-review.** Decision 12's second half; and that the code cannot tell a review GitHub did not create from one GitHub does not list yet.

## What the real run showed

One run under Docker on the final code, against a real Postgres, in a network with no way out, with a key made for the run. The previous release came first, on a fresh database; this branch followed on that database, with inline notes switched on in its config.

- The previous release applied its four migrations. This branch added the fifth, and nothing else. A comment row the previous release had stored reads with no block.
- On that Postgres: a note written with its block and read back; a second write of the same comment left the row as it was; the blocks that have a note were found from the rows; the new config key was read as on.
- The manifest is in the image with the permissions and events the plan lists, and the command refuses arguments it cannot use before anything is created or listens.
- From inside the network the service answered its health check and could not reach the outside.
- A signed push for a pull request that already had a published review was accepted and queued; one with a wrong signature was refused. The job's first try failed at its first read of GitHub and was put back, with nothing spent.
- The log was nine lines, each one JSON object. None held the webhook secret, the private key, the model key, the database password, a score's reason, a review's overview or a comment's text.
- Everything the run made was removed.

## Verified with a real app

On 2026-11-21 and 22 the branch was tried against the real GitHub App and the private scratch repository of the earlier trials, with a real model for two reviews. The app has no webhook, so each event was posted to the service by hand.

**The publishing of many inline comments, through the service's own code and no model**

- **One review with 6 findings' comments and 50 notes is accepted** (design 20, item 9). The notes were made by the service's own function, with reasons that held a mention, a tag, a code span, a long text and characters outside ASCII.
- **GitHub answered that request with a server error after more than ten seconds, and had created the review all the same,** with every comment. This happened both times it was tried.
- **The service's own publishing step recovered.** Its first start ended as failed with that error. The next start asked GitHub for the app's own reviews of the commit, found the review, adopted it and posted nothing; the read-back stored the six findings and the fifty notes; one review stood on the commit. Decision 12 gives that next start the time to find it.
- **Every note's text came back exactly as it was sent,** each on the line asked for.
- A finding and a note on the same line are two threads.
- **Rendering, read from GitHub's own HTML of a note:** `Human review:` in bold, the category as code, the mention not linked, the tag shown as text.

**The service itself, with notes switched on**

- The migration ran on the trial's database.
- A `/review` posted one note on the flagged block of a file, on its first changed line, with the score the block is held at; the read-back stored it as a note with its block and reported none missing.
- A second `/review` repeated no note, wrote no reply into the note's thread and owed it no verdict.
- The note was then resolved by a person; the next `/review` did not give it again.
- On a second pull request the note for a score taken from the first carried the category alone, with no reason.
- A push that edited the flagged block got a new note on the same line, beside the old, resolved one: the cost the README names.

**Seen, and worth knowing**

- A review with many inline comments is answered with an error although it was posted. With notes on, and on a pull request with many flagged blocks, this will be ordinary. The service's defence is the next start, a quarter of an hour later.
- The trial's model answers most files with a whole-file score and no block score. A file flagged as a whole gets no note, so with such a model notes are few: one block was noted in each pull request.
- A note shows the score its block is held at with the reason the model wrote for the lower score it gave.

**Still not verified**

- **The command that creates the app, and the manifest flow** (design 20, item 3): it needs a person signed in to GitHub at a browser. Nothing of it was run against GitHub.
- A review GitHub refuses for one comment, and which try is then accepted.
- More than 50 flagged blocks through a job (the 56 comments went through the writer and the publishing step, not through a review job).
- A renamed file, a second scorer, GitHub's own webhook deliveries.
- A review posted twice because GitHub's list did not show it in time: not seen; the list showed the review within seconds.

## Put off

- **The gate** (stage 5) is next. What is stored here lets it tell a note from a finding.
- **A note's replies counted as labels for the score:** stage 8.
- **For the owner to decide:**
  - whether a recorded review that is young and finds no review of its own on GitHub should wait instead of being posted (decision 12 covers the usual case by time; a `/review` or a reopening within seconds of the failure can still start too early);
  - whether notes that were refused should be remembered, so that one note GitHub never accepts stops costing the others (call 10).
- **Known and left as they are:**
  - An edited block, a merged or split hunk and a renamed file's blocks get new notes, and the old threads stay (calls 5 and 11).
  - A note is never rewritten when its block's score changes later.
  - With more than 50 flagged blocks a block can be in neither the body's list nor the notes of one review (call 13).
  - If the list of the app's own reviews does not show a review GitHub created, the review is posted a second time; the code cannot tell the two cases apart.
  - Each note is a thread: the limits on reading a pull request's threads and comments are reached sooner.
  - Each later permission (the gate's, automatic approval's) is added by hand in the app's settings and accepted by every installation (call 1).
  - Every app made from the manifest may push to the repositories it is installed on, though the service has no code that does (call 2, the owner's ruling). An adopter who will not grant that lowers `Contents` in the app's settings, which was not tried.
  - The last re-check's two leftovers, both needing someone to move or replace the secrets file during the minute the command waits. A reserved file that was moved aside holds the secrets, while the command ends with `write_failed` and says no key is in anyone's hands. And on a stop or a failed exchange the command removes whatever the path names, also a file put in the reserved one's place. The README says both.

## Not verified

- Two jobs of one pull request at once.
- The command on a real socket, and on Windows.
- How many inline comments make GitHub answer with an error: 56 did, twice; smaller reviews in the earlier trials did not.
