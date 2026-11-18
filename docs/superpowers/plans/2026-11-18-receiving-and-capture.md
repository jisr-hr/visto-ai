# Receiving and Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service that receives a GitHub App's webhooks, stores each one before it acknowledges it, and records in its own Postgres what people do on pull requests.

**Architecture:** Three new parts. `db` owns the Postgres client, the migrations and the queries. `forge/github` checks a webhook's signature and turns its payload into the project's own event types. `shell` decides what an event stores, writes it in one transaction with the delivery id, and answers. `src/main.ts` wires them. Tests run against an in-process Postgres; nothing in this plan calls GitHub or a model.

**Tech Stack:** Unchanged from plans 1 and 2 (Node 26 running TypeScript directly, npm, `node:test`, `tsc --noEmit`, ESLint, `zod`, `yaml`, `diff`), plus `pg` as a dependency and `@electric-sql/pglite` and `@types/pg` as development dependencies. HTTP is `node:http` with no framework. Signatures use `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it. Earlier plans and their notes are beside this file.

**Notes:** `docs/superpowers/plans/2026-11-18-receiving-and-capture-notes.md` is written when the build ends: the decisions taken and what its final review leaves open. Where this plan and the notes differ, the notes say what was built.

## Scope

Build stage 4 of section 18 (the shell) is too large for one plan. It is split in three, and each ends with something that runs. This is the first.

| Plan | Covers | Ends with |
|---|---|---|
| **3. Receiving and capture** (this plan) | `db`, migrations, the service's configuration, webhook signature, normalised events, receiving (8.1: verify, parse, reject duplicates, store, acknowledge), capture of human activity (7.1), pull request facts, the service entry, a container setup | `docker compose up` gives a service that stores every signed webhook and what people did |
| 4. Review jobs in dry run | The app's identity and installation tokens, the lock that keeps a second instance from running (section 17, D13), the queue (8.2) with its drain and its recovery, triggers and filters, redelivery, a review job that runs the engine in `full` mode, recording (8.5), the daily spend guard, dry run (11.1) | A deployment in dry run computes and records a review for each pull request and writes nothing to GitHub |
| 5. Publishing, threads and commands | Publishing pinned to a commit (8.3, D20), reading back comments, inline notes (D22), threads and their verdicts (8.4, 5.6 steps 5 to 7), the other review modes with a pull request's earlier state (5.2), scores across reviews (6.2, D17), the `/review` command (D15), the start-up check of permissions and events (D16), the app manifest | A working reviewer on a pull request |

Two things about that split. The review modes, the earlier state and the scores across reviews all rest on a published review, and a dry run never counts as an earlier run (11.1), so they come with publishing and not before it. Plan 5 is the largest of the three and may be cut again when it is written.

| In this plan | Left to a later plan, and why |
|---|---|
| 8.1: the order on every webhook, and storing before acknowledging (D14) | **What an event triggers** (a review, a command, the gate): plans 4 and 5, stage 5. This plan records the delivery and what it says about people and the pull request |
| 7.1: reviews with their state, inline comments, general comments, thread resolutions, merges and closes, each with the author's association | **Reverts** (7.1, 7.2): detecting that a pull request reverts another belongs with the `revert` record, stage 8. **Learning from what is captured:** stage 8 |
| 13: `schema_migrations`, `deliveries`, `pull_requests`, `human_activity` | **Every other table:** with the plan that first writes it |
| 11: the `app`, `database` and `server` blocks | **The app's id and key, dry run, ignored authors, the base filter:** plan 4, where they are first read |
| 17: an image and a Compose file | **The single-instance lock:** plan 4, with the queue it protects. **The app manifest and the setup guide for a real app:** plan 5, when the permission list is final |
| 14: one log line per delivery; the health route returns liveness only | **Alerts, the model connection check, dependency statuses:** plan 4 |
| Stopping: no new connection, requests in flight finish | **The drain of 8.2**, which keeps accepting webhooks while reviews finish: plan 4 changes how the service stops, because this plan has no job to wait for |

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **Stage 4 is three plans**, as in the first table above.
2. **Libraries.** `pg` in production and `@electric-sql/pglite` in tests, both behind one small interface of the project's own. No HTTP framework and no JWT library.
3. **Routes.** `POST /webhooks/github` and `GET /healthz`. The port is 8080 unless the config says otherwise.
4. **Answers.** 202 with `accepted`, `ignored` or `duplicate`; 400 for a body that is not JSON or a request with no delivery id or event name; 401 for a bad signature; 404 for an unknown path; 405 for a wrong method; 413 for a body over the limit; 503 when the database cannot store it or too many requests are in flight. Every body is one short word or code.
5. **What "stored before acknowledged" means here.** One transaction writes the delivery id together with everything this plan derives from the event. The answer is sent after the commit. The raw payload is not kept: section 13 keeps delivery ids for duplicate rejection only.
6. **When the database is down the answer is 503**, so the sender shows the delivery as failed and it can be delivered again. The predecessor accepted such a delivery and lost it.
7. **Edits, deletions and dismissals are not captured.** A comment or a review that is edited, deleted or dismissed later keeps what was stored when it was made. Section 7.1 does not list them, and the predecessor ignored them too.
8. **Identity is compared without regard to letter case.** The owner and the repository name are stored in lower case.
9. **A person is an account the git service does not type as a bot.** The mapper plan 2 wrote also treats a login ending in `[bot]` as a bot, and this plan uses the same mapper for live events, so history and live capture agree. Section 8.4 names account type only; the suffix is reserved for apps, so it adds no false positive. A thread resolved by a bot is not stored either.
10. **An event older than what is stored does not change a pull request's facts.** Age is the git service's own "updated at" on the pull request. With equal times the later arrival wins.
11. **The body limit is 25 MB**, the largest payload GitHub says it sends.
12. **A webhook must be sent as JSON.** One sent as a form is answered 400 `not_json`.
13. **The `app` and `database` blocks are optional in the shared config** so the eval commands keep working without them. The service refuses to start without both.
14. **The database URL is a secret by reference**, like a key: it holds a password.
15. **A thread event has no id of its own**, so its row is keyed by the delivery id, its time is when it arrived, and its association is empty. The signature does not cover the delivery id, so a captured request sent again under a new id is processed again; only a thread event then adds a row.
16. **Text is stored without NUL characters and with broken surrogate pairs replaced.** Postgres refuses the first, and a comment that could never be stored would fail on every redelivery.
17. **The sample-webhook tool posts only to this machine** (`localhost`, `127.0.0.1` or `::1`).
18. **At most 20 webhook requests are handled at once.** A request over that is answered 503 `busy` before its body is read. A body is held in memory before its signature can be checked, so without a cap anyone who can reach the port could make the service hold 25 MB per open request.
19. **A reply in a thread arrives twice from the git service**, once as the comment and once as a review with no text and state `commented`. Both are stored, as two kinds of row.

## Global Constraints

Every constraint of plans 1 and 2 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only: no `enum`, no `namespace`, no parameter properties. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character, and any control character, is written as an escape or built with `String.fromCharCode`. After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network or a real database.** `test/setup.ts` blocks sockets, so a test cannot open even a local connection. Database tests use `testDb()` from `src/db/testing.ts`, one fresh database per test. HTTP is tested by calling the listener with objects, never through a port.
- **The service makes no outbound call in this plan.** Nothing in `src/shell`, `src/db`, `src/service.ts` or `src/main.ts` calls `fetch`.
- **Boundaries, enforced by lint (Task 1):** only `src/db/**` imports `pg` or `@electric-sql/pglite`. Only `src/forge/github/**`, `src/eval/cli.ts` and `src/main.ts` import from `src/forge/github/**`. `src/engine/**` imports nothing from `db`, `shell`, `eval` or `forge/github`.
- **GitHub's header names and payload shapes appear only under `src/forge/github/`.** The shell sees `WebhookReader` and `ForgeEvent` from `src/forge/types.ts`.
- **SQL:** every value is a numbered parameter, never joined into the text. Every table is written with its schema, `visto_ai.<table>`. Columns are `text`, `integer`, `boolean`, `timestamptz` or `jsonb` only, and a count is cast with `::int`: the two clients agree on those. A `jsonb` value is passed as JSON text.
- **Times** cross the project's types as ISO 8601 strings. A query passes them as text cast to `timestamptz` and turns a returned `Date` back into a string with `toISOString()`, so a time read back has the form `2026-03-01T10:00:00.000Z`. Fixtures write times in that form.
- **Logs** carry ids, names, codes and counts. They never carry a payload, a comment's text, a signature, a secret or an error's message. **Answers** never carry a stack trace, a path or an error message: a short code only.
- **Fixtures are synthetic and invented:** `acme/shop`, pull request 7, logins such as `octo-dev`. No real repository, login, id or text.
- **Ported behaviour is named by a `PM-` key.** The key resolves to the predecessor's file privately, in the task's dispatch, never in this repository. What is carried over is the rule a test checks. Every literal is invented here.
- **Nothing internal in this repository,** including commit messages and the notes file.
- **Git:** work on a branch named `stage-4a`. Commit locally after each task. A commit made by an agent ends with that agent's own co-author line. `git config user.email` must print the owner's public address before the first commit. Push nothing without the owner's go-ahead.

## Review Focus

Inputs and failures the design implies, that a person running this would meet, each pinned by a test in the task that owns the code:

1. **The same delivery arrives twice.** It is stored once, and the second is answered `duplicate` (Task 7). Two arriving at the same moment cannot be told apart from two in a row by the in-process database, which has one connection: the guard is the form of the SQL (Task 2), and the real run sends two at once (Task 9).
2. **Events arrive out of order.** An older pull request event does not roll the stored facts back (Tasks 2 and 7).
3. **The database fails in the middle of a delivery.** Nothing is half stored, the delivery is not marked as seen, and the answer is 503 so it can be sent again (Task 7).
4. **A signed payload of a shape nobody expected:** an unknown event, an unknown action, a missing or wrongly typed field, a time that is not a time, a number too large to store. It is recorded as ignored with a reason and answered 202. It never raises and never answers 5xx (Tasks 4 and 7).
5. **Text written by strangers:** a comment with a NUL character, a broken surrogate pair, control characters or 65,000 characters. It is stored as data and reaches no log (Tasks 2 and 7).
6. **A caller that misbehaves on the wire:** a connection dropped in the middle of a body, a body over the limit, many requests at once. The service answers or lets go, and keeps running (Task 7).

## File Structure

```
src/db/types.ts              the Db interface
src/db/pglite.ts             Db over an in-process Postgres (tests)
src/db/postgres.ts           Db over a pg pool (production)
src/db/testing.ts            testDb(): a fresh migrated in-process database
src/db/migrate.ts            ordered migrations, each run once
src/db/migrations/0001_receiving.sql
src/db/text.ts               storable(): text Postgres will accept
src/db/deliveries.ts         recordDelivery
src/db/pull-requests.ts      savePullRequest, getPullRequest
src/db/human-activity.ts     recordActivity, listActivity
src/forge/types.ts           + PullRequestFacts, ForgeEvent, WebhookReader, WebhookReading
src/forge/github/objects.ts  author, review and comment mappers, moved out of history-source.ts
src/forge/github/events.ts   eventOf(name, payload): ForgeEvent
src/forge/github/webhook.ts  createGithubWebhookReader(secret)
src/forge/github/send-sample.ts  the sample-webhook tool
src/shell/capture.ts         captureOf(event, delivery, receivedAt)
src/shell/receive.ts         receive(deps, headers, body)
src/shell/http.ts            createListener(routes)
src/service.ts               startService(config, deps)
src/main.ts                  the command that starts the service
Dockerfile, compose.yaml, env.example, .dockerignore
```

## Shared Types

`PullRequestFacts` is added to `src/forge/types.ts` in Task 2 and the rest in Task 4. Later tasks use them exactly as written.

```ts
export interface PullRequestFacts {
  ref: PullRequestRef;
  author: string; authorIsBot: boolean;
  baseBranch: string; headBranch: string; headSha: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  mergedAt: string | null; closedAt: string | null; mergeCommit: string | null;
  installation: string | null;   // the app installation the event came through
  updatedAt: string;             // the git service's "updated at" of the pull request in this event
}
export type PullRequestAction = 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'retargeted' | 'closed' | 'other';
export type ForgeEvent =
  | { kind: 'ping' }
  | { kind: 'pull_request'; action: PullRequestAction; facts: PullRequestFacts }
  | { kind: 'review'; ref: PullRequestRef; review: HumanReview }
  | { kind: 'inline_comment'; ref: PullRequestRef; comment: HumanInlineComment }
  | { kind: 'general_comment'; ref: PullRequestRef; comment: GeneralComment }
  | { kind: 'thread'; ref: PullRequestRef; action: 'resolved' | 'unresolved'; thread: string; rootComment: string | null; actor: string; actorIsBot: boolean }
  | { kind: 'ignored'; reason: 'unknown_event' | 'unknown_action' | 'not_a_pull_request' | 'malformed' };
export type WebhookReading =
  | { ok: false; reason: 'bad_signature' | 'not_json' | 'no_delivery_id' | 'no_event_name' }
  | { ok: true; delivery: string; name: string; action: string | null; event: ForgeEvent };
export interface WebhookReader {
  /** `headers`: the request's headers, names in lower case. `body`: the bytes as received. */
  read(headers: Record<string, string | undefined>, body: Buffer): WebhookReading;
}
```

`PullRequestAction` has no reader in this plan. Plan 4's triggers read it; it is here because Task 4 is where the event is read.

---

### Task 1: The database part

**Files:**
- Create: `src/db/types.ts`, `src/db/pglite.ts`, `src/db/migrate.ts`, `src/db/testing.ts`, `src/db/migrations/.gitkeep`
- Modify: `package.json` (dependencies), `eslint.config.js`, `test/boundaries.test.ts`
- Test: `src/db/pglite.test.ts`, `src/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/db/types.ts
export interface Db {
  /** One statement with numbered parameters ($1, $2, ...). Returns its rows. */
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>;
  /** A script of several statements, without parameters. For migrations. */
  script(sql: string): Promise<void>;
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it rejects. Calling it on `tx` rejects with Error('nested_transaction'). */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// src/db/migrate.ts
export interface Migration { name: string; sql: string }
export const MIGRATIONS_DIR: string;                       // src/db/migrations, resolved from this file
export function loadMigrations(dir: string): Migration[]; // every *.sql file, by name; name is the file name without .sql
/** Applies what is not yet applied, in name order. Returns the names applied now. */
export function migrate(db: Db, migrations: Migration[]): Promise<string[]>;
// src/db/pglite.ts
export function pgliteDb(): Promise<Db>;                  // a fresh in-memory database
// src/db/testing.ts
export function testDb(): Promise<Db>;                    // pgliteDb() with loadMigrations(MIGRATIONS_DIR) applied
```

- [ ] **Step 1: Install the libraries**

Run: `npm install pg && npm install --save-dev @electric-sql/pglite @types/pg`
Expected: `package.json` lists `pg` under dependencies and the other two under devDependencies; `npm test` still passes.

- [ ] **Step 2: Write the failing tests**

`src/db/pglite.test.ts`:

```ts
test('a fresh database answers a query with parameters', async () => {
  const db = await pgliteDb();
  assert.deepEqual(await db.query('select $1::text as t, $2::int as n', ['a', 2]), [{ t: 'a', n: 2 }]);
  await db.close();
});
test('a transaction that rejects leaves nothing behind, one that resolves commits', async () => {
  const db = await pgliteDb();
  await db.script('create table t (n integer); create table u (n integer);');
  await assert.rejects(db.transaction(async (tx) => { await tx.query('insert into t values (1)'); throw new Error('stop'); }), /stop/);
  assert.deepEqual(await db.query('select count(*)::int as n from t'), [{ n: 0 }]);
  assert.equal(await db.transaction(async (tx) => { await tx.query('insert into t values (1)'); return 'done'; }), 'done');
  assert.deepEqual(await db.query('select count(*)::int as n from t'), [{ n: 1 }]);
  assert.deepEqual(await db.query('select count(*)::int as n from u'), [{ n: 0 }]); // the script ran both statements
});
test('a transaction inside a transaction is refused', async () => {
  const db = await pgliteDb();
  await assert.rejects(db.transaction((tx) => tx.transaction(async () => 1)), /nested_transaction/);
});
test('a time comes back as a Date, jsonb as an object, a cast count as a number', async () => {
  const db = await pgliteDb();
  const [row] = await db.query<{ at: unknown; j: unknown; n: unknown }>(
    "select '2026-01-02T03:04:05Z'::timestamptz as at, '{\"a\":1}'::jsonb as j, count(*)::int as n");
  assert.ok(row!.at instanceof Date);
  assert.equal((row!.at as Date).toISOString(), '2026-01-02T03:04:05.000Z');
  assert.deepEqual(row!.j, { a: 1 });
  assert.equal(row!.n, 1);
});
test('two databases share nothing', async () => {
  const [a, b] = [await pgliteDb(), await pgliteDb()];
  await a.script('create table only_in_a (n integer)');
  await assert.rejects(b.query('select * from only_in_a'));
});
```

`src/db/migrate.test.ts`, with `const one = { name: '0001_a', sql: 'create table visto_ai.a (n integer);' }` and `const two = { name: '0002_b', sql: 'create table visto_ai.b (n integer); insert into visto_ai.b values (1);' }`:

- `migrate(db, [two, one])` returns `['0001_a', '0002_b']`; a second call returns `[]`; `select name from visto_ai.schema_migrations order by name` gives both names.
- A migration whose second statement fails (`'create table visto_ai.c (n integer); select nope();'`) rejects; afterwards `visto_ai.c` does not exist and its name is not in `schema_migrations`.
- With `0001_a` applied, `migrate(db, [two])` rejects with a message matching `/unknown_migration_applied/`: the database is ahead of the code.
- `migrate(db, [])` on a fresh database creates the schema `visto_ai` and the table `visto_ai.schema_migrations (name text primary key, applied_at timestamptz not null default now())`.
- `loadMigrations` on a temporary directory holding `0002_b.sql`, `0001_a.sql`, `notes.txt` and `.gitkeep` returns the two `.sql` files in name order with their text.
- `testDb()` resolves, and `select count(*)::int as n from visto_ai.schema_migrations` answers.

Add to `test/boundaries.test.ts`, in the file's existing style:

```ts
test('only the db part may import a Postgres client', async () => {
  for (const name of ['pg', '@electric-sql/pglite']) {
    assert.ok((await lint(`import '${name}';\n`, 'src/shell/x.ts')).includes('no-restricted-imports'), name);
    assert.ok((await lint(`import '${name}';\n`, 'src/forge/github/x.ts')).includes('no-restricted-imports'), name);
    assert.deepEqual(await lint(`import '${name}';\n`, 'src/db/x.ts'), [], name);
  }
});
test('the engine may not import the db or the shell', async () => {
  assert.ok((await lint("import '../db/types.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
  assert.ok((await lint("import '../shell/receive.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the shell may not import the GitHub adapter, and the service entry may', async () => {
  assert.ok((await lint("import '../forge/github/webhook.ts';\n", 'src/shell/x.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import './forge/github/webhook.ts';\n", 'src/main.ts'), []);
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/db/pglite.test.ts src/db/migrate.test.ts test/boundaries.test.ts`
Expected: FAIL: the `src/db` modules do not exist, and each of the three new boundary tests fails on one of its assertions.

- [ ] **Step 4: Implement**

- `pgliteDb()` wraps one `PGlite` instance. `query` returns the rows. `script` runs the whole text. `transaction` hands `work` a `Db` bound to the transaction whose own `transaction` rejects.
- The in-process database must start under `test/setup.ts` as it is, and a test process must end on its own after the tests. If either fails (it tries to open a socket or to fetch, or it keeps the process alive), stop and report it: do not loosen the test setup.
- `migrate` first runs `create schema if not exists visto_ai` and creates `schema_migrations`. Each migration runs in one transaction together with the insert of its name. Order is by name, whatever the order of the list.
- `eslint.config.js`: flat config does not merge a rule's options across blocks, so each block that sets `no-restricted-imports` must carry every restriction that applies to its files. The tests in Step 2 and the existing ones define the result.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass. `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json eslint.config.js test/boundaries.test.ts src/db
git commit -m "feat: the db part, with migrations and an in-process database for tests"
```

---

### Task 2: The first migration and its queries

**Files:**
- Create: `src/db/migrations/0001_receiving.sql`, `src/db/text.ts`, `src/db/deliveries.ts`, `src/db/pull-requests.ts`, `src/db/human-activity.ts`
- Delete: `src/db/migrations/.gitkeep`
- Modify: `src/forge/types.ts` (add `PullRequestFacts` only, from Shared Types; the rest arrives in Task 4)
- Test: `src/db/text.test.ts`, `src/db/deliveries.test.ts`, `src/db/pull-requests.test.ts`, `src/db/human-activity.test.ts`

**Interfaces:**
- Consumes: `Db`, `testDb` (Task 1); `PullRequestRef`, `Association`, `Side`, `HumanReview` from `src/forge/types.ts`.
- Produces:

```ts
// src/db/text.ts
/** Text Postgres will store: no NUL character, and a broken surrogate pair replaced by U+FFFD. */
export function storable(text: string): string;
// src/db/deliveries.ts
/** false when this id was already recorded: the caller then does nothing else. */
export function recordDelivery(db: Db, d: { id: string; name: string; action: string | null; outcome: 'handled' | 'ignored'; reason: string | null }): Promise<boolean>;
// src/db/pull-requests.ts
/** Inserts or updates. false, and nothing written, when the stored facts are newer (a later updatedAt). */
export function savePullRequest(db: Db, facts: PullRequestFacts): Promise<boolean>;
export function getPullRequest(db: Db, ref: PullRequestRef): Promise<PullRequestFacts | null>;
// src/db/human-activity.ts
export type ActivityKind = 'review' | 'inline_comment' | 'general_comment' | 'thread_resolved' | 'thread_unresolved';
export interface Activity {
  ref: PullRequestRef; kind: ActivityKind;
  sourceId: string;                 // the git service's id of the review or comment; the delivery id for a thread event
  author: string; association: Association | null;
  state: HumanReview['state'] | null; body: string;
  path: string | null; side: Side | null; line: number | null; startLine: number | null; fileLevel: boolean | null;
  commit: string | null; replyTo: string | null; thread: string | null;
  at: string;
  delivery: string | null;          // the delivery that brought it; null for a row that came another way
}
/** false when it was already stored (same service, kind and source id). */
export function recordActivity(db: Db, a: Activity): Promise<boolean>;
export function listActivity(db: Db, ref: PullRequestRef): Promise<Activity[]>; // oldest first: by `at`, then by insertion
```

- [ ] **Step 1: Write the migration**

`src/db/migrations/0001_receiving.sql`:

```sql
create table visto_ai.deliveries (
  id text primary key,
  name text not null,
  action text,
  outcome text not null,
  reason text,
  received_at timestamptz not null default now()
);

create table visto_ai.pull_requests (
  service text not null, owner text not null, repo text not null, number integer not null,
  author text not null, author_is_bot boolean not null,
  base_branch text not null, head_branch text not null, head_sha text not null,
  draft boolean not null,
  state text not null,
  merged_at timestamptz, closed_at timestamptz, merge_commit text,
  installation text,
  updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  primary key (service, owner, repo, number)
);

create table visto_ai.human_activity (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  kind text not null,
  source_id text not null,
  author text not null,
  association text,
  state text,
  body text not null,
  path text, side text, line integer, start_line integer, file_level boolean,
  commit text, reply_to text, thread text,
  at timestamptz not null,
  delivery text,
  unique (service, kind, source_id)
);
create index human_activity_pull_request on visto_ai.human_activity (service, owner, repo, number);
```

- [ ] **Step 2: Write the failing tests**

Each test opens its own `testDb()`. Use `const ref = { service: 'github' as const, owner: 'acme', repo: 'shop', number: 7 }`.

`src/db/text.test.ts` (build the characters with `String.fromCharCode`, so the file stays ASCII):
- `storable('a' + String.fromCharCode(0) + 'b')` is `'ab'`.
- `storable('a' + String.fromCharCode(0xd800) + 'b')` is `'a' + String.fromCharCode(0xfffd) + 'b'`.
- `storable('plain')` is `'plain'`.

`src/db/deliveries.test.ts`:
- `recordDelivery` with id `'d-1'` returns `true`, and `false` the second time; the table then holds one row with the first call's `name`, `action`, `outcome` and `reason`.

`src/db/pull-requests.test.ts`, with `facts(over)` building open, non-draft facts for `ref` by `octo-dev`, `updatedAt: '2026-03-01T10:00:00.000Z'`, `installation: '55'`:
- Saved facts are read back equal by `getPullRequest`.
- A later `updatedAt` with `headSha` changed returns `true` and is what `getPullRequest` then returns. The row's `first_seen_at` is the same before and after.
- **PM-push-order:** an earlier `updatedAt` returns `false` and leaves every stored field as it was.
- The same `updatedAt` with a changed `headSha` returns `true`: the later arrival wins.
- An update whose `installation` is `null` keeps the stored `'55'`.
- `{ ...ref, owner: 'Acme', repo: 'Shop' }` reads and updates the same row; `getPullRequest` returns owner `'acme'`, repo `'shop'`.
- `getPullRequest` for an unknown pull request is `null`.
- A merged pull request keeps `state: 'merged'`, `mergedAt`, `closedAt` and `mergeCommit`.

`src/db/human-activity.test.ts`:
- An approval with an empty body (`kind: 'review'`, `state: 'approved'`, `body: ''`) is stored and listed with every field equal to what was passed.
- The same `kind` and `sourceId` a second time returns `false` and adds no row; the same `sourceId` under another `kind` is stored.
- A row with `delivery: null` is stored and listed.
- `listActivity` returns rows oldest first by `at`, and in insertion order when `at` is equal.
- **Review Focus 5:** a body holding a NUL character, a lone surrogate and 65,000 characters is stored; what is read back has no NUL and is otherwise the same length.
- `listActivity` for another pull request of the same repository is empty.

- [ ] **Step 3: Run them and see them fail**

Run: `node --import ./test/setup.ts --test "src/db/*.test.ts"`
Expected: FAIL: the new modules do not exist.

- [ ] **Step 4: Implement**

- Every text value written goes through `storable`. `owner` and `repo` are lower-cased on every write and every lookup.
- `savePullRequest` is one statement: an insert that on conflict updates only when the stored `updated_at` is not later than the new one, keeps `first_seen_at`, and keeps the stored `installation` when the new one is null. Whether a row came back tells the result.
- `recordDelivery` and `recordActivity` are each one `insert ... on conflict do nothing returning` statement. That form, and not a select followed by an insert, is what makes a second delivery arriving at the same moment wait for the first and then report `false` (Review Focus 1).
- Times are passed as text cast to `timestamptz` and read back with `toISOString()`.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src/db src/forge/types.ts
git commit -m "feat: tables and queries for deliveries, pull request facts and human activity"
```

---

### Task 3: Configuration for the service

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `config.example.yml`, and the two test files that build a `DeploymentConfig` by hand: `src/eval/replay.test.ts`, `src/eval/backtest/run.test.ts` (each gains `app: null, database: null, server: { port: 8080 }`)
- Test: `src/config/load.test.ts`

**Interfaces:**
- Consumes: the existing `parseConfig`, `ConfigError`, `DeploymentConfig`.
- Produces:

```ts
// DeploymentConfig gains:
app: { webhookSecret: string } | null;
database: { url: string } | null;
server: { port: number };
export type ServiceConfig = DeploymentConfig & { app: { webhookSecret: string }; database: { url: string } };
/** The config a running service needs. Throws a ConfigError naming each missing block. */
export function serviceConfig(config: DeploymentConfig): ServiceConfig;
```

The blocks, as a deployment writes them:

```yaml
app:
  webhookSecret: { env: WEBHOOK_SECRET }
database:
  url: { env: DATABASE_URL }
server:
  port: 8080
```

- [ ] **Step 1: Write the failing tests**

In `src/config/load.test.ts`, with the file's `minimal` text and `const service = minimal + 'app:\n  webhookSecret: { env: HOOK }\ndatabase:\n  url: { env: DB_URL }\n'` and `const env = { MODEL_KEY: 'k', HOOK: 'hook-secret-value', DB_URL: 'postgres://u:db-password-value@db:5432/visto' }`:

- Without the blocks: `app` and `database` are `null`, `server` is `{ port: 8080 }`.
- With them: `app` is `{ webhookSecret: 'hook-secret-value' }`, `database.url` is the URL.
- `server: { port: 9000 }` is read; `0`, `65536`, `80.5` and an unknown key inside `server` are each a `ConfigError` whose issue starts with `server`.
- An unset `HOOK` gives the issue `app.webhookSecret: environment variable HOOK is not set`. An unset `DB_URL` gives `database.url: environment variable DB_URL is not set`.
- A `DB_URL` of `mysql://u:db-password-value@db/x` gives the issue `database.url: must be a postgres URL`, and the whole error message does not contain `db-password-value`. Both `postgres://` and `postgresql://` are accepted.
- A webhook secret written inline (`webhookSecret: hook-secret-value`) is a `ConfigError` whose message does not contain `hook-secret-value`.
- An unknown key inside `app` or `database` is a `ConfigError` that names the key.
- `serviceConfig` on a config without the blocks throws a `ConfigError` whose issues are exactly `['app: required to run the service', 'database: required to run the service']`; with both it returns the config.
- The example file as shipped still loads with only the model's key variable set, and has `app` and `database` as `null`.
- The example file with its three service blocks switched on (remove the comment marks the way the file's existing scorer test does) loads when their variables are set, and `serviceConfig` accepts it.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/config/load.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`app` and `database` are optional strict objects in the schema; `server` is a strict object with `port` defaulting to 8080. `parseConfig` resolves the two secrets like `model.apiKey`. `config.example.yml` gains the three blocks commented out, each line explained in the file's style, under a line saying they are needed only to run the service.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/config src/eval/replay.test.ts src/eval/backtest/run.test.ts config.example.yml
git commit -m "feat: config blocks for the service: the webhook secret, the database and the port"
```

---

### Task 4: Normalised events

**Files:**
- Create: `src/forge/github/objects.ts`, `src/forge/github/events.ts`
- Modify: `src/forge/types.ts` (the rest of Shared Types), `src/forge/github/history-source.ts` (use the moved mappers)
- Test: `src/forge/github/objects.test.ts`, `src/forge/github/events.test.ts`

**Interfaces:**
- Consumes: `HumanReview`, `HumanInlineComment`, `GeneralComment`, `PullRequestFacts`, and the mapping code inside `history-source.ts`.
- Produces:

```ts
// src/forge/github/objects.ts: the same objects arrive in a list answer and in a webhook
export function authorOf(raw: unknown): { author: string; authorIsBot: boolean };
export function reviewOf(raw: unknown): HumanReview | null;        // null for a pending review
export function inlineCommentOf(raw: unknown): HumanInlineComment;
export function generalCommentOf(raw: unknown): GeneralComment;
// the three mappers throw Error('github_bad_response') on a shape they cannot read, as the code does today
// src/forge/github/events.ts
export function eventOf(name: string, payload: unknown): ForgeEvent; // never throws
```

What `eventOf` reads. Check every field name against GitHub's public webhook documentation before writing a fixture, and report any that differs; the fixtures are invented. In every row `ref` is `{ service: 'github', owner: repository.owner.login, repo: repository.name, number }`.

| Event name | Actions | Result |
|---|---|---|
| `ping` | any | `{ kind: 'ping' }` |
| `pull_request` | `opened`, `reopened`, `ready_for_review`, `synchronize`, `closed` map to themselves. `edited` with `changes.base` present is `retargeted`. Any other action is `other` | `pull_request` with facts. `number` is the payload's `number`. `author` and `authorIsBot` from `authorOf(pull_request.user)`; `base.ref`, `head.ref`, `head.sha`, `draft`; `state` is `merged` when `pull_request.merged` is true, otherwise `pull_request.state`; `merged_at`, `closed_at`; `merge_commit_sha` only when merged; `installation.id` as text, or null; `pull_request.updated_at` |
| `pull_request_review` | `submitted`. Others, `dismissed` among them: `unknown_action` | `review`, mapped by `reviewOf(payload.review)`; `number` from `pull_request.number`. A pending review is `unknown_action` |
| `pull_request_review_comment` | `created`. Others: `unknown_action` | `inline_comment`, mapped by `inlineCommentOf(payload.comment)`; `number` from `pull_request.number` |
| `issue_comment` | `created`. Others: `unknown_action` | `general_comment`, mapped by `generalCommentOf(payload.comment)`; `number` from `issue.number`. Without `issue.pull_request` it is `not_a_pull_request` |
| `pull_request_review_thread` | `resolved`, `unresolved`. Others: `unknown_action` | `thread`: `thread.node_id`; `rootComment` the id, as text, of the first of `thread.comments`, or null; `actor` and `actorIsBot` from `authorOf(sender)`; `number` from `pull_request.number` |
| anything else | | `unknown_event` |

`{ kind: 'ignored', reason: 'malformed' }` is the result when any of these holds, so that nothing `eventOf` returns can be refused by the database:
- the payload is not an object, or lacks or mistypes a field its row needs;
- a time (`updated_at`, `merged_at`, `closed_at`, a review's `submitted_at`, a comment's `created_at`) is present and `Date.parse` cannot read it;
- the pull request's `number`, or a comment's line or start line, is not a whole number from 1 to 2,147,483,647.

Every time in the result is rewritten with `new Date(value).toISOString()`.

- [ ] **Step 1: Write the failing tests**

`src/forge/github/objects.test.ts`:
- A review whose `state` is `'APPROVED'` and one whose `state` is `'approved'` both map to `state: 'approved'`: a list answer writes it in capitals and a webhook in lower case.
- A review with `body: null` maps to `body: ''`; a review with `state: 'PENDING'` maps to `null`.
- `authorOf({ login: 'octo-dev', type: 'User' })` is a person; `{ login: 'tool', type: 'Bot' }` and `{ login: 'tool[bot]', type: 'User' }` are bots.
- The existing tests of `history-source.ts` still pass unchanged after the move.

`src/forge/github/events.test.ts`, with small builders `repo()`, `user(login, type)` and one builder per event that returns an invented payload:
- One test per row of the table above asserting the whole resulting event with `assert.deepEqual`.
- `pull_request` closed with `merged: true` gives `state: 'merged'` and a `mergeCommit`; closed with `merged: false` gives `state: 'closed'` and `mergeCommit: null`.
- `pull_request` with action `labeled` gives action `other` and full facts; `edited` without `changes.base` gives `other`; with it, `retargeted`.
- A payload without `installation` gives `installation: null`.
- `issue_comment` on an issue gives `not_a_pull_request`; action `edited` or `deleted` gives `unknown_action`. A review with action `dismissed` gives `unknown_action`.
- A time written as `2026-03-01T10:00:00Z` comes out as `2026-03-01T10:00:00.000Z`.
- **Review Focus 4:** each of these returns `{ kind: 'ignored', reason: 'malformed' }` without throwing: `null`, `'text'`, `[]`, `{}`, a pull request event whose `number` is `'7'`, one whose `number` is `2147483648`, one without `pull_request`, one whose `updated_at` is `'yesterday'`, a review event whose `review` is `null`, an inline comment whose `line` is `-1`. An event named `deployment` gives `unknown_event`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test "src/forge/github/*.test.ts"`
Expected: FAIL: the two modules do not exist.

- [ ] **Step 3: Implement**

- Move `authorOf` and the three mappers out of `history-source.ts` without changing what they return, apart from reading a review's state without regard to case. `history-source.ts` imports them.
- `eventOf` catches what the mappers throw and returns `malformed`.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/forge
git commit -m "feat: GitHub webhook payloads become the project's own events"
```

---

### Task 5: The webhook reader

**Files:**
- Create: `src/forge/github/webhook.ts`
- Test: `src/forge/github/webhook.test.ts`

**Interfaces:**
- Consumes: `eventOf` (Task 4); `WebhookReader`, `WebhookReading` from `src/forge/types.ts`.
- Produces:

```ts
export function createGithubWebhookReader(secret: string): WebhookReader; // throws Error('empty_webhook_secret') for ''
```

`read`, in order (**PM-signature**):

1. The header `x-hub-signature-256` must be `sha256=` followed by the hex HMAC-SHA256 of the body's bytes under the secret. Both sides are compared as bytes with `timingSafeEqual`, after checking that the two byte lengths are equal. Anything else is `bad_signature`.
2. The body must parse as JSON: otherwise `not_json`.
3. `x-github-delivery` must be a non-empty string: otherwise `no_delivery_id`. `x-github-event` likewise: otherwise `no_event_name`.
4. `action` is the payload's `action` when it is a string, otherwise `null`. `event` is `eventOf(name, payload)`.

- [ ] **Step 1: Write the failing tests**

`src/forge/github/webhook.test.ts`, with `const secret = 'hook-secret-value'`, `const reader = createGithubWebhookReader(secret)` and `const sign = (body: Buffer) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')`:

```ts
const headers = (body: Buffer, over: Record<string, string | undefined> = {}) =>
  ({ 'x-github-event': 'ping', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(body), ...over });
test('a signed ping is read', () => {
  const body = Buffer.from('{"zen":"x"}');
  assert.deepEqual(reader.read(headers(body), body), { ok: true, delivery: 'd-1', name: 'ping', action: null, event: { kind: 'ping' } });
});
```

- Each of these is `{ ok: false, reason: 'bad_signature' }`: no signature header; a signature of another length; one made with another secret; one over a body that differs by one byte; one prefixed `sha1=`; a header of the right length in characters that holds one non-ASCII character (build it with `String.fromCharCode(233)`), which must not throw.
- The signature is checked before anything else: a bad signature on a body that is not JSON is `bad_signature`, not `not_json`.
- A correctly signed body that is not JSON (`a=1&b=2`) is `not_json`.
- A missing or empty `x-github-delivery` is `no_delivery_id`; a missing or empty `x-github-event` is `no_event_name`.
- A signed `issue_comment` payload with `action: 'created'` gives `action: 'created'` and a `general_comment` event; a payload whose `action` is a number gives `action: null`.
- `createGithubWebhookReader('')` throws `Error('empty_webhook_secret')`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/forge/github/webhook.test.ts`
Expected: FAIL: the module does not exist.

- [ ] **Step 3: Implement** as specified above.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/forge/github/webhook.ts src/forge/github/webhook.test.ts
git commit -m "feat: a webhook reader for GitHub: the signature first, then the event"
```

---

### Task 6: Capture

**Files:**
- Create: `src/shell/capture.ts`
- Test: `src/shell/capture.test.ts`

**Interfaces:**
- Consumes: `ForgeEvent`, `PullRequestFacts` (Task 4), `Activity` (Task 2).
- Produces:

```ts
export type Capture =
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'handled'; pullRequest: PullRequestFacts | null; activity: Activity | null };
/** What an event stores. Pure: it reads no clock and no database. */
export function captureOf(event: ForgeEvent, delivery: string, receivedAt: Date): Capture;
```

| Event | Capture |
|---|---|
| `ping` | ignored, reason `ping` |
| `ignored` | ignored, with the event's reason |
| `pull_request`, any action, any author | handled: its facts, no activity |
| `review` by a bot | ignored, reason `bot_author` |
| `review` by a person | handled: activity `review`; `sourceId` the review's id; `state`, `body`, `commit`, `association`, `at` from the review |
| `inline_comment` by a person | handled: activity `inline_comment` with `path`, `side`, `line`, `startLine`, `fileLevel`, `commit`, `replyTo`, `body`, `association`, `at` |
| `general_comment` by a person | handled: activity `general_comment` with `body`, `association`, `at` |
| `inline_comment` or `general_comment` by a bot | ignored, reason `bot_author` |
| `thread` by a person | handled: activity `thread_resolved` or `thread_unresolved`; `sourceId` the delivery id; `thread`; `replyTo` the root comment; `author` the actor; `association` null; `at` the arrival time as ISO text |
| `thread` by a bot | ignored, reason `bot_author` |

Every activity carries the event's `ref` and `delivery`. Fields an activity does not use are `null`, and `body` is `''` where there is none.

- [ ] **Step 1: Write the failing tests**

`src/shell/capture.test.ts`: one test per row of the table, each asserting the whole result with `assert.deepEqual`. Plus:
- **PM-capture, fixed:** an approval with an empty body by a person is handled, not dropped.
- A pull request opened by a bot is handled, and its facts keep `authorIsBot: true`.
- A comment by the pull request's own author is handled like any person's.
- `captureOf` called twice with the same arguments returns equal results.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/shell/capture.test.ts`
Expected: FAIL: the module does not exist.

- [ ] **Step 3: Implement `captureOf`** as the table says.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/shell
git commit -m "feat: what each event stores about people and the pull request"
```

---

### Task 7: The receiver

**Files:**
- Create: `src/shell/receive.ts`, `src/shell/http.ts`
- Test: `src/shell/receive.test.ts`, `src/shell/http.test.ts`

**Interfaces:**
- Consumes: `Db`, `testDb`, `recordDelivery`, `savePullRequest`, `recordActivity`, `listActivity`, `getPullRequest`; `WebhookReader`, `WebhookReading`; `captureOf`.
- Produces:

```ts
// src/shell/receive.ts
export interface HttpAnswer { status: number; body: string }
export interface ReceiveDeps { db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void }
export function receive(deps: ReceiveDeps, headers: Record<string, string | undefined>, body: Buffer): Promise<HttpAnswer>; // never rejects
// src/shell/http.ts
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_IN_FLIGHT = 20;
export interface RequestLike extends AsyncIterable<Buffer> { method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined> }
export interface ResponseLike { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }
export function createListener(
  routes: { webhook: (headers: Record<string, string | undefined>, body: Buffer) => Promise<HttpAnswer> },
  limits?: { maxBodyBytes?: number; maxInFlight?: number },   // for tests; the defaults are the two constants
): { listener: (req: RequestLike, res: ResponseLike) => void; idle: () => Promise<void> };
```

`receive`, in order (**PM-receive**, with its gaps closed):

1. `reader.read`. Not ok: 401 `invalid_signature` for `bad_signature`, otherwise 400 with the reason as the body.
2. `captureOf(event, delivery, clock())`.
3. One transaction: `recordDelivery` with the capture's outcome and reason. If it returns false, stop: 202 `duplicate`. Otherwise `savePullRequest` when there are facts, then `recordActivity` when there is an activity.
4. After the commit: 202 `accepted` for a handled delivery, 202 `ignored` for an ignored one.
5. If the transaction rejects: 503 `storage_unavailable`.
6. If `reader.read` or `captureOf` throws: 500 `internal_error`.

One log entry per call: `{ event: 'webhook', delivery, name, action, outcome, reason }`.
- `outcome` is `accepted`, `ignored`, `duplicate`, `rejected` (steps 1 and its 400 and 401 answers) or `failed` (steps 5 and 6). `reason` is the code, or null for `accepted` and `duplicate`.
- For a `rejected` call, and for a `failed` one where the reader threw, `delivery`, `name` and `action` are `null`: the shell does not read the git service's headers itself.
- A `failed` entry adds `error`, the error's `name`, and `code`, the error's `code` when that is a string (Postgres puts its SQLSTATE there), otherwise null. Never the message.
- A logger that throws changes nothing.

`createListener`:

| Request | Answer |
|---|---|
| `POST /webhooks/github` | the route's answer |
| `POST /webhooks/github` while `maxInFlight` webhook requests are already being handled | 503 `busy`, without reading the body |
| `POST /webhooks/github` whose `content-length` is over the limit, or whose body grows past it | 413 `payload_too_large`, without calling the route |
| `POST /webhooks/github` whose body stream fails (the caller dropped the connection) | no answer is owed; nothing throws, no promise is left rejected, and the request stops counting as in flight |
| `GET /healthz` | 200 `ok` |
| another method on either path | 405 `method_not_allowed` |
| any other path | 404 `not_found` |
| the route rejects or throws | 500 `internal_error` |

Every answer has `content-type: text/plain; charset=utf-8` and `cache-control: no-store`. A query string does not change which path matches. A header given several times is read as its first value. `idle()` resolves when no request is being handled, counting a request from its arrival until its answer has been written or its stream has failed.

- [ ] **Step 1: Write the failing tests**

`src/shell/receive.test.ts` uses a real `testDb()` and a fake reader: `const reader = (reading: WebhookReading): WebhookReader => ({ read: () => reading })`. Events are built as `ForgeEvent` values; no GitHub payload appears in this file.

```ts
test('a review by a person is stored before the answer, and answered accepted', async () => {
  const db = await testDb();
  const logs: Record<string, unknown>[] = [];
  const answer = await receive({ db, reader: reader(read('d-1', reviewEvent)), clock, log: (e) => logs.push(e) }, {}, Buffer.from(''));
  assert.deepEqual(answer, { status: 202, body: 'accepted' });
  assert.equal((await listActivity(db, ref)).length, 1);
  assert.deepEqual(logs, [{ event: 'webhook', delivery: 'd-1', name: 'pull_request_review', action: 'submitted', outcome: 'accepted', reason: null }]);
});
```

- A pull request event stores its facts: `getPullRequest` returns them.
- An ignored event (`{ kind: 'ignored', reason: 'unknown_event' }`) answers 202 `ignored`, stores nothing but the delivery row, whose `outcome` is `ignored` and `reason` is `unknown_event`.
- `bad_signature` answers 401 `invalid_signature` and stores no delivery row; `not_json`, `no_delivery_id` and `no_event_name` each answer 400 with that word. Each logs `outcome: 'rejected'` with `delivery`, `name` and `action` null.
- **Review Focus 1:** the same delivery twice answers `accepted` then `duplicate`, with one activity row. Two calls started together with `Promise.all` give one `accepted` and one `duplicate`, in either order, and one activity row.
- **Review Focus 2:** a pull request event with `updatedAt` 10:00 after one with 11:00 answers 202 `accepted`, and `getPullRequest` still returns the 11:00 facts.
- **Review Focus 3:** with a `Db` whose transaction hands out a `tx` that rejects on its second `query` with an error whose `code` is `'57P01'` and whose message is `'do-not-log-this'`, the answer is 503 `storage_unavailable`. Afterwards the same delivery through the real database answers `accepted`, so nothing of the failed attempt was kept. The log entry has `outcome: 'failed'`, `error` equal to the error's name and `code: '57P01'`, and `JSON.stringify(logs)` does not contain `do-not-log-this`.
- A reader whose `read` throws answers 500 `internal_error` and logs `outcome: 'failed'`; `receive` does not reject.
- **Review Focus 5:** a comment whose body holds `'secret-looking-text'` is stored, and `JSON.stringify(logs)` does not contain that text.
- A logger that throws does not change the answer.

`src/shell/http.test.ts` builds requests with `Object.assign(Readable.from([Buffer.from('ab'), Buffer.from('c')]), { method: 'POST', url: '/webhooks/github', headers: { 'x-a': 'b' } })` and a response object that records `writeHead` and `end`:

- One test per row of the table above.
- The route receives the body's bytes joined (`'abc'`) and the headers.
- With `{ maxBodyBytes: 8 }`, a body of 9 bytes sent in chunks with no `content-length` answers 413 and the route is not called; so does a request whose `content-length` is `'9'`.
- With `{ maxInFlight: 1 }` and one request held by a route promise the test controls, a second webhook request answers 503 `busy`; after the first is released, a third is handled.
- **Review Focus 6:** a request built from an async generator that yields one chunk and then throws: the route is not called, the test sees no unhandled rejection (await a turn of the event loop, then assert), and `idle()` resolves.
- `/webhooks/github?x=1` matches the webhook path.
- `idle()` resolves at once with nothing in flight, and only after the answer when a request is being handled.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test "src/shell/*.test.ts"`
Expected: FAIL: the two modules do not exist.

- [ ] **Step 3: Implement** as specified above.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/shell
git commit -m "feat: receive a webhook: verify, reject duplicates, store, then acknowledge"
```

---

### Task 8: The production database client and the service entry

**Files:**
- Create: `src/db/postgres.ts`, `src/service.ts`, `src/main.ts`
- Modify: `package.json` (a `start` script: `node src/main.ts`), `eslint.config.js` only if Task 1 left `src/main.ts` out
- Test: `src/db/postgres.test.ts`, `src/service.test.ts`, `src/main.test.ts`

**Interfaces:**
- Consumes: `Db`, `migrate`, `loadMigrations`, `MIGRATIONS_DIR`; `ServiceConfig`, `serviceConfig`, `loadConfig`, `ConfigError`; `createListener`, `receive`, `RequestLike`, `ResponseLike`; `createGithubWebhookReader`.
- Produces:

```ts
// src/db/postgres.ts
export interface ClientLike { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }
export interface PoolLike extends Pick<ClientLike, 'query'> {
  connect(): Promise<ClientLike>; end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
type Log = (entry: Record<string, unknown>) => void;
export function postgresDbFrom(pool: PoolLike, log: Log): Db;
export function postgresDb(url: string, log: Log): Db;    // postgresDbFrom(new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 }), log)
// src/service.ts
export interface Listening { close(): Promise<void> }     // stops accepting new connections
export interface ServiceDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: Log;
  listen: (listener: (req: RequestLike, res: ResponseLike) => void, port: number) => Promise<Listening>;
}
export const STOP_WAIT_MS = 10_000;
/** Migrates, then listens. `stop` closes the listener, waits for requests in flight (at most STOP_WAIT_MS), then closes the database. */
export function startService(config: ServiceConfig, deps: ServiceDeps): Promise<{ stop(): Promise<void> }>;
// src/main.ts
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export function createServer(listener: (req: RequestLike, res: ResponseLike) => void): import('node:http').Server;
export function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

`src/db/postgres.test.ts`, with a fake pool that records every statement text in one list, whether each client was released, and the listener given to `on`:
- `query` returns the pool's `rows`.
- `transaction` takes one client, sends `begin`, the work's statements and `commit` on that client, and releases it. When the work rejects it sends `rollback`, releases the client and rejects with the same error.
- When `commit` itself rejects, the client is still released and the rejection reaches the caller.
- `tx.transaction` rejects with `nested_transaction`.
- `close` ends the pool.
- `postgresDbFrom` registers an `error` listener on the pool. Calling it with an error whose `code` is `'57P01'` and whose message is `'do-not-log-this'` does not throw and logs exactly `{ event: 'database_error', error: <the error's name>, code: '57P01' }`. A pool with no listener would end the process when Postgres restarts.

`src/service.test.ts`, with `testDb()`, a fake reader and a fake `listen` that records the port and returns a `close` the test can observe:
- `startService` applies the migrations before it listens: at the moment `listen` is called, `visto_ai.deliveries` exists.
- It listens on the configured port.
- A request given to the captured listener is answered by the receiver (a reading through the fake reader stores a delivery).
- `stop` closes the listener first, then waits for a request in flight, then closes the database: assert the order with a list the fakes push to.
- When `listen` rejects, or when a migration rejects (give it a `Db` whose `script` rejects), `startService` rejects and the database is closed.

`src/main.test.ts`:
- `main([], {}, out)` returns 2 and prints one line starting `usage:`.
- `main(['--config', '<a path that does not exist>'], {}, out)` returns 2 and prints `usage: cannot read --config`.
- A config file without the `app` block returns 2 and prints `config: app: required to run the service` among its lines. Write the file under `os.tmpdir()`.
- No line printed in these cases contains a value of an environment variable passed in.
- `createServer(listener)` returns a server whose `requestTimeout` is `REQUEST_TIMEOUT_MS` (30000) and whose `headersTimeout` is `HEADERS_TIMEOUT_MS` (10000). The test never calls `listen`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/db/postgres.test.ts src/service.test.ts src/main.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

- `main` takes one option, `--config <path>`. It loads the config, builds `postgresDb`, the GitHub reader and an `http.createServer` listener, starts the service and returns only when it has stopped. It logs one JSON line per entry to standard output.
- The server it creates has `requestTimeout` set to 30,000 ms and `headersTimeout` to 10,000 ms, exported as `REQUEST_TIMEOUT_MS` and `HEADERS_TIMEOUT_MS`. Node's default lets a caller take five minutes to send a request, and each such caller holds one of the 20 places (call 18). Build the server in a small exported function, `createServer(listener)`, so a test can assert both values on the server object without opening a port.
- Exit codes: 2 for a usage error or a `ConfigError` (it prints `usage: ...` or one `config: <issue>` line per issue); 1 when the service cannot start for another reason (it prints the single line `start_failed` and logs `{ event: 'start_failed', error: <name>, code: <code or null> }`); 0 after a clean stop. It never prints a stack trace, an error's message, the database URL or a secret.
- **PM-drain:** on `SIGTERM` or `SIGINT` it calls `stop` and exits with 0. A second signal exits at once with 1.
- The path that opens a port and connects to Postgres has no unit test: Task 9 exercises it.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/db/postgres.ts src/db/postgres.test.ts src/service.ts src/service.test.ts src/main.ts src/main.test.ts package.json eslint.config.js
git commit -m "feat: the service entry: migrate, listen, and stop cleanly"
```

---

### Task 9: Run it: an image, Compose, and a sample webhook

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `env.example`, `src/forge/github/send-sample.ts`
- Modify: `package.json` (script `dev:send-webhook`: `node src/forge/github/send-sample.ts`), `README.md`
- Test: `src/forge/github/send-sample.test.ts`

**Interfaces:**
- Consumes: `main` (Task 8), the webhook route (Task 7), `createGithubWebhookReader` (Task 5).
- Produces:

```ts
// src/forge/github/send-sample.ts
export type SampleKind = 'pull_request' | 'review' | 'comment';
/** An invented, signed webhook: the headers to send and the body. */
export function sampleWebhook(kind: SampleKind, secret: string, delivery: string): { headers: Record<string, string>; body: string };
/** true for http URLs with no user or password whose host is localhost, 127.0.0.1 or [::1]. */
export function isLocalUrl(url: string): boolean;
```

Run as a command: `npm run dev:send-webhook -- --url http://localhost:8080/webhooks/github --secret-env WEBHOOK_SECRET [--kind review] [--delivery <id>]`. It reads the secret from the named environment variable, posts the sample without following a redirect, and prints the status and the body. It refuses any URL that `isLocalUrl` rejects, and never prints the secret.

- `Dockerfile`: from `node:26-bookworm-slim`; installs with `npm ci --omit=dev`; copies `src` and `contract`; runs as the `node` user; exposes 8080; its `CMD` is the exec form `["node", "src/main.ts", "--config", "/config/config.yml"]`, so the process receives the stop signal itself.
- `compose.yaml`: two services (section 17), both with `restart: unless-stopped`.
  - `db` is `postgres:17` with one named volume, a database named `visto`, its password from the environment and a health check with `pg_isready`. It publishes no port.
  - `app` is built from the `Dockerfile`, starts after `db` is healthy, reads its variables from a local `.env`, mounts `./config.local.yml` read-only at `/config/config.yml`, publishes port 8080, has `stop_grace_period: 20s` (longer than `STOP_WAIT_MS`), and has a health check that requests `http://127.0.0.1:8080/healthz` with `node -e` (the image has no curl).
- `env.example` names every variable the Compose file and the example config read, with placeholder values and no real secret. (`.gitignore` ignores `.env*`, so the example cannot be named `.env.example`. `config.local.yml` is ignored already.)
- `.dockerignore`: `node_modules`, `.git`, `.superpowers`, `docs`, `runs`, `*.jsonl`, `.env*`, `config.local.yml`.
- `README.md`: a short section "Run the service" with the commands; the status table row for the service split in two, receiving and capture as built, queue and publishing as planned; and the two sentences that say there is no service and no Docker setup (in the status note at the top and under the status table) brought up to date: the service receives and records, and still reviews nothing. The "Run the service" section also says, in two or three sentences, that the service holds a request's body in memory before it can check the signature, at most 25 MB for each of at most 20 requests at once, so a caller with no secret can make it hold about 500 MB; and that TLS, and any limit on connections or body size per caller, belong to the proxy placed in front of it.

- [ ] **Step 1: Write the failing tests**

`src/forge/github/send-sample.test.ts`:
- For each `SampleKind`, `createGithubWebhookReader(secret).read(headers, Buffer.from(body))` is ok, with the delivery passed in, and its event has the expected `kind` (`pull_request`, `review`, `general_comment`).
- The same sample read with another secret is `bad_signature`.
- `isLocalUrl` is true for `http://localhost:8080/x`, `http://127.0.0.1:8080/x` and `http://[::1]:8080/x`, and false for `https://example.com/x`, `http://localhost.example.com/x`, `http://localhost@example.com/x`, `http://user:pw@localhost/x`, `ftp://localhost/x` and `not a url`.
- The sample payloads hold only invented names: assert the repository is `acme/shop`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --import ./test/setup.ts --test src/forge/github/send-sample.test.ts`
Expected: FAIL: the module does not exist.

- [ ] **Step 3: Implement the tool, then write the four files and the README changes**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass, and the ASCII check prints nothing.

- [ ] **Step 5: Try it for real, on this machine only**

This is the first run against a real Postgres (section 20, item 5). It pulls two public images and uses its own Compose project name, so it touches no other container or volume.

Before anything: if the Docker daemon is not running, do not start it; report this step as not run. If `.env` or `config.local.yml` already exists in the project folder, stop and report it: this step must not overwrite or delete a file it did not create.

```bash
cp env.example .env && cp config.example.yml config.local.yml   # then switch the app, database and server blocks on in config.local.yml
docker compose -p visto-ai-try config -q
docker compose -p visto-ai-try up -d --build --wait
set -a && . ./.env && set +a
send() { npm run -s dev:send-webhook -- --url http://localhost:8080/webhooks/github --secret-env WEBHOOK_SECRET "$@"; }
send --kind pull_request --delivery try-1
send --kind review --delivery try-2
send --kind review --delivery try-2
send --kind comment --delivery try-3
send --kind comment --delivery try-4 & send --kind comment --delivery try-4 & wait
docker compose -p visto-ai-try exec db psql -U postgres -d visto -c "select kind, author, state from visto_ai.human_activity order by id" -c "select owner, repo, number, state, updated_at from visto_ai.pull_requests" -c "select id, outcome from visto_ai.deliveries order by id"
node -e "fetch('http://localhost:8080/webhooks/github',{method:'POST',body:Buffer.alloc(26*1024*1024)}).then(async r=>console.log('big body:',r.status,await r.text()),e=>console.log('big body: no answer,',e.cause?.code??e.message))"
node -e "const chunk=Buffer.alloc(1024*1024);let n=0;const body=new ReadableStream({pull(c){if(n++<26)c.enqueue(chunk);else c.close()}});fetch('http://localhost:8080/webhooks/github',{method:'POST',body,duplex:'half'}).then(async r=>console.log('big stream:',r.status,await r.text()),e=>console.log('big stream: no answer,',e.cause?.code??e.message))"
docker compose -p visto-ai-try restart db && sleep 10 && send --kind comment --delivery try-5
docker compose -p visto-ai-try stop app && docker compose -p visto-ai-try ps -a --format '{{.Service}} {{.ExitCode}}'
docker compose -p visto-ai-try logs app | tail -20
```

Whatever happened, finish with: `docker compose -p visto-ai-try down -v && rm .env config.local.yml`.

Expected:
- `try-1` answers `202 accepted`; the first `try-2` `202 accepted` and the second `202 duplicate`; `try-3` `202 accepted`; the two `try-4` sent together give one `accepted` and one `duplicate`.
- The first query shows one `review` row and the comments, the second the pull request of the sample, the third one row per delivery id.
- The 26 MB body prints `big body: 413 payload_too_large` (refused from its declared length), and the 26 MB stream, which declares no length, prints `big stream: 413 payload_too_large` (refused while it is read). Unit tests cannot show these two: they need a real connection. If either prints "no answer", report exactly what it printed: do not change the code to make it pass.
- After the database restarts, the app is still running and `try-5` is accepted (possibly after one 503).
- `app` stops with exit code 0.
- The log has one JSON line per delivery and no payload text.

Put in the task report what was seen for each of these, and any difference between how the two Postgres clients behaved. Do not claim a line of the expected list that was not observed.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml env.example src/forge/github/send-sample.ts src/forge/github/send-sample.test.ts package.json README.md
git commit -m "feat: an image, a Compose file and a sample webhook to run the service"
```

---

## After the last task

Not a task to dispatch: whoever runs the plan writes `docs/superpowers/plans/2026-11-18-receiving-and-capture-notes.md` from the build's own record, in the form of the two earlier notes files. It holds the decisions taken while building, each with what it costs if wrong; where the plan and what was built differ; what the final review left open, split into "before plan 4" and "small, can wait"; and what Task 9's real run showed. No internal name, no path of the predecessor, no number from a private run.
