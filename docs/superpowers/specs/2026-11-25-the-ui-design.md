# Visto AI: the UI (stage 10)

This document designs stage 10 of the build order (design section 18, item 10): the web UI. It extends the main design, `2026-11-13-visto-ai-design.md`, which still binds everything it does not change here; where this document changes it, section 9 says so. The screens were drawn as mockups and approved by the owner on 2026-11-25.

## 1. What the UI is for

The people who run the service open it to see what the reviewer is doing now, what it did lately and how well its score tells what needs a person, and to change how it behaves without editing a file. Six screens:

1. **Overview.** Reviews over the last 7, 30 or 90 days (published, dry run, failed), what is in review now, today's spend against the daily limit, how many pull requests were approved automatically and how many were drawn for the audit, reviews per day, open alerts, score quality per repository (Safety, Benefit and Focus at the repository's threshold, each with the count behind it, design 6.6 "Live"), reverts, the approval settings in short, and the health of each dependency.
2. **Activity.** What is running and queued now, each with its stage (waiting for pushes to settle, queued, preparing, reviewing batch n of m, judging threads, publishing) and who or what asked for it; withdrawals waiting to retry; the recent reviews with their outcome, highest score, findings, mode, cost, time taken and age, filterable by repository and outcome, searchable by title or number.
3. **One review.** Why it approved or did not (the approval paragraph's code and text), the merge gate's state, the score of each file with its reason and its blocks, the files not reviewed and why, the findings with their severity, place and thread state, earlier threads (cleared, still open), dropped duplicates, usage (model, calls, tokens, cached tokens, cost), the approval record (this run's code; earlier approvals and their withdrawal), each dependency's status on that review, and the feedback people gave. A selector moves between the reviews of the pull request.
4. **Repositories.** For one repository and a window: Safety by block and by file, Benefit and Focus, at 20, 40, 70 and 90 percent and at the repository's own threshold, each with its count; the blocks people stepped in on that scored under the threshold; reverts and how many of them the bot had approved; audits drawn and how many needed a person; the share of helpful feedback and the reasons given.
5. **Memory.** The learned records (people stepped in, reverts, lessons) with their kind, text, place, source, dates and an on and off switch each (design 7, "every record has a kill switch in the UI").
6. **Settings.** Every setting that is not a secret and not needed before the database is reached, editable, with what it does in plain words; secrets shown only as set or not set; who may open the UI.

The mockups were drawn on a design canvas and are copied, as approved, into `2026-11-25-the-ui-mockups/` beside this document, one HTML file per screen (`Main` is the Overview). Every value in them is invented. They fix the screens' content and look: the columns, filters, cards and the grouping and wording of the Settings form; this document fixes everything else. The look: light by default with a dark theme a viewer switches, a soft gray-blue ground, white cards, an indigo accent, Inter for text and a monospace face for code, built with shadcn/ui on React. On 2026-11-27 the owner had the colours follow the project icon (`assets/icon.svg`): a pale green-gray ground and a dark green accent in the light theme, a deep green ground and the icon's mint in the dark one, and the icon itself beside the name and as the tab's icon. The mockups' indigo is replaced; the rest of their look stands.

## 2. What the owner decided

Quoted or restated from the conversation of 2026-11-25:

- **O-UI-1.** Every setting that can be configured is editable in the UI, "like the threshold and so on". Secrets stay out of the UI.
- **O-UI-2.** Settings live in the database: the same Postgres the service already uses.
- **O-UI-3.** Some people will only edit `config.yml`. The two stay in sync by a rule per setting, applied at each start (section 4.3).
- **O-UI-4.** shadcn/ui may be used. "A more modern design, not all black", with a dark theme too.
- **O-UI-5.** The merge gate keeps its behaviour: on a gated base branch in enforce or bypass mode a push waits for `/done`; shadow mode keeps push reviews. The UI says so beside both settings.
- **O-UI-6.** The setting that lists the base branches whose pull requests are reviewed on every push (today's `baseBranches`, empty meaning every branch) is shown as "Reviewed on every push", and `*` is accepted as every branch.

## 3. How it is built

### 3.1 The parts

- **The frontend** is a single-page React application in TypeScript under `ui/`, outside `src/`, built with Vite, styled with Tailwind and shadcn/ui components (copied into `ui/`, as shadcn does), with its own `package.json`, `tsconfig.json` and lint block. It is built into static files when the Docker image is built, in a build stage of its own; the runtime image holds only the built files. The service's own code keeps its rules: no build step, Node's type stripping, no new runtime library in `src/`.
- **The service** serves the built files under `/ui/` (an `index.html` for every path under it that is not a file, so the application's own routes reload), redirects `/` to `/ui/`, and answers a JSON API under `/api/`. Both are a route group of the existing `node:http` server, with their own body cap and in-flight count, modelled on the extension routes.
- **The API** is the only way the frontend reaches data. Every answer is built from an allowlist of fields; no answer ever holds the loaded configuration object, which carries secret values.

### 3.2 Sign-in and access

- **Who may open it.** The UI is on when `ui.publicUrl` is written; password accounts are made in the UI and by a command; `ui.accounts` and `ui.team` decide who may sign in through GitHub. GitHub access is read from the file; password accounts and every role live in the database, and the last admin cannot be removed.
- **How.** Sign-in goes through the GitHub App's own user authorization (OAuth for GitHub Apps): the app's client id in the config, its client secret by reference (`APP_CLIENT_SECRET`), the callback `<public URL>/api/auth/callback`. The service asks GitHub for the signed-in user's login, then checks it: listed in `ui.accounts`, or an active member of `ui.team`, read with the existing team-membership read (`GET orgs/{org}/teams/{team}/memberships/{login}`, Members read) through the installation of that organisation. Anything that cannot be read refuses the sign-in.
- **Sessions** are rows of a table (`ui_sessions`): a random id stored hashed, the login, the times it was made and last used, and an expiry 12 hours after it was made. The cookie holds the id only: `HttpOnly`, `Secure`, `SameSite=Strict`, path `/`. Membership is checked again at each sign-in, not on every request; signing out deletes the row. The OAuth `state` is a random value stored with a 10-minute expiry and used once. The way back's state and a PKCE verifier are also set in a cookie of their own, `__Host-`, `SameSite=Lax`, 10 minutes, cleared on the way back, because a `Strict` cookie is not sent when GitHub sends the browser back; the cookies carry the `__Host-` prefix; a session's last use is written when the stored one is 60 seconds old or more; a session keeps the way it was let in (a named account, or the team) and ends when that way no longer holds; expired rows are deleted at most once a minute, at most 1,000 states are live, and the sign-in routes have 2 places of their own and the rest of the API 4. A session belongs to an account, whose role is read at each request; a password sign-in makes the same session.
- **Who may change settings.** Admins only; viewers see everything but Settings, and the API refuses them its admin routes. Every change is recorded with who made it and when (section 4.4).
- **Requests that change something** (`POST`, `PUT`, `DELETE`) carry a per-session token in a header the API checks; a read never changes anything. The token is derived from the session's id and given by `GET /api/me`.
- **Headers.** A content security policy that allows only the service's own origin (no inline script, no third-party origin; the fonts are bundled), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, and `Cache-Control: no-store` on every API answer.

### 3.3 What the UI needs that the service does not store yet

From the map of the code made for this stage. Each becomes a task of a plan:

1. **A review's stage while it runs.** The job's row gains a stage (preparing; reviewing batch n of m, from the engine as its batches end; judging threads while a batch holding a thread owed a verdict has not ended; publishing) and the time it was reached; a claim clears it, and a running row the service does not hold reads as stopped.
2. **A pull request's title**, stored with its facts on each delivery.
3. **Alerts.** A table of alerts: code, short details (never a secret, a login or a text), when raised and when cleared. The alerts the service already raises are written there as well as logged and posted; an alert that has a pair (a dependency failing, then working) is cleared by its pair.
4. **Dependency health.** A table holding each dependency's current status (the model's key check, the second scorer, memory, each extension, each MCP server, the app's permissions and events) and since when, written where the service already learns it.
5. **Spend per day** over a window, and reviews per day, read from what is stored.
6. **Feedback**, read back per review and per repository.
7. **The kill switch** of a memory record, written by the UI and read by the next review (the status `disabled` the table already allows).
8. **Live score quality.** The labels of design 6.6 (a block needed a person) are built from the stored human activity and the stored runs, and fed to the same pure measuring code the backtest uses. The stricter label needs the diff at the last head before the merge, which is not stored; the live numbers use each block's hash at the pull request's last review instead, and say so on the screen. They are computed on request for one repository and window, and cached for a few minutes.
9. **A finding's thread state** is derived from what is stored (thread events in human activity, verdicts kept by later runs), not read from GitHub on each view.

### 3.4 Calls the builder made on the design's check

Each is reversible and listed for the owner.

- **Dry run decides no approval.** The service in dry run works out no approval (it reads neither threads nor branch rules then). The UI says "Not decided in dry run" where a decision would stand, and counts no approval or audit for a dry-run review. Cost: a deployment trying the service in dry run sees no approval numbers until it goes live.
- **Open and recent alerts.** An alert is open only while what it reports still holds: a dependency failing (until its pair says it works again), a permission or event missing (until a start finds it), a withdrawal that failed (while its failure is recorded), spend at 80% of the limit (until the day ends, UTC). Every other alert is listed under "Recent" for 7 days and is never open. Nobody clears an alert by hand. Cost: an alert that has no state behind it cannot be marked as dealt with.
- **File and database that pass apart and clash together.** When the file passes on its own but the settings it leaves in the database make the whole refuse (for example the UI switched approval on with an audit share above 0, and the file later drops `auditKey`), the start is refused with each issue and a sentence saying which settings clash and that writing them in `config.yml` settles it (a setting changed in the file wins at the next start). Cost: the service and its UI are down until the file is fixed.
- **An audited pull request "needed a person"** when, after its review, any of its blocks or files is labelled as needing a person by design 6.6's strict label, or it was later reverted. The count shows how many audits there were and how many of them needed a person, each with its count. Cost: an audit a person read and found fine leaves no trace, so a low count means "nobody stepped in", not "a person checked".

## 4. Settings in the database

### 4.1 What moves and what stays

- **In the database, editable in the UI:** `dryRun`, `learning`, `limits`, the model's non-secret fields (endpoint, model, fallbacks, effort, extra body and headers that are not secret references, prices, time limit, how the answer is asked for), the second scorer's non-secret fields and its threshold, and the repository defaults and every override (branches, ignored authors, "Reviewed on every push", how a new commit is reviewed, threshold, inline notes, the merge gate, automatic approval, the thread rule, the audit share).
- **In `config.yml` only, shown read-only:** what the service needs before it reaches the database or that holds a secret by reference: `app` (id, key, webhook secret, client id and secret), `database`, `server`, `alerts`, `auditKey`, `extensions`, `mcpServers`, and `ui` (who may open it). Secret values are never shown; the UI shows each secret's variable name and whether it is set.

### 4.2 One validation

A save is the whole set of editable settings, merged with the file-only part, checked by the same schema and the same checks across fields that check the file today (an enabled gate names a branch, the audit key is set when approval draws, and the rest). A save that fails is refused with each issue next to its field, and nothing is stored. The service never runs on settings it would refuse at start.

### 4.3 Keeping the file and the database in sync (O-UI-3)

At each start, for each editable setting, the service compares the file's value now with the file's value the last time it read the file, which it keeps in the database:

- **Changed in the file** (written, edited or removed): the file's value goes into the database, replacing what the UI set, and the change is recorded as made by `config.yml`. A setting removed from the file goes back to its default.
- **Not changed in the file:** the database keeps its value, so a change made in the UI survives a restart.
- **A file that fails validation** stops the start, as today, and nothing is copied.
- **The first start** with no stored settings copies every setting from the file.

Each value on the Settings page says where it came from ("From `config.yml` at the start of <time>", or "Changed in the UI by <login>, <time>"). The page gives the current settings as a `config.yml` section to copy back into the file. The UI never writes the file.

### 4.4 The record of changes

Every change, from the UI or from the file at a start, is a row: when, who (`config.yml` or a login), the scope (global or a repository), the setting's path, the old value and the new one. Secrets never appear in it. The Settings page lists the latest changes.

### 4.5 When a change takes effect

- **At the next review**, with no restart: the repository settings, the limits read for each review (tokens per call, batches per review, the daily spend limit), and the model's and scorer's fields read at each call.
- **At the next start:** settings the service reads once when it starts (dry run, learning, the queue's concurrency, the model's endpoint and time limit, how the answer is asked for, the second scorer's endpoint). The UI marks them, and after such a change shows "Takes effect when the service restarts" until it has.

A review already running keeps the settings it started with.

## 5. The API, in outline

All under `/api/`, all answers JSON, all behind a session but the sign-in routes:

- `GET /api/auth/start`, `GET /api/auth/callback`, `POST /api/auth/signout`, `GET /api/me`.
- `GET /api/auth/ways`, `POST /api/auth/password`, `POST /api/auth/first-password`, `POST /api/me/password`, `GET /api/accounts`, `POST /api/accounts/new`, `/role`, `/reset`, `/remove`.
- `GET /api/overview?days=`, `GET /api/activity` (running and queued), `GET /api/reviews?repo=&outcome=&q=&before=` (paged), `GET /api/reviews/{run}`, `GET /api/pulls/{owner}/{repo}/{number}/reviews`.
- `GET /api/repositories`, `GET /api/repositories/{owner}/{repo}/quality?days=`.
- `GET /api/memory?kind=&repo=&q=`, `PUT /api/memory/{id}` (on or off).
- `GET /api/settings`, `PUT /api/settings`, `GET /api/settings/changes`, `GET /api/settings/export`.
- `GET /api/health` (dependency statuses and open alerts).

The plans fix the shapes. Every list is paged and bounded. `GET /api/activity` also lists the withdrawals waiting to try again; `GET /api/reviews` reads the last 30 days, 25 a page; `GET /api/me` holds the repositories the service has seen.

## 6. Testing

- **The API** is tested like the rest of the service: through the listener with no socket, on PGlite, with GitHub stubbed at the boundary (the OAuth exchange, the user read and the membership read included).
- **The frontend** is tested with Vitest and Testing Library: each screen renders from stubbed API answers, its states (empty, loading, error) and its controls (a switch, a save that is refused). No test reaches the network.
- **A real run under Docker** at the end of each plan, as before, with a stub of GitHub's OAuth endpoints inside the closed network, a browser driving the built UI through sign-in and each screen.

## 7. The cut into plans

1. **The frame:** the `ui/` application and its build, serving it, the API's route group, sign-in, sessions and access, the layout with its sidebar and theme switch, Activity (with the stage of a running review and pull request titles) and One review. It ends with a signed-in person seeing what runs and opening a review. Cut in two plans: sign-in, serving, the layout and Activity, which is built, and the One review screen, which is next.
2. **Settings:** the settings tables, the sync at start, validation, saving, the record of changes, the export, applying at the next review and marking what waits for a restart, `*` in "Reviewed on every push", and the Settings screen.
3. **The rest:** alerts and dependency health stored, spend and reviews per day, feedback read, live score quality, the kill switch, and the Overview, Repositories and Memory screens.

Each plan is reviewed before it is built, built task by task with a review of each task, ends with a run under Docker and a review of the whole branch, and is merged through a pull request, as in the stages before.

## 8. Not in this stage

- Re-running a review from the UI: a `/review` comment does it.
- Editing secrets, `app`, `database`, `server`, extensions or MCP servers from the UI.
- Anything the mockups do not show.

## 9. Changes to the main design

- **Section 4,** the `ui` part: it serves the screens of this document and writes settings, the record of changes and memory switches, and sign-in's sessions and states, not only the kill switch.
- **Section 11.1:** the deployment config's editable part lives in the database once the service has started, kept in sync with the file by section 4.3; the file keeps `app`, `database`, `server`, `alerts`, `auditKey`, `extensions`, `mcpServers` and `ui`. D10 is unchanged: a reviewed repository's own file still cannot loosen anything, and the UI is part of the deployment, not of a repository.
- **Section 18, item 10:** cut in three plans, as section 7 says.
