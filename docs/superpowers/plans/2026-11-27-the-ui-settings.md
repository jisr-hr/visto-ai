# The UI's Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every setting of the deployment that is neither a secret nor needed before the database is reached lives in the database once the service has started, and an admin changes it on the Settings screen. At each start the service compares each setting in `config.yml` with what the file said the last time it was read: a setting changed in the file goes into the database and wins, one not changed keeps what the UI saved, and a file that clashes with what the UI saved stops the start with each issue and a sentence saying how to settle it. A save is checked by the same code that checks the file, whole, and is refused with each issue beside its setting, storing nothing. Every change, from the UI or from the file, is recorded with who made it and when, and the screen lists the latest. The screen also gives the saved settings as `config.yml` text to copy back; the UI never writes the file. A saved change applies from the next review, but for the settings the service reads once when it starts, which the screen marks and, once changed, shows as waiting for a restart. "Reviewed on every push" (`baseBranches`) takes `*` as every branch. Settings opens on the mockup's sections, General, Model, Repositories, Secrets and Access, and keeps Accounts as built.

**Architecture:** `src/config/load.ts` splits `parseConfig` into `readYaml` and `parseDocument`, the one validation, and its `ConfigError` gains each issue's path as keys. `src/config/editable.ts` (pure) names the editable settings by scope (`global`, `defaults`, or a repository `owner/name`) and dotted path, takes them out of a document and puts them back in, pins the ones read at start, maps an issue to its setting, maps a loaded config back to the file's shape, and writes the export. Migration `0016_settings` adds `settings` (the database's editable part, one row per setting written, with its source), `settings_file` (what the file wrote at the last start) and `setting_changes` (the record); `src/db/settings.ts` holds every statement. `src/shell/settings.ts` makes the start's sync and the save, each one transaction under the table's lock, and holds the settings in force. `src/main.ts` migrates and syncs after taking the instance lock, then builds the engine from the settings in force at start and starts the service on them; `src/service.ts` reads the settings in force at each review (one snapshot per review job), each event and each look at the spend, and asks main's `engineDeps` for the model client and scorer of those settings. `src/ui/settings.ts` builds the four answers from an allowlist; `src/ui/route.ts` routes them for admins. In `ui/`, the client gains four calls, three controls (a switch, a list of chips, the segmented control with none chosen), a pure draft (`ui/src/settings-draft.ts`), and the Settings screen in four files.

**Tech Stack:** Unchanged: Node 26 or later, type stripping, no build step, no new library in either `package.json` (the root's `yaml`, already a dependency, writes the export). React 19, Tailwind v4 with the tokens of `ui/src/index.css` only. One migration, `0016_settings`. No model call.

**Spec:** `docs/superpowers/specs/2026-11-25-the-ui-design.md` ("the UI design"): 1 item 6, 2 (O-UI-1, 2, 3, 5, 6), 3.2 (who may change settings, requests that change something), 3.4 (file and database that pass apart and clash together), 4 whole, 5 (the four settings routes), 7 item 2, 9; its mockup `docs/superpowers/specs/2026-11-25-the-ui-mockups/Settings.dc.html` ("the mockup"), whose form's grouping and wording are approved and fixed and whose indigo is replaced by the tokens of `ui/src/index.css` (the UI design 1, as amended on 2026-11-27); and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` ("main"): 11.1, D10, 13. It builds on the merged plans `docs/superpowers/plans/2026-11-25-the-ui-sign-in-and-activity.md` and `docs/superpowers/plans/2026-11-26-password-sign-in-and-roles.md` and their notes, whose calls and "as built" rules stand unless a call here changes them. Executors read the UI design, the mockup and this plan whole.

**Notes:** the notes file beside this plan, `docs/superpowers/plans/2026-11-27-the-ui-settings-notes.md`, is written when the build ends. **This plan's branch is cut from the One review plan's branch `ui-review`**, which itself starts from `ui-theme` (`dev` plus one recolour commit). That plan adds a review page and two read routes to `ui/src/app.tsx`, `ui/src/api.ts`, `src/ui/api.ts`, `src/ui/route.ts` and `src/ui/api-types.ts`, two methods to every frontend `fakeApi` and to the `each` list of `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page`, and a seventh `fakeApi`, of its own, in `ui/src/pages/review.test.tsx`. This plan was written against `dev` as read before those commits: each task that touches one of those files finds that plan's additions there, keeps them as they are and adds its own beside them (in `route.ts`, its paths in the table of methods, after the review paths that plan dispatches before the table, and its cases in the switch; in `api-types.ts`, its types after the others; in the `each` list and the seven fakes, its four methods after theirs), and says in its report how it merged.

**Words used below.** *The file*: `config.yml`'s document as `readYaml` read it at this start. *A setting*: one entry of the lists of Task 2, named by its *scope* (`global`, `defaults`, or a repository's `owner/name` in lower case) and its *path* (dotted, such as `score.threshold`); its *key* is `<scope>:<path>`. *Written*: a setting the database (or a document) holds a value for; one not written reads as its default, or, for a repository, as the defaults'. *The editable part*: every setting written, as a map from key to value (`Editable`). *At start*: as this start of the service left it. *Saved*: as the last save left it (at start, the same). *In force*: what the service runs on: the saved settings, but the start-time ones (Task 2, rules 1 and 4) as at start. *Start-time*: read once when the service starts (UI design 4.5). *The version*: the id of the newest row of the record, 0 when it has none. *The record*: `visto_ai.setting_changes`. *The lock*: `lock table visto_ai.settings in share row exclusive mode`, the first statement of the sync's and of each save's transaction. *An admin read*, *an admin change*: a route behind a session and the admin role, the second with the token for changes too (the password plan's call 20). *The draft*: the page's unsaved changes. *Short code*, *the token for changes*, *a session*: as in the plans before.

## Scope

| In this plan | Left out, and why |
|---|---|
| The settings tables, the sync at each start, the clash refusal (4.3, 3.4) | **Editing `app`, `database`, `server`, `ui`, `alerts`, `auditKey`, `extensions`, `mcpServers` or a secret** (UI design 4.1, 8): read-only on the screen |
| One validation for the file and for a save (4.2) | **Writing `config.yml`** (4.3): the export is text to copy |
| The record of changes and its card (4.4) | **The memory switch, alerts, health, the other screens** (UI design 7, item 3) |
| Applying at the next review, and marking what waits for a restart (4.5) | **Restarting the service from the UI**: the operator restarts it |
| `*` in "Reviewed on every push" (O-UI-6) | **The eval commands reading the database** (call 21): they read the file |
| The four routes (5) and the Settings screen as the mockup draws it, Accounts kept | **A per-repository right to change settings** (UI design 3.2): admins change all |

**Dry run:** the same; `dryRun` is itself a start-time setting (call 19).

## Not in this plan

- Re-running a review from the UI, restarting the service, or writing any file (UI design 8).
- The Overview, Repositories and Memory screens, alerts, health, spend per day, feedback, the memory switch (the UI design's plan 3).
- Any dropped idea (no finding verifier, no repository-wide context packs, no recall-first contract, no lens pass), and any model call.

## Calls

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where a design says otherwise, the call says so.

**The cut and the rules of the build**

1. **One plan of eleven tasks** (the UI design's plan 2, whole): the validation and `*`; the editable part; the store; the sync and the save; applying them; the API; the client, its controls and the draft; the page with General, Model, Secrets and Access; Repositories; the record and the export; the documents with the run under Docker. Cost: a plan near the size of the first two.
2. **(builder) No new library**, at runtime or in `ui/`: the export is written by the root's `yaml` (`stringify`), already a dependency; the switch, the chips and the slider are ours (a `button` with `role="switch"`, buttons and a native `input type="range"`), not shadcn's Switch, which needs `@radix-ui/react-switch`. Cost: no focus ring of Radix's; each control is ours to keep.
3. **(builder) One migration, `0016_settings`** (the One review plan adds none). The previous release refuses to start on the migrated database (`unknown_migration_applied`), as after every migration. Cost: no way back to the previous release.
4. **(builder) Tests never reach the network, a real Postgres or a model.** Cost: what Postgres does with two saves at once is shown only by the run under Docker (Task 11).
5. **(builder) The tokens only.** Every class is a token class of `ui/src/index.css`'s `@theme` (`bg-accent`, `text-accent-text`, `bg-accent-soft`, `bg-subtle`, `text-muted`, `bg-ok-bg`, ...) or a size; never a hex value or a palette class. The mockup's switch colours (`--off`, `--knob`) are not tokens: the off track is `bg-muted`, the knob `bg-card`. Cost: the switch that is off is darker than drawn.

**What a setting is**

6. **The editable part (UI design 4.1), as settings.** `global`: `dryRun`, `learning`, the four `limits`, and `model.baseUrl`, `model.model`, `model.fallbacks`, `model.effort.default`, `model.effort.elevated`, `model.toolChoice`, `model.timeoutSeconds`, `model.prices`, `model.extraBody`, `model.extraHeaders`, `scorer.baseUrl`, `scorer.model`, `scorer.timeoutSeconds`. `defaults` and each repository: `primaryBranches`, `ignoredAuthors`, `baseBranches`, `newHead`, the five `score.*` keys and the seven `gate.*` keys. A list or a map is one setting. Values are stored in the file's own shape (the JSON of what YAML read), so the database's part put back into the file's document is checked by the very code that checks the file, `written` or not included (`newHead` not written, the scorer's threshold that must be written). `model.apiKey`, `scorer.apiKey` and every other block stay in the file. **(As built, by the owner's ruling after the final review: `model.baseUrl` and `scorer.baseUrl` are not settings either. They stay in the file, shown read only with "Set in config.yml", because an admin who could edit them could send the model's and the scorer's API keys to an address of their choosing; the lists below are as built without them, 17 global paths and five start-time ones.)** Cost: a value is a whole list or map: two people editing one list meet at the version (call 16).
7. **Scopes.** `global`, `defaults`, and each override's key lower-cased (the git service's names are case-insensitive, as `repoSettingsFor` already reads them); an override key that is not of the form `<owner>/<name>` (`^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$` once lower-cased) names no repository the service can review, and is dropped from the editable part. Cost: such a key in the file is silently not copied; it never had an effect.
8. **The second scorer is on while one of its three keys is written.** Its key stays in the file: put back, the `scorer` block is the written `scorer.*` keys with the file's `scorer.apiKey`, and no block at all when none is written (its reference dropped). Switching it off in the UI unwrites the three keys; switching it on needs the file to write `scorer.apiKey`, or the save is refused with that issue. Whether it is on is start-time (call 19). Cost: a deployment names its scorer in the file first; once the UI switched it off, the file's block stays unread until the file changes a scorer key.
9. **Effort is a select, as drawn:** `Provider default` (`{}`), `Low`, `Medium`, `High` (`{ reasoning: { effort: <low|medium|high> } }`, OpenRouter's form, as `config.example.yml` writes it), and, when the stored fragment is any other, `As written in config.yml`, which keeps it until another is chosen. Cost: another fragment is kept or replaced from the UI, never edited.
10. **Rows and cards the mockup does not draw** (O-UI-1 makes every setting editable; the mockup's grouping stands): in Model, after its drawn rows, `Second scorer endpoint` (as built: read only text, not a field) and `Second scorer time limit` (shown while the scorer is on), `Extra body` and `Extra headers` (JSON text); in each repository's pane, `Use the default` beside an override (as built: also under the gate's and automatic approval's heading switches, which show their override line and can go back to the default; a repository added in the pane that overrides nothing says `It is kept once it overrides a setting.`, wording the mockup does not have; and each repository's pane starts fresh, keyed by the repository); after Access, the Accounts card as built, then `Changes` (the record) and `In config.yml` (the export), each also in the sections' nav; on every row its source line (4.3) and, on a start-time row, the badge `Needs a restart`; in Secrets, the rows of call 12 the mockup does not draw (`GitHub App client secret`, each `Extension ...` and each `MCP server ...`). Cost: four rows of Model, three cards, a button and the Secrets rows the owner did not see.
11. **Access is read-only, in words true since the password plan:** `Address`, `Team that may sign in through GitHub`, `Accounts that may sign in through GitHub` (the mockup's "Team that may open this page" and "With no team and no account named, the UI is off" stopped being true when the UI turned on with its address alone). Settings opens on General: the page reads from the top. Cost: Accounts, which the page opened on, is now below Access.
12. **Secrets, by variable name:** each reference the file writes (`model.apiKey`, `scorer.apiKey`, `app.privateKey`, `app.webhookSecret`, `app.clientSecret`, `database.url`, `auditKey`, `alerts.webhook`, and each `{ env }` in an extension's options or a server's headers) is `Set` (the service refuses to start while a written one is not); one the file can write but does not is `Not set`, with no variable. The mockup's "Not set, alerts are shown here only" waits for the alerts of plan 3: it reads `Not set`. Cost: no variable is named for a secret not written.

**The sync and the save**

13. **The sync (UI design 4.3), in `main.ts`, after the instance lock and the migrations and before anything reads a setting**, in one transaction whose first statement is the lock: for each key in the editable part the file writes now or wrote at the last start, a value that differs (written or not included) is changed in the file: written into `settings` (or its row deleted when the file no longer writes it, so it reads as its default), as made by `config.yml`, and recorded when the database's value differs; then `settings_file` becomes the file's editable part. A key the file did not change keeps the database's value. The first start needs no case of its own: nothing was read before, so every setting the file writes is changed. Values are compared and stored as the database keeps them (`storableValue`: no U+0000, no lone surrogate), so a file value holding one is not seen as changed at every start. When the file writes the value the UI saved, nothing is recorded but the setting's source becomes `config.yml`. **(ruled by the builder) While the UI is off (the file writes no `ui.publicUrl`), each start copies the file's editable part whole:** every key whose stored value or source is not the file's is written or deleted as made by `config.yml`, each value that changes recorded, so no setting applies that nobody can see or undo. Cost: the start runs about one statement per setting written once, and one per setting changed; the eval commands do not see what the UI saved (call 21); turning the UI off drops the changes made in the UI and not written into the file (the record keeps them, and the export taken before gives their text).
14. **A clash at start (UI design 3.4).** The file passed alone; the file's document with the database's part put back is checked too, and when that fails the transaction is rolled back (nothing copied, `settings_file` not advanced) and the start is refused: each issue on its own `config: ` line, then, when some setting of the database's part came from the UI, the sentence `Saved in the UI: <their file paths joined with ", ", at most 10, then ", and <n> more">; with them config.yml does not pass. Changing them in config.yml (another value, or removed) settles it: a setting changed in the file wins at the next start.`, then `start_failed`, exit 1. Cost: the service and its UI stay down until the file is fixed; the sentence names every setting saved in the UI, not only those that clash, which the issues tell.
15. **One validation (UI design 4.2).** `parseDocument` is what `parseConfig` does once the YAML is read, unchanged; the file, the start's merged document and each save go through it. A save is refused unless two documents pass: the file's with the saved part put back (what the next start would run on) and the file's with the part in force until the restart (what runs now). Each issue is mapped to its setting by its path (`ConfigError.details`, Task 1); an issue whose path names no setting (`auditKey`, `scorer.apiKey`) is shown at the top of the page, its whole line. Nothing is stored when either fails. Cost: two parses per save (each a few milliseconds).
16. **A save is a list of changes against the version the page read.** Each names a key and its new value, or no value to unwrite it ("use the default"). Under the lock, a version that is not the newest refuses the whole save (409 `changed`): the page reads the settings again and keeps its draft, so a second save sends the same changes on top of the newer settings. A change whose value is what is stored changes and records nothing. Cost: two admins saving at once: the second saves again.
17. **The record (UI design 4.4):** one row per value changed (a save, or the file at a start), with the time, `config.yml` or the account's name (kept as text, as `ui_account_changes` keeps it), the scope, the path, and the value before and after as JSON, SQL null for not written. No setting is a secret (call 6). **`model.extraBody` and `model.extraHeaders` take no reference** (the schema reads them as plain values): whatever the file writes there is shown to admins, recorded and exported. **So are `model.baseUrl` and `scorer.baseUrl`**, which take any http or https address, a user, a password or a query included. The Settings page is an admin's: viewers never see any of them. Nothing is refused (a deployed file would stop starting). Cost: a credential written in plain text in an extra header, an extra body field or an endpoint's address (`https://user:token@...`, `...?key=...`) is shown on the screen, stored in the three tables, recorded and exported.
18. **Values the database would change are refused before any check:** a change whose value (or a key inside it) holds U+0000 or a lone surrogate is `bad_request`, so what is checked is what is stored. Cost: none known.

**When a change takes effect**

19. **Start-time (UI design 4.5), from where the code reads each today:** `dryRun`, `learning`, `limits.queueConcurrency`, `model.timeoutSeconds`, `model.toolChoice`, and whether the scorer is on (as built: the two endpoints are no longer settings, so no longer in this list). Every other setting is read at the next review or event: the repository settings (each event, gate job, withdraw job and review job reads `repoSettingsFor` of the settings in force), the limits read for each review, the daily spend limit (read at each look; as built, a level the day's spend has fallen back under because the limit was raised alerts again when it is reached again), the model's model, fallbacks, effort, extra body and headers and prices, and the scorer's model and time limit (the review job asks `engineDeps` for a model client and a scorer made from the settings in force: `extraHeaders`, which the client reads once when made, follows each review). The judge's model client is made from the settings in force at each of its calls. **The design lists the scorer's endpoint as start-time and is silent on whether the scorer is on:** both are, since the contract file and the scorer's presence are chosen once at start. Cost: a gate switched on in the UI holds each pull request from its next event, and the start's sweep of checks, the bypass alert and the app's permission check (feature_off) wait for the next start; a gate switched on while the pause changes asks no checks until then; **two more are read at start:** automatic approval switched on in the UI is checked for Administration read (`approvalUseOf` in the app check) only at the next start, and every check of the model's key, at the start and at each upkeep, sends the start's `model.extraHeaders` and endpoint while reviews send the saved headers.
20. **A review already running keeps the settings it started with:** the review job is given, when its runner starts it, a snapshot of the settings in force (its `settingsFor`, its limits and its engine). Events, the gate's and the withdrawal's jobs read the settings in force when each runs. Cost: none known.
21. **The eval commands (`npm run eval:replay`, `eval:backtest`, `eval:judge` and the other `eval:*` scripts) read `config.yml` only.** Cost: an eval after a change in the UI runs on the file's settings; the export gives the text to bring the file in step.
22. **What waits for a restart:** a start-time setting whose saved value (written or not included) is not its value at start; and the scorer when its being on differs. The row says `Takes effect when the service restarts` until a start reads it. Cost: none known.

**The API and the screen**

23. **The routes** (Task 6 holds the exact JSON): `GET /api/settings` (an admin read), `PUT /api/settings` (an admin change with a JSON body), `GET /api/settings/changes?before=` (an admin read, 50 a page, newest first), `GET /api/settings/export` (an admin read). The table of methods takes `GET, PUT` for `/api/settings`, and a 405 carries `allow: GET, PUT`. With the UI on but no settings given to the route (the tests of before), the four answer 404 `not_found` and read nothing. Cost: none known.
24. **The export:** the file's `dryRun`, `learning`, `limits`, `model`, `scorer` and `repositories` blocks as the saved settings make them (the written settings only, and the references the file writes inside `model` and `scorer`), as YAML, after two comment lines saying what it is and that a setting changed in the file wins at the next start. It reads back as the same settings (a test). Cost: the file's comments in those blocks are lost when they are replaced.
25. **The draft.** A control changed writes its key, whatever the value; Discard drops the draft; `Discard` and `Save changes` are disabled while nothing is unsaved (the mockup draws both always on); a JSON field holding text that is not JSON disables Save and says so (as built, it also counts as an unsaved change); what was typed while a save was out is kept, and only an entry still as it was sent is taken as saved; the page reads the settings once when opened, and again after a save or a refusal as `changed`; it is not polled. Leaving the page drops the draft with no question. Cost: an unsaved draft is lost to a reload.
26. **`*` (O-UI-6):** `baseBranches` holding `*` reviews every branch, like the empty list; `*` beside names reads as every branch too (git refuses `*` in a branch name, so no branch is shadowed). The screen shows an empty list as one `*` chip that cannot be removed. **The gate's `branches` are unchanged** (O-UI-5): a `*` there is read as it is today, a literal name that gates nothing, and no file that starts today is refused. The screen says so beside them: the `Gated branches` row's help ends ` A * here is not every branch: it is read as a branch of that name.` (Task 9). Cost: a gate written with `*` still gates nothing, said only on the screen.
27. **Logs:** `{ event: 'settings', from_file, from_ui }` at each start (the values the file changed at this start, and the settings whose value came from the UI); `{ event: 'settings_save', outcome, changes }` per save that reached the work (`saved`, `changed` or `invalid`; `changes` the values changed, or the changes asked); `ui_failed` with the routes' names `settings`, `settings_save`, `settings_changes`, `settings_export` (as built: a save that fails after the version check, on the database or as `bad_change`, writes no `settings_save` line; the route's `ui_failed` is its only line). Never a value, a name or a login. Cost: who changed what is read from the record, not the log.
28. **The source line of each row (4.3)** (as built: a setting the draft takes back reads `Not written`; one unset in the defaults reads `The default`, and `newHead` there `Not set: incremental, and full where the merge gate holds pushes`): `From config.yml at the start of <time>`, `Changed in the UI by <name>, <time>` (times as `utc()` writes them), `The default` for a global or defaults setting not written; in a repository's pane `From the defaults`, or, when overridden, `Overrides <the defaults' value>` with its source and `Use the default`. Cost: none known.
29. **The run under Docker** (Task 11) adds to the plans before: two starts across a change of the file, a clash, a restart for a start-time setting, two saves at once on Postgres, and one review through the stubs after a save. Cost: what GitHub itself answers stays unverified, as before.

## For the owner

1. **Cannot be undone:** the previous release refuses to start on a database this release has migrated.
2. **What the first start does:** it copies every setting `config.yml` writes into the database, recorded as made by `config.yml`. From then on the UI's changes survive restarts, and a setting you change in the file wins at the next start (UI design 4.3). The evals read the file only (call 21): copy the export into the file to keep it in step.
3. **A clash stops the service** until the file is fixed (call 14): the start prints each issue and which settings came from the UI.
4. **Rulings you may want to change** (each a small change): calls 9 (effort as a select), 10 (the rows and cards not drawn), 11 (Access's wording; Settings opens on General), 13 (the builder's: with the UI off, each start copies the file whole, dropping what the UI saved), 15 (two checks per save), 16 (the version), 19 (the start-time list, the scorer's being on included), 25 (Save and Discard disabled while nothing is unsaved), 5 (the switch's colours).
5. **Not settled, and yours to weigh:** a credential written in plain text in `model.extraHeaders` or `model.extraBody` is shown to admins, stored, recorded and exported; **(as built, settled by the owner after the final review)** `model.baseUrl` and `scorer.baseUrl` are file-only, so no admin can send the API keys elsewhere, and a credential written in an address is shown to admins read only and in the export, not stored or recorded; viewers never see Settings (call 17); a gate switched on from the UI waits for each pull request's next event, and its sweep, the bypass alert and the permission check for the next start; automatic approval switched on from the UI is checked for Administration read at the next start (call 19).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **The service:** Node 26 or later, npm, no build step, erasable TypeScript only, `import type` for types, relative imports ending in `.ts`, no new library in either `package.json`.
- **The frontend:** classes from the tokens of `ui/src/index.css` and sizes only (call 5). The token check, `LC_ALL=C grep -rnE '\[#[0-9A-Fa-f]{3,8}\]|(bg|text|border|ring|accent|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]' ui/src --include='*.tsx' --exclude='*.test.tsx'`, prints nothing after each frontend task (it prints nothing on `dev` today).
- **ASCII only** in `src`, `contract`, `test`, `examples`, `ui/src`, `ui/index.html`, `ui/public` and `ui/`'s config files: after each task `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test examples ui/src ui/index.html ui/public` prints nothing. The remove button of a chip reads `x`, as drawn.
- **No test reaches the network, a real database or a model.** A database is `testDb()` (migrated) or `pgliteDb()`; a clock is passed in; every wait has a bound. The frontend's tests stub the API object; `fetch` is blocked.
- **Secrets:** no answer, export, record row, log line or error holds a secret's value; the editable part holds none (call 6). The settings code is given the environment only inside `check` (`main.ts`), never stored.
- **One validation:** nothing but `parseDocument` decides whether settings are good; no rule of the schema or of its checks across fields is written again in `src/shell`, `src/ui` or `ui/`.
- **The UI off changes nothing but these:** the migration; the sync at each start, which then copies the file's editable part whole (call 13), so the service runs on the file's settings; `*` in the base filter (call 26); `/`, `/ui/` and `/api/` answer 404 as today.
- **Boundaries, by the lint as it is:** `src/config/editable.ts` imports only `./load.ts`, `./schema.ts`'s types and `yaml`; `src/shell/settings.ts` imports `src/config`, `src/db`; `src/ui/settings.ts` imports `src/config`, `src/db`, `src/shell`; `src/main.ts` imports `./db/migrate.ts` and `./shell/settings.ts`; `src/engine/**` imports nothing new.
- **SQL:** plain SQL in the schema `visto_ai`; a time as an ISO string with `::timestamptz`; a value as `storableJson(...)` with `::jsonb`; a name through `storable()`. No statement text of this plan names `visto_ai.pull_requests` (but the existing `knownRepositories`, called from an API request) or the word `gate` (a path such as `gate.enabled` is a parameter, never in a statement's text).
- **No existing test is edited, but for these,** each named in its task with the exact change: `src/db/migrate.test.ts`'s test of `0015_accounts`, whose `migrate(db, all)` becomes `migrate(db, all.filter((m) => m.name <= '0015_accounts'))`, as the accounts plan did for the test of `0014_ui` (Task 3); `src/service.test.ts`'s harness (`start` takes the settings; `engineDeps` records its second argument; Task 5); the seven frontend `fakeApi`s (`ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/accounts.test.tsx`, `ui/src/pages/activity.test.tsx`, `ui/src/pages/password.test.tsx`, `ui/src/pages/sign-in.test.tsx`, and the One review plan's `ui/src/pages/review.test.tsx`) gain the four calls, and `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` gains them in its `each` list (Task 7); `ui/src/pages/accounts.test.tsx`'s `the accounts are listed with how they sign in, their role, their last sign-in and who made them` expects the Settings page's sub-line (Task 8). Every new field of an existing type is optional. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test` in `src`, Vitest in `ui`. `at(seconds)` from `2026-03-01T10:00:00.000Z`; the admin `octo-admin`; repositories `acme/shop`, `acme/web`, `acme/tools`; `ui.publicUrl` `https://visto.example.test`; variables `OPENROUTER_API_KEY` = `model-key-for-tests-only`, `SCORER_API_KEY` = `scorer-key-for-tests-only`, `AUDIT_KEY` = `audit-key-for-tests-only-0123456789abcdef`, `WEBHOOK_SECRET` = `webhook-secret-for-tests-only`, `DATABASE_URL` = `postgres://visto:db-password-for-tests@db.example.test/visto`, `APP_PRIVATE_KEY` an RSA key made by the test (`generateKeyPairSync`). The settings tests define their own file with these (`load.test.ts`'s `SERVICE_YAML`, `ENV`, `example()` and `uncomment()` are not exported, and its model key `'k'` is too short to search rows for). Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A file and the database that pass apart and clash together** (3.4), and a file that changes the very setting the UI saved. Task 4 `settings saved in the UI that clash with the file refuse the start with each issue and the sentence, and nothing is copied` and `a setting changed in the file replaces what the UI saved, and one the file did not change keeps it`.
2. **Two saves at once, or a save from a page read before another save or a restart.** Task 4 `a save from an older version is refused as changed, and of two saves at once one is saved`; Task 8 `a save that met another keeps the changes and reads the settings again`.
3. **A body that is not of its shape:** an unknown path, a scope of another shape, two changes of one key, a NUL inside a value, too many changes, a version that is not a number. Task 6 `a save whose body is not of its shape is bad_request and stores nothing`.
4. **A secret where it must not be:** an answer, the export, the record, a log line, an error. Task 2 `the export holds the references the file writes and no secret`; Task 4 `no row, log line or error holds a secret's value`; Task 6 `no answer holds a secret's value or a field the screen does not show`.
5. **A start-time setting saved and read before the restart:** dry run switched off while the service still runs in dry run; the scorer switched off. Task 5 `a start-time setting saved waits for the next start: the review stays dry and the concurrency and the model's time limit stay`; Task 6 `a start-time setting saved waits for the restart, and the scorer's being on too`.
6. **A review running across a save.** Task 5 `a review reads the settings in force when it starts, and keeps them to its end`.
7. **Override keys of another case or shape, and a file value the database would change.** Task 2 `an override key is lower-cased, and one that names no repository is dropped`; Task 4 `a file value holding a NUL is stored as the database keeps it and is not seen as changed at the next start`.
8. **A field typed wrong in the page:** text in a number, JSON that is not JSON, an empty price. Task 8 `the model's rows read and write their values`.
9. **`*` beside branch names, and `*` in the gate's branches.** Task 1 `a base filter holding * reviews every branch, beside names too` and `the gate's branches read * as they do today`; Task 9 `the merge gate's rows show while it is on, with what each mode does`.
10. **The UI turned off after an admin saved settings.** Task 4 `while the UI is off, a start copies the file whole, and what the UI saved goes, recorded as made by config.yml`.
11. **A step after the instance lock that fails:** the migration, the sync (a clash among them) or the engine's base. Task 5 `each step after the lock that fails releases the lock and closes the database once, and nothing after it runs` and `a start refused for its config writes each issue as a config line, then start_failed, and ends 1`.

---

### Task 1: One validation with named issues, and `*` in the base filter

**Files:**
- Modify: `src/config/load.ts`, `src/shell/triggers.ts`
- Test: `src/config/load.test.ts`, `src/shell/triggers.test.ts` (new tests only)

**Interfaces:**

```ts
// src/config/load.ts
/** One issue, with its place as keys ([] for one of the whole file) and its text after the place. */
export interface ConfigIssue { path: Array<string | number>; message: string }
export class ConfigError extends Error {
  issues: string[];        // exactly as today
  details: ConfigIssue[];  // one per issue, in the same order; absent from the constructor: each issue with path [] and its whole text
  constructor(issues: string[], details?: ConfigIssue[]);
}
/** The YAML of a config file, read; throws the ConfigError parseConfig throws today for YAML it cannot read. */
export function readYaml(text: string): unknown;
/** Every check of parseConfig on a document already read; never changes it. */
export function parseDocument(document: unknown, env: Record<string, string | undefined>): DeploymentConfig;
// parseConfig(text, env) becomes parseDocument(readYaml(text), env); loadConfig is unchanged.
```

**Rules (UI design 4.2, O-UI-6; calls 15, 26):**

1. **The details.** A schema issue's path is zod's `i.path` (a symbol as `String(...)`), its message `i.message` with the unknown keys' suffix as today. Each issue written by hand carries the path of its key: the gate's `['repositories', 'defaults' | 'overrides', <name as written>?, 'gate', 'branches']`, the audit key's `['auditKey']`, the sign-in issues' `['ui', 'publicUrl']`, `['app', 'clientId']`, `['app', 'clientSecret']`, each variable not set `[...its key]` (`['model', 'apiKey']`, `['extensions', i, 'options', ...]`, `['mcpServers', i, 'headers', name]`), the scorer's threshold `['repositories', 'defaults', 'score', 'threshold']`, two overrides of one repository `['repositories', 'overrides']`, a YAML error `[]`. `issues` is unchanged, character for character.
2. **`parseDocument`** holds everything `parseConfig` did after `parse(yamlText)`, the document given in place of `doc` (`?? {}` as today).
3. **`skipReason`:** `base_filtered` only when `baseBranches` is not empty, does not hold `*`, and does not hold the base branch.
4. **The gate's branches are not touched** (call 26): `src/config/schema.ts` is unchanged.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/config/load.test.ts
test('a document read is checked as its text is, and the check does not change it', () => {
  /* for example() with exampleEnv, and SERVICE_YAML: parseDocument(readYaml(t), env) deepEquals parseConfig(t, env);
     the document deepEquals a structuredClone taken before; readYaml('a: [') throws ConfigError with issues ['not valid YAML at line 1, column 5 (...)'] and details [{ path: [], message: <that issue> }] */
});
test('each issue carries its place as keys and its text after the place, in the order of the issues', () => {
  /* limits.queueConcurrency 0: details[0] { path: ['limits', 'queueConcurrency'], message: issues[0] after 'limits.queueConcurrency: ' };
     an override 'acme/shop.js' with the gate enabled and no branch: { path: ['repositories', 'overrides', 'acme/shop.js', 'gate', 'branches'], message: 'must name at least one branch when the gate is enabled' };
     autoApprove with auditShare 5 and no auditKey: { path: ['auditKey'], ... }; a scorer with no threshold written: ['repositories', 'defaults', 'score', 'threshold'];
     model.apiKey's variable unset: ['model', 'apiKey']; an unknown key at the root: { path: [], message: 'Unrecognized key: "x" (x)' } (as zod words it);
     issues.length === details.length in each; new ConfigError(['a: b']).details deepEquals [{ path: [], message: 'a: b' }] */
});
test("the gate's branches read * as they do today", () => {
  /* defaults gate { enabled: true, branches: ['main', '*'] }: parses, and the loaded defaults' gate.branches is ['main', '*'], as on dev */
});
// src/shell/triggers.test.ts
test('a base filter holding * reviews every branch, beside names too', () => {
  /* baseBranches ['*']: skipReason null for base 'feature'; ['main', '*']: null for 'feature'; ['main']: 'base_filtered' for 'feature', null for 'main'; []: null */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/config/load.test.ts src/shell/triggers.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the config checked as a document, each issue with its place, and * in the base filter`.

---

### Task 2: The editable part

**Files:**
- Create: `src/config/editable.ts`, `src/config/editable.test.ts`

**Interfaces:**

```ts
// src/config/editable.ts
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };
export const GLOBAL = 'global';
export const DEFAULTS = 'defaults';
export const GLOBAL_PATHS: readonly string[];       // rule 1, in that order
export const REPOSITORY_PATHS: readonly string[];   // rule 1, in that order
/** Global paths read once when the service starts (call 19); whether the scorer is on is start-time too. */
export const AT_START: ReadonlySet<string>;
/** A repository's scope once lower-cased. */
export const REPOSITORY_SCOPE: RegExp;              // /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/
export function settingKey(scope: string, path: string): string;              // `${scope}:${path}`
export function keyParts(key: string): { scope: string; path: string };       // split at the first ':'
export function isSetting(scope: string, path: string): boolean;
/** Every setting written, keyed by settingKey. */
export type Editable = ReadonlyMap<string, SettingValue>;
export function editableOf(document: unknown): Editable;
/** A new document: `document`'s keys config.yml alone holds, with `editable` in place of its editable part (rule 3). */
export function withEditable(document: unknown, editable: Editable): unknown;
/** The part in force: `saved`'s, but each start-time setting and the scorer's being on as `atStart` has them (rule 4). */
export function inForceEditable(atStart: Editable, saved: Editable): Editable;
export function scorerOn(editable: Editable): boolean;          // some scorer.* key written
/** JSON with sorted keys; undefined (not written) is its own text. */
export function canonical(value: SettingValue | undefined): string;
export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean;
/** The setting an issue's path names; null when it names none. */
export function settingOfIssue(path: ReadonlyArray<string | number>): { scope: string; path: string } | null;
/** The path config.yml writes: `learning`, `repositories.defaults.score.threshold`, `repositories.overrides.acme/shop.gate.mode`. */
export function filePathOf(scope: string, path: string): string;
/** Every global and defaults setting, and each repository's of `repositories`, as `config` holds it, in the file's shape (rule 6). */
export function shownValues(config: DeploymentConfig, repositories: readonly string[]): Map<string, SettingValue>;
/** The export (call 24). */
export function exportText(document: unknown, editable: Editable, at: string): string;
export type SecretKind = 'model_key' | 'scorer_key' | 'app_private_key' | 'webhook_secret' | 'app_client_secret' | 'database' | 'audit_key' | 'alert_webhook' | 'extension' | 'mcp_header';
export interface SecretRef { kind: SecretKind; of: string | null; variable: string | null }
export function secretsOf(document: unknown): SecretRef[];
```

**Rules (UI design 4.1 to 4.5; calls 6 to 9, 12, 19, 24):**

1. **The lists**, exactly: `GLOBAL_PATHS` = `dryRun`, `learning`, `limits.spendPerDay`, `limits.queueConcurrency`, `limits.inputTokensPerCall`, `limits.batchesPerReview`, `model.baseUrl`, `model.model`, `model.fallbacks`, `model.effort.default`, `model.effort.elevated`, `model.toolChoice`, `model.timeoutSeconds`, `model.prices`, `model.extraBody`, `model.extraHeaders`, `scorer.model`, `scorer.timeoutSeconds` (as built, without the two `baseUrl` paths: 17 paths). `REPOSITORY_PATHS` = `primaryBranches`, `ignoredAuthors`, `baseBranches`, `newHead`, `score.threshold`, `score.inlineNotes`, `score.autoApprove`, `score.approvalThreads`, `score.auditShare`, `gate.enabled`, `gate.branches`, `gate.checkName`, `gate.mode`, `gate.clearByReply`, `gate.skipTeam`, `gate.requiredChecks`. `AT_START` = `dryRun`, `learning`, `limits.queueConcurrency`, `model.timeoutSeconds`, `model.toolChoice` (as built, without the two `baseUrl` paths: 5). `isSetting`: `global` with a global path, or `defaults` or a scope matching `REPOSITORY_SCOPE` with a repository path.
2. **`editableOf`:** for each path, the value where the document holds the key (own property, value not `undefined`; `null` is a value); global paths from the top level (`model.effort.default` is `doc.model.effort.default`); `defaults` from `repositories.defaults`; each key of `repositories.overrides`, lower-cased, kept when it matches `REPOSITORY_SCOPE` (call 7), from its entry.
3. **`withEditable`:** a deep copy of `document` with `dryRun`, `learning`, `limits` and `repositories` removed, `model` reduced to its `apiKey` (when written), and `scorer` removed; then each setting of `editable` set at its place, creating the objects on the way (`repositories.overrides.<scope>.<path>`); then, when some `scorer.*` is written and `document.scorer.apiKey` is written, that reference is set at `scorer.apiKey` (call 8). The keys of the result follow the order of the lists, overrides by name. `document` is never changed. **A scope is one key and is never split:** `editableOf` and `withEditable` walk a path by its segments after the scope (`keyParts` splits a key at its first `:`), so `acme/shop.js` stays one override.
4. **`inForceEditable`:** start from `saved`; replace each `AT_START` key by `atStart`'s (deleted when `atStart` does not write it); then, when `scorerOn(atStart)` is false, delete every `scorer.*` key; when it is true and `scorerOn(saved)` is false, set `scorer.model` and `scorer.timeoutSeconds` as `atStart` has them.
5. **`settingOfIssue`:** `['dryRun' | 'learning', ...]` names that global setting; `['limits' | 'model' | 'scorer', k, ...]` the global `<block>.<k>` when it is in the list, and `['model', 'effort', 'default' | 'elevated', ...]` that one; `['repositories', 'defaults', ...rest]` and `['repositories', 'overrides', name, ...rest]` (scope `name` lower-cased) the repository path `rest[0].rest[1]` when it is in the list, else `rest[0]` when it is; anything else null.
6. **`shownValues`:** for `global`, the loaded value under each path (`limits.*`, `model.*` as loaded, `dryRun`, `learning`; `scorer.*` the scorer's when it is on, else null). For `defaults` and each repository (`repoSettingsFor(config, name)` merged): `primaryBranches`, `ignoredAuthors`, `baseBranches`, `newHead` (null when not written), `score.threshold` (`scoreThreshold`), `score.inlineNotes`, `score.autoApprove` / `score.approvalThreads` / `score.auditShare` (`approvalOf(settings)`'s `enabled` / `threads` / `auditShare`), and each `gate.*`.
7. **`exportText`:** the text `# The settings saved in the UI on ${at}, as config.yml writes them.\n# Replace these keys of config.yml with them: a setting changed in the file wins at the next start.\n` followed by `stringify` (from `yaml`) of an object holding, of `withEditable(document, editable)`, its `dryRun`, `learning`, `limits`, `model`, `scorer` and `repositories`, each only when present.
8. **`secretsOf`:** in this order, one entry each for `model.apiKey` (`model_key`), `scorer.apiKey` (`scorer_key`), `app.privateKey`, `app.webhookSecret`, `app.clientSecret`, `database.url`, `auditKey`, `alerts.webhook`, each with its `env` as `variable` when the document writes it, else null, and `of` null; then one `extension` for each `{ env }` mapping inside an extension's `options` (`of` `<name>, option <dotted path>`), and one `mcp_header` for each header written as a reference (`of` `<server name>, header <Header>`), only those written.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/config/editable.test.ts: its own fixtures (load.test.ts exports none): `example()` reads config.example.yml with readFileSync and a local
// `uncomment(text, from)` of load.test.ts's five lines, written again here; `ENV` holds the Global Constraints' variables. Read with readYaml.
test('the editable part of a file is every setting it writes, by scope and path, and none it does not', () => {
  /* example(): global keys exactly those the example writes (dryRun, learning, the four limits, the model's but apiKey; no scorer.*);
     defaults: primaryBranches, ignoredAuthors, baseBranches; 'acme/shop:primaryBranches' ['trunk'], 'acme/shop:baseBranches' ['trunk'], 'acme/shop:score.threshold' 60;
     'global:model.prices' null (written as null); no key holds 'apiKey', 'app', 'database', 'ui' */
});
test('an override key is lower-cased, and one that names no repository is dropped', () => {
  /* overrides { 'Acme/Web': { newHead: full }, acme: { newHead: full }, ' acme/x': {...} }: only 'acme/web:newHead' */
});
test('a document with its editable part put back checks as the file does, and keeps every key config.yml alone holds', () => {
  /* parseDocument(withEditable(doc, editableOf(doc)), env) deepEquals parseDocument(doc, env); doc unchanged;
     with 'defaults:score.threshold' 55: the loaded defaults' scoreThreshold 55; app, database, ui, extensions as in doc;
     a doc with scorer { apiKey: { env: SCORER_API_KEY }, model: vendor/decision-model } and threshold written: no scorer.* in editable -> no scorer block;
     with 'global:scorer.model' set -> scorer { model, apiKey: { env: SCORER_API_KEY } }; model.apiKey kept whatever editable holds */
});
test('the settings in force keep the ones read at start until the next start, and follow the save in every other', () => {
  /* for each AT_START path p: saved with p changed -> inForce holds atStart's value (or none); for every other global path and every repository path: saved's;
     atStart without scorer, saved with scorer.model -> no scorer.* key; atStart with scorer.model 'a' and timeoutSeconds 60, saved without -> 'a' and 60;
     atStart with scorer, saved scorer.model 'b' -> 'b' */
});
test('values are the same when they hold the same JSON, keys in any order, and a value not written is only itself', () => {
  /* sameValue({ a: 1, b: [2] }, { b: [2], a: 1 }) true; sameValue(undefined, null) false; sameValue(undefined, undefined) true; sameValue(1, '1') false */
});
test("an issue's path names its setting, and an issue of config.yml alone names none", () => {
  /* ['model', 'fallbacks', 0] -> global model.fallbacks; ['model', 'effort', 'elevated', 'x'] -> global model.effort.elevated;
     ['repositories', 'overrides', 'Acme/Shop', 'gate', 'branches'] -> acme/shop gate.branches; ['repositories', 'defaults', 'score', 'threshold'] -> defaults score.threshold;
     ['repositories', 'defaults', 'newHead'] -> defaults newHead; ['scorer', 'apiKey'], ['auditKey'], ['limits'], [] -> null */
});
test('the values shown are the settings loaded, in the shape the file writes them', () => {
  /* the example: global limits.spendPerDay 50, model.prices null, scorer.model null; defaults score.threshold 70, score.autoApprove false,
     score.approvalThreads 'strict', score.auditShare 5, newHead null, gate.enabled false, gate.checkName 'AI Review';
     acme/shop: score.threshold 60, primaryBranches ['trunk'], ignoredAuthors ['dependabot[bot]'] (from the defaults) */
});
test('the export holds the references the file writes and no secret, and reads back as the same settings', () => {
  /* the example with an override 'acme/shop.js' { newHead: full, gate: { mode: shadow } } added: text starts with the two comment lines;
     editableOf(readYaml(text)) has the same keys and sameValue values as the editable given, 'acme/shop.js:newHead' and 'acme/shop.js:gate.mode' among them;
     holds 'OPENROUTER_API_KEY'; holds neither 'model-key-for-tests-only' nor 'app:' nor 'database:' nor 'ui:' nor 'auditKey' */
});
test('the secrets are the references config.yml writes, by variable name, and the ones it does not write have none', () => {
  /* the example with app, database, alerts and an extension option uncommented: kinds in rule 8's order; model_key OPENROUTER_API_KEY;
     scorer_key null; extension { of: 'example, option secret', variable: 'EXAMPLE_FEEDBACK_SECRET' }; mcp_header only when the server's header is a reference */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/config/editable.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the editable part of the config, by scope and path, put back, pinned at start, shown and exported`.

---

### Task 3: The store

**Files:**
- Create: `src/db/migrations/0016_settings.sql`, `src/db/settings.ts`, `src/db/settings.test.ts`
- Modify: `src/db/text.ts` (`storableValue`)
- Test: `src/db/migrate.test.ts` (one change, a new test), `src/db/text.test.ts` (a new test)

**Interfaces:**

```ts
// src/db/text.ts
/** `value` with every string in it, keys included, passed through storable(); storableJson is JSON.stringify(storableValue(value)). */
export function storableValue(value: unknown): unknown;
// src/db/settings.ts
export interface SettingRow { scope: string; path: string; value: unknown; set_by: 'config.yml' | 'ui'; set_by_name: string | null; set_at: Date }
export interface ChangeRow {
  id: number; at: Date; by: 'config.yml' | 'ui'; by_name: string | null; scope: string; path: string;
  before: string | null; after: string | null;   // the value's JSON text; null: not written
}
export function lockSettings(tx: Db): Promise<void>;
export function readSettings(db: Db): Promise<SettingRow[]>;
export function readFileSettings(db: Db): Promise<Array<{ scope: string; path: string; value: unknown }>>;
export function writeSetting(db: Db, s: { scope: string; path: string; value: unknown; by: 'config.yml' | 'ui'; name: string | null; at: string }): Promise<void>;
export function deleteSetting(db: Db, scope: string, path: string): Promise<boolean>;
export function replaceFileSettings(db: Db, rows: ReadonlyArray<{ scope: string; path: string; value: unknown }>): Promise<void>;
/** `before` / `after` undefined: not written. */
export function recordSettingChange(db: Db, c: { at: string; by: 'config.yml' | 'ui'; name: string | null; scope: string; path: string; before: unknown; after: unknown }): Promise<number>;
export function settingsVersion(db: Db): Promise<number>;
export function readSettingChanges(db: Db, before: number | null, limit: number): Promise<ChangeRow[]>;
```

**Rules (UI design 4.3, 4.4; calls 13, 16, 17):**

1. **The migration**, exactly:

```sql
create table visto_ai.settings (
  scope text not null,
  path text not null,
  value jsonb not null,
  set_by text not null check (set_by in ('config.yml', 'ui')),
  set_by_name text,
  set_at timestamptz not null,
  primary key (scope, path),
  check ((set_by = 'ui') = (set_by_name is not null))
);
create table visto_ai.settings_file (
  scope text not null,
  path text not null,
  value jsonb not null,
  primary key (scope, path)
);
create table visto_ai.setting_changes (
  id integer generated always as identity primary key,
  at timestamptz not null,
  by text not null check (by in ('config.yml', 'ui')),
  by_name text,
  scope text not null,
  path text not null,
  old_value jsonb,
  new_value jsonb,
  check ((by = 'ui') = (by_name is not null)),
  check (old_value is not null or new_value is not null)
);
```

   (No index on `at`: the record is paged by `id`.)

2. **The statements**, exactly; a value goes in as `storableJson(value)`, a scope, a path and a name through `storable()`:

```sql
-- lockSettings
lock table visto_ai.settings in share row exclusive mode;
-- readSettings
select scope, path, value, set_by, set_by_name, set_at from visto_ai.settings order by scope, path;
-- readFileSettings
select scope, path, value from visto_ai.settings_file order by scope, path;
-- writeSetting
insert into visto_ai.settings (scope, path, value, set_by, set_by_name, set_at) values ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)
on conflict (scope, path) do update set value = excluded.value, set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = excluded.set_at;
-- deleteSetting
delete from visto_ai.settings where scope = $1 and path = $2 returning scope;
-- replaceFileSettings: the delete, then one insert for each row
delete from visto_ai.settings_file;
insert into visto_ai.settings_file (scope, path, value) values ($1, $2, $3::jsonb);
-- recordSettingChange ($6, $7: storableJson of the value, or null when undefined)
insert into visto_ai.setting_changes (at, by, by_name, scope, path, old_value, new_value)
values ($1::timestamptz, $2, $3, $4, $5, $6::jsonb, $7::jsonb) returning id;
-- settingsVersion
select coalesce(max(id), 0)::int as version from visto_ai.setting_changes;
-- readSettingChanges ($1: the id to page from, or null; $2: the limit)
select id, at, by, by_name, scope, path, old_value::text as before, new_value::text as after
from visto_ai.setting_changes where ($1::integer is null or id < $1::integer) order by id desc limit $2;
```

- [ ] **Step 1: Write the failing tests and the one change.** In `src/db/migrate.test.ts`, the test of `0015_accounts` (it asserts `await migrate(db, all)` is `['0015_accounts']`) becomes `migrate(db, all.filter((m) => m.name <= '0015_accounts'))`, as the accounts plan made the test of `0014_ui` filter `<= '0014_ui'`; nothing else of it changes.

```ts
// src/db/migrate.test.ts
test('0016_settings follows 0015_accounts and makes the three tables of settings, empty', async () => { /* ledger order; the three tables exist with 0 rows */ });
// src/db/text.test.ts
test('a value is stored with every string cleaned, keys included', () => { /* storableValue({ ['a' + NUL]: ['b' + NUL, 1, null] }) deepEquals { a: ['b', 1, null] } */ });
// src/db/settings.test.ts
test('a setting is written with its source, replaced, read back with its JSON as it was, and deleted', async () => {
  /* write global model.prices null by config.yml at at(0): read value null, set_by 'config.yml', set_by_name null; write { a: [1, 'x'] } by ui 'octo-admin' at at(5): replaced;
     deleteSetting true, then false; a ui write with no name rejects (the check) */
});
test("the file's part is replaced whole", async () => { /* replace [a, b], then [b, c]: rows b and c only */ });
test('a change is recorded with its values as JSON text, not written as null, and paged newest first', async () => {
  /* record before undefined after 70: before null, after '70'; before null after undefined: before 'null', after null; both undefined rejects;
     60 rows: readSettingChanges(null, 51) 51 newest first; readSettingChanges(<id of the 51st>, 51) the 9 older; settingsVersion the newest id; on an empty table 0 */
});
test('the lock is the first statement of the transaction that takes it', async () => { /* a spy: in db.transaction, lockSettings then readSettings: the texts in that order */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/migrate.test.ts src/db/text.test.ts src/db/settings.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the store of settings: the database's part, the file's at the last start, and the record of changes`.

---

### Task 4: The sync at each start, and the save

**Files:**
- Create: `src/shell/settings.ts`, `src/shell/settings.test.ts`

**Interfaces:**

```ts
// src/shell/settings.ts
export interface AskedChange { scope: string; path: string; value?: SettingValue }   // no value: not written ("use the default")
export interface SettingIssue { scope: string | null; path: string | null; message: string }
export type SaveOutcome =
  | { kind: 'saved'; changed: number; restart: boolean }
  | { kind: 'changed' }
  | { kind: 'invalid'; issues: SettingIssue[] };
export interface Settings {
  /** The file's document as read at this start. */
  readonly file: unknown;
  /** The editable part this start left in the database. */
  readonly startEditable: Editable;
  /** The file's own part with startEditable: what the service started on. */
  readonly atStart: ServiceConfig;
  /** What the service runs on now (call 19). */
  inForce(): ServiceConfig;
  /** As last saved: what the next start runs on, the file unchanged. */
  saved(): { editable: Editable; config: ServiceConfig };
  save(version: number, changes: readonly AskedChange[], by: string): Promise<SaveOutcome>;
}
export const CLASH_NAMED = 10;
export function issuesOf(error: ConfigError): SettingIssue[];
export function startSettings(deps: {
  db: Db; file: unknown; check: (document: unknown) => ServiceConfig; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  /** Whether the file turns the UI on (it writes `ui.publicUrl`); false: the start copies the file whole (call 13). */
  uiOn: boolean;
}): Promise<Settings>;
```

**Rules (UI design 3.4, 4.2 to 4.5; calls 13 to 17, 22, 27):**

1. **`issuesOf`:** each of `error.details`, by `settingOfIssue(path)`: a setting gives `{ scope, path, message }`; none gives `{ scope: null, path: null, message: <the issue's whole line, error.issues[i]> }`.
2. **The sync**, in one `db.transaction` whose first statement is `lockSettings`: `now` = `editableOf(file)` with each value through `storableValue`; `last` = `readFileSettings`; `stored` = `readSettings`. For each key of `last` or `now`, in sorted order, where `sameValue(last, now)` is false: when `now` holds it, `writeSetting` by `config.yml`, name null, at the clock; else `deleteSetting`; and when `sameValue(stored, now)` is false, `recordSettingChange` by `config.yml` with `before` the stored value (undefined when none) and `after` `now`'s. **With `uiOn` false** the keys walked are those of `stored` or `now`, and a key is written (or deleted) when its stored value is not `sameValue` with `now`'s or its source is `ui`, recorded when the value differs: the database's part becomes the file's whole, every source `config.yml`. Then `replaceFileSettings(now)`. Then the database's part (read again) is put back: `check(withEditable(file, part))`. A `ConfigError` there rolls the transaction back and rejects with a `ConfigError` of its issues followed, when some setting of `part` has the source `ui`, by call 14's sentence, naming those (as `filePathOf`), sorted, joined with `, `, at most `CLASH_NAMED`, then `, and <n> more` when there are more; with none, the issues alone. Any other failure rolls back and rejects as it is.
3. **Started:** `atStart` = that check's config, `startEditable` = the part; in force and saved are those too. One log line `{ event: 'settings', from_file: <changes recorded>, from_ui: <settings whose source is ui> }`.
4. **`save`**, in one transaction whose first statement is `lockSettings`: `settingsVersion` not equal to `version` answers `{ kind: 'changed' }`. Else the stored part with `changes` applied (a value set, no value deleted) is `next`; a change for a key `isSetting` refuses rejects `Error('bad_change')` (the route never sends one). `check(withEditable(file, next))`, then `check(withEditable(file, inForceEditable(startEditable, next)))`: a `ConfigError` from either answers `{ kind: 'invalid', issues: issuesOf(error) }` with nothing written. Then for each change whose value is not `sameValue` with the stored one: `writeSetting` by `ui` with `by` as the name (or `deleteSetting`), and `recordSettingChange`. After the commit, saved and in force become the two checks' configs, but only when the save's new version (the id of its last record row) is above the one they reflect, so two saves the lock puts in a row never leave the older one in memory; the started settings reflect the start's version. `restart`: some change written is `global` with a path in `AT_START`, or `scorerOn` of the saved part differs from `startEditable`'s.
5. **Logs:** one `settings_save` line per call that reached the version check (call 27). No line, error or row holds a secret's value or a name, but the record's `by_name` and the setting's `set_by_name`.

- [ ] **Step 1: Write the failing tests.** On `testDb()`, with fixtures of the file's own (Global Constraints): `FILE_YAML` writes `model` (`apiKey: { env: OPENROUTER_API_KEY }`, `model: vendor/model-a`), `app` (`id: 12345`, `privateKey: { env: APP_PRIVATE_KEY }`, `webhookSecret: { env: WEBHOOK_SECRET }`), `database` (`url: { env: DATABASE_URL }`), `auditKey: { env: AUDIT_KEY }`, `ui: { publicUrl: https://visto.example.test }` and `limits: { spendPerDay: 50 }`, read by `readYaml`; `check = (d) => serviceConfig(parseDocument(d, ENV))`; `uiOn: true` but where a test says otherwise.

```ts
// src/shell/settings.test.ts
test('the first start copies every setting the file writes, recorded as made by config.yml, and none it does not write', async () => {
  /* rows equal editableOf(file); each set_by 'config.yml'; one change row each, before null; settings_file equal; log { event: 'settings', from_file: n, from_ui: 0 };
     atStart deepEquals check(file) */
});
test('a second start with the file unchanged changes and records nothing', async () => { /* rows, record and version as after the first */ });
test('a setting changed in the file replaces what the UI saved, and one the file did not change keeps it', async () => {
  /* save limits.spendPerDay 40 and score.threshold 55 by octo-admin; restart with the file's spendPerDay 30 (threshold not changed in the file):
     spendPerDay 30 set_by 'config.yml' recorded before '40' after '30'; threshold 55 still 'ui'; from_ui 1 */
});
test('a setting removed from the file goes back to its default, and one the file writes as the UI saved it records nothing', async () => {
  /* file writes learning: true, then not: its row deleted, recorded after null; UI saves dryRun false, then the file writes dryRun: false: no change row, set_by 'config.yml' */
});
test('settings saved in the UI that clash with the file refuse the start with each issue and the sentence, and nothing is copied', async () => {
  /* file with auditKey; UI saves score.autoApprove true (auditShare 5 by default); restart with auditKey removed and spendPerDay changed:
     rejects ConfigError: issues[0] 'auditKey: must be written while autoApprove is true with an auditShare above 0', last issue
     'Saved in the UI: repositories.defaults.score.autoApprove; with them config.yml does not pass. Changing them in config.yml (another value, or removed) settles it: a setting changed in the file wins at the next start.';
     spendPerDay row as before, settings_file as before, version as before; 12 UI settings: the sentence names 10, then ', and 2 more';
     a merged part that fails with no setting from the UI: the issues alone, no sentence */
});
test('while the UI is off, a start copies the file whole, and what the UI saved goes, recorded as made by config.yml', async () => {
  /* UI saves score.threshold 55 and limits.spendPerDay 40; restart with uiOn false and the file unchanged: threshold's row deleted (FILE_YAML writes none), recorded before '55' after null;
     spendPerDay 50 set_by 'config.yml', recorded before '40' after '50'; every row's set_by 'config.yml'; atStart's defaults scoreThreshold 70; from_ui 0 */
});
test('a file value holding a NUL is stored as the database keeps it and is not seen as changed at the next start', async () => {
  /* model.model written "vendor/a\0": stored 'vendor/a'; a second start records nothing */
});
test('a save is checked whole, refused with each issue at its setting, and stores nothing then', async () => {
  /* defaults gate.enabled true with no branch: { kind: 'invalid', issues: [{ scope: 'defaults', path: 'gate.branches', message: 'must name at least one branch when the gate is enabled' }] };
     limits.queueConcurrency 0: at global limits.queueConcurrency; scorer.model with a file that writes no scorer.apiKey: { scope: null, path: null, message: 'scorer.apiKey: ...' };
     rows, record and version unchanged after each */
});
test('a save records each value it changes, by the name given, and one that changes nothing records nothing', async () => {
  /* [defaults score.threshold 55, limits.spendPerDay as stored]: { kind: 'saved', changed: 1, restart: false }; one record row by 'ui' 'octo-admin', before null (FILE_YAML writes no threshold), after '55';
     the same save again: { kind: 'saved', changed: 0, restart: false }, no row, the version unchanged;
     an override acme/shop newHead full, then unset: row deleted, recorded after null; saved().config's acme/shop newHead null */
});
test('a save from an older version is refused as changed, and of two saves at once one is saved', async () => {
  /* save at version v -> saved; another at v -> { kind: 'changed' }; Promise.all of two saves at the same version: one saved, one changed;
     inForce() and saved() hold the one saved */
});
test('the settings in force keep what is read at start until the next start; the rest follow the save', async () => {
  /* save dryRun false, limits.queueConcurrency 5, model.toolChoice auto, score.threshold 55, limits.inputTokensPerCall 50000:
     inForce() dryRun true, queueConcurrency 2, toolChoice forced, defaults scoreThreshold 55, inputTokensPerCall 50000; saved().config dryRun false; restart true */
});
test("no row, log line or error holds a secret's value", async () => {
  /* 'model-key-for-tests-only', 'audit-key-for-tests-only-0123456789abcdef', 'webhook-secret-for-tests-only', 'db-password-for-tests' and the app key's PEM body
     appear in no settings, settings_file or setting_changes row, no log line, no issue */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/shell/settings.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the settings synced with config.yml at each start, and a save checked whole and recorded`.

---

### Task 5: The service runs on the settings in force

**Files:**
- Modify: `src/service.ts`, `src/main.ts`, `src/shell/spend.ts`
- Test: `src/service.test.ts` (the harness change, new tests), `src/main.test.ts`, `src/shell/spend.test.ts` (new tests only)

**Interfaces:**

```ts
// src/service.ts, ServiceDeps:
  /** Absent: the settings are `config`, which never changes. Given: `config` is `settings.atStart`. */
  settings?: Settings;
  /** The engine's dependencies for one review, from the settings it runs on (the service always gives them). */
  engineDeps: (source: Source, settings?: ServiceConfig) => ReviewDeps;
// src/shell/spend.ts
export function createSpendGuard(deps: { db: Db; limit: number | (() => number); clock: () => Date; alert: Alert }): ...;   // a function is read at each look
// src/main.ts
/** The model client and, with a scorer, the scorer of `config`; made for each review. */
export function clientsFor(config: DeploymentConfig, io: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }): { model: ModelClient; scorer?: Scorer };
/**
 * The steps after the instance lock, in this order: the migrations, the settings of this start, then the engine's base from them.
 * A step that rejects or throws releases the lock and closes the database, each once and each failure of those swallowed, and its
 * error is passed on; no step after it runs.
 */
export async function afterLock<B>(lock: InstanceLock, db: { close(): Promise<void> }, steps: {
  migrate: () => Promise<unknown>; settings: () => Promise<Settings>; base: (settings: Settings) => B;
}): Promise<{ settings: Settings; base: B }>;
/** A start that failed: each issue of a ConfigError as `config: <issue>`, then `start_failed`; any other error `start_failed` alone. */
export function startFailed(error: unknown, out: (line: string) => void): void;
```

**Rules (UI design 4.5; calls 13, 14, 19, 20):**

1. **The service.** `const inForce = deps.settings === undefined ? () => config : () => deps.settings.inForce()`. `settingsFor = (name) => repoSettingsFor(inForce(), name)` (events, the gate's and the withdrawal's jobs, the sweeps). The spend guard's limit is `() => inForce().limits.spendPerDay`. The review runner runs `runReviewJob(job, reviewDepsAt(inForce()))`, where `reviewDepsAt(c)` is `reviewDeps` with `settingsFor` bound to `c`, `limits` `{ inputTokensPerCall: c.limits.inputTokensPerCall, batchesPerReview: c.limits.batchesPerReview, modelTimeoutSeconds: c.model.timeoutSeconds }` and `engineDeps: (source) => deps.engineDeps(source, c)`. Everything else keeps reading `config`.
2. **`main.ts`.** The file is read with `readYaml` and checked with `parseDocument` (the usage and `config:` lines as today). After `lockThenLoad`: `afterLock(lock, db, { migrate: () => migrate(db, loadMigrations(MIGRATIONS_DIR)), settings: () => startSettings({ db, file, check: (d) => serviceConfig(parseDocument(d, env)), clock, log, uiOn: config.ui !== undefined }), base: (settings) => engineBase(settings.atStart, ...) })` (the engine's base moved here from before the lock). The start's `catch` is `startFailed(error, out)` and rethrows, so `runUntilSignal` logs `start_failed` and resolves 1, as today. `startService(settings.atStart, { ..., settings, engineDeps: (source, c) => ({ source, ...engine, ...clientsFor(c ?? settings.atStart, { fetch, sleep }) }), model: { complete: (request) => clientsFor(settings.inForce(), { fetch, sleep }).model.complete(request) } })`.
3. **`clientsFor`:** `{ model: createModelClient(config.model, io) }`, with `scorer: createJevScorer(config.scorer, io)` when `config.scorer` is not null.

- [ ] **Step 1: Write the failing tests and the harness change.**

`src/service.test.ts`, two changes to the harness and nothing else: `start` takes an optional `settings?: Settings`; given, the service is started on `settings.atStart` with `settings` in its deps, and no option that builds the config is read (`dryRun`, `toolChoice`, `learning`, `gate`, `repositoriesYaml`, `queueConcurrency`, `uiYaml`: the YAML given to `settingsOf` builds it; `ui` and the others are read as today); and `engineDeps` becomes `(source, given) => { engineSettings.push(given); return ({ source }) as ReviewDeps; }`, with `engineSettings: unknown[]` returned beside `reviewDeps`. A helper `settingsOf(h, yaml?, env?)` migrates `h`'s database and returns `startSettings` of `BASE_YAML` (or `yaml`), `check` with `ENV` (or `env`), `uiOn` whether that YAML writes `ui`.

```ts
// src/service.test.ts
test('a review reads the settings in force when it starts, and keeps them to its end', async () => {
  /* holdReview; settings; opened #7: inputs[0].repoConfig.scoreThreshold 70; while it is held, save defaults score.threshold 55 and limits.inputTokensPerCall 50000;
     released: engineSettings[0]'s defaults scoreThreshold 70; opened #8: inputs[1] scoreThreshold 55, limits.inputTokensPerCall 50000; engineSettings[1] the new settings */
});
test('an event reads the repository settings saved before it', async () => {
  /* save defaults ignoredAuthors ['octo-dev']; a pull request by octo-dev opened: no review job (inputs empty after the runner's tick) */
});
test('a start-time setting saved waits for the next start: the review stays dry and the concurrency and the model\'s time limit stay', async () => {
  /* save dryRun false, model.timeoutSeconds 100, limits.queueConcurrency 5: the next review: no publishReview write, inputs[0].limits.modelTimeoutSeconds 240,
     engineSettings[0].dryRun true, engineSettings[0].limits.queueConcurrency 2 */
});
test('without settings the service runs on the config it was given, as before', async () => { /* engineSettings[0] is the config given */ });
// src/main.test.ts (fakes, as lockThenLoad's test: a lock and a database that record their release and close)
test('the steps after the lock run in order, and the settings and the base come back', async () => { /* order ['migrate', 'settings', 'base']; base given the settings; no release, no close */ });
test('each step after the lock that fails releases the lock and closes the database once, and nothing after it runs', async () => {
  /* migrate rejects: release 1, close 1, settings and base not called, rejects with that error; settings rejects a ConfigError: the same, base not called; base throws: the same;
     a release and a close that reject too: the step's error is the one passed on */
});
test('a start refused for its config writes each issue as a config line, then start_failed, and ends 1', async () => {
  /* startFailed(new ConfigError(['auditKey: must be ...', 'Saved in the UI: ...']), out): lines ['config: auditKey: must be ...', 'config: Saved in the UI: ...', 'start_failed'];
     another Error: ['start_failed']; runUntilSignal with a start rejecting that ConfigError resolves 1 and logs one start_failed */
});
test('the model client and the scorer of each review are made from the settings given, and no scorer when they name none', async () => {
  /* a fetch stub: clientsFor(c with model.baseUrl https://model.example.test/v1, model vendor/model-b).model.complete(...): url https://model.example.test/v1/chat/completions, body.model 'vendor/model-b';
     with scorer { baseUrl https://scorer.example.test, model vendor/decision-model }: scorer present, its request to https://scorer.example.test/decisions; without: no key 'scorer' */
});
// src/shell/spend.test.ts
test('a limit given as a function is read at each look', async () => { /* spent 40: limit () => 50 -> 'warn'; the function now 30 -> 'limit', alert spend_limit { spent: 40, limit: 30 } */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/service.test.ts src/main.test.ts src/shell/spend.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the service runs on the settings in force, each review on a snapshot of them`.

---

### Task 6: The settings routes

**Files:**
- Create: `src/ui/settings.ts`, `src/ui/settings.test.ts`
- Modify: `src/ui/api-types.ts`, `src/ui/route.ts`, `src/service.ts` (the route is given the settings); merged with the One review plan's additions (Notes)
- Test: `src/ui/route.test.ts`, `src/service.test.ts` (new tests only)

**Interfaces:**

```ts
// src/ui/api-types.ts, added (types only)
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };
export interface SettingSource { by: 'config.yml' | 'ui'; name: string | null; at: string }
export interface Setting { written: boolean; value: SettingValue; source: SettingSource | null; restart: boolean; waits: boolean }
export interface RepositorySettings { name: string; settings: Record<string, Setting> }
export type SecretKind = 'model_key' | 'scorer_key' | 'app_private_key' | 'webhook_secret' | 'app_client_secret' | 'database' | 'audit_key' | 'alert_webhook' | 'extension' | 'mcp_header';
export interface SecretState { kind: SecretKind; of: string | null; variable: string | null }
export interface SettingsView {
  now: string; version: number;
  global: Record<string, Setting>; defaults: Record<string, Setting>; repositories: RepositorySettings[];
  scorer: { on: boolean; waits: boolean };
  secrets: SecretState[];
  access: { publicUrl: string; github: boolean; accounts: string[]; team: string | null };
}
export interface SettingsSave { version: number; changes: Array<{ scope: string; path: string; value?: SettingValue }> }
export interface SettingIssue { scope: string | null; path: string | null; message: string }
export interface SettingsInvalid { error: 'invalid'; issues: SettingIssue[] }
export interface SettingChangeRow { id: number; at: string; by: 'config.yml' | 'ui'; name: string | null; scope: string; path: string; before: string | null; after: string | null }
export interface SettingChanges { changes: SettingChangeRow[]; next: number | null }
export interface SettingsExport { text: string }
// src/ui/settings.ts
export interface SettingsApiDeps {
  db: Db; clock: () => Date; settings: Settings; log: (entry: Record<string, unknown>) => void;
  access: SettingsView['access'];
}
export function settingsView(deps: SettingsApiDeps): Promise<SettingsView>;
export function saveOf(body: Record<string, unknown>): SettingsSave | null;
export function saveSettings(deps: SettingsApiDeps, by: string, save: SettingsSave): Promise<UiAnswer>;
export function settingChanges(deps: SettingsApiDeps, query: URLSearchParams): Promise<SettingChanges | 'bad_request'>;
export function settingsExport(deps: SettingsApiDeps): SettingsExport;
// src/ui/route.ts: createUiRoute's deps gain  settings?: SettingsApiDeps;
```

**Rules (UI design 3.2, 4, 5; calls 12, 15 to 18, 22 to 24, 27):**

1. **`settingsView`:** `version` = `settingsVersion` first, then `rows` = `readSettings` (the saved part is their values), so a save landing between the two reads gives the page an older version with newer rows, which its next save meets as a harmless 409 (call 16), never the reverse; names = the repository scopes of `rows` and `knownRepositories(db, 200)`, sorted, unique. Each setting of `global` (every global path), `defaults` and each name (every repository path): `written` when a row holds it, `value` the row's, else `shownValues(settings.saved().config, names)`'s; `source` `{ by, name, at }` of the row, else null; `restart` for a global path in `AT_START`; `waits` for those when `sameValue(startEditable.get(key), <the saved part>.get(key))` is false. `scorer` `{ on: scorerOn(saved part), waits: <differs from startEditable's> }`. `secrets` `secretsOf(settings.file)`; `access` as given. Built field by field; nothing else.
2. **`saveOf`:** exactly the keys `version` (a whole number 0 to 2147483647) and `changes` (an array of 1 to 500); each change exactly `scope`, `path` and optionally `value`, with `isSetting(scope, path)` (a repository scope already lower-case), no key twice, and no string in its value, keys included, holding U+0000 or a lone surrogate (call 18). Else null.
3. **`saveSettings`:** `settings.save(version, changes, by)`: saved answers 200 with a new `settingsView`; changed 409 `{ error: 'changed' }`; invalid 422 `{ error: 'invalid', issues }`.
4. **`settingChanges`:** `before` empty reads as absent, else `^\d{1,10}$` up to 2147483647 (else `'bad_request'`); 51 read (`readSettingChanges`), 50 answered, `next` the 50th's id when 51 came back; `before` and `after` cut to 200 characters with `...` added when longer.
5. **`settingsExport`:** `{ text: exportText(settings.file, settings.saved().editable, clock's ISO) }`.
6. **The route.** `METHODS` gains `['/api/settings', 'GET, PUT']`, `['/api/settings/changes', 'GET']`, `['/api/settings/export', 'GET']`; a method is allowed when it is one of the value split at `', '`, and every 405 carries the value as `allow`. With `deps.settings` absent the four answer 404 `not_found` before any read. `GET /api/settings` an admin read (`settings`); `PUT /api/settings` an admin change with a body (`withBody`, then `saveOf`: null is 400 `bad_request`; `settings_save`), `by` the session's `login`; `GET /api/settings/changes` an admin read (`settings_changes`, `'bad_request'` is 400); `GET /api/settings/export` an admin read (`settings_export`).
7. **The service** gives `createUiRoute` `settings: { db, clock, settings: deps.settings, log: say, access: { publicUrl, github: <GitHub sign-in on>, accounts, team } }` when both the UI and `deps.settings` are given.

**The answers, exactly in shape (values invented; every path of the lists is a key of `global`, `defaults` and each repository's `settings`):**

```json
{ "now": "2026-03-01T10:00:00.000Z", "version": 14,
  "global": {
    "dryRun": { "written": true, "value": true, "source": { "by": "config.yml", "name": null, "at": "2026-03-01T09:00:00.000Z" }, "restart": true, "waits": false },
    "limits.spendPerDay": { "written": true, "value": 40, "source": { "by": "ui", "name": "octo-admin", "at": "2026-03-01T09:30:00.000Z" }, "restart": false, "waits": false },
    "limits.queueConcurrency": { "written": false, "value": 2, "source": null, "restart": true, "waits": false } },
  "defaults": { "score.threshold": { "written": true, "value": 70, "source": { "by": "config.yml", "name": null, "at": "2026-03-01T09:00:00.000Z" }, "restart": false, "waits": false } },
  "repositories": [ { "name": "acme/shop", "settings": {
    "score.threshold": { "written": true, "value": 60, "source": { "by": "ui", "name": "octo-admin", "at": "2026-03-01T09:30:00.000Z" }, "restart": false, "waits": false },
    "gate.enabled": { "written": false, "value": false, "source": null, "restart": false, "waits": false } } } ],
  "scorer": { "on": false, "waits": false },
  "secrets": [ { "kind": "model_key", "of": null, "variable": "OPENROUTER_API_KEY" }, { "kind": "alert_webhook", "of": null, "variable": null } ],
  "access": { "publicUrl": "https://visto.example.test", "github": true, "accounts": ["octo-lead"], "team": null } }
```

```json
{ "version": 14, "changes": [ { "scope": "defaults", "path": "score.threshold", "value": 65 }, { "scope": "acme/shop", "path": "baseBranches" } ] }
```

```json
{ "error": "invalid", "issues": [
  { "scope": "acme/shop", "path": "gate.branches", "message": "must name at least one branch when the gate is enabled" },
  { "scope": null, "path": null, "message": "auditKey: must be written while autoApprove is true with an auditShare above 0" } ] }
```

```json
{ "changes": [ { "id": 14, "at": "2026-03-01T09:30:00.000Z", "by": "ui", "name": "octo-admin", "scope": "global", "path": "limits.spendPerDay", "before": "50", "after": "40" } ], "next": null }
```

```json
{ "text": "# The settings saved in the UI on 2026-03-01T10:00:00.000Z, as config.yml writes them.\n# Replace these keys of config.yml with them: a setting changed in the file wins at the next start.\ndryRun: true\n..." }
```

- [ ] **Step 1: Write the failing tests.**

```ts
// src/ui/settings.test.ts (testDb; startSettings of Task 4's FILE_YAML, its own copy, with the override acme/shop { score: { threshold: 60 } }; a pull request of acme/web saved)
test('the view holds every setting with its value, whether it is written and where it came from', async () => {
  /* global keys deepEqual GLOBAL_PATHS; defaults' and each repository's REPOSITORY_PATHS; repositories ['acme/shop', 'acme/web'] (an override and one seen);
     acme/web score.threshold { written: false, value: 70 }; acme/shop score.threshold { written: true, value: 60, source.by 'config.yml' }; version 14 after 14 changes */
});
test('a start-time setting saved waits for the restart, and the scorer\'s being on too', async () => {
  /* save dryRun false: global dryRun { restart: true, waits: true }; limits.spendPerDay { restart: false, waits: false };
     a file with a scorer, saved off: scorer { on: false, waits: true } */
});
test('the record is paged newest first, its values cut at 200 characters, and a malformed page is bad_request', async () => {
  /* 60 changes: 50 and next; the rest; a 300-character value: 203 characters ending '...'; before 'x': 'bad_request'; before '': as absent */
});
test("no answer holds a secret's value or a field the screen does not show", async () => {
  /* the keys of each answer exactly those of api-types.ts; JSON of the view, the record and the export holds none of the variables' values */
});
test('a save whose body is not of its shape is null, and one of its shape is read as it is', () => {
  /* saveOf: an unknown path, scope 'Acme/Shop', scope 'acme', two changes of one key, a value holding NUL in a string and in a key, 501 changes,
     version -1, 1.5 or '1', an extra key, changes [] -> null; { version: 0, changes: [{ scope: 'defaults', path: 'newHead' }] } -> itself */
});
// src/ui/route.test.ts (the harness given settings from startSettings on its database)
test('an admin reads the settings, saves a change, reads the record and the export', async () => {
  /* GET /api/settings 200; PUT with the token and JSON: 200 with the new view; GET /api/settings/changes 200 holding it; GET /api/settings/export 200 { text } */
});
test('a viewer is refused every settings route as forbidden, and a save without the token is csrf first', async () => { /* 403 forbidden x4; PUT without the token 403 csrf */ });
test('a save is refused with each issue at its setting, as changed when another came first, and as bad_request when its body is not of its shape; nothing is stored then', async () => {
  /* 422 { error: 'invalid', issues }; 409 { error: 'changed' }; 400 bad_request; text/plain 415 not_json; the record's length unchanged after each;
     one settings_save line for the 422 and one for the 409, none for the 400 and the 415, holding no name */
});
test('the settings route takes GET and PUT, and refuses another with both in allow', async () => { /* DELETE /api/settings: 405 allow 'GET, PUT'; POST /api/settings/export: 405 allow 'GET' */ });
test('without settings given, the four routes are not found and read nothing', async () => { /* the harness without settings: 404 not_found x4; no statement */ });
// src/service.test.ts
test('with the UI on and settings given, an admin saves a setting and the next review reads it', async () => {
  /* settingsOf(h, BASE_YAML + 'ui:\n  publicUrl: https://visto.example.test\n') (password sign-in alone needs no client id or secret) and the option ui: uiDeps().ui
     (uiYaml is not read with settings given); an admin password account; sign in; PUT score.threshold 55; opened #7: inputs[0].repoConfig.scoreThreshold 55 */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/settings.test.ts src/ui/route.test.ts src/service.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the settings routes: the view, the save, the record and the export, for admins`.

---

### Task 7: The client, the controls and the draft

**Files:**
- Create: `ui/src/components/ui/switch.tsx`, `ui/src/components/chips.tsx`, `ui/src/settings-draft.ts`; tests `ui/src/api.test.ts`, `ui/src/components/controls.test.tsx`, `ui/src/settings-draft.test.ts`
- Modify: `ui/src/api.ts`, `ui/src/api-types.ts`, `ui/src/components/segmented.tsx`, `ui/src/app.tsx` (the watched API's four calls); the seven `fakeApi`s and the `each` list of `ui/src/app.test.tsx`'s 401 test (Global Constraints); merged with the One review plan's additions (Notes)

**Interfaces:**

```ts
// ui/src/api.ts, Api gains:
  settings(): Promise<SettingsView>;
  /** 200 resolves saved with the new view; 422 holding issues resolves invalid; any other refusal rejects RequestFailed (409 'changed' among them). */
  saveSettings(csrf: string, save: SettingsSave): Promise<{ kind: 'saved'; view: SettingsView } | { kind: 'invalid'; issues: SettingIssue[] }>;
  settingChanges(before?: number): Promise<SettingChanges>;
  settingsExport(): Promise<SettingsExport>;
// ui/src/components/ui/switch.tsx
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; labelledBy?: string; label?: string; disabled?: boolean }): JSX.Element;
// ui/src/components/chips.tsx
export function Chips(props: { label: string; values: readonly string[]; onChange: (values: string[]) => void; addLabel?: string; empty?: string }): JSX.Element;
// ui/src/components/segmented.tsx: `value: T | null` (null: none pressed)
// ui/src/settings-draft.ts
export const GLOBAL = 'global';
export const DEFAULTS = 'defaults';
export interface Unset { readonly unset: true }
export const UNSET: Unset;
export type Draft = ReadonlyMap<string, SettingValue | Unset>;
export function keyOf(scope: string, path: string): string;
export interface Shown { written: boolean; value: SettingValue; edited: boolean; source: SettingSource | null; restart: boolean; waits: boolean }
export function shown(view: SettingsView, draft: Draft, scope: string, path: string): Shown;
export function withChange(draft: Draft, scope: string, path: string, value: SettingValue | Unset): Draft;
export function changesOf(view: SettingsView, draft: Draft): SettingsSave['changes'];
export function overridesOf(view: SettingsView, draft: Draft, name: string): number;
export function repositoryNames(view: SettingsView, draft: Draft, added: readonly string[]): string[];
export function numberOrText(text: string): SettingValue;
export type EffortChoice = 'none' | 'low' | 'medium' | 'high' | 'custom';
export function effortChoice(value: SettingValue): EffortChoice;
export function effortValue(choice: Exclude<EffortChoice, 'custom'>): SettingValue;
/** A value as a row says it: lists joined with ', ' (an empty baseBranches '*', another empty list 'none'), true 'On', false 'Off', null 'none', a map as JSON. */
export function valueText(path: string, value: SettingValue): string;
export const REPOSITORY_NAME: RegExp;   // /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/
```

**Rules (calls 2, 5, 25, 26):**

1. **The client.** `settings` reads `/api/settings`; `saveSettings` sends `PUT /api/settings` with the token header and the body as JSON, reads a 422 whose body is `{ error: 'invalid', issues: [...] }` as invalid (another 422 rejects `RequestFailed(422, <code>)`); `settingChanges(before)` reads `/api/settings/changes`, with `?before=<n>` when given; `settingsExport` reads `/api/settings/export`. The watched API of `app.tsx` passes each through `watch`. **`send` today takes only `GET` and `POST` and a flat body, and reads a refusal's body in `codeOf`:** it gains `'PUT'`, and its body becomes any JSON value (`unknown`, sent as `JSON.stringify`); `saveSettings` makes its request with `call` as `send` does but reads the answer itself, so a 422's body is read once, for its `issues`, before any code is read (another refusal goes through `codeOf` as today; an ok answer through `answerOf`).
2. **`shown`:** the draft's value when it holds the key (`UNSET`: not written), else the view's setting; a repository key not written shows `shown(view, draft, 'defaults', path)`'s value; a repository the view does not list reads as every key not written. `edited` when the draft holds the key.
3. **`changesOf`:** one change for each draft key whose written-ness or value (`JSON` with sorted keys) differs from the view's, sorted by scope then path; `UNSET` has no `value`.
4. **`numberOrText`:** a number when the text, trimmed, is not empty and `Number` of it is finite; else the text as it is (the service refuses it at its field).
5. **Effort:** `{}` is `none`; `{ reasoning: { effort: 'low' | 'medium' | 'high' } }` and nothing else is that one; any other value `custom`.
6. **The classes,** each the mockup's, in tokens only (call 5):

| Piece | Classes |
|---|---|
| `Switch` (`.switch`, a `button type="button" role="switch" aria-checked`) | `relative h-[26px] w-11 flex-none cursor-pointer rounded-full border-0 p-0 disabled:cursor-default disabled:opacity-55`, on `bg-accent`, off `bg-muted`; the knob, a `span aria-hidden="true"`: `absolute top-[3px] left-[3px] size-5 rounded-full bg-card shadow-card transition-[left] duration-150`, on adds `left-[21px]` |
| Chip (`.chip`) | `inline-flex items-center gap-1.5 rounded-[7px] bg-subtle py-1 pr-1.5 pl-2.5 font-mono text-[13px]`; its button `size-[22px] cursor-pointer rounded-[5px] border-0 bg-transparent font-sans text-sm font-medium text-muted`, `aria-label="Remove <value>"`, text `x`; the empty chip, no button, `text-muted` |

7. **`Chips`:** each value a chip; none and `empty` given, one chip of `empty` that cannot be removed; then a `Button` `addLabel` (default `Add`), which becomes an `Input` (`aria-label="Add to <label>"`, `w-[180px] font-mono`, focused): Enter adds the trimmed text when not empty and not already listed, then closes; Escape closes; focus goes back to the button.

- [ ] **Step 1: Write the failing tests and the `fakeApi` change.** Each of the seven `fakeApi`s (the six of the Global Constraints and the One review plan's in `ui/src/pages/review.test.tsx`, each in its own style, after that plan's `review` and `pullReviews`) gains `settings`, `saveSettings`, `settingChanges` and `settingsExport`, each recording `['settings']`, `['saveSettings', csrf, save]`, `['settingChanges', before]`, `['settingsExport']` (a fake that records no calls returns the same values without the push) and answering `over`'s, else rejecting `RequestFailed(500, 'not_expected')`. `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` gains in `each`, after the One review plan's two: `['settings', (api) => api.settings(), ['settings']]`, `['saveSettings', (api) => api.saveSettings(ME.csrf, SAVE), ['saveSettings', ME.csrf, SAVE]]`, `['settingChanges', (api) => api.settingChanges(8977), ['settingChanges', 8977]]`, `['settingsExport', (api) => api.settingsExport(), ['settingsExport']]`, with `const SAVE: SettingsSave = { version: 14, changes: [{ scope: 'global', path: 'learning', value: true }] }`. Nothing else in those files changes.

```ts
// ui/src/api.test.ts
test('the settings calls send what the service reads and read what it answers', async () => {
  /* a fetchFn stub: settings() GET /api/settings; saveSettings('tok', save): PUT, x-visto-csrf tok, content-type application/json, body JSON.stringify(save);
     200 -> { kind: 'saved', view }; 422 { error: 'invalid', issues } -> { kind: 'invalid', issues }; 409 { error: 'changed' } rejects RequestFailed 409 'changed';
     settingChanges(8977) GET /api/settings/changes?before=8977; settingChanges() no query; settingsExport() GET /api/settings/export */
});
// ui/src/components/controls.test.tsx
test('a switch says whether it is on and changes it', async () => { /* role switch, aria-checked, the classes of rule 6 for on and off, click -> onChange(!checked); disabled */ });
test('chips are removed by their button and added by name, once each', async () => {
  /* Remove trunk -> onChange(['rc']); Add -> input focused; 'main' Enter -> onChange([..., 'main']); a duplicate or blank adds nothing; Escape closes and focuses Add;
     values [] with empty '*': one chip '*' with no button */
});
test('the segmented control may have none pressed', async () => {
  /* the change is shown by the type check (value null now compiles); at run time: value null, every button aria-pressed false and none has the on classes;
     clicking Full calls onChange('full') */
});
// ui/src/settings-draft.test.ts
test('a setting shows the draft over the view, and a repository not overriding shows the defaults as drafted', () => {
  /* draft defaults score.threshold 65: acme/web's score.threshold { written: false, value: 65 }; UNSET on acme/shop's: the same; edited true */
});
test('only what differs from the view is a change, sorted, and unsetting sends no value', () => {
  /* a draft value equal to the view's (keys in another order): no change; written -> UNSET: { scope, path } with no 'value' key; order by scope then path */
});
test('numbers, effort and values read as pinned', () => {
  /* numberOrText('45') 45, (' 1.5 ') 1.5, ('') '', ('abc') 'abc'; effortChoice({}) none, ({ reasoning: { effort: 'high' } }) high, ({ reasoning: { effort: 'high' }, x: 1 }) custom;
     valueText('baseBranches', []) '*', ('primaryBranches', ['main', 'master']) 'main, master', ('ignoredAuthors', []) 'none', true 'On' */
});
test('the repositories are the view\'s, those added and those the draft names, sorted, once each', () => { /* view ['acme/shop'], added ['acme/tools'], draft acme/web: the three, sorted */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the settings calls of the UI, a switch, chips, and the draft of unsaved changes`.

---

### Task 8: The Settings page: its header, General, Model, Secrets and Access, and saving

**Files:**
- Create: `ui/src/pages/settings.tsx`, `ui/src/pages/settings-parts.tsx`, `ui/src/pages/settings.test.tsx`
- Modify: `ui/src/pages/accounts.tsx` (`AccountsSection`: the card as built, without the page header), `ui/src/app.tsx` (`/ui/settings` is `SettingsPage` for an admin); merged with the One review plan's additions (Notes)
- Test: `ui/src/pages/accounts.test.tsx` (the one change of the Global Constraints)

**Interfaces:**

```ts
// ui/src/pages/settings-parts.tsx
export interface Form {
  view: SettingsView; draft: Draft;
  shown(scope: string, path: string): Shown;
  set(scope: string, path: string, value: SettingValue | Unset): void;
  issuesAt(scope: string, path: string): string[];
  setBadJson(key: string, bad: boolean): void;
}
export const LABELS: Readonly<Record<string, string>>;   // each path's row label (rule 3; repository rows in Task 9)
export function whereOf(scope: string, path: string): string;   // 'General', 'Model', 'Defaults for all' or the repository
export function SourceLine(props: { form: Form; scope: string; path: string }): JSX.Element | null;
export function Row(props: { id: string; label: string; help: ReactNode; labelFor?: string; restart?: string; form: Form; scope: string; path: string; children: ReactNode }): JSX.Element;
// ui/src/pages/settings.tsx
export function SettingsPage(): JSX.Element;
// ui/src/pages/accounts.tsx
export function AccountsSection(): JSX.Element;
```

**Rules (UI design 1 item 6, 4; the mockup; calls 9 to 12, 22, 25, 28):**

1. **As drawn in the mockup** (lines 84 to 111 and 177 to 194): the page header, the sections' nav, General (`id="general"`), Model (`id="model"`), Secrets (`id="secrets"`), Access (`id="access"`); then `AccountsSection` (`id="accounts"`). Repositories (`id="repos"`, Task 9) comes between Model and Secrets, and Changes and In config.yml (Task 10) after Accounts; each task adds its own link to the nav, so the nav never names a section the page lacks. Classes, each the mockup's in tokens (call 5):

| Piece | Classes |
|---|---|
| Section (`section.card`, `id` its anchor, `aria-labelledby` its heading) | `flex flex-col rounded-[12px] border border-border bg-card px-6 py-5 shadow-card` (Repositories adds `gap-4`, Secrets `gap-2`) |
| `.h2` | `m-0 text-[17px] font-semibold` (General, Model, Access add `mb-1`) |
| `.row` | `flex flex-wrap items-start gap-x-8 gap-y-3 border-t border-border py-4 first-of-type:border-t-0` |
| `.lbl` | `flex min-w-0 shrink grow basis-[260px] flex-col gap-1`; its label `text-sm font-medium`; its help `text-[13px] leading-[1.45] text-muted` |
| `.ctl` | `flex min-w-0 shrink grow basis-[300px] flex-wrap items-center gap-2.5` |
| `.from`, `.over` | `text-xs text-muted`; `text-xs font-medium text-accent-text` |
| `.sec` | `flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 text-sm first-of-type:border-t-0` |
| Mono | `font-mono text-[12.5px]` |
| Header's right | `flex flex-wrap items-center gap-2.5`; its line `text-[13px] text-muted` |
| Nav | `<nav aria-label="Settings sections" className="flex flex-wrap gap-2">`, each a `Button asChild` around `<a href="#<id>">` |
| JSON field | `fieldClasses` with `min-h-24 w-full py-2 font-mono text-[12.5px]`, a `textarea` |
| A row's issue | `w-full text-[13px] text-bad`, one `p` per issue, at the end of `.ctl` |
| Restart badges | `Badge tone="muted"` `Needs a restart` beside the label; `Badge tone="warn"` `Takes effect when the service restarts` in `.ctl` when `waits` |

2. **The data.** `api.settings()` once when the page opens; while it reads `Reading the settings.` (a plain `p`); failed: `The settings could not be read.` with `Try again`. **In every state** (reading, failed, read) the page has its one `h1` `Settings`, the sub-line, the nav and `AccountsSection`, which renders whatever the settings read does; the header's right side and the settings' sections only once read. Outside `AccountsSection`, nothing has `role="status"` but `Saved.` and nothing has `role="alert"` but the refusal box, each shown only after a save (the existing tests of Accounts query both roles page-wide). The draft, the issues, the JSON fields not valid and the repository chosen are the page's state.
3. **Texts, exactly** (the mockup's where it draws them):

| Where | Text |
|---|---|
| Header | `<h1>Settings</h1>`; sub `Saved settings apply from the next review. A review already running keeps the settings it started with.`; line `No unsaved changes`, `1 unsaved change`, `<n> unsaved changes`; `Discard`; primary `Save changes` (`Saving` while sent); both disabled while nothing is unsaved, Save also while sending or while a JSON field is not valid |
| Nav | in the end `General`, `Model`, `Repositories`, `Secrets`, `Access`, `Accounts`, `Changes`, `In config.yml`; this task's: `General`, `Model`, `Secrets`, `Access`, `Accounts` |
| `LABELS` (global) | `dryRun` `Dry run`, `learning` `Learning`, `limits.spendPerDay` `Daily spend limit`, `limits.queueConcurrency` `Reviews at once`, `limits.inputTokensPerCall` `Input tokens per call`, `limits.batchesPerReview` `Batches per review`, `model.baseUrl` `Endpoint`, `model.model` `Model`, `model.fallbacks` `Fallbacks`, `model.effort.default` `Effort, default`, `model.effort.elevated` `Effort, elevated`, `model.toolChoice` `How the answer is asked for`, `model.timeoutSeconds` `Time limit per call`, `model.prices` `Prices per million tokens`, `model.extraBody` `Extra body`, `model.extraHeaders` `Extra headers`, `scorer.model` `Second scorer`, `scorer.baseUrl` `Second scorer endpoint`, `scorer.timeoutSeconds` `Second scorer time limit` |
| `whereOf` | `global` with a path under `model.` or `scorer.`: `Model`; another `global`: `General`; `defaults`: `Defaults for all`; a repository: its name |
| General rows | `Dry run` / `Reviews are run and recorded, and nothing is posted to GitHub.` (switch, then `On` or `Off` in `text-[13px] text-muted`; restart); `Learning` / `Learn from what people do on pull requests: where they stepped in, reverts, and replies to findings.` (switch, word; restart); `Daily spend limit` / `Reviews wait once the day's model spend reaches it. An alert is raised at 80%.` (`$` muted, number input `max-w-[140px]`); `Reviews at once` / `How many reviews run side by side.` (`max-w-[140px]`; restart); `Input tokens per call` / `The most one model call is sent. A larger pull request is split into batches.` (`max-w-[180px]`); `Batches per review` / `Files past the last batch are listed as not reviewed.` (`max-w-[140px]`) |
| Model rows | `Endpoint` / `An OpenAI-compatible endpoint. Its key is a secret, set in the environment.` (as built: read only mono text, help ending `Set in config.yml.`, no restart badge); `Model` / `Tried first for every review.`; `Fallbacks` / `Tried in this order when the model fails.` (`Chips` with `Add a model`); `Effort` / `Elevated is used for pull requests into a primary branch.` (two selects in labels `Default` and `Elevated`, `text-[13px] text-muted`, options `Provider default`, `Low`, `Medium`, `High`, and `As written in config.yml` only while the value is custom); `How the answer is asked for` / `Auto is for a model whose endpoint refuses a request that names a tool.` (Segmented `Forced`, `Auto`; restart); `Time limit per call` / `Seconds.` (restart); `Prices per million tokens` / `Used only when the endpoint reports no cost.` (labels `Input`, `Cached`, `Output` over inputs `w-[100px]`; all three empty writes null); `Second scorer` / `A model of its own that scores the blocks. When it fails, the review keeps its findings.` (switch, restart text `On or off: needs a restart`; input `aria-label="Scorer model"` mono, disabled while off); while the scorer is shown on: `Second scorer endpoint` / `The scorer's API. Its key is a secret, set in the environment.` (as built: read only text, help ending `Set in config.yml.`) and `Second scorer time limit` / `Seconds, for one scorer call.`; `Extra body` / `JSON fields merged into every request to the model.`; `Extra headers` / `JSON: each header's name and value, sent with every request to the model. A value here is shown, recorded and exported.` |
| Scorer switch | on from off writes `scorer.model` the input's text (`''` when none); off writes `UNSET` to the three `scorer.*` |
| JSON field not valid | `Not valid JSON.` in the row's issue style |
| Source line (call 28) | `From config.yml at the start of <utc(at)>`, `Changed in the UI by <name>, <utc(at)>`, `The default` |
| Secrets | `Secrets`, right `Read from the environment at start. Never shown or changed here.` (`text-[13px] text-muted`); rows `Model key`, `Second scorer key`, `GitHub App private key`, `Webhook secret`, `GitHub App client secret`, `Database`, `Audit key`, `Alert webhook`, `Extension <of>`, `MCP server <of>`, each then the variable in mono muted when there is one; Badge ok `Set`, or muted `Not set` |
| Access | `Address` / `Where people open the service. Set in config.yml.` (mono); `Team that may sign in through GitHub` / `Its active members may sign in through the GitHub App, as viewers until an admin says otherwise. Set in config.yml.` (mono, or `None`); `Accounts that may sign in through GitHub` / `GitHub logins named in config.yml, beside the team.` (read-only chips, or `None`); with GitHub sign-in off one line `Sign-in through GitHub is off: config.yml names neither accounts nor a team.` in place of the two |
| Saved | `Saved.` (`role="status"`, `text-[13px] text-muted`) until the next change |
| Refused | a `role="alert"` box `rounded-[12px] border border-border bg-bad-bg px-5 py-3 text-sm text-bad` under the header: `Not saved. Each issue is shown at its setting:`, then a list, each `<where>, <label>: <message>`, or the message alone for one with no setting |
| Changed meanwhile | the same box: `Settings were saved meanwhile, here or in config.yml at a start. They were read again, and your changes are kept: save again.` |
| Other failures | `The settings could not be saved.`; 503: `The service is busy. Try again in a moment.`; status 0: `The service could not be reached. Try again in a moment.` |

4. **Saving.** `api.saveSettings(me.csrf, { version: view.version, changes: changesOf(view, draft) })`: saved replaces the view and clears the draft and the issues; invalid keeps the draft and sets the issues; a rejection `changed` reads the settings again and keeps the draft; a 403 `forbidden` is the app's (the watched API).

- [ ] **Step 1: Write the failing tests and the one change.** `accounts.test.tsx`'s `the accounts are listed ...` expects the sub-line `Saved settings apply from the next review. A review already running keeps the settings it started with.` in place of its own; nothing else of that file changes.

```tsx
// ui/src/pages/settings.test.tsx (VIEW: a fixture holding every path, written as the example's file would, with sources of both kinds)
test('Settings shows its header, its sections and their rows as drawn, with where each value came from', async () => {
  /* heading Settings, the sub-line, 'No unsaved changes', Discard and Save changes disabled; nav links and hrefs; the General rows' labels and helps;
     Dry run switch aria-checked true and 'On'; spend '40'; 'From config.yml at the start of 2026-03-01 09:00 UTC', 'Changed in the UI by octo-admin, 2026-03-01 09:30 UTC', 'The default';
     each section's classes; the Accounts region after Access */
});
test('a setting read once at start is marked, and one saved that waits for a restart says so', async () => {
  /* 'Needs a restart' on Dry run, Learning, Reviews at once, Endpoint, How the answer is asked for, Time limit per call; none on Daily spend limit;
     dryRun waits: 'Takes effect when the service restarts'; scorer.waits: on the Second scorer row */
});
test('changes are counted, Discard puts them back, and Save sends only what changed with the version', async () => {
  /* toggle Learning, type 45 in spend: '2 unsaved changes'; Discard: none, values back; again, Save: saveSettings('csrf-1', { version: 14, changes: [learning true, limits.spendPerDay 45] });
     saved: 'Saved.', 'No unsaved changes', the new view's values */
});
test('a save refused shows each issue at its setting and all of them at the top, and keeps the changes', async () => {
  /* invalid [{ global limits.spendPerDay 'Invalid input: expected number, received string' }, { null null 'auditKey: must be ...' }]: the box lists
     'General, Daily spend limit: Invalid input: expected number, received string' and the auditKey line; the spend row shows the message; '1 unsaved change' */
});
test('a save that met another keeps the changes and reads the settings again', async () => {
  /* saveSettings rejects RequestFailed(409, 'changed'): settings() read twice; the box's sentence; the draft kept; Save again sends the second view's version */
});
test("the model's rows read and write their values", async () => {
  /* Fallbacks: remove vendor/model-b, add vendor/model-c -> model.fallbacks ['vendor/model-c']; Effort: {} reads Provider default, high reads High, a custom fragment 'As written in config.yml';
     Low writes { reasoning: { effort: 'low' } }; Auto writes model.toolChoice 'auto'; prices emptied writes null, '1' in one only writes { inputPerMillion: 1, cachedInputPerMillion: '', outputPerMillion: '' };
     Extra body '{' -> 'Not valid JSON.' and Save disabled, '{"a":1}' -> model.extraBody { a: 1 }; the scorer switched off -> the three scorer.* unset; on -> the endpoint and time limit rows */
});
test('the secrets show only their variable and whether it is set, and Access shows what config.yml says', async () => {
  /* 'Model key' 'OPENROUTER_API_KEY' 'Set'; 'Alert webhook' 'Not set' with no variable; 'Extension example, option secret'; no value of a secret in the page;
     Access: the address, 'None' for the team, the accounts' chips with no remove button; github false: the off line */
});
test('a row names its setting in the list of issues as the page labels it', () => {
  /* whereOf('global', 'limits.spendPerDay') 'General', ('global', 'scorer.model') 'Model', ('defaults', 'newHead') 'Defaults for all', ('acme/shop', 'gate.mode') 'acme/shop';
     LABELS has every global path */
});
test('settings that cannot be read say so, and the accounts stay', async () => { /* settings rejects: the text, Try again reads again; the Accounts region shown */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the Settings page: its header, General, Model, Secrets and Access, and saving with each issue at its setting`.

---

### Task 9: Repositories

**Files:**
- Create: `ui/src/pages/settings-repositories.tsx`, `ui/src/pages/settings-repositories.test.tsx`
- Modify: `ui/src/pages/settings.tsx` (the section between Model and Secrets, and `Repositories` in the nav after `Model`), `ui/src/pages/settings-parts.tsx` (the repository rows' labels, the override line)

**Interfaces:**

```ts
// ui/src/pages/settings-repositories.tsx
export function RepositoriesSection(props: { form: Form; issues: readonly SettingIssue[] }): JSX.Element;
```

**Rules (UI design 4.1, O-UI-5, O-UI-6; the mockup lines 113 to 175; calls 10, 26, 28):**

1. **As drawn:** the header line, the listbox with `Add a repository`, and the pane of the repository chosen with its boxes Review, Score, Merge gate and Automatic approval. Classes, each the mockup's in tokens:

| Piece | Classes |
|---|---|
| Listbox | `role="listbox" aria-label="Repository"`, `flex max-w-[260px] shrink grow basis-[200px] flex-col gap-0.5` |
| `.repo` (a `button type="button" role="option" aria-selected`) | `flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-subtle`; chosen adds `bg-accent-soft text-accent-text` |
| Pane | `flex min-w-0 shrink grow-[999] basis-[480px] flex-col gap-5`; its title `flex flex-wrap items-center gap-2.5` with `strong` `text-base` |
| Box | `rounded-[10px] border border-border px-[18px] py-1` (Automatic approval `pb-2`); `h3` `mt-3.5 mb-0 text-sm font-semibold`; a box whose heading has a switch: `mt-3.5 flex items-center justify-between gap-2.5` with the `h3` `m-0` |
| How it works | `mt-2.5 mb-1.5 flex flex-col gap-1.5 rounded-lg bg-subtle px-3.5 py-3 text-[13px] leading-[1.55]`; `strong` `text-[13px] font-semibold`; `ol` `m-0 flex flex-col gap-1 pl-[18px]` |
| Threshold | `input type="range" min="1" max="100"` `w-full accent-accent`; the value `min-w-12 text-right font-semibold`; the scale `flex justify-between text-xs text-muted` |

2. **The list:** `Defaults for all` first, chosen when the page opens, badge muted `Defaults`; then `repositoryNames(view, draft, added)`, each with badge muted `Defaults` (no override), accent `1 override` or `<n> overrides` (`overridesOf`), or bad `1 issue` / `<n> issues` when issues name its scope. `Add a repository` opens an `Input` (`aria-label="Repository to add"`, placeholder `owner/name`) with `Add` and `Cancel`: the text trimmed and lower-cased, matching `REPOSITORY_NAME`, is added and chosen (one listed already is chosen); else `Write it as owner/name.` in `text-[13px] text-bad`.
3. **The pane's title:** the name (`Defaults for all` for the defaults), badge muted `Every repository starts from these` or `Settings not overridden come from the defaults`.
4. **Rows, texts exactly as drawn:** Review: `Primary branches`, `Ignored authors`, `Reviewed on every push` (its help with `/review`, `/done`, `*` and `/done` in mono, and the gate's sentence, O-UI-5), `A new commit is reviewed` (Segmented `Incremental`, `Full`; none pressed when the value is null); Score: `Threshold` (`<n>%`; the scale `1`, the note, `100`), `Inline notes` (switch); Merge gate: the switch in the heading (`aria-labelledby` the heading), `How it works` with its four items always, and while the gate is shown on `Gated branches` (its drawn help, then the sentence of call 26), `Check name` (`max-w-[240px]`), `Mode` (Segmented `aria-label="Gate mode"` `Enforce`, `Shadow`, `Bypass`, the help the mockup's `modeHelp` for the mode shown), `A reply clears a blocking finding` (switch), `Team that may skip` (mono `max-w-[320px]`; empty writes null), `Required checks`; Automatic approval: the switch in the heading, and while shown on `How it works` (its sentence), `Thread rule` (Segmented `Strict`, `Gate rule`, the help the mockup's `ruleHelp`), `Audit share` (`max-w-[120px]`, `%`, Badge ok dotted `Audit key set` when the secrets' `audit_key` has a variable, else warn dotted `Audit key not set`), and its closing paragraph `It approves only where the base branch's rules dismiss stale approvals, and never a draft or a pull request from a fork.` (`mt-1 mb-2 text-[13px] text-muted`).
5. **`Reviewed on every push`:** `Chips` with `empty` `*` (call 26). The heading's switches write `gate.enabled` and `score.autoApprove`; the rows write the path of their label below.
6. **`LABELS` (repository):** `primaryBranches` `Primary branches`, `ignoredAuthors` `Ignored authors`, `baseBranches` `Reviewed on every push`, `newHead` `A new commit is reviewed`, `score.threshold` `Threshold`, `score.inlineNotes` `Inline notes`, `score.autoApprove` `Automatic approval`, `score.approvalThreads` `Thread rule`, `score.auditShare` `Audit share`, `gate.enabled` `Merge gate`, `gate.branches` `Gated branches`, `gate.checkName` `Check name`, `gate.mode` `Gate mode`, `gate.clearByReply` `A reply clears a blocking finding`, `gate.skipTeam` `Team that may skip`, `gate.requiredChecks` `Required checks`.
7. **The override line (call 28):** in the defaults' pane each row's `SourceLine`; for `newHead` not written, `Not set: incremental, and full where the merge gate holds pushes`. In a repository's pane, not written: `From the defaults` (`.from`); written: `Overrides <valueText(path, the defaults' shown value)>` (`.over`), its `SourceLine`, and a `Button` `Use the default` (`min-h-7 px-2 text-xs`), which writes `UNSET`. The threshold's note: in a repository's pane `From the defaults: <d>%` or `Overrides the default of <d>%`; in the defaults' pane none.

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/pages/settings-repositories.test.tsx
test('the repositories are listed with their overrides, the defaults first', async () => {
  /* options 'Defaults for all' (selected) 'Defaults', 'acme/shop' '3 overrides', 'acme/web' 'Defaults'; choosing acme/shop: aria-selected, the hint badge */
});
test('a setting not overridden comes from the defaults, and one overridden says what it overrides and can use the default again', async () => {
  /* acme/shop Primary branches: chip trunk, 'Overrides main, master', the source line, Use the default -> chips main, master and 'From the defaults', '1 unsaved change';
     Save sends { scope: 'acme/shop', path: 'primaryBranches' } with no value */
});
test('Reviewed on every push shows every branch as *, and says what the merge gate does beside it', async () => {
  /* defaults [] : one '*' chip with no button; Add trunk -> ['trunk']; the help holds 'On a branch where the merge gate is on, pushes wait for /done instead, unless the gate is in Shadow mode.' */
});
test("the merge gate's rows show while it is on, with what each mode does", async () => {
  /* off: How it works only; switched on: the six rows; Shadow -> its help; Team that may skip emptied writes null; Gated branches' help holds 'they wait for /done' and ends 'A * here is not every branch: it is read as a branch of that name.' */
});
test("automatic approval shows its rules while on, the thread rule's help, and whether the audit key is set", async () => {
  /* on: How it works; Gate rule -> ruleHelp 'Gate rule: ...'; 'Audit key set'; a view with audit_key null: 'Audit key not set'; audit share '7' writes 7 */
});
test('the threshold writes a whole number and says whether it overrides the default', async () => {
  /* acme/web: 'From the defaults: 70%'; slider 60 -> '60%', 'Overrides the default of 70%', score.threshold 60; the defaults' pane: no note */
});
test('a repository is added by its name, and refused in another shape', async () => {
  /* 'Acme/Tools' -> 'acme/tools' listed and chosen, 'Defaults'; 'acme' -> 'Write it as owner/name.'; 'acme/shop' -> chosen, not twice */
});
test('a repository whose save was refused says so in the list, and its issue stands at its row', async () => {
  /* invalid with acme/shop gate.branches: its option '1 issue' (bad); chosen: the Gated branches row shows the message */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the Repositories section of Settings: the defaults, each override, the merge gate and automatic approval`.

---

### Task 10: The record of changes and the export

**Files:**
- Create: `ui/src/pages/settings-record.tsx`, `ui/src/pages/settings-record.test.tsx`
- Modify: `ui/src/pages/settings.tsx` (the two cards after Accounts, `Changes` and `In config.yml` at the end of the nav, `reads` bumped after each save)

**Interfaces:**

```ts
// ui/src/pages/settings-record.tsx
export function ChangesSection(props: { reads: number }): JSX.Element;   // reads: bumped by the page after each save
export function ExportSection(props: { reads: number }): JSX.Element;
```

**Rules (UI design 4.3, 4.4; calls 10, 24):**

1. **Changes** (`id="changes"`, a section card with the Accounts card's classes, its head and its heading): `Changes`, right `The latest first. A change in config.yml is recorded at the start that read it.`; a table `When`, `Who`, `Where`, `Setting`, `Before`, `After`: `utc(at)`; `config.yml` in mono or the name; `whereOf(scope, path)`; `LABELS[path]` (the path in mono when it has none); before and after in mono, `Not set` muted when null. `Older` (when `next` is not null) reads `settingChanges(next)` and adds the rows. Empty: `No change yet.`; failed: `The changes could not be read.`
2. **In config.yml** (`id="export"`): `In config.yml`, the line `The saved settings, as config.yml writes them. Replace these keys of the file with this text to keep it in step: the UI never writes the file, and a setting changed in the file wins at the next start.` (`text-[13px] text-muted`); the text in `<pre className="m-0 overflow-x-auto rounded-lg bg-subtle p-3.5 font-mono text-[12.5px]">`; `Copy` through `navigator.clipboard.writeText` (`Copied` after; refused: `The copy was refused: select the text and copy it by hand.`); failed: `The text could not be read.`
3. **Reads:** each when the page opens and when `reads` changes (after a save).

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/pages/settings-record.test.tsx
test('the changes are listed newest first, with who made them, where, and before and after', async () => {
  /* rows: '2026-03-01 09:30 UTC', 'octo-admin', 'General', 'Daily spend limit', '50', '40'; a config.yml row in mono; 'Not set' for null;
     Older -> settingChanges(next) and its rows added; none -> 'No change yet.'; rejected -> 'The changes could not be read.' */
});
test('the export shows the saved settings as config.yml writes them, and copies them', async () => {
  /* the pre holds the text; Copy -> writeText(text), 'Copied'; writeText rejects -> the refusal line */
});
test('after a save the changes and the export are read again', async () => { /* a save through the page: settingChanges and settingsExport each read twice */ });
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the record of setting changes and the export as config.yml on the Settings page`.

---

### Task 11: The documents, the run under Docker, and the notes

**Files:**
- Modify: `docs/guide/the-ui.md`, `docs/guide/configuration.md`, `docs/guide/merge-gate.md`, `docs/guide/automatic-approval.md`, `docs/guide/second-scorer.md`, `docs/guide/leave-dry-run.md`, `docs/guide/running-the-service.md`, `README.md`, `config.example.yml`, `docs/superpowers/specs/2026-11-25-the-ui-design.md` and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built
- Create: `docs/superpowers/plans/2026-11-27-the-ui-settings-notes.md`

**Rules:**

1. **The guide.** Each sentence states only what the code does, with its cost where it has one. `the-ui.md`: Settings as built (its sections, who may open it, saving, the issues, the version, the restart marks, the record, the export, Accounts after Access), the four routes with their shapes, the log lines, migration `0016_settings`, the statements to read the settings and the record by hand (rule 2), and what was tried. `configuration.md`: the editable part and the file-only part (UI design 4.1), the sync's rule (4.3) with the clash, what applies at the next review and at the next start (call 19), `*` in `baseBranches` (and that the gate's `branches` read it as a name), the export, the evals reading the file (call 21), the copy of the file whole while the UI is off (call 13), what of the extra headers, the extra body and the endpoints' addresses the screen, the record and the export show (call 17), and that a reviewed repository's own `.visto-ai.yml` still only adds protection (main D10): the UI is the deployment's. Each of `merge-gate.md`, `automatic-approval.md`, `second-scorer.md`, `leave-dry-run.md` where it says only the file sets a key: the file or Settings, and when the change applies; `running-the-service.md`: the start's migration and sync, the clash refusal and its lines. README: the status row `UI: ... Settings ...` built, with what was tried; the planned row loses `settings`.
2. **The statements** for the guide:

```sql
-- the settings in the database, and where each came from
select scope, path, value, set_by, set_by_name, set_at from visto_ai.settings order by scope, path;
-- the latest changes
select at, by, by_name, scope, path, old_value, new_value from visto_ai.setting_changes order by id desc limit 50;
```

3. **`config.example.yml`:** after its third line, `# Once the service has started, dryRun, learning, limits, the model's and the scorer's settings (not their keys) and repositories live in its database too, and an admin changes them in the UI's Settings; a setting changed here wins at the next start (docs/guide/configuration.md).`; the comment of `baseBranches` ends `; empty or * means every branch.` The example's tests run unchanged.
4. **The designs are amended,** in the same commit, one sentence for each place this plan departs from them or adds to them:

| Document, section | The sentence | Call |
|---|---|---|
| UI design 4.1 | The second scorer is on while one of its keys is in the database; its key stays in `config.yml`. An override key that names no repository (not `<owner>/<name>`) is not copied. | 7, 8 |
| UI design 4.2 | A save is a list of changes against the version the page read; a save after another is refused and sent again; both the settings saved and those in force until the next start are checked. | 15, 16 |
| UI design 4.3 | The sync runs after the migrations, before anything reads a setting, in one transaction; a start refused for a clash copies nothing, and says which settings came from the UI. | 13, 14 |
| UI design 4.5 | Whether the second scorer is on is read at the next start too; a merge gate switched on applies at each pull request's next event, and its sweep of checks and the app's permission checks (the gate's, and automatic approval's Administration read) at the next start. | 19 |
| UI design 5 | `GET /api/settings/changes` pages 50 at a time; `PUT /api/settings` answers 409 when another save came first and 422 with each issue. | 16, 23 |
| UI design 7, item 2 | It gains: Built in one plan. | 1 |
| Main 11.1, first paragraph | It gains: Once the service has started, the editable part (UI design 4.1) lives in its database, kept in step with this file at each start. | 13 |
| Main 11.1, repository defaults | The base filter reads `*` or an empty list as every branch; the gate's branches read `*` as a branch's name. | 26 |
| Main 13 | `settings`, `settings_file` and `setting_changes` hold the editable part, the file's at the last start, and the record of changes. | 3 |
| UI design 4.3, a bullet after "The first start" | While the UI is off, each start copies the file's editable part whole, every difference recorded as made by `config.yml`. | 13 |

5. **The run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before (the stub of GitHub, the model stub, Playwright's Chromium in the app's network namespace, `psql`):
   - **The previous release first** on an empty database, then this branch on it: the ledger gains `0016_settings`, `settings` holds what the file writes, the record one row each by `config.yml`, one `settings` log line; the previous release, started again, refuses.
   - **Saving:** an admin (made by the command) opens Settings: General shows `From config.yml at the start of ...`; the defaults' threshold set to 65 and `acme/shop`'s gate switched on with no branch: Save is refused with the issue at Gated branches; a branch added: saved; Changes lists both; In config.yml shows the text, and the text written into the file reads back as the same settings.
   - **At the next review:** an `opened` event through the stubs after the save: the run's threshold is 65.
   - **Restarts:** the app restarted with the file unchanged keeps 65 (`Changed in the UI by ...`); the file's `limits.spendPerDay` changed and the app restarted: the file's value, recorded by `config.yml`, and 65 kept. Dry run switched off: `Takes effect when the service restarts`, the sidebar still `Dry run`; restarted: `Live`.
   - **The UI off:** `ui.publicUrl` removed and the app restarted: the values the UI saved are gone, each recorded as made by `config.yml`; put back, the UI shows the file's values.
   - **A clash:** automatic approval switched on in the UI with the file writing `auditKey`; the file's `auditKey` removed and the app restarted: it exits 1 printing the `config:` lines and the sentence; `settings` and `settings_file` as before; the key put back: it starts.
   - **Two saves at once** from two admins' pages (`Promise.all` of two `fetch` from inside the app's container, the same version): one 200, one 409; one record row.
   - **`*`:** with `baseBranches: [main]` a pull request into `feature` is dropped as `base_filtered`; with `*` saved, the next one is reviewed.
   - **Throughout,** every log line of the service is one JSON object (the `config:` lines of a refused start are written by `out`, as today); no log line, answer, export or row holds a secret's value; the page loads with no content security policy refusal (the console read). Everything the run made is removed.
6. **The notes file,** in the form of the plans before: the status, the decisions taken while building, what the reviews found, what the run showed, what is for the owner, what is known and left, and what is not verified.

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the root suite, type check, lint, the four `ui` scripts, the ASCII check, the token check and the guide check (`npm test` runs `test/guide/check.test.ts`).
- [ ] **Step 3: Commit** `docs: the UI's settings in the guide, the README, the config example, the designs, and the plan as built`.

---

## To verify

None of these is shown by a test of this plan. Each names the step of Task 11 that can show it.

1. **That Postgres takes the lock and two saves at once as PGlite does** (one saved, one `changed`). Task 11 rule 5, two saves at once.
2. **That `yaml`'s `stringify` writes every value the settings hold so that a person can paste it** (the round trip is tested; how it reads is not). Task 11 rule 5, saving.
3. **That the controls work in a real browser under the content security policy:** the switch's transition, the range input's `accent-accent`, the clipboard. Task 11 rule 5, throughout.
4. **That a review after a save runs on the saved setting through the real stack.** Task 11 rule 5, at the next review.
5. **That the start's sync and its refusal behave on a real start with a real file.** Task 11 rule 5, restarts and a clash.
6. **The sizes:** 50 changes a page, 200 characters of a value in the record's answer, 500 changes a save, 10 settings named by a clash, 200 repositories seen.
