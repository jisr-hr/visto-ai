# Notes: The UI's Sign-in and Activity plan

These notes record what happened while `2026-11-25-the-ui-sign-in-and-activity.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan file was corrected as the build went, so it states the rules as built; its changes are marked "(as built)". This plan is the first of stage 10 of the build order (the UI, design 7, item 1), cut in two: sign-in, serving, the layout and the Activity screen here; the page of one review next.

## Status

- The plan was drafted from the UI's design and its approved mockups, and reviewed by another model before anything was built. That review found nothing critical and five important points (a config example the tests would have broken, a test harness that could not take the new keys, a removed login keeping its session when a team is named, unauthenticated requests able to take every database connection, and Node 26's own `localStorage` hiding jsdom's in the frontend's tests) and eighteen smaller ones. All were ruled on and applied before the first line of code.
- Tasks 1 to 11 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer in a separate checkout of the task's commit. The reviewers ran the code as an attacker would (forged states and cookies, path tricks, header injection, links that loop, a database that fails at each step), compared the old and new HTTP listener over raw requests, and made one-line changes to the code to see which tests would notice. Seven fix rounds followed; each was reviewed again until clean.
- Task 12's documents were written from the code as built. A review of the whole branch, on the strongest model the build had, found nothing critical or important and four smaller points; those and the eleven small points left during the build were fixed in one wave, reviewed again (44 one-line changes to the fixed code, every one caught by a test). The run under Docker was made last, on the final code, by an agent of its own with throwaway secrets.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **The engine's timing is unchanged** (Task 3): a batch's end is told through a callback `runBatch` calls just before it returns, with no wait added. A first version added one wait for every deployment; over 4,000 seeded reviews, 115 came out differently (the order of requests or of log lines, and in 58 one request fewer after a stop for credentials or credit). As built, the same 4,000 reviews match the engine before this plan exactly, with or without a listener.
2. **Every call of sign-in ends after 10 seconds** (Task 4, and the team read in the fix wave): the code exchange, the user read, the installation read and the membership read; a timeout is `github_network`. Without it a GitHub that does not answer could hold one of the two sign-in places for minutes.
3. **Every answer of the UI's routes carries the four security headers,** the listener's own `busy`, too-large and failure answers included (Task 5); an answer Node refuses to write becomes a plain 500 with its own length, and the connection closes.
4. **The built folder is read by hand and never follows a link to a folder** (Task 5): two links that loop made Node's recursive read run without end, so the service never started.
5. **The client secret cannot reach sign-in by type** (Task 8): handing the whole `ui` config to it is a compile error.
6. **With the UI off nothing of it is read,** the app check included: it asks for Members read only when the UI is on and names a team (Task 8).
7. **The requester shown is whoever wrote `/review` or `/done`** (call 13), also a commenter who may not command (the job is refused when it runs): that login is on the pull request for anyone who can see it. A re-run's requester is not sent (the page does not show it).
8. **A search holding a NUL is a bad request** (Task 7), and the search box takes at most 100 characters, the API's own limit (Task 11).
9. **A filter that hides every running job says so** (Task 11): `Nothing running or queued matches.`; the counts stay over all jobs, as the sidebar's.
10. **A title links only to an `https://` address** (Task 11). The service always builds one; this is a guard.
11. **A database failure during the session read is a failure, not a sign-out** (fix wave): the page shows `Not updating` and the line is logged; before, every open page went to the sign-in page and nothing was logged.
12. **A withdrawal is listed only after a failed try** (fix wave): one pending after a crash's recovery read as a failure that did not happen.
13. **No theme flash** (fix wave): a small script of the UI's own, loaded first, applies a stored theme before the page paints. The policy needed no change.
14. **The UI's links stay in the UI** (fix wave): a link outside `/ui/` is left to the browser, and the router ignores one.
15. **The README does not claim that sign-in requests cannot take the database's five connections**: the UI's 2 and 4 places can send six short statements at once. Each holds a connection for one statement, so the others wait in the pool; the README says so.
16. **The screenshots of the run are kept out of the repository** and shown to the owner instead: the repository keeps the approved mockups, and pictures of a stub's data would add weight and nothing true of the code.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the previous release (`main` as of pull request 20, with the same thirteen migrations as `main` today), then this branch on its database (the ledger gained `0014_ui`, the old rows read with no title, stage or code), then the previous release again, which refused to start (`unknown_migration_applied`); with the UI off, `/`, `/ui/` and `/api/me` were not found, with the headers as before; a `ui` block without the three keys sign-in needs stopped the start with the three issues and no value printed. With the UI on, in dry run, behind a stub answering as `github.com` and `api.github.com` with a certificate of a CA made for the run: every header of call 17, hashed assets kept a year, the index never stored; a real Chromium (Playwright 1.65.1) signed in with PKCE (the stub found the verifier matched the challenge, the parameters sent as a form) and landed on `/ui/`; Activity showed `Stopped`, `Queued` (with reviews paused by a spend limit the run set) and `Waiting for pushes to settle`, the withdrawal line, two pages of reviews, the outcome and repository filters and a search; the theme held across a reload, and a stored theme was on the page before its script ran, on a system of the other theme, both ways; sign-out deleted the session; a login not listed read `This GitHub account may not open this page.`; no policy violation was reported; five reads sent at once while the session table was locked left one answered 503 `busy` at once and four answered once the lock was released; one dry-run review against the stub and a model stub that waited 20 seconds was seen as `Reviewing` `batch 1 of 1`, then in Recent reviews. Every log line kept was one JSON object and none held a secret, a cookie's value, a code, a state, a token or the login.

## What was checked against GitHub

Nothing. A real sign-in needs the app's callback URL and client secret set on GitHub, and the owner at the browser.

## For the owner to decide

1. **Before a real sign-in:** on the app's settings page, the callback URL `<ui.publicUrl>/api/auth/callback`, a client secret in the variable `app.clientSecret` names, the client ID in `app.clientId`; with `ui.team`, the app installed on that organisation with Members read; the service served over HTTPS at `ui.publicUrl`.
2. **A try against GitHub** on the scratch app (plan, "To verify", 1 to 4 and 7): it needs the owner at GitHub's page.
3. **Rulings he may want to change:** decisions 7, 9, 13 and 16 above, and the plan's calls 1, 11, 14, 19 and 24.
4. **Known limits:** a login of an Enterprise Managed User (with an underscore) cannot sign in; `ui/` uses ESLint 9.34.0, which npm reports as no longer supported (lint only); npm does not run the install scripts of `esbuild` and `@tailwindcss/oxide`, and the image and the UI build without them.

## Known and left as they are

- A job the review itself put back because the head moved reads `Waiting to try again` (a label only).
- A withdrawal pending after a crash, with no failed try, is not listed until a try fails.
- Two sign-ins started at the same moment can pass the cap of 1,000 live states by one.
- The frontend's lint keeps the UI from importing the service's code through static imports only.
- The guard that keeps `runBatch` from rejecting if its end callback throws has no test that can fail: nothing reachable throws there.
- On a narrow window the Took and When cells of Recent reviews wrap onto two lines (`1 min 11` then `s`).
- `Preparing` lasts a few milliseconds and is rarely seen by the 5-second read.

## Not verified

- GitHub itself: its token exchange, PKCE and form parameters for a GitHub App, the user read with the user's token, the installation and membership reads, and a member of a child team (plan, "To verify").
- A sign-in through a team, `http://127.0.0.1`, and browsers other than Chromium.
- `Judging threads`, `Publishing` and `Waiting to try again` seen live, and a withdraw job running.
- One log of the run (the first start with the UI on) was lost before it was searched; its seven lines, read on screen, were JSON.
- Rate limits beyond the caps.
