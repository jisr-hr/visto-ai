# Password Sign-in and Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment whose config writes `ui.publicUrl` alone serves the UI with accounts of its own: a name, a password and a role, Admin or Viewer. The first admin is made by a command run where the service runs, which prints a one-time password once; that person signs in with it, chooses a password and lands on `/ui/`. An admin opens Settings, which opens on Accounts: makes accounts (each with a one-time password shown once), changes roles, resets passwords and removes accounts; the last admin can be neither removed nor made a viewer. A viewer sees every screen but Settings, and the API refuses it every admin route. After five wrong passwords in a row an account waits 15 minutes, and every refusal reads and lasts alike. GitHub sign-in stays beside it when `ui.accounts` or `ui.team` is named: a GitHub sign-in is an account too, a viewer until an admin says otherwise. Every role is read from the database at each request.

**Architecture:** One migration, `0015_accounts`, adds `ui_accounts` (one row per person, both kinds), `ui_account_changes` (the record of changes) and `ui_sessions.account_id`; the sessions of before are deleted. `src/db/ui-accounts.ts` holds every statement on accounts, and every change that can lower the number of admins runs inside `underLock`, a transaction whose first statement locks the accounts table. `src/ui/passwords.ts` is pure: scrypt from `node:crypto`, the one-time password, the name and length rules. `src/ui/password-auth.ts` answers the password sign-in, the first password and changing one's own password; `src/ui/accounts.ts` makes, re-roles, resets and removes, for the API and for the command alike; `src/ui/auth.ts` keeps GitHub sign-in and the session read, which now joins the account and its role. `src/ui/route.ts` adds the routes, the role checks, the JSON and `Origin` checks; `src/shell/http.ts` counts the two new sign-in routes with the sign-in places. `src/ui/accounts-cli.ts` is the command (`npm run accounts`). In `ui/`, the client gains the new calls, the sign-in page a password form and the choosing of a password, the sidebar shows Settings to admins only, and two pages are added: Change password and Settings' Accounts.

**Tech Stack:** Unchanged: Node 26 or later, type stripping, no build step, no new runtime library in `src/` or in `ui/` (scrypt and `randomInt` from `node:crypto`; plain markup with the existing components). One migration, `0015_accounts`. No model call.

**Spec:** `docs/superpowers/specs/2026-11-26-password-sign-in-and-roles-design.md` (whole; "the password design" below), which amends `docs/superpowers/specs/2026-11-25-the-ui-design.md` ("the UI design": 3.2, 4.4, 5, 6, 8) and builds on the merged plan `docs/superpowers/plans/2026-11-25-the-ui-sign-in-and-activity.md` and its notes ("the first plan"), whose calls and "as built" rules stand unless a call here changes them. The look follows `docs/superpowers/specs/2026-11-25-the-ui-mockups/Activity.dc.html` (components, tokens) and `Settings.dc.html` (the Settings page's header). Section numbers below are the password design's unless written otherwise.

**Notes:** the notes file beside this plan is written when the build ends.

**Words used below.** *The UI on*: the loaded config has `ui` (Task 1) and the service was given `ServiceDeps.ui` (Task 6). *GitHub sign-in on*: the UI on, `ui` names an account or a team, and the service was given a `ForgeSignIn`. *An account*: a row of `visto_ai.ui_accounts`, of kind `password` or `github`. *Chose its password*: a password account whose `one_time_until` is null. *A counting admin*: an admin of kind `github`, or of kind `password` that chose its password (4.2). *The lock*: `lock table visto_ai.ui_accounts in share row exclusive mode`, the first statement of `underLock`'s transaction. *A one-time password*: 20 characters drawn by `oneTimePassword()`, stored as a password hash with `one_time_until` set. *Waits*: `wait_until` is after the clock. *The hash made at start*: the hash of 32 random bytes that `createPasswordAuth` makes once, at the cost it is given. *The actor*: who makes a change: a session (read again under the lock) or the command. *An admin route*: `GET /api/accounts` and the four `POST /api/accounts/...`. *The token for changes*, *a session*, *short code*: as in the first plan. *COST*: `{ log2N: 4, r: 1, p: 1 }`, the cost every test passes.

## Scope

| In this plan | Left out, and why |
|---|---|
| The UI on with `ui.publicUrl` alone; GitHub sign-in on with accounts or a team (4.1) | **The Settings screens and settings in the database** (UI design 7, plan 2): the other sections stay "come in a later plan" |
| Accounts, roles, the record of changes, sessions that belong to an account (4.2, 4.5, 4.8) | **A screen for the record of changes** (6): the README gives the statement that reads it |
| Password sign-in, one-time passwords, the first password, changing one's own, resets, the wait (4.3) | **Email, invitations, "forgot password", two-factor, more roles, per-repository rights, renaming an account** (3, 6) |
| GitHub sign-ins as account rows, viewers by default (4.4) | **A wait per address** (6): rate limits beyond the caps stay the proxy's |
| The API's role checks and the `Origin` check (4.5) | **The review page** (the UI's plan 1b) |
| The command for the first admin and the way back in (4.6) | |
| The sign-in page, the sidebar, Change password, Settings' Accounts (4.7) | |
| The logs, the README, the config example, the designs, a run under Docker | |

**Dry run:** changes nothing here; accounts and roles work the same.

## Not in this plan

- Settings in the database, the record of setting changes and its screen (the UI's plan 2), the other screens (plan 3), the review page (plan 1b).
- A screen for the record of account changes (6); email of any kind; a wait per address.
- Any dropped idea (no finding verifier, no repository-wide context packs, no recall-first contract, no lens pass), and any model call.

## Calls

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where a design says otherwise, the call says so.

**The cut and the rules of the build**

1. **(builder) One plan of eleven tasks**, which ends with the whole of section 4 shown under Docker. Cost: a plan near the size of the first one; the record of changes has no screen until the Settings plan.
2. **(builder) No new library**, at runtime or in `ui/`: `scrypt`, `randomBytes`, `randomInt` and `timingSafeEqual` from `node:crypto`; the confirmations and the one-time password are plain markup in the page with the existing components (button, card, badge, table, input, native select), never `<dialog>`: the policy forbids inline styles and scripts, and jsdom 26.1.0, the tests' DOM, has no `showModal` (its `HTMLDialogElement` is empty). Cost: no focus trap; a confirmation is a line in the row that asked for it.
3. **(builder) One migration, `0015_accounts`.** It deletes every `ui_sessions` row first (they hold a login and a way in but no account), so everyone signs in again once. The previous release refuses to start on the migrated database (`unknown_migration_applied: 0015_accounts`), as after every migration. Cost: one sign-in for everyone; no way back to the previous release.
4. **(builder) Tests never reach the network,** as before. scrypt's cost is a parameter (`cost`, a `PasswordCost`) that every test passes as COST; the production cost is `PASSWORD_COST` and is never changed for a test. One test hashes once at `PASSWORD_COST`, so the production parameters are shown to run on Node. Cost: the other tests exercise a hash 2,048 times cheaper than production's.
5. **(builder) No dropped idea returns; no model call.**

**Configuration and the store**

6. **On.** The UI is on when `ui` writes `publicUrl`, names an account, or writes a team (4.1). GitHub sign-in is on when `ui` names an account or a team, and then `publicUrl`, `app.clientId` and `app.clientSecret` must be written, refused by name as today. `UiConfig` keeps its five keys; `clientId` and `clientSecret` become `string | null`, null exactly when GitHub sign-in is off (a client id or secret written without accounts or a team is read, as today, and not carried). Cost: a config that wrote `ui: { publicUrl }` alone, off until now, turns the UI on at the next start, with nobody able to sign in until the command makes an admin.
7. **The tables** (Task 3 holds the exact SQL). One table for both kinds, `ui_accounts`, with identity ids; one unique index `(kind, lower(name))` gives both uniqueness rules of 4.2 (a password name is lower-case by its rule, a GitHub login unique letter case aside, the two kinds apart). A password account's hash, its one-time password's end, its wrong tries and its wait live on its row; checks refuse a password account with no hash and a GitHub account with one. `ui_sessions` gains `account_id`, deleted with its account (`on delete cascade`); its `login` stays, holding the account's name at sign-in, and is never read back. Cost: one redundant text column kept so the first plan's statements and tests stand.
8. **The last admin** (4.2) is checked under the lock: `underLock` is one transaction whose first statement is the lock (`share row exclusive` conflicts with itself and with every write, not with reads), so every change to a role, a reset, a removal, an account made and a GitHub row made runs one at a time. Under it the actor is read again from its session (none: `signed_out`; a viewer: `forbidden`), then the target, then the count of counting admins other than the target: none, and the target is an admin about to be made a viewer or removed, refuses `last_admin`. **Tested three ways:** a spy shows the lock as each change's first statement; two admins making each other viewers at once (`Promise.all`) leave one admin on PGlite; and the run under Docker does the same on Postgres, `psql` holding the lock in the code's own mode (`share row exclusive`) until `pg_stat_activity` shows both requests waiting on the lock statement, then committing within the pool's `statement_timeout` (15 s, `POOL_OPTIONS`). Cost: sign-ins' own writes (a wrong try, a right one's transaction of call 17) wait while a change holds the lock; the hashes are made before it, so it is held for a few statements.
9. **A reset is not a role change** (the design is silent): the last-admin rule does not refuse it, and it ends the account's sessions (4.3). **The UI refuses an admin's reset of their own account** (409 `own_account`), so a reset made in the UI never touches the actor, who is always a counting admin: no reset made in the UI can leave no counting admin, and a one-time password lost on the screen cannot lock the last admin out. The command may reset any password account: it is the way back in (4.6). Cost: an admin who wants a new one-time password for themselves asks another admin or runs the command.
10. **The record of changes** (4.8): one row per change, with `by_kind` `password`, `github`, `command`, or `sign_in` (the design is silent on who makes a GitHub row at its first sign-in: `sign_in`), the names as text, and the new role (null for a removal). A first password chosen is recorded as `password_changed`, made by the account itself. Cost: a reader tells a first password from a later change only by the `reset` or `made` row before it.

**Passwords**

11. **The hash** (4.3): scrypt with N = 2^15, r = 8, p = 1, a 16-byte random salt and a 32-byte key, written `scrypt$<log2 N>$<r>$<p>$<salt>$<key>` (base64url, no padding) and compared with `timingSafeEqual`. **`maxmem` is `256 * N * r` bytes (64 MiB at production cost): Node's default of 32 MiB refuses N = 2^15 with r = 8** (OpenSSL counts `128 * r * (N + 2)` bytes and more). A stored value names its own parameters; one whose p is not 1, whose log2 N is outside 4 to 15 or r outside 1 to 8, whose log2 N is 15 with an r other than 8, or that is not of that form, verifies nothing, so a row written by hand cannot make a verify cost more than production's (COST, log2 N 4 with r 1 and p 1, is accepted; scrypt also needs N below 2^(16 r), which every accepted pair is). (as built) A new password is 12 to 128 characters counted as code points, well formed (no lone surrogate) and with no U+0000 (NUL), not normalized: scrypt pads a key shorter than 64 bytes with zero bytes and writes every lone surrogate as U+FFFD, so either would make two passwords one. A password typed at sign-in is verified whatever it holds. Cost: about 32 MiB and 50 to 150 ms of one of libuv's 4 threads per hash or verify, so at most about 128 MiB at once; a password typed in another Unicode form does not match, and one with a lone surrogate or a NUL cannot be chosen.
12. **The one-time password** (4.3): 20 characters from `23456789abcdefghjkmnpqrstuvwxyz` (31 characters, no `0`, `1`, `i`, `l`, `o`, no capitals), each drawn by `randomInt(31)`, which Node documents as free of modulo bias: about 99 bits. It is stored only as its hash in `password_hash`, with `one_time_until` 72 hours after it was made, and answered once (by the route that made it, or printed once by the command). Cost: a person types 20 characters once.
13. **The first sign-in** (4.3): a right one-time password at `POST /api/auth/password` answers `{ "next": "choose_password" }` and makes no session; the page keeps the name and the one-time password in its memory and sends them again with the new password to `POST /api/auth/first-password`, which verifies the one-time password again and then, in one transaction, sets the new hash only over the hash it verified (a reset meanwhile wins: 401 `refused`) and makes the session (call 17). Cost: the one-time password stays in the page's memory until chosen (as built: or until a refusal after which it cannot work, `refused`, `expired` or `already_chosen`, which sends the page back to the first step; Task 8 rule 5); two verifies for a first sign-in.
14. **The wait** (4.3): the count lives on the account's row (`failed_tries`). A wrong password adds one; the fifth sets `wait_until` to the clock plus 15 minutes and the count back to 0. While it waits no password is verified against it. (as built) Nor does a verify begun before the wait started write anything: `rightTry` and `setOwnPassword` (call 17) also require that the account does not wait at the clock the request read, so of tries sent at once, each verified against the account's hash, none signs in, chooses a password or changes one once another started the wait. The count and the wait are cleared by a right password, a reset (UI or command) and a change of one's own password. The clock is the service's (`deps.clock`, `new Date()` in production), not the database's. Cost: someone who knows a name can keep that account waiting (an admin's reset ends it); a clock set back lengthens a wait.
15. **One sentence and one time for every refusal** (4.3): an unknown name, a name of another shape, a GitHub login typed as a name, a wrong password and an account that waits all answer 401 `refused` after exactly one verify: the account's hash for a wrong password, the hash made at start for the rest. **The design says every refusal reads alike; an expired one-time password reads `expired`, but only after the right one-time password was verified,** so it tells nothing to someone who does not hold it. Cost: an unknown name costs a verify like a known one; a wrong password's write (`wrongTry`) waits on the lock while an account change holds it (about a millisecond), which an unknown name's refusal does not.
16. **Typed names are trimmed and lower-cased** before the rule and the look-up at sign-in (a phone may capitalise the first letter); an account is made only with a name that already matches the rule. Cost: none known.

**Sessions, routes and roles**

17. **Sessions** (4.5): a password sign-in makes the same session as GitHub's (the cookie `__Host-visto_session`, 12 hours, the token for changes), with `via` `password`, **in one transaction** whose first statement clears the count and the wait only over the hash that was verified and, as built, only while the account does not wait at the clock the request read (`rightTry`; for a first password `setOwnPassword`, over the one-time password's hash) and returns the row, then makes the session and writes the last sign-in; when no row comes back the answer is 401 `refused` and no session is made, so a reset, a change of password or a wait committed while the sign-in verified wins over it. The session read joins the account, so the role, the kind and the name are the row's at each request, and a removed account's sessions are gone with it. A password session holds while its account is a password account; a GitHub session as the first plan says. Changing one's own password deletes the account's other sessions; a reset deletes all of them. Expired rows are also deleted at a password sign-in or a first password, once its body holds, at most once a minute between the two, so a deployment without GitHub sign-in deletes them too. Cost: none new.
18. **GitHub rows** (4.4): a GitHub sign-in let in by the file finds its account by login, letter case aside, writes its name as GitHub writes it now and its last sign-in; with none, it makes one as a viewer, made by `sign_in`, under the lock. With 1,000 accounts and none of its own it is refused (`full`, a new reason on the sign-in page; 4.2's cap). Cost: a login freed and taken by someone else gets the row's role (4.2, unchanged).
19. **The routes** (Task 6 holds the exact JSON): `GET /api/auth/ways`, `POST /api/auth/password`, `POST /api/auth/first-password` (no session); `POST /api/me/password` (a session and the token); `GET /api/accounts` (a session and the admin role); `POST /api/accounts/new`, `/role`, `/reset`, `/remove` (a session, the token and the admin role). The account to change is named in the body by its id, never in the path, so the route table keeps one method per exact path. `GET /api/me` gains `kind` and `role`, and its `login` is renamed `name`. Cost: the paths are not REST-shaped; three frontend fixtures and the layout change with `Me`.
20. **Roles are the API's** (4.5): every admin route answers a viewer 403 `forbidden`, whatever the page shows; checks run in this order: a session (401 `signed_out`), the token for a change (403 `csrf`), the role (403 `forbidden`), the body (415 `not_json`, 400 `bad_request`), then the work, whose actor is read again under the lock. Cost: none known.
21. **The `Origin` check** (4.5): the two routes that change something without a session need `Origin` exactly equal to `ui.publicUrl` (403 `origin`) and a `content-type` of `application/json` (415 `not_json`), checked before anything else. Every other route that reads a body needs JSON too. Browsers send `Origin` on every `POST` (the run under Docker shows Chromium does). Cost: a script must send the header; a proxy that rewrites `Origin` breaks password sign-in.
22. **Places** (4.5): the two new routes that sign in (`/api/auth/password`, `/api/auth/first-password`) count against the sign-in routes' 2 places, with `/api/auth/start` and `/api/auth/callback`; `/api/auth/ways` and every other new route against the API's 4, so a flood of password tries cannot hide `Sign in with GitHub`. Cost: two password sign-ins at once at most (each about 100 ms of scrypt); a flood of them holds sign-in off, as a flood of GitHub starts did.
23. **The command** (4.6): `npm run accounts -- <make|reset|github> --config <path> ...` (Task 7 holds its arguments, lines and exit codes). It reads the config with the service's own `loadConfig`, so every variable the file names must be set, as for the service, and uses only `database.url` (**the design says it reads only the database's address: it uses only that**); it never migrates and refuses a database without `0015_accounts` (`not_migrated`); it writes no log line (its database is opened with a no-op log), its changes are in the record as `command`. Cost: run where the service's variables are set.

**Logs and screens**

24. **Logs** (4.8): `ui_signin` gains `way` (`github` or `password`); a password line's outcome is `ok`, `choose`, `refused`, `expired`, `already_chosen`, `bad_request` (its reason the code answered) or `failed` (its reason the short code), and a refused one has reason null; GitHub's gain the outcome `full`. `ui_account`: `{ event: 'ui_account', change, role }` once per change made through the service, a GitHub row made at sign-in included (logged once the row is made, so also when its session then fails). `change` itself writes no line on a failure: the route logs it as `ui_failed`, while `signIn` and `firstPassword` answer and log their own as `ui_signin` `failed`. No line ever holds a name, a login, a password, a one-time password, a hash, a session id or a token. Cost: who did what is read from the record, not the log.
25. **Screens** (4.7; texts pinned in Tasks 8 to 10): the sign-in page has a name, a password and `Sign in`, and `Sign in with GitHub` under it only while `GET /api/auth/ways` says GitHub is on; a right one-time password turns the card into the choice of a password. The sidebar shows Settings to admins only; the user block says how the person signed in and, for a password account, links `Change password`, a page of its own (`/ui/password`). Settings opens on Accounts: the table, `New account`, and per row change role, reset password and remove, each confirmed or answered in the page; a one-time password is shown once in a box with `Copy` and `Done`, and is gone after `Done` or a reload. After each change the list is read again. A viewer at `/ui/settings`, and a GitHub account at `/ui/password`, see the not-found page; an answer 403 `forbidden` makes the app read `/api/me` again (as built: its answer applies only while the session that asked is still the one signed in, Task 9 rule 3), so a demoted admin keeps the Settings entry until their next request to an admin route answers 403 `forbidden`, and loses it then. Cost: no mockup was drawn; the confirmations are lines in a row.
26. **The run under Docker** (Task 11) adds to the first plan's: the command inside the app's container, Playwright's Chromium for the screens (its contexts granted the clipboard), `psql` for the lock, `node -e` with `fetch` inside the app's container for the `Origin` checks and the timing of refusals (the image, `node:26-bookworm-slim`, has no `curl`), and the stub of GitHub of the first plan for GitHub sign-in beside passwords. Cost: what GitHub itself answers stays unverified.

## For the owner

1. **Cannot be undone:** the previous release refuses to start on a database this release has migrated, and every session of the first plan is deleted by the migration: everyone signs in again once.
2. **The first admin, where the service runs** (Task 7): `docker compose exec app npm run accounts -- make --config /config/config.yml --name <name> --role admin` prints a one-time password once; open `<ui.publicUrl>/ui/signin` within 72 hours, sign in with it and choose a password. With GitHub sign-in only: `... accounts -- github --config /config/config.yml --login <login> --role admin`, before or after that person's first sign-in. The same command is the way back in if every admin's password is lost (`reset`).
3. **Password sign-in alone** needs only `ui.publicUrl` (HTTPS, or `http://localhost` on one machine): no callback URL and no client secret.
4. **Who sees what:** a viewer sees every screen but Settings; everyone signed in sees the activity of every repository the app is installed on (the first plan's call 13).
5. **Rulings you may want to change** (each a small change): call 9 (an admin cannot reset their own account in the UI), 13 (the choice of a password in a second request), 15 (the expired sentence), 16 (names lower-cased at sign-in), 18 (the GitHub cap), 22 (the places), 23 (the command reads the whole file).
6. **Not settled, and yours to weigh:** a person is their login (4.2); a wait per address belongs to the proxy; the record of changes has no screen yet.
7. **Still not tried against GitHub** (the first plan's "For the owner", 3): it needs you at the browser.
8. **Two ways in that stay closed** (as built): a GitHub login with an underscore, as Enterprise Managed Users have, still cannot sign in through GitHub (the first plan's); and behind a proxy that rewrites `Origin`, password sign-in is refused as `origin` (call 21).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **The service:** Node 26 or later, npm, no build step, erasable TypeScript only, `import type` for types, relative imports ending in `.ts`, no new library in either `package.json`.
- **ASCII only** in `src`, `contract`, `test`, `examples`, `ui/src`, `ui/index.html`, `ui/public` and `ui/`'s config files. After each task `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test examples ui/src ui/index.html ui/public` prints nothing.
- **No test reaches the network, a real database or a model.** A database is `testDb()`; a clock is passed in; every wait has a bound; every hash in a test is made at COST.
- **Secrets:** a password, a one-time password, a hash, a session id and a token are never logged, put in an error's text, a URL or an answer, but the one-time password in the answer of the route that made it (and the command's one line) and the hash in its own column. No log line holds a name or a login. The client secret stays where the first plan put it.
- **The UI off changes nothing but the migration** (`0015_accounts` is applied whether or not the UI is on): `/`, `/ui/` and `/api/` answer 404 plain as today, and nothing of `ui_accounts` is read (Task 6 `with only the UI's address, the service serves password sign-in alone, and with the UI off nothing of the accounts is read`).
- **Boundaries, by the lint as it is:** `src/ui/**` imports `src/db`, `src/config`, `src/shell` and `src/forge/types.ts`; `src/ui/accounts-cli.ts` may import `../db/postgres.ts` (the lint forbids the `pg` package, not that file). `ui/` reaches `src/` only through `ui/src/api-types.ts`.
- **SQL:** plain SQL in the schema `visto_ai`; a time as an ISO string with `::timestamptz`; a name through `storable()`; no statement of this plan names `visto_ai.pull_requests` or the word `gate`.
- **Every change that can lower the number of admins, and every account made, runs inside `underLock`.** No hash is made inside it.
- **A password session is made only inside the transaction whose first statement is guarded by the hash that was verified** and, as built, by the wait at the clock the request read (`rightTry`, or `setOwnPassword` for a first password; call 17), and only when that statement returned the row.
- **No existing test is edited, but for these,** each named with its exact change in its task: `src/config/load.test.ts` (Task 1); `src/db/ui-sessions.test.ts`, `src/ui/auth.test.ts`, `src/ui/api.test.ts`'s `SESSION`, `src/ui/route.test.ts`'s `a session read that rejects ...` (Task 3); `src/ui/route.test.ts`'s harness and `a person signs in ...`, `src/ui/api.test.ts`'s `me holds ...` and `ME`, `src/service.test.ts`'s `uiDeps()`, `a member of the team signs in ...`, and the three frontend `ME` constants (Task 6); the three frontend `fakeApi`s, `ui/src/app.test.tsx`'s `any read answered 401 ...`, and `ui/src/pages/sign-in.test.tsx`'s two tests (Task 8); `ui/src/app.test.tsx`'s `each sidebar entry ...` and, as built and ruled, `ui/src/components/layout.test.tsx`'s `a viewer at /ui/settings and a GitHub account at /ui/password see Not found`, whose admin case expects the Accounts section in place of `Coming in a later plan.` (Task 10). Fields added to `Session` and `Me` are required, and every literal of them is named above. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test` in `src`, Vitest in `ui`. `at(seconds)` from `2026-03-01T10:00:00.000Z`; password accounts `octo-admin`, `octo-viewer`, `octo-new`; GitHub logins `octo-lead` and `octo-dev` as in the first plan; passwords `a long password of mine` and `another long password`; `ui.publicUrl` `https://visto.example.test`; another origin `https://other.example.test`. Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **Two changes at once around the last admin,** and an admin demoted or removed while their request waits for the lock. Task 3 `every change runs after the lock, as its transaction's first statement`; Task 5 `two admins making each other viewers at once leave one admin` and `a viewer, a removed session and an expired one change nothing, read again under the lock`.
2. **An admin who does not count:** a password admin that has not chosen a password, used to step down. Task 5 `the last admin cannot be made a viewer or removed, and an admin who has not chosen a password does not count`.
3. **A refusal that tells more than it should:** an unknown name, a name of another shape, a GitHub login typed as a name, a wrong password, an account that waits, by sentence, status or work done. Task 4 `a wrong password, a name that does not exist, a name of another shape and an account that waits are refused alike, each after one verify, the unknown and the waiting against the hash made at start`.
4. **A password in the wrong place:** a log line, an answer, an error, a row, the command's output. Task 4 `no answer, log line, row or error holds a password, a one-time password, a hash or a name, but the hash in its own column`; Task 7 `no line but the one-time password's holds a secret, and the command logs nothing`.
5. **Another site's page:** no `Origin`, another `Origin`, `text/plain`, a form body, an array. Task 6 `the password sign-in and the first password need the public origin and JSON, and say so before reading anything`.
6. **The one-time password misused:** expired, reset meanwhile, sent again after a password was chosen, typed as the new password, reused after a reset. Task 4 `a right one-time password asks for a password and makes no session; an expired one is refused as expired`, `a first password whose one-time password was reset meanwhile is refused`, `a first password for an account that chose its own already is refused as already_chosen`.
7. **A viewer reaching an admin's data** through the API, a role changed mid-session. Task 6 `a viewer is refused every admin route as forbidden, whatever it sends, and a change without the token is csrf first` and `a role changed takes effect at the next request of the session it was changed for`.
8. **Names that collide:** a GitHub login and a password name alike, letter case. Task 3 `a password account's name is unique, and a GitHub account's letter case aside, the two kinds apart`.
9. **The scrypt memory limit, and a stored hash that names more than production's cost:** a hash at production cost; p 2, or log2 N 15 with r below 8. Task 2 `the production cost is N 2^15, r 8, p 1, and a hash made at it verifies` and `a stored value that is not a hash of ours, or names a cost out of bounds, verifies nothing and never throws`.
10. **The command leaving no admin, or writing to a database not migrated, or saying a role was set when it was there already.** Task 7.
11. **A reset or a change of password committed while a sign-in verifies:** the old password must not make a session after the reset's deletion. Task 4 `a reset committed while a sign-in verifies makes no session`, `a change of one's own password while another sign-in verifies makes no session` and `a first password whose one-time password was reset meanwhile is refused`.
12. **A failure in the middle:** a database step or a hash that rejects in each of the three password functions, and a GitHub row made whose session then fails. Task 4 `a database step that fails answers internal_error, logs failed with its code, and makes no session`; Task 6 `a handler of the new routes that fails is internal_error, logged with its route name only`; Task 3 `a GitHub row made whose session cannot be made is still logged as made, then failed`.

---

### Task 1: The UI on with its address alone

**Files:**
- Modify: `src/config/load.ts`, `src/main.ts` (one line, rule 3)
- Test: `src/config/load.test.ts` (one change, new tests)

**Interfaces:**

```ts
// src/config/load.ts
export interface UiConfig {
  accounts: string[]; team: string | null; publicUrl: string;
  /** Null exactly when GitHub sign-in is off: ui names neither an account nor a team. */
  clientId: string | null;
  clientSecret: string | null;
}
/** Whether ui names an account or a team, which turns GitHub sign-in on (its client id and secret are then written). */
export function githubSignInOn(ui: UiConfig): ui is UiConfig & { clientId: string; clientSecret: string };
```

**Rules (4.1; call 6):**

1. **On.** The UI is on when `raw.ui` writes `publicUrl`, names at least one account, or writes `team`. GitHub sign-in is on when it names an account or writes a team; only then are the three issues of today raised (their text unchanged: `must be written when ui names accounts or a team`). `ui: {}` and `ui: { accounts: [] }` are off.
2. **Loaded.** With the UI on: `ui: { accounts, team: team ?? null, publicUrl: new URL(publicUrl).origin, clientId, clientSecret }`, where `clientId` and `clientSecret` are the written ones with GitHub sign-in on and null otherwise. A `clientSecret` written is still resolved whatever `ui` says.
3. **`main.ts`** gives `ServiceDeps.ui` only when `config.ui` is there and `githubSignInOn(config.ui)`, passing `clientId` and `clientSecret` as today, until Task 6 wires password sign-in.

- [ ] **Step 1: Write the failing tests and the one change.**

`src/config/load.test.ts`, test `the UI is off unless ui names accounts or a team, and a config that writes no ui gives the config it gave`: its title becomes `the UI is off unless ui writes an address or names accounts or a team, and a config that writes no ui gives the config it gave`, and the entry `` `${SERVICE_YAML}ui: { publicUrl: https://visto.example.test }\n` `` is removed from its second loop.

```ts
test('ui with only an address is on with password sign-in alone, and needs no client id or secret', () => {
  /* SERVICE_YAML + "ui: { publicUrl: 'https://visto.example.test/' }": c.ui deepEquals { accounts: [], team: null, publicUrl: 'https://visto.example.test',
     clientId: null, clientSecret: null }; githubSignInOn(c.ui) false; c.app deepEquals APP_THREE; minimal + the same block: the same ui;
     UI_APP + the same block with APP_CLIENT_SECRET set: clientId null, clientSecret null */
});
test('with accounts or a team, GitHub sign-in is on and carries the client id and secret', () => {
  /* UI_APP + ui { accounts: [octo-lead], publicUrl }: githubSignInOn true, clientId 'Iv1.0123456789abcdef'; ui { team: acme/reviewers, publicUrl }: true;
     ui { accounts: [], publicUrl }: false */
});
test('an address written alone that is not one is refused by name, and quotes nothing', () => {
  /* ui { publicUrl: 'http://visto.example.test' }: exactly ['ui.publicUrl: must be an https URL with no path, query or user, or http://localhost or http://127.0.0.1'] */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/config/load.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the UI is on with its address alone, and GitHub sign-in with accounts or a team`.

---

### Task 2: Passwords, one-time passwords and names

**Files:**
- Create: `src/ui/passwords.ts`, `src/ui/passwords.test.ts`

**Interfaces:**

```ts
// src/ui/passwords.ts
export interface PasswordCost { log2N: number; r: number; p: number }
export const PASSWORD_COST: PasswordCost;                   // { log2N: 15, r: 8, p: 1 }
export const NAME: RegExp;                                  // /^[a-z0-9][a-z0-9._-]{0,38}$/
export const ONE_TIME_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const ONE_TIME_LENGTH = 20;
/** A new password: 12 to 128 code points, well formed, with no U+0000 (as built; rule 5). */
export function passwordLengthOk(password: string): boolean;
/** 20 characters of the alphabet, each drawn by randomInt. */
export function oneTimePassword(): string;
/** `scrypt$<log2N>$<r>$<p>$<salt>$<key>`; rejects `bad_cost` for a cost out of bounds, before any work. */
export function hashPassword(password: string, cost?: PasswordCost): Promise<string>;
/** Whether `password` is the one `stored` was made of; false for anything that is not a hash of ours within the bounds. */
export function verifyPassword(password: string, stored: string): Promise<boolean>;
```

**Rules (4.2, 4.3; calls 11, 12):**

1. **The bounds:** all whole numbers, p exactly 1, log2N 4 to 15, r 1 to 8, and at log2N 15 r exactly 8; so no accepted cost exceeds `PASSWORD_COST` (at most 64 MiB of `maxmem`), and COST is accepted. `hashPassword` and `verifyPassword` apply the same bounds.
2. **`hashPassword`:** a salt of `randomBytes(16)`; `scrypt(Buffer.from(password, 'utf8'), salt, 32, { N: 2 ** log2N, r, p, maxmem: 256 * 2 ** log2N * r })` through `promisify`; the text `scrypt$${log2N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`. A scrypt failure rejects `scrypt_failed`.
3. **`verifyPassword`:** `stored` must match `^scrypt\$(\d{1,2})\$(\d)\$(\d)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$` with its numbers in the bounds, else false with no scrypt; the key is computed with the stored parameters and salt and compared with `timingSafeEqual` (32 bytes each). A scrypt failure rejects `scrypt_failed`; nothing else rejects.
4. **`oneTimePassword`:** `Array.from({ length: 20 }, () => ONE_TIME_ALPHABET[randomInt(ONE_TIME_ALPHABET.length)]).join('')`.
5. **`passwordLengthOk`:** `[...password].length` from 12 to 128. (as built) It also refuses a new password that is not `isWellFormed()` (a lone surrogate) or that holds U+0000 (NUL): scrypt pads a key shorter than 64 bytes with zero bytes and writes every lone surrogate as U+FFFD, so either would make two passwords one; `verifyPassword` is unchanged and verifies any string.
6. No error's message holds anything but its short code.

- [ ] **Step 1: Write the failing tests.**

```ts
test('a password is hashed with its own salt and its parameters, and only it verifies', async () => {
  /* hashPassword('a long password of mine', COST) matches /^scrypt\$4\$1\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/; two hashes of it differ;
     verify of it true; of 'a long password of minE', '' and 'a long password of mine ' false */
});
test('the production cost is N 2^15, r 8, p 1, and a hash made at it verifies', async () => {
  /* PASSWORD_COST deepEquals { log2N: 15, r: 8, p: 1 }; hashPassword(x) (no cost) starts with 'scrypt$15$8$1$' and verifies; one hash and one verify only */
});
test('a stored value that is not a hash of ours, or names a cost out of bounds, verifies nothing and never throws', async () => {
  /* '', 'x', a good hash with its key cut to 42 characters, with one character of the key changed, with log2N 16 or 3, r 9, p 2 or 3, with '$' doubled: false each;
     a good hash's text rewritten to name log2N 15 with r 1 or 7, or log2N 15, r 8 and p 2: false each */
});
test('a cost out of bounds is refused before any hash', async () => {
  /* log2N 3, 16, 4.5; r 0, 9; p 0, 2, 3; log2N 15 with r 1, 4 or 7: each rejects with the message 'bad_cost'; COST resolves */
});
test('a one-time password is 20 characters of an alphabet with no look-alike, drawn evenly', () => {
  /* the alphabet has 31 distinct characters, none of 0 1 i l o, no capital; 1,000 draws: each of length 20, each character in the alphabet,
     each of the 31 counted between 400 and 900 times (645 expected) */
});
test('a password has 12 to 128 characters, counted as a person sees them', () => {
  /* 'a'.repeat(11) false, 12 true, 128 true, 129 false; '\u{1F511}'.repeat(12) true; '\u{1F511}'.repeat(129) false; ("e" + String.fromCharCode(0x301)).repeat(6) true (12 code points) */
});
test('a name is 1 to 39 lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit', () => {
  /* 'octo-admin', 'a', '9lives', 'a.b_c-d', 'a'.repeat(39) match; '', 'Octo', '-x', '.x', '_x', 'a'.repeat(40), 'octo admin', 'octo@x', 'octo/x' do not */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/passwords.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: password hashes with scrypt, one-time passwords, and the rule of a name`.

---

### Task 3: Accounts in the store, and every session belongs to one

**Files:**
- Create: `src/db/migrations/0015_accounts.sql`, `src/db/ui-accounts.ts`, `src/db/ui-accounts.test.ts`
- Modify: `src/db/ui-sessions.ts`, `src/ui/auth.ts`
- Test: `src/db/migrate.test.ts` (new test), `src/db/ui-sessions.test.ts` (changes, new test), `src/ui/auth.test.ts` (changes, new tests), `src/ui/api.test.ts` (one change), `src/ui/route.test.ts` (one change)

**Interfaces:**

```ts
// src/db/ui-accounts.ts
export const MAX_ACCOUNTS = 1000;
export type AccountKind = 'password' | 'github';
export type Role = 'admin' | 'viewer';
export type ByKind = 'password' | 'github' | 'command' | 'sign_in';
export type Change = 'made' | 'role' | 'reset' | 'removed' | 'password_changed';
export interface AccountRow {
  id: number; kind: AccountKind; name: string; role: Role; password_hash: string | null; one_time_until: Date | null;
  failed_tries: number; wait_until: Date | null; made_at: Date; made_by_kind: ByKind; made_by_name: string | null; last_sign_in_at: Date | null;
}
export interface Actor { id: number; kind: AccountKind; name: string; role: Role }
/** One transaction whose first statement is the lock (call 8). */
export function underLock<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T>;
export function passwordAccount(db: Db, name: string): Promise<AccountRow | null>;
export function accountById(db: Db, id: number): Promise<AccountRow | null>;
export function githubAccount(db: Db, login: string): Promise<AccountRow | null>;          // letter case aside
export function listAccounts(db: Db, limit: number): Promise<AccountRow[]>;
export function countAccounts(db: Db): Promise<number>;
export function countingAdminsBesides(db: Db, id: number): Promise<number>;
/** null when the name is taken in its kind. */
export function insertAccount(db: Db, a: { kind: AccountKind; name: string; role: Role; passwordHash: string | null; oneTimeUntil: string | null;
  at: string; by: ByKind; byName: string | null; signedInAt: string | null }): Promise<AccountRow | null>;
export function setRole(db: Db, id: number, role: Role): Promise<AccountRow | null>;
export function setOneTime(db: Db, id: number, hash: string, until: string): Promise<AccountRow | null>;
/** Sets a password chosen by its account, only over the hash that was verified and (as built) while the account does not wait at `now`, the service's clock; false when the row's hash is another now or it waits. */
export function setOwnPassword(db: Db, id: number, hash: string, verified: string, now: string): Promise<boolean>;
export function deleteAccount(db: Db, id: number): Promise<AccountRow | null>;
export function wrongTry(db: Db, id: number, waitUntil: string): Promise<void>;
/** Clears the count and the wait only while the row's hash is still `verified` and (as built) the account does not wait at `now`, the service's clock (call 17); false when it is another now or it waits, and nothing is written. */
export function rightTry(db: Db, id: number, verified: string, now: string): Promise<boolean>;
export function signedInAt(db: Db, id: number, at: string): Promise<void>;
export function recordChange(db: Db, c: { at: string; by: ByKind; byName: string | null; change: Change; kind: AccountKind; name: string; role: Role | null }): Promise<void>;
/** The account of a session that has not expired; null when there is none. */
export function actorOf(db: Db, idHash: string, now: string): Promise<Actor | null>;
/** Call 18: the GitHub account of `login`, its name and last sign-in written; made as a viewer when there is none. */
export function githubSignIn(db: Db, login: string, at: string, max: number): Promise<{ account: AccountRow; made: boolean } | 'full'>;
// src/db/ui-sessions.ts
export async function createSession(db: Db, s: { idHash: string; login: string; via: string; accountId: number; at: string; expiresAt: string }): Promise<void>;
/** `login` is the account's name now. */
export async function readSession(db: Db, idHash: string, now: string): Promise<{ login: string; via: string; accountId: number; kind: AccountKind; role: Role } | null>;
/** Deletes the account's sessions but `keep` (an id hash) when given; how many. */
export async function deleteSessionsOf(db: Db, accountId: number, keep: string | null): Promise<number>;
// src/ui/auth.ts
export interface Session { login: string; idHash: string; csrf: string; accountId: number; kind: AccountKind; role: Role }   // login: the account's name
// AuthDeps keeps its keys; `signIn` becomes `ForgeSignIn | null` (null: GitHub sign-in off)
export function hashOf(value: string): string;           // exported as it is
export function sessionCookie(id: string): string;       // exported as it is
```

**Rules (4.2, 4.4, 4.5, 4.8; calls 3, 7, 8, 10, 17, 18, 24):**

1. **The migration**, exactly:

```sql
delete from visto_ai.ui_sessions;
create table visto_ai.ui_accounts (
  id integer generated always as identity primary key,
  kind text not null check (kind in ('password', 'github')),
  name text not null,
  role text not null check (role in ('admin', 'viewer')),
  password_hash text,
  one_time_until timestamptz,
  failed_tries integer not null default 0,
  wait_until timestamptz,
  made_at timestamptz not null,
  made_by_kind text not null check (made_by_kind in ('password', 'github', 'command', 'sign_in')),
  made_by_name text,
  last_sign_in_at timestamptz,
  check ((kind = 'password') = (password_hash is not null)),
  check (kind = 'password' or (one_time_until is null and wait_until is null and failed_tries = 0))
);
create unique index ui_accounts_name on visto_ai.ui_accounts (kind, lower(name));
create table visto_ai.ui_account_changes (
  id integer generated always as identity primary key,
  at timestamptz not null,
  by_kind text not null check (by_kind in ('password', 'github', 'command', 'sign_in')),
  by_name text,
  change text not null check (change in ('made', 'role', 'reset', 'removed', 'password_changed')),
  account_kind text not null check (account_kind in ('password', 'github')),
  account_name text not null,
  role text check (role in ('admin', 'viewer'))
);
create index ui_account_changes_at on visto_ai.ui_account_changes (at);
alter table visto_ai.ui_sessions add column account_id integer not null references visto_ai.ui_accounts (id) on delete cascade;
create index ui_sessions_account on visto_ai.ui_sessions (account_id);
```

2. **The statements of `ui-accounts.ts`**, `<A>` standing for `id, kind, name, role, password_hash, one_time_until, failed_tries, wait_until, made_at, made_by_kind, made_by_name, last_sign_in_at`; names and `byName` go through `storable()`:

```sql
-- underLock: inside db.transaction, first
lock table visto_ai.ui_accounts in share row exclusive mode;
-- passwordAccount / accountById / githubAccount
select <A> from visto_ai.ui_accounts where kind = 'password' and name = $1;
select <A> from visto_ai.ui_accounts where id = $1;
select <A> from visto_ai.ui_accounts where kind = 'github' and lower(name) = lower($1);
-- listAccounts
select <A> from visto_ai.ui_accounts order by lower(name), kind, id limit $1;
-- countAccounts / countingAdminsBesides
select count(*)::int as n from visto_ai.ui_accounts;
select count(*)::int as n from visto_ai.ui_accounts where role = 'admin' and (kind = 'github' or one_time_until is null) and id <> $1;
-- insertAccount
insert into visto_ai.ui_accounts (kind, name, role, password_hash, one_time_until, made_at, made_by_kind, made_by_name, last_sign_in_at)
values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9::timestamptz)
on conflict do nothing returning <A>;
-- setRole / setOneTime / setOwnPassword ($4: the clock; as built) / deleteAccount
update visto_ai.ui_accounts set role = $2 where id = $1 returning <A>;
update visto_ai.ui_accounts set password_hash = $2, one_time_until = $3::timestamptz, failed_tries = 0, wait_until = null
where id = $1 and kind = 'password' returning <A>;
update visto_ai.ui_accounts set password_hash = $2, one_time_until = null, failed_tries = 0, wait_until = null
where id = $1 and kind = 'password' and password_hash = $3 and (wait_until is null or wait_until <= $4::timestamptz) returning id;
delete from visto_ai.ui_accounts where id = $1 returning <A>;
-- wrongTry ($2: the clock plus 15 minutes) / rightTry ($2: the hash that was verified; $3: the clock, as built) / signedInAt
update visto_ai.ui_accounts set
  failed_tries = case when failed_tries + 1 >= 5 then 0 else failed_tries + 1 end,
  wait_until = case when failed_tries + 1 >= 5 then $2::timestamptz else wait_until end
where id = $1 and kind = 'password';
update visto_ai.ui_accounts set failed_tries = 0, wait_until = null where id = $1 and password_hash = $2 and (wait_until is null or wait_until <= $3::timestamptz) returning id;
update visto_ai.ui_accounts set last_sign_in_at = $2::timestamptz where id = $1;
-- recordChange
insert into visto_ai.ui_account_changes (at, by_kind, by_name, change, account_kind, account_name, role)
values ($1::timestamptz, $2, $3, $4, $5, $6, $7);
-- actorOf
select a.id, a.kind, a.name, a.role
from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id
where s.id_hash = $1 and s.expires_at > $2::timestamptz;
-- githubSignIn, first and, under the lock, again before the count
update visto_ai.ui_accounts set name = $1, last_sign_in_at = $2::timestamptz
where kind = 'github' and lower(name) = lower($1) returning <A>;
```

3. **`githubSignIn`:** the update; a row: `{ account, made: false }`. None: `underLock`: the update again (a row: as before); `countAccounts` at `max` or more: `'full'`; `insertAccount({ kind: 'github', name: login, role: 'viewer', passwordHash: null, oneTimeUntil: null, at, by: 'sign_in', byName: null, signedInAt: at })`; `recordChange({ at, by: 'sign_in', byName: null, change: 'made', kind: 'github', name: login, role: 'viewer' })`; `{ account, made: true }`.
4. **`ui-sessions.ts`**, `createSession` and `readSession` become, and `deleteSessionsOf` is:

```sql
insert into visto_ai.ui_sessions (id_hash, login, via, account_id, created_at, last_used_at, expires_at)
values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::timestamptz);
select s.via, s.last_used_at, a.id as account_id, a.kind, a.name, a.role
from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id
where s.id_hash = $1 and s.expires_at > $2::timestamptz;
delete from visto_ai.ui_sessions where account_id = $1 and ($2::text is null or id_hash <> $2) returning id_hash;
```

   The last use's write is as today. `readSession` answers `{ login: name, via, accountId, kind, role }`.
5. **`auth.ts`.** With `signIn` null, `start` and `finish` answer `json(404, { error: 'not_found' })`, read nothing and log nothing. In `finish`, once the way in holds: `githubSignIn(db, login, iso(now), MAX_ACCOUNTS)`; `'full'` is the outcome `full` (reason null); made: one `{ event: 'ui_account', change: 'made', role: 'viewer' }`, logged as soon as `githubSignIn` answers, before `createSession` and before the `ui_signin` line; then `createSession({ idHash, login: account.name, via, accountId: account.id, ... })`. A rejection of either is `failed`; a `createSession` that rejects after a row was made leaves the `ui_account` line logged (the row and its record exist), then `ui_signin` `failed`. Every `ui_signin` line gains `way: 'github'`, written after `event`. **`sessionOf`:** the joined row; it holds when its kind is `password` and its `via` is `password`, or its kind is `github` and its way in holds as the first plan says (call 11 there); the answer is `{ login, idHash, csrf, accountId, kind, role }`.
6. Nothing in this task logs or answers a name.

- [ ] **Step 1: Write the failing tests and the changes.**

`src/db/ui-sessions.test.ts`: a helper `account(db, login)` answers `(await githubSignIn(db, login, at(0), 1000))` 's account id (the same row for the same login); in the four tests that call `createSession` (`a session is read with its way in ...`, `a session read at a clock gone back ...`, `a deleted or expired session is not read`, `live states are counted, ...`), each call gains `accountId: await account(db, <its login>)`, and each expected `readSession` answer `{ login: L, via: V }` becomes `{ login: L, via: V, accountId: <L's id>, kind: 'github', role: 'viewer' }`.

`src/ui/auth.test.ts`, the exact changes and nothing else:
- the helper `signin` becomes `({ event: 'ui_signin', way: 'github', outcome, reason })`, and a helper `signins = (logs: Record<string, unknown>[]) => logs.filter((e) => e.event === 'ui_signin')` is added; every `assert.deepEqual` whose actual value is a harness's `logs` (`h.logs`, `alone.logs`) or the spread `[...none.logs, ...down.logs, ...unread.logs, ...odd.logs]` takes it through `signins(...)`;
- the helper `sessions` selects `id_hash, login, via, created_at, last_used_at, expires_at` in place of `*`;
- in `while 1,000 states are live ...`, the session insert is preceded by `insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind) values ('github', 'octo-lead', 'viewer', $1::timestamptz, 'sign_in')` with `[iso(-1)]`, and names `account_id` with `(select id from visto_ai.ui_accounts)`;
- the expected sessions of `a login GitHub writes in another letter case ...` and `a session is read by its cookie ...` gain `accountId: 1, kind: 'github', role: 'viewer'`; the two `Session` literals of `the token for changes ...` gain the same three fields.

`src/ui/api.test.ts`: `SESSION` gains `accountId: 1, kind: 'github', role: 'viewer'`. `src/ui/route.test.ts`, test `a session read that rejects ...`: `h.failing.text` becomes `'select s.via, s.last_used_at'`.

```ts
// src/db/migrate.test.ts
test('0015_accounts deletes the sessions of before, and adds the accounts, the record of changes and the account of each session', async () => {
  /* migrations below 0015 applied, a session row inserted, then all: '0015_accounts' follows '0014_ui'; ui_sessions empty;
     ui_accounts and ui_account_changes have exactly the columns of rule 1 with their types and nullability; ui_sessions.account_id integer not null;
     indexes ui_accounts_name, ui_account_changes_at, ui_sessions_account exist; a session insert with no account_id rejects */
});
// src/db/ui-accounts.test.ts
test("a password account's name is unique, and a GitHub account's letter case aside, the two kinds apart", async () => {
  /* insertAccount password octo-admin twice: the second null; github Octo-Lead then octo-lead: null; password octo-lead beside github octo-lead: made */
});
test("a row's checks refuse a password account with no hash and a GitHub account with one, or with a wait", async () => { /* three inserts by hand reject */ });
test('a GitHub sign-in makes its account a viewer once, by sign_in, then keeps its role and writes its name as GitHub writes it', async () => {
  /* githubSignIn('Octo-Lead', at(0)): made, viewer, made_by_kind sign_in, last_sign_in_at at(0); one record { by_kind: 'sign_in', change: 'made',
     account_kind: 'github', account_name: 'Octo-Lead', role: 'viewer' }; setRole admin; githubSignIn('octo-lead', at(9)): not made, admin, name 'octo-lead',
     last_sign_in_at at(9); still one record */
});
test('a GitHub sign-in with 1,000 accounts and none of its own is full, and one that has its row still signs in', async () => {
  /* 999 rows by generate_series and octo-lead's: githubSignIn('octo-dev') 'full'; githubSignIn('octo-lead') not made */
});
test('the admins that count are the GitHub ones and the password ones that chose their password, the account changed aside', async () => {
  /* admins: password set (A), password one-time (B), github (C); a viewer: besides A 1, besides C 1, besides B 2 */
});
test("every change runs after the lock, as its transaction's first statement", async () => {
  /* a spy db: underLock(db, work) runs 'lock table visto_ai.ui_accounts in share row exclusive mode' as the first statement inside the transaction, then work's */
});
test('a wrong try is counted, the fifth starts the wait it is given and counts again from none, and a right one clears both only over the hash it verified', async () => {
  /* wrongTry x4: failed_tries 4, wait_until null; the fifth with at(900): 0, at(900); wrongTry x2 then rightTry(id, <another hash>): false, failed_tries 2,
     wait_until at(900); rightTry(id, <the row's hash>): true, 0, null; wrongTry on a GitHub row changes nothing; rightTry on it false */
});
test('a password is set only over the hash that was verified', async () => {
  /* setOwnPassword(id, h2, h1) true, hash h2, one_time_until null; setOwnPassword(id, h3, h1) false, hash h2 */
});
test('an actor is read with its session, and an expired or deleted session reads none', async () => { /* actorOf before and at expiry; after deleteAccount null */ });
test('a change is recorded with who made it, what, to whom and the new role, as text that outlives the account', async () => {
  /* recordChange by password octo-admin, role, password octo-viewer, admin; deleteAccount(octo-viewer): the record row is unchanged */
});
// src/db/ui-sessions.test.ts
test("a session's account is read with it, its role as the row has it now, and the account's removal or a sweep of its others removes its sessions", async () => {
  /* two sessions of one account: setRole admin, readSession role admin; deleteSessionsOf(id, 'h-a') 1, h-a still read; deleteAccount: readSession null */
});
// src/ui/auth.test.ts
test("a GitHub sign-in makes the account a viewer at its first sign-in, logs it once, and the session reads the row's role at each request", async () => {
  /* code-1: logs [{ event: 'ui_account', change: 'made', role: 'viewer' }, signin('ok')]; sessionOf role 'viewer'; role set to admin by a statement:
     the next sessionOf role 'admin'; a second sign-in logs [signin('ok')] only */
});
test('a GitHub row made whose session cannot be made is still logged as made, then failed', async () => {
  /* code-1 with h.failing.text 'insert into visto_ai.ui_sessions': /ui/signin?error=failed; h.logs exactly
     [{ event: 'ui_account', change: 'made', role: 'viewer' }, signin('failed')]; the octo-lead row and its one record kept; no session */
});
test('a GitHub sign-in with 1,000 accounts and none of its own is refused as full', async () => {
  /* 1,000 password rows by generate_series: /ui/signin?error=full, signin('full'), no session */
});
test('with GitHub sign-in off the start and the way back are not found, and read nothing', async () => {
  /* createAuth with signIn null: start and finish 404 { error: 'not_found' } with the JSON headers; no statement; no log line */
});
test("a password session reads by its kind, whatever the file's accounts say, and a removed account's session is none", async () => {
  /* a password account and createSession via 'password': sessionOf with ui.accounts [] reads it, kind password; deleteAccount: sessionOf null */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/migrate.test.ts src/db/ui-accounts.test.ts src/db/ui-sessions.test.ts src/ui/auth.test.ts src/ui/api.test.ts src/ui/route.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: accounts and the record of their changes in the store, and every session belongs to an account whose role it reads`.

---

### Task 4: Password sign-in, the first password, and changing one's own

**Files:**
- Create: `src/ui/password-auth.ts`, `src/ui/password-auth.test.ts`
- Modify: `src/ui/api-types.ts` (`SignInStep`)

**Interfaces:**

```ts
// src/ui/api-types.ts gains
export interface SignInStep { next: 'signed_in' | 'choose_password' }
// src/ui/password-auth.ts
export const WRONG_TRIES = 5;
export const WAIT_MS = 15 * 60_000;
export interface PasswordAuthDeps {
  db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  random?: () => string;                                       // a session id: 32 random bytes in base64url; absent: randomBytes(32)
  cost?: PasswordCost;                                         // every hash it makes, the hash made at start included; absent: PASSWORD_COST
  verify?: (password: string, stored: string) => Promise<boolean>;   // absent: verifyPassword (a test records what is compared)
}
export interface PasswordAuth {
  signIn(body: Record<string, unknown>): Promise<UiAnswer>;                     // POST /api/auth/password, after the origin and JSON checks; never rejects
  firstPassword(body: Record<string, unknown>): Promise<UiAnswer>;              // POST /api/auth/first-password, after the same; never rejects
  change(session: Session, body: Record<string, unknown>): Promise<UiAnswer>;   // POST /api/me/password, after the token check; rejects on a failure
}
/** One for the service: it makes the hash made at start once, and keeps when it last deleted expired rows. */
export function createPasswordAuth(deps: PasswordAuthDeps): PasswordAuth;
```

**Rules (4.3, 4.5, 4.8; calls 13 to 17, 24):**

1. **The hash made at start** is `hashPassword(randomBytes(32).toString('base64url'), cost)`, begun in `createPasswordAuth`, its rejection caught there (a request that needs it then answers as a database failure does). **Every refusal of rule 3 runs exactly one `verify`.**
2. **Bodies.** `signIn`: exactly the keys `name` (a string of at most 200 characters) and `password` (at most 1,024); `firstPassword`: `name`, `oneTimePassword` (at most 1,024) and `password`; `change`: `current` and `password`. Anything else: 400 `bad_request`, nothing read. The name is `name.trim().toLowerCase()`; one that fails `NAME` is no account.
3. **`signIn`**, once its body holds (rule 2), first the sweep: expired sessions and states deleted with `deleteExpired` when this object has not swept yet, or swept 60 seconds ago or more by the clock (one time of the last sweep for `signIn` and `firstPassword`). Then, H standing for the `password_hash` read and verified:
   - no account, or one that waits: `verify(password, <the hash made at start>)`, then 401 `refused`;
   - `verify(password, H)` false: `wrongTry(id, now + WAIT_MS)`, 401 `refused`;
   - true, and a one-time password: `rightTry(id, H, now)`; false: 401 `refused`; true and expired (`one_time_until <= now`): 401 `expired`; true and not expired: 200 `{ "next": "choose_password" }`, no session;
   - true, and it chose its password: **one transaction** (call 17): `rightTry(tx, id, H, now)`, its first statement; false: 401 `refused`, nothing else written, no session; true: the session (rule 6), and after the commit 200 `{ "next": "signed_in" }` with its cookie.

   (as built) Every `rightTry` and `setOwnPassword` of rules 3 to 5 is given `now`, the clock the request read, and writes nothing while the account waits then (Task 3's statements): a verify begun before a wait started, as when tries sent at once each verify against the account's hash, is answered as a hash changed meanwhile, 401 `refused` for `signIn` and `firstPassword` and 400 `wrong_password` for `change`, with no session, no record and no `ui_account` line.
4. **`firstPassword`**, once its body holds: `passwordLengthOk(password)` false: 400 `password_length`; `password === oneTimePassword`: 400 `same_password`; both before any statement. Then the sweep (rule 3), then rule 3's first two steps with `oneTimePassword`. True, H the one-time password's hash verified: `rightTry(id, H, now)` false: 401 `refused`; chose its password already: 409 `already_chosen`; expired: 401 `expired`; else the new hash (outside any transaction), then **one transaction** (call 17) whose first statement, `setOwnPassword(tx, id, hash, H, now)`, is the guarded update of a first password (over the one-time password's hash, clearing the count and the wait); false: 401 `refused`, nothing else written, no session; true: `recordChange({ by: 'password', byName: name, change: 'password_changed', kind: 'password', name, role })`; the session (rule 6); after the commit, 200 `{ "next": "signed_in" }` with its cookie, and one `ui_account` line `{ change: 'password_changed', role }`.
5. **`change`:** a GitHub session: 409 `github_account`; the body (rule 2); `passwordLengthOk(password)` false: 400 `password_length`; `accountById(session.accountId)` null: 401 `signed_out`; it waits: `verify` against the hash made at start, 400 `wrong_password`; `verify(current, H)` false: `wrongTry`, 400 `wrong_password`; true: `rightTry(id, H, now)` false: 400 `wrong_password`; the new hash; then one transaction: `setOwnPassword(tx, id, hash, H, now)` false: 400 `wrong_password`; `deleteSessionsOf(id, session.idHash)`; `recordChange(... 'password_changed' ...)`; after the commit, 204 with an empty body, `no-store` and the security headers; one `ui_account` line. **A database step or a hash that rejects makes `change` reject** with that error, writing no line; the route answers it 500 `internal_error` and logs `{ event: 'ui_failed', route: 'own_password', reason }` (Task 6, rule 3).
6. **A session**, inside the transaction of rule 3 or 4 and on its `tx`: an id from `random()`; `createSession(tx, { idHash: hashOf(id), login: name, via: 'password', accountId, at: now, expiresAt: now + SESSION_MS })`; `signedInAt(tx, id, now)`; after the commit, the header `set-cookie: sessionCookie(id)` (Task 3).
7. **The answers** are `json(status, value)` from `headers.ts`; errors `{ "error": <code> }`. **`signIn` and `firstPassword` never reject:** a database step or a hash that rejects (the hash made at start included) is answered by them, 500 `internal_error`, logged as `ui_signin` `failed` (rule 8), with no session. `change` rejects instead (rule 5).
8. **Logs:** `signIn` and `firstPassword` log exactly one `{ event: 'ui_signin', way: 'password', outcome, reason }` each: `ok`, `choose`, `refused`, `expired` and `already_chosen` with reason null; `bad_request` with the code answered (`bad_request`, `password_length`, `same_password`); `failed` with `codeOf(error)`. `change` logs only its `ui_account` line; its failure is logged by the route as `ui_failed` (rule 5). No line holds a name.

- [ ] **Step 1: Write the failing tests.** A harness as `auth.test.ts`'s: PGlite behind a spy that records statements and fails one on demand (`h.failing.text`), a clock the test moves, `random` answering `'a'.repeat(43)`, `'b'.repeat(43)`, ... in turn, `cost` COST, and `verify` wrapping `verifyPassword` to record `[password, stored]` and, when the test has set `h.during` (a function), clearing it first and then awaiting its call before it resolves, so a verify made inside it runs plainly. Accounts are made with `insertAccount` and `hashPassword(..., COST)`.

```ts
test('a right password makes a session of twelve hours with the cookie of GitHub sign-in, and writes the last sign-in', async () => {
  /* octo-admin chose 'a long password of mine': 200 { next: 'signed_in' }, set-cookie exactly the session cookie of the first plan with 'a'.repeat(43);
     ui_sessions: via 'password', account_id, expires at(43200); last_sign_in_at at(0); log [{ event: 'ui_signin', way: 'password', outcome: 'ok', reason: null }];
     'Octo-Admin ' as the name: the same */
});
test('a wrong password, a name that does not exist, a name of another shape and an account that waits are refused alike, each after one verify, the unknown and the waiting against the hash made at start', async () => {
  /* each answer deepEquals 401 { error: 'refused' } with the same headers; each made one verify: the wrong one against octo-admin's hash, 'octo-nobody',
     'octo admin!', 'octo-lead' (a GitHub account of that login exists) and a waiting account against one same hash found in no row; logs outcome refused, reason null */
});
test('five wrong passwords in a row make the account wait 15 minutes by the clock, even for the right one; then it signs in, and a right one clears the count', async () => {
  /* four wrong, one right: failed_tries 0; five wrong at at(0): wait_until at(900); the right one at at(899): refused, and no verify against its hash;
     at at(900): signed_in; wait_until null */
});
test('a right one-time password asks for a password and makes no session; an expired one is refused as expired', async () => {
  /* one_time_until at(259200): 200 { next: 'choose_password' }, no set-cookie, no session, log choose; at at(259200): 401 expired; a wrong one then: refused */
});
test('the first password signs in, ends the one-time password, is recorded and logged, and needs the one-time password again', async () => {
  /* firstPassword { name, oneTimePassword, password: 'a long password of mine' }: 200 signed_in with the cookie; one_time_until null; the hash verifies the new one;
     a record { by_kind: 'password', by_name: 'octo-new', change: 'password_changed', role: 'viewer' }; logs ui_account then ui_signin ok;
     a wrong oneTimePassword: refused, with one wrong try counted */
});
test('a first password that is too short, too long, or the one-time password itself is refused before any verify', async () => {
  /* 11 and 129 characters: 400 password_length; the same as oneTimePassword: 400 same_password; no verify and no statement, the sweep's included */
});
test('a first password for an account that chose its own already is refused as already_chosen', async () => { /* 409 already_chosen; no change */ });
test('a first password whose one-time password was reset meanwhile is refused', async () => {
  /* octo-new one-time: h.during commits a reset by Task 3's statements (setOneTime(id, <another one-time hash>, at(259200)), deleteSessionsOf(id, null)):
     401 refused; the row keeps the reset's hash and one_time_until; ui_sessions and ui_account_changes empty; log [refused, reason null]; no ui_account line */
});
test('a reset committed while a sign-in verifies makes no session', async () => {
  /* octo-admin chose 'a long password of mine': h.during commits a reset as above; signIn with the right password: 401 { error: 'refused' }, no set-cookie;
     ui_sessions empty; last_sign_in_at null; the row keeps the reset's hash; one statement after the verify, rightTry's guarded update (Task 3), inside the
     transaction; log [refused, reason null] */
});
test("a change of one's own password while another sign-in verifies makes no session", async () => {
  /* octo-admin chose 'a long password of mine', with session S: h.during awaits change(S, { current: 'a long password of mine', password: 'another long password' })
     (204); signIn with 'a long password of mine': 401 refused; ui_sessions holds S's row only; 'another long password' verifies the row's hash */
});
test('changing one\'s own password needs the current one, ends the other sessions and keeps this one', async () => {
  /* two sessions: change { current, password: 'another long password' } 204; the other session gone, this one read; the new one verifies;
     a wrong current: 400 wrong_password and a wrong try; a waiting account: 400 wrong_password after a verify against the hash made at start */
});
test('a GitHub session cannot change a password', async () => { /* 409 github_account, nothing read */ });
test('a body of the wrong shape is bad_request, and nothing is read', async () => {
  /* {}, { name: 'x' }, { name: 7, password: 'x' }, an extra key, a name of 201 characters, a password of 1,025: 400 bad_request, no statement, log bad_request */
});
test('expired sessions are deleted at a password sign-in or a first password, at most once a minute between them, and after the body holds', async () => {
  /* signIn at at(0), firstPassword at at(30), signIn at at(60), firstPassword at at(90): the statements holding 'expires_at <= $1' at at(0) and at(60) only;
     a bad body and a first password of 11 characters at at(200): none */
});
test('a database step that fails answers internal_error, logs failed with its code, and makes no session', async () => {
  /* signIn and firstPassword, each of their statements in turn rejecting: 500 { error: 'internal_error' }, one ui_signin { outcome: 'failed', reason: <its code> },
     no session, neither rejects; a createPasswordAuth given { log2N: 3, r: 1, p: 1 } (the hash made at start rejects bad_cost): signIn of 'octo-nobody' 500, failed
     bad_cost; change, each of its statements in turn rejecting: change rejects with that error, no log line, the row's hash and the sessions as before */
});
test('no answer, log line, row or error holds a password, a one-time password, a hash or a name, but the hash in its own column', async () => {
  /* every answer and log line of this file holds none of the passwords, one-time passwords, 'scrypt$', 'octo-'; the rows of ui_sessions and
     ui_account_changes hold no password and no 'scrypt$'; the hash made at start is made once per createPasswordAuth, at COST ('scrypt$4$1$1$') */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/password-auth.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: password sign-in with one-time passwords, the first password, the wait after five wrong ones, and changing one's own`.

---

### Task 5: Making, re-roling, resetting and removing accounts, under the lock

**Files:**
- Create: `src/ui/accounts.ts`, `src/ui/accounts.test.ts`
- Modify: `src/ui/api-types.ts`

**Interfaces:**

```ts
// src/ui/api-types.ts gains
export type AccountKind = 'password' | 'github';
export type Role = 'admin' | 'viewer';
export interface Account {
  id: number; kind: AccountKind; name: string; role: Role;
  password: 'set' | 'one_time' | 'expired' | null;   // null for a GitHub account
  waitsUntil: string | null;                         // while it waits after five wrong tries
  madeAt: string; madeBy: { kind: 'password' | 'github' | 'command' | 'sign_in'; name: string | null };
  lastSignInAt: string | null; you: boolean;
}
export interface Accounts { now: string; accounts: Account[] }
export interface OneTime { account: Account; oneTimePassword: string; expiresAt: string }
export interface AccountAnswer { account: Account }
// src/ui/accounts.ts
export const ONE_TIME_MS = 72 * 3_600_000;
export type Actor = { by: 'session'; idHash: string } | { by: 'command' };
export type Refusal = 'signed_out' | 'forbidden' | 'not_found' | 'bad_name' | 'bad_login' | 'name_taken' | 'full' | 'last_admin' | 'github_account' | 'own_account';
export interface Made { account: AccountRow; oneTimePassword: string; expiresAt: string }
export interface AccountsDeps { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void; cost?: PasswordCost; max?: number }
export interface AccountChanges {
  list(): Promise<AccountRow[]>;                                   // at most MAX_ACCOUNTS
  make(actor: Actor, name: string, role: Role): Promise<Made | Refusal>;
  /** `made`: the row was made by this call; `changed`: a row there before had another role, now written; both false: it had the role already. */
  setRole(actor: Actor, target: { id: number } | { github: string }, role: Role): Promise<{ account: AccountRow; made: boolean; changed: boolean } | Refusal>;
  reset(actor: Actor, target: { id: number } | { name: string }): Promise<Made | Refusal>;
  remove(actor: Actor, id: number): Promise<AccountRow | Refusal>;
}
export function createAccountChanges(deps: AccountsDeps): AccountChanges;
/** The API's view of a row: never its hash; `you` when its id is `you`. */
export function accountOf(row: AccountRow, now: Date, you: number | null): Account;
```

**Rules (4.2, 4.3, 4.6, 4.8; calls 8 to 10, 12, 24):**

1. **The order of every change:** the one-time password drawn and hashed first (make, reset), outside the lock; then `underLock`: the actor (a session: `actorOf(idHash, now)`, none `signed_out`, not admin `forbidden`; the command: none read), the target, the rule, the change, `recordChange`, and after the commit one `{ event: 'ui_account', change, role }` (role null for a removal). `by` and `byName` are the actor's kind and name, or `command` and null.
2. **`make`:** `NAME` false: `bad_name` (before any hash). Under the lock: `countAccounts` at `max` (MAX_ACCOUNTS) or more: `full`; `insertAccount({ kind: 'password', name, role, passwordHash, oneTimeUntil: now + ONE_TIME_MS, at: now, by, byName, signedInAt: null })` null: `name_taken`; recorded `made` with the role.
3. **`setRole`:** `{ id }` read with `accountById`, none `not_found`; `{ github }` (the command): a login failing `^[A-Za-z0-9-]{1,39}$` is `bad_login` (before the lock); `githubAccount(login)`, none: made with the role (`full` at the cap), recorded `made`: `{ account, made: true, changed: false }`. The role it has already: `{ account: <the row>, made: false, changed: false }`, nothing written, recorded or logged. An admin made a viewer while `countingAdminsBesides(id)` is 0: `last_admin`. Else `setRole`, recorded `role`: `{ account, made: false, changed: true }`.
4. **`reset`:** `{ id }` with `accountById`, `{ name }` (the command) with `passwordAccount`; none: `not_found`; a GitHub account: `github_account`; a session actor whose account is the target: `own_account` (call 9). `setOneTime(id, hash, now + ONE_TIME_MS)`, `deleteSessionsOf(id, null)`, recorded `reset` with its role.
5. **`remove`:** none: `not_found`; an admin while `countingAdminsBesides(id)` is 0: `last_admin`; `deleteAccount` (its sessions go with it), recorded `removed`, role null.
6. **`accountOf`:** `password` null for GitHub, else `set` with `one_time_until` null, `one_time` while it is after `now`, `expired` otherwise; `waitsUntil` the ISO of `wait_until` while it is after `now`, else null; `madeBy` `{ kind: made_by_kind, name: made_by_name }`; times as ISO strings.
7. No refusal reads or writes anything after the step that refused, and none is logged.

- [ ] **Step 1: Write the failing tests.** A harness with PGlite behind a statement spy, a clock, COST, a log, and helpers making password accounts (chosen or one-time) and sessions for them.

```ts
test('an admin makes a password account with a one-time password answered once and stored only as its hash, for 72 hours', async () => {
  /* make(admin's session, 'octo-viewer', 'viewer'): oneTimePassword of 20 alphabet characters that verifies the row's hash; one_time_until at(259200);
     expiresAt that ISO; made_by_kind password, made_by_name octo-admin; a record made viewer; a log { event: 'ui_account', change: 'made', role: 'viewer' };
     the one-time password in no row, record or log line */
});
test('a name taken, a name of another shape and the 1,001st account are refused, and nothing is made', async () => {
  /* 'octo-viewer' again: name_taken; 'Octo': bad_name with no statement; 1,000 rows: full; no record, no log line for any */
});
test('a role is changed and recorded; the role it has already changes nothing', async () => {
  /* octo-viewer to admin: made false, changed true, the row admin, a record role admin, a log line; again to admin: made false, changed false, the row,
     no statement after the read, no record */
});
test('the last admin cannot be made a viewer or removed, and an admin who has not chosen a password does not count', async () => {
  /* octo-admin alone: setRole viewer on itself last_admin, remove itself last_admin; octo-new made admin (one-time): still last_admin for both;
     octo-new chooses (setOwnPassword): octo-admin can step down; then octo-new is the last: last_admin; a GitHub admin counts */
});
test('two admins making each other viewers at once leave one admin', async () => {
  /* octo-admin and octo-viewer (admin, chose): Promise.all of each making the other a viewer: exactly one returns the row, the other 'forbidden';
     countingAdminsBesides(-1) is 1 */
});
test('a reset gives a new one-time password, clears the wait, and ends every session of the account; a GitHub account and one\'s own are refused', async () => {
  /* octo-viewer waiting with two sessions: reset by octo-admin: a new one-time password verifying the hash, failed_tries 0, wait_until null, no session left,
     a record reset; reset of a GitHub row: github_account; of octo-admin by itself: own_account */
});
test('removing an account deletes its row and its sessions at once, and the record keeps its name', async () => {
  /* remove octo-viewer: its sessions gone, a record { change: 'removed', account_name: 'octo-viewer', role: null }; remove it again: not_found */
});
test('a viewer, a removed session and an expired one change nothing, read again under the lock', async () => {
  /* a viewer's session: forbidden for each change; a session whose account was removed, and one expired: signed_out; no write in any */
});
test('the command makes and resets by name and sets a GitHub login\'s role, making its row, and is recorded as the command', async () => {
  /* make({ by: 'command' }, 'octo-admin', 'admin'); reset({ by: 'command' }, { name: 'octo-admin' }); setRole({ by: 'command' }, { github: 'octo-lead' }, 'admin'):
     made true, changed false, made_by_kind command; again: made false, changed false, the row; { github: 'octo-dev' } viewer, then admin: made false,
     changed true; { github: 'octo_lead' }: bad_login; each record by_kind command, by_name null */
});
test('every change takes the lock first', async () => { /* the spy: in each change's transaction the first statement is the lock */ });
test('the view of an account holds no hash, and says whether it chose its password, waits, and is you', async () => {
  /* accountOf for set, one_time, expired, waiting and GitHub rows: the keys of Account exactly; no value holds 'scrypt$'; you for the id given only */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/accounts.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: accounts made, given a role, reset and removed under one lock, and the last admin kept`.

---

### Task 6: The routes, the role checks, the origin check, and the service serving password sign-in

**Files:**
- Modify: `src/ui/route.ts`, `src/ui/api.ts` (`me`), `src/ui/api-types.ts` (`Me`, `Ways`), `src/shell/http.ts` (`uiPart`), `src/service.ts`, `src/main.ts`, `ui/src/components/layout.tsx` (`me.login` becomes `me.name`, twice)
- Test: `src/ui/route.test.ts` (changes, new tests), `src/ui/api.test.ts` (two changes), `src/shell/http.test.ts` (new test), `src/service.test.ts` (changes, new tests), `ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/activity.test.tsx` (the `ME` constant each)

**Interfaces:**

```ts
// src/ui/api-types.ts
export interface Me { name: string; kind: AccountKind; role: Role; csrf: string; mode: 'live' | 'dry_run'; repositories: string[] }
export interface Ways { github: boolean }
// src/ui/route.ts
export function createUiRoute(deps: {
  auth: Auth; passwords: PasswordAuth; accounts: AccountChanges; api: ApiDeps; files: UiFiles;
  ui: { publicUrl: string; github: boolean }; log: (entry: Record<string, unknown>) => void;
}): UiRoute;
// src/service.ts, ServiceDeps.ui becomes
  ui?: { signIn: ForgeSignIn | null; files: UiFiles; passwordCost?: PasswordCost };   // signIn null: no GitHub sign-in whatever the file says
```

**Rules (4.1, 4.5; calls 6, 17, 19 to 22):**

1. **The routes** (`METHODS` gains each, one method per path):

| Route | Needs | Answers |
|---|---|---|
| `GET /api/auth/ways` | nothing | 200 `Ways` |
| `GET /api/auth/start`, `/callback` | GitHub sign-in on, else 404 `not_found` | as the first plan |
| `POST /api/auth/password` | `Origin`, JSON | `passwords.signIn` |
| `POST /api/auth/first-password` | `Origin`, JSON | `passwords.firstPassword` |
| `POST /api/auth/signout` | session, token | as the first plan |
| `GET /api/me`, `/activity`, `/reviews` | session | as the first plan; `Me` as above |
| `POST /api/me/password` | session, token, JSON | `passwords.change` |
| `GET /api/accounts` | session, admin | 200 `Accounts` (`list`, viewed with `accountOf(row, now, session.accountId)`) |
| `POST /api/accounts/new` | session, token, admin, JSON `{ name: string, role }` | 201 `OneTime` |
| `POST /api/accounts/role` | the same, `{ id, role }` | 200 `AccountAnswer` |
| `POST /api/accounts/reset` | the same, `{ id }` | 200 `OneTime` |
| `POST /api/accounts/remove` | the same, `{ id }` | 204, empty, `no-store` and the security headers |

   `id` is a whole number from 1 to 2147483647 and `role` `admin` or `viewer`; the keys exactly those, `name` a string of at most 200 characters; else 400 `bad_request`. The work's refusals: `signed_out` 401; `forbidden` 403; `not_found` 404; `bad_name` 400; `name_taken`, `full`, `last_admin`, `github_account`, `own_account` 409.
2. **The checks, in order** (call 20): `Origin` (exactly `ui.publicUrl`, else 403 `origin`) for the two open `POST`s only; a session (401 `signed_out`); the token for a change (403 `csrf`); the admin role (403 `forbidden`); a body: `content-type` whose first value, lower-cased, is `application/json` or starts with `application/json;`, else 415 `not_json`; `JSON.parse` of the body as UTF-8 giving a plain object (not an array, not null), else 400 `bad_request`. Each refusal reads nothing after it.
3. **Errors** as the first plan: `{ "error": <code> }`, `no-store`, the security headers. A handler that rejects: 500 `internal_error` and `{ event: 'ui_failed', route, reason }` with `route` one of the first plan's or `ways`, `own_password` (`passwords.change` rejects on a failure, Task 4 rule 5), `accounts`, `account_new`, `account_role`, `account_reset`, `account_remove`. `passwords.signIn` and `passwords.firstPassword` never reject: they answer their own failures 500 `internal_error` and log them as `ui_signin` `failed` (Task 4, rule 7), so the route logs no `ui_failed` for them.
4. **`me`** answers `{ name: session.login, kind, role, csrf, mode, repositories }`.
5. **The listener** (call 22): `uiPart` counts `/api/auth/password` and `/api/auth/first-password` with `/api/auth/start` and `/api/auth/callback` against `UI_SIGNIN_IN_FLIGHT` (its comment names the four); `/api/auth/ways` stays with every other `/api` path against `UI_API_IN_FLIGHT`.
6. **The service.** With `config.ui` and `deps.ui`: GitHub is on when `githubSignInOn(config.ui)` and `deps.ui.signIn !== null` (`deps.ui.signIn` is read only when the first holds); `createAuth({ ..., signIn: <on> ? deps.ui.signIn : null })`; `createPasswordAuth({ db, clock, log: say, cost })` and `createAccountChanges({ db, clock, log: say, cost })` with `cost` `deps.ui.passwordCost` when given; the route with `ui: { publicUrl: config.ui.publicUrl, github: <on> }`. The app check's fourth argument is true only with GitHub on and a team named. With either absent nothing of this is made or read, as today.
7. **`main.ts`:** with `config.ui`, `ui: { signIn: githubSignInOn(config.ui) ? createGithubSignIn({ ... as today }) : null, files: loadUiFiles(...) }`.

**The answers, exactly in shape (values invented):**

```json
{ "name": "octo-admin", "kind": "password", "role": "admin", "csrf": "q7Jv0bW2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D", "mode": "live", "repositories": ["acme/shop"] }
```

```json
{ "github": false }
```

```text
POST /api/auth/password        sent { "name": "octo-admin", "password": "a long password of mine" }
                               200  { "next": "signed_in" } with set-cookie, or { "next": "choose_password" } with none
POST /api/auth/first-password  sent { "name": "octo-admin", "oneTimePassword": "k7m2q9xh4wz8r3bt6pn5", "password": "a long password of mine" }
                               200  { "next": "signed_in" } with set-cookie
POST /api/me/password          sent { "current": "a long password of mine", "password": "another long password" }   204, empty
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "accounts": [
  { "id": 1, "kind": "password", "name": "octo-admin", "role": "admin", "password": "set", "waitsUntil": null, "madeAt": "2026-03-01T09:00:00.000Z",
    "madeBy": { "kind": "command", "name": null }, "lastSignInAt": "2026-03-01T09:58:00.000Z", "you": true },
  { "id": 2, "kind": "github", "name": "octo-lead", "role": "viewer", "password": null, "waitsUntil": null, "madeAt": "2026-03-01T09:30:00.000Z",
    "madeBy": { "kind": "sign_in", "name": null }, "lastSignInAt": "2026-03-01T09:30:00.000Z", "you": false } ] }
```

```text
POST /api/accounts/new         sent { "name": "octo-viewer", "role": "viewer" }
                               201  { "account": { "id": 3, "kind": "password", "name": "octo-viewer", "role": "viewer", "password": "one_time",
                                      "waitsUntil": null, "madeAt": "2026-03-01T10:00:00.000Z", "madeBy": { "kind": "password", "name": "octo-admin" },
                                      "lastSignInAt": null, "you": false },
                                      "oneTimePassword": "k7m2q9xh4wz8r3bt6pn5", "expiresAt": "2026-03-04T10:00:00.000Z" }
POST /api/accounts/role        sent { "id": 3, "role": "admin" }   200 { "account": { ...the row as above, "role": "admin" } }
POST /api/accounts/reset       sent { "id": 3 }                    200 the shape of /new's answer, with a new one-time password
POST /api/accounts/remove      sent { "id": 3 }                    204, empty
any refusal                    { "error": "<code>" } with the status of rule 1 or 2
```

- [ ] **Step 1: Write the failing tests and the changes.**

`src/ui/route.test.ts`: the harness gains `const COST = { log2N: 4, r: 1, p: 1 }`, and `createUiRoute({ auth, api, files: FILES, log })` becomes `createUiRoute({ auth, passwords: createPasswordAuth({ db, clock, log, cost: COST }), accounts: createAccountChanges({ db, clock, log, cost: COST }), api, files: FILES, ui: { publicUrl: 'https://visto.example.test', github: true }, log })`; `send` gains an optional `body` (a string, sent as a `Buffer`) and `origin` and `type` headers; in `a person signs in, reads who they are, ...`, the expected `/api/me` body becomes `{ name: 'octo-lead', kind: 'github', role: 'viewer', csrf: tokenOf(id), mode: 'dry_run', repositories: ['acme/shop'] }`.
`src/ui/api.test.ts`: `me holds the login, ...`'s expected value becomes `{ name: 'octo-lead', kind: 'github', role: 'viewer', csrf: ..., mode: 'dry_run', repositories: [...] }` as it was otherwise; `ME` becomes `{ name: true, kind: true, role: true, csrf: true, mode: true, repositories: true }`.
`src/service.test.ts`: a constant `PASSWORDS_FOR_TESTS: PasswordCost = { log2N: 4, r: 1, p: 1 }`; `uiDeps()`'s `ui` gains the plain property `passwordCost: PASSWORDS_FOR_TESTS`; in `a member of the team signs in through the service, ...`, `ui: { signIn, files }` becomes `ui: { signIn, files, passwordCost: PASSWORDS_FOR_TESTS }` and `who.login` becomes `who.name`.
`ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/activity.test.tsx`: `ME` becomes `{ name: 'octo-lead', kind: 'github', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: [...as it was] }`.

```ts
// src/ui/route.test.ts
test('a password account signs in, reads who it is with its role, and an admin reads the accounts', async () => {
  /* octo-admin (admin, chose): POST /api/auth/password with origin and JSON: 200 signed_in and a cookie; /api/me: name octo-admin, kind password, role admin;
     /api/accounts: 200 Accounts with octo-admin you true and no 'scrypt$' anywhere in the body */
});
test('a viewer is refused every admin route as forbidden, whatever it sends, and a change without the token is csrf first', async () => {
  /* a viewer's session: GET /api/accounts 403 forbidden; each POST /api/accounts/... with the token and a good body: 403 forbidden; without the token: 403 csrf;
     with a text/plain body and the token: 403 forbidden (the role before the body); no statement on ui_accounts but the session read */
});
test('the password sign-in and the first password need the public origin and JSON, and say so before reading anything', async () => {
  /* no Origin, 'https://other.example.test', 'https://visto.example.test/', 'null': 403 origin; text/plain, application/x-www-form-urlencoded, no type: 415 not_json;
     '[]', 'null', '7', '{': 400 bad_request; 'application/json; charset=utf-8': read; no statement for any refusal */
});
test('a role changed takes effect at the next request of the session it was changed for', async () => {
  /* octo-viewer's session: GET /api/accounts 403; octo-admin makes it admin: the same cookie, the next GET 200; made a viewer again: 403; removed: 401 signed_out */
});
test('with GitHub sign-in off the ways say so, and the start and the way back are not found', async () => {
  /* a route with github false and auth's signIn null: /api/auth/ways { github: false }; start and callback 404 not_found; with github true: { github: true } */
});
test('each account route answers each refusal with its status and code', async () => {
  /* new 'Octo' 400 bad_name; again 409 name_taken; role on 99 404 not_found; role { id: 'x' } 400 bad_request; the last admin 409 last_admin;
     reset of a GitHub row 409 github_account; reset of oneself 409 own_account; remove 204 then 404; me/password from a GitHub session 409 github_account */
});
test('a handler of the new routes that fails is internal_error, logged with its route name only', async () => {
  /* a statement of each route rejecting: 500, one ui_failed { route, reason } each (own_password, accounts, account_new, account_role, account_reset, account_remove);
     a statement of /api/auth/password and of /api/auth/first-password rejecting: 500 internal_error, one ui_signin { way: 'password', outcome: 'failed' } and no ui_failed */
});
// src/shell/http.test.ts
test('the password sign-in and the first password count against the sign-in places, and the ways against the API\'s', async () => {
  /* POST /api/auth/password and POST /api/auth/first-password held: /api/auth/start, /api/auth/password and /api/auth/first-password are 503 busy, unread,
     while /api/auth/ways and /api/me are served; released. Four of /api/accounts and /api/auth/ways held: /api/auth/ways and /api/me are 503 busy, unread,
     while POST /api/auth/password is served */
});
// src/service.test.ts
test("with only the UI's address, the service serves password sign-in alone, and with the UI off nothing of the accounts is read", async () => {
  /* uiYaml 'ui:\n  publicUrl: https://visto.example.test\n' with ui (signIn null): /api/auth/ways { github: false }; /api/auth/start 404; the signIn getter never read;
     uiTeamCalls [false]; an account made by statements signs in through POST /api/auth/password and reads /api/me;
     the harness as it is, uiYaml only, and ui only: no statement holds 'ui_accounts' */
});
test('a password sign-in through the service logs no name and no password', async () => {
  /* a sign-in, a wrong one, a first password: no log line holds 'octo-' or either password; the ui_signin lines have way 'password' */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/route.test.ts src/ui/api.test.ts src/shell/http.test.ts src/service.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint`, the four `ui` scripts (`npm --prefix ui run lint`, `typecheck`, `test`, `run build`) and the ASCII check.
- [ ] **Step 5: Commit** `feat: the routes of password sign-in and accounts, roles checked by the API, and the origin of a sign-in`.

---

### Task 7: The command for the first admin and the way back in

**Files:**
- Create: `src/ui/accounts-cli.ts`, `src/ui/accounts-cli.test.ts`
- Modify: `package.json` (the script `"accounts": "node src/ui/accounts-cli.ts"`, after `app:create`)

**Interfaces:**

```ts
// src/ui/accounts-cli.ts
export type Command =
  | { kind: 'make'; config: string; name: string; role: Role }
  | { kind: 'reset'; config: string; name: string }
  | { kind: 'github'; config: string; login: string; role: Role };
/** The arguments; a usage error throws UsageError (its message the usage line). */
export function parseArgs(argv: string[]): Command;
/** One command on a database that has 0015_accounts; the lines go to `out`. The exit code. */
export function runCommand(command: Command, deps: { db: Db; clock: () => Date; out: (line: string) => void; cost?: PasswordCost }): Promise<number>;
/** Reads the config with loadConfig, opens postgresDb(database.url, () => {}) (a no-op log: the command writes no log line), runs, closes. */
export function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number>;
```

**Rules (4.6; calls 9, 23):**

1. **Arguments, exactly:** `make --config <path> --name <name> --role <admin|viewer>`, `reset --config <path> --name <name>`, `github --config <path> --login <login> --role <admin|viewer>`, each option once, in any order, nothing else. Anything else: the one line `usage: accounts make --config <path> --name <name> --role <admin|viewer> | reset --config <path> --name <name> | github --config <path> --login <login> --role <admin|viewer>` and exit 2.
2. **`main`:** a config that cannot be read: `usage: cannot read --config`, exit 2; a `ConfigError`: `config: <issue>` for each, exit 2; no `database`: `usage: accounts needs a database in the config`, exit 2. The database is `postgresDb(config.database.url, () => {})`: the pool's own `database_error` lines go to a no-op log, so nothing reaches stdout or stderr but the lines of rules 1 to 3. It is closed after the run whatever happened; a close that fails changes nothing.
3. **`runCommand`:** `isApplied(db, '0015_accounts')` false: `not_migrated`, exit 1, nothing written. Then, through `createAccountChanges({ db, clock, log: () => {}, cost })` with `{ by: 'command' }`:
   - `make`: `made <name> (<role>)`, `one-time password: <password>`, `expires at <ISO>`; exit 0.
   - `reset`: `reset <name>`, `one-time password: <password>`, `expires at <ISO>`; exit 0. (as built) It finds the password account by the name as written: a name in another letter case reads `not_found`.
   - `github`, by Task 5's `setRole` answer: `made` true: `made the GitHub account <login> (<role>)`; `changed` true: `set the GitHub account <login> to <role>`; both false: `the GitHub account <login> is <role> already`; exit 0.
   - a refusal: its code alone (`bad_name`, `bad_login`, `name_taken`, `full`, `not_found`, `last_admin`), exit 1; a failure: its short code or `internal_error`, exit 1.
4. The one-time password is printed once and nowhere else; the command writes no log line (call 23). (as built) `npm run accounts` prints npm's own two lines on stdout before the command's, so a script that reads the command's lines runs `npm run --silent accounts -- ...`.

- [ ] **Step 1: Write the failing tests.** `runCommand` on PGlite with a clock and COST; `main` only on paths that open no database.

```ts
test('make prints the one-time password once, with the name, the role and when it expires, and exits 0', async () => {
  /* make octo-admin admin: exactly ['made octo-admin (admin)', 'one-time password: <20 alphabet characters>', 'expires at 2026-03-04T10:00:00.000Z'];
     the password verifies the row's hash; a record by_kind command */
});
test("reset prints a new one-time password, and github sets a login's role, making its row", async () => {
  /* reset octo-admin: a new password, the old one no longer verifies, sessions gone; github octo-dev viewer: ['made the GitHub account octo-dev (viewer)'];
     again viewer: ['the GitHub account octo-dev is viewer already'], no record added; admin: ['set the GitHub account octo-dev to admin'], a record role admin */
});
test('the command refuses to leave no admin, a name taken, a name of another shape, an unknown account and a full table, with their codes and exit 1', async () => {
  /* octo-lead the only admin: github octo-lead viewer: ['last_admin'], 1, unchanged; make octo-admin twice: name_taken; make 'Octo': bad_name;
     reset octo-nobody: not_found; github 'octo_lead': bad_login; 1,000 rows: full */
});
test('arguments that are missing, unknown or repeated are a usage error with exit 2, and nothing is opened', async () => {
  /* [], ['make'], make without --role, --role owner, --name twice, an extra positional, an unknown option, reset with --role: parseArgs throws the usage line;
     main answers it with 2 */
});
test('a database not migrated to 0015 is refused as not_migrated and nothing is written', async () => { /* migrations below 0015 only: ['not_migrated'], 1 */ });
test('a config that cannot be read, or refused, or without a database, is a usage error', async () => {
  /* a missing file: 'usage: cannot read --config', 2; a file with an unknown key: 'config: ...', 2; a valid file with no database: 'usage: accounts needs a database in the config', 2 */
});
test('no line but the one-time password\'s holds a secret, and the command logs nothing', async () => {
  /* across the tests above: no line holds 'scrypt$', and only the 'one-time password: ' lines hold a one-time password; process.stdout.write is never called */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/accounts-cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the accounts command, which makes the first admin and is the way back in`.

---

### Task 8: The client and the sign-in page with a password

**Files:**
- Modify: `ui/src/api-types.ts`, `ui/src/api.ts`, `ui/src/app.tsx`, `ui/src/pages/sign-in.tsx`
- Test: `ui/src/pages/sign-in.test.tsx` (two tests replaced, new tests), `ui/src/app.test.tsx` (the fake, one change, a new test), `ui/src/components/layout.test.tsx` and `ui/src/pages/activity.test.tsx` (the fake)

**Interfaces:**

```ts
// ui/src/api-types.ts adds AccountKind, Role, Ways, SignInStep, Account, Accounts, OneTime, AccountAnswer to its re-export
// ui/src/api.ts, Api gains
  ways(): Promise<Ways>;
  passwordSignIn(name: string, password: string): Promise<SignInStep>;
  firstPassword(name: string, oneTimePassword: string, password: string): Promise<SignInStep>;
  changePassword(csrf: string, current: string, password: string): Promise<void>;
  accounts(): Promise<Accounts>;
  makeAccount(csrf: string, name: string, role: Role): Promise<OneTime>;
  setRole(csrf: string, id: number, role: Role): Promise<AccountAnswer>;
  resetPassword(csrf: string, id: number): Promise<OneTime>;
  removeAccount(csrf: string, id: number): Promise<void>;
// ui/src/pages/sign-in.tsx
export function SignIn(props: { api: Api; error: string | null; onSignedIn: () => void }): JSX.Element;
```

**Rules (4.7; calls 13, 15, 25):**

1. **The client.** A call with a body sends `{ method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', ...token }, body: JSON.stringify(<the body of Task 6>) }`; a change behind a session adds `x-visto-csrf`; `signOut` is unchanged. An answer 204 reads no body. Paths as Task 6.
2. **`App`** renders `<SignIn api={api} error={...} onSignedIn={...} />` with the raw `api` (a sign-in's 401 is a refusal, not a sign-out); `onSignedIn` reads `me()` again. Its watched API covers every method.
3. **The sign-in page** reads `api.ways()` once; until it answers `github: true` (and when it fails) no GitHub part is shown.
4. **Texts, exactly** (the card, the brand and the heading's classes as the first plan's):

| Where | Text |
|---|---|
| First step | `<h1>Sign in</h1>`; line `Sign in with your name and password.` (`text-sm text-muted`); `<form aria-label="Sign in with a password" class="flex flex-col gap-3">`: `<label class="text-sm font-medium">` `Name` over an `Input` (`autoComplete="username"`, `autoCapitalize="none"`, `spellCheck={false}`), `Password` over an `Input type="password"` (`current-password`), a primary `Button type="submit"` `Sign in` (while sending: disabled, `Signing in`) |
| GitHub part | below the form, a line `text-sm text-muted` `Or with the GitHub account this deployment lets in:` and a `Button` asChild (default variant, `self-start`) `<a href="/api/auth/start">Sign in with GitHub</a>` |
| Choosing | `<h1>Choose your password</h1>`; line `This was a one-time password. Choose the password you will sign in with: 12 to 128 characters.`; `<form aria-label="Choose your password">`: `New password` and `New password again` (`new-password`); primary `Choose and sign in` (sending: `Signing in`); default `Cancel`, which goes back to the first step and forgets the one-time password |
| Alert | above the form, `<p role="alert" class="text-sm text-bad">`, one at a time |
| From a password | `refused`: `The name or the password is wrong. After five wrong tries in a row, an account waits 15 minutes.`; `expired`: `This one-time password has expired. Ask an admin for a new one.`; `already_chosen`: `This account has its own password already. Sign in with it.`; `password_length`: `A password has 12 to 128 characters.`; `same_password`: `Choose a password other than the one-time password.`; the two new ones differ (checked before sending): `The two passwords are not the same.`; a length out of bounds (checked before sending): the `password_length` text; status 503: `The service is busy. Try again in a moment.`; status 0: `The service could not be reached. Try again in a moment.`; any other: `The sign-in failed.` |
| From GitHub (`?error=` on `/ui/signin`) | the first plan's five, `full`: `This deployment keeps 1,000 accounts at most. An admin can remove one.`, any other: `The sign-in failed.` |

5. A refusal keeps the name typed and empties the password fields. `{ next: 'signed_in' }` calls `onSignedIn`; `{ next: 'choose_password' }` shows the choice. (as built) The page keeps the name the first step sent together with the one-time password, in one state, and the choice sends that name; the first step's `Name` and `Password` are disabled while it is sent. On the choice, a refusal `refused`, `expired` or `already_chosen` does what `Cancel` does (the one-time password forgotten, the first step again with the name kept) and says its sentence above the first form, so a one-time password that can no longer work is never sent again; `password_length`, `same_password`, a 503, status 0 and any other keep the choice. The choice's form holds, before `New password`, a read-only `<input class="sr-only">` with `autoComplete="username"`, `tabIndex={-1}` and the kept name, so a password manager keeps the new password under that name. Each form's submit is default-prevented, also while it is sent.

- [ ] **Step 1: Write the failing tests and the changes.**

Each `fakeApi` of `ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx` and `ui/src/pages/activity.test.tsx` gains, after `signOut`, `ways` (records `['ways']`, answers `over.ways` or `{ github: true }`), `accounts` (records, answers `over.accounts` or `{ now: NOW, accounts: [] }`), and the seven others, each recording `[name, ...args]` and answering `over.<name>` or rejecting `new RequestFailed(500, 'not_expected')`.
`ui/src/app.test.tsx`, test `any read answered 401 shows the sign-in page`: after the line `await act(() => vi.advanceTimersByTimeAsync(5000));`, the line `await act(async () => {});` is added.
`ui/src/pages/sign-in.test.tsx`: its two tests are replaced by the first two below (their assertions on the reasons, the card, the brand and the GitHub link move there, with the link's classes those of a default button).

```tsx
test('each reason GitHub sent back reads as pinned, above the form, and none or an empty one shows no alert', async () => { /* the five, full, failed, busy, __proto__ */ });
test('the sign-in page is a centred card with the brand, its heading, the password form, and the way through GitHub only when it is on', async () => {
  /* ways { github: true }: the link /api/auth/start after the form; { github: false } and a ways that rejects: no link; the labels, the autocomplete values */
});
test('a right password signs in, and a refusal says its sentence and keeps the name', async () => {
  /* signed_in: onSignedIn once, passwordSignIn('octo-admin', 'a long password of mine'); refused 401: the sentence, the name kept, the password empty */
});
test('a one-time password leads to choosing a password, twice, which signs in', async () => {
  /* choose_password: the heading Choose your password; firstPassword('octo-new', <the one-time password>, 'a long password of mine'); onSignedIn */
});
test('the choice checks the two passwords and their length before sending', async () => { /* different: the sentence, no call; 11 characters: the length sentence, no call */ });
test('each refusal of the choice reads as pinned, and Cancel goes back', async () => { /* expired, already_chosen, same_password, password_length, 503, 0 */ });
// ui/src/app.test.tsx
test('the new requests send JSON with their method, path and body, and a change behind a session its token', async () => {
  /* each method of rule 1 against a recording fetch: the exact init; a 204 resolves undefined; a 409 { error: 'last_admin' } rejects RequestFailed(409, 'last_admin') */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: the sign-in page with a name and a password, the choice of a first password, and the client of the new routes`.

---

### Task 9: The sidebar by role, and Change password

**Files:**
- Create: `ui/src/pages/password.tsx`, `ui/src/pages/password.test.tsx`
- Modify: `ui/src/components/layout.tsx`, `ui/src/app.tsx`
- Test: `ui/src/components/layout.test.tsx` (new tests)

**Rules (4.7; call 25):**

1. **The sidebar** lists Settings only when `me.role` is `admin`. The user block's line is `Signed in with GitHub` for a GitHub account and `Signed in with a password` for a password account, which adds, under it, `Link` to `/ui/password` `Change password` (`text-xs`).
2. **Paths:** `/ui/password` is the Change password page for a password account and the not-found page for a GitHub one; `/ui/settings` stays `Later` for an admin until Task 10 and is the not-found page for a viewer.
3. **A role that changed:** an answer 403 `forbidden` to any watched call makes `App` read `me()` again, keeping the page on screen; its answer replaces who is signed in. (as built) The read again belongs to the session that asked it: `App` notes the signed-in `me`'s `csrf` when it asks (from a ref kept current at render), and its answer, a new `me` or a 401, applies only while the state is still signed in with that same `csrf`, so an answer that comes after a sign-out and another person's sign-in leaves that person, their name, their entries and their token as they are.
4. **Change password**, texts exactly: `PageHeader` `Change password`, sub `Your other sessions end when it changes.`; a `Card` `flex max-w-[480px] flex-col gap-3 p-6` holding `<form aria-label="Change password">` with `Current password` (`current-password`), `New password` and `New password again` (`new-password`), a primary `Change password` (sending: `Changing`). Success: `<p role="status" class="text-sm text-ok">Your password is changed. Your other sessions have ended.</p>` and the fields emptied. Alerts (`role="alert"`, `text-sm text-bad`): `wrong_password`: `The current password is wrong, or the account is waiting after five wrong tries (15 minutes).`; the length and the two new ones that differ as Task 8 (checked before sending); 503 and 0 as Task 8; any other: `The password could not be changed.` (as built) An empty `Current password` is not sent (the service would count it as a wrong try toward the wait): the page says `Write your current password.`, checked before the two new ones and their length, and empties the fields as the other checks before sending do.

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/components/layout.test.tsx
test('a viewer has no Settings entry, and an admin has it', async () => { /* role viewer: four entries; admin: five */ });
test('a password account is said so and links Change password; a GitHub account does not', async () => {
  /* kind password: 'Signed in with a password', the link /ui/password; kind github: 'Signed in with GitHub', no link */
});
test('a viewer at /ui/settings and a GitHub account at /ui/password see Not found', async () => { /* headings Not found */ });
test('a 403 forbidden makes the app read who is signed in again, and Settings goes', async () => {
  /* an admin on /ui/activity; activity rejects 403 forbidden once and me then answers role viewer: no Settings entry, the page still shown */
});
// ui/src/pages/password.test.tsx
test('the current password and the new one twice change the password, and say so', async () => { /* changePassword(csrf, current, new); the status line; emptied */ });
test('each refusal reads as pinned, and nothing is sent for two new ones that differ or a length out of bounds', async () => { /* wrong_password, 503, 0, other */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: Settings in the sidebar for admins only, how a person signed in, and the Change password page`.

---

### Task 10: Settings opens on Accounts

**Files:**
- Create: `ui/src/pages/accounts.tsx`, `ui/src/pages/accounts.test.tsx`
- Modify: `ui/src/app.tsx` (`/ui/settings` for an admin), `ui/src/format.ts` (`utc`)
- Test: `ui/src/format.test.ts` (new test), `ui/src/app.test.tsx` (one change)

**Interfaces:**

```ts
// ui/src/format.ts
/** `YYYY-MM-DD HH:MM UTC`; a time that cannot be read is ''. */
export function utc(at: string): string;
```

**Rules (4.7; calls 9, 12, 25):**

1. **The page:** `PageHeader` `Settings`, sub `Who may open the service, and what they may do. The other settings come in a later plan.`; a `Card` section `aria-labelledby` its `<h2 class="m-0 text-base font-semibold">Accounts</h2>`, whose head (`flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]`, as Activity's) holds the heading with a muted `Badge` `<n> accounts` (`1 account`) and, while the form is closed, a primary `Button` `New account`.
2. **The form** (opened by `New account`), `<form aria-label="New account" class="flex flex-wrap items-end gap-3 border-t border-border px-5 py-4">`: `Name` over an `Input` (`autoComplete="off"`, `autoCapitalize="none"`), `Role` over the native select (`Viewer` value `viewer`, first; `Admin` value `admin`), a primary `Make the account` (sending: `Making`) and `Cancel`; under them `<p class="w-full text-[13px] text-muted">1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.</p>`. A name failing that rule is refused before sending, with the `bad_name` text.
3. **The one-time password,** after a make or a reset: `<div role="status" class="flex flex-col gap-2 border-t border-border bg-subtle px-5 py-4">` holding `<strong class="text-sm">One-time password for <name></strong>`, `<code class="font-mono text-[15px]">` the password, `<p class="text-[13px] text-muted">Shown once. <name> signs in with it once, then chooses a password. It expires <utc(expiresAt)>.</p>`, `Copy` (`navigator.clipboard.writeText`; then its text is `Copied`; a refusal adds `The copy was refused: select the password and copy it by hand.`) and `Done`, which forgets it. It is kept in the page's state only.
4. **The table** (`overflow-x-auto`, the first plan's `Table`): `Name`, `Signs in with`, `Role`, `Last sign-in`, `Made`, `Actions`. Name: the name `font-medium`, then a muted `Badge` `GitHub` for a GitHub account and an accent `Badge` `You` for `you`, `flex flex-wrap items-center gap-2`. Signs in with: `GitHub` or `Password`, and for a password account a line `text-[13px] text-muted`: `Has not chosen a password yet` (`one_time`), `Its one-time password has expired` (`expired`), `Waiting after five wrong tries, until <utc(waitsUntil)>` while it waits. Role: accent `Admin` or muted `Viewer`. Last sign-in: `ago(lastSignInAt, now)`, or muted `Never`. Made: `ago(madeAt, now)` over `by <name>`, `by the command` or `at its first sign-in` (`text-[13px] text-muted`). Actions (`flex flex-wrap gap-2`): `Make viewer` or `Make admin`; `Reset password` for a password account that is not `you`; `Remove`, which turns the cell into `<span class="text-[13px]">Remove <name>? Their sessions end at once.</span>`, a primary `Remove` and `Cancel`.
5. **Refusals,** one alert above the table, `<p role="alert" class="border-t border-border px-5 py-3 text-sm text-bad">`: `last_admin`: `The last admin cannot be made a viewer or removed. Make another admin first: one who has not chosen a password yet does not count.`; `own_account`: `Change your own password from the sidebar.`; `not_found`: `This account no longer exists.`; `name_taken`: `An account with this name exists already.`; `bad_name`: `A name is 1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.`; `full`: `This deployment keeps 1,000 accounts at most. Remove one first.`; 503: `The service is busy. Try again in a moment.`; (as built) status 0, as the other pages: `The service could not be reached. Try again in a moment.`; any other: `The change failed.`
6. **States:** the first read: `<p class="px-5 py-3 text-sm text-muted">Reading the accounts.</p>`; a failed read: `The accounts could not be read.` and a `Button` `Try again`; no row: `No account yet.` in one cell. After each change (or a `not_found`) the list is read again; it is not polled.
7. **`utc`:** `2026-03-04T10:00:00.000Z` reads `2026-03-04 10:00 UTC`.

- [ ] **Step 1: Write the failing tests and the one change.**

`ui/src/app.test.tsx`, test `each sidebar entry leads to its page, ...`: the row `['Settings', '/ui/settings', 'Settings']` is removed from `pages`.

```tsx
// ui/src/pages/accounts.test.tsx
test('the accounts are listed with how they sign in, their role, their last sign-in and who made them', async () => {
  /* rows of each password state, waiting, GitHub, you: each cell's text as rule 4; 'Reset password' absent for you and for GitHub */
});
test('a new account shows its one-time password once, with Copy, until Done', async () => {
  /* userEvent.setup() before render (jsdom has no navigator.clipboard; setup attaches user-event's clipboard stub); makeAccount(csrf, 'octo-viewer', 'viewer');
     the box with the password and 'It expires 2026-03-04 10:00 UTC.'; Copy: await navigator.clipboard.readText() is it, the text Copied; Done: gone;
     the list read again; nowhere after a remount */
});
test('a name of another shape is refused before sending, and each refusal of the server reads as pinned', async () => { /* rule 5's eight */ });
test('a role is changed, a password reset and an account removed after its confirmation, and the list read again', async () => {
  /* setRole(csrf, 3, 'admin'); resetPassword(csrf, 3) shows a box; Remove then Cancel sends nothing; Remove then Remove: removeAccount(csrf, 3) */
});
test('reading, a failed read and Try again', async () => { /* the three states of rule 6 */ });
// ui/src/format.test.ts
test('a time is written in UTC to the minute', () => { /* the value of rule 7; 'x' gives '' */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: Settings opens on Accounts: making accounts, roles, resets and removals, with the one-time password shown once`.

---

### Task 11: The documents, the run under Docker, and the notes

**Files:**
- Modify: `README.md`, `config.example.yml`, `env.example`, `docs/superpowers/specs/2026-11-25-the-ui-design.md`, `docs/superpowers/specs/2026-11-26-password-sign-in-and-roles-design.md` and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built
- Create: `docs/superpowers/plans/2026-11-26-password-sign-in-and-roles-notes.md`

**Rules:**

1. **README.** Each sentence states only what the code does, with its cost where it has one. `## Status`: the UI's row becomes `UI: sign-in by password or through the GitHub App, admins and viewers, Accounts in Settings, and the Activity screen (off unless the config writes ui)`, with what was tried. In `### The UI (optional)`: switching it on (call 6) and the refusal; **a new part `**Accounts and roles.**`**: the two kinds and roles, what a viewer cannot reach, the last admin and who counts (call 8), resets (call 9), 1,000 accounts; **`**The first admin, and the way back in.**`**: the command's three forms, its lines and exit codes, that it reads the whole config and needs `0015_accounts`, the owner's line of "For the owner", 2; **`**Signing in with a password.**`**: one-time passwords (calls 12, 13), the password rule and the hash (call 11), the wait and the one sentence (calls 14, 15), names lower-cased (call 16), the `Origin` and JSON rule (call 21); in signing in through GitHub: GitHub rows (call 18); in the sessions: the role read at each request, changing one's own password, a reset and a removal (call 17); the caps: the sign-in places' four routes, and `/api/auth/ways` among the API's (call 22); the screens: the sign-in page, the sidebar by role, Change password, Accounts (call 25); the logs (call 24); the migration `0015_accounts` (call 3); and these statements, exactly:

```sql
-- who is signed in now, and as whom
select a.kind, a.name, a.role, s.via, s.created_at, s.last_used_at, s.expires_at
from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id where s.expires_at > now() order by s.last_used_at desc;
-- the record of account changes, newest first
select at, by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by at desc, id desc limit 100;
-- sign everyone out
delete from visto_ai.ui_sessions;
```

   `## Development`: nothing new; `## Repository layout`: the command beside `src/ui/`.
2. **`config.example.yml`:** the `ui` block's comment becomes, and the block lists `publicUrl` first (the test `the example's ui block, uncommented ...` passes unchanged; Step 2 runs it):

```yaml
# The web UI at <publicUrl>/ui/. It is on when publicUrl is written; with none of publicUrl, accounts and team it is off, and /ui/ and
# /api/ answer 404. Its accounts are made by an admin in Settings, and the first admin by the command npm run accounts (README, The UI).
# accounts and team name who may also sign in through the GitHub App, as a viewer until an admin says otherwise; with either,
# app.clientId and app.clientSecret must be written too, and on the app's settings page the callback URL is <publicUrl>/api/auth/callback.
# With team, install the app on that organisation with Members read. Everyone signed in sees the activity of every repository.
# ui:
#   publicUrl: https://visto.example.test
#   accounts: [octo-lead]
#   team: acme/reviewers
```

   and the `app` block's line `# Only when ui below names who may open the UI: ...` reads `# Only when ui below names who may sign in through GitHub: ...`, the rest unchanged.
3. **`env.example`:** its `APP_CLIENT_SECRET` comment reads `# Only if config.local.yml names who may sign in through GitHub: the client secret generated on the GitHub App's settings page.`
4. **The designs are amended,** in the same commit:

| Document, section | The sentence | Call |
|---|---|---|
| UI design 3.2, Who may open it | It becomes the password design's section 7, first bullet. | 6 |
| UI design 3.2, Who may change settings | It becomes: Admins only; viewers see everything but Settings, and the API refuses them its admin routes. | 20 |
| UI design 3.2, Sessions | It gains: A session belongs to an account, whose role is read at each request; a password sign-in makes the same session. | 17 |
| UI design 5 | It gains: `GET /api/auth/ways`, `POST /api/auth/password`, `POST /api/auth/first-password`, `POST /api/me/password`, `GET /api/accounts`, `POST /api/accounts/new`, `/role`, `/reset`, `/remove`. | 19 |
| UI design 8 | The bullet on roles is removed (the password design, 7). | 20 |
| Password design 4.2 | It gains: An admin cannot reset their own account in the UI; a reset keeps the role, so the last-admin rule does not refuse it. | 9 |
| Password design 4.3 | It gains: An expired one-time password reads as expired, but only once it was verified. | 15 |
| Password design 4.6 | It gains: It reads the whole config, as the service does, and uses only the database's address. | 23 |
| Password design 4.8 | It gains: A GitHub row made at its first sign-in is recorded as made by `sign_in`; a first password is recorded as `password_changed`. | 10 |
| Main 11.1, the UI's bullet | It becomes: The UI: the address people open it at (`ui.publicUrl`), and who may sign in through GitHub (accounts or one team, with the app's client id and secret, by reference); accounts and roles live in the database. | 6 |
| Main 13 | It gains: `ui_accounts` and `ui_account_changes` hold the UI's accounts and the record of their changes; a session names its account. | 7 |
| Main 18, item 10 | It gains: Password accounts and two roles, admin and viewer, are added beside GitHub sign-in. | 1 |

5. **The run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before; the images (this branch, `main` before it, Playwright's of the version the script uses, Postgres) are built or pulled before.
   - **The previous release first** (`main` before this branch), on an empty database, with the first plan's config and a session row written by statements, then stopped. This branch starts on it: the ledger gains `0015_accounts`, `ui_sessions` is empty; the previous release, started again, refuses (`unknown_migration_applied`).
   - **Every request no browser sends** is sent from inside the app's container by `node -e` with `fetch` (the image, `node:26-bookworm-slim`, has no `curl`), or from the Playwright container in the app's network namespace; none by `curl`.
   - **Password only:** `ui.publicUrl: http://localhost:8080` and nothing else of `ui`, no client id or secret, dry run. From inside the app's container: `/api/auth/ways` `{"github":false}`, `/api/auth/start` 404, `/api/me` 401. The command in the container: `make --name octo-admin --role admin` prints its three lines, exit 0; again `name_taken`, exit 1; no arguments, the usage line, exit 2.
   - **A browser** (Chromium, context A): signs in as `octo-admin` with the one-time password, is asked to choose, chooses, lands on `/ui/`; the sidebar has Settings, `Signed in with a password` and `Change password`; Settings lists `octo-admin` with `You`; `New account` `octo-viewer` (Viewer) shows the one-time password, `Copy` puts it in the browser's clipboard (every context is made with `grantPermissions(['clipboard-read', 'clipboard-write'])`; read back by `navigator.clipboard.readText()`), `Done` and a reload show it no more. Context B signs `octo-viewer` in with it and chooses: no Settings entry, `/ui/settings` Not found, and from B's page `fetch('/api/accounts')` 403 `forbidden`, a `POST /api/accounts/new` with B's token 403 `forbidden`.
   - **A role at the next request:** A makes `octo-viewer` an admin; B's next `GET /api/accounts` 200 with no new sign-in; A makes it a viewer again; B's next 403.
   - **The wait, and the time of refusals** (an account waits after 5 wrong passwords, so 20 wrong ones cannot be timed in a row): by `node -e` with `fetch` in the app's container, each `POST /api/auth/password` with `Origin: http://localhost:8080` and JSON, timed by `performance.now()` around the `fetch`: five runs of 4 wrong passwords for `octo-viewer` then its right one (which clears the count), only the 20 wrong ones timed; 20 refusals of unknown names. Then in a context C, five wrong passwords for `octo-viewer`, then the right one: six times the same sentence, and it waits; then 20 refusals of `octo-viewer` while it waits (its right password among them), timed in the container as before. The three medians (wrong, unknown, waiting) are written in the notes, each within 25% of the others. A's reset of `octo-viewer` ends the wait and its sessions (B's next request 401), and C signs in with the new one-time password.
   - **The origin:** by `node -e` with `fetch` in the app's container, `POST /api/auth/password` with `Origin: https://other.example.test`, and with no `Origin` set: 403 `origin`; with the right `Origin` and `content-type: text/plain`: 415 `not_json`.
   - **The last admin:** A making itself a viewer: 409 and the page's sentence. With `octo-viewer` an admin that chose its password, `psql` runs `begin; lock table visto_ai.ui_accounts in share row exclusive mode;` (the code's own mode, which leaves the session read free) and holds it; A and B each send the other's demotion; `select count(*)::int from pg_stat_activity where wait_event_type = 'Lock' and query like 'lock table visto_ai.ui_accounts%'` reads 2 (both requests wait on the lock statement, past their session reads); `psql` commits within the pool's `statement_timeout` (15 s, `POOL_OPTIONS`, past which the waiting lock statements would be cancelled): one answered 200, the other 403 `forbidden`, and `select count(*)::int from visto_ai.ui_accounts where role = 'admin'` reads 1.
   - **Change password and removal:** A changes its password; A's second context (a second sign-in) reads 401 at its next request, A's own keeps working; A removes `octo-viewer`: B's next request 401.
   - **GitHub beside it:** the first plan's stub of `github.com` and `api.github.com` (a CA of the run, `NODE_EXTRA_CA_CERTS`, network aliases), `ui.accounts: [octo-lead]`, an invented client id and a random secret; restarted: `/api/auth/ways` `{"github":true}`; `octo-lead` signs in through GitHub in context D, lands on `/ui/`, `Signed in with GitHub`, no Settings; the command `github --login octo-lead --role admin`, then D reloads: Settings; A's password sign-in still works beside it.
   - **The record:** the README's second statement lists every change of the run, in order, with who made it.
   - **Throughout,** every log line is one JSON object, and none holds `octo-admin`, `octo-viewer`, `octo-lead`, a password, a one-time password, `scrypt$`, a cookie's value, a code, a state or a token. Screenshots in light and dark (the sign-in page with and without GitHub, the choice of a password, Accounts with a one-time password shown, Change password) are shown to the owner and kept out of the repository. Everything the run made is removed.
6. **The notes file,** in the form of the plans before: the status, the decisions taken while building, what the reviews found, what the run showed, what is for the owner, what is known and left, and what is not verified.

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the root suite, type check, lint, the four `ui` scripts and the ASCII check, `the example's ui block, uncommented ...` among them.
- [ ] **Step 3: Commit** `docs: password sign-in and roles in the README, the config examples, the designs, and the plan as built`.

---

## To verify

None of these is shown by a test of this plan. Each names the step of Task 11 that can show it, or "For the owner" when it needs GitHub and his browser.

1. **That refusals last alike on the real image** (an unknown name, a wrong password timed in runs of 4, an account that waits). Task 11, rule 5, the wait.
2. **That the lock serializes two changes on Postgres,** where PGlite runs one transaction at a time anyway. Task 11, rule 5, the last admin.
3. **That scrypt at production cost runs in the image** on Linux, on this machine's processor (the image is built for it only; the package lock holds both Linux platforms' entries as before; the test of Task 2 runs it where the suite runs). Task 11, rule 5.
4. **That browsers send `Origin` on a same-origin `POST`,** and that the clipboard works on `http://localhost`: Chromium in Task 11; other browsers not tried.
5. **GitHub itself,** as the first plan's "To verify", 1 to 4 and 7. For the owner, 7.
6. **The sizes:** 12 to 128 characters, 20 characters of 31, 72 hours, 5 tries, 15 minutes, 1,000 accounts, N 2^15, r 8, p 1 (and no stored cost above it), 64 MiB, 2 sign-in places for four routes, 200 and 1,024 characters of a body's strings.
