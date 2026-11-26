# The UI, Sign-in and Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment whose config names who may open the UI (`ui.accounts` or `ui.team`) serves a web application under `/ui/`. A person signs in through the GitHub App's own user authorization; the service reads who they are, lets them in when they are named or are an active member of the team, and gives them a session of 12 hours. They see the layout of the approved mockups (the sidebar, a theme switch, who is signed in, whether the service is live or in dry run) and the Activity screen: what runs now with its stage (waiting for pushes to settle, queued, preparing, reviewing batch n of m, judging threads, publishing) and who asked for it, withdrawals waiting to try again, and the reviews of the last 30 days with their outcome, highest score, findings, mode, cost, time taken and age, filtered by repository and outcome and searched by title or number. The other sidebar entries, and a review row's link, lead to a short "Coming in a later plan" page. With neither accounts nor a team named, `/`, `/ui/` and `/api/` answer 404 as today. The service starts storing pull request titles and the stage of a running review.

**Architecture:** The frontend is a package of its own, `ui/`, built by Vite into `ui/dist` in a stage of its own in the Dockerfile; the runtime image holds only the built files. The service reads those files once at start (`src/ui/files.ts`) and answers a third route group of `createListener` (`src/shell/http.ts`), with its own body cap and places (the files, the sign-in routes and the rest of the API each counted apart), for `/`, `/ui/...` and `/api/...`. `src/ui/route.ts` dispatches: static files with fixed cache and security headers, the sign-in routes of `src/ui/auth.ts` (state with a PKCE verifier, and sessions, in two new tables; `__Host-` cookies; the token for changes), and the JSON reads of `src/ui/api.ts`, built from an allowlist over `src/db/activity.ts`. The answers' shapes are one file of types, `src/ui/api-types.ts`, which the frontend imports with `import type` through one re-export. GitHub's authorize page, code exchange, user read and an organisation's installation sit behind one new interface, `ForgeSignIn`, in `src/forge/github/sign-in.ts`. The engine tells its caller when its model calls start and as each batch ends (`ReviewDeps.progress`); the review job turns that into a stage on its job row (`markStage`). Pull request events carry the title, which `savePullRequest` stores.

**Tech Stack:** The service: unchanged (Node 26 or later, type stripping, no build step, no new runtime library in `src/`). The frontend: React, TypeScript, Vite, Tailwind CSS, shadcn/ui components copied into `ui/`, Vitest with Testing Library on jsdom, all in `ui/package.json` with exact versions and a lock file. One migration, `0014_ui`. No model call.

**Spec:** `docs/superpowers/specs/2026-11-25-the-ui-design.md` (whole) and its mockups in `docs/superpowers/specs/2026-11-25-the-ui-mockups/` (`Activity.dc.html` and `Review.dc.html` for the layout, the sidebar and the tokens; `Main.dc.html` for the counts of "In review now"; `Settings.dc.html` for the dry-run card), and `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both designs. Section numbers below are the UI design's unless "main" is written: 1, 3.1, 3.2, 3.3 (items 1 and 2), 3.4, 5, 6, 7, 8; main 4, 8.1, 8.2, 10, 11.1, 13, 14, 16, 17, 18 (item 10), 22.

**Notes:** the notes file beside this plan is written when the build ends. This is the first of two plans of the frame (design 7, item 1; call 1). The second builds the One review screen.

**Words used below.** *The UI on*: the loaded config has `ui` (Task 1) and the service was given `ServiceDeps.ui` (Task 8). *Let in*: a GitHub account of type `User` whose login is in `ui.accounts` (letter case aside), or that is an active member of `ui.team`. *The way back*: `GET /api/auth/callback`. *A session*: a row of `visto_ai.ui_sessions`, named by a cookie. *The token for changes*: the per-session value the API checks in the header `x-visto-csrf` on `POST`, `PUT` and `DELETE`. *The stage*: the five columns a running review job gains (Task 2). *Held*: `runner.holds(ref)` of the review runner is true. *The window*: the 30 days before the clock. *Short code*: as in the plans before. *The mockup*: the approved file named; "as drawn" means its markup, classes and texts.

## Scope

| In this plan | Left out, and why |
|---|---|
| The `ui/` package, its build, lint, tests, lock file; the Dockerfile's build stage; CI | **The One review screen and its routes** (`/api/reviews/{run}`, `/api/pulls/...`): the next plan (call 1). A review row links to a "Coming in a later plan" page until then |
| Serving `/ui/`, `/` to `/ui/`, the API's route group, the headers of 3.2 | **Overview, Repositories, Memory, Settings**: plans 2 and 3 of the design's cut; their entries lead to "Coming in a later plan" |
| Sign-in through the GitHub App, the state, sessions, access, sign-out, the token for changes | **`app:create` keeping the client id and secret, and `callback_urls` in the manifest** (call 26): the owner sets both by hand |
| The layout: sidebar, theme switch, who is signed in, live or dry run | **Alerts, dependency health, spend per day, feedback, live score quality** (3.3 items 3 to 9): plan 3 |
| Activity: running and queued with the stage, withdrawals waiting to try again, recent reviews paged and filtered | **A per-repository check of who may see what** (call 13): the config names who runs the service |
| Titles and stages stored (3.3, items 1 and 2) | **Revoking the user's token after the read** (call 10) |

**Dry run:** the UI works the same; the sidebar says "Dry run"; the stage is written by dry-run reviews too, except `publishing`, which a dry run never reaches.

## Not in this plan

- The One review screen, its API and a finding's thread state (the next plan).
- Settings in the database, alerts, health, the other screens (plans 2 and 3).
- Changes to `app:create` and `app-manifest.json` (call 26).
- Any dropped idea (no verifier, no repository-wide packs, no recall-first contract, no lens pass), and any model call.

## Calls

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where a design says otherwise, the call says so.

**The cut and the stack**

1. **(builder) The frame is cut in two plans; this is the first:** configuration, the store, titles and stages, sign-in at the git boundary, the route group and the files, sign-in and sessions, the reads and the API of the frame and Activity, the route and the service serving it, the `ui/` package, the layout, the Activity screen, and the documents with the run: twelve tasks. The second builds the One review screen: its two routes, the derived thread state, the feedback read for one run, and the screen. Cost: until it is built a review row of Activity leads to "Coming in a later plan", so a person sees what ran but not why it decided as it did; the design's plan 1 ends one screen short.
2. **(builder) The stack:** React, TypeScript, Vite, Tailwind CSS (v4, through its Vite plugin), shadcn/ui components, Vitest and Testing Library on jsdom, with exact versions in `ui/package.json` (Task 9 lists them; they are checked when installed, and shown to install and run on Node 26) and `ui/package-lock.json`. Nothing enters the root `package.json`. Cost: a second package with its own lock, its own `node_modules` (about 300 packages), a second install in CI and in the image's build stage; updating it is its own work.
3. **(builder) shadcn/ui components, this plan's: button, card, badge, table, input,** written by hand into `ui/src/components/ui/` in the shape of shadcn/ui's published source for React 19 and Tailwind v4 (function components, `data-slot`, `cn`, `class-variance-authority` for variants, `@radix-ui/react-slot` for `asChild`), with the mockup's classes (Task 9) in place of shadcn's. No CLI fetches them. **(planner) The repository filter is a native `<select>` with the input's classes**, as the mockup draws it; shadcn's Select is a Radix popover that adds a `<style>` element, which the content security policy refuses. Tabs, switch and tooltip come with the screens that use them. The outcome filter is a small segmented control of our own (`ui/src/components/segmented.tsx`), as drawn. Cost: shadcn's later fixes are not pulled; each copy is ours to keep.
4. **(builder) Installing:** Task 9 runs `npm install` inside `ui/` with the network, for that command and `npm view` only, confirms that the pinned versions install and run on Node 26 (Node 26 defines `localStorage` and `Storage` itself, which breaks jsdom's: the test workers start with `--no-experimental-webstorage`), writes what it found in its report, and commits the lock file. Every other task works offline; `ui/node_modules` stays in the checkout. No task after Task 9 adds a package. Cost: a reviewer of a later task uses that checkout's `ui/node_modules`, or the network once.
5. **(builder) The build:** a stage of its own in the Dockerfile (`npm ci` and `vite build` in `ui/`), whose `dist` alone is copied into the runtime image; CI installs, lints, type-checks, tests and builds `ui/`. The root lint ignores `ui/`, which has its own config; the ASCII check reaches `ui/src`, `ui/index.html`, `ui/public` and `ui/*.ts`/`ui/*.js`. Cost: the image build needs the network for two `npm ci`; CI takes longer.
6. **(builder) Sign-in, sessions, access and headers as 3.2 says,** with the details of calls 9 to 12 and 17. Cost: as each of those says.
7. **(builder) Tests never reach the network:** GitHub's authorize page, code exchange, user read, installation read and membership read are fakes of `ForgeSignIn` and `ForgeChecks` in the service's tests, and a fetch stubbed by route in the adapter's; the frontend's tests stub the API object and block `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`. Cost: what GitHub really answers is shown only by the run of the owner's (For the owner, 3).
8. **(builder) No dropped idea returns; no model call.**

**Configuration and sign-in**

9. **The keys.** `ui.accounts` (GitHub logins, at most 100), `ui.team` (`<org>/<team-slug>`), `ui.publicUrl` (where people open the service: `https` with no path, query or user; or `http://localhost` or `http://127.0.0.1`, with a port or none, for a try on one machine), `app.clientId` (as GitHub shows it) and `app.clientSecret` (by reference; `APP_CLIENT_SECRET` in the examples). The UI is on when `ui.accounts` names one login or `ui.team` is written; then `publicUrl`, `clientId` and `clientSecret` must be written, each refused by name when not, in dry run too and for the eval commands, which read the same file. A `clientSecret` written is resolved whatever `ui` says. The loaded config carries `ui` only when it is on, with the five values; `app` stays the three it was. Access is read from the file only (3.2). Cost: a config with `ui` named and the sign-in keys missing does not start; an eval run with such a config needs the variable set.
10. **The sign-in.** `GET /api/auth/start` makes a random state and a random PKCE verifier (32 bytes each, base64url), stores both as their SHA-256 for 10 minutes (the state taken once), sets both in one cookie `__Host-visto_oauth=<state>.<verifier>` (`Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`, no `Domain`), then sends the browser to `https://github.com/login/oauth/authorize` with the client id, `redirect_uri=<publicUrl>/api/auth/callback`, the state, `code_challenge` (the base64url SHA-256 of the verifier), `code_challenge_method=S256` and `allow_signup=false`. The way back clears that cookie whatever it answers, takes the state only when the query's equals the cookie's and the cookie's verifier hashes to the stored one, then exchanges the code once (`POST https://github.com/login/oauth/access_token`, form parameters, with the verifier), reads `GET https://api.github.com/user` once with the token, and drops the token. **The design is silent on binding the state to the browser:** a `SameSite=Strict` cookie is not sent when GitHub sends the browser back, so the state's cookie is `Lax`; the session's is `Strict`, as 3.2 says. Cost: the user's token is not revoked and stays valid until GitHub expires it (8 hours with the app's default); a person who takes longer than 10 minutes on GitHub's page, or who opened the service at another host than `publicUrl` (the cookie is not sent there), signs in again (refused as `state`); one row per start until it expires.
11. **Access.** A login in `ui.accounts`, compared without letter case, is let in with no call. Otherwise, with `ui.team`, the service reads the app's installation on the team's organisation (`GET /orgs/{org}/installation`, the app's token) and then the membership with the existing `isTeamMember`, with that installation (Members read); only `active` is let in. A bot (`type` other than `User`) is never let in. Anything that cannot be read refuses (`unverified`). Membership is read again at each sign-in, not on each request (3.2). **(ruled after the review) A session keeps the way it was let in** (`via`: `account`, or the team's `org/slug` as the file wrote it) **and stops being one as soon as that way no longer holds** in the running config: `account` while the login is no longer listed, a team while `ui.team` is not that team (letter case aside), whatever else the file names (a restart with the login removed or the team changed). The feature `ui` is checked at start: with `ui.team`, the app lacks `members:read` is a `feature_off` (call 27). Cost: a member removed from the team keeps a session for up to 12 hours; with `ui.team`, the app must be installed on that organisation; the person is the login, so a login freed and taken by someone else is let in as the name says.
12. **Sessions.** The id is 32 random bytes in base64url (43 characters), stored as its SHA-256 in hex with the login, the way it was let in (call 11), the times made and last used, and an expiry 12 hours after it was made; the cookie `__Host-visto_session` holds the id only (`Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`, no `Domain`). **The last use is written when the stored last use is 60 seconds old or more** (a read every 5 seconds would otherwise write every 5 seconds). **(ruled after the review) Expired sessions and states are deleted at a start of a sign-in, at most once a minute; while 1,000 states are live, `GET /api/auth/start` answers 503 `busy` and stores nothing; the sign-in routes have 2 places of their own** (call 17), so requests nobody signed in for cannot take the database's 5 connections. Signing out deletes the row and clears the cookie. **The token for changes is not stored:** it is the base64url SHA-256 of `csrf:` and the session id, so only the holder of the cookie can know it; `GET /api/me` gives it, and `POST /api/auth/signout` refuses a request without it (403 `csrf`). Cost: a stolen session id gives its token too (the cookie is `HttpOnly`, so a script cannot read either); a deleted session's cookie lingers in the browser until it expires, and reads as signed out; a flood of starts can hold sign-in off for up to 10 minutes; rate limits beyond these caps are the proxy's in front (For the owner, 6).

**The API and what it shows**

13. **The routes and their answers** (Task 7 holds the exact JSON). All answers are JSON with `cache-control: no-store`; errors are `{ "error": <short code> }`: 400 `bad_request`, 401 `signed_out`, 403 `csrf`, 404 `not_found`, 405 `method_not_allowed`, 500 `internal_error`, 503 `busy` (the states' cap). A parameter written empty (`repo=`, `outcome=`, `before=`, `q=`) reads as absent.
    - `GET /api/me`: the login, the token for changes, `live` or `dry_run`, and the repositories the service has stored a pull request of (lower case, sorted, at most 200), which the sidebar counts.
    - `GET /api/activity`: the review jobs running or pending (at most 200; running first, by start, then by when they may start), each with its repository, number, title, a link to the pull request, the first 12 characters of its head, its stage (call 14), when it started when it runs, when it may start, and why it runs with the requester's login for a manual job; the withdraw jobs waiting to try again (pending with at least one start; at most 50) with their retry code (call 16) and when; the places (the review runner's concurrency and the withdraw runner's 2); and why reviews are paused (`spend_limit`, `model_error` or null).
    - `GET /api/reviews?repo=&outcome=&q=&before=`: the runs whose `started_at` is in the window, newest first, 25 a page, `before` the run id to page from (keyset), with the total that match; `repo` an `owner/name`, `outcome` `approved`, `needs_person` (with `audit`) or `failed`; `q` matches the title as a substring without letter case, or the number when it is digits with or without `#`. Each row: run id, repository, number, title, outcome (call 20), failure code, highest score and the run's own threshold, findings counted by severity (the placed findings, as the notice counts them), mode, dry run, cost, time taken (`finished_at - started_at`), and when it finished.
    - **Left out of every answer:** the loaded config; every secret; a run's body, comments and result (only the counts, the threshold and the nothing-new mark are read from it, in SQL); review ids, comment ids, installations, deliveries, associations, base shas and branches, the approval's dismissal facts, failure stages; any author's login; any text a person wrote. **What is shown and why it is safe:** the signed-in viewer's own login; a manual job's requester, who is an owner, member or collaborator of that repository and asked on the pull request itself; pull request titles, numbers and short heads. Everyone the deployment's file lets in sees every repository the app is installed on: the file names the people who run the service, who already can read its database and logs. Cost: a team member without read access to one repository sees its titles, numbers and requesters; nothing narrows that.
14. **The stage of a running review.** Five columns on `jobs` (`stage`, `stage_at`, `batch`, `batches` and `threads_due`, Task 2), written by the review job on its own row: `stage` is `preparing` (written first thing by the review job), `reviewing` or `judging_threads` (written from the engine's progress: before the first batch is sent and as each batch ends), or `publishing` (written just before the post, so never in dry run). `judging_threads` is written while a batch that holds a thread owed a verdict has not ended (`threads_due` counts those threads); such files are sent first (main 5.2, priority 1), so a review that judges threads shows it first, as the mockup does. **The design names "judging threads" as a step; the code judges threads inside the batch calls, beside the files:** this is how the stage tells it. `batch` is the batches ended plus one, at most `batches`. Writes are made only with `ReviewJobDeps.stages` (the service sets it), only on a running row, in order, and the job waits for them after the engine returns; one that fails changes nothing and logs nothing. **A claim clears the stage**, so a pending row's leftovers are never read, and the API reads the stage only of a running row. A crash leaves the row running with its stage, but the service is down; the next start's recovery puts it back to pending before listening, so the UI shows it queued. A running row the runner does not hold (left running by a job that could not record its run, main 8.2) reads as `stopped` ("runs again at the next start"), is listed in the table of what runs with its badge, and is counted as running (call 19). A running row with no stage reads as `preparing`. **(ruled after the review) A pending row reads `waiting` only when it is a push's job (`synchronize`) whose `run_at` is its `created_at` plus the 180 quiet seconds**, as receiving stores it; any other pending row not yet due (a job put back) reads `retrying`, and a due one `queued`. Cost: up to `batches + 2` more statements per review; the second scorer's step has no stage of its own (the last batch's stays shown); a stale running row of a pull request that has a newer running job reads as running.
15. **Titles** are carried by every pull request event that has one (`PullRequestFacts.title`), stored by `savePullRequest` (a newer event's wins, as for every fact), kept when an event carries none, never read back into `getPullRequest`. Cost: a pull request stored before this release shows `acme/shop #7` in place of its title until its next delivery; the title, which its author wrote, is stored and shown to people let in (React escapes it).
16. **A withdrawal's retry code.** `requeueJob` gains an optional code, stored in `jobs.retry_code` (null when none is given); only the withdraw job gives one, its failed try's short code. Cost: a review job waiting to try again shows no code.

**Serving and the frontend**

17. **Serving.** The files of `ui/dist` are read once at start into memory, keyed by the path they are served at; no path is ever joined to the folder, so nothing can leave it. `GET /ui/assets/<name>` serves a file with `cache-control: public, max-age=31536000, immutable` (Vite's names carry a hash), a missing one is 404; every other file, `index.html` included, is `no-store`; a path under `/ui/` that is no file is answered with `index.html`, so the application's own paths reload; `/ui` and `/` go to `/ui/` (302); a method other than `GET` is 405. Every answer of the group carries, exactly: `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: same-origin`, `x-frame-options: DENY`. The fonts are bundled (Fontsource packages) and Vite inlines no asset (`assetsInlineLimit: 0`), so the policy needs no `data:`; React sets styles through the DOM, which the policy allows. **(ruled after the review) Places, each counted apart:** the files (`/`, `/ui`, `/ui/...`, answered from memory with no database) 16; the two sign-in routes (`/api/auth/start`, `/api/auth/callback`) 2; every other `/api` path 4. One body cap of 64 KiB. Cost: a rebuilt `ui/dist` needs a restart; an unbuilt one leaves `/ui/` 404 while the API works (logged as `{ event: 'ui', files: 0 }`); the UI's reads share the database's 5 connections with the reviews, at most 6 of them at once; a fifth API request at once, or a third sign-in step, is answered 503 `busy` (plain, as the listener answers it).
18. **The theme** is the viewer's choice in local storage (`visto-theme`, `light` or `dark`), else the system's (`prefers-color-scheme`), followed live while no choice is stored; the class `dark` or `light` on `<html>` switches the mockup's tokens. **No flash:** before any script runs, the CSS itself follows `prefers-color-scheme` on a page with neither class (Task 9, rule 6). Storage that throws reads as no choice. Cost: none known.
19. **The counts of "In review now" follow the mockups:** `<r> running, <q> queued`, where running counts every job that runs, is stopped, or waits for pushes to settle (as `Main.dc.html`'s "3: 2 reviewing, 1 waiting for pushes to settle") and queued counts the due ones and those waiting to try again; the sidebar's badge is the running count, shown when above 0. Cost: a job that has not started is counted as running while its pushes settle.
20. **The outcome of a run,** the first that holds: `failed` (the run failed); `nothing_new` (not published and its result says nothing new); `audit` (`approval_code` is `audit_sample`); `approved`; `not_posted` (not dry run and not published: a publication that failed, was refused or waits, or a body that could not be rendered); `needs_person` (`needs_human`); `reviewed`. The filter `needs_person` takes `needs_person` and `audit`. Cost: a dry run never reads as approved (3.4); a run still waiting to be posted reads as not posted.
21. **Score colours:** red at or above the run's own threshold (`result.verdict.threshold`, 70 when it holds none), blue at 40 or above, green below; a failed run shows "None" and a nothing-new one "Kept", as drawn. Cost: none known.
22. **Relative times** ("48 s ago", "1:42 left") are counted from the `now` each answer carries, not from the browser's clock. Cost: none known.
23. **Polling:** the layout reads `/api/activity` every 5 seconds and the Activity screen reads the first page of `/api/reviews` every 15 seconds, neither while the page is hidden, both again when it shows; a failed read turns "Updating live" into "Not updating" until one works; any 401 shows the sign-in page. Cost: a viewer makes about 16 requests a minute.
24. **A sign-out control** (the mockups have none, the design has the route): an icon button beside the theme switch, `aria-label="Sign out"`. Cost: one button the owner did not see.
25. **Pages the mockups do not draw,** with texts pinned in Tasks 10 and 11: the sign-in page with its reasons, "Coming in a later plan" (Overview at `/ui/`, Repositories, Memory, Settings, and a review at `/ui/reviews/<run>`), a page not found, the loading and unreachable states, and the stages and outcomes the mockup does not show (Preparing, Publishing, Waiting to try again, Stopped, Not posted). The way back lands on `/ui/`. Cost: the first page after a sign-in is "Coming in a later plan" until the Overview is built.
26. **`app:create` and the manifest are not changed.** The owner sets the callback URL and generates the client secret on the app's settings page (For the owner, 2). Cost: two steps by hand on GitHub; an app made by `app:create` drops the client secret GitHub returned (it can be generated again at any time).
27. **Members read for the team.** `missingFor` and `AppIdentity.lacks` gain the feature `ui`: with `ui.team` named, the app lacking `members:read` is reported at start (in dry run too, since the read is made in dry run). Cost: none known.
28. **One file of shapes.** `src/ui/api-types.ts` holds the answers' types and imports nothing; the frontend reaches it only through `ui/src/api-types.ts`, a type re-export, and its lint refuses any other import that leaves `ui/`. Cost: the root type check and the frontend's both read that file.
29. **Migration `0014_ui`:** the title, the stage's five columns and the retry code, and the two tables of sign-in. Every row stored before reads as no title, no stage and no code. The previous release refuses to start on the migrated database (`unknown_migration_applied`), as after every migration.
30. **Logs:** one `{ event: 'ui', files: <n> }` at start with the UI on; one `ui_signin` per way back, with `outcome` (`ok`, `denied`, `state`, `github`, `not_allowed`, `unverified`, `failed`) and `reason` (a short code or null); one `ui_failed` with the route's fixed name and the short code when an API handler throws. Never a login, a code, a state, a token, a cookie, a session id or the client secret. Cost: who signed in is read from `ui_sessions`, not the log.
31. **With the UI off, what changes:** the migration; the title written with the facts; the stage written by review jobs and cleared by claims; the withdrawal's retry code; `ResponseLike.end` taking a buffer and `writeHead` several values of one header; the root lint ignoring `ui/`. Nothing is answered, logged or posted that was not: `/`, `/ui/` and `/api/` answer 404 `not_found` as plain text, as today (Global Constraints list the pins).
32. **The run under Docker** (Task 12) stubs GitHub inside the closed network under its own names: a small server the run makes, answering as `github.com` and `api.github.com` with a certificate from a CA made for the run, which the app trusts through `NODE_EXTRA_CA_CERTS` (a Node runtime variable, no behaviour of the service); a browser (Playwright's image of the exact version the run's script uses, pulled before the network is closed) in the app's network namespace drives the built UI at `http://localhost:8080`, where a `Secure` cookie is kept. The stub's 404 on `/app/hook/deliveries` raises `redelivery_failed` once at start, as expected. Cost: what GitHub itself answers stays unverified (call 7).
33. **(ruled after the review) The progress bar departs from the mockup's samples** (60% at batch 2 of 3, 35% while judging threads, invented values): `preparing` 5, `reviewing` and `judging_threads` `10 + round(80 * (batch - 1) / batches)` (37% at batch 2 of 3), `publishing` 95, else 0. Cost: the bar moves only as batches end, in steps.

## For the owner

1. **Cannot be undone:** the previous release does not start on a database this release has migrated. The rest can: the UI is off unless the file names who may open it.
2. **Before a real sign-in can work,** on the GitHub App's settings page: set the **Callback URL** to `<ui.publicUrl>/api/auth/callback`; keep "Expire user authorization tokens" on; **generate a client secret** and put it in the variable `app.clientSecret` names (`APP_CLIENT_SECRET`); copy the **Client ID** into `app.clientId`; with `ui.team`, install the app on that organisation and accept Members read. Serve the service over HTTPS at `ui.publicUrl` (the session cookie is `Secure`); `http://localhost` works only on the same machine.
3. **To try it against GitHub,** the scratch app needs that callback (for example `http://localhost:8080/api/auth/callback`) and a client secret, and you at the browser to approve on GitHub's page. The default: not tried; the run under Docker uses a stub (call 32).
4. **Who sees what:** everyone the file lets in sees the titles, numbers and requesters of every repository the app is installed on (call 13).
5. **Rulings you may want to change** (each a small change): call 1 (the cut), call 14 (judging threads as told), call 19 (waiting counted as running), call 11 (a session ends when the way it was let in no longer holds), call 24 (the sign-out button), call 25 (the first page after sign-in), call 33 (the progress bar).
6. **Not settled, and yours to weigh:** a person is their login, so a login freed and registered again by someone else is let in under the name the file writes; the caps of call 12 and 17 are the only limit on requests, and anything more (per address, per minute) belongs to the proxy in front; members of the team's child teams may pass the team read (To verify, 3).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **The service:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`. No new library in the root `package.json`.
- **The frontend:** only the packages of Task 9, exact versions; relative imports end in `.ts` or `.tsx`; nothing under `ui/` is imported by `src/`; `ui/` imports from `src/` only `src/ui/api-types.ts`, as types, through `ui/src/api-types.ts`.
- **ASCII only** in `src`, `contract`, `test`, `examples`, `ui/src`, `ui/index.html`, `ui/public` and the config files of `ui/`. After each task, `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test examples` prints nothing; from Task 9 on, so does `LC_ALL=C grep -rn -P '[^\x00-\x7F]' ui/src ui/index.html ui/public ui/vite.config.ts ui/eslint.config.js ui/package.json ui/tsconfig.json` (the lock file is npm's and is not checked).
- **No test reaches the network, a real database or a model.** A database is `testDb()`. GitHub is a fetch stubbed by route or a literal fake that pushes `[name, ...args]`. A clock is passed in. Every wait has a bound. The frontend's tests stub the API object; `fetch` and the others are blocked by `ui/src/test/setup.ts`.
- **Secrets:** the client secret goes from `parseConfig` to `createGithubSignIn` (in `main.ts`) and to GitHub's token exchange only; no other part is given it (`AuthDeps.ui` holds the accounts, the team and the address only); the user's token lives inside one call of `signedIn`; a session id, a state and a verifier are stored only as their hashes. None of them, nor a code, is ever logged, stored in clear, answered, put in an error's text or a URL other than GitHub's own.
- **The UI off changes nothing but call 31's list.** The pins: Task 1 `the UI is off unless ui names accounts or a team, and a config that writes no ui gives the config it gave`; Task 4 `with no team named, the app lacks what it lacked`; Task 5 `with no UI route, /, /ui/ and /api/ are not found as before`; Task 3 `with stages off the engine is given no progress and no stage is written`; Task 8 `with the UI off, /, /ui/ and /api/me are not found as before, and nothing is read for them`.
- **Boundaries, by the lint as it is:** `src/ui/**` falls under the general block (no GitHub adapter, no Postgres client, no MCP); it imports `src/db`, `src/config`, `src/shell` and `src/forge/types.ts`. Only `src/forge/github/**` knows GitHub's shapes; `src/main.ts` wires the adapter. `src/engine/**` imports nothing new; the progress is a callback in its deps.
- **Migrations:** one file, `src/db/migrations/0014_ui.sql`, plain SQL in the schema `visto_ai`. Owner and repo lower-cased on every write and lookup; outside text through `storable()`; a time as an ISO string with `::timestamptz`. No statement of this plan run outside an API request names `visto_ai.pull_requests` but `savePullRequest`'s, and none names the word `gate` (the service's tests filter statements by those words).
- **No existing test is edited, but for these,** each named in its task with the exact change: `src/forge/github/events.test.ts`, the test `no word of the description is in the event` (Task 3); `src/shell/http.test.ts`, the interface `Written` (Task 5); `src/service.test.ts`, the `Options` type, `harness()` with its `lacks` fake, and what `harness()` returns (Task 8). `src/config/load.test.ts`'s `the example file has no service blocks as shipped, and loads with them switched on` and `the example with its extensions block switched on names the example module` uncomment the example's run of lines from `# app:` to the blank line after `alerts`: they pass unchanged (Task 12, rule 2). Every new field of an existing type is optional. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test` in `src`; Vitest in `ui`. `REF = acme/shop` number 7; `at(seconds)` from `2026-03-01T10:00:00.000Z`; logins `octo-lead` (named), `octo-dev` (a requester), `octo-guest` (not let in); the team `acme/reviewers`; installation `'99'`; `ui.publicUrl` `https://visto.example.test`; client id `Iv1.0123456789abcdef`; client secret `client-secret-for-tests-only` in `APP_CLIENT_SECRET`; codes `code-1`; hosts under `example.test`. Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A way back that was not this browser's, or not now:** a state reused, a state from another browser, a cookie missing, a verifier that does not match, an expired state, `error=access_denied`. Task 6 `a state is taken once: the same way back again is refused as state` and `a way back whose state or verifier differs from its cookie, has none, or has expired is refused as state, makes no session and clears the cookie`.
2. **Someone who should not get in:** a bot, a login not named, a member who is not active, a team that cannot be read, a login removed from the file while a team is still named, a team changed. Task 6 `GitHub's refusal, an account not named, a bot, and a team that cannot be read are refused each with its own code`, `an active member of the team is let in through the organisation's installation; a member who is not active is not`, `a session is read by its cookie, and stops being one when it expires or is signed out` and `a session stops being one when the way it was let in no longer holds, with accounts and a team both named`.
3. **A secret in the wrong place:** the client secret, the token, the code, the state, the verifier, the session id in a log line, an answer, an error or a row. Task 4 `an answer of the wrong shape, a status that is not 200 and a network failure each reject with a short code holding neither the secret nor the token`; Task 6 `no log line or answer holds the code, the state, the verifier, the session id or the client secret, and no row holds any of them in clear`; Task 7 `an answer holds no field the screens do not show`.
4. **A path that tries to leave the folder, a missing asset, another method, the UI off.** Task 5 `a path that is no file is answered with index.html, and a missing asset is not found` and `with no UI route, /, /ui/ and /api/ are not found as before`; Task 8 `with the UI off, /, /ui/ and /api/me are not found as before, and nothing is read for them`.
5. **Requests nobody signed in for, many at once:** a flood of starts, of ways back, of reads without a cookie. Task 5 `the files, the sign-in routes and the rest of the API have places of their own, and one body limit`; Task 6 `while 1,000 states are live a start answers busy and stores nothing, and expired rows are deleted at most once a minute`.
6. **A stage that lies:** left by a crash, a running row nobody holds, a write that fails, a progress that throws, a pending row's leftovers, a push's job put back. Task 2 `a claim clears the stage a start before left`; Task 3 `a stage that cannot be written changes nothing and is not logged` and `a progress that throws changes nothing, and a review with no batch tells none`; Task 7 `a running job this service does not hold reads as stopped, and a pending one's old stage is not read`.
7. **Titles out of order:** an event with none, an older event, an edit. Task 2 `the title is stored with the facts, kept when an event carries none, and replaced only by a newer event's`; Task 3 `a pull request event stores its title, an older event leaves it, and an edit replaces it`.
8. **Search and parameters a person types:** `%`, `_` and `\` in `q`, a malformed `repo`, a `before` that is not a number, a parameter written empty. Task 7 `the search takes percent, underscore and backslash as themselves, an empty parameter is absent, and a malformed one is bad_request`.
9. **The content security policy refused in the built page:** an inline script, an inline style, a data URI. Task 9 step 5 and Task 12's browser run.

---

### Task 1: Who may open the UI, and what sign-in needs, in the configuration

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`
- Test: `src/config/load.test.ts` (new tests only)

**Interfaces:**

```ts
// src/config/load.ts
export interface UiConfig {
  accounts: string[];   // as written
  team: string | null;  // "org/team-slug"; null when not written
  publicUrl: string;    // the origin, with no trailing slash: new URL(written).origin
  clientId: string;     // app.clientId as written
  clientSecret: string; // the value of the variable app.clientSecret names; never logged, stored or posted
}
// DeploymentConfig gains:  ui?: UiConfig;   present only when ui names an account or a team
```

**Rules (3.2, 4.1; calls 9, 11):**

1. **Schema.** `app` gains `clientId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, { message: 'must be 1 to 100 letters, digits, dots, hyphens or underscores' }).optional()` and `clientSecret: secretRef.optional()`. A top-level `ui: z.object({ accounts, team, publicUrl }).strict().optional()` with `accounts: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/, { message: 'must be a GitHub login' })).max(100).default([])`, `team: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, { message: 'must be <org>/<team-slug>' }).optional()`, `publicUrl: z.string().refine(isPublicUrl, { message: 'must be an https URL with no path, query or user, or http://localhost or http://127.0.0.1' }).optional()`.
2. `isPublicUrl(value)`: printable ASCII with no space, `URL.canParse`, no username, password, search or hash, `pathname === '/'`; protocol `https:`, or `http:` with hostname `localhost` or `127.0.0.1`.
3. **On.** The UI is on when `raw.ui` names at least one account or writes `team`. Then each of these that is missing is an issue, in this order, gathered with the gate's and the audit key's issues into one `ConfigError`: `ui.publicUrl: must be written when ui names accounts or a team`, `app.clientId: must be written when ui names accounts or a team`, `app.clientSecret: must be written when ui names accounts or a team`. Dry run changes nothing. No issue quotes a value.
4. **The secret.** Inside the `raw.app !== undefined` block, a written `clientSecret` is resolved after the webhook secret: unset or empty is `app.clientSecret: environment variable <NAME> is not set`. `app` keeps exactly `{ id, privateKey, webhookSecret }`.
5. **Loaded.** With the UI on, `ui: { accounts, team: team ?? null, publicUrl: new URL(publicUrl).origin, clientId, clientSecret }`; otherwise no key `ui`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('the UI is off unless ui names accounts or a team, and a config that writes no ui gives the config it gave', () => {
  /* minimal, SERVICE_YAML and parseConfig(example(), exampleEnv): 'ui' in c is false, and app deepEquals the three keys as before;
     SERVICE_YAML + 'ui: { accounts: [] }\n' and + 'ui: { publicUrl: https://visto.example.test }\n': 'ui' in c is false, no issue */
});
test('ui with accounts or a team is read with the client id, the client secret from its variable and the public address as an origin', () => {
  /* SERVICE_YAML with app.clientId Iv1.0123456789abcdef, app.clientSecret { env: APP_CLIENT_SECRET },
     ui { accounts: [octo-lead], publicUrl: 'https://visto.example.test/' }: c.ui deepEquals { accounts: ['octo-lead'], team: null,
     publicUrl: 'https://visto.example.test', clientId: 'Iv1.0123456789abcdef', clientSecret: 'client-secret-for-tests-only' }; c.app has 3 keys;
     ui { team: acme/reviewers, publicUrl: http://localhost:8080 }: team 'acme/reviewers', accounts [], publicUrl 'http://localhost:8080' */
});
test('ui that names who may open it but lacks the address, the client id or the client secret is refused with each issue, in dry run too, and quotes no value', () => {
  /* ui { accounts: [octo-lead] } with none of the three: exactly the three issues of rule 3, in order; with dryRun false the same;
     with only publicUrl missing: exactly that one; the message holds neither 'octo-lead' nor 'client-secret-for-tests-only' */
});
test('a public address with a path, a query, a user, or plain http to another host is refused by name', () => {
  /* https://visto.example.test/ui, https://visto.example.test/?a=1, https://u:p@visto.example.test, http://visto.example.test, ftp://x.test:
     each issue starts with 'ui.publicUrl:' and holds none of the address */
});
test('an account that is not a login, and a team that is not org/slug, are refused by name', () => {
  /* accounts [octo_lead], [''], 101 logins; team acme, acme/re viewers: each issue starts with 'ui.accounts' or 'ui.team' */
});
test('a client secret written is resolved whatever ui says, and refused when its variable is not set', () => {
  /* SERVICE_YAML with app.clientSecret and no ui, APP_CLIENT_SECRET unset: exactly 'app.clientSecret: environment variable APP_CLIENT_SECRET is not set';
     set: parses, 'ui' in c false */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/config/load.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: who may open the UI, and the app's client id and secret, in the configuration`.

---

### Task 2: The store: the title, the stage, the retry code, sessions and states

**Files:**
- Create: `src/db/migrations/0014_ui.sql`, `src/db/ui-sessions.ts`, `src/db/ui-sessions.test.ts`
- Modify: `src/db/jobs.ts` (`ReviewStage`, `markStage`, `claimJob`, `requeueJob`), `src/db/pull-requests.ts` (`savePullRequest`), `src/forge/types.ts` (`PullRequestFacts.title`), `src/approval/withdraw.ts` (the put-back's code)
- Test: `src/db/migrate.test.ts`, `src/db/jobs.test.ts`, `src/db/pull-requests.test.ts`, `src/approval/withdraw.test.ts` (new tests only)

**Interfaces:**

```ts
// src/forge/types.ts, PullRequestFacts gains:
  title?: string;   // the title the event carries; absent: it carries none, and what is stored stays
// src/db/jobs.ts
export type ReviewStage =
  | { stage: 'preparing' } | { stage: 'publishing' }
  | { stage: 'reviewing'; batch: number; batches: number }
  | { stage: 'judging_threads'; batch: number; batches: number; threadsDue: number };
/** Writes a running job's stage and when it was reached; false when the job is not running. */
export async function markStage(db: Db, id: number, stage: ReviewStage, at: string): Promise<boolean>;
export async function requeueJob(db: Db, id: number, runAt: string, now: string, giveBackStart: boolean, code?: string): Promise<'requeued' | 'superseded'>;
// src/db/ui-sessions.ts
/** `via`: 'account', or the team's "org/slug" as the file wrote it (call 11). */
export async function createSession(db: Db, s: { idHash: string; login: string; via: string; at: string; expiresAt: string }): Promise<void>;
/** The session's login and way in while it has not expired; its last use is written when the stored last use is 60 seconds old or more. */
export async function readSession(db: Db, idHash: string, now: string): Promise<{ login: string; via: string } | null>;
export async function deleteSession(db: Db, idHash: string): Promise<boolean>;
export async function saveState(db: Db, s: { stateHash: string; verifierHash: string; expiresAt: string }): Promise<void>;
/** Deletes the state; its verifier's hash when it was there and had not expired, else null. */
export async function takeState(db: Db, stateHash: string, now: string): Promise<{ verifierHash: string } | null>;
/** How many states have not expired at `now`. */
export async function liveStates(db: Db, now: string): Promise<number>;
/** Deletes the sessions and states expired at `now`; how many. */
export async function deleteExpired(db: Db, now: string): Promise<number>;
```

**Rules (3.2, 3.3; calls 12, 14, 15, 16, 29):**

1. **The migration**, exactly:

```sql
alter table visto_ai.pull_requests add column title text;
alter table visto_ai.jobs add column stage text;
alter table visto_ai.jobs add column stage_at timestamptz;
alter table visto_ai.jobs add column batch integer;
alter table visto_ai.jobs add column batches integer;
alter table visto_ai.jobs add column threads_due integer;
alter table visto_ai.jobs add column retry_code text;
create table visto_ai.ui_sessions (
  id_hash text primary key,
  login text not null,
  via text not null,
  created_at timestamptz not null,
  last_used_at timestamptz not null,
  expires_at timestamptz not null
);
create table visto_ai.ui_states (
  state_hash text primary key,
  verifier_hash text not null,
  expires_at timestamptz not null
);
create index ui_states_expires on visto_ai.ui_states (expires_at);
```

2. **`markStage`**, with `$4` to `$6` null where the stage has no such field:

```sql
update visto_ai.jobs set stage = $2, stage_at = $3::timestamptz, batch = $4, batches = $5, threads_due = $6
where id = $1 and status = 'running'
returning id
```

3. **`claimJob`**'s statement becomes (the rest of the function unchanged):

```sql
update visto_ai.jobs set status = 'running', starts = starts + 1, started_at = $2::timestamptz,
       stage = null, stage_at = null, batch = null, batches = null, threads_due = null
where id = $1 and status = 'pending' and run_at <= $2::timestamptz
returning <COLUMNS>
```

4. **`requeueJob`**'s first statement (`putBack`) becomes, with `$4` `storableOrNull(code ?? null)` (its other statements unchanged):

```sql
update visto_ai.jobs j set status = 'pending', run_at = $2::timestamptz, starts = starts - $3, retry_code = $4
where j.id = $1 and j.status = 'running'
  and not exists (select 1 from visto_ai.jobs p where p.status = 'pending' and p.kind = j.kind
                  and p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number)
returning id
```

   **`runWithdrawJob`** passes `end.code` as the code where it puts a job back (`withdraw.ts`, the `else` branch after `job.starts >= MAX_STARTS`); no other caller passes one.
5. **`savePullRequest`** becomes, with `$19` `storableOrNull(facts.title ?? null)`; `getPullRequest` is unchanged:

```sql
insert into visto_ai.pull_requests
  (service, owner, repo, number, author, author_is_bot, base_branch, head_branch, head_sha,
   draft, state, merged_at, closed_at, merge_commit, installation, updated_at, reverts, title)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14, $15, $16::timestamptz, $17::integer, $19)
on conflict (service, owner, repo, number) do update set
  author = excluded.author, author_is_bot = excluded.author_is_bot,
  base_branch = excluded.base_branch, head_branch = excluded.head_branch, head_sha = excluded.head_sha,
  draft = excluded.draft, state = excluded.state,
  merged_at = excluded.merged_at, closed_at = excluded.closed_at, merge_commit = excluded.merge_commit,
  installation = coalesce(excluded.installation, visto_ai.pull_requests.installation),
  updated_at = excluded.updated_at,
  reverts = case when $18::boolean then visto_ai.pull_requests.reverts else excluded.reverts end,
  title = coalesce(excluded.title, visto_ai.pull_requests.title)
where visto_ai.pull_requests.updated_at <= excluded.updated_at
returning number
```
6. **The statements of `ui-sessions.ts`:**

```sql
-- createSession
insert into visto_ai.ui_sessions (id_hash, login, via, created_at, last_used_at, expires_at)
values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz);
-- readSession: the read, then the write only when now minus the stored last_used_at is 60 seconds or more
select login, via, last_used_at from visto_ai.ui_sessions where id_hash = $1 and expires_at > $2::timestamptz;
update visto_ai.ui_sessions set last_used_at = $2::timestamptz where id_hash = $1;
-- deleteSession
delete from visto_ai.ui_sessions where id_hash = $1 returning id_hash;
-- saveState
insert into visto_ai.ui_states (state_hash, verifier_hash, expires_at) values ($1, $2, $3::timestamptz);
-- takeState: the verifier's hash when a row came back with expires_at after $2
delete from visto_ai.ui_states where state_hash = $1 returning verifier_hash, expires_at;
-- liveStates
select count(*)::int as n from visto_ai.ui_states where expires_at > $1::timestamptz;
-- deleteExpired: the two counts added
delete from visto_ai.ui_sessions where expires_at <= $1::timestamptz returning id_hash;
delete from visto_ai.ui_states where expires_at <= $1::timestamptz returning state_hash;
```

The login and `via` go through `storable()`.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/db/migrate.test.ts
test('0014_ui adds the title, the stage, the retry code and the two tables of sign-in, and every row stored before reads as none', async () => {
  /* migrations below 0014 applied, a pull request and a job inserted, then all applied: '0014_ui' follows '0013_approval';
     title, stage, stage_at, batch, batches, threads_due, retry_code null; ui_sessions (with via) and ui_states (with verifier_hash) exist and are empty */
});
// src/db/jobs.test.ts
test("a running job's stage is written with its time, and a job that is not running takes none", async () => {
  /* claimed: markStage reviewing 2 of 3 at at(5) true, the row reads 'reviewing', at(5), 2, 3, null; judging_threads 1 of 2 with 3 due: 1, 2, 3;
     preparing: batch, batches and threads_due null; a pending job and a finished one: false and unchanged */
});
test('a claim clears the stage a start before left', async () => {
  /* claimed, markStage publishing, requeueJob, claimed again: stage, stage_at, batch, batches, threads_due all null */
});
test('a job put back keeps the code it is given, and one put back without a code has none', async () => {
  /* requeueJob(..., 'github_403'): retry_code 'github_403'; claimed, requeueJob with no code: null */
});
// src/db/pull-requests.test.ts
test('the title is stored with the facts, kept when an event carries none, and replaced only by a newer event\'s', async () => {
  /* save with title 'Round prices before tax' at at(0): stored; save with no title at at(10): kept; save 'Round prices' at at(5): kept;
     save 'Round all prices' at at(20): replaced; getPullRequest's answer has no key 'title' */
});
// src/db/ui-sessions.test.ts
test('a session is read with its way in while it has not expired, and its use is written when the stored one is 60 seconds old or more', async () => {
  /* created at at(0) via 'account', expiring at(43200): read at at(30) gives { login: 'octo-lead', via: 'account' }, last_used_at at(0);
     at at(59): at(0); at at(60): at(60); at at(119): at(60); a session via 'acme/reviewers' reads that via */
});
test('a deleted or expired session is not read', async () => { /* read at at(43200): null; deleted: deleteSession true, then false, read null */ });
test('a state is taken once with its verifier hash, and an expired one is taken but answers null', async () => {
  /* saved { 'h-s', 'h-v', at(600) }: taken at at(10) { verifierHash: 'h-v' }, again null; another until at(600) taken at at(600): null, and gone */
});
test('live states are counted, and expired sessions and states are deleted while the rest stays', async () => {
  /* three states, one expired at at(10): liveStates at at(10) 2; two sessions expired, two not: deleteExpired 3; both live sessions read; liveStates 2 */
});
// src/approval/withdraw.test.ts
test("a withdrawal put back after a failed try keeps that try's code on its row", async () => {
  /* the harness of 'a dismissal that fails is tried again after 10 and 60 seconds, ...', after the first start: retry_code 'github_403' (the fake's code) */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/migrate.test.ts src/db/jobs.test.ts src/db/pull-requests.test.ts src/db/ui-sessions.test.ts src/approval/withdraw.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the store of the UI: titles, the stage of a running job, a withdrawal's retry code, sessions and states`.

---

### Task 3: Titles from each delivery, and the stage of a running review

**Files:**
- Modify: `src/forge/github/events.ts` (`factsOf`), `src/engine/types.ts` (`ReviewProgress`, `ReviewDeps.progress`), `src/engine/review.ts`, `src/shell/review-job.ts` (`ReviewJobDeps.stages`)
- Test: `src/forge/github/events.test.ts` (one change, new tests), `src/shell/receive.test.ts`, `src/engine/review.test.ts`, `src/shell/review-job.test.ts` (new tests only)

**Interfaces:**

```ts
// src/engine/types.ts
/** How far a review's model calls have got. */
export interface ReviewProgress {
  batches: number;    // the batches the review sends
  ended: number;      // the batches that have ended, answered or given up
  threadsDue: number; // threads owed a verdict in the batches that have not ended
}
// ReviewDeps gains:
  progress?: (progress: ReviewProgress) => void;   // told before the first batch is sent and as each batch ends; absent: nobody is told
// src/shell/review-job.ts, ReviewJobDeps gains:
  /** Whether the job writes its stage on its row; absent: none is written and the engine is given no progress. */
  stages?: boolean;
```

**Rules (3.3 items 1 and 2; calls 14, 15):**

1. **The title.** `factsOf` adds `title: pr.title` when `pr.title` is a string (an empty one included), and no key otherwise.
2. **The engine.** In `reviewOnce`, once `packed.batches` is final and is not empty, `dueIn[i]` is the count of threads with `due: true` on the files of batch `i`; the engine tells `{ batches, ended: 0, threadsDue: sum }` before `inPool`, and after each batch's `runBatch` settles (in a `finally` around it) `{ batches, ended: <ended so far>, threadsDue: <the sum over batches not ended> }`. Each call is inside `try/catch`: a progress that throws changes nothing. Nothing is told when no batch is sent, nor on any path that returns before `inPool`.
3. **The job, with `stages` true only.** `stage(s)` calls `markStage(db, job.id, s, <the clock now>)` and swallows a rejection, logging nothing. The job writes `{ stage: 'preparing' }` first, before step 1. The engine is given `{ ...engine, progress }` in both calls of `deps.review` (dry run and not); `progress` checks that `batches`, `ended` and `threadsDue` are whole numbers at or above 0 (else ignores the call), maps to `{ stage: 'judging_threads', batch, batches, threadsDue }` when `threadsDue > 0`, else `{ stage: 'reviewing', batch, batches }`, with `batch = Math.min(ended + 1, batches)`, and chains the write after the previous one; the job awaits the chain right after `deps.review` settles, before rendering. Just before `approvalContext()` in the branch where `timed` is true, the job writes `{ stage: 'publishing' }`. Nothing else in the job changes.
4. **The service** sets `stages: true` in `reviewDeps` (Task 8 wires it; this task adds the field and its use).

- [ ] **Step 1: Write the failing tests and the one change.**

`src/forge/github/events.test.ts`, test `no word of the description is in the event`: the line `assert.equal(text.includes('Double'), false);` becomes `assert.equal(factsIn(event).title, 'Revert "Double the totals"');`.

```ts
// src/forge/github/events.test.ts
test('the title of the pull request is carried as written, and absent when the payload has none', () => {
  /* pr({ title: 'Round prices before tax' }): facts.title is that; pr({ title: '' }): ''; pr({}): 'title' in facts false; pr({ title: 7 }): false */
});
// src/shell/receive.test.ts
test('a pull request event stores its title, an older event leaves it, and an edit replaces it', async () => {
  /* opened with title 'Round prices' updated_at T: stored; an older event 'Old' (earlier updated_at): kept; edited 'Round all prices' later: replaced */
});
// src/engine/review.test.ts
test('the progress is told before the first batch and as each batch ends, with the due threads of the batches not ended', async () => {
  /* two batches (as the batch tests of this file pack them), the first file holding one due earlier thread:
     told [{ batches: 2, ended: 0, threadsDue: 1 }, { 2, 1, 0 or 1 by which ends first }, { 2, 2, 0 }]: three calls, ended 0, 1, 2, threadsDue never below 0 */
});
test('a progress that throws changes nothing, and a review with no batch tells none', async () => {
  /* progress throwing: the result deepEquals the one with no progress; a pull request whose files need no model call: no call */
});
// src/shell/review-job.test.ts
test('with stages on, the job writes preparing, each stage the engine tells, then publishing, in that order', async () => {
  /* not dry run, stages true, the review stub calls engine.progress({2,0,1}) then ({2,1,0}) then ({2,2,0}): the params of the statements
     holding 'set stage = $2' in order: preparing; judging_threads 1 of 2, 1 due; reviewing 2 of 2; reviewing 2 of 2; publishing */
});
test('in dry run the job writes no publishing stage', async () => { /* dry run, stages true: preparing then the engine's, no publishing */ });
test('a stage that cannot be written changes nothing and is not logged', async () => {
  /* every 'set stage = $2' rejects: the review line, the drafts and the run deepEqual those of the same job with stages off (job, number, duration_ms set to 0) */
});
test('with stages off the engine is given no progress and no stage is written', async () => {
  /* the harness as it is: 'progress' in h.engines[0] false; no statement holds 'set stage' */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/forge/github/events.test.ts src/shell/receive.test.ts src/engine/review.test.ts src/shell/review-job.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: pull request titles from each delivery, and the stage of a running review on its job`.

---

### Task 4: Sign-in at the git boundary

**Files:**
- Create: `src/forge/github/sign-in.ts`, `src/forge/github/sign-in.test.ts`
- Modify: `src/forge/types.ts` (`SignedIn`, `ForgeSignIn`, `FeatureOff['feature']`, `AppIdentity.lacks`), `src/forge/github/app-info.ts` (`missingFor`, `lacks`)
- Test: `src/forge/github/app-info.test.ts` (new tests only)

**Interfaces:**

```ts
// src/forge/types.ts
export interface SignedIn { login: string; isBot: boolean }
export interface ForgeSignIn {
  /** The page where a person approves the sign-in; `challenge` is the base64url SHA-256 of the PKCE verifier. */
  authorizeUrl(state: string, challenge: string, redirectUri: string): string;
  /** The account that approved: the code is exchanged once, with the verifier, for a user token, which reads the account once and is dropped. Rejects with a short code. */
  signedIn(code: string, verifier: string, redirectUri: string): Promise<SignedIn>;
  /** The app's installation on an organisation, read with the app's own token; null when it is not installed there. Rejects with a short code. */
  orgInstallation(org: string): Promise<string | null>;
}
// FeatureOff['feature'] gains 'ui'; AppIdentity.lacks(dryRun, gate?, approval?, uiTeam?: boolean)
// src/forge/github/sign-in.ts
export function createGithubSignIn(opts: { clientId: string; clientSecret: string; auth: AppAuth; fetch: typeof fetch; webBase?: string; apiBase?: string }): ForgeSignIn;
// src/forge/github/app-info.ts
export function missingFor(info: AppInfo, dryRun: boolean, gate?: GateNeeds, approval?: boolean, uiTeam?: boolean): FeatureOff[];
```

**Rules (3.2; calls 10, 11, 27):**

1. `webBase` defaults to `https://github.com`, `apiBase` to `https://api.github.com`, trailing slashes cut.
2. **`authorizeUrl`** is `${webBase}/login/oauth/authorize?` and a `URLSearchParams` of `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `allow_signup=false`, in that order.
3. **`signedIn`.** A code that does not match `^[A-Za-z0-9_-]{1,100}$` rejects `oauth_bad_code`, and a verifier that does not match `^[A-Za-z0-9_-]{43,128}$` rejects `oauth_bad_verifier`, each with no call. Then one `POST ${webBase}/login/oauth/access_token`, `redirect: 'manual'`, headers `Accept: application/json`, `Content-Type: application/x-www-form-urlencoded`, `User-Agent: visto-ai`, body the text of a `URLSearchParams` of `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier`, in that order (form parameters, as GitHub's documentation shows): a throw is `github_network`; a status other than 200 is `github_<status>`; a body that is not a JSON object is `github_bad_response`; a string `error` is `oauth_refused`; else a non-empty string `access_token` is needed (`github_bad_response`). Then one `GET ${apiBase}/user` with `Authorization: Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: visto-ai`, `Accept: application/vnd.github+json`: a throw is `github_network`, not ok is `github_<status>`, and the body needs `login` matching `^[A-Za-z0-9-]{1,39}$` and a string `type`, else `github_bad_response`. The answer is `{ login, isBot: type !== 'User' }`. Neither call is retried.
4. **`orgInstallation`.** An org that does not match `^[A-Za-z0-9-]{1,39}$` rejects `github_bad_path`. One `GET ${apiBase}/orgs/<org>/installation` with `Authorization: Bearer ${auth.appToken()}` and the other three headers: 404 is null; a throw is `github_network`; not ok is `github_<status>`; a positive whole `id` is answered as text, else `github_bad_response`.
5. No error's message holds anything but its short code.
6. **`missingFor`** adds `need('ui', 'members', 'read')` when `uiTeam === true`, in dry run too; `lacks` passes `uiTeam` through.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/forge/github/sign-in.test.ts
test('the authorize address names the client, the way back, the state and the challenge, and lets nobody sign up', () => {
  /* authorizeUrl('s-1', 'c-1', 'https://visto.example.test/api/auth/callback') is exactly
     'https://github.com/login/oauth/authorize?client_id=Iv1.0123456789abcdef&redirect_uri=https%3A%2F%2Fvisto.example.test%2Fapi%2Fauth%2Fcallback&state=s-1&code_challenge=c-1&code_challenge_method=S256&allow_signup=false' */
});
test('a code is exchanged once, with its verifier in form parameters, for a token that reads the account, and the token is not kept', async () => {
  /* verifier 'v'.repeat(43): the calls: POST https://github.com/login/oauth/access_token, content-type application/x-www-form-urlencoded, body exactly
     'client_id=Iv1.0123456789abcdef&client_secret=client-secret-for-tests-only&code=code-1&redirect_uri=https%3A%2F%2Fvisto.example.test%2Fapi%2Fauth%2Fcallback&code_verifier=vvv...',
     then GET https://api.github.com/user with 'Bearer t-1'; answer { login: 'octo-lead', isBot: false }; JSON.stringify of the answer holds neither 't-1' nor the secret */
});
test("GitHub's refusal of a code is oauth_refused, and no account is read", async () => { /* { error: 'bad_verification_code' }: oauth_refused; one call */ });
test('an answer of the wrong shape, a status that is not 200 and a network failure each reject with a short code holding neither the secret nor the token', async () => {
  /* exchange 401: github_401; exchange not JSON: github_bad_response; no access_token: github_bad_response; fetch throws: github_network;
     /user 401: github_401; /user login 'octo lead': github_bad_response; code 'a b': oauth_bad_code with no call; verifier of 42 characters: oauth_bad_verifier with no call;
     no message holds the secret or 't-1' */
});
test('an account that is not a person is a bot', async () => { /* type 'Bot': isBot true; 'Organization': true */ });
test("the installation of an organisation is read with the app's token, and 404 is none", async () => {
  /* GET https://api.github.com/orgs/acme/installation with 'Bearer <appToken>': { id: 99 } gives '99'; 404 null; 500 github_500; org 'a/b': github_bad_path */
});
// src/forge/github/app-info.test.ts
test("with the UI's team named, the app lacks members read when it has not got it, in dry run too", () => {
  /* permissions without members: missingFor(info, true, undefined, false, true) holds { feature: 'ui', missing: 'members:read' }; with members read: none */
});
test('with no team named, the app lacks what it lacked', () => { /* missingFor with uiTeam absent and false deepEquals the call without it */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/forge/github/sign-in.test.ts src/forge/github/app-info.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: sign-in through the GitHub App at the git boundary, and members read for the UI's team`.

---

### Task 5: The UI's route group, the built files and the headers

**Files:**
- Create: `src/ui/headers.ts`, `src/ui/files.ts`, `src/ui/files.test.ts`
- Modify: `src/shell/http.ts`
- Test: `src/shell/http.test.ts` (one change, new tests), `test/boundaries.test.ts` (new test only)

**Interfaces:**

```ts
// src/shell/http.ts
export const UI_BODY_BYTES = 64 * 1024;
export const UI_FILES_IN_FLIGHT = 16;    // '/', '/ui', '/ui/...'
export const UI_SIGNIN_IN_FLIGHT = 2;    // '/api/auth/start', '/api/auth/callback'
export const UI_API_IN_FLIGHT = 4;       // every other '/api' path
export interface UiRequest { method: string; path: string; query: string; headers: Record<string, string | undefined>; body: Buffer }
export interface UiAnswer { status: number; headers: Record<string, string | string[]>; body: string | Buffer }   // a list: one header line for each value (set-cookie)
export type UiRoute = (request: UiRequest) => Promise<UiAnswer>;
// createListener's routes gain  ui?: UiRoute;   its limits gain  maxUiBodyBytes?, maxUiFilesInFlight?, maxUiSignInInFlight?, maxUiApiInFlight?: number
// ResponseLike becomes  writeHead(status: number, headers: Record<string, string | string[]>): unknown;  end(body: string | Buffer): unknown;
// src/ui/headers.ts
export const CSP: string;                                     // call 17, exactly
export const SECURITY_HEADERS: Readonly<Record<string, string>>; // the CSP and the three others of call 17
export function plain(status: number, body: string): UiAnswer;  // text/plain; charset=utf-8, no-store, the security headers
export function json(status: number, value: unknown, extra?: Record<string, string | string[]>): UiAnswer;  // application/json; charset=utf-8, no-store
export function redirect(location: string, extra?: Record<string, string | string[]>): UiAnswer;            // 302, location, no-store, empty body
// src/ui/files.ts
export interface UiFile { body: Buffer; type: string }
export type UiFiles = ReadonlyMap<string, UiFile>;   // by the path it is served at: '/ui/' + its path in the folder, with forward slashes
export function loadUiFiles(dir: string): UiFiles;   // empty when the folder is not there
export function fileAnswer(files: UiFiles, method: string, path: string): UiAnswer;
```

**Rules (3.1, 3.2; calls 17, 31):**

1. **The listener.** With `routes.ui` given, after the extension prefix, `/webhooks/github` and `/healthz`, a path (the URL before `?`) that is `/`, `/ui`, starts with `/ui/`, is `/api` or starts with `/api/` goes to the UI route, with `query` the text after the first `?`. Its places are its own and counted in three parts (call 17): `/`, `/ui` and `/ui/...` against `UI_FILES_IN_FLIGHT`, exactly `/api/auth/start` and `/api/auth/callback` against `UI_SIGNIN_IN_FLIGHT`, every other path of the group against `UI_API_IN_FLIGHT`; a request beyond its part's places gets 503 `busy`, plain, as today, and takes none of another part's. Its body is read as an extension's with its own cap (413 `payload_too_large` and `connection: close`), a stream that fails writes nothing, the headers are first values under lower-case names, defined as the extension's are. The answer is written with exactly the route's headers (a list given to `writeHead` as it is, so Node writes one line for each value) and body; a route that rejects gives 500 `internal_error` with the plain headers of today. With no `ui` route every path is answered as today.
2. **`loadUiFiles`** reads the folder recursively with `readdirSync(dir, { recursive: true, withFileTypes: true })`, files only, each read whole; the type is by extension: `.html` `text/html; charset=utf-8`, `.js` `text/javascript; charset=utf-8`, `.css` `text/css; charset=utf-8`, `.svg` `image/svg+xml`, `.woff2` `font/woff2`, `.woff` `font/woff`, `.json` `application/json`, `.png` `image/png`, `.ico` `image/x-icon`, `.txt` `text/plain; charset=utf-8`, else `application/octet-stream`. A folder that is not there (or not a folder) gives an empty map.
3. **`fileAnswer`.** A method other than `GET`: 405 plain `method_not_allowed` with `allow: GET`. `/ui`: redirect `/ui/`. `/ui/` reads as `/ui/index.html`. A key in the map: 200 with its type, `cache-control: public, max-age=31536000, immutable` under `/ui/assets/`, `no-store` otherwise. Not a key: under `/ui/assets/` 404 plain `not_found`; else `index.html`, 200, `no-store`; with no `index.html`, 404 plain `not_found`. The path is never decoded and never joined to a folder.
4. Every answer of `headers.ts` and `files.ts` carries `SECURITY_HEADERS`.

- [ ] **Step 1: Write the failing tests and the one change.**

`src/shell/http.test.ts`, the interface `Written`: `headers: Record<string, string>` becomes `headers: Record<string, string | string[]>`, and `body: string` becomes `body: string | Buffer`; the `let headers` of `response()` takes the same type.

```ts
// src/ui/files.test.ts
test('the built files are loaded by the path they are served at, and a folder that is not there gives none', () => {
  /* a temp folder with index.html, assets/index-a1.js, assets/fonts/x.woff2, favicon.svg: keys '/ui/index.html', '/ui/assets/index-a1.js',
     '/ui/assets/fonts/x.woff2', '/ui/favicon.svg' with their types; a missing folder: size 0 */
});
test('a hashed asset is served with its type and cached for a year; index.html is never stored', () => {
  /* /ui/assets/index-a1.js: 200, text/javascript; charset=utf-8, public, max-age=31536000, immutable, its bytes; /ui/: index.html, no-store; /ui/favicon.svg: no-store */
});
test('a path that is no file is answered with index.html, and a missing asset is not found', () => {
  /* /ui/activity, /ui/reviews/9001, /ui/%2e%2e/package.json, /ui/../src/main.ts: index.html; /ui/assets/nope.js: 404 not_found; no index.html in the map: 404 */
});
test('/ui is sent to /ui/, and a method other than GET is refused', () => { /* /ui: 302 location /ui/; POST /ui/: 405, allow GET */ });
test('every answer carries the content security policy and the three other headers, exactly', () => {
  /* each answer above: content-security-policy is exactly CSP (the text of call 17), x-content-type-options nosniff, referrer-policy same-origin, x-frame-options DENY */
});
// src/shell/http.test.ts
test('with a UI route, its paths reach it with their method, path, query, headers and body, and the others do not', async () => {
  /* /, /ui, /ui/x, /api, /api/me?x=1: the route sees { method, path, query: 'x=1', headers lower-cased first values, body }; its headers written as given;
     /webhooks/github and /healthz keep theirs; /extensions/<name> keeps a module's; /other: 404 not_found plain */
});
test('the files, the sign-in routes and the rest of the API have places of their own, and one body limit', async () => {
  /* UI_BODY_BYTES 65536, UI_FILES_IN_FLIGHT 16, UI_SIGNIN_IN_FLIGHT 2, UI_API_IN_FLIGHT 4; with the route held: a third /api/auth/start or /api/auth/callback
     at once gets 503 busy while /api/me, /ui/ and a webhook are still served; a fifth /api/me at once gets 503 busy while /api/auth/start and /ui/ are served;
     a seventeenth /ui/x at once gets 503 busy while /api/me is served; each place is given back when its route settles;
     a body over maxUiBodyBytes: 413 with connection close; a route that rejects: 500 internal_error plain */
});
test('an answer with several values of one header is written with each', async () => {
  /* the route answers { 'set-cookie': ['a=1', 'b=2'] }: writeHead is given the list as it is */
});
test('with no UI route, /, /ui/ and /api/ are not found as before', async () => { /* each: 404, not_found, the plain headers of today */ });
// test/boundaries.test.ts
test("the UI's server part may not import the GitHub adapter or a Postgres client", async () => {
  /* src/ui/x.ts importing '../forge/github/sign-in.ts', 'pg': no-restricted-imports; importing '../forge/types.ts': none */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/files.test.ts src/shell/http.test.ts test/boundaries.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a route group for the UI, the built files served with their cache and security headers`.

---

### Task 6: Sign-in, sessions and access

**Files:**
- Create: `src/ui/auth.ts`, `src/ui/auth.test.ts`

**Interfaces:**

```ts
// src/ui/auth.ts
export const SESSION_COOKIE = '__Host-visto_session';
export const STATE_COOKIE = '__Host-visto_oauth';
export const CSRF_HEADER = 'x-visto-csrf';
export const SESSION_MS = 12 * 3_600_000;
export const STATE_MS = 10 * 60_000;
export const SWEEP_MS = 60_000;      // expired rows are deleted at most once in this time
export const MAX_LIVE_STATES = 1000;
export interface AuthDeps {
  db: Db;
  ui: Pick<UiConfig, 'accounts' | 'team' | 'publicUrl'>;   // never the client secret, which only the adapter holds
  signIn: ForgeSignIn; checks: Pick<ForgeChecks, 'isTeamMember'>;
  clock: () => Date; log: (entry: Record<string, unknown>) => void;
  random?: () => string;   // 32 random bytes in base64url; absent: randomBytes(32)
}
export interface Session { login: string; idHash: string; csrf: string }
export interface Auth {
  start(): Promise<UiAnswer>;                                                          // GET /api/auth/start
  finish(query: URLSearchParams, cookies: Record<string, string>): Promise<UiAnswer>;  // GET /api/auth/callback
  sessionOf(cookies: Record<string, string>): Promise<Session | null>;
  signOut(session: Session): Promise<UiAnswer>;                                        // POST /api/auth/signout, once the token is checked
}
/** One for the service: it keeps when it last deleted expired rows. */
export function createAuth(deps: AuthDeps): Auth;
export function cookiesOf(header: string | undefined): Record<string, string>;
export function csrfOk(session: Session, header: string | undefined): boolean;
```

**Rules (3.2; calls 10, 11, 12, 30):**

1. **Hashes and the token.** A state's, a verifier's and a session id's hash is `createHash('sha256').update(value).digest('hex')`; the PKCE challenge is `createHash('sha256').update(verifier).digest('base64url')`; a session's token for changes is `createHash('sha256').update('csrf:' + id).digest('base64url')`. Every comparison of two secrets is `timingSafeEqual` after a length check; `csrfOk` with an absent header is false.
2. **`cookiesOf`** splits on `;`, trims, takes `name=value` at the first `=`, keeps the first of a name, defines (not assigns) each key.
3. **The cookies, exactly:** state `__Host-visto_oauth=<state>.<verifier>; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`; its clearing `__Host-visto_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; session `__Host-visto_session=<id>; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`; its clearing `__Host-visto_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`. None has a `Domain`.
4. **`start`.** When this object has not deleted expired rows yet, or did so `SWEEP_MS` or more ago by the clock, `deleteExpired(now)` (and the time is kept). Then `liveStates(now)`: at `MAX_LIVE_STATES` or more, `json(503, { error: 'busy' })` and nothing stored. Else a state and a verifier, each from `random()`; `saveState({ stateHash, verifierHash, expiresAt: now + STATE_MS })`; `redirect(signIn.authorizeUrl(state, challenge, <publicUrl>/api/auth/callback), { 'set-cookie': <the state cookie> })`. A database step that rejects: `redirect('/ui/signin?error=failed')`.
5. **`finish`.** Every answer it gives carries the state cookie's clearing, and the session cookie first when it makes one (`set-cookie` is then a list of two). The first that holds, each a `redirect` to `/ui/signin?error=<code>` but the last, and each logged once as `{ event: 'ui_signin', outcome, reason }`:
   - an `error` parameter: `denied` (reason null);
   - no `code` or no `state` parameter, no state cookie, a cookie that is not `<43 characters>.<43 characters>` of base64url, a cookie state not equal to the parameter, `takeState` null, or the cookie's verifier not hashing to the verifier hash taken: `state`;
   - `signedIn(code, verifier, redirectUri)` rejects: `github`, its short code as reason;
   - `isBot`: `not_allowed`;
   - the login in `ui.accounts` (compared lower-cased): let in with `via` `account`; else no team: `not_allowed`; else `orgInstallation(org)` rejects or is null, or `isTeamMember` rejects: `unverified` (reason the short code, or `not_installed`); `isTeamMember` false: `not_allowed`; true: let in with `via` the team as `ui.team` writes it;
   - a database step that rejects: `failed`;
   - let in: a session id from `random()`, `createSession({ idHash, login, via, at: now, expiresAt: now + SESSION_MS })`, then `redirect('/ui/', ...)`, outcome `ok`.
6. **`sessionOf`.** A cookie that does not match `^[A-Za-z0-9_-]{43}$` is none, with no read. `readSession(hash, now)`; null is none. **The way in must still hold** in the config it was given: `via` `account` while the login is in `ui.accounts` (lower-cased), a team while `ui.team` equals it (lower-cased); else none, whatever else the config names, and the row is left. Else `{ login, idHash, csrf }`.
7. **`signOut`.** `deleteSession(idHash)`, then 204 with an empty body, `no-store`, the security headers and the session cookie's clearing.
8. No answer, log line or error holds a code, a state, a verifier, a session id, the token, the client secret or a login, but the cookies and the location this step sets.

- [ ] **Step 1: Write the failing tests.** A fake `ForgeSignIn` answers `authorizeUrl` as `https://github.test/authorize?state=<state>&challenge=<challenge>`, `signedIn` from a map of codes (recording the verifier), `orgInstallation` from a map; a fake `isTeamMember` from a map; `random` answers `'a'.repeat(43)`, `'b'.repeat(43)`, ... in turn; the clock is a value the test moves.

```ts
test('the start stores a state and a verifier for ten minutes, sets both in one cookie, and sends the browser to GitHub with the challenge', async () => {
  /* 302, location https://github.test/authorize?state=aaa...&challenge=<base64url sha256 of 'b'.repeat(43)>, set-cookie exactly the state cookie of rule 3;
     ui_states holds sha256 of the state and of the verifier, expiring at(600) */
});
test('while 1,000 states are live a start answers busy and stores nothing, and expired rows are deleted at most once a minute', async () => {
  /* 1,000 live states: 503 { error: 'busy' }, still 1,000 rows; expired rows inserted, starts at at(0), at(30), at(60):
     the statements holding 'expires_at <= $1' run at at(0) and at(60) only */
});
test('the way back with the right state and verifier and a named account makes a session of twelve hours and sends the browser to /ui/', async () => {
  /* code-1 -> octo-lead, ui.accounts ['Octo-Lead']: 302 /ui/, set-cookie [the session cookie of rule 3 with 'c'.repeat(43), the state cookie's clearing];
     signedIn was given the verifier 'b'.repeat(43); ui_sessions has id_hash sha256('c'.repeat(43)), login octo-lead, via account, expires_at at(43200);
     log [{ event: 'ui_signin', outcome: 'ok', reason: null }] */
});
test('a state is taken once: the same way back again is refused as state', async () => { /* second: /ui/signin?error=state; one session */ });
test('a way back whose state or verifier differs from its cookie, has none, or has expired is refused as state, makes no session and clears the cookie', async () => {
  /* cookie state other; cookie verifier other; no cookie; a cookie with no '.'; no state parameter; taken at at(600): each /ui/signin?error=state with
     set-cookie the state cookie's clearing; error=access_denied: denied; ui_sessions empty */
});
test("GitHub's refusal, an account not named, a bot, and a team that cannot be read are refused each with its own code", async () => {
  /* signedIn rejects oauth_refused: github, reason oauth_refused; octo-guest with no team: not_allowed; a bot: not_allowed;
     team named, orgInstallation null: unverified, not_installed; rejects github_502: unverified, github_502; isTeamMember rejects: unverified */
});
test("an active member of the team is let in through the organisation's installation; a member who is not active is not", async () => {
  /* ui.team acme/reviewers, orgInstallation('acme') '99', isTeamMember('99', 'acme/reviewers', 'octo-dev') true: a session via 'acme/reviewers'; false: not_allowed */
});
test('a session is read by its cookie, and stops being one when it expires or is signed out', async () => {
  /* sessionOf with the cookie: octo-lead, csrf = base64url sha256('csrf:' + id); at at(43200): null; a cookie of another shape: null with no statement;
     signOut: 204, set-cookie exactly the session cookie's clearing, then sessionOf null */
});
test('a session stops being one when the way it was let in no longer holds, with accounts and a team both named', async () => {
  /* ui { accounts: [octo-lead], team: acme/reviewers }: octo-lead let in via account, octo-dev via the team;
     an auth made with accounts [] and the same team: octo-lead's session null, octo-dev's read; with accounts [octo-lead] and team acme/other: octo-lead's read,
     octo-dev's null; with team ACME/Reviewers: octo-dev's read */
});
test("the token for changes is the session's own, and another session's or none is refused", () => {
  /* csrfOk(s, s.csrf) true; another's false; undefined false; a prefix false */
});
test('no log line or answer holds the code, the state, the verifier, the session id or the client secret, and no row holds any of them in clear', async () => {
  /* JSON of every log line and answer of the tests above, but the set-cookie and location headers of their own step, holds none of them;
     the rows of ui_sessions and ui_states hold only hashes, the login and the way in; AuthDeps has no key holding the client secret */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/auth.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: sign-in through the GitHub App with PKCE, sessions of twelve hours that keep their way in, and the token for changes`.

---

### Task 7: The reads and the API of the frame and Activity

**Files:**
- Create: `src/ui/api-types.ts`, `src/db/activity.ts`, `src/db/activity.test.ts`, `src/ui/api.ts`, `src/ui/api.test.ts`

**Interfaces:**

```ts
// src/ui/api-types.ts: types only, imports nothing; the frontend reads it through ui/src/api-types.ts
export interface ApiError { error: string }
export interface Me { login: string; csrf: string; mode: 'live' | 'dry_run'; repositories: string[] }
export type JobStage = 'waiting' | 'retrying' | 'queued' | 'preparing' | 'reviewing' | 'judging_threads' | 'publishing' | 'stopped';
export interface ActivityJob {
  job: number; repository: string; number: number; title: string | null; url: string; head: string | null;
  stage: JobStage; batch: number | null; batches: number | null; threadsDue: number | null;
  startedAt: string | null; runAt: string; askedBy: { reason: string; login: string | null };
}
export interface Withdrawal { repository: string; number: number; code: string | null; runAt: string }
export interface Activity {
  now: string; places: { reviews: number; withdrawals: number }; paused: 'spend_limit' | 'model_error' | null;
  jobs: ActivityJob[]; withdrawals: Withdrawal[];
}
export type ReviewOutcome = 'approved' | 'needs_person' | 'audit' | 'reviewed' | 'nothing_new' | 'not_posted' | 'failed';
export interface RecentReview {
  run: number; repository: string; number: number; title: string | null; outcome: ReviewOutcome; failureCode: string | null;
  highest: number | null; threshold: number | null; findings: { blocker: number; major: number; minor: number };
  mode: 'full' | 'incremental' | 'recheck'; dryRun: boolean; cost: number; tookMs: number; at: string;
}
export interface Reviews { now: string; windowDays: number; total: number; reviews: RecentReview[]; next: number | null }
// src/db/activity.ts
export interface JobRow { id: number; owner: string; repo: string; number: number; reason: string; head_sha: string; trigger: string; requested_by: string | null;
  status: string; run_at: Date; starts: number; started_at: Date | null; created_at: Date; stage: string | null; batch: number | null; batches: number | null;
  threads_due: number | null; title: string | null; stored_head: string | null }
export async function activityJobs(db: Db, limit: number): Promise<JobRow[]>;
export async function waitingWithdrawals(db: Db, limit: number): Promise<Array<{ owner: string; repo: string; number: number; retry_code: string | null; run_at: Date }>>;
export async function knownRepositories(db: Db, limit: number): Promise<string[]>;
export interface ReviewFilters { since: string; repository: string | null; kinds: string[] | null; title: string | null; number: number | null; before: number | null }
export async function recentReviews(db: Db, f: ReviewFilters, limit: number): Promise<ReviewRow[]>;   // ReviewRow: the columns of rule 2
export async function countReviews(db: Db, f: ReviewFilters): Promise<number>;                      // `before` not read
// src/ui/api.ts
export interface ApiDeps {
  db: Db; clock: () => Date; dryRun: boolean; reviewPlaces: number; withdrawPlaces: number;
  holds: (ref: PullRequestRef) => boolean;
  paused: () => Promise<string | null>;   // the service's pauseCode as it is; any code but spend_limit and model_error answers null
  pullRequestUrl: (ref: PullRequestRef) => string;
}
export function me(deps: ApiDeps, session: Session): Promise<Me>;
export function activity(deps: ApiDeps): Promise<Activity>;
export function reviews(deps: ApiDeps, query: URLSearchParams): Promise<Reviews | 'bad_request'>;
```

**Rules (3.1, 3.2, 5; calls 13, 14, 19, 20, 30):**

1. **The reads' statements**, exactly; owner and repo are stored lower-cased:

```sql
-- activityJobs ($1: the limit, 200)
select j.id, j.owner, j.repo, j.number, j.reason, j.head_sha, j.trigger, j.requested_by, j.status, j.run_at, j.starts,
       j.started_at, j.created_at, j.stage, j.batch, j.batches, j.threads_due, p.title, p.head_sha as stored_head
from visto_ai.jobs j
left join visto_ai.pull_requests p on p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number
where j.kind = 'review' and j.status in ('pending', 'running')
order by case when j.status = 'running' then 0 else 1 end, case when j.status = 'running' then j.started_at else j.run_at end, j.id
limit $1;
-- waitingWithdrawals ($1: 50)
select owner, repo, number, retry_code, run_at from visto_ai.jobs
where kind = 'withdraw' and status = 'pending' and starts > 0
order by run_at, id limit $1;
-- knownRepositories ($1: 200)
select distinct owner || '/' || repo as name from visto_ai.pull_requests order by name limit $1;
```

2. **The reviews' statements.** The inner part, `$1` the window's start and `$2` the repository or null:

```sql
select r.id, r.owner, r.repo, r.number, p.title, r.mode, r.dry_run, r.failure_code, r.highest_score, r.cost::float8 as cost,
       r.started_at, r.finished_at,
       case when jsonb_typeof(r.result->'verdict'->'threshold') = 'number' then (r.result->'verdict'->>'threshold')::float8 end as threshold,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'blocker')::int as blockers,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'major')::int as majors,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'minor')::int as minors,
       case
         when r.outcome = 'failed' then 'failed'
         when not r.published and r.result->'nothingToDo' = 'true'::jsonb then 'nothing_new'
         when r.approval_code = 'audit_sample' then 'audit'
         when r.approved then 'approved'
         when not r.dry_run and not r.published then 'not_posted'
         when r.needs_human then 'needs_person'
         else 'reviewed'
       end as kind
from visto_ai.review_runs r
left join visto_ai.pull_requests p on p.service = r.service and p.owner = r.owner and p.repo = r.repo and p.number = r.number
where r.started_at >= $1::timestamptz and ($2::text is null or r.owner || '/' || r.repo = $2)
```

   Around it (in the source the escape character is written `'\\'` inside the template literal, so the statement holds one backslash):

```sql
-- recentReviews ($7: 26)
select * from (<inner>) x
where ($3::text is null or x.kind = any(string_to_array($3, ',')))
  and ($4::text is null or x.title ilike $4 escape '\' or ($5::integer is not null and x.number = $5::integer))
  and ($6::integer is null or x.id < $6::integer)
order by x.id desc
limit $7;
-- countReviews
select count(*)::int as n from (<inner>) x
where ($3::text is null or x.kind = any(string_to_array($3, ',')))
  and ($4::text is null or x.title ilike $4 escape '\' or ($5::integer is not null and x.number = $5::integer));
```

   `$3` is the kinds joined with commas, or null; `$4` is `'%' + q.replaceAll(/[\\%_]/g, (c) => '\\' + c) + '%'`, or null; `$5` the number or null; `$6` `before` or null.
3. **`me`:** `{ login, csrf, mode: dryRun ? 'dry_run' : 'live', repositories: knownRepositories(200) }`.
4. **`activity`:** `now` the clock's ISO; `places` `{ reviews: reviewPlaces, withdrawals: withdrawPlaces }`; `paused` from `paused()`, kept only when it is `spend_limit` or `model_error`, else null; each job row: the ref is `{ service: 'github', owner, repo, number }` (the service this release knows), given to `holds()` and `pullRequestUrl()`; `repository` `owner/repo`; `head` the first 12 characters of `head_sha`, or of `stored_head` when `head_sha` is `''`, null when both are empty; `askedBy` `{ reason, login: trigger === 'manual' ? requested_by : null }`; the stage: running and not held: `stopped` (listed with the running ones); running and held: the row's `stage` when it is one of `preparing`, `reviewing`, `judging_threads`, `publishing`, else `preparing`, with `batch` and `batches` for the second and third and `threadsDue` for the third, null otherwise; pending with `run_at` after now: `waiting` when `reason === 'synchronize'` and `run_at - created_at` is exactly `QUIET_SECONDS * 1000` (`src/shell/triggers.ts`, as receiving stores a push's job), else `retrying`; pending and due: `queued`. `startedAt` only for a running row. Withdrawals: `{ repository, number, code: retry_code, runAt }`.
5. **`reviews`:** a parameter written empty reads as absent. `repo` lower-cased must match `^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$`; `outcome` `approved` (`['approved']`), `needs_person` (`['needs_person', 'audit']`) or `failed` (`['failed']`); `q` trimmed at most 100 characters, empty after the trim reads as none, digits with or without one `#` (at most 9 digits) also give the number; `before` `^\d{1,10}$` and at most 2147483647. Anything else: `'bad_request'`. The window starts 30 days before the clock; 26 rows are read; `next` is the 25th row's run when a 26th came. Each row: `highest` null for `failed` and `nothing_new`, else `highest_score`; `threshold` the read number or null; `tookMs` `finished_at - started_at`; `at` `finished_at`.

**The answers, exactly in shape (values invented):**

```json
{ "login": "octo-lead", "csrf": "q7Jv0bW2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D", "mode": "live", "repositories": ["acme/billing", "acme/shop"] }
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "places": { "reviews": 2, "withdrawals": 2 }, "paused": null,
  "jobs": [
    { "job": 41, "repository": "acme/shop", "number": 131, "title": "Cache the tax table per region", "url": "https://github.com/acme/shop/pull/131",
      "head": "a41c09e2b7d3", "stage": "reviewing", "batch": 2, "batches": 3, "threadsDue": null, "startedAt": "2026-03-01T09:59:12.000Z",
      "runAt": "2026-03-01T09:59:12.000Z", "askedBy": { "reason": "synchronize", "login": null } },
    { "job": 44, "repository": "acme/web", "number": 204, "title": null, "url": "https://github.com/acme/web/pull/204", "head": "17f0c3a9e5b2",
      "stage": "waiting", "batch": null, "batches": null, "threadsDue": null, "startedAt": null, "runAt": "2026-03-01T10:01:42.000Z",
      "askedBy": { "reason": "synchronize", "login": null } } ],
  "withdrawals": [ { "repository": "acme/shop", "number": 128, "code": "github_403", "runAt": "2026-03-01T10:00:52.000Z" } ] }
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "windowDays": 30, "total": 412,
  "reviews": [ { "run": 9001, "repository": "acme/shop", "number": 128, "title": "Round prices before tax", "outcome": "needs_person", "failureCode": null,
    "highest": 74, "threshold": 70, "findings": { "blocker": 0, "major": 1, "minor": 0 }, "mode": "incremental", "dryRun": false,
    "cost": 0.084, "tookMs": 41000, "at": "2026-03-01T09:48:00.000Z" } ],
  "next": 8977 }
```

- [ ] **Step 1: Write the failing tests.**

```ts
// src/db/activity.test.ts
test('the activity reads running review jobs first, then the pending by when they may start, with the title, the stored head and the creation time', async () => {
  /* a running job (title stored), two pending at at(60) and at(0), a gate job and a finished review job: order running, at(0), at(60); no gate, no finished;
     created_at as stored */
});
test('the withdrawals waiting are the pending withdraw jobs with a start, with their code', async () => {
  /* a pending withdraw job with starts 0: not listed; put back with 'github_403': listed with it */
});
test('each run reads as its outcome, the first that holds', async () => {
  /* one run of each: failed; nothing new unpublished; nothing new published after an approval (approved); audit_sample; approved; live unpublished (not_posted);
     dry run needs_human (needs_person); dry run not (reviewed); a result of {} (findings 0, threshold null) */
});
test('the reviews of the window are paged by run, filtered by repository, kinds, title or number, and counted', async () => {
  /* 30 runs in the window, 1 before: 26 read, next as rule 5; before the 25th: the rest; repo acme/billing; kinds failed; title 'tax'; number 128; count 30 */
});
// src/ui/api.test.ts (PGlite, rows written with the db functions or by statements)
test('me holds the login, the token, the mode and the repositories seen', async () => {
  /* dryRun true: mode dry_run; pull requests of acme/shop and acme/billing: ['acme/billing', 'acme/shop'] */
});
test('a running job this service does not hold reads as stopped, and a pending one\'s old stage is not read', async () => {
  /* holds false: stopped, listed with startedAt; holds true with stage null: preparing; holds is called with service 'github';
     a push's job stored by enqueueJob with runAt now + 180 s and stage reviewing written by hand: waiting; the same put back by requeueJob to now + 60 s: retrying;
     a reopened job with run_at after now: retrying; due: queued; manual with requested_by octo-dev: askedBy { reason: 'command', login: 'octo-dev' };
     head '' -> the stored head */
});
test('the pause is told only as spend_limit or model_error', async () => { /* paused answering 'spend_limit': spend_limit; 'other_code': null; null: null */ });
test('the search takes percent, underscore and backslash as themselves, an empty parameter is absent, and a malformed one is bad_request', async () => {
  /* titles '100% done', 'a_b', 'c\\d', 'abc': q '%' finds only the first, '_' only the second, '\\' only the third;
     'repo=&outcome=&before=&q=' answers as no parameter at all; repo 'acme', outcome 'all', before 'x', q of 101 characters: 'bad_request' */
});
test('an answer holds no field the screens do not show', async () => {
  /* the keys of Me, Activity, ActivityJob, Withdrawal, Reviews, RecentReview are exactly those of api-types.ts; with a run whose body is 'BODY-TEXT',
     a job with installation '99', comment_id 'c-31', association 'member', delivery 'd-1': no answer's JSON holds any of them */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/activity.test.ts src/ui/api.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the reads and the API of the frame and Activity`.

---

### Task 8: The route, and the service serving it

**Files:**
- Create: `src/ui/route.ts`, `src/ui/route.test.ts`
- Modify: `src/service.ts` (`ServiceDeps.ui`, the route, `stages: true`, the app check's `uiTeam`), `src/main.ts` (the wiring)
- Test: `src/service.test.ts` (the harness change, new tests)

**Interfaces:**

```ts
// src/ui/route.ts
export function createUiRoute(deps: { auth: Auth; api: ApiDeps; files: UiFiles; log: (entry: Record<string, unknown>) => void }): UiRoute;
// src/service.ts, ServiceDeps gains:
  /** Sign-in at the git service and the built files; absent: the UI is off whatever the config says. */
  ui?: { signIn: ForgeSignIn; files: UiFiles };
```

**Rules (3.1, 3.2, 5; calls 12, 13, 17, 23, 27, 30):**

1. **The route,** every answer from `headers.ts` or `files.ts`:
   - `/` `GET`: redirect `/ui/`; another method: 405 plain. `/ui` and `/ui/...`: `fileAnswer`.
   - `GET /api/auth/start`, `GET /api/auth/callback`: `auth.start()`, `auth.finish(query, cookiesOf(cookie))`, no session needed. `POST /api/auth/signout`: a session (else 401 `signed_out`) and the token (else 403 `csrf`), then `auth.signOut`.
   - `GET /api/me`, `GET /api/activity`, `GET /api/reviews`: a session, else 401 `signed_out`; `reviews` answering `'bad_request'` is 400.
   - A known path with another method: 405 `method_not_allowed`; any other `/api` path: 404 `not_found`.
   - A handler that rejects: 500 `internal_error`, logged `{ event: 'ui_failed', route: 'me' | 'activity' | 'reviews' | 'signout', reason: codeOf(error) }`.
2. **The service.** With `config.ui` and `deps.ui` both given, one `createAuth({ db, ui: { accounts: config.ui.accounts, team: config.ui.team, publicUrl: config.ui.publicUrl }, signIn: deps.ui.signIn, checks: deps.checks, clock, log: say })` (the client secret is not handed on), and the listener gets `ui: createUiRoute({ auth, api: { db, clock, dryRun: config.dryRun, reviewPlaces: config.limits.queueConcurrency, withdrawPlaces: WITHDRAW_CONCURRENCY, holds: (ref) => runner.holds(ref), paused: pauseCode, pullRequestUrl: deps.pullRequestUrl }, files: deps.ui.files, log: say })`; the service logs `{ event: 'ui', files: deps.ui.files.size }` once after listening. `reviewDeps` gains `stages: true`. `appCheck` passes `config.ui !== undefined && config.ui.team !== null` as `lacks`' fourth argument. With either absent, nothing of this is made or read.
3. **`main.ts`.** With `config.ui`, `ui: { signIn: createGithubSignIn({ clientId: config.ui.clientId, clientSecret: config.ui.clientSecret, auth, fetch: github }), files: loadUiFiles(join(import.meta.dirname, '..', 'ui', 'dist')) }`, made before the lock is taken like the other adapters.

- [ ] **Step 1: Write the failing tests and the harness change.**

`src/service.test.ts`, three changes and nothing else in the harness:
- the `Options` type gains `uiYaml?: string` and `ui?: ServiceDeps['ui']`;
- in `harness()`'s `start`, when `uiYaml` is given the YAML parsed is `BASE_YAML.replace('  webhookSecret: { env: S }\n', '  webhookSecret: { env: S }\n  clientId: Iv1.0123456789abcdef\n  clientSecret: { env: C }\n') + (yaml ?? '') + options.uiYaml` (a second `app:` would be a duplicate key), with `{ ...ENV, C: 'client-secret-for-tests-only' }`, and `ui` is passed as `ServiceDeps.ui` when given;
- the `lacks` fake takes a fourth argument and pushes it to a new `uiTeamCalls: unknown[]`, which `harness()` returns beside `approvalCalls`.

```ts
// src/ui/route.test.ts (PGlite, fakes of ForgeSignIn and isTeamMember, an in-memory UiFiles)
test('a person signs in, reads who they are, the activity and the reviews, and signs out', async () => {
  /* start -> callback with the state cookie -> GET /api/me with the session cookie: 200 Me with mode and repositories; /api/activity 200; /api/reviews 200;
     POST /api/auth/signout without the token: 403 csrf; with it: 204; /api/me then 401 signed_out */
});
test('without a session every read is signed_out, and the sign-in routes are open', async () => {
  /* /api/me, /api/activity, /api/reviews: 401 { error: 'signed_out' } with no-store and the security headers; /api/auth/start: 302; /api/nope: 404; POST /api/me: 405 */
});
test('a handler that fails is internal_error, logged with its route and short code only', async () => { /* activityJobs rejects: 500; one ui_failed line { route: 'activity', reason } */ });
// src/service.test.ts
test('with the UI off, /, /ui/ and /api/me are not found as before, and nothing is read for them', async () => {
  /* the harness as it is, and with uiYaml but no ui, and with ui but no uiYaml: 404 not_found plain for each; no statement holds 'ui_sessions' or 'ui_states' */
});
test('with the UI on, / goes to /ui/, the built page is served, and /api/me asks for a sign-in', async () => {
  /* uiYaml with accounts [octo-lead] and publicUrl; ui with a fake signIn and a map holding /ui/index.html: 302, 200 index, 401; one { event: 'ui', files: 1 } line */
});
test("the review jobs write their stage, and the app check asks for the team's permission", async () => {
  /* a review run through the service: a statement holding 'set stage = $2'; with ui.team: uiTeamCalls [true]; with accounts only: [false]; the harness as it is: [false] */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/route.test.ts src/service.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the UI's route, served by the service when the UI is on`.

---

### Task 9: The `ui/` package, its build, lint, tests and the image's build stage

The only task that uses the network, for `npm view` and `npm install` inside `ui/` and nothing else.

**Files:**
- Create: `ui/package.json`, `ui/package-lock.json` (made by npm), `ui/index.html`, `ui/public/favicon.svg`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/eslint.config.js`, `ui/src/main.tsx`, `ui/src/app.tsx` (a placeholder Task 10 replaces), `ui/src/index.css`, `ui/src/lib/utils.ts`, `ui/src/api-types.ts`, `ui/src/components/ui/button.tsx`, `card.tsx`, `badge.tsx`, `table.tsx`, `input.tsx`, `select.tsx`, `ui/src/components/segmented.tsx`, `ui/src/test/setup.ts`, `ui/src/components/ui/ui.test.tsx`
- Modify: `eslint.config.js` (ignores), `.gitignore`, `.dockerignore`, `Dockerfile`, `.github/workflows/ci.yml`

**Rules (3.1; calls 2 to 5, 17, 28):**

1. **`ui/package.json`:** `"name": "visto-ai-ui"`, `"private": true`, `"type": "module"`, `"license": "Apache-2.0"`, scripts `build: vite build`, `test: vitest run`, `typecheck: tsc --noEmit -p .`, `lint: eslint .`. Exact versions, each checked first with `npm view <name>@<version> version`; one that does not resolve, or an install that fails on a peer, stops the task and is reported (no other version is chosen by the implementer):
   - `dependencies`: `@fontsource/inter` 5.2.6, `@fontsource/jetbrains-mono` 5.2.6, `@radix-ui/react-slot` 1.2.3, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `react` 19.1.1, `react-dom` 19.1.1, `tailwind-merge` 3.3.1.
   - `devDependencies`: `@tailwindcss/vite` 4.1.12, `@testing-library/dom` 10.4.0, `@testing-library/jest-dom` 6.6.3, `@testing-library/react` 16.3.0, `@testing-library/user-event` 14.6.1, `@types/react` 19.1.8, `@types/react-dom` 19.1.6, `@vitejs/plugin-react` 5.0.2, `eslint` 9.34.0, `eslint-plugin-react-hooks` 5.2.0, `globals` 16.3.0, `jsdom` 26.1.0, `tailwindcss` 4.1.12, `typescript` 5.9.2, `typescript-eslint` 8.41.0, `vite` 7.1.5, `vitest` 3.2.4.
   - After `npm install`, `ui/package-lock.json` must hold entries for `@rollup/rollup-linux-x64-gnu`, `@rollup/rollup-linux-arm64-gnu`, `@esbuild/linux-x64`, `@esbuild/linux-arm64`, `lightningcss-linux-x64-gnu`, `lightningcss-linux-arm64-gnu`, `@tailwindcss/oxide-linux-x64-gnu` and `@tailwindcss/oxide-linux-arm64-gnu` (the image is built on Linux, on either processor); one missing stops the task and is reported.
   - **(ruled after the review) Node 26:** the task confirms, on the Node of the checkout (`node --version`, 26 or later), that the pinned versions install, build (`vite build`), lint, type-check and test, and writes in its report the Node version, what `npm install` warned of, and whether the tests needed rule 2's flag (they do when Node's own `localStorage` hides jsdom's); a failure stops the task and is reported.
2. **`vite.config.ts`** (`defineConfig` from `vitest/config`): `base: '/ui/'`, plugins `react()` and `tailwindcss()`, `build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false }`, `test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true, pool: 'forks', poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } } }` (Node 26 defines `localStorage`, `sessionStorage` and `Storage` itself, which would stand in front of jsdom's in the workers).
3. **`tsconfig.json`:** `target es2022`, `lib ["es2023", "dom", "dom.iterable"]`, `module esnext`, `moduleResolution bundler`, `jsx react-jsx`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `skipLibCheck`, `types ["vite/client"]`, `include ["src", "vite.config.ts"]` (the matchers' types come with the setup file's import). Tests import `test`, `expect` and `vi` from `vitest`; no globals.
4. **`eslint.config.js`:** `tseslint.config` with ignores `dist/` and `node_modules/`, `tseslint.configs.recommended`, then for `**/*.{ts,tsx}` browser globals and `eslint-plugin-react-hooks`'s flat config, `reactHooks.configs['recommended-latest']` (if the pinned version lacks it: `plugins: { 'react-hooks': reactHooks }` with `rules: reactHooks.configs.recommended.rules`, written in the report); for `src/**/*.{ts,tsx}` but `src/api-types.ts`: `no-restricted-imports` with the pattern `{ regex: '^(\\.\\./)+src/', message: 'The UI reaches the service only through src/api-types.ts.' }`; for `src/api-types.ts`: `@typescript-eslint/no-restricted-imports` with the same regex and `allowTypeImports: true`. The root `eslint.config.js` adds `'ui/'` to its ignores.
5. **`index.html`:** `<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`, the viewport meta, `<title>Visto AI</title>`, `<link rel="icon" type="image/svg+xml" href="/ui/favicon.svg">`, `<div id="root"></div>`, `<script type="module" src="/src/main.tsx"></script>`; no inline script or style anywhere. `public/favicon.svg`: the logo of the mockup (the accent square of 9 px radius with the white check path `M5 12.5l4.5 4.5L19 7.5`), as a standalone SVG. After `npm run build`, `dist/index.html` holds no `<script>` without `src`, no `<style>` and no `style=`, and `dist` holds no `data:` in a `.css` file: checked with `grep` in Step 5, and the result written in the report.
6. **`index.css`:** `@import "tailwindcss";` and the Fontsource files `@fontsource/inter/400.css`, `500.css`, `600.css`, `700.css`, `@fontsource/jetbrains-mono/400.css`, `500.css`; `:root` holds the mockup's `.app` tokens, every value copied character for character from `Activity.dc.html` (`--bg` to `--shadow`); its `.app.dark` tokens, copied the same way, are written twice: in `@media (prefers-color-scheme: dark) { :root:not(.light) { ... } }`, so a page with neither class follows the system before any script runs (no flash, call 18), and in `:root.dark { ... }`, so a stored choice of dark wins on any system; `@theme inline` maps `--color-<name>: var(--<name>)` for `bg`, `card`, `border`, `text`, `muted`, `subtle`, `accent`, `accent-soft`, `accent-text`, `on-accent`, `ok`, `ok-bg`, `warn`, `warn-bg`, `bad`, `bad-bg`, `info`, `info-bg`, then `--shadow-card: var(--shadow)`, `--font-sans: Inter, system-ui, sans-serif`, `--font-mono: 'JetBrains Mono', ui-monospace, monospace`; `@layer base`: `body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans) }`, `a { color: var(--accent-text) }`, `a:hover { color: var(--accent) }`.
7. **The components and their classes** (the mockup's, translated; `cn` is `twMerge(clsx(...))`):

| Piece | Classes |
|---|---|
| `Card` (`.card`) | `rounded-[12px] border border-border bg-card shadow-card` |
| `Button` default (`.btn`) | `inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium text-text no-underline hover:bg-subtle hover:text-text disabled:cursor-default disabled:opacity-55`; size `icon`: `px-2.5`; variant `primary`: `border-accent bg-accent text-on-accent hover:bg-accent hover:text-on-accent` |
| `Badge` (`.badge`) | `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium`; tones `ok` `bg-ok-bg text-ok`, `warn` `bg-warn-bg text-warn`, `bad` `bg-bad-bg text-bad`, `info` `bg-info-bg text-info`, `muted` `bg-subtle text-muted`, `accent` `bg-accent-soft text-accent-text`; `dot` adds `<span class="inline-block size-1.5 rounded-full bg-current">` first |
| `Table` (`.t`) | `w-full border-collapse text-sm`; head cell `whitespace-nowrap border-b border-border px-4 py-2.5 text-left text-xs font-medium text-muted`; cell `border-b border-border px-4 py-3 align-middle`; body `[&_tr:last-child_td]:border-b-0`; a row with `hover` `hover:[&>td]:bg-subtle` |
| `Input` (`.input`), `Select` (native) | `min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text` |
| `Segmented` (`.seg`) | group `inline-flex flex-wrap gap-0.5 rounded-[9px] bg-subtle p-[3px]`, `role="group"`; each `button type="button"` `min-h-8 cursor-pointer rounded-[7px] border-0 bg-transparent px-3 py-1.5 text-[13px] font-medium text-muted`, the one on `bg-card text-text shadow-card` with `aria-pressed="true"` |

8. **`api-types.ts`:** `export type { ApiError, Me, JobStage, ActivityJob, Withdrawal, Activity, ReviewOutcome, RecentReview, Reviews } from '../../src/ui/api-types.ts';`
9. **`test/setup.ts`:** `@testing-library/jest-dom/vitest`; `fetch` rejects a `NetworkBlockedError`; `XMLHttpRequest`, `WebSocket` and `EventSource` are classes whose constructor throws it; `window.matchMedia` answers `{ matches: false, media, addEventListener() {}, removeEventListener() {} }`; after each test, `cleanup()`, `localStorage.clear()`, `document.documentElement.className = ''`. The frontend's own error class is not named `ApiError`, which is the answer's type (Task 10).
10. **The image:** a first stage `FROM node:26-bookworm-slim AS ui`, `WORKDIR /build/ui`, `COPY ui/package.json ui/package-lock.json ./`, `RUN npm ci`, `COPY ui/ ./`, `COPY src/ui/api-types.ts /build/src/ui/api-types.ts`, `RUN npm run build`; the runtime stage as today plus `COPY --from=ui /build/ui/dist ./ui/dist` after `COPY contract ./contract`. `.dockerignore` gains `**/node_modules` and `ui/dist`; `.gitignore` gains `ui/dist/`.
11. **CI** after `npm ci`: `npm ci --prefix ui`; after `npm test`: `npm --prefix ui run lint`, `npm --prefix ui run typecheck`, `npm --prefix ui test`, `npm --prefix ui run build`.

- [ ] **Step 1: Check the versions** (`npm view`, network) **and install** (`npm install` inside `ui/`, network), then check the lock and Node 26 (rule 1).
- [ ] **Step 2: Write the failing tests.**

```tsx
// ui/src/components/ui/ui.test.tsx
test('a button, a card, a badge of each tone, a table, an input and a select carry the mockup classes', () => {
  /* each renders with the classes of rule 7; Badge dot renders the dot span first; Button asChild renders its child <a> with the button classes */
});
test('the segmented control marks the one on, and tells which was pressed', async () => {
  /* options All, Approved: All has aria-pressed true and the on classes; clicking Approved calls onChange('approved') */
});
test('the network is blocked in tests', async () => { /* fetch('/api/me') rejects NetworkBlockedError; new XMLHttpRequest() throws */ });
test("the page's storage is jsdom's, cleared after each test", () => {
  /* localStorage.setItem('k', 'v') then getItem gives 'v'; localStorage is an instance of window.Storage; a second test reads null */
});
```

- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm --prefix ui run lint && npm --prefix ui run typecheck && npm --prefix ui test`, then `npm test && npm run typecheck && npm run lint` and the ASCII check. Check the lint refusal by hand: a file importing `../../src/config/load.ts` is refused, then delete it.
- [ ] **Step 5: Build** `npm --prefix ui run build` and check rule 5 with `grep`.
- [ ] **Step 6: Commit** `feat: the ui package, its components and tests, built in a stage of its own and checked in CI`.

---

### Task 10: The layout, the sign-in page, and the pages still to come

**Files:**
- Create: `ui/src/api.ts`, `ui/src/router.tsx`, `ui/src/theme.ts`, `ui/src/format.ts`, `ui/src/context.tsx`, `ui/src/components/layout.tsx`, `ui/src/components/icons.tsx`, `ui/src/pages/sign-in.tsx`, `ui/src/pages/later.tsx`, `ui/src/pages/not-found.tsx`; tests `ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/sign-in.test.tsx`, `ui/src/format.test.ts`, `ui/src/theme.test.ts`
- Modify: `ui/src/app.tsx`, `ui/src/main.tsx`

**Interfaces:**

```ts
// ui/src/api.ts
/** A request the API did not answer with success; not `ApiError`, which is the JSON type of the answer it carries. */
export class RequestFailed extends Error { status: number; code: string }
export interface ReviewQuery { repo?: string; outcome?: 'approved' | 'needs_person' | 'failed'; q?: string; before?: number }
export interface Api {
  me(): Promise<Me>; activity(): Promise<Activity>; reviews(query: ReviewQuery): Promise<Reviews>; signOut(csrf: string): Promise<void>;
}
export function createApi(fetchFn?: typeof fetch): Api;   // same-origin, accept JSON; an answer not ok rejects RequestFailed(status, its ApiError's code)
export function usePoll<T>(read: () => Promise<T>, ms: number, key: string): { data: T | null; failed: boolean; error: RequestFailed | null };
// ui/src/router.tsx
export function useLocation(): { path: string; search: string };
export function navigate(to: string, replace?: boolean): void;
export function Link(props: { to: string; className?: string; children: ReactNode; 'aria-current'?: 'page' }): JSX.Element;
// ui/src/theme.ts
export function storedTheme(): 'light' | 'dark' | null;
export function currentTheme(): 'light' | 'dark';
export function applyTheme(theme: 'light' | 'dark'): void;   // the class dark or light on <html>, never both
export function chooseTheme(theme: 'light' | 'dark'): void;  // stores and applies
// ui/src/format.ts
export function initials(login: string): string;
export function ago(at: string, now: string): string;
export function took(ms: number): string;
export function left(runAt: string, now: string): string;
export function money(cost: number): string;
export function plural(n: number, one: string, many: string): string;
// ui/src/app.tsx
export function App(props: { api: Api }): JSX.Element;
```

**Rules (1, 3.2, 3.4; calls 18, 22 to 25):**

1. **`format.ts`.** `initials`: split on `-`, `_` and `.`, the first character of the first two parts upper-cased, or the first two characters of a single part (`octo-lead` `OL`, `octolead` `OC`, `''` `?`). `ago`: whole seconds from `at` to `now`, a time after `now` as 0; under 60 `<s> s ago`; under 60 minutes `<m> min ago`; under 24 hours `<h> h ago`; under 48 hours `yesterday`; else `<d> days ago`. `took`: rounded seconds, a duration below 0 as 0; under 60 `<s> s`; else `<m> min` or `<m> min <s> s`. `left`: seconds up, at least 0, `<m>:<ss>`. `money`: `$` and three decimals. `plural`: `<n> <one>` when n is 1, else `<n> <many>`.
2. **`theme.ts`:** call 18; every storage access is inside `try/catch`. `main.tsx` applies the current theme before the first render and, while no choice is stored, follows `prefers-color-scheme` changes. Before it runs, Task 9's CSS has already followed the system, so the first paint is never in the other theme.
3. **`App`:** reads `me()` once. While it reads: `<div aria-busy="true"></div>`. A 401: the sign-in page. Any other failure: `Could not reach the service.` and a button `Try again`, which reads again. Signed in: the layout around the page of the path. The app is in a context (`context.tsx`) with `api`, `me`, the latest `Activity` and whether its last read failed; the layout reads `activity()` with `usePoll` every 5000 ms (not while `document.visibilityState` is `hidden`, at once when it shows again); any read that rejects with 401 shows the sign-in page.
4. **Paths:** `/ui/` Overview, `/ui/activity` Activity (Task 11; until then a placeholder `<h1>Activity</h1>`), `/ui/repositories`, `/ui/memory`, `/ui/settings`, `/ui/reviews/<digits>` (heading `Review`), `/ui/signin` (signed in: `navigate('/ui/', true)`); any other path under `/ui/`: `<h1>Not found</h1>` and `No page at this address.` The coming pages: `<h1>` with the screen's name and `<p class="text-muted">Coming in a later plan.</p>`, in the page header of rule 6.
5. **The sidebar**, as drawn in `Activity.dc.html` (lines 50 to 70), with these classes: the root `flex min-h-screen flex-wrap bg-bg font-sans text-text`; the aside `flex max-w-full shrink grow basis-[232px] flex-col gap-6 border-r border-border bg-card px-3.5 py-5`; the brand `flex items-center gap-2.5 px-1.5`, its square `flex size-8 items-center justify-center rounded-[9px] bg-accent text-on-accent` with the check icon, `Visto AI` (`text-[15px]`, strong) over `Review service` (`text-xs text-muted`); the nav `flex flex-col gap-0.5` with `aria-label="Main"`, each entry `flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted no-underline hover:bg-subtle hover:text-text`, the one on `bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text` with `aria-current="page"`; the entries Overview, Activity, Repositories, Memory, Settings with the mockup's icons; Activity is on for `/ui/activity` and `/ui/reviews/...`, Overview only for `/ui/`; Activity carries a `Badge` accent `ml-auto` with the running count of call 19 when above 0. The foot `mt-auto flex flex-col gap-3`: the mode card `Card` with `flex flex-col gap-1.5 p-3 shadow-none`, holding a dotted `Badge` `self-start` and a line `text-xs text-muted`; the user row `flex items-center gap-2.5 px-1.5`: the avatar `flex size-[30px] items-center justify-center rounded-full bg-subtle text-xs font-semibold` (`aria-hidden`), the login (`text-[13px] font-medium`) over `Signed in with GitHub` (`text-xs text-muted`), then the theme `Button` size icon `ml-auto` and the sign-out `Button` size icon.
6. **The main box** `flex min-w-0 shrink grow-[999] basis-[560px] flex-col gap-6 px-8 pb-12 pt-7`; a page header `flex flex-wrap items-end justify-between gap-4` with `<h1 class="m-0 text-2xl font-semibold tracking-[-0.01em]">` and a sub-line `mt-1 mb-0 text-sm text-muted`.
7. **Texts, exactly:**

| Where | Text |
|---|---|
| Mode card, live | Badge ok `Live`; line `Posting reviews on <n> repositories. Dry run is off.` (`1 repository` when n is 1) |
| Mode card, dry run | Badge warn `Dry run`; line `Reviews are recorded, nothing is posted.` |
| Theme button | `aria-label` `Switch to dark theme` in light, `Switch to light theme` in dark; the moon icon of the mockup |
| Sign-out button | `aria-label` `Sign out`; icon paths `M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3`, `M10 17l-5-5 5-5`, `M5 12h11` (stroke, as the mockup's icons) |
| Sign-in page | a centred `Card` of `max-w-[400px] p-8`, the brand, `<h1>Sign in</h1>`, `Sign in with the GitHub account this deployment lets in.`, a primary `Button` asChild `<a href="/api/auth/start">Sign in with GitHub</a>` |
| Sign-in reasons (`?error=` on `/ui/signin`) | `denied`: `GitHub did not give access. Sign in again to try once more.`; `not_allowed`: `This GitHub account may not open this page.`; `unverified`: `The team membership could not be read, so the sign-in was refused.`; `state`: `The sign-in took too long or was started in another window. Sign in again.`; `github`: `GitHub could not be reached. Sign in again in a moment.`; any other: `The sign-in failed.`; shown above the button in a line `text-sm text-bad` with `role="alert"` |

8. **Sign out:** `api.signOut(me.csrf)`, then the sign-in page at `/ui/signin` (`navigate('/ui/signin')`); a failure leaves the person signed in.

- [ ] **Step 1: Write the failing tests.** A `fakeApi(over)` per file answers canned values and records calls.

```ts
// ui/src/format.test.ts
test('initials, ages, durations, time left, money and plurals read as pinned', () => {
  /* initials('octo-lead') 'OL', ('octolead') 'OC', ('') '?'; ago 48 s 'ago', 12 min, 3 h, 30 h 'yesterday', 50 h '2 days ago', a future time '0 s ago';
     took(41000) '41 s', (72000) '1 min 12 s', (120000) '2 min', (400) '0 s', (-5000) '0 s'; left 102 s '1:42', past '0:00'; money(0.084) '$0.084', (0) '$0.000'; plural(1, 'repository', 'repositories') */
});
// ui/src/theme.test.ts
test('the stored choice wins, else the system, and a storage that throws reads as none', () => {
  /* stored dark: dark; none and matchMedia dark: dark; getItem throws: system; applyTheme('dark') then ('light'): <html> class exactly 'light' */
});
test('before any script, the CSS follows the system', () => {
  /* the text of src/index.css (imported as './index.css?raw', which vite/client types) holds '@media (prefers-color-scheme: dark)' with ':root:not(.light)' and the dark --bg '#0F1218',
     and ':root.dark' with the same */
});
// ui/src/app.test.tsx
test('while signed out the sign-in page shows, with the reason GitHub sent back', async () => {
  /* me rejects 401 at /ui/signin?error=not_allowed: 'Sign in with GitHub' links to /api/auth/start; the alert reads 'This GitHub account may not open this page.' */
});
test('a service that cannot be reached says so, and Try again reads again', async () => { /* me rejects 500 then answers: the text, then the layout */ });
test('each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found', async () => {
  /* /ui/repositories: heading Repositories, 'Coming in a later plan.', its entry aria-current page; /ui/reviews/9001: heading Review, Activity on; /ui/nope: Not found */
});
test('any read answered 401 shows the sign-in page', async () => { /* activity rejects 401 on the second poll: the sign-in page */ });
// ui/src/components/layout.test.tsx
test('the sidebar shows who is signed in, the mode and the running count', async () => {
  /* me octo-lead live with 4 repositories: 'OL', 'octo-lead', 'Signed in with GitHub', 'Live', 'Posting reviews on 4 repositories. Dry run is off.';
     dry_run: 'Dry run', 'Reviews are recorded, nothing is posted.'; activity with 2 running and 1 waiting: the Activity badge '3'; with none: no badge */
});
test('the theme switch stores the choice and switches the class on the page', async () => {
  /* light: button 'Switch to dark theme'; clicked: <html> has dark and not light, localStorage visto-theme dark, the label 'Switch to light theme' */
});
test('sign out sends the token for changes and shows the sign-in page', async () => { /* signOut called with me.csrf; the sign-in page; a rejection leaves the layout */ });
test('the activity is read every five seconds, and not while the page is hidden', async () => {
  /* fake timers: reads at 0, 5 s, 10 s; hidden for 10 s: none; visible again: one at once */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: the layout of the UI, its theme switch, the sign-in page and the pages still to come`.

---

### Task 11: The Activity screen

**Files:**
- Create: `ui/src/pages/activity.tsx`, `ui/src/pages/activity.test.tsx`
- Modify: `ui/src/app.tsx` (the path `/ui/activity`)

**Rules (1, item 2; calls 13, 14, 19 to 23, 33):**

1. **As drawn in `Activity.dc.html`** (lines 72 to 125): the page header with the search, the repository select and the live badge; the card "In review now" with its header, its table and the withdrawals' lines; the card "Recent reviews" with its header, the outcome control, its table and its foot. Card headers `flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]` with `<h2 class="m-0 text-base font-semibold">`; tables in `overflow-x-auto`; a title cell `flex min-w-[220px] flex-col gap-0.5`, its link `font-medium text-text no-underline hover:text-accent-text hover:underline`, its sub-line `text-[13px] text-muted`; a head `font-mono text-[12.5px]`; the progress bar `h-1.5 overflow-hidden rounded-full bg-subtle` with an inner `block h-full rounded-full bg-accent` whose width is the percent, `role="img"`; a score `inline-flex min-w-11 items-center justify-center rounded-md px-2 py-0.5 text-[13px] font-semibold` toned `bg-ok-bg text-ok` (green), `bg-info-bg text-info` (blue) or `bg-bad-bg text-bad` (red) by call 21; the foot `flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-5 py-3`; the withdrawal line `flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3 text-[13px]`.
2. **The data.** "In review now" is the context's `Activity` (Task 10's poll). "Recent reviews" is `api.reviews(query)` read at once and when the query changes, and every 15000 ms while on the first page (`usePoll`, keyed by the query). The search is sent 300 ms after the last key; any filter change starts again from the first page. Paging keeps a stack of `before` values: Next pushes `next`, Previous pops. The repository select lists `me.repositories`. The search and the repository also filter the rows of "In review now" in the page: the repository equal, and the search found in the title without letter case, or equal to the number (with or without `#`).
3. **Texts, exactly:**

| Where | Text |
|---|---|
| Header | `<h1>Activity</h1>`; `What the service is doing now, and what it did lately` |
| Search | placeholder and hidden label `Search pull requests`; `type="search"`, `w-[240px]` |
| Repository | hidden label `Repository`; first option `All repositories`, value `''` |
| Live badge | dotted ok `Updating live`; when the last read failed, dotted warn `Not updating` |
| Card 1 | `In review now`; Badge accent `<r> running, <q> queued` (call 19); right, `text-[13px] text-muted`: `<n> places for reviews, <m> for withdrawals` (`1 place for reviews` when n is 1) |
| Columns | `Pull request`, `Stage`, `Asked by`, `Started`, `Progress` (`w-[200px]`) |
| Title | the title linked to `url` (`rel="noreferrer"`); with no title, `<repository> #<number>` as the link; sub-line `<repository> #<number>` and the head in mono |
| Stage | `waiting`: dotted muted `Waiting for pushes to settle`, detail `<left> left`; `retrying`: dotted muted `Waiting to try again`, detail `<left> left`; `queued`: dotted muted `Queued`, detail `starts when a place is free`, or `waits while reviews are paused` when `paused`; `preparing`: dotted info `Preparing`; `reviewing`: dotted info `Reviewing`, detail `batch <batch> of <batches>`; `judging_threads`: dotted info `Judging threads`, detail `<threadsDue> due`; `publishing`: dotted info `Publishing`; `stopped`: dotted warn `Stopped`, detail `runs again at the next start`. The detail is `text-[13px] text-muted` after a space |
| Asked by | `synchronize` `A push`; `opened` `Opened`; `reopened` `Reopened`; `ready_for_review` `Marked ready for review`; `retargeted` `Retargeted`; `command`, `command_retry` mono `/review` then ` by <login>` when there is one; `done`, `done_retry` mono `/done` then ` by <login>`; `rerun`, `rerun_retry` `A re-run of the check`; any other the reason in mono |
| Started | `ago(startedAt, now)` when running, else `Not yet`; `text-muted` |
| Progress | percent: `preparing` 5, `reviewing` and `judging_threads` `10 + round(80 * (batch - 1) / batches)`, `publishing` 95, else 0; `aria-label` `About <p> percent` for a running stage, `Waiting` for `waiting` and `retrying`, `Queued`, `Stopped` (call 33: not the mockup's sample values) |
| No job | one cell spanning the columns: `Nothing is running or queued.` (`text-muted`) |
| Withdrawal | Badge warn `Withdrawal`; `<repository> #<number>: dismissing an earlier approval failed (<code in mono>), tried again in <took(max(0, runAt - now))>.`, or without ` (<code>)` when there is none; a time already past reads `0 s` |
| Card 2 | `Recent reviews`; the control `aria-label="Outcome"`: `All`, `Approved`, `Needs a person`, `Failed` |
| Columns | `Pull request`, `Outcome`, `Highest score`, `Findings`, `Mode`, `Cost`, `Took`, `When` |
| Title | the title (or `<repository> #<number>`) linked with `Link` to `/ui/reviews/<run>`; sub-line `<repository> #<number>` |
| Outcome | `approved` ok `Approved`; `needs_person` warn `Needs a person`; `audit` accent `Drawn for the audit`; `reviewed` muted `Reviewed`; `nothing_new` muted `Nothing new`; `not_posted` muted `Not posted`; `failed` bad `Failed`, then a space and the code in mono muted |
| Highest score | `failed`: `None` muted; `nothing_new`: `Kept` muted; else the score `<highest>%` |
| Findings | `<n> blocker`, `<n> major`, `<n> minor` for those above 0, in that order, joined with `, `; none: `None` muted |
| Mode | `Full`, `Incremental`, `Re-check`; a dry run adds `, dry run` |
| Cost, Took, When | `money(cost)`, `took(tookMs)`, `ago(at, now)` muted |
| Foot | `<rows> of <total> reviews in the last 30 days` (`review` when total is 1), `text-[13px] text-muted`; buttons `Previous` (disabled on the first page) and `Next` (disabled when `next` is null) |
| No review | `No review in the last 30 days.`, or `No review matches.` with any filter, in one cell |
| Read failed | `The reviews could not be read.` in one cell |

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/pages/activity.test.tsx
test('In review now shows each stage with its words, who asked, when it started and its progress', async () => {
  /* one job of each stage at now 10:00:00: 'Reviewing' 'batch 2 of 3' 'About 37 percent', 'Judging threads' '3 due', 'Waiting for pushes to settle' '1:42 left',
     'Waiting to try again', 'Queued' 'starts when a place is free', 'Preparing' 'About 5 percent', 'Publishing' 'About 95 percent', 'Stopped' 'runs again at the next start' in the same table, with a started time;
     'A push', '/review by octo-dev', 'Opened'; '48 s ago', 'Not yet'; a title null reads 'acme/web #204'; the head in mono */
});
test('the counts say running and queued as the overview counts them, and the places', async () => {
  /* 2 running, 1 stopped, 1 waiting, 1 queued, 1 retrying: '4 running, 2 queued', and the sidebar's badge '4'; places 2 and 2: '2 places for reviews, 2 for withdrawals'; 1: '1 place for reviews, 2 for withdrawals';
     paused spend_limit: 'waits while reviews are paused' */
});
test('a withdrawal waiting to try again is said with its code and when', async () => {
  /* code github_403 due in 52 s: 'acme/shop #128: dismissing an earlier approval failed (github_403), tried again in 52 s.'; code null: '...failed, tried again in 52 s.'; runAt 5 s before now: 'tried again in 0 s.' */
});
test('nothing running reads as such, and the live badge says when updates fail', async () => { /* no job: 'Nothing is running or queued.'; failed read: 'Not updating' */ });
test('recent reviews show each outcome, score, findings, mode, cost, time taken and age', async () => {
  /* one of each outcome: the seven badges; 74 at threshold 70 red, 52 blue, 18 green; failed 'None' and 'github_502'; nothing new 'Kept';
     '1 blocker, 1 major', 'None'; 'Incremental', 'Re-check', 'Full, dry run'; '$0.084', '1 min 12 s', '12 min ago'; the title links to /ui/reviews/9001 */
});
test('the outcome, the repository and the search are sent to the server, and paging goes forward and back', async () => {
  /* Approved: reviews({ outcome: 'approved' }); repository acme/shop: { repo: 'acme/shop', outcome: 'approved' }; typing 'tax' sends q after 300 ms once;
     Next with next 8977: { ..., before: 8977 }; Previous: without before; a filter change starts from the first page; In review now keeps only acme/shop rows matching 'tax' */
});
test('the list says when nothing matches, and when it cannot be read', async () => {
  /* empty with no filter: 'No review in the last 30 days.'; with q: 'No review matches.'; rejected: 'The reviews could not be read.';
     '25 of 412 reviews in the last 30 days', '1 of 1 review in the last 30 days' */
});
test('the first page of reviews is read again every 15 seconds, and a later page is not', async () => { /* fake timers: 0, 15 s; after Next: none */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: the Activity screen: what runs now with its stage, withdrawals, and the reviews of the last 30 days`.

---

### Task 12: The documents, the run under Docker, and the notes

**Files:**
- Modify: `README.md`, `config.example.yml`, `env.example`, `docs/superpowers/specs/2026-11-25-the-ui-design.md` and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built
- Create: `docs/superpowers/plans/2026-11-25-the-ui-sign-in-and-activity-notes.md`
- Test: `src/config/load.test.ts` (one new test)

**Rules:**

1. **README.** Each sentence states only what the code does, with its cost where it has one. `## Status`: the row `UI` becomes `UI: sign-in through the GitHub App and the Activity screen (off unless the config names who may open it)`, built, with what was tried (rule 5); a row `UI: the review page, settings, the overview, repositories and memory`, planned. A new section `### The UI (optional)` after `### Reading what a review would have posted`: the five keys and the refusal; the GitHub steps of "For the owner", 2; building `ui/` for a start outside Docker (`npm --prefix ui ci && npm --prefix ui run build`) and that `/ui/` is 404 until then (`{ event: 'ui', files: 0 }`); the sign-in with PKCE, the `__Host-` cookies and their attributes, 12 hours, the state's 10 minutes, access, the way a session was let in and when it is read again (calls 10 to 12), that the team read may let in members of the team's child teams (To verify, 3), that the service must be opened at `publicUrl` itself (another host loses the state's cookie and the sign-in is refused as `state`), and the caps of calls 12 and 17; who sees what (call 13); the screens of this release and what leads to "Coming in a later plan"; the stage and what each reads as (call 14); the headers and the cache (call 17); the routes and that every one but sign-in needs a session; `ui_signin` and its outcomes; the migration `0014_ui` and that a previous release cannot be put back; and these statements, exactly:

```sql
-- who is signed in now
select login, via, created_at, last_used_at, expires_at from visto_ai.ui_sessions where expires_at > now() order by last_used_at desc;
-- sign everyone out
delete from visto_ai.ui_sessions;
```

   `### Creating the app`: the callback URL and the client secret. `## Development`: the `ui` scripts. `## Repository layout`: `ui/` and `src/ui/`.
2. **`config.example.yml`.** (ruled after the review) `src/config/load.test.ts`'s `the example file has no service blocks as shipped, and loads with them switched on` and `the example with its extensions block switched on names the example module` uncomment every line from `# app:` to the blank line after `alerts`, with variables that hold no client secret. So under `# app:`, after its `webhookSecret` line, the two keys are written as comments that stay comments once that run is uncommented: `#   # clientId: Iv1.0123456789abcdef` and `#   # clientSecret: { env: APP_CLIENT_SECRET }`; and the `ui` block stands after the blank line that follows `alerts`, before the audit key's paragraph, followed by a blank line of its own:

```yaml
# Who may open the web UI at <publicUrl>/ui/. With neither accounts nor team written the UI is off, and /ui/ and /api/ answer 404.
# With either, app.clientId, app.clientSecret and publicUrl must be written too. Sign-in goes through the GitHub App: on its settings
# page set the callback URL to <publicUrl>/api/auth/callback and generate a client secret. With team, install the app on that
# organisation with Members read. Everyone let in sees the activity of every repository the app is installed on.
# ui:
#   accounts: [octo-lead]
#   team: acme/reviewers
#   publicUrl: https://visto.example.test
```

   **Test:** `the example's ui block, uncommented with the app's client id and secret, reads who may open the UI and what sign-in needs`: `uncomment(uncomment(example(), '# app:'), '# ui:')`, then `'  # clientId:'` and `'  # clientSecret:'` replaced by `'  clientId:'` and `'  clientSecret:'`, parsed with the app's variables and `APP_CLIENT_SECRET`: `ui` deepEquals `{ accounts: ['octo-lead'], team: 'acme/reviewers', publicUrl: 'https://visto.example.test', clientId: 'Iv1.0123456789abcdef', clientSecret: <the variable> }`. Step 2 runs the two tests named above too, unchanged.
3. **`env.example`:** after `APP_PRIVATE_KEY`, `# Only if config.local.yml names who may open the UI: the client secret generated on the GitHub App's settings page.` and `# APP_CLIENT_SECRET=change-me-client-secret`.
4. **The designs are amended,** in the same commit, one sentence for each place this plan departs from them or adds to them:

| Document, section | The sentence | Call |
|---|---|---|
| UI design 3.2, Sessions | The way back's state and a PKCE verifier are also set in a cookie of their own, `__Host-`, `SameSite=Lax`, 10 minutes, cleared on the way back, because a `Strict` cookie is not sent when GitHub sends the browser back; the cookies carry the `__Host-` prefix; a session's last use is written when the stored one is 60 seconds old or more; a session keeps the way it was let in (a named account, or the team) and ends when that way no longer holds; expired rows are deleted at most once a minute, at most 1,000 states are live, and the sign-in routes have 2 places of their own and the rest of the API 4. | 10, 11, 12, 17 |
| UI design 3.2, Requests that change something | The token is derived from the session's id and given by `GET /api/me`. | 12 |
| UI design 3.3, item 1 | It becomes: The job's row gains a stage (preparing; reviewing batch n of m, from the engine as its batches end; judging threads while a batch holding a thread owed a verdict has not ended; publishing) and the time it was reached; a claim clears it, and a running row the service does not hold reads as stopped. | 14 |
| UI design 5 | `GET /api/activity` also lists the withdrawals waiting to try again; `GET /api/reviews` reads the last 30 days, 25 a page; `GET /api/me` holds the repositories the service has seen. | 13 |
| UI design 7, item 1 | It gains: Cut in two plans: sign-in, serving, the layout and Activity, which is built, and the One review screen, which is next. | 1 |
| UI design 9, the bullet on main section 4 | It gains: and sign-in's sessions and states. | 12 |
| Main 10, App permissions | Members read is needed also when the UI names a team. | 27 |
| Main 11.1, the UI's bullet | It becomes: Who may open the UI: named accounts or one team (`ui`), with the address people open it at and the app's client id and secret, by reference. | 9 |
| Main 13 | `pull_requests` gains the title; `jobs` the stage and a withdrawal's retry code; `ui_sessions` and `ui_states` hold sign-in. | 15, 16, 29 |
| Main 18, item 10 | It gains: Cut in three plans (UI design 7), the first in two. | 1 |

5. **The run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before; the images are built before, with the network.
   - **The previous release first** (main before this branch), on an empty database, given a pull request and a published run by statements, then stopped. This branch starts on it: the ledger gains `0014_ui`; the new columns are null and the old rows read; the previous release, started again, refuses.
   - **The UI off:** `/`, `/ui/`, `/api/me` answer 404 `not_found`, plain.
   - **The refusal:** `ui.accounts` without `publicUrl`, `clientId` and `clientSecret` stops the start with the three issues and prints no value.
   - **The UI on,** `dryRun: true`, the Playwright image of the exact version the browser script uses pulled before the network is closed, `ui.accounts: [octo-lead]`, `publicUrl: http://localhost:8080`, an invented client id and a random secret. A stub server made for the run answers as `github.com` and `api.github.com` (network aliases) with a certificate of a CA made for the run (`NODE_EXTRA_CA_CERTS` on the app): the authorize page sends the browser back with a code and the state at once; the exchange and `/user` answer the login the stub is set to; every other path 404 (so the start's redelivery raises `redelivery_failed` once, as expected, which the notes say). From inside the app's container: `/` 302 `/ui/`; `/ui/` 200 with the exact headers of call 17; an asset `immutable`; `/ui/activity` the index; `/ui/assets/nope.js` 404; `/api/me` 401.
   - **A browser** (Playwright's image, in the app's network namespace, the stub's certificate accepted): signs in as `octo-lead` and lands on `/ui/`; the sidebar shows the login and `Dry run`; Activity shows rows written by statements: a pending `synchronize` job due in 2 minutes (`Waiting for pushes to settle`), a due one (`Queued`), a running one nobody holds (`Stopped`), a pending withdraw job with one start and `github_403`, and 30 runs of the window of each outcome (two pages, the filters and the search); the theme kept across a reload, and no flash of the other theme on a dark system; sign out; five `/api/me` sent at once from inside the container leave at least one answered 503 `busy`; a sign-in as `octo-guest` reads `This GitHub account may not open this page.`; the console shows no violation of the content security policy. Screenshots in light and dark go in the notes.
   - **A stage seen live:** the stub also answers the reads one dry-run review of one small pull request makes (an installation token, the pull request, its files, their contents, `.visto-ai.yml` as 404, `GET /app`), and a model stub (`model.baseUrl` pointed at it) answers one completion with one `submit_review` call after 20 seconds; an `opened` event delivered: while the model stub waits, Activity shows `Reviewing` with `batch 1 of 1`; after it, the run is in Recent reviews.
   - **Throughout,** every log line is one JSON object; the log holds neither the client secret, the session cookie's value, a code, a state, a token nor `octo-lead`. Everything the run made is removed.
6. **The notes file,** in the form of the plans before: the status, the decisions taken while building, what the reviews found, what the run showed, what is for the owner, what is known and left, and what is not verified.

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the root suite, type check, lint, the four `ui` scripts and the ASCII check.
- [ ] **Step 3: Commit** `docs: the UI's sign-in and Activity in the README, the config examples, the designs, and the plan as built`.

---

## To verify

None of these is shown by a test of this plan. Each names the step of Task 12 that can show it, or "For the owner" when it needs GitHub and his browser.

1. **What GitHub's token exchange answers** for a good code, a used code and a wrong secret (a 200 with `error` is assumed from GitHub's documentation). For the owner, 3.
2. **That a GitHub App's user authorization needs no scope** and that `GET /user` answers `login` and `type` with the user's token. For the owner, 3.
3. **That `GET /orgs/{org}/installation` answers the app's installation with the app's token**, that the membership read works with it for a member whose membership is private, and whether a member of a child team of `ui.team` reads as an active member (GitHub's documentation suggests it does: the README says so). For the owner, 3, with a team.
4. **That a browser keeps a `Secure`, `__Host-` cookie on `http://localhost`** and sends a `Lax` cookie on GitHub's redirect back; whether it does on `http://127.0.0.1`, and in Safari on localhost; that a host other than `publicUrl` loses the state's cookie and is refused as `state`. Task 12, rule 5 (Chromium on localhost); the rest, and against GitHub, For the owner, 3.
5. **That the built page needs nothing the policy refuses** in a real browser (fonts, the CSS of each chunk, React's styles). Task 12, rule 5.
6. **That the exact versions of Task 9 install together and run on Node 26**, and the lock builds on Linux on both processors. Task 9, step 1; the image build of Task 12.
7. **That GitHub's token endpoint takes PKCE from a GitHub App** (`code_challenge` with `S256`, `code_verifier` at the exchange) and form parameters. For the owner, 3.
8. **Rate limits beyond the caps** (per address, per minute): none here; For the owner, 6.
9. **The sizes:** 16, 2 and 4 places, 64 KiB, 12 hours, 10 minutes, 60 seconds between writes of the last use and between deletions of expired rows, 1,000 live states, 5 and 15 seconds of polling, 25 a page, 30 days, 200 jobs and repositories, 50 withdrawals.
