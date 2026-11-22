# Notes: Scores Answer for Their Surroundings plan

These notes record what happened while `2026-11-22-scores-answer-for-their-surroundings.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run on a real Postgres showed, what a trial with a real app and real models showed, and what is left. The plan file was corrected as the build went, so it states the rules as built.

The plan closes call 19 of the plan before it (`2026-11-20-scores-that-hold-and-reading-less.md`), which the owner ruled on 2026-11-22: a stored score is reused, with the model not asked, only when the lines around the block are the same too. On the same day he settled every other question that was open; those rulings are in the design's section 21 and in the notes of the plans they belong to.

## Status

- The plan was reviewed before it was built, by another model than the one that wrote it. It found no critical defect and three important ones, all applied before the first line of code (decisions 1 and 2).
- Task 1 was built by one implementer, tests first, and then reviewed as part of the whole branch by the strongest model. That review drove the real engine through several hundred lives of a pull request, on this branch and on a copy of `main`, and found two ways a score could fall where it could not before. The rule was corrected, not patched (decision 3), in a fix wave. The re-review, by the same model, found two more: a block the model left to a whole-file score was asked for again at every review, and a hunk split in one place and scored whole in another could fall to its parts. A second, small fix wave followed, against the rule of one wave (decision 4), and a last check, which found nothing above minor and said ready.
- At the end: 1,891 tests pass, the type check and the lint are clean, source and tests are ASCII.
- The migration was run under Docker on a real Postgres. The rule was tried with a real app, a real review model and a real second scorer. Both are below.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **A block asked again is held to its own stored score, not through the file's floor** (call 3). As first planned, the stored score of a moved block went into its file's floor. The plan's review showed that every block of the file scored in the same run would then be raised to it and, with inline notes on, each given a note.
2. **Two hunks with the same changed lines among different lines are two hunks** when a stored result is read: each has its own split. As first planned they were pooled, as they are on `main`, where the pooled parts fit neither hunk and both are asked again at each review. This departs from `main`: two such hunks now keep their splits unasked, so when a higher block leaves their file they are not scored again and are not raised to its score, where on `main` they were.
3. **The surroundings decide only whether the model is asked; what a block keeps is decided by its changed lines alone** (call 6). As first built, each pair of changed lines and surroundings kept its own score. A block back among lines it had been scored among then took that older, lower score, and of two hunks with the same changed lines, editing or removing the higher let the file fall to the lower. Now the history keeps the highest score for the changed lines, as it always did, and beside it the surroundings a score was stored among.
4. **"Among known lines" means that the model was already asked there,** whatever it answered: it scored the block, left it to the file's whole-file score, or split it. As built in the first fix wave, only a score stored among the lines counted. A block the model then left to a whole-file score was asked for again at every review, without end, and a hunk that was split among its present lines and had a score as a whole from elsewhere was kept by its parts, below that score. Now a block the model was asked for among its lines, and whose changed lines have a score, is kept whole at that score.
5. **A hunk with a split stored among its present lines is kept whole, unasked, at the score of its changed lines when they have one,** whether or not the split fits. With no such score and a split that does not fit, it is asked again as one block: it is not stood for, also when it once stood under a whole-file score there, it is held only to the file's floor, and it takes no score from another pull request.
6. **A part of a split hunk that comes to stand as a hunk of its own is asked again,** held to its score. It carried its hunk's surroundings, and alone it has others. Before this plan it kept its score unasked.
7. **The check that drops a lookup answer with other surroundings stays in `review.ts`,** though no test can reach it: the function that uses the answers compares the surroundings as well.

## What the reviews found that the plan had wrong

- **The plan's review.** Decisions 1 and 2; and two costs the plan had not named: after an upgrade, or a merge of the base that changes lines beside a block, a file that was left out as already read is sent again, and in a pull request too large to be read whole a file that finds no room goes to a person.
- **The review of the whole branch.** Decisions 3 and 4; three sentences of the README and of the design that were true only when no score was stored among a block's present lines; and five tests that passed with their code reverted, each of which now fails without it or is named as a pin.

## What the run on a real Postgres showed

One run under Docker on the branch's code as first built (the database code did not change in the fix waves), against a real Postgres, in a network with no way out, with a key made for the run. The previous release came first, on a fresh database; this branch followed on that database.

- The previous release applied its six migrations. This branch added the seventh and one column, and nothing else.
- A row of `block_scores` stored by the previous release reads with no surroundings and is found by no lookup.
- Rows written with surroundings: the lookup found the highest score of the pair asked for, nothing for another pair of the same changed lines, and nothing for the pull request that stored them.
- From inside the network the service answered its health check and could not reach the outside. Its log was six lines, each one JSON object, with none of the run's secrets.
- Everything the run made was removed.

## Verified with a real app and real models

On 2026-11-22 the branch, as it stood after the first fix wave, was tried against the real GitHub App and the private scratch repository of the earlier trials, with a real review model and, for the first time through the service, a real second scorer. The app has no webhook, so each event was posted to the service by hand.

- The service applied the two migrations the trial's database lacked and started with the scorer named.
- **A first review** of a new pull request, whose one change stands among unchanged lines: the review model was called once and the scorer once, for the one block; the block's score was stored with its surroundings, in the run and in `block_scores`; the review and its note were posted.
- **A `/review` on the same head** was a re-check: neither model was called, the block kept its score as one of an earlier run, and no note was repeated.
- **A push that moved the same two lines into another function:** the changed lines hashed as before and the surroundings did not. The scorer was asked for the block again and its score was stored with the new surroundings. Before this plan the block would have kept its score with no call.
- The note of the first review was not given again for the moved block: a note goes by the changed lines, which this plan left alone.

**Still not verified with a real model**

- A block asked again and scored lower than its stored score, so that it is held: the scorer did not answer lower.
- The first review after an upgrade of a pull request whose stored scores have no surroundings.
- A split hunk, a whole-file score, a score from another pull request, a renamed file.

## Known and left as they are

- The surroundings are the few unchanged lines a hunk shows. Lines moved to where the neighbours read the same are not told apart, and a hunk with no unchanged line, as in a new file, has none (call 5).
- The lines an incremental review shows as removed are still told by the changed lines alone (call 5).
- After an upgrade every block of an open pull request is scored again once and every file is sent again; in a pull request too large to be read whole, a file that finds no room goes to a person (call 4). The same holds, for the files concerned, after a merge of the base that changes lines beside their blocks; such a push can get a review where it told nothing new before.
- When the hunk of a split block stands among other lines, its parts are not held one by one: the hunk is asked again as one block, and the parts' scores are the file's floor, as when a split hunk is edited (call 3). Not while another hunk with the same changed lines still keeps those parts: the hunk asked again is then not raised at that review, and the other hunk carries the file.
- An added file that was left to a whole-file score, and whose lines are also a split hunk of another file, can score below what it had before this plan when it is added again under a new name: its history is found by the changed lines, and none of it was stored for a hunk of its own.
- When a block is held to its own stored score, the review's tag reads as for the floor: "a block this file lost had scored".
- A score stored by another pull request is reused only for the same surroundings, and nothing holds a block to a score another pull request stored among other lines.
- A stored `around` that is an empty string is stored as it is; the engine never writes or asks for one.

## Not verified

- Two jobs of one pull request at once.
- The eval commands with a history: replay passes none.
