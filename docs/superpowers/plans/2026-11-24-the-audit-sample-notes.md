# Notes: The Audit Sample plan

These notes record what happened while `2026-11-24-the-audit-sample.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan file was corrected at the end of the build, so it states the rules as built; its changes are marked "(as built)". This plan is the second and last of stage 9 of the build order: with it, automatic approval draws its audit sample (design 6.5, D9), and the refusal of the plan before (approval only with a share of 0) is gone. What is left of the build order is the UI.

## Status

- The plan was drafted from the design, the plan of automatic approval and its notes, and the code, and reviewed by another model before anything was built. That review recomputed every test vector and every count from the plan's definition, and they matched; it found nothing critical, one important defect (the key `env.example` showed would have passed the length check, so a deployment that uncommented it would have drawn with a key printed in the public repository) and eleven smaller points. All were ruled on and applied before the first line of code (decisions 8 to 10).
- Tasks 1 to 4 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer in a separate checkout of the task's commit. The reviewers ran the code: damaged shares, keys and identities fed to the draw, the draw's comparison checked at its exact boundary, the vectors recomputed, and one-line changes to the code to see which tests would notice. Every task's code was approved at its first review.
- Task 5's documents were written by an implementer from the code as built and reviewed against the code; that review found one sentence the code did not keep (decision 12), and the documents were corrected. The run under Docker was made by an agent of its own with throwaway secrets.
- Then a review of the whole branch, on the strongest model the build had left. It found no path by which a pull request that should be drawn is approved, nothing critical, and nothing in the code to fix; it recomputed the vectors and the draw's boundary. Its one important point was that these notes and the README's account of the run were not yet written, and two sentences of the plan and the design were inexact; all were done in one round of the documents, checked again (decision 14).

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

**Before the plan was written**

1. **One small plan** (call 1): the draw, its sentence, condition 6 at publish, the key in the configuration, the documents.
2. **The draw is pure and keyed** (call 2): HMAC-SHA-256 with the audit key over the pull request's identity as the service stores it (service, owner and repository lower-cased, number), no head and no time; the first four bytes of the digest read as a number, drawn when it falls under the share. Cost: a pull request drawn once is drawn at every head, and the outcome of its first decided head tells its author the outcome of the later ones until the share or the key changes.
3. **The draw is the last condition** (call 3): it is made only when every other condition held, so the label means "would have been approved". Cost: a drawn pull request's review reads the threads and the branch's rule as an approval would.
4. **The label is the review's own text, with the code `audit_sample`** (call 4): no GitHub label, no review request, no new permission.
5. **A missing or short key refuses the start** (call 5), in dry run and for the eval commands too, whenever the defaults or any override, merged with them, has approval on with a share above 0. The eval commands draw nothing and need only some value of the right length, never the deployment's real key.
6. **No migration** (call 6): `approval_code` holds the code. Cost: an audited review adopted by a later start is stored with no code, so it is not counted as an audit.
7. **No new library, no model call, no dropped idea** (call 7).

**On the review of the plan**

8. **The example key is refused on purpose** (call 5): `env.example` shows a value shorter than 32 characters, and a test shows the service refuses it.
9. **What an author can learn, said plainly** (calls 10, 12, 13): the first decided head tells the later ones; a new pull request for the same change draws again (the design's accepted gap); a rename or a transfer that changes more than letter case draws again.
10. **Tests made to tell what they claim** (Tasks 3 and 4): an audited row read by a query of its own; the pull requests' heads split across two tests; the test keys named so they cannot collide with a file's own.

**While building**

11. **A key of 32 spaces is accepted** (Task 4, as the plan says): the service cannot judge a key's randomness, and a long run of one letter would be as weak. The README tells the operator to use a long random secret.
12. **After a rename the service does not see an approval it posted before** (Task 5's review): every record is keyed by the repository's name as GitHub delivers it now, so an approval posted under the old name is not withdrawn by the service; it stands until GitHub's own rule dismisses it at a push, or a person does. This is true of every record since the plan of automatic approval, not new here; the documents said otherwise, and were corrected.
13. **A leftover marker of the reverts plan in the README was removed**, the sentence it guarded having been confirmed by that plan's run.
14. **The last round changed only documents**: the README's account of the run under Docker, the plan's sentence on what can reach the draw on the scratch repository, and the design's rename sentence, which now says a rename of letter case alone does not draw again.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the previous release, then this branch, then the previous release again on one database, each starting and listening, with the thirteen migrations of the plan before and no new one; with approval on at the default share, a missing key, a variable not set, and keys of 19 and 31 characters each stopped the start with its issue and printed no value, in dry run too, and the eval command stopped with the same issue; a key of 48 characters started, and a share of 0 started with no key; inside the image the draw gave the tests' vectors, their nesting across shares and their counts over twenty thousand invented pull requests; no key or other secret was in any log line.

## What was checked against GitHub

Nothing. No review on the private scratch repository of the earlier trials can reach the draw: both reads of the branch's rule answer 403 there, so no review there gets past `rule_unreadable`.

## For the owner to decide

1. **A repository that holds rules** (as after the plan of automatic approval): only there can an approval, and so an audit, be posted through the service.
2. **Rulings he may want to change:** the draw read last (call 3); the label as text only (call 4); the 32-character minimum (call 5); a drawn pull request drawn at every head (call 12).

## Known and left as they are

- The draw's comparison at its exact boundary, a non-ASCII owner and a share such as 0.1 between two draws have no test of their own (the code is exact; the run checked the vectors).
- A pull request record of the wrong shape that does not throw is drawn like any other; records come from the service's own rows.
- A resumed run being drawn, and an audited review over a standing approval asking for a withdrawal, have no test of their own; both are paths the plan of automatic approval tested.
- After a rename or a transfer that changes more than letter case, the service also forgets the history condition 4 reads: a major finding a run under the old name left without a thread no longer holds approval. The app's own threads with no stored row still count as open, so the loss is limited to findings without a thread. Like decision 12, this is true of every record since the plan of automatic approval.
- An `env` name written by mistake as a secret's value is printed in the "is not set" issue, as for every secret given by reference since the first stage.

## Not verified

- An audit through the service against GitHub (item 1 above).
- The run under Docker was made on the code as merged: the rounds after it changed only documents and comments of the example config.
