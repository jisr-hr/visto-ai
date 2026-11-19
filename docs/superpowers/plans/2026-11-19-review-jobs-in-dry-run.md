# Review Jobs in Dry Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment in dry run reviews each pull request as its events arrive, records what it would have posted, and writes nothing to a repository.

**Architecture:** The receiver now stores a job in the same transaction as the delivery. A runner inside the app process claims due jobs from Postgres, never two for one pull request, and hands each to the review job. The review job reads the pull request live from GitHub with an installation token, runs the engine in `full` mode and records the run. A database lock keeps a second instance out. Start-up recovers interrupted jobs before it listens and asks GitHub for failed deliveries again after. Stopping drains.

**Tech Stack:** Unchanged from plan 3. No new library: the app's JSON Web Token is signed with `node:crypto`, and every outbound call goes through a `fetch` that is passed in.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it. Earlier plans and their notes are beside this file. The notes of plan 3 list what this plan had to deal with first; the table under "Carried over from plan 3" says where each item went.

**Notes:** `docs/superpowers/plans/2026-11-19-review-jobs-in-dry-run-notes.md` is written when the build ends: the decisions taken and what its final review leaves open. Where this plan and the notes differ, the notes say what was built.

## Scope

This is the second of the three plans that build stage 4 of section 18 (the shell). The split is in plan 3.

| In this plan | Left to a later plan, and why |
|---|---|
| 10: the app's identity, installation tokens minted per installation and cached | **The start-up check of granted permissions and subscribed events (8.4), the app manifest:** plan 5, when the permission list is final |
| 8.1: what a pull request event triggers, the quiet period after a push, the filters on automatic reviews | **Commands (`/review`, `/done`, the skip), a re-run of the check, manual reviews:** plan 5 and stage 5. **Withdrawing an approval on a push:** stage 9. **Learning from a closed pull request:** stage 8. **Gated pull requests reviewed only on request:** stage 5 |
| 8.2: the queue in Postgres, fixed concurrency, never two jobs for one pull request, the live head read before a job runs, at most 3 starts, the drain, the recovery, redelivery with the heartbeat | **"Unless their review was already published" in the recovery:** plan 5. Here a run is recorded and its job finished in one transaction, so an interrupted job has no recorded run |
| 5.2: the `full` mode only, as the engine has it today, and the rule that an automatic trigger on an already reviewed head is skipped | **`incremental`, `recheck`, the earlier state, scores across reviews:** plan 5. They rest on a published review, and a dry run never counts as one (11.1) |
| 8.5 and 13: `jobs`, `heartbeat`, `review_runs` | **`file_scores`, `block_scores`, `thread_verdicts`, `review_comments`:** plan 5, which first reads them. A dry run stores its scores and findings inside its run row |
| 11.1: dry run, the app's id and key, ignored authors, the base filter, the daily limit, the concurrency, the alert webhook | **The gate block, the score block beyond the threshold, MCP servers, extensions, learning, the UI's access list, the audit key:** with the stage that first reads each |
| 12: spend per day, queue concurrency | Every other guard is already in the engine, or belongs to a later stage |
| 14: one log line per review, usage per review, the model's status on every review, the model connection check, the alerts a dry run can raise | **Alerts for the publish rate, cached tokens at zero, stale learning, a failed dismissal, a merge under a stale approval, a missing permission:** with the stage that can raise each. **Alerts shown in the UI:** stage 10 |
| 17: the lock that keeps a second instance out | |

### Carried over from plan 3

Plan 3's notes list eleven items "before the next plan builds on this". Where each went:

| Item | Here |
|---|---|
| The in-process test database has one connection, so nothing concurrent can be tested on it | The queue needs no concurrent claim: one runner in one process (D13) claims with single statements that check the row's state, and "never two for one pull request" is kept in memory. What two connections can do to those statements is argued in Task 2 and exercised on a real Postgres in Task 12 |
| `commit` resolves after a statement error the work caught | A Global Constraint: nothing inside a transaction catches a statement's error and goes on |
| The pool has no statement timeout and no keep-alive | Task 2: 15 seconds and keep-alive on the pool; a migration switches the timeout off for itself |
| Signal handlers are installed only after start | Task 12: before start |
| The owner and repository name are lower-cased only inside `db` | Job rows come out of `db` in lower case, and the runner's key per pull request is built from a job row only |
| An ignored delivery is marked as seen | Unchanged. Redelivery asks only for deliveries the service did not answer with success, and an ignored one was answered 202 |
| `stop` closes the listener first | Task 11: the drain comes first, and webhooks are accepted during it |
| After a database close that timed out the process lingers | Task 12: the process exits once `stop` has ended |
| Request timeouts are checked every 30 seconds; nothing bounds a wait on Postgres | The statement timeout bounds the wait on Postgres. The 30-second check is unchanged |
| An older event with the same "updated at" can win | Unchanged in what is stored. A job never trusts stored facts: it reads the pull request live before it runs, and when the head it finds is another one, that head gets a job (Task 10) |
| A start that fails logs no reason | Task 12: the log line carries the error's short code when it has one |

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **The service starts only with `dryRun: true`.** Publishing does not exist yet. If the key defaulted to "dry", a deployment upgraded to the next plan's code would start posting reviews with no change to its config. With the key required now, switching to live reviews is a line somebody writes.
2. **One pending job per pull request.** A newer trigger replaces its reason, head and time and resets its count of starts. That is how "a newer push replaces a pending one" (8.1) is kept, and it also holds for a push that arrives while an `opened` job has not started.
3. **A job's states are `pending`, `running`, `done` and `dropped`.** A delayed job is a pending one whose time has not come. A review that fails is `done` with outcome `failed` and is not run again by itself: the run row carries the failure, and the next push or, from plan 5, a `/review` brings a new job. Two failures put the job back instead: a refused key (call 11) and a failure of the git service before any model call (call 24). "At most 3 starts" counts every start that was not given back.
4. **Filters are applied twice:** when the event arrives, from the event's facts, and when the job comes up, from the live pull request. The base filter is a list of exact branch names; empty means every branch. Ignored authors are matched without regard to letter case and default to `dependabot[bot]`.
5. **Start-up recovery only puts interrupted jobs back.** The runner drops a job that is more than a day old or out of starts when it comes up, at start-up and at any other time. A closed pull request or a moved head is found by the live read, at the cost of one API read per such job. Stored facts can be wrong (plan 3's notes, equal "updated at"), and the design's own fix is the live read (8.2).
6. **The instance lock is a Postgres advisory lock held on a connection of its own.** When that connection ends, the lock is gone, so the process exits at once with code 1 and its supervisor starts it again; under Compose that is `restart: unless-stopped`. Reviews running at that moment are cut and run again after the restart. Plan 3's service survived a database restart; this one restarts with it.
7. **The runner looks for due jobs every 5 seconds,** and at once when a webhook queued one or a job ended. There is no timer per job, so a delayed job starts up to 5 seconds late.
8. **The drain waits at most 10 minutes for running reviews (PM-drain).** The Compose file's grace period becomes 11 minutes. A second signal still ends the process at once.
9. **The day of the daily limit is the UTC day,** and the spend is the cost of the runs recorded that day. A review already running is not stopped, so the day can end above the limit by what the running reviews cost.
10. **A run that used tokens and reported no cost raises one alert per process (`cost_unknown`).** An endpoint that reports no cost, with no prices configured, makes the daily limit blind.
11. **A rejected key or a key out of credit pauses reviews for 5 minutes at a time.** The job that met it is put back, due when the pause is over, and its start is not counted when the run cost nothing. When the 5 minutes are over one job tries the model again; a refused call costs nothing. A job can wait this way for a day at most, the age at which the runner drops it.
12. **The key check is `GET <model.baseUrl>/key`** (5.4, 14: OpenRouter's key endpoint). 401 is a rejected key; 402, or a key whose own limit has nothing left, is no credit; 200 is fine; anything else says nothing, so another endpoint that has no such route is simply not judged by the check. It runs at start-up and every 5 minutes. A check that says the key is refused starts a pause once and never extends one, and when a review then succeeds the check is ignored for the rest of the process: on an endpoint whose key route refuses what its model accepts, the check must not hold reviews.
13. **An alert is always a log line, and a JSON POST when `alerts.webhook` is set.** Alerts are sent in dry run too: they are about the deployment's health, and 11.1 forbids notifiers, which are extensions (11.3).
14. **Redelivery runs in dry run.** It asks GitHub to send the app's own deliveries again and writes to no repository. The only requests to the git service that are not `GET` are the token mint and the redelivery request.
15. **No redelivery on the first start,** when there is no heartbeat to look back from.
16. **The app's id is written in the config as a number.** It is not a secret. The private key is by reference, may be written on one line with `\n` for each line break, and is checked to be an RSA key when the config is loaded.
17. **The app's token lives 9 minutes (PM-app-auth),** though GitHub allows 10.
18. **A run row holds the review text and the inline comments as they would be posted, and the engine's whole result as JSON.** That is what lets a dry run be read and compared, before the score tables exist.
19. **Recording a run is tried 3 times** (waiting 1 second, then 5). A review costs money and an unrecorded one would run again after a restart. If all three fail, the cost is in the log and the job stays `running`.
20. **Finished jobs are deleted after 14 days (13) by the same 5-minute tick that checks the key.**
21. **The heartbeat is written every 60 seconds,** starting when a redelivery attempt got through the deliveries (PM-redelivery). An attempt that did not is made again every 5 minutes with the same look-back, and raises one alert. Until one gets through, the stored heartbeat does not move, so a restart looks back just as far.
22. **A head that already has a finished review against the same base is not reviewed again (5.2).** Dry runs are compared with dry runs only, so the first live review of a head is never skipped because of a dry one (11.1). Without this, a pull request closed and reopened would be reviewed, and paid for, twice.
23. **Twelve tasks in one plan.** It ends with one thing that runs, and the tasks are ordered so that the last two are the only ones that touch the service's start and stop.
24. **A job whose pull request could not be read from the git service is tried again a minute later,** its start counted, so three starts bound it. This covers a failure of the shell's own reads, and one inside the engine before any model call whose code starts with `github_`. Without it a short outage of the git service would remove that head's review for good: in dry run nothing can ask again.
25. **A job whose head has moved makes sure the live head has a job.** 8.2 drops such a job because the new head's own event queues one. Events arrive out of order or within the same second, and then that job may not exist. The job for the live head is due after the quiet period, and none is created when the pull request already has a pending one.
26. **An event older than what is stored still triggers, from the stored facts, and never replaces a pending job.** Any later event of a pull request, a label for example, can be stored before the push it followed.

## Global Constraints

Every constraint of plans 1 to 3 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only: no `enum`, no `namespace`, no parameter properties. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network or a real database.** `test/setup.ts` blocks sockets and the global `fetch`. Every outbound call in this plan goes through a `fetch` passed in as a dependency, and a test passes a stub. Nothing in `src` reads `globalThis.fetch` but `src/main.ts`, `src/eval/cli.ts` and the sample tool `src/forge/github/send-sample.ts`. Database tests use `testDb()`, one fresh database per test.
- **Nothing in this plan writes to a repository on the git service.** The only requests to the git service that are not `GET` are the installation token mint and the redelivery request. The two other requests that are not `GET` go elsewhere: the model call and the alert.
- **Boundaries, enforced by lint as in plan 3:** only `src/db/**` imports a Postgres client. Only `src/forge/github/**`, `src/eval/cli.ts` and `src/main.ts` import from `src/forge/github/**`; the shell sees `ForgeAccess` and `HookDeliveries` from `src/forge/types.ts`. `src/engine/**` imports nothing from `db`, `shell`, `eval` or `forge/github`. `src/db/**` imports nothing from `src/engine/**`.
- **SQL:** every value is a numbered parameter. Every table is written with its schema, `visto_ai.<table>`. Columns are `text`, `integer`, `boolean`, `timestamptz`, `jsonb` or, new here, `double precision`, which both clients return as a JavaScript number. A count or a sum is cast (`::int`, `::float8`). A `jsonb` value is passed as JSON text made by `storableJson` (Task 2).
- **Times in SQL come from the caller.** Every function in `src/db/jobs.ts`, `src/db/review-runs.ts` and `src/db/heartbeat.ts` takes its time as an ISO 8601 string and passes it as text cast to `timestamptz`. None of them calls `now()`, so a test controls every time. A time read back has the form `2026-03-01T10:00:00.000Z`.
- **Nothing inside a transaction catches a statement's error and goes on.** A caught error leaves the transaction aborted on one client and committed on the other.
- **Logs** carry ids, names, codes and counts. They never carry a payload, a title, a description, a comment's or a finding's text, a token, a key, a signature or an error's message. **A token, a key or a JWT never appears in a thrown error.** Errors that cross a boundary carry a short code as their message, such as `github_401`.
- **A short code** matches `/^[a-z][a-z0-9_]*$/` and is at most 40 characters. Wherever this plan says "the error's code", it is the error's message when that is a short code, and `internal_error` otherwise.
- **Fixtures are synthetic and invented:** `acme/shop`, pull request 7, logins such as `octo-dev`, installation `99`, app id `12345`. A test that needs an RSA key generates one with `generateKeyPairSync('rsa', { modulusLength: 2048 })`; no key is written in a file.
- **Ported behaviour is named by a `PM-` key.** The key resolves to the predecessor's file privately, never in this repository. What is carried over is the rule a test checks. Every literal is invented here.
- **Nothing internal in this repository,** including commit messages and the notes file.
- **Git:** work on a branch named `stage-4b`. Commit locally after each task. A commit made by an agent ends with that agent's own co-author line. `git config user.email` must print the owner's public address before the first commit. Push nothing without the owner's go-ahead.

## Review Focus

Inputs and failures the design implies, that a person running this would meet, each pinned by a test in the task that owns the code:

1. **Several pushes in a row.** One review runs, after the quiet period, of the last head (Tasks 2 and 7).
2. **An event for a pull request whose review is running.** The new job waits and runs after it; the two never overlap, and another pull request's job is not held up (Task 8).
3. **The pull request changed between the trigger and the run:** a new head, closed, turned into a draft. The job is dropped with a reason and no model call is made, and a new head gets a job of its own (Task 10).
4. **The process dies in the middle of a review.** At the next start the job runs again, at most 3 starts in all, and no run is recorded twice (Tasks 2, 10 and 11).
5. **The model key is rejected or out of credit, or the daily limit is reached.** Reviews wait, no job is lost, and the operator gets one alert, not one per job (Tasks 9 and 10).
6. **A model answer the database refuses:** a finding that holds a NUL character or half of a surrogate pair. The run is still recorded. Otherwise the job would run, and spend, again (Tasks 2 and 10).
7. **GitHub is unreachable or refuses the app.** The run is recorded as failed with a code, the job is tried again a minute later, three starts at most, and the service keeps running (Tasks 4, 5, 8 and 10).
8. **Events of one pull request arrive out of order.** A push that arrives after a later label still gets its review, and an old event never undoes the job of a newer one (Tasks 7 and 10).

## File Structure

```
src/config/schema.ts, load.ts        + app.id, app.privateKey, dryRun, limits.spendPerDay, limits.queueConcurrency,
                                       alerts.webhook, ignoredAuthors, baseBranches; repoSettingsFor
src/db/migrations/0002_jobs.sql      jobs, heartbeat, review_runs
src/db/jobs.ts                       the queue's statements
src/db/review-runs.ts                recordRun, listRuns, spentSince
src/db/heartbeat.ts                  readHeartbeat, beat
src/db/text.ts                       + storableJson
src/db/postgres.ts                   + pool options, takeInstanceLock
src/db/migrate.ts                    a migration runs with no statement timeout
src/forge/types.ts                   + LivePullRequest, ForgeAccess, HookDelivery, HookDeliveries
src/forge/github/app-auth.ts         the app's token and installation tokens
src/forge/github/access.ts           createGithubAccess: the live pull request, a source per installation
src/forge/github/hook-deliveries.ts  listing and re-sending the app's deliveries
src/forge/github/send-sample.ts      + --action and --head
src/shell/triggers.ts                what an event queues, and why not
src/shell/receive.ts                 + the job, in the delivery's transaction
src/shell/runner.ts                  claims due jobs and runs them
src/shell/alerts.ts                  createAlerts
src/shell/model-health.ts            checkModelKey, createModelHealth
src/shell/spend.ts                   createSpendGuard
src/shell/review-job.ts              runReviewJob
src/shell/redelivery.ts              pickRedeliveries, runRedelivery
src/shell/recovery.ts                recoverJobs
src/service.ts                       start: lock, migrate, recover, listen, redeliver, timers. stop: drain first
src/main.ts                          builds the real clients (Task 11); signals before start, a clean exit (Task 12)
compose.yaml, env.example, config.example.yml, README.md
```

## Shared Types

Added to `src/forge/types.ts` in Task 5 (the first two) and Task 6 (the last two). Later tasks use them exactly as written.

```ts
export interface LivePullRequest {
  info: PullRequestInfo;                 // for an open pull request, baseSha is the merge base of its base and its head
  state: 'open' | 'closed' | 'merged';
}
export interface ForgeAccess {
  /** The pull request as the git service has it now. null when it is not there. Rejects with a short code. */
  readPullRequest(ref: PullRequestRef, installation: string): Promise<LivePullRequest | null>;
  /** A read-only source for one review, with that installation's token. Rejects with a short code. */
  sourceFor(installation: string): Promise<Source>;
}
export interface HookDelivery { id: string; guid: string; at: string; ok: boolean }   // ok: the service answered it with success
export interface HookDeliveries {
  /** The app's own webhook deliveries made at or after `since`. `complete` is false when the listing stopped at its page limit. */
  listSince(since: string): Promise<{ deliveries: HookDelivery[]; complete: boolean }>;
  /** Asks the git service to send one delivery again. Rejects with a short code; `github_rate_limited` when told to slow down. */
  redeliver(id: string): Promise<void>;
}
```

Added to `src/config/load.ts` in Task 1:

```ts
export interface RepoSettings extends RepoConfig { ignoredAuthors: string[]; baseBranches: string[] }
```

Produced by `src/db/jobs.ts` in Task 2:

```ts
export type JobStatus = 'pending' | 'running' | 'done' | 'dropped';
export interface Job {
  id: number; ref: PullRequestRef;      // owner and repo in lower case
  reason: string;                       // the event that queued it: opened, reopened, ready_for_review, synchronize, retargeted
  headSha: string;                      // the head that event named
  status: JobStatus; outcome: string | null;
  runAt: string; starts: number; createdAt: string;
}
```

Used by Tasks 7 to 11 as a type for every logger: `type Log = (entry: Record<string, unknown>) => void`. Each file declares it locally, as plan 3's files do.

---

### Task 1: Configuration

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `config.example.yml`
- Modify: `src/eval/replay.ts`, `src/eval/backtest/run.ts`. They spread `config.limits` into the engine's limits, which must keep exactly its three keys; they now take `inputTokensPerCall` and `batchesPerReview` by name, so the two existing tests that assert those three keys keep passing
- Modify (they build a `DeploymentConfig` or a `ServiceConfig` by hand and stop compiling): `src/eval/replay.test.ts`, `src/eval/backtest/run.test.ts`, `src/service.test.ts`, `src/main.test.ts`, and any other file `npm run typecheck` names
- Test: the existing test file of `src/config/load.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export interface RepoSettings extends RepoConfig { ignoredAuthors: string[]; baseBranches: string[] }
export interface DeploymentConfig {
  model: ModelConfig; scorer: ScorerConfig | null;
  app: { id: string; privateKey: string; webhookSecret: string } | null;
  database: { url: string } | null;
  server: { port: number };
  dryRun: boolean;
  alerts: { webhook: string } | null;
  limits: { inputTokensPerCall: number; batchesPerReview: number; spendPerDay: number; queueConcurrency: number };
  repositories: { defaults: RepoSettings; overrides: Record<string, Partial<RepoSettings>> };
}
export type ServiceConfig = DeploymentConfig & {
  app: { id: string; privateKey: string; webhookSecret: string }; database: { url: string }; dryRun: true;
};
/** `fullName` is "owner/name", matched without regard to case. An override replaces only the keys it sets. */
export function repoSettingsFor(config: DeploymentConfig, fullName: string): RepoSettings;
/** Unchanged in what it returns: exactly { primaryBranches, scoreThreshold }, the two keys the engine reads. */
export function repoConfigFor(config: DeploymentConfig, fullName: string): RepoConfig;
```

The keys as written in the file, with their rules:

| Key | Rule | Default |
|---|---|---|
| `app.id` | A whole number from 1 up. Loaded as its decimal text | required in `app` |
| `app.privateKey` | `{ env: NAME }`. Each backslash followed by `n` in the value becomes a line break. Must be an RSA private key in PEM form (`createPrivateKey`, `asymmetricKeyType === 'rsa'`), else the issue `app.privateKey: must be an RSA private key in PEM form` | required in `app` |
| `dryRun` | boolean | `false` |
| `alerts.webhook` | `{ env: NAME }`, an http or https URL, else `alerts.webhook: must be an http or https URL` | no `alerts` block |
| `limits.spendPerDay` | a positive number, US dollars | `50` |
| `limits.queueConcurrency` | a whole number from 1 to 20 | `2` |
| `repositories.defaults.ignoredAuthors`, and in an override | a list of logins | `['dependabot[bot]']` |
| `repositories.defaults.baseBranches`, and in an override | a list of branch names; empty means every branch | `[]` |

`serviceConfig` adds the issue `dryRun: must be true: this version cannot publish` when `dryRun` is not `true`. No issue ever quotes a value.

- [ ] **Step 1: Write the failing tests**

```ts
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SERVICE_YAML = `
model: { apiKey: { env: MODEL_KEY }, model: m }
app: { id: 12345, privateKey: { env: APP_KEY }, webhookSecret: { env: HOOK } }
database: { url: { env: DB } }
dryRun: true
`;
const ENV = { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 's', DB: 'postgres://u:p@db:5432/visto' };

test('the app block carries the id as text, the key and the secret', () => {
  assert.deepEqual(parseConfig(SERVICE_YAML, ENV).app, { id: '12345', privateKey: PEM, webhookSecret: 's' });
});
test('a private key written on one line with backslash-n is read as its lines', () => {
  assert.equal(parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: PEM.replaceAll('\n', '\\n') }).app?.privateKey, PEM);
});
test('a private key that is not an RSA key is refused and never printed', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  for (const value of ['not-a-key-value', ec]) {
    assert.throws(() => parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: value }), (e: unknown) =>
      e instanceof ConfigError && e.issues.length === 1 && e.issues[0] === 'app.privateKey: must be an RSA private key in PEM form'
      && !e.message.includes('not-a-key-value'));
  }
});
test('an app block without an id or a key is refused', () => {
  const yaml = SERVICE_YAML.replace('id: 12345, privateKey: { env: APP_KEY }, ', '');
  assert.throws(() => parseConfig(yaml, ENV), ConfigError);
});
test('what this plan adds has these defaults', () => {
  const c = parseConfig('model: { apiKey: { env: MODEL_KEY }, model: m }', ENV);
  assert.equal(c.dryRun, false);
  assert.equal(c.alerts, null);
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 });
  assert.deepEqual(c.repositories.defaults.ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(c.repositories.defaults.baseBranches, []);
});
test('the alert webhook is read by reference, must be an http or https URL, and is never printed', () => {
  const yaml = `${SERVICE_YAML}alerts: { webhook: { env: HOOK_URL } }\n`;
  assert.deepEqual(parseConfig(yaml, { ...ENV, HOOK_URL: 'https://alerts.example.test/in/abc' }).alerts, { webhook: 'https://alerts.example.test/in/abc' });
  assert.throws(() => parseConfig(yaml, { ...ENV, HOOK_URL: 'ftp://alerts.example.test/abc' }), (e: unknown) =>
    e instanceof ConfigError && e.issues[0] === 'alerts.webhook: must be an http or https URL' && !e.message.includes('alerts.example.test'));
});
test('the queue concurrency is a whole number from 1 to 20, and the daily limit is positive', () => {
  for (const limits of ['{ queueConcurrency: 0 }', '{ queueConcurrency: 21 }', '{ queueConcurrency: 1.5 }', '{ spendPerDay: 0 }']) {
    assert.throws(() => parseConfig(`${SERVICE_YAML}limits: ${limits}\n`, ENV), ConfigError);
  }
});
test('serviceConfig refuses a config that is not in dry run', () => {
  const live = parseConfig(SERVICE_YAML.replace('dryRun: true', 'dryRun: false'), ENV);
  assert.throws(() => serviceConfig(live), (e: unknown) =>
    e instanceof ConfigError && e.issues.length === 1 && e.issues[0] === 'dryRun: must be true: this version cannot publish');
  assert.equal(serviceConfig(parseConfig(SERVICE_YAML, ENV)).dryRun, true);
});
test('repoSettingsFor applies an override key by key, and repoConfigFor still returns the two keys the engine reads', () => {
  const c = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    Acme/Shop: { baseBranches: [main], ignoredAuthors: [] }\n`, ENV);
  assert.deepEqual(repoSettingsFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: ['main'] });
  assert.deepEqual(repoSettingsFor(c, 'acme/other').ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(repoConfigFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70 });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail; nothing else does.

- [ ] **Step 3: Implement the keys in `src/config/schema.ts` and `src/config/load.ts`**

The schema stays `strict` at every level. `load.ts` resolves the three new references the way it resolves `app.webhookSecret`, with the same "environment variable NAME is not set" issue.

- [ ] **Step 4: Update the files that build a config by hand, and `config.example.yml`**

Hand-built configs gain `dryRun: false`, `alerts: null`, the two new limits and the two new repository keys. `config.example.yml` documents every new key with placeholder values and says the service starts only with `dryRun: true`.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/config config.example.yml src/eval src/service.test.ts src/main.test.ts
git commit -m "feat: configuration for the app's identity, dry run, the daily limit and review filters"
```

---

### Task 2: Tables and queries

**Files:**
- Create: `src/db/migrations/0002_jobs.sql`, `src/db/jobs.ts`, `src/db/review-runs.ts`, `src/db/heartbeat.ts`
- Modify: `src/db/text.ts`, `src/db/postgres.ts`, `src/db/migrate.ts`, `eslint.config.js` (the `src/db/**` block also forbids `**/engine/**`), `test/boundaries.test.ts` (one case for that rule)
- Test: `src/db/jobs.test.ts`, `src/db/review-runs.test.ts`, `src/db/heartbeat.test.ts`, and the existing tests of `text.ts`, `postgres.ts` and `migrate.ts`

**Interfaces:**
- Consumes: `Db`, `testDb`, `storable`, `PullRequestRef`.
- Produces (the `Job` type is under Shared Types):

```ts
// src/db/text.ts
/** JSON text Postgres accepts as jsonb: every string in `value`, keys included, passed through storable(). */
export function storableJson(value: unknown): string;

// src/db/jobs.ts
/**
 * One pending job per pull request. With none, a job is stored and its id returned. With one: when `replace` is true
 * its reason, head, time and delivery are replaced, its starts go back to 0, its creation time becomes `now` and its id
 * is returned; when `replace` is false it is left as it is and null is returned.
 */
export function enqueueJob(db: Db, j: { ref: PullRequestRef; reason: string; headSha: string; runAt: string; now: string; delivery: string | null; replace: boolean }): Promise<number | null>;
/** Pending jobs whose time is at or before `now`, earliest time first, then lowest id; at most `limit`. */
export function dueJobs(db: Db, now: string, limit: number): Promise<Job[]>;
/** pending and due -> running, counting a start. null when the job is not pending any more or its time is after `now`. */
export function claimJob(db: Db, id: number, now: string): Promise<Job | null>;
/** pending or running -> done or dropped, with its outcome. false when it was already finished. */
export function finishJob(db: Db, id: number, status: 'done' | 'dropped', outcome: string, now: string): Promise<boolean>;
/** running -> pending, due at `runAt`; with `giveBackStart` its count of starts goes down by one. When the pull request already has a pending job, this one is dropped with outcome `superseded` instead, finished at `now`. */
export function requeueJob(db: Db, id: number, runAt: string, now: string, giveBackStart: boolean): Promise<'requeued' | 'superseded'>;
/** Every pending or running job, lowest id first. */
export function unfinishedJobs(db: Db): Promise<Job[]>;
export function getJob(db: Db, id: number): Promise<Job | null>;
/** Deletes done and dropped jobs finished before `before`. Returns how many. */
export function deleteFinishedJobs(db: Db, before: string): Promise<number>;

// src/db/review-runs.ts
export interface RunUsage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
export interface RunRecord {
  ref: PullRequestRef; job: number | null;
  trigger: 'automatic' | 'manual'; mode: 'full'; dryRun: boolean;
  headSha: string; baseSha: string | null;          // baseSha is null when the run failed before the pull request was read
  outcome: 'ok' | 'failed'; failureStage: string | null; failureCode: string | null;
  needsHuman: boolean; highestScore: number;
  body: string;                                     // the review text as it would be posted; '' when none was rendered
  comments: unknown;                                // the inline comments as they would be posted
  result: unknown;                                  // the engine's result
  usage: RunUsage;
  startedAt: string; finishedAt: string;
}
export interface StoredRun extends RunRecord { id: number }
/** Appends one row. Returns its id. */
export function recordRun(db: Db, run: RunRecord): Promise<number>;
/** A pull request's runs, lowest id first. */
export function listRuns(db: Db, ref: PullRequestRef): Promise<StoredRun[]>;
/** The summed cost of the runs started at or after `since`. 0 when there are none. */
export function spentSince(db: Db, since: string): Promise<number>;
/** Whether the pull request has a run with outcome `ok` at this head and this base, of the same kind (dry or live). */
export function hasOkRun(db: Db, ref: PullRequestRef, headSha: string, baseSha: string, dryRun: boolean): Promise<boolean>;

// src/db/heartbeat.ts
/** When the service was last known alive. null before the first beat. */
export function readHeartbeat(db: Db): Promise<string | null>;
export function beat(db: Db, now: string): Promise<void>;

// src/db/postgres.ts
export const POOL_OPTIONS: { max: 5; connectionTimeoutMillis: 5000; statement_timeout: 15000; keepAlive: true; keepAliveInitialDelayMillis: 10000 };
```

The migration:

```sql
create table visto_ai.jobs (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  reason text not null,
  head_sha text not null,
  status text not null,
  outcome text,
  run_at timestamptz not null,
  starts integer not null,
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  delivery text
);
create unique index jobs_one_pending on visto_ai.jobs (service, owner, repo, number) where status = 'pending';
create index jobs_due on visto_ai.jobs (run_at) where status = 'pending';

create table visto_ai.heartbeat (
  only_row boolean primary key default true check (only_row),
  alive_at timestamptz not null
);

create table visto_ai.review_runs (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  job integer,
  trigger text not null,
  mode text not null,
  dry_run boolean not null,
  head_sha text not null,
  base_sha text,
  outcome text not null,
  failure_stage text, failure_code text,
  needs_human boolean not null,
  highest_score integer not null,
  body text not null,
  comments jsonb not null,
  result jsonb not null,
  calls integer not null, input_tokens integer not null, output_tokens integer not null, cached_tokens integer not null,
  cost double precision not null,
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create index review_runs_pull_request on visto_ai.review_runs (service, owner, repo, number);
create index review_runs_started on visto_ai.review_runs (started_at);
```

Three statements whose form is the guard, as plan 3's duplicate check was. Write them this way:

```sql
-- enqueueJob with replace: true. With replace: false the same insert ends in "do nothing returning id", which returns no row when a pending job exists.
insert into visto_ai.jobs (service, owner, repo, number, reason, head_sha, status, run_at, starts, created_at, delivery)
values ($1, $2, $3, $4, $5, $6, 'pending', $7::timestamptz, 0, $8::timestamptz, $9)
on conflict (service, owner, repo, number) where status = 'pending'
do update set reason = excluded.reason, head_sha = excluded.head_sha, run_at = excluded.run_at,
              starts = 0, created_at = excluded.created_at, delivery = excluded.delivery
returning id

-- claimJob
update visto_ai.jobs set status = 'running', starts = starts + 1, started_at = $2::timestamptz
where id = $1 and status = 'pending' and run_at <= $2::timestamptz
returning ...

-- requeueJob, first statement ($3 is 1 to give the start back, else 0)
update visto_ai.jobs j set status = 'pending', run_at = $2::timestamptz, starts = starts - $3
where j.id = $1 and j.status = 'running'
  and not exists (select 1 from visto_ai.jobs p where p.status = 'pending'
                  and p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number)
returning id
```

Why these hold on a real Postgres with several connections, which the in-process database cannot show:

- **A replace against a claim of the same row.** Both are one statement on one row, so one waits for the other. A claim that comes second checks the row again, finds its time in the future and takes nothing. A replace that comes second finds no pending row and inserts a new one.
- **A requeue against a trigger for the same pull request.** `requeueJob` runs its statements outside any transaction. When its first statement returns no row, or is refused with a unique violation (the error's `code` is `23505`), a pending job exists, and its second statement drops this job as `superseded`. This is the one place a statement's error is caught, and it is not inside a transaction.

`owner` and `repo` are stored in lower case, as `savePullRequest` stores them, and text goes through `storable`. `recordRun` passes `comments` and `result` through `storableJson`, and `body` through `storable`.

`postgresDb` builds its pool from `{ connectionString: url, ...POOL_OPTIONS }`. Keep-alive needs its initial delay: without one the operating system waits about two hours before it probes an idle connection. The statement timeout is enforced by the server, so it bounds a slow statement, not a connection that died silently; the keep-alive is what ends that one. `migrate` runs `set local statement_timeout = 0` as the first statement inside each migration's transaction, so the pool's 15 seconds never cut a migration.

- [ ] **Step 1: Write the failing tests**

Shared by the three test files:

```ts
const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
```

`src/db/jobs.test.ts`, with `const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...over })` and a fresh `db = await testDb()` in each test:

```ts
test('a second trigger for a pull request replaces its pending job and starts it afresh', async () => {
  const first = await enqueueJob(db, job());
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [first]);
  const second = await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), delivery: 'd2' }));
  assert.equal(second, first);
  assert.deepEqual(await unfinishedJobs(db), [{
    id: first, ref: REF, reason: 'synchronize', headSha: 'h2', status: 'pending', outcome: null, runAt: at(240), starts: 0, createdAt: at(60),
  }]);
});
test('without replace, a trigger fills a gap and leaves a pending job as it is', async () => {
  const first = await enqueueJob(db, job({ replace: false }));
  assert.notEqual(first, null);
  assert.equal(await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), replace: false })), null);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.headSha, j.runAt]), [[first, 'opened', 'h1', at(0)]]);
});
test('the owner and the repository name are stored in lower case, so two spellings are one pull request', async () => {
  const first = await enqueueJob(db, job({ ref: { ...REF, owner: 'Acme', repo: 'Shop' } }));
  assert.equal(await enqueueJob(db, job()), first);
  assert.deepEqual((await getJob(db, first))?.ref, REF);
});
test('a running job does not stop a new pending job for the same pull request', async () => {
  const id = await enqueueJob(db, job());
  await claimJob(db, id, at(0));
  const next = await enqueueJob(db, job({ headSha: 'h2', runAt: at(5), now: at(5) }));
  assert.notEqual(next, id);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.status]), [[id, 'running'], [next, 'pending']]);
});
test('dueJobs returns pending jobs whose time has come, earliest first, up to the limit', async () => {
  await enqueueJob(db, job({ runAt: at(10) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(5) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 9 }, runAt: at(600) }));
  assert.deepEqual((await dueJobs(db, at(10), 5)).map((j) => j.ref.number), [8, 7]);
  assert.deepEqual((await dueJobs(db, at(10), 1)).map((j) => j.ref.number), [8]);
});
test('claimJob counts a start and succeeds once', async () => {
  const id = await enqueueJob(db, job());
  const claimed = await claimJob(db, id, at(1));
  assert.deepEqual([claimed?.status, claimed?.starts], ['running', 1]);
  assert.equal(await claimJob(db, id, at(2)), null);
});
test('a job replaced to a later time between the look and the claim is not claimed', async () => {
  const id = await enqueueJob(db, job());
  await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(180), now: at(1) }));
  assert.equal(await claimJob(db, id, at(2)), null);
  assert.equal((await getJob(db, id))?.status, 'pending');
});
test('finishJob ends a job once and keeps its outcome', async () => {
  const id = await enqueueJob(db, job());
  assert.equal(await finishJob(db, id, 'dropped', 'stale_head', at(3)), true);
  assert.equal(await finishJob(db, id, 'done', 'reviewed', at(4)), false);
  const j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.outcome], ['dropped', 'stale_head']);
});
test('requeueJob puts a running job back, and gives its start back when asked', async () => {
  const id = await enqueueJob(db, job());
  await claimJob(db, id, at(1));
  assert.equal(await requeueJob(db, id, at(60), at(9), false), 'requeued');
  let j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.starts, j?.runAt], ['pending', 1, at(60)]);
  await claimJob(db, id, at(60));
  assert.equal(await requeueJob(db, id, at(61), at(61), true), 'requeued');
  j = await getJob(db, id);
  assert.equal(j?.starts, 1);
});
test('requeueJob drops the job as superseded when the pull request already has a pending one', async () => {
  const id = await enqueueJob(db, job());
  await claimJob(db, id, at(1));
  const next = await enqueueJob(db, job({ headSha: 'h2', runAt: at(2), now: at(2) }));
  assert.equal(await requeueJob(db, id, at(60), at(9), false), 'superseded');
  const old = await getJob(db, id);
  assert.deepEqual([old?.status, old?.outcome], ['dropped', 'superseded']);
  assert.equal((await getJob(db, next))?.status, 'pending');
});
test('requeueJob treats a unique violation on its first statement as superseded', async () => {
  const texts: string[] = [];
  const fake = { query: async (text: string) => {
    texts.push(text);
    if (texts.length === 1) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    return [];
  } } as unknown as Db;
  assert.equal(await requeueJob(fake, 1, at(0), at(0), false), 'superseded');
  assert.match(texts[1]!, /'dropped'/);
});
test('deleteFinishedJobs removes finished jobs older than the time given and no others', async () => {
  const old = await enqueueJob(db, job());
  await finishJob(db, old, 'done', 'reviewed', at(0));
  const recent = await enqueueJob(db, job({ ref: { ...REF, number: 8 } }));
  await finishJob(db, recent, 'done', 'reviewed', at(100));
  const open = await enqueueJob(db, job({ ref: { ...REF, number: 9 } }));
  assert.equal(await deleteFinishedJobs(db, at(50)), 1);
  assert.deepEqual([await getJob(db, old), (await getJob(db, recent))?.id, (await getJob(db, open))?.id], [null, recent, open]);
});
```

`src/db/review-runs.test.ts`:

```ts
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: 'h1', baseSha: 'b1',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' }], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
test('a run is read back as it was recorded', async () => {
  const id = await recordRun(db, run());
  assert.deepEqual(await listRuns(db, REF), [{ id, ...run() }]);
});
test('a failed run keeps its stage and code, and may have no base', async () => {
  const failed = run({ outcome: 'failed', failureStage: 'prepare', failureCode: 'github_network', baseSha: null, needsHuman: true, highestScore: 100, body: '', comments: [], result: {} });
  const id = await recordRun(db, failed);
  assert.deepEqual(await listRuns(db, REF), [{ id, ...failed }]);
});
test('a run whose text Postgres would refuse is still recorded', async () => {
  const NUL = String.fromCharCode(0);
  const HALF = String.fromCharCode(0xd83d);
  await recordRun(db, run({ body: `a${NUL}b`, comments: [{ body: HALF }], result: { findings: [{ body: `x${NUL}y${HALF}` }] } }));
  const [stored] = await listRuns(db, REF);
  assert.equal(stored!.body, 'ab');
  assert.equal(JSON.stringify(stored!.result).includes('\\u0000'), false);
});
test('hasOkRun finds a finished review of the same head, base and kind, and nothing else', async () => {
  await recordRun(db, run());
  await recordRun(db, run({ headSha: 'h9', outcome: 'failed', failureStage: 'model', failureCode: 'timeout' }));
  assert.deepEqual(await Promise.all([
    hasOkRun(db, REF, 'h1', 'b1', true), hasOkRun(db, REF, 'h1', 'b2', true), hasOkRun(db, REF, 'h1', 'b1', false),
    hasOkRun(db, REF, 'h9', 'b1', true), hasOkRun(db, { ...REF, number: 8 }, 'h1', 'b1', true),
  ]), [true, false, false, false, false]);
});
test('spentSince adds the cost of runs started at or after the time given', async () => {
  assert.equal(await spentSince(db, at(0)), 0);
  await recordRun(db, run({ startedAt: at(-10), usage: { ...run().usage, cost: 4 } }));
  await recordRun(db, run({ startedAt: at(0), usage: { ...run().usage, cost: 0.5 } }));
  await recordRun(db, run({ startedAt: at(100), usage: { ...run().usage, cost: 0.25 } }));
  assert.equal(await spentSince(db, at(0)), 0.75);
});
```

`src/db/heartbeat.test.ts`:

```ts
test('the heartbeat is empty until the first beat, then holds the last one', async () => {
  assert.equal(await readHeartbeat(db), null);
  await beat(db, at(0));
  await beat(db, at(60));
  assert.equal(await readHeartbeat(db), at(60));
});
```

Added to the existing tests of `text.ts`, `postgres.ts` and `migrate.ts`:

```ts
test('storableJson cleans every string, keys included, and leaves other values alone', () => {
  const NUL = String.fromCharCode(0);
  assert.equal(storableJson({ [`k${NUL}`]: [`v${NUL}`, 1, true, null, { n: 0.5 }] }), '{"k":["v",1,true,null,{"n":0.5}]}');
});
test('the pool bounds a statement and keeps its connections alive', () => {
  assert.deepEqual(POOL_OPTIONS, { max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
});
test('a migration switches the statement timeout off for itself', async () => {
  const db = await pgliteDb();
  const seen: string[] = [];
  const spy: Db = { ...db, transaction: (work) => db.transaction((tx) => work({
    ...tx,
    query: (text, params) => { seen.push(text); return tx.query(text, params); },
    script: (sql) => { seen.push(sql); return tx.script(sql); },
  })) };
  await migrate(spy, [{ name: '0001_x', sql: 'create table visto_ai.x (n integer);' }]);
  assert.equal(seen[0], 'set local statement_timeout = 0');
});
```

The existing test of the migration ledger gains `0002_jobs` among the applied names.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the modules and the tables do not exist.

- [ ] **Step 3: Write the migration and the three modules, `storableJson`, `POOL_OPTIONS`, and the line in `migrate`**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/db eslint.config.js test/boundaries.test.ts
git commit -m "feat: tables and queries for jobs, review runs and the heartbeat"
```

---

### Task 3: The instance lock

**Files:**
- Modify: `src/db/types.ts`, `src/db/postgres.ts`
- Test: the existing test file of `src/db/postgres.ts`

**Interfaces:**
- Consumes: `pg`.
- Produces:

```ts
// src/db/types.ts
export interface InstanceLock { release(): Promise<void> }

// src/db/postgres.ts
export interface LockClientLike {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
}
export const INSTANCE_LOCK_KEY = 5684201;
/**
 * Takes the deployment's lock on `client`, which it connects and owns. null, with the client closed, when another
 * instance holds it. `onLost` is called once, and only when the connection ends or fails after the lock was taken
 * and before `release` was called.
 */
export function takeInstanceLockOn(client: LockClientLike, onLost: () => void): Promise<InstanceLock | null>;
/** The same over a connection of its own to `url`. */
export function takeInstanceLock(url: string, onLost: () => void): Promise<InstanceLock | null>;
```

The lock is `select pg_try_advisory_lock($1) as held` with `INSTANCE_LOCK_KEY`. It belongs to the connection, so it is never taken through the pool. The `error` and `end` listeners are attached before `connect`, so a connection that fails has a listener. When `connect` or the statement rejects, the client is closed and the rejection passed on.

A real client emits `end` after its own `end()` too. So three closes are not a loss, and `onLost` must stay silent for each: the close after "another instance holds it", the close after a failed `connect` or statement, and `release`. `release` marks the lock released before it closes the client. In `main`, `onLost` ends the process (Task 11), so a wrong call here would turn a refused second instance, or every clean stop, into a crash.

`takeInstanceLock` is `takeInstanceLockOn(new pg.Client({ connectionString: url, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 5000 }), onLost)`. Without the initial delay the operating system waits about two hours before it probes an idle connection, and a lock session that died silently would keep the lock that long.

- [ ] **Step 1: Write the failing tests**

```ts
function fakeClient(held: boolean | Error) {
  const listeners: Record<'error' | 'end', Array<(e?: Error) => void>> = { error: [], end: [] };
  const calls: string[] = [];
  const emit = (event: 'error' | 'end'): void => { for (const l of listeners[event]) l(event === 'error' ? new Error('gone') : undefined); };
  return {
    calls, emit,
    connect: async (): Promise<void> => { calls.push('connect'); },
    query: async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      calls.push(`${text} ${JSON.stringify(params)}`);
      if (held instanceof Error) throw held;
      return { rows: [{ held }] };
    },
    // Like the real client: closing it emits `end`.
    end: async (): Promise<void> => { calls.push('end'); emit('end'); },
    on: (event: 'error' | 'end', listener: (e?: Error) => void): void => { listeners[event].push(listener); },
  };
}

test('the lock is taken with one statement on its own connection', async () => {
  const client = fakeClient(true);
  assert.notEqual(await takeInstanceLockOn(client, () => {}), null);
  assert.deepEqual(client.calls, ['connect', `select pg_try_advisory_lock($1) as held [${INSTANCE_LOCK_KEY}]`]);
});
test('when another instance holds the lock the answer is null, the connection is closed, and that is not a loss', async () => {
  const client = fakeClient(false);
  let lost = 0;
  assert.equal(await takeInstanceLockOn(client, () => { lost += 1; }), null);
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
test('a statement that fails rejects, the connection is closed, and that is not a loss', async () => {
  const client = fakeClient(new Error('boom'));
  let lost = 0;
  await assert.rejects(takeInstanceLockOn(client, () => { lost += 1; }), /boom/);
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
test('losing the connection after the lock was taken calls onLost once', async () => {
  const client = fakeClient(true);
  let lost = 0;
  await takeInstanceLockOn(client, () => { lost += 1; });
  client.emit('error');
  client.emit('end');
  assert.equal(lost, 1);
});
test('release closes the connection and is not a loss', async () => {
  const client = fakeClient(true);
  let lost = 0;
  const lock = await takeInstanceLockOn(client, () => { lost += 1; });
  await lock!.release();
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the five new tests fail.

- [ ] **Step 3: Implement `takeInstanceLockOn` and `takeInstanceLock`**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/db
git commit -m "feat: a database lock that keeps a second instance out"
```

---

### Task 4: The app's identity

**Files:**
- Create: `src/forge/github/app-auth.ts`
- Test: `src/forge/github/app-auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export interface AppAuth {
  /** A token signed as the app, for the app's own endpoints. */
  appToken(): string;
  /** A token for one installation: the cached one while it has 10 minutes or more left, else a new one. */
  installationToken(installation: string): Promise<string>;
}
export function createAppAuth(opts: { appId: string; privateKey: string; fetch: typeof fetch; clock: () => Date; apiBase?: string }): AppAuth;
```

PM-app-auth, the rules carried over:

- The app token is a JSON Web Token: header `{ "alg": "RS256", "typ": "JWT" }`, payload `{ "iat": now - 60, "exp": now + 540, "iss": appId }` in whole seconds, each part base64url without padding, signed with RSA-SHA256 over `header.payload`.
- A token is minted with `POST <apiBase>/app/installations/<id>/access_tokens`, default `apiBase` `https://api.github.com`, with the headers the project's reads send (`X-GitHub-Api-Version: 2022-11-28`, `User-Agent: visto-ai`, `Accept: application/vnd.github+json`) and `Authorization: Bearer <app token>`. Any 2xx answer with a non-empty `token` text is a token. Its `expires_at`, when missing or not a time, is taken as one hour from now.
- Callers that ask for the same installation while a mint is under way share that mint. A mint that fails is not cached.
- A 5xx answer or a network failure is tried once more, at once, like the project's reads.
- Failures reject with a short code and nothing else: `github_bad_path` for an installation id that is not all digits (no request is sent), `github_<status>` for a refusal, `github_network`, `github_bad_response` for an answer that is not JSON or has no token.

- [ ] **Step 1: Write the failing tests**

```ts
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const NOW = Date.parse('2026-03-01T10:00:00.000Z');
function setup(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let now = NOW;
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer left');
    if (next instanceof Error) throw next;
    return next;
  };
  const auth = createAppAuth({ appId: '12345', privateKey: PEM, clock: () => new Date(now), fetch: stub as typeof fetch });
  return { auth, calls, advance: (ms: number): void => { now += ms; } };
}
const minted = (token: string, expiresAt: string | null): Response =>
  new Response(JSON.stringify(expiresAt === null ? { token } : { token, expires_at: expiresAt }), { status: 201 });
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const MINUTE = 60_000;

test('the app token is an RS256 token for the app, valid from a minute ago for nine more', () => {
  const [h, p, s] = setup([]).auth.appToken().split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(p), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '12345' });
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url'), true);
});
test('an installation token is minted with the app token', async () => {
  const { auth, calls } = setup([minted('t-1', '2026-03-01T11:00:00Z')]);
  assert.equal(await auth.installationToken('99'), 't-1');
  assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/99/access_tokens');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.match(String(new Headers(calls[0]!.init.headers).get('authorization')), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});
test('a token is reused while it has ten minutes or more left', async () => {
  const { auth, calls, advance } = setup([minted('t-1', '2026-03-01T11:00:00Z'), minted('t-2', '2026-03-01T12:00:00Z')]);
  await auth.installationToken('99');
  advance(49 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-1');
  advance(2 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-2');
  assert.equal(calls.length, 2);
});
test('an answer with no expiry is treated as valid for one hour', async () => {
  const { auth, calls, advance } = setup([minted('t-1', null), minted('t-2', null)]);
  await auth.installationToken('99');
  advance(49 * MINUTE);
  await auth.installationToken('99');
  assert.equal(calls.length, 1);
  advance(2 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-2');
});
test('callers that ask together share one mint, and each installation has its own token', async () => {
  const { auth, calls } = setup([minted('t-99', '2026-03-01T11:00:00Z'), minted('t-100', '2026-03-01T11:00:00Z')]);
  assert.deepEqual(await Promise.all([auth.installationToken('99'), auth.installationToken('99')]), ['t-99', 't-99']);
  assert.equal(await auth.installationToken('100'), 't-100');
  assert.equal(calls.length, 2);
});
test('a refused mint rejects with the status as its code, is not cached, and its error holds no token', async () => {
  const { auth, calls } = setup([new Response('{"message":"Bad credentials"}', { status: 401 }), minted('t-1', '2026-03-01T11:00:00Z')]);
  await assert.rejects(auth.installationToken('99'), (e: unknown) => e instanceof Error && e.message === 'github_401');
  assert.equal(await auth.installationToken('99'), 't-1');
  assert.equal(calls.length, 2);
});
test('an answer with no token, or that is not JSON, is refused', async () => {
  await assert.rejects(setup([new Response('{"token":""}', { status: 201 })]).auth.installationToken('99'), /^Error: github_bad_response$/);
  await assert.rejects(setup([new Response('nope', { status: 201 })]).auth.installationToken('99'), /^Error: github_bad_response$/);
});
test('an installation id that is not digits is refused before any request', async () => {
  const { auth, calls } = setup([]);
  await assert.rejects(auth.installationToken('9/9'), /^Error: github_bad_path$/);
  assert.equal(calls.length, 0);
});
test('a server error or a network failure is tried once more', async () => {
  const flaky = setup([new Response('', { status: 502 }), minted('t-1', '2026-03-01T11:00:00Z')]);
  assert.equal(await flaky.auth.installationToken('99'), 't-1');
  await assert.rejects(setup([new Error('down'), new Error('down')]).auth.installationToken('99'), /^Error: github_network$/);
});
test('a key that cannot be read is refused when the app identity is built', () => {
  const noFetch = (async () => new Response('')) as typeof fetch;
  assert.throws(() => createAppAuth({ appId: '12345', privateKey: 'not-a-key-value', clock: () => new Date(NOW), fetch: noFetch }),
    (e: unknown) => e instanceof Error && e.message === 'bad_private_key');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the module does not exist.

- [ ] **Step 3: Implement `createAppAuth`**

`createSign('RSA-SHA256')` signs; nothing else is needed. `createAppAuth` throws `Error('bad_private_key')` at once when the key cannot be read as a private key, so a bad key stops the start and not the first review. That the key is an RSA key is checked when the config is loaded (Task 1).

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/forge/github
git commit -m "feat: the app's token and installation tokens"
```

---

### Task 5: Reading a pull request as it is now

**Files:**
- Create: `src/forge/github/access.ts`
- Modify: `src/forge/types.ts` (`LivePullRequest`, `ForgeAccess`)
- Test: `src/forge/github/access.test.ts`

**Interfaces:**
- Consumes: `AppAuth` (Task 4); `createGithubHttp`, `jsonOf`, `isObject` from `./http.ts`; `createGithubReadSource`; `authorOf` from `./objects.ts`.
- Produces: `export function createGithubAccess(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): ForgeAccess`

`readPullRequest(ref, installation)`:

1. Takes the installation's token and reads `GET /repos/<owner>/<repo>/pulls/<number>`. 404 is `null`. Any other refusal rejects `github_<status>`.
2. From the answer: `title` (text), `body` (text, or `''` when null), the author's login (`authorOf`), `base.ref`, `base.sha`, `head.ref`, `head.sha`, `draft` (boolean), `state` (`open` or `closed`), `merged` (boolean). Anything missing or of another type rejects `github_bad_response`. The state is `merged` when `merged` is true, else the answer's `state`.
3. For an open pull request it reads `GET /repos/<owner>/<repo>/compare/<base.sha>...<head.sha>?per_page=1` and takes `merge_base_commit.sha` as `info.baseSha`: the engine reads the old side of a file at that commit (the comment on `PullRequestInfo.baseSha`). For a closed or merged one no second request is made and `info.baseSha` is `base.sha`; the job drops it anyway.

`info.ref` is the `ref` it was given. `sourceFor(installation)` is `createGithubReadSource` with that installation's token.

- [ ] **Step 1: Write the failing tests**

```ts
const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const PULL = {
  number: 7, title: 'Add things', body: null, state: 'open', merged: false, draft: false,
  user: { login: 'octo-dev', type: 'User' }, base: { ref: 'main', sha: 'base111' }, head: { ref: 'feat', sha: 'head222' },
};
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
/** Answers by "<path and query>"; an unknown one is 404. Records each request's path and Authorization header. */
function github(routes: Record<string, () => Response>) {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url).replace('https://api.github.com', '');
    seen.push({ path, authorization: new Headers(init?.headers).get('authorization') });
    return (routes[path] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, access: createGithubAccess({ auth, fetch: stub as typeof fetch }) };
}
const PULL_PATH = '/repos/acme/shop/pulls/7';
const COMPARE_PATH = '/repos/acme/shop/compare/base111...head222?per_page=1';

test('an open pull request is read with the merge base as its base, using the installation token', async () => {
  const { access, seen } = github({ [PULL_PATH]: () => json(PULL), [COMPARE_PATH]: () => json({ merge_base_commit: { sha: 'merge000' }, files: [] }) });
  assert.deepEqual(await access.readPullRequest(REF, '99'), {
    info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'head222', draft: false },
    state: 'open',
  });
  assert.deepEqual(seen, [{ path: PULL_PATH, authorization: 'Bearer tok-99' }, { path: COMPARE_PATH, authorization: 'Bearer tok-99' }]);
});
test('a merged or closed pull request is read without the merge base', async () => {
  const { access, seen } = github({ [PULL_PATH]: () => json({ ...PULL, state: 'closed', merged: true }) });
  const live = await access.readPullRequest(REF, '99');
  assert.deepEqual([live?.state, live?.info.baseSha, seen.length], ['merged', 'base111', 1]);
});
test('a pull request that is not there is null', async () => {
  assert.equal(await github({}).access.readPullRequest(REF, '99'), null);
});
test('a refusal rejects with the status as its code', async () => {
  const { access } = github({ [PULL_PATH]: () => json({ message: 'Forbidden' }, 403) });
  await assert.rejects(access.readPullRequest(REF, '99'), /^Error: github_403$/);
});
test('an answer of another shape is refused', async () => {
  for (const broken of [{ ...PULL, draft: undefined }, { ...PULL, state: 'weird' }, { ...PULL, head: { ref: 'feat' } }]) {
    await assert.rejects(github({ [PULL_PATH]: () => json(broken) }).access.readPullRequest(REF, '99'), /^Error: github_bad_response$/);
  }
});
test('a compare answer with no merge base is refused', async () => {
  const { access } = github({ [PULL_PATH]: () => json(PULL), [COMPARE_PATH]: () => json({ files: [] }) });
  await assert.rejects(access.readPullRequest(REF, '99'), /^Error: github_bad_response$/);
});
test('sourceFor reads with that installation token', async () => {
  const { access, seen } = github({ '/repos/acme/shop/contents/a.ts?ref=head222': () => new Response('x') });
  const source = await access.sourceFor('99');
  const info = { ref: REF, title: '', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'head222', draft: false };
  assert.equal(await source.getFileContent(info, 'a.ts', 'head222'), 'x');
  assert.equal(seen[0]!.authorization, 'Bearer tok-99');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the module does not exist.

- [ ] **Step 3: Add the two types to `src/forge/types.ts` and implement `createGithubAccess`**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/forge
git commit -m "feat: read a pull request live with an installation token"
```

---

### Task 6: Asking for failed deliveries again

**Files:**
- Create: `src/forge/github/hook-deliveries.ts`, `src/shell/redelivery.ts`
- Modify: `src/forge/types.ts` (`HookDelivery`, `HookDeliveries`)
- Test: `src/forge/github/hook-deliveries.test.ts`, `src/shell/redelivery.test.ts`

**Interfaces:**
- Consumes: `AppAuth` (Task 4).
- Produces:

```ts
// src/forge/github/hook-deliveries.ts
export const MAX_DELIVERY_PAGES = 10;
export function createGithubHookDeliveries(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): HookDeliveries;

// src/shell/redelivery.ts
export const MAX_REDELIVERIES = 200;
export const PACE_MS = 200;
export const RATE_LIMIT_WAIT_MS = 60_000;
/** Ids to send again: for each guid none of whose attempts was ok, its latest attempt; oldest first; at most `cap`. */
export function pickRedeliveries(deliveries: HookDelivery[], cap?: number): string[];
/** Lists, picks and asks. Never rejects. */
export function runRedelivery(
  deps: { hooks: HookDeliveries; sleep: (ms: number) => Promise<void>; log: (entry: Record<string, unknown>) => void },
  since: string,
): Promise<{ picked: number; requested: number; failed: number; complete: boolean; code: string | null }>;
```

PM-redelivery, the rules carried over:

- **Listing.** `GET <apiBase>/app/hook/deliveries?per_page=100` with the app token (`Authorization: Bearer <auth.appToken()>`), then the URL in the `Link` header's `rel="next"` entry, as long as that URL starts with `<apiBase>/app/hook/deliveries?`. A link anywhere else is not followed and the listing is not complete. It stops when a page has no next link, or when the last delivery of a page was made before `since`, or after `MAX_DELIVERY_PAGES` pages with a next link still to follow, which is the one other case where `complete` is false. Deliveries made before `since` are left out.
- **One delivery** is `{ id: String(id), guid, at: <delivered_at as ISO>, ok: 200 <= status_code && status_code < 400 }`. An item without a whole-number `id`, a text `guid`, a time in `delivered_at` or a number in `status_code` rejects `github_bad_response`.
- **Asking again.** `POST <apiBase>/app/hook/deliveries/<id>/attempts` with the app token; any 2xx is done. 429, or 403 with the header `x-ratelimit-remaining: 0`, rejects `github_rate_limited`. Any other answer rejects `github_<status>`. An id that is not all digits rejects `github_bad_path` with no request sent.
- **Picking.** Attempts are grouped by `guid`. A guid with an ok attempt needs nothing. Of the others, the attempt with the latest `at` is picked, the picks are ordered oldest first, and at most 200 are kept.
- **Pacing.** `sleep(PACE_MS)` between two requests. On `github_rate_limited` it sleeps `RATE_LIMIT_WAIT_MS` and tries that id once more; a second rate limit ends the run, and every id not yet asked for counts as failed. Any other failure counts that one id as failed and the run goes on.
- `runRedelivery` logs one entry, `{ event: 'redelivery', listed, picked, requested, failed, complete, code }`. `code` is null, or the code of a listing that failed (then nothing is requested), or `github_rate_limited` when the run was ended by it.

- [ ] **Step 1: Write the failing tests**

`src/forge/github/hook-deliveries.test.ts` uses a stub `fetch` that answers from a queue and records each request's URL, method and `authorization` header, and `const auth: AppAuth = { appToken: () => 'jwt', installationToken: async () => 'unused' }`:

```ts
const item = (id: number, guid: string, deliveredAt: string, statusCode: number) => ({
  id, guid, delivered_at: deliveredAt, redelivery: false, duration: 0.1, status: 'x', status_code: statusCode,
  event: 'pull_request', action: 'opened', installation_id: 99, repository_id: 1,
});
const page = (items: unknown[], next?: string): Response =>
  new Response(JSON.stringify(items), { status: 200, headers: next === undefined ? {} : { link: `<${next}>; rel="next"` } });
const FIRST = 'https://api.github.com/app/hook/deliveries?per_page=100';
const SECOND = 'https://api.github.com/app/hook/deliveries?per_page=100&cursor=c2';

test('deliveries are listed with the app token, following the next link', async () => {
  const { hooks, calls } = setup([
    page([item(12, 'g2', '2026-03-01T10:06:00Z', 503)], SECOND),
    page([item(11, 'g1', '2026-03-01T10:05:00Z', 202)]),
  ]);
  assert.deepEqual(await hooks.listSince('2026-03-01T10:00:00.000Z'), {
    deliveries: [
      { id: '12', guid: 'g2', at: '2026-03-01T10:06:00.000Z', ok: false },
      { id: '11', guid: 'g1', at: '2026-03-01T10:05:00.000Z', ok: true },
    ],
    complete: true,
  });
  assert.deepEqual(calls.map((c) => [c.url, c.authorization]), [[FIRST, 'Bearer jwt'], [SECOND, 'Bearer jwt']]);
});
test('the listing stops at the page whose last delivery is older than asked for, and leaves older ones out', async () => {
  const { hooks, calls } = setup([page([item(12, 'g2', '2026-03-01T10:06:00Z', 503), item(11, 'g1', '2026-03-01T09:00:00Z', 503)], SECOND)]);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.deliveries.map((d) => d.id), listed.complete, calls.length], [['12'], true, 1]);
});
test('the listing stops after ten pages and says it is not complete', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => page([item(100 - i, `g${i}`, '2026-03-01T10:06:00Z', 503)], `${FIRST}&cursor=c${i}`));
  const { hooks, calls } = setup(pages);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.deliveries.length, listed.complete, calls.length], [10, false, 10]);
});
test('a next link that leaves the deliveries listing is not followed', async () => {
  const { hooks, calls } = setup([page([item(12, 'g2', '2026-03-01T10:06:00Z', 503)], 'https://elsewhere.example.test/app/hook/deliveries?cursor=c2')]);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.complete, calls.length], [false, 1]);
});
test('a delivery is ok when its status code is from 200 to 399', async () => {
  const { hooks } = setup([page([200, 202, 399, 0, 400, 503].map((code, i) => item(i + 1, `g${i}`, '2026-03-01T10:06:00Z', code)))]);
  assert.deepEqual((await hooks.listSince('2026-03-01T10:00:00.000Z')).deliveries.map((d) => d.ok), [true, true, true, false, false, false]);
});
test('an item of another shape is refused', async () => {
  await assert.rejects(setup([page([{ id: 'x' }])]).hooks.listSince('2026-03-01T10:00:00.000Z'), /^Error: github_bad_response$/);
});
test('redeliver posts to the attempts of that delivery', async () => {
  const { hooks, calls } = setup([new Response('{}', { status: 202 })]);
  await hooks.redeliver('11');
  assert.deepEqual([calls[0]!.url, calls[0]!.method, calls[0]!.authorization], ['https://api.github.com/app/hook/deliveries/11/attempts', 'POST', 'Bearer jwt']);
});
test('a rate limit has its own code, and any other refusal carries its status', async () => {
  await assert.rejects(setup([new Response('', { status: 429 })]).hooks.redeliver('11'), /^Error: github_rate_limited$/);
  await assert.rejects(setup([new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })]).hooks.redeliver('11'), /^Error: github_rate_limited$/);
  await assert.rejects(setup([new Response('', { status: 422 })]).hooks.redeliver('11'), /^Error: github_422$/);
});
test('a delivery id that is not digits is refused before any request', async () => {
  const { hooks, calls } = setup([]);
  await assert.rejects(hooks.redeliver('1/1'), /^Error: github_bad_path$/);
  assert.equal(calls.length, 0);
});
```

`src/shell/redelivery.test.ts`, with `at` as in Task 2 and `const d = (id: string, guid: string, seconds: number, ok: boolean): HookDelivery => ({ id, guid, at: at(seconds), ok })`:

```ts
test('each delivery that never succeeded is picked once, by its latest attempt, oldest first', () => {
  assert.deepEqual(pickRedeliveries([
    d('5', 'g3', 50, false), d('4', 'g2', 40, true), d('3', 'g2', 30, false), d('2', 'g1', 20, false), d('1', 'g1', 10, false),
  ]), ['2', '5']);
});
test('at most the cap is picked, the oldest', () => {
  assert.deepEqual(pickRedeliveries([d('3', 'g3', 30, false), d('2', 'g2', 20, false), d('1', 'g1', 10, false)], 2), ['1', '2']);
});
test('redeliveries are paced, counted and logged', async () => {
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 2, failed: 0, complete: true, code: null });
  assert.deepEqual([h.asked, h.slept], [['1', '2'], [PACE_MS]]);
  assert.deepEqual(h.logged, [{ event: 'redelivery', listed: 2, picked: 2, requested: 2, failed: 0, complete: true, code: null }]);
});
test('a rate limit is waited out once', async () => {
  const h = harness({ deliveries: [d('1', 'g1', 10, false)], complete: true }, { '1': [new Error('github_rate_limited')] });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 1, requested: 1, failed: 0, complete: true, code: null });
  assert.deepEqual([h.asked, h.slept], [['1', '1'], [RATE_LIMIT_WAIT_MS]]);
});
test('a second rate limit ends the run, and what was not asked for counts as failed', async () => {
  const limited = [new Error('github_rate_limited'), new Error('github_rate_limited')];
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true }, { '1': limited });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 0, failed: 2, complete: true, code: 'github_rate_limited' });
  assert.deepEqual(h.asked, ['1', '1']);
});
test('one delivery that cannot be sent again does not stop the others', async () => {
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true }, { '1': [new Error('github_422')] });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 1, failed: 1, complete: true, code: null });
});
test('a listing that fails is logged with its code and nothing is asked for', async () => {
  const h = harness(new Error('github_401'));
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 0, requested: 0, failed: 0, complete: false, code: 'github_401' });
  assert.deepEqual(h.asked, []);
});
```

`harness(listing, failures?)` builds a fake `HookDeliveries` whose `listSince` returns or rejects with `listing`, and whose `redeliver(id)` records the id in `asked` and rejects with the next error queued for that id, if any; `sleep` records its argument in `slept`; `log` records in `logged`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the modules do not exist.

- [ ] **Step 3: Add the two types to `src/forge/types.ts`, then implement the two modules**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/forge src/shell
git commit -m "feat: ask the git service for failed deliveries again"
```

---

### Task 7: What an event queues

**Files:**
- Create: `src/shell/triggers.ts`
- Modify: `src/shell/receive.ts`, `src/service.ts` (it builds the receiver's dependencies)
- Test: `src/shell/triggers.test.ts`, and a new `src/shell/receive-jobs.test.ts`, kept apart from `receive.test.ts` so that its helpers do not collide with that file's. `src/shell/receive.test.ts` and `src/service.test.ts` are updated for the two new dependencies and, where they assert the whole log entry of an accepted pull request delivery, for its two new fields.

**Interfaces:**
- Consumes: `PullRequestAction`, `PullRequestFacts`, `RepoSettings` (Task 1), `enqueueJob` (Task 2), `savePullRequest`, `getPullRequest`.
- Produces:

```ts
// src/shell/triggers.ts
export const QUIET_SECONDS = 180;
export type SkipReason = 'closed' | 'draft' | 'ignored_author' | 'base_filtered';
export type TriggerReason = 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'retargeted';
export type Trigger =
  | { kind: 'queue'; reason: TriggerReason; headSha: string; delaySeconds: number }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'none' };
/** Why no automatic review is wanted for a pull request in this state; null when one is. Checked in this order: any state but open (`closed`), draft, ignored author, base branch. */
export function skipReason(
  pr: { state: 'open' | 'closed' | 'merged'; draft: boolean; author: string; baseBranch: string }, settings: RepoSettings,
): SkipReason | null;
/** What a pull request event asks for. `facts` are the newest the service has for the pull request: the event's own, or the stored ones when the event is older than what is stored. */
export function triggerOf(action: PullRequestAction, facts: PullRequestFacts, settings: RepoSettings): Trigger;

// src/shell/receive.ts
export interface ReceiveDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  settingsFor: (fullName: string) => RepoSettings;   // "owner/name"
  onQueued: () => void;                              // called after the commit, once per delivery that stored or replaced a job
}
```

The rules (8.1, PM-debounce):

- Only the five reasons queue. The actions `closed` and `other` are `{ kind: 'none' }`.
- `skipReason` on `facts` comes first. An ignored author is matched without regard to letter case. `baseBranches` empty lets every branch through; otherwise the base branch must be in the list, compared exactly.
- A push (`synchronize`) waits `QUIET_SECONDS`. Every other reason has no delay. The head is `facts.headSha`.

In `receive`, for a `pull_request` event, inside the transaction that records the delivery and after `savePullRequest`:

- When `savePullRequest` answered true, the newest facts are the event's, and a job it queues **replaces** the pull request's pending job (`replace: true`): a second push moves the one pending job to its own head and time.
- When it answered false, the event is older than what is stored. The facts are then read back with `getPullRequest(tx, ref)`, and a job it queues only **fills a gap** (`replace: false`): it is stored when the pull request has no pending job and changes nothing when it has one.

An older event must still be able to queue. Any later event of the same pull request, a label or a new title for example, can be stored first, and the push it followed would otherwise queue nothing: no job for that head would ever exist. And it must not replace, or a late `opened` would cut the quiet period of a newer push.

The job's `runAt` is the receiving time plus the delay, its `now` the receiving time, its `delivery` the delivery id.

The `webhook` log entry of an accepted `pull_request` delivery gains two fields: `job` (`'queued'` for a job stored or replaced with no delay, `'delayed'` for one with a delay, null when none was) and `skip` (the skip reason, or null). No other entry changes. `onQueued` is called after the commit when `job` is not null, and what it throws is ignored.

- [ ] **Step 1: Write the failing tests**

`src/shell/triggers.test.ts`, with `REF` and `at` as in Task 2:

```ts
const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [] };
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});

test('opening, reopening, marking ready and retargeting queue a review at once; a push after the quiet period', () => {
  for (const action of ['opened', 'reopened', 'ready_for_review', 'retargeted'] as const) {
    assert.deepEqual(triggerOf(action, facts(), SETTINGS), { kind: 'queue', reason: action, headSha: 'h1', delaySeconds: 0 });
  }
  assert.deepEqual(triggerOf('synchronize', facts(), SETTINGS), { kind: 'queue', reason: 'synchronize', headSha: 'h1', delaySeconds: 180 });
});
test('a close and any other action ask for nothing', () => {
  assert.deepEqual(triggerOf('closed', facts({ state: 'closed' }), SETTINGS), { kind: 'none' });
  assert.deepEqual(triggerOf('other', facts(), SETTINGS), { kind: 'none' });
});
test('the filters, in their order: closed, draft, ignored author, base branch', () => {
  assert.deepEqual(triggerOf('reopened', facts({ state: 'merged', draft: true }), SETTINGS), { kind: 'skip', reason: 'closed' });
  assert.deepEqual(triggerOf('opened', facts({ draft: true, author: 'dependabot[bot]' }), SETTINGS), { kind: 'skip', reason: 'draft' });
  assert.deepEqual(triggerOf('opened', facts({ author: 'Dependabot[bot]' }), SETTINGS), { kind: 'skip', reason: 'ignored_author' });
  assert.deepEqual(triggerOf('opened', facts(), { ...SETTINGS, baseBranches: ['release'] }), { kind: 'skip', reason: 'base_filtered' });
  assert.equal(triggerOf('opened', facts(), { ...SETTINGS, baseBranches: ['main'] }).kind, 'queue');
});
```

`src/shell/receive-jobs.test.ts`. It has `REF`, `at`, `SETTINGS` and `facts` as above, and `const pr = (action: PullRequestAction, over: Partial<PullRequestFacts> = {}): ForgeEvent => ({ kind: 'pull_request', action, facts: facts(over) })`. Before each test it makes a fresh `db = await testDb()`, sets `now = at(0)` (the clock is `() => new Date(now)`), empties `logged`, sets `queued = 0` and `onQueued = () => { queued += 1; }`. `deliver(event, delivery, database = db)` calls `receive` with a reader stub that returns `{ ok: true, delivery, name: 'pull_request', action: event.action, event }`, `settingsFor: () => SETTINGS`, the clock, a `log` that pushes into `logged`, and `onQueued: () => onQueued()`:

```ts
test('an opened pull request stores a job due now and wakes the runner', async () => {
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual([job!.ref, job!.reason, job!.headSha, job!.runAt, job!.status], [REF, 'opened', 'h1', at(0), 'pending']);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.skip, queued], ['queued', null, 1]);
});
test('a push stores a job due after the quiet period', async () => {
  await deliver(pr('synchronize'), 'd1');
  assert.equal((await unfinishedJobs(db))[0]!.runAt, at(180));
  assert.equal(logged.at(-1)!.job, 'delayed');
});
test('two pushes leave one job, of the second head, timed from the second push', async () => {
  await deliver(pr('synchronize'), 'd1');
  now = at(60);
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(60) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.runAt]), [['h2', at(240)]]);
});
test('a draft stores the pull request and no job', async () => {
  await deliver(pr('opened', { draft: true }), 'd1');
  assert.notEqual(await getPullRequest(db, REF), null);
  assert.deepEqual([await unfinishedJobs(db), logged.at(-1)!.job, logged.at(-1)!.skip, queued], [[], null, 'draft', 0]);
});
test('an event that arrives after a later one still queues, from the stored facts', async () => {
  await deliver(pr('other', { updatedAt: at(2) }), 'd1');            // a label, stored first
  await deliver(pr('synchronize', { updatedAt: at(0) }), 'd2');      // the push it followed
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.reason, j.headSha, j.runAt]), [['synchronize', 'h1', at(180)]]);
  assert.deepEqual([logged.at(-1)!.job, queued], ['delayed', 1]);
});
test('an older event never replaces the job of a newer one', async () => {
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(5) }), 'd1');
  await deliver(pr('opened', { updatedAt: at(0) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.reason, j.headSha, j.runAt]), [['synchronize', 'h2', at(180)]]);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.skip, queued], [null, null, 1]);
});
test('an older event is filtered by the stored state, not by its own', async () => {
  await deliver(pr('opened', { draft: true, updatedAt: at(100) }), 'd1');
  await deliver(pr('ready_for_review', { updatedAt: at(50) }), 'd2');
  assert.deepEqual([await unfinishedJobs(db), logged.at(-1)!.skip], [[], 'draft']);
});
test('the same delivery twice queues once', async () => {
  await deliver(pr('opened'), 'd1');
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'duplicate' });
  assert.deepEqual([(await unfinishedJobs(db)).length, queued], [1, 1]);
});
test('when the job cannot be stored nothing of the delivery is stored', async () => {
  const failing: Db = { ...db, transaction: (work) => db.transaction((tx) => work({
    ...tx, query: (text, params) => (text.includes('visto_ai.jobs') ? Promise.reject(new Error('refused')) : tx.query(text, params)),
  })) };
  assert.deepEqual(await deliver(pr('opened'), 'd1', failing), { status: 503, body: 'storage_unavailable' });
  assert.equal(await getPullRequest(db, REF), null);
  assert.deepEqual(await db.query('select id from visto_ai.deliveries'), []);
  assert.equal(queued, 0);
});
test('an onQueued that throws changes nothing about the answer', async () => {
  onQueued = () => { throw new Error('boom'); };
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail; the existing tests of `receive` and of the service fail to compile until their dependencies gain the two new fields.

- [ ] **Step 3: Implement `triggers.ts`, change `receive.ts`, and give `src/service.ts` and the existing tests the two new dependencies**

Until Task 11, `src/service.ts` passes `settingsFor: (name) => repoSettingsFor(config, name)` and `onQueued: () => {}`.

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/shell src/service.ts src/service.test.ts
git commit -m "feat: a pull request event stores a review job with its delivery"
```

---

### Task 8: The runner

**Files:**
- Create: `src/shell/runner.ts`
- Test: `src/shell/runner.test.ts`

**Interfaces:**
- Consumes: `dueJobs`, `claimJob`, `finishJob`, `Job` (Task 2).
- Produces:

```ts
export const MAX_STARTS = 3;
export const MAX_AGE_MS = 24 * 3_600_000;
export interface RunnerDeps {
  db: Db; concurrency: number; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  /** false: start nothing now. */
  mayStart: () => Promise<boolean>;
  /** Takes one claimed job to its end and writes its outcome. */
  run: (job: Job) => Promise<void>;
}
export interface Runner {
  /** Starts due jobs while there is a free place. Resolves when the claims are made, not when the jobs end. A call made while one is under way is folded into one more pass, and resolves when that pass has ended. */
  tick(): Promise<void>;
  /** From now on nothing is started. Resolves when the pass under way, if any, has ended and no job is running. */
  drain(): Promise<void>;
  running(): number;
}
export function createRunner(deps: RunnerDeps): Runner;
```

PM-queue and 8.2, the rules:

- One pass: when draining, or with no free place, it does nothing. Otherwise it asks `mayStart`; false, or a rejection (logged as `{ event: 'gate_failed', error, code }`), ends the pass. Then it reads `dueJobs(db, now, concurrency)` and goes through them in order. Draining is checked again before each claim.
- A job whose pull request has a job running in this process is passed over, so a later pull request overtakes it. The key is `service/owner/repo#number`, built from the job row.
- A job created more than `MAX_AGE_MS` before now is finished as `dropped` with outcome `too_old`. Otherwise a job with `starts >= MAX_STARTS` is finished as `dropped` with outcome `attempts_exhausted`. Either is logged as `{ event: 'job', job, repo, number, outcome: 'dropped', reason }` and not run (PM-jobs: too old is judged before the starts). These two rules are also what start-up relies on: recovery only puts jobs back (Task 11).
- Otherwise it is claimed with `claimJob`. A claim that returns null is passed over. A claimed job is run without being awaited, and it is run as `claimJob` returned it, not as `dueJobs` listed it: a trigger may have replaced its head in between.
- The pass repeats while it started or dropped something and a place is free.
- When a job's `run` ends, its place is freed and a pass is started. When `run` rejects, the job is finished as `done` with outcome `failed`, and `{ event: 'job', job, repo, number, outcome: 'failed', reason: 'internal_error', error }` is logged, `error` being the error's name. In every entry of the runner, `repo` is `owner/name`.
- A database error in a pass is logged as `{ event: 'runner_failed', error, code }` and the pass ends. `tick` never rejects.

- [ ] **Step 1: Write the failing tests**

With `REF`, `at` and `job` as in Task 2, and:

```ts
function harness(over: Partial<RunnerDeps> = {}) {
  const started: Job[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const ends = new Map<string, () => void>();          // by "<number> <head>"
  const state = { now: at(600) };
  const runner = createRunner({
    db, concurrency: 2, clock: () => new Date(state.now), log: (e) => { logged.push(e); }, mayStart: async () => true,
    run: (j) => new Promise<void>((end) => { started.push(j); ends.set(`${j.ref.number} ${j.headSha}`, end); }),
    ...over,
  });
  /** Lets the runner notice a job's end, then runs one more pass. */
  const next = async (): Promise<void> => { await new Promise((r) => setImmediate(r)); await runner.tick(); };
  return { runner, started, logged, state, end: (key: string): void => { ends.get(key)!(); }, next };
}
const numbers = (jobs: Job[]): number[] => jobs.map((j) => j.ref.number);

test('due jobs start up to the concurrency, and the next starts when one ends', async () => {
  for (const n of [7, 8, 9]) await enqueueJob(db, job({ ref: { ...REF, number: n }, runAt: at(n) }));
  const h = harness();
  await h.runner.tick();
  assert.deepEqual([numbers(h.started), h.runner.running()], [[7, 8], 2]);
  h.end('7 h1');
  await h.next();
  assert.deepEqual(numbers(h.started), [7, 8, 9]);
});
test('a pull request never has two jobs running, and a later pull request is not held up', async () => {
  const h = harness();
  await enqueueJob(db, job());
  await h.runner.tick();
  await enqueueJob(db, job({ headSha: 'h2', runAt: at(1), now: at(1) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(2), now: at(2) }));
  await h.runner.tick();
  assert.deepEqual(h.started.map((j) => `${j.ref.number} ${j.headSha}`), ['7 h1', '8 h1']);
  h.end('7 h1');
  await h.next();
  assert.deepEqual(h.started.map((j) => `${j.ref.number} ${j.headSha}`), ['7 h1', '8 h1', '7 h2']);
});
test('a job is not started before its time', async () => {
  const h = harness();
  h.state.now = at(0);
  await enqueueJob(db, job({ runAt: at(180) }));
  await h.runner.tick();
  assert.deepEqual(h.started, []);
  h.state.now = at(180);
  await h.runner.tick();
  assert.deepEqual(numbers(h.started), [7]);
});
test('nothing starts while mayStart says no, and no start is counted', async () => {
  const id = await enqueueJob(db, job());
  const h = harness({ mayStart: async () => false });
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([h.started.length, j?.status, j?.starts], [0, 'pending', 0]);
});
test('a mayStart that rejects is treated as no and logged', async () => {
  await enqueueJob(db, job());
  const h = harness({ mayStart: () => Promise.reject(new Error('db down')) });
  await h.runner.tick();
  assert.deepEqual([h.started.length, h.logged[0]!.event], [0, 'gate_failed']);
});
test('a job that is out of starts is dropped and not run, and the next one runs', async () => {
  const id = await enqueueJob(db, job());
  await db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(1) }));
  const h = harness({ concurrency: 1 });
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([numbers(h.started), j?.status, j?.outcome], [[8], 'dropped', 'attempts_exhausted']);
});
test('a job more than a day old is dropped and not run', async () => {
  const id = await enqueueJob(db, job({ now: at(-90_000), runAt: at(-90_000) }));
  const h = harness();
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([h.started.length, j?.status, j?.outcome], [0, 'dropped', 'too_old']);
  assert.deepEqual(h.logged, [{ event: 'job', job: id, repo: 'acme/shop', number: 7, outcome: 'dropped', reason: 'too_old' }]);
});
test('a run that rejects ends the job as failed and the runner goes on', async () => {
  const id = await enqueueJob(db, job());
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(1) }));
  const ran: number[] = [];
  const h = harness({ concurrency: 1, run: async (j) => { ran.push(j.ref.number); if (j.ref.number === 7) throw new TypeError('private detail'); } });
  await h.runner.tick();
  await h.next();
  const j = await getJob(db, id);
  assert.deepEqual([ran, j?.status, j?.outcome], [[7, 8], 'done', 'failed']);
  assert.equal(JSON.stringify(h.logged).includes('private detail'), false);
});
test('ticks that overlap never start more than the concurrency', async () => {
  for (const n of [7, 8, 9, 10, 11]) await enqueueJob(db, job({ ref: { ...REF, number: n } }));
  const h = harness();
  await Promise.all([h.runner.tick(), h.runner.tick(), h.runner.tick()]);
  assert.equal(h.started.length, 2);
});
test('after drain nothing starts, and drain resolves when the running jobs have ended', async () => {
  for (const n of [7, 8, 9]) await enqueueJob(db, job({ ref: { ...REF, number: n }, runAt: at(n) }));
  const h = harness();
  await h.runner.tick();
  let drained = false;
  const draining = h.runner.drain().then(() => { drained = true; });
  h.end('7 h1');
  await h.next();
  assert.deepEqual([numbers(h.started), drained], [[7, 8], false]);
  h.end('8 h1');
  await draining;
  assert.equal(h.runner.running(), 0);
});
test('a database failure in a pass is logged and the next pass works', async () => {
  await enqueueJob(db, job());
  let fail = true;
  const flaky: Db = { ...db, query: (text, params) => (fail ? Promise.reject(Object.assign(new Error('gone'), { code: '57P01' })) : db.query(text, params)) };
  const h = harness({ db: flaky });
  await h.runner.tick();
  assert.deepEqual([h.started.length, h.logged[0]!.event, h.logged[0]!.code], [0, 'runner_failed', '57P01']);
  fail = false;
  await h.runner.tick();
  assert.deepEqual(numbers(h.started), [7]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the module does not exist.

- [ ] **Step 3: Implement `createRunner`**

One promise holds the pass under way and one flag says another was asked for; that is the whole of the folding.

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/shell
git commit -m "feat: a runner that claims due jobs, never two for one pull request"
```

---

### Task 9: Pauses and alerts

**Files:**
- Create: `src/shell/alerts.ts`, `src/shell/model-health.ts`, `src/shell/spend.ts`
- Test: `src/shell/alerts.test.ts`, `src/shell/model-health.test.ts`, `src/shell/spend.test.ts`

**Interfaces:**
- Consumes: `spentSince` (Task 2).
- Produces:

```ts
// src/shell/alerts.ts
/** `details` never has a key named `event`, `code` or `at`: the log entry keeps those for itself. */
export type Alert = (code: string, details?: Record<string, string | number | boolean | null>) => void;
export const ALERT_TIMEOUT_MS = 5_000;
/** `alert` never throws and returns at once. `settled` resolves when no post is under way. */
export function createAlerts(deps: { webhook: string | null; fetch: typeof fetch; clock: () => Date; log: (entry: Record<string, unknown>) => void }): { alert: Alert; settled(): Promise<void> };

// src/shell/model-health.ts
export const PAUSE_MS = 300_000;
export const KEY_CHECK_TIMEOUT_MS = 10_000;
export type KeyCheck = 'ok' | 'auth' | 'no_credit' | 'unknown';
/** Asks the model endpoint whether the key works. Never rejects. */
export function checkModelKey(model: { baseUrl: string; apiKey: string; extraHeaders: Record<string, string> }, io: { fetch: typeof fetch }): Promise<KeyCheck>;
export interface ModelHealth {
  paused(now: Date): boolean;
  /** What a key check found. */
  checked(result: KeyCheck, now: Date): void;
  /** How a review ended: `auth` or `no_credit`, or null when the model answered it. */
  reviewed(code: 'auth' | 'no_credit' | null, now: Date): void;
}
export function createModelHealth(alert: Alert): ModelHealth;

// src/shell/spend.ts
export const WARN_SHARE = 0.8;
export type SpendLevel = 'ok' | 'warn' | 'limit';
export function createSpendGuard(deps: { db: Db; limit: number; clock: () => Date; alert: Alert }): {
  /** Today's level, from the cost of the runs recorded since the start of the UTC day. Rejects when the database does. */
  level(): Promise<SpendLevel>;
  /** One run's usage: tokens with no cost raise `cost_unknown`, once per process. */
  noteRun(usage: { inputTokens: number; outputTokens: number; cost: number }): void;
};
```

**Alerts (14).** `alert(code, details)` first logs `{ event: 'alert', code, ...details }`. With a webhook it then posts `{ "source": "visto-ai", "code": code, "at": <now as ISO>, "details": details }` as JSON, `details` being `{}` when none was given, with `redirect: 'manual'` and a time limit of `ALERT_TIMEOUT_MS`. An answer outside 2xx, a failure or a timeout is logged as `{ event: 'alert_failed', code, status }`, `status` being the answer's status or null. The webhook's address is never logged. A logger that throws stops neither the post nor the caller. What an alert says about a failure goes under the key `reason`, never `code`: spread into the log entry, a detail named `code` would replace the alert's own name.

**The key check (calls 11 and 12).** `GET <baseUrl without trailing slashes>/key` with the headers of `extraHeaders`, then `Authorization: Bearer <apiKey>` (an extra header never replaces it), and a time limit of `KEY_CHECK_TIMEOUT_MS`. 401 is `auth`. 402 is `no_credit`. 200 is `no_credit` when the body is JSON whose `data.limit_remaining` is a number at or below 0, and `ok` otherwise, also when the body is not JSON. Every other answer, a failure and a timeout are `unknown`.

**The model's health.** It holds whether a failure stands, that failure's code and who saw it (`review` or `check`), the time until which reviews are paused, and whether the key check is still trusted (at first it is).

- **A review's failure** (`reviewed('auth' | 'no_credit')`) always becomes the standing failure, seen by `review`, and pauses until `now + PAUSE_MS`. It raises `model_error` with `{ reason: <the code>, seen_by: 'review' }` when no failure stood or the standing one had another code.
- **A check's failure** (`checked('auth' | 'no_credit')`) counts only when no failure stands and the check is trusted. It then becomes the standing failure, seen by `check`, pauses until `now + PAUSE_MS` and raises `model_error` with `seen_by: 'check'`. In every other case it changes nothing: a check starts a pause once and never extends one.
- **`reviewed(null)`** clears a standing failure, ends the pause and raises `model_ok`. If that failure was seen by a check, the check was wrong about this endpoint, and it is not trusted for the rest of the process. With no failure standing it does nothing.
- **`checked('ok')`** clears a standing failure, ends the pause and raises `model_ok`, but only when that failure was seen by a check. A key that passes the check says nothing about a failure a review met: the check cannot see the account's credit.
- **`checked('unknown')`** changes nothing.
- **`paused(now)`** is true until the pause time. After it, the next review is the test, whatever a check says.

So a pause can never hold for good on the word of the check alone: when it is over, one job tries the model.

**The daily limit (12, call 9).** The spend is `spentSince(db, <start of the UTC day of clock()>)`. At or above `limit` the level is `limit`; at or above `WARN_SHARE * limit` it is `warn`. `spend_limit` and `spend_80` are each raised once per UTC day, with `{ spent, limit }`, `spent` rounded to cents. A day that goes straight to the limit raises `spend_limit` only.

- [ ] **Step 1: Write the failing tests**

`src/shell/alerts.test.ts`. `setup(webhook, answer, log?)` builds the alerts over a stub `fetch` that records `{ url, init }` in `calls` and answers with `answer` (a `Response`, or an `Error` to reject), a clock fixed at `2026-03-01T10:00:00.000Z`, and a `log` that records in `logged` unless the third argument gives another:

```ts
test('an alert is logged, and posted as JSON when a webhook is set', async () => {
  const h = setup('https://alerts.example.test/in', new Response('', { status: 200 }));
  h.alert('spend_limit', { spent: 50.25, limit: 50 });
  await h.settled();
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'spend_limit', spent: 50.25, limit: 50 }]);
  assert.deepEqual([h.calls[0]!.url, h.calls[0]!.init.method, JSON.parse(String(h.calls[0]!.init.body))], [
    'https://alerts.example.test/in', 'POST',
    { source: 'visto-ai', code: 'spend_limit', at: '2026-03-01T10:00:00.000Z', details: { spent: 50.25, limit: 50 } },
  ]);
});
test('an alert that names a reason keeps its own code in the log', async () => {
  const h = setup(null, new Response(''));
  h.alert('model_error', { reason: 'auth', seen_by: 'review' });
  await h.settled();
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'model_error', reason: 'auth', seen_by: 'review' }]);
});
test('with no webhook an alert is a log line only', async () => {
  const h = setup(null, new Response(''));
  h.alert('model_ok');
  await h.settled();
  assert.deepEqual([h.logged, h.calls.length], [[{ event: 'alert', code: 'model_ok' }], 0]);
});
test('a webhook that refuses or cannot be reached is logged without its address, and nothing is thrown', async () => {
  for (const [answer, status] of [[new Response('', { status: 500 }), 500], [new Error('down'), null]] as const) {
    const h = setup('https://alerts.example.test/in', answer);
    h.alert('model_error', { reason: 'auth' });
    await h.settled();
    assert.deepEqual(h.logged.at(-1), { event: 'alert_failed', code: 'model_error', status });
    assert.equal(JSON.stringify(h.logged).includes('alerts.example.test'), false);
  }
});
test('a logger that throws stops neither the post nor the caller', async () => {
  const h = setup('https://alerts.example.test/in', new Response(''), () => { throw new Error('log'); });
  h.alert('model_ok');
  await h.settled();
  assert.equal(h.calls.length, 1);
});
```

`src/shell/model-health.test.ts`, with `const t = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000)`. Before each test `alerts` is emptied and `health = createModelHealth((code, details) => { alerts.push([code, details ?? {}]); })` is made anew:

```ts
test('the key check asks the key route of the model endpoint, with the extra headers and the key as a bearer token', async () => {
  const calls: Array<{ url: string; authorization: string | null; team: string | null }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), team: headers.get('x-team') });
    return new Response('{"data":{"limit_remaining":12.5}}');
  };
  const model = { baseUrl: 'https://models.example.test/v1/', apiKey: 'k', extraHeaders: { 'x-team': 'a', Authorization: 'Bearer other' } };
  assert.equal(await checkModelKey(model, { fetch: stub as typeof fetch }), 'ok');
  assert.deepEqual(calls, [{ url: 'https://models.example.test/v1/key', authorization: 'Bearer k', team: 'a' }]);
});
test('what each answer of the key route means', async () => {
  const cases: Array<[Response | Error, KeyCheck]> = [
    [new Response('', { status: 401 }), 'auth'], [new Response('', { status: 402 }), 'no_credit'],
    [new Response('{"data":{"limit_remaining":0}}'), 'no_credit'], [new Response('{"data":{"limit_remaining":null}}'), 'ok'],
    [new Response('not json'), 'ok'], [new Response('', { status: 404 }), 'unknown'], [new Response('', { status: 500 }), 'unknown'],
    [new Error('down'), 'unknown'],
  ];
  for (const [answer, expected] of cases) {
    const stub = async (): Promise<Response> => { if (answer instanceof Error) throw answer; return answer; };
    assert.equal(await checkModelKey({ baseUrl: 'https://models.example.test/v1', apiKey: 'k', extraHeaders: {} }, { fetch: stub as typeof fetch }), expected);
  }
});
test('a review that meets a rejected key pauses reviews for five minutes and raises one alert', () => {
  health.reviewed('auth', t(0));
  assert.deepEqual([health.paused(t(299)), health.paused(t(300))], [true, false]);
  health.reviewed('auth', t(300));
  assert.deepEqual([health.paused(t(599)), alerts], [true, [['model_error', { reason: 'auth', seen_by: 'review' }]]]);
});
test('a key check that says the key is refused starts a pause once and never extends it', () => {
  health.checked('auth', t(0));
  health.checked('auth', t(200));
  assert.deepEqual([health.paused(t(299)), health.paused(t(300)), alerts], [true, false, [['model_error', { reason: 'auth', seen_by: 'check' }]]]);
});
test('a key check that passes lifts a pause a check caused, and not one a review caused', () => {
  health.checked('no_credit', t(0));
  health.checked('ok', t(60));
  assert.deepEqual([health.paused(t(61)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
  health.reviewed('no_credit', t(100));
  health.checked('ok', t(160));
  assert.equal(health.paused(t(161)), true);
});
test('a review the model answered lifts the pause and says so once', () => {
  health.reviewed('no_credit', t(0));
  health.reviewed(null, t(300));
  health.reviewed(null, t(400));
  assert.deepEqual([health.paused(t(301)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
});
test('a check that a review proves wrong is ignored from then on', () => {
  health.checked('auth', t(0));
  health.reviewed(null, t(300));
  health.checked('auth', t(600));
  assert.deepEqual([health.paused(t(601)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
});
test('a check that says nothing changes nothing', () => {
  health.checked('unknown', t(0));
  assert.deepEqual([health.paused(t(1)), alerts], [false, []]);
  health.reviewed('auth', t(0));
  health.checked('unknown', t(10));
  assert.equal(health.paused(t(11)), true);
});
test('a different failure is a new alert', () => {
  health.reviewed('auth', t(0));
  health.reviewed('no_credit', t(10));
  assert.deepEqual(alerts.map((a) => (a[1] as { reason: string }).reason), ['auth', 'no_credit']);
});
```

`src/shell/spend.test.ts`. Before each test it makes a fresh `db = await testDb()` and empties `alerts`; `alert` pushes `[code, details ?? {}]` into it. `cost(startedAt, usd)` records a run, built like `run()` of Task 2's run tests, that started at that time with that cost:

```ts
test('the level follows the cost of the runs recorded since the start of the UTC day', async () => {
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date('2026-03-01T10:00:00.000Z'), alert });
  await cost('2026-02-28T23:59:59.000Z', 100);
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-01T00:00:00.000Z', 39.5);
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-01T09:00:00.000Z', 0.5);
  assert.equal(await guard.level(), 'warn');
  await cost('2026-03-01T09:30:00.000Z', 10);
  assert.equal(await guard.level(), 'limit');
});
test('each level is alerted once a day, and again the next day', async () => {
  let now = '2026-03-01T10:00:00.000Z';
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date(now), alert });
  await cost('2026-03-01T09:00:00.000Z', 40);
  await guard.level();
  await guard.level();
  await cost('2026-03-01T09:30:00.000Z', 10.254);
  await guard.level();
  await guard.level();
  assert.deepEqual(alerts, [['spend_80', { spent: 40, limit: 50 }], ['spend_limit', { spent: 50.25, limit: 50 }]]);
  now = '2026-03-02T00:00:01.000Z';
  assert.equal(await guard.level(), 'ok');
  await cost('2026-03-02T00:00:00.500Z', 60);
  await guard.level();
  assert.deepEqual(alerts.map((a) => a[0]), ['spend_80', 'spend_limit', 'spend_limit']);
});
test('a run with tokens and no cost is alerted once', () => {
  const guard = createSpendGuard({ db, limit: 50, clock: () => new Date(), alert });
  guard.noteRun({ inputTokens: 0, outputTokens: 0, cost: 0 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0.01 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0 });
  guard.noteRun({ inputTokens: 10, outputTokens: 1, cost: 0 });
  assert.deepEqual(alerts, [['cost_unknown', {}]]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the modules do not exist.

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/shell
git commit -m "feat: alerts, the model's health and the daily limit"
```

---

### Task 10: The review job

**Files:**
- Create: `src/shell/review-job.ts`
- Test: `src/shell/review-job.test.ts`

**Interfaces:**
- Consumes: `Job`, `getJob`, `enqueueJob`, `finishJob`, `requeueJob` (Task 2); `recordRun`, `hasOkRun` (Task 2); `getPullRequest`; `ForgeAccess` (Task 5); `skipReason`, `QUIET_SECONDS` (Task 7); `ModelHealth`, `PAUSE_MS` (Task 9); the engine's `ReviewInput`, `ReviewDeps`, `ReviewResult`, `Limits`, `Usage`, `Span`, and `renderReview`.
- Produces:

```ts
export const RECORD_WAITS_MS = [1_000, 5_000];
export const RETRY_WAIT_MS = 60_000;
export interface ReviewJobDeps {
  db: Db; forge: ForgeAccess; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  settingsFor: (fullName: string) => RepoSettings;
  limits: Limits;
  dryRun: boolean;
  /** The engine's dependencies for one review, around the source it is given. */
  engineDeps: (source: Source) => ReviewDeps;
  /** The engine's entry point. */
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  health: Pick<ModelHealth, 'reviewed'>;
  spend: { noteRun(usage: Usage): void };
}
/** Takes one claimed job to its end: drops it, puts it back, or reviews and records. Never rejects. */
export function runReviewJob(job: Job, deps: ReviewJobDeps): Promise<void>;
```

What it does, in order (8.2, 8.5, 11.1). `now` is the clock when the job began.

1. **The installation.** `getPullRequest(db, job.ref)`. With no stored pull request, or none with an installation, the job is dropped as `no_installation`.
2. **The live read.** `forge.readPullRequest(job.ref, installation)`. null drops the job as `not_found`. A rejection is a failed run at stage `prepare` (step 7).
3. **The checks, in this order.**
   - `skipReason` on the live state, draft flag, author and base branch, with `settingsFor("<owner>/<repo>")`. A reason drops the job with that reason (`closed`, `draft`, `ignored_author`, `base_filtered`).
   - **A head that is not `job.headSha`.** In one transaction: `enqueueJob` for the live head with `replace: false`, the job's own reason, `runAt` at `now` plus `QUIET_SECONDS`, and a null delivery; then this job is finished as `dropped` with outcome `stale_head`. So the newer head has a job whether or not its own event was received, and when its own event did queue one, that job is left as it is (call 25).
   - `hasOkRun(db, job.ref, head, base, dryRun)` with the live head and base. True drops the job as `already_reviewed` (5.2: an automatic trigger on an already reviewed head is skipped). The base compared is the merge base, so a pull request retargeted to a branch with another merge base is reviewed, and one whose diff is the same is not.
4. **The review.** `source = await forge.sourceFor(installation)` (a rejection is a failed run at stage `prepare`), then `review` with `{ pullRequest: live.info, trigger: 'automatic', repoConfig: { primaryBranches, scoreThreshold } of the settings, limits, asOf: now, earlier: null }` and `engineDeps(source)`. Should `review` reject, that is a failed run at stage `engine` with code `internal_error`.
5. **What would be posted.** `renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl })`, `lineUrl` bound to the live pull request.
6. **Telling the guards.** `spend.noteRun(result.usage)`. When the result's failure code is `auth` or `no_credit`, `health.reviewed(code, now)`. Otherwise, when the result made at least one model call and its `dependencies.model` is `ok`, `health.reviewed(null, now)`. Otherwise nothing.
7. **The record.** One run row: the job's id, `trigger: 'automatic'`, `mode: 'full'`, `dryRun`, the live head and base, the outcome (`ok` or `failed`) with the failure's stage and code, `needsHuman` and `highestScore` from the verdict, the rendered body and comments, the whole result, the usage, the start and end times. A run that failed at `prepare` or `engine` has the job's head, a null base, `needsHuman: true`, `highestScore: 100`, an empty body, no comments, an empty result and zero usage. Then one of three ends:
   - **The key was refused** (the failure code is `auth` or `no_credit`): the run is recorded, then the job is put back with `requeueJob`, due at `now + PAUSE_MS`, its start given back when the run's cost is 0 (call 11).
   - **The git service failed before any model call** (the run failed at stage `prepare`; or at stage `context` with a code that starts with `github_`, having made no model call): the run is recorded, then the job is put back, due at `now + RETRY_WAIT_MS`, its start counted (call 24). The runner drops it when its starts are used up (Task 8).
   - **Every other run:** one transaction that first finishes the job, `done` with outcome `reviewed` when the review's status is `ok` and `failed` when it is not, and then records the run. When `finishJob` answers false the job was already finished: an earlier try committed and its answer was lost. Nothing more is written then.
   - Each write is tried up to three times, sleeping `RECORD_WAITS_MS[0]` then `RECORD_WAITS_MS[1]` between tries. When the third fails, the `review` log entry has outcome `record_failed` and the job is left `running`.
8. **The log (14).** A dropped job logs `{ event: 'job', job, repo, number, outcome: 'dropped', reason }`. A run logs `{ event: 'review', job, repo, number, head, trigger, mode, dry_run, outcome, failure_stage, failure_code, needs_human, highest, findings, calls, cost, duration_ms, requeued }`, `repo` being `owner/name`, `findings` the number of placed findings, and `requeued` true when the job was put back.

Every step is guarded: whatever fails, `runReviewJob` resolves. An error's code is its message when that is a short code, else `internal_error`; its message reaches no log.

- [ ] **Step 1: Write the failing tests**

With `REF` and `at` as in Task 2, a fresh `db = await testDb()` before each test, and:

```ts
const LIMITS = { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 };
const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [] };
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
/** The same pull request against another base: a test that runs two reviews in one database uses it for the second, which would otherwise be dropped as already reviewed. */
const OTHER_BASE: LivePullRequest = { ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } };
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const NO_CALLS = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
/** A result as the engine returns it for a finished review, with one finding. */
const okResult = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null, ...over,
});
const failed = (stage: 'context' | 'model', code: string, over: Partial<ReviewResult> = {}): ReviewResult => okResult({
  status: 'failed', failure: { stage, code }, overview: '', findings: [], coverage: { reviewed: [], notReviewed: [] },
  verdict: { threshold: 70, needsHuman: true, highest: 100 }, ...over,
});
```

`await harness(options)` stores the pull request's facts with installation `99` (unless `options.stored === false`), then enqueues (reason `opened`, head `h1`, times `at(0)`, `replace: true`) and claims a job. It builds the dependencies: a `forge` whose `readPullRequest` returns `options.live` (default `LIVE`; an `Error` makes it reject) and whose `sourceFor` returns an empty object; a `review` that records its input in `inputs` and returns `options.result` (default `okResult()`); a `health` whose `reviewed` pushes its first argument into `healthCalls`; a `spend` whose `noteRun` pushes into `spendCalls`; a `sleep` that pushes into `slept` and resolves; a clock at `at(0)`; `settingsFor: () => options.settings ?? SETTINGS`; `dryRun: true`; `limits: LIMITS`; `lineUrl: () => 'https://git.example.test/x'`; and a `log` that pushes into `logged`. `options.recordFailures: n` wraps the database so that its first `n` calls of `transaction` reject. `options.lostAnswer: true` wraps it so that its first call of `transaction` does the work, commits, and then rejects. It returns all of these with the claimed `job` and `deps`.

```ts
test('a review is run on the live pull request, recorded with what would be posted, and its job ends as reviewed', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.job, stored!.trigger, stored!.mode, stored!.dryRun, stored!.headSha, stored!.baseSha, stored!.outcome, stored!.needsHuman, stored!.highestScore],
    [h.job.id, 'automatic', 'full', true, 'h1', 'merge000', 'ok', false, 35]);
  assert.deepEqual(stored!.usage, USAGE);
  assert.match(stored!.body, /Human review/);
  assert.deepEqual((stored!.result as ReviewResult).findings, okResult().findings);
  assert.equal((stored!.comments as unknown[]).length, 1);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'reviewed']);
  assert.deepEqual(h.inputs, [{
    pullRequest: LIVE.info, trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 }, limits: LIMITS, asOf: new Date(at(0)), earlier: null,
  }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual(
    [entry.repo, entry.number, entry.head, entry.outcome, entry.dry_run, entry.findings, entry.cost, entry.requeued],
    ['acme/shop', 7, 'h1', 'ok', true, 1, 0.5, false]);
});
test('a job is dropped, with no model call and no run, when the pull request is gone, closed, a draft or by an ignored author', async () => {
  const cases: Array<[LivePullRequest | null, string]> = [
    [null, 'not_found'], [{ ...LIVE, state: 'closed' }, 'closed'], [{ ...LIVE, state: 'merged' }, 'closed'],
    [{ ...LIVE, info: { ...LIVE.info, draft: true } }, 'draft'],
    [{ ...LIVE, info: { ...LIVE.info, author: 'dependabot[bot]' } }, 'ignored_author'],
  ];
  for (const [live, reason] of cases) {
    const h = await harness({ live });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length], ['dropped', reason, 0, 0]);
    assert.deepEqual(h.logged.at(-1), { event: 'job', job: h.job.id, repo: 'acme/shop', number: 7, outcome: 'dropped', reason });
  }
});
test('a base branch outside the filter drops the job', async () => {
  const h = await harness({ settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'base_filtered');
});
test('a pull request the service has no installation for is dropped', async () => {
  const h = await harness({ stored: false });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'no_installation');
});
test('a job whose head has moved is dropped, and the live head gets a job due after the quiet period', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.inputs.length], ['dropped', 'stale_head', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.reason, j.runAt, j.starts, j.status]), [['h2', 'opened', at(180), 0, 'pending']]);
});
test('a job whose head has moved leaves the job the newer head already has', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  const own = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.runAt]), [[own, 'synchronize', at(100)]]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'stale_head');
});
test('a head that already has a finished review against the same base is not reviewed again', async () => {
  const first = await harness();
  await runReviewJob(first.job, first.deps);
  const again = await harness();
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([(await getJob(db, again.job.id))?.outcome, again.inputs.length, (await listRuns(db, REF)).length], ['already_reviewed', 0, 1]);
  const retargeted = await harness({ live: OTHER_BASE });
  await runReviewJob(retargeted.job, retargeted.deps);
  assert.deepEqual([(await getJob(db, retargeted.job.id))?.outcome, (await listRuns(db, REF)).length], ['reviewed', 2]);
});
test('a pull request that cannot be read is recorded as a failed run, and the job is tried again in a minute with its start counted', async () => {
  const h = await harness({ live: new Error('github_502') });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.outcome, stored!.failureStage, stored!.failureCode, stored!.headSha, stored!.baseSha, stored!.needsHuman, stored!.highestScore, stored!.usage.cost],
    ['failed', 'prepare', 'github_502', 'h1', null, true, 100, 0]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts, h.inputs.length], ['pending', at(60), 1, 0]);
  assert.equal(h.logged.find((e) => e.event === 'review')!.requeued, true);
});
test('an error that is not a short code is recorded as internal_error and its message is logged nowhere', async () => {
  const h = await harness({ live: new Error('Something private went wrong') });
  await runReviewJob(h.job, h.deps);
  assert.equal((await listRuns(db, REF))[0]!.failureCode, 'internal_error');
  assert.equal(JSON.stringify(h.logged).includes('private'), false);
});
test('a failure of the git service inside the engine is tried again too; any other failure before the model is not', async () => {
  const again = await harness({ result: failed('context', 'github_network', { usage: NO_CALLS }) });
  await runReviewJob(again.job, again.deps);
  let j = await getJob(db, again.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
  await finishJob(db, again.job.id, 'dropped', 'test_over', at(1));
  const final = await harness({ result: failed('context', 'too_many_files', { usage: NO_CALLS }) });
  await runReviewJob(final.job, final.deps);
  j = await getJob(db, final.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'failed']);
});
test('a failed review is recorded with its stage and code and is not run again', async () => {
  const h = await harness({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.failureStage, stored!.failureCode, j?.status, j?.outcome, h.healthCalls], ['failed', 'model', 'timeout', 'done', 'failed', []]);
});
test('a refused key records the run and puts the job back for when the pause is over; the start is given back only when the run cost nothing', async () => {
  const free = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: { ...USAGE, cost: 0 } }) });
  await runReviewJob(free.job, free.deps);
  let j = await getJob(db, free.job.id);
  assert.deepEqual([free.healthCalls, j?.status, j?.runAt, j?.starts, (await listRuns(db, REF)).at(-1)!.failureCode], [['auth'], 'pending', at(300), 0, 'auth']);
  await finishJob(db, free.job.id, 'dropped', 'test_over', at(1));
  const paid = await harness({ result: failed('model', 'no_credit', { dependencies: { model: 'error' } }) });
  await runReviewJob(paid.job, paid.deps);
  j = await getJob(db, paid.job.id);
  assert.deepEqual([paid.healthCalls, j?.status, j?.runAt, j?.starts], [['no_credit'], 'pending', at(300), 1]);
});
test('a review the model answered tells the health so, and one that made no model call says nothing', async () => {
  const answered = await harness();
  await runReviewJob(answered.job, answered.deps);
  assert.deepEqual(answered.healthCalls, [null]);
  const silent = await harness({ live: OTHER_BASE, result: okResult({ usage: NO_CALLS, findings: [] }) });
  await runReviewJob(silent.job, silent.deps);
  assert.deepEqual([silent.healthCalls, silent.spendCalls.length], [[], 1]);
});
test('a model answer the database would refuse is still recorded', async () => {
  const NUL = String.fromCharCode(0);
  const h = await harness({ result: okResult({ findings: [{ ...okResult().findings[0]!, body: `a${NUL}b` }], overview: `o${NUL}` }) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status], [1, 'done']);
});
test('recording is tried three times; then the cost is in the log and the job is left running', async () => {
  const twice = await harness({ recordFailures: 2 });
  await runReviewJob(twice.job, twice.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, twice.slept, (await getJob(db, twice.job.id))?.status], [1, [1000, 5000], 'done']);
  const always = await harness({ live: OTHER_BASE, recordFailures: 3 });
  await runReviewJob(always.job, always.deps);
  const entry = always.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.outcome, entry.cost, (await getJob(db, always.job.id))?.status, (await listRuns(db, REF)).length], ['record_failed', 0.5, 'running', 1]);
});
test('a record that was committed but looked failed is not written twice', async () => {
  const h = await harness({ lostAnswer: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status, h.slept], [1, 'done', [1000]]);
});
test('nothing the job does can make it reject', async () => {
  const broken = await harness();
  broken.deps.review = () => Promise.reject(new Error('boom'));
  broken.deps.log = () => { throw new Error('log'); };
  await runReviewJob(broken.job, broken.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.failureStage, stored!.failureCode, (await getJob(db, broken.job.id))?.status], ['engine', 'internal_error', 'done']);
});
test('the engine itself runs under the job', async () => {
  const h = await harness();
  h.deps.review = review;   // from src/engine/review.ts
  h.deps.engineDeps = () => engineDepsWithStubs();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.outcome, (stored!.result as ReviewResult).coverage.reviewed], ['ok', ['a.ts']]);
});
```

`engineDepsWithStubs()` builds real `ReviewDeps` the way the engine's own tests in `src/engine/review.test.ts` do: a `Source` with one changed file `a.ts` that has a small patch, and a model stub that answers the forced `submit_review` call with a valid answer that has no findings and no scores.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail because the module does not exist.

- [ ] **Step 3: Implement `runReviewJob`**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/shell
git commit -m "feat: the review job reads the pull request live, runs the engine and records the run"
```

---

### Task 11: Recovery, start and stop

**Files:**
- Create: `src/shell/recovery.ts`
- Modify: `src/service.ts`, `src/main.ts` (it must hand `startService` its new dependencies, or the project stops compiling)
- Test: `src/shell/recovery.test.ts`, `src/service.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1 to 10 produce.
- Produces:

```ts
// src/shell/recovery.ts
/** PM-recovery: puts every running job back to pending, due at `now`, its starts kept. One whose pull request already has a pending job is dropped as `superseded`. Logs { event: 'recovery', requeued, dropped }. */
export function recoverJobs(db: Db, now: Date, log: (entry: Record<string, unknown>) => void): Promise<{ requeued: number; dropped: number }>;

// src/service.ts
export const TICK_MS = 5_000;
export const BEAT_MS = 60_000;
export const UPKEEP_MS = 300_000;
export const DRAIN_WAIT_MS = 600_000;
export const LOOKBACK_MARGIN_MS = 120_000;
export const JOB_KEEP_MS = 14 * 86_400_000;
export interface ServiceDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  listen: (listener: (req: RequestLike, res: ResponseLike) => void, port: number) => Promise<Listening>;
  /** null when another instance holds the lock. */
  takeLock: () => Promise<InstanceLock | null>;
  forge: ForgeAccess; hooks: HookDeliveries;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** A repeating timer. Returns its cancel. `work` never rejects; what it returns is there for a test to wait on. */
  every: (ms: number, work: () => Promise<void>) => () => void;
  engineDeps: (source: Source) => ReviewDeps;
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: ReviewJobDeps['lineUrl'];
}
/** `settled` resolves when the work that follows listening has had its first try: the key check, the redelivery attempt and, when that worked, the first beat. */
export function startService(config: ServiceConfig, deps: ServiceDeps): Promise<{ stop(): Promise<void>; settled: Promise<void> }>;
```

Start-up does not judge a job's age or its starts. The runner does, when the job comes up (Task 8), and its first pass runs as soon as the service listens.

**Start (8.2, 17, PM-recovery).** In this order, each step finished before the next:

1. `takeLock()`. null closes the database and rejects with `Error('another_instance_running')`. Nothing is migrated by an instance that does not hold the lock.
2. `migrate`.
3. `recoverJobs`.
4. `listen`.

A failure in steps 2 to 4 releases the lock, closes the database and rejects with that failure.

After listening, and not awaited by `startService`:

5. `every(TICK_MS, ...)` runs a pass of the runner, `every(UPKEEP_MS, ...)` runs the upkeep, and one pass is run at once.
6. **A key check:** `checkModelKey` on the model's config, its result given to `health.checked`. `{ event: 'model_check', result }` is logged the first time and whenever the result differs from the one before.
7. **Redelivery.** `readHeartbeat`. With no heartbeat there is nothing to ask for (a first start), and step 8 follows. Otherwise `runRedelivery` with `since` that heartbeat less `LOOKBACK_MARGIN_MS`. When its result has a `code`, or `failed` above 0, or is not `complete`, the alert `redelivery_failed` is raised with `{ reason: <the code, or 'partial'>, failed, complete }`, at most once per start. When the result has a `code` the attempt did not get through the deliveries, and step 8 does not follow: the upkeep makes the attempt again, with the same `since`, until one has no `code`.
8. **The heartbeat.** `beat(now)`, then `every(BEAT_MS, ...)` beats. Until an attempt of step 7 got through, the stored heartbeat stays where the last run left it, so a restart looks back just as far.

`settled` resolves when steps 6 to 8 have had their first try. Each is guarded: a failure is logged as `{ event: 'start_step_failed', step, error, code }`, `step` being `key_check`, `redelivery` or `heartbeat`, and the others go on.

**The upkeep,** every `UPKEEP_MS`: the key check of step 6; `deleteFinishedJobs(db, now - JOB_KEEP_MS)`; and, while step 7 has not got through, another attempt of it followed by step 8.

**The wiring.** The runner's `mayStart` is `!health.paused(clock()) && (await spend.level()) !== 'limit'`. Its `run` is `runReviewJob` with `limits` built from `config.limits.inputTokensPerCall`, `config.limits.batchesPerReview` and `config.model.timeoutSeconds`, `dryRun: config.dryRun`, and `settingsFor: (name) => repoSettingsFor(config, name)`. `receive` gets the same `settingsFor`, and an `onQueued` that starts a pass.

**Stop (8.2, PM-drain).** In this order, and it still never rejects:

1. The service is marked as stopping. Every timer is cancelled, none is registered from then on, and steps 6 to 8 do nothing more: an attempt of step 7 under way may finish, and no beat follows it.
2. `runner.drain()`, waited for at most `DRAIN_WAIT_MS`. Webhooks are still accepted and stored meanwhile; the jobs they queue stay pending. When the wait runs out, `{ event: 'drain_timeout', running }` is logged and the cut jobs stay marked `running`.
3. The listener is closed and requests in flight are waited for, at most `STOP_WAIT_MS`, as in plan 3.
4. When beating had begun, a last `beat(now)`.
5. `alerts.settled()`, waited for at most `ALERT_TIMEOUT_MS`.
6. The database is closed, waiting at most `CLOSE_WAIT_MS`, as in plan 3.
7. The lock is released, waiting at most `CLOSE_WAIT_MS`.

**`src/main.ts`** builds the real clients, and is the only place in the service that does:

- `createAppAuth` from `config.app`, with `globalThis.fetch` and a real clock. A key that cannot be read fails the start.
- `createGithubAccess` and `createGithubHookDeliveries` over it.
- `takeLock: () => takeInstanceLock(config.database.url, onLost)`. `onLost` logs `{ event: 'instance_lock_lost' }` and calls `process.exit(1)` (call 6).
- The engine's dependencies as `src/eval/cli.ts` builds them: `createModelClient`, the contract read from `contract/<contractFile(config)>`, a token of 16 hex characters, the scorer when one is configured. `engineDeps: (source) => ({ source, ...those })`. `review` is the engine's. `lineUrl` is `githubLineUrl`.
- `every` is `setInterval`, unreferenced, calling `work` and ignoring what it returns, and returning its `clearInterval`. `sleep` is `setTimeout` as a promise. `fetch` is `globalThis.fetch`.

Nothing else in `main.ts` changes in this task; its handling of signals and of its exit is Task 12's.

- [ ] **Step 1: Write the failing tests**

`src/shell/recovery.test.ts`, with `REF`, `at` and `job` as in Task 2:

```ts
test('start-up puts interrupted jobs back and leaves pending ones alone', async () => {
  const cut = await enqueueJob(db, job());
  await claimJob(db, cut, at(0));
  const waiting = await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(120) }));
  const logged: Array<Record<string, unknown>> = [];
  assert.deepEqual(await recoverJobs(db, new Date(at(10)), (e) => { logged.push(e); }), { requeued: 1, dropped: 0 });
  const back = await getJob(db, cut);
  assert.deepEqual([back?.status, back?.starts, back?.runAt], ['pending', 1, at(10)]);
  assert.deepEqual([(await getJob(db, waiting))?.status, (await getJob(db, waiting))?.runAt], ['pending', at(120)]);
  assert.deepEqual(logged, [{ event: 'recovery', requeued: 1, dropped: 0 }]);
});
test('an interrupted job whose pull request has a newer pending job is dropped as superseded', async () => {
  const cut = await enqueueJob(db, job());
  await claimJob(db, cut, at(0));
  await enqueueJob(db, job({ headSha: 'h2', runAt: at(1), now: at(1) }));
  assert.deepEqual(await recoverJobs(db, new Date(at(10)), () => {}), { requeued: 0, dropped: 1 });
  assert.equal((await getJob(db, cut))?.outcome, 'superseded');
});
```

`src/service.test.ts` is rebuilt around one `await harness(options)`. It has `REF`, `at`, `job`, `run`, `SETTINGS`, `facts`, `pr` and `LIVE` as the earlier tasks' tests do. The harness makes:

- `h.db`, a `pgliteDb()` (not migrated, so a test sees the service migrate it) whose `close` pushes `close` onto `h.events` and closes nothing, so a test can still query it afterwards;
- `takeLock`, which pushes `lock` and returns a lock whose `release` pushes `release`, or returns null with `options.lock === null`;
- `listen`, which pushes `listen`, keeps the listener, awaits `h.onListen` when a test set one, rejects with `options.listenError` when given, and returns a `Listening` whose `close` pushes `listener-close`;
- `every`, which records `{ ms, work, cancelled }` in `h.timers`; `h.runTimer(ms)` awaits the `work` registered for that interval;
- a `forge` that returns `LIVE` and an empty source, and a `review` that pushes its input into `h.inputs` and returns an ok result with cost 0.5 (`options.holdReview` makes it wait for `h.releaseReview()`); `h.reviewed()` resolves once `review` has been called;
- a `hooks` whose `listSince` pushes its argument into `h.listedSince`, awaits `h.beforeListing()` when a test set one, and answers with the next entry of `options.listings` (an `Error` rejects; default `{ deliveries: [], complete: true }` every time);
- a stub `fetch` that pushes each URL into `h.fetched` and answers 200 with `{}`; a `sleep` that resolves at once; a `log` that pushes into `h.logged`;
- a clock at `options.now ?? at(0)`, which is on 2026-03-01;
- a config from `serviceConfig`, with the daily limit at 50.

`h.start()` calls `startService`. `h.webhook(event, delivery)` sends one delivery through the kept listener, with a reader stub as in Task 7, and resolves with `{ status, body }`. `h.flush()` awaits `setImmediate` five times.

Plan 3's tests of `stop` are kept, each on the new harness. Where one asserts the whole list of log entries, the `recovery` and `model_check` entries of the start are filtered out first.

```ts
test('start takes the lock, then migrates and recovers, then listens', async () => {
  const h = await harness();
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  const cut = await enqueueJob(h.db, job());
  await claimJob(h.db, cut, at(0));
  let seenAtListen: string | undefined;
  h.onListen = async () => { seenAtListen = (await getJob(h.db, cut))?.status; };
  await h.start();
  assert.deepEqual([h.events.slice(0, 2), seenAtListen], [['lock', 'listen'], 'pending']);
});
test('a second instance is refused before it migrates or listens', async () => {
  const h = await harness({ lock: null });
  await assert.rejects(h.start(), /^Error: another_instance_running$/);
  assert.deepEqual(h.events, ['lock', 'close']);
  await assert.rejects(h.db.query('select 1 from visto_ai.jobs'));
});
test('when a later step of the start fails the lock is released and the database closed', async () => {
  const h = await harness({ listenError: new Error('EADDRINUSE') });
  await assert.rejects(h.start(), /EADDRINUSE/);
  assert.deepEqual(h.events.slice(-2).sort(), ['close', 'release']);
});
test('a delivery that queues a review is run without waiting for the timer', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.reviewed();
  assert.equal(h.inputs[0]!.pullRequest.headSha, 'h1');
});
test('after listening it checks the key, asks for failed deliveries since the last heartbeat less two minutes, then starts beating', async () => {
  const h = await harness({ now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), h.listedSince, await readHeartbeat(h.db)], [true, [at(-120)], at(600)]);
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'model_check'), [{ event: 'model_check', result: 'ok' }]);
});
test('on a first start nothing is asked for again, and the beat starts', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[], at(0), true]);
});
test('a redelivery that does not get through is alerted once and tried again by the upkeep with the same look-back; the beat starts only when one does', async () => {
  const h = await harness({ now: at(600), listings: [new Error('github_502'), new Error('github_502'), { deliveries: [], complete: true }] });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120)], at(0), false]);
  await h.runTimer(UPKEEP_MS);
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120), at(-120), at(-120)], at(600), true]);
  const raised = h.logged.filter((e) => e.event === 'alert' && e.code === 'redelivery_failed');
  assert.deepEqual(raised, [{ event: 'alert', code: 'redelivery_failed', reason: 'github_502', failed: 0, complete: false }]);
  await h.runTimer(UPKEEP_MS);
  assert.equal(h.listedSince.length, 3);
});
test('the upkeep checks the key and deletes jobs finished more than fourteen days ago', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  const old = await enqueueJob(h.db, job());
  await finishJob(h.db, old, 'done', 'reviewed', at(-15 * 86_400));
  h.fetched.length = 0;
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), await getJob(h.db, old)], [true, null]);
});
test('nothing starts once the daily limit is reached, and the operator is told once', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await h.webhook(pr('opened'), 'd1');
  await h.runTimer(TICK_MS);
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await unfinishedJobs(h.db))[0]!.status], [0, 'pending']);
  assert.equal(h.logged.filter((e) => e.event === 'alert' && e.code === 'spend_limit').length, 1);
});
test('stop drains first: a running review finishes while webhooks are still accepted, then the listener, the database and the lock', async () => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  const stopping = service.stop();
  assert.deepEqual(await h.webhook(pr('opened', { headSha: 'h2', updatedAt: at(5) }), 'd2'), { status: 202, body: 'accepted' });
  assert.equal(h.events.includes('listener-close'), false);
  h.releaseReview();
  await stopping;
  assert.deepEqual(h.events.slice(-3), ['listener-close', 'close', 'release']);
  const pending = await h.db.query<{ n: number }>("select count(*)::int as n from visto_ai.jobs where status = 'pending'");
  assert.deepEqual([h.timers.every((t) => t.cancelled), pending[0]!.n], [true, 1]);
});
test('stop goes on once DRAIN_WAIT_MS has passed, and says how many reviews were cut', async (t) => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = service.stop();
  await h.flush();
  t.mock.timers.tick(DRAIN_WAIT_MS);
  await stopping;
  assert.deepEqual(h.logged.find((e) => e.event === 'drain_timeout'), { event: 'drain_timeout', running: 1 });
  assert.equal((await h.db.query<{ status: string }>('select status from visto_ai.jobs'))[0]!.status, 'running');
});
test('a stop that comes while failed deliveries are being asked for starts no beat', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const h = await harness({ now: at(600) });
  h.beforeListing = () => held;               // listSince waits for this before it answers
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await h.flush();
  const stopping = service.stop();
  release();
  await stopping;
  await service.settled;
  assert.deepEqual([await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [at(0), false]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | grep -E "^(not ok|# (pass|fail))"`
Expected: the new tests fail; plan 3's tests of the service fail to compile until the harness is rebuilt.

- [ ] **Step 3: Implement `recovery.ts`, the start and the stop in `src/service.ts`, and the wiring in `src/main.ts`**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/shell src/service.ts src/service.test.ts src/main.ts
git commit -m "feat: the service recovers, runs and drains review jobs"
```

---

### Task 12: Signals, the container setup and a real run

**Files:**
- Modify: `src/main.ts`, `src/forge/github/send-sample.ts`, `compose.yaml`, `env.example`, `README.md`
- Test: `src/main.test.ts`, the existing test of `send-sample.ts`

**Interfaces:**
- Consumes: everything.
- Produces:

```ts
// src/main.ts
/** The error's name, its string code, and the short code its message starts with (up to a colon), or null. Never its message. */
export function describeFailure(error: unknown): { error: string; code: string | null; reason: string | null };
/**
 * Runs `start` and stops what it started on the first signal, also one that arrives before `start` has resolved.
 * A second signal calls exit(1). A start that rejects logs { event: 'start_failed', ...describeFailure } and resolves 1.
 * Resolves 0 after a stop.
 */
export function runUntilSignal(
  start: () => Promise<{ stop(): Promise<void> }>,
  signals: { on(listener: () => void): void; off(listener: () => void): void },
  exit: (code: number) => void,
  log: (entry: Record<string, unknown>) => void,
): Promise<number>;

// src/forge/github/send-sample.ts: a fourth, optional argument for the pull_request kind
export function sampleWebhook(
  kind: SampleKind, secret: string, delivery: string, options?: { action?: 'opened' | 'synchronize'; head?: string },
): { headers: Record<string, string>; body: string };
```

In `main`, the signals are `SIGTERM` and `SIGINT`, handed to `runUntilSignal`, which is called before anything is started, so a signal during the migrations or the recovery is not lost. `main` prints `start_failed` as before when the start fails.

The file's last block becomes `process.exit(await main(...))`, so a database close that timed out no longer leaves the process waiting to be killed.

The sample tool gains `--action opened|synchronize` (default `opened`) and `--head <sha>` (default `abc123`) for the `pull_request` kind.

- [ ] **Step 1: Write the failing tests**

`src/main.test.ts`, added:

```ts
test('a failure is described by its name, its code and the short code its message starts with', () => {
  assert.deepEqual(describeFailure(new Error('another_instance_running')), { error: 'Error', code: null, reason: 'another_instance_running' });
  assert.deepEqual(describeFailure(new Error('unknown_migration_applied: 0009_x')), { error: 'Error', code: null, reason: 'unknown_migration_applied' });
  assert.deepEqual(describeFailure(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' })), { error: 'Error', code: 'ECONNREFUSED', reason: null });
});

function signalsFake() {
  const listeners = new Set<() => void>();
  return {
    on: (l: () => void): void => { listeners.add(l); }, off: (l: () => void): void => { listeners.delete(l); },
    send: (): void => { for (const l of [...listeners]) l(); }, count: (): number => listeners.size,
  };
}
test('the first signal stops the service and the code is 0', async () => {
  const signals = signalsFake();
  let stops = 0;
  const done = runUntilSignal(async () => ({ stop: async () => { stops += 1; } }), signals, () => {}, () => {});
  await new Promise((r) => setImmediate(r));
  signals.send();
  assert.deepEqual([await done, stops, signals.count()], [0, 1, 0]);
});
test('a signal that arrives during the start stops the service as soon as it has started', async () => {
  const signals = signalsFake();
  let started!: (service: { stop(): Promise<void> }) => void;
  let stops = 0;
  const done = runUntilSignal(() => new Promise((resolve) => { started = resolve; }), signals, () => {}, () => {});
  signals.send();
  started({ stop: async () => { stops += 1; } });
  assert.deepEqual([await done, stops], [0, 1]);
});
test('a second signal ends the process at once', async () => {
  const signals = signalsFake();
  const exits: number[] = [];
  void runUntilSignal(async () => ({ stop: () => new Promise<void>(() => {}) }), signals, (code) => { exits.push(code); }, () => {});
  await new Promise((r) => setImmediate(r));
  signals.send();
  signals.send();
  assert.deepEqual(exits, [1]);
});
test('a start that fails is logged with its reason and the code is 1', async () => {
  const logged: Array<Record<string, unknown>> = [];
  const code = await runUntilSignal(() => Promise.reject(new Error('another_instance_running')), signalsFake(), () => {}, (e) => { logged.push(e); });
  assert.deepEqual([code, logged], [1, [{ event: 'start_failed', error: 'Error', code: null, reason: 'another_instance_running' }]]);
});
```

The test of `send-sample`, added:

```ts
test('a pull request sample can carry another action and another head', () => {
  const { body } = sampleWebhook('pull_request', 's', 'd1', { action: 'synchronize', head: 'def456' });
  const payload = JSON.parse(body) as { action: string; pull_request: { head: { sha: string } } };
  assert.deepEqual([payload.action, payload.pull_request.head.sha], ['synchronize', 'def456']);
});
```

- [ ] **Step 2: Run them to see them fail, then implement `describeFailure`, `runUntilSignal`, their use in `main`, the exit, and the two options of the sample tool**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: The container setup and the README**

- `compose.yaml`: the app's `stop_grace_period` becomes `660s`.
- `env.example`: `APP_PRIVATE_KEY`, with the note that the key is written on one line with `\n` for each line break, and a commented `ALERT_WEBHOOK_URL`. Placeholders only.
- `README.md`, "Run the service":
  - what the service does now: reviews in dry run, recorded, nothing posted;
  - the keys it needs, and that it starts only with `dryRun: true`;
  - how to read what a review would have posted: one `psql` query on `visto_ai.review_runs` for `body`, `outcome` and `cost`;
  - one instance per database, a restart of the database restarts the app, and the connection to Postgres must be direct: the lock and the statement timeout do not work through a pooler in transaction mode;
  - stopping waits up to 10 minutes for running reviews;
  - every review costs money: the daily limit, and what pauses reviews;
  - the two new options of the sample tool.
  The status section and the layout table gain the new parts.

- [ ] **Step 4: Commit**

```bash
git add src compose.yaml env.example README.md
git commit -m "feat: signals before start, a clean exit; container setup and README for dry run"
```

- [ ] **Step 5: A real run on this machine, with the app cut off from the outside**

Under its own Compose project name, with an override file and an env file kept outside the repository. The override puts both services on a network with `internal: true`, so the running app reaches the database and nothing else, and publishes no port. Building the image may download its base image and the packages, as it did in plan 3's run; nothing of the project is sent. The env file holds invented secrets and an RSA key made for this run with `openssl genrsa`. Webhooks are sent from inside the app's container (`docker compose exec app node src/forge/github/send-sample.ts ...`). Show, and record in the notes:

1. The app starts and logs `recovery`, `listening` and a `model_check` whose result is `unknown`, because nothing is reachable.
2. An `opened` sample is answered `202 accepted`. Its job is tried three times, a minute apart, each try a row of `review_runs` with `failure_stage = 'prepare'`, `failure_code = 'github_network'` and `cost = 0`, and then it is dropped as `attempts_exhausted`. `select sum(cost)::float8 from visto_ai.review_runs` answers on the real client.
3. Two `synchronize` samples with two heads leave one pending job, of the second head, due about 180 seconds after the second. After `docker compose restart app` the job is still pending and comes up at its time.
4. A second app container on the same database (`docker compose run --rm app`) ends with `start_failed` and the reason `another_instance_running`, and the first keeps running.
5. After `docker compose restart db` the app logs `instance_lock_lost`, exits, is started again by Compose, and accepts the next sample.
6. `docker compose stop app` ends with exit code 0 within seconds when no review is running, and the log shows no `instance_lock_lost`.
7. **Two connections against the queue's statements,** with `psql` inside the database container, on rows inserted by hand for an invented pull request:
   - Session A opens a transaction, runs the enqueue statement for the pull request and waits 5 seconds before it commits. Session B, started a second later, runs the first requeue statement for a running job of the same pull request. Expected: B waits, then fails with a unique violation (`23505`).
   - Session A opens a transaction, runs the enqueue statement that moves the pending job's time into the future and waits before it commits. Session B runs the claim statement for that job. Expected: B waits, then updates no row.
8. Everything is removed afterwards: containers, the volume, the key.

- [ ] **Step 6: Write the notes file and commit it**

`docs/superpowers/plans/2026-11-19-review-jobs-in-dry-run-notes.md`, in the form of plan 3's notes: status, decisions taken while building with what each costs if wrong, what the reviews found, what the real run showed, what is put off, and what is not verified.

---

## To verify with a real app

None of this can be shown by a test or by the run in Task 12. Each needs a GitHub App on a scratch repository, a model key, and the owner's go-ahead.

1. That GitHub accepts the app token as built: `iss` as the app's id written as text, and the 2022-11-28 API version header the project sends. GitHub's documentation now shows a newer version header.
2. That a token minted for an installation reads a pull request, its compare and its files, also for a pull request from a fork, whose head commit lives in another repository.
3. That the deliveries listing returns newest first, as the stop rule assumes, and that a delivery asked for again arrives with the delivery id it had. GitHub's documentation states neither.
4. That OpenRouter's key route answers as the check reads it, what it answers for a key whose account, not the key, is out of credit, and whether a 402 can be about one request and not the account.
5. How often GitHub delivers a pull request's events out of order, which is what the stored-facts rule of Task 7 and the moved-head rule of Task 10 are for.
6. A whole review in dry run: a real pull request, a real model call, and a run row whose body reads like the review a person would expect.
7. The queue's statements under real load. Task 12 shows the two orderings Task 2 argues, one at a time.
