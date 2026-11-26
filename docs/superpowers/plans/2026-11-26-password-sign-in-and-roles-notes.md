# Notes: The Password Sign-in and Roles plan

These notes record what happened while `2026-11-26-password-sign-in-and-roles.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan file was corrected as the build went, so it states the rules as built; its changes are marked "(as built)". The owner asked for this change after the UI's first plan was merged: some deployments do not want a GitHub callback URL, so the UI gains accounts of its own with a password, beside GitHub sign-in, and two roles, Admin and Viewer, managed in the UI.

## Status

- The design was played back to the owner in conversation and approved, then written (`docs/superpowers/specs/2026-11-26-password-sign-in-and-roles-design.md`) and checked by a reader asked only what a builder would still have to guess; its two questions were settled as the builder's calls in the design (who counts toward the last admin; names kept in a database record of changes, never in log lines). The owner approved the design and the plan.
- The plan was reviewed by another model before anything was built. It found one critical hole (a reset or a password change did not end a sign-in already being checked: a session could be made from the old password after the reset) and four important points (two steps of the run under Docker that could not show what they claimed, a role change that could not tell "changed" from "already", and a contradiction in how a password change fails). All were ruled and applied before the first line of code.
- Ten code tasks were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer in a separate checkout of the task's commit. The reviewers ran the code as an attacker would (requests sent at once, forged origins, timing, mutants of every rule). Four fix rounds followed (Tasks 2, 4, 8 and 9), each reviewed again until clean; the other tasks' smaller findings waited for the fix wave.
- The documents were written from the code as built. `main` gained another pull request meanwhile and was merged into the branch with no conflict. A review of the whole branch, on the strongest model the build had, found nothing critical or important beyond the items already queued; those and the items set aside during the build were fixed in one wave of two parts, reviewed again (76 one-line changes to the code, every one caught by a test but one, then pinned). A last small round followed. The run under Docker was made by an agent of its own, on the code after the wave.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **A verify begun before the wait cannot win** (Task 4): tries sent at once were each checked against the account's hash before any was counted, so after four wrong tries a wrong and a right one sent together signed in and cleared the wait. The right try's write now also requires that the account is not waiting at that moment.
2. **A new password is well formed and holds no NUL** (Task 2): scrypt ignores trailing NUL characters and reads every lone surrogate as the same character, so `'\0'` twelve times would have matched an empty password. Checking a password at sign-in is unchanged.
3. **The hash made at start for unknown names is made again when it failed** (fix wave): a start hash that failed once made unknown names answer 500 while known names answered 401, which told names apart. While it cannot be made, every name answers 500 alike.
4. **The command makes no GitHub admin while GitHub sign-in is off** (fix wave): such an admin could never sign in but would count toward the last admin, so the only password admin could step down.
5. **A sign-in refused for its origin is logged** (Task 6): an operator behind a proxy that rewrites `Origin` would otherwise see password sign-in fail with no line saying why. The line holds no name.
6. **A dead one-time password is never sent again** (Task 8): on the choice of a first password, an answer that the one-time password is refused, expired or already used goes back to the first step with the name kept; pressing again had made the account wait 15 minutes.
7. **A late answer applies only to the session that asked** (Tasks 8 and 9, fix wave): on a browser where one person signed out and another signed in, a slow answer meant for the first could show the second the first's name and Settings, or sign them out.
8. **Small guards on the screens**: an empty current password is not sent; the command's `make` and `reset` take a name in any letter case; the name is kept with the one-time password; the hidden username on the choice form for password managers; the row buttons of Accounts name their account for screen readers; focus follows the controls that disappear.
9. **The screenshots of the run are kept out of the repository** and shown to the owner, as in the plan before.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the release before this one, then this one on its database (the ledger gained `0015_accounts`, the old sessions were gone, and the release before then refused to start, `unknown_migration_applied`); with `ui.publicUrl` alone, no GitHub sign-in and its routes not found; the `accounts` command made the first admin in the service's container, printed its one-time password once, refused a second make (`name_taken`) and a bad call (the usage line), and exited on its own every time; a real Chromium (Playwright 1.65.1) signed the admin in with its one-time password, chose a password, made a viewer and copied its one-time password through the clipboard; the viewer saw no Settings and the admin routes answered it `forbidden`; a role changed at the person's next request; after five wrong passwords the account waited, its right password refused too, and a reset ended the wait and the sessions; a wrong password, an unknown name and a waiting account were refused in medians of 62.97, 61.15 and 62.20 ms (at most 3% apart, on one machine); a sign-in from another origin or with none was refused 403 and logged, and one that was not JSON 415; two admins demoting each other at once both waited on the lock (`pg_stat_activity` read 2), one was answered 200 and the other `forbidden`, and one admin was left; a password change ended the other session and kept its own; a removal ended the removed account's sessions; GitHub sign-in worked beside it against a stub, the GitHub login started as a viewer, and the command made it an admin. All 122 log lines of the branch were one JSON object each and none held a name, a password, a one-time password, a hash, a cookie's value or a token.

## What was checked against GitHub

Nothing. GitHub sign-in was tried against a stub only, as in the plan before.

## For the owner to decide

1. **The first admin:** in the service's container, `npm run --silent accounts -- make --config <the config> --name <name> --role admin` prints a one-time password, to be used within 72 hours. The migration signs everyone out once, and the release before cannot start on the migrated database.
2. **Rulings he may want to change:** decisions 4 and 5 above; the plan's calls on the one-time password (72 hours, 20 characters), the wait (five tries, 15 minutes), the password rule (12 to 128 characters), and who counts toward the last admin.
3. **A real GitHub sign-in** still needs the app's callback URL and client secret set on GitHub, as before.

## Known and left as they are

- Someone who knows a name can keep that account waiting by sending wrong passwords; an admin's reset ends the wait.
- Turning GitHub sign-in off, or removing a login from the file, while a GitHub admin is the only admin leaves only the command as the way back in.
- Enterprise Managed User logins (with an underscore) still cannot sign in through GitHub.
- The sidebar's account block is cramped at common widths: a name such as `octo-admin` breaks at its hyphen and the lines under it wrap (seen in the run's screenshots).
- PGlite runs one transaction at a time, so the lock is pinned in the tests by its place only; the run under Docker showed it on Postgres.
- The last small round (a test of the command with GitHub sign-in on, one README sentence, and focus after a make and a removal) came after the run under Docker.

## Not verified

- GitHub itself; browsers other than Chromium; password managers; screen readers.
- The time of refusals on other hardware; the measured cost of a password check (about 47 to 50 ms and 33 MiB) on one machine only.
