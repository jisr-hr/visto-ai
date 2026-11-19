# Publishing the First Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment that is not in dry run posts one review on each pull request, pinned to the commit it read, and reviews on request when a person with access comments `/review`.

**Architecture:** The review job now records a finished review before it publishes it, so the paid work is never lost and never done twice. A publish step reads the head again, looks for a review of its own that an earlier attempt may already have posted, posts with one fallback, and marks the run as published in the same transaction that finishes the job. A new write side of the GitHub adapter does the posting; the shell sees it as an interface. A `/review` comment stores a manual job in the delivery's transaction, and everything it needs to look up or answer happens inside that job.

**Tech Stack:** Unchanged. No new library.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it. Earlier plans and their notes are beside this file; the notes of plan 4 (`2026-11-19-review-jobs-in-dry-run-notes.md`) list what was put off "before publishing".

**Notes:** `docs/superpowers/plans/2026-11-19-publishing-the-first-review-notes.md` is written when the build ends.

## Scope

Plan 3 cut stage 4 in three and said its third plan "may be cut again when it is written". It is cut here. What plan 3 called plan 5 becomes two:

| Plan | Covers | Ends with |
|---|---|---|
| **5. Publishing the first review** (this plan) | Publishing pinned to a commit (8.3, D20), with its fallback and the read-back of the posted comments; recording a publication (8.5); the `/review` command (8.1, D15) with its reaction and its reply; the start-up check of the app's permissions and events (8.4, D16); mentions and raw HTML made inert in model-written text | A deployment out of dry run posts the first review of a pull request |
| 6. Later heads and threads | Reading the app's threads (8.4), their verdicts and the duplicate rule (5.6 steps 5 to 7), the `incremental` and `recheck` modes with a pull request's earlier state (5.2), scores across reviews (6.2, D17), the score tables, replies and resolving, inline notes (D22), the app manifest | A reviewer that follows a pull request through its pushes |

**Why the cut is here.** A second review of a pull request cannot be published responsibly without knowing the threads of the first: the engine would raise the same findings again on every push. Reading threads, judging them and reviewing only what changed are one piece of work, and it rests on reviews that were published. So this plan publishes the first review only, and says so plainly when it declines a later one.

| In this plan | Left to plan 6 or later, and why |
|---|---|
| 8.3: one review per run, pinned; the head read again before publishing; a rejection of the inline comments retried as body only; a rejected commit fails; the comments read back and stored | **"Retried first without the human-review notes":** there are no notes yet (plan 6). **A server error retried at once:** see call 5 |
| 5.2: the first review of a pull request, `full` mode, automatic or on request | **Any review of a pull request that already has a published one** (a later head, a re-check): plan 6. Such a job is dropped as `later_head` or `already_reviewed`, and a `/review` is answered with a refusal |
| 8.1: `/review` from the first line of a comment, by a person who is an owner, member or collaborator (D15); an eyes reaction when accepted; a confused reaction and a reply with a short code on refusal or failure | **`/done`, the skip command, a re-run of the check:** stage 5 |
| 8.4: the app identified by its own account; the start-up check of permissions and events, logged and alerted | **Threads, replies, resolving:** plan 6 |
| 8.5 and 13: a run's publication (review id, when); `review_comments` | **`file_scores`, `block_scores`, `thread_verdicts`:** plan 6, which first reads them |
| 11.1: `dryRun: false` is accepted | **The app manifest and the setup guide built on it:** plan 6, with the permission list threads need |
| 6.4: nothing. Every review is posted as a comment | **Approval and its withdrawal:** stage 9 |
| 14: the alert for what the app lacks (`feature_off`) | **The alert when the publish rate falls:** plan 6, when later reviews make a rate worth watching. A publication that fails is in the log with its code |

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **Mentions in model-written text are made inert; links are left as written.** A finding, a summary or a score's reason that holds `@name` would notify that person from the app's account, and text inside a pull request can steer what the model writes. The design leaves this open (plan 1's notes say the choice belongs to publishing). A zero-width space is put after the `@`, outside code. The service's own "requested by @name" line is not touched. Cost if wrong: a mention the model meant is not delivered.
2. **Only the first review of a pull request is published** (the cut above). In dry run nothing changes: every head is still reviewed and recorded.
3. **A review that failed is not posted.** It is recorded as before. Only a `/review` that fails gets an answer on the pull request.
4. **A finished review is recorded before it is published,** and marked as published afterwards. The row's `published`, review id, publication time and posted text are filled in once; nothing else of a row is ever changed. Design 8.5 says a run row is append-only, to keep a failed re-run from hiding a published review; filling in a run's own publication does not do that. Cost if wrong: a second table for publications.
5. **Nothing is posted twice, at the cost of a slower retry.** A publish request that fails is never repeated blindly, not even after a server error, because the review may have been created. The job is put back, and its next start first lists the app's own reviews of the pull request: one on that commit is adopted, and one on another commit means the pull request has its first review already. No clock is compared. 8.3 says a server error is retried once.
6. **A stored review is published later without being computed again.** A job that finds a finished, unpublished review of the same head and base, less than a day old, publishes that one. The model is not called again.
7. **The head is read again just before publishing.** If it moved, an automatic job publishes nothing and makes sure the new head has a job; a `/review` job starts over once (8.3). 8.3 reads the head around the file list; here it is read after the review, which is later and covers it.
8. **A pull request closed while its review ran gets no review.**
9. **`/review` is checked and answered inside its job** (8.1, D14). The webhook stores a manual job whoever wrote the comment; the job refuses a commenter without access. A stranger's command costs one reaction and one reply.
10. **A manual job outranks an automatic one.** From a commenter with access (call 18 for the others), it replaces the pull request's pending job and is due at once; a later push does not replace it. It reviews the live head, and the filters for automatic reviews (draft, ignored author, base branch) do not apply to it.
11. **The commenter's access is the association the event carries** (design 20, item 7 doubts it for private members; a lookup can replace it later).
12. **In dry run a `/review` is reviewed and recorded and nothing is written:** no reaction, no reply.
13. **The start-up check never stops the start.** What is missing is logged and alerted, once for each thing that is missing. A check that could not be made is not made again until the next start.
14. **When the inline comments are refused, the whole text of each is put in the body,** under the finding it belongs to, so nothing the review found is lost.
15. **The comments are read back after the publication is recorded.** A read-back that fails is logged and not tried again; those comments' ids are then unknown to plan 6.
16. **A command from any bot is ignored,** not only from the app itself (PM-command). 8.1 excludes only comments the app wrote. A bot that may command a review can make two bots answer each other.
17. **Raw HTML the model wrote is shown as text.** Outside code every `<` is written as `&lt;`, so nothing of the model's is rendered as HTML: no comment that hides text, no block that folds what follows. Cost if wrong: a table or a details block the model wrote on purpose is shown as its source.
18. **A command from someone without access never pushes a job out.** It is stored only when the pull request has no pending job; and when it is refused, an automatic job for the stored head is stored in its place, in case a push's job was kept out meanwhile.

## Global Constraints

Every constraint of plans 1 to 4 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only: no `enum`, no `namespace`, no parameter properties. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape (the zero-width space is `\u200b`). After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network or a real database.** Every outbound call goes through a `fetch` passed in as a dependency. Database tests use `testDb()`, one fresh database per test.
- **Writes to the git service happen only through `ForgeWriter`** (Task 4), only from `src/shell/review-job.ts` and `src/shell/publish.ts`, and **never in dry run**: in dry run the service gives the job a writer that refuses every call (Task 7), and the job does not call it. The read-only `createGithubHttp` keeps refusing anything but `GET`.
- **Nothing unpinned is ever posted (D20).** Every review carries the commit it was computed for.
- **Boundaries, enforced by lint:** only `src/db/**` imports a Postgres client. Only `src/forge/github/**`, `src/eval/cli.ts` and `src/main.ts` import from `src/forge/github/**`; the shell sees `ForgeAccess`, `ForgeWriter`, `AppInfo` and `HookDeliveries` from `src/forge/types.ts`. `src/engine/**` imports nothing from `db`, `shell`, `eval` or `forge/github`. `src/db/**` imports nothing from `src/engine/**`.
- **SQL:** every value is a numbered parameter. Every table is written with its schema, `visto_ai.<table>`. Column types as in plan 4. Times come from the caller as ISO 8601 strings; no function in `src/db` calls `now()`.
- **Nothing inside a transaction catches a statement's error and goes on.** `requeueJob` is never called inside a transaction.
- **Logs** carry ids, names, codes and counts. They never carry a payload, a title, a comment's or a finding's text, a token, a key, or an error's message. **A token never appears in a thrown error.** Errors that cross a boundary carry a short code as their message (`/^[a-z][a-z0-9_]*$/`, at most 40 characters); "the error's code" is its message when that is a short code, else `internal_error`.
- **What the service writes on a pull request** is the rendered review, an eyes or a confused reaction, and one fixed sentence with a short code. Never a stack trace, a path of the host or an error's message.
- **Fixtures are synthetic and invented:** `acme/shop`, pull request 7, logins such as `octo-dev`, installation `99`, app id `12345`, the app's slug `visto-test`.
- **Ported behaviour is named by a `PM-` key.** The key resolves to the predecessor's file privately, never in this repository. Every literal is invented here.
- **Nothing internal in this repository,** including commit messages and the notes file.
- **Git:** work on a branch named `stage-4c`. Commit locally after each task. A commit made by an agent ends with that agent's own co-author line. Push nothing without the owner's go-ahead.

## Review Focus

Inputs and failures the design implies, that a person running this would meet, each pinned by a test in the task that owns the code:

1. **The process dies between posting a review and recording it.** At the next start the same review is not posted again and the model is not called again (Tasks 6 and 7).
2. **GitHub is unreachable when the review is ready.** The review stays stored, is published by a later start of the job, and is paid for once (Tasks 6 and 7).
3. **A push lands while the review runs.** Nothing is posted for the old head, and the new head gets a job (Task 7).
4. **GitHub refuses the inline comments.** The review is still posted, with every comment's text in its body (Tasks 1 and 6).
5. **Someone without access comments `/review`,** or a bot does. No review runs; a person gets a refusal, a bot gets nothing (Tasks 5 and 8).
6. **The text of a finding names a person or holds an HTML comment.** Nobody is notified and nothing is hidden (Task 1).
7. **A second trigger on a pull request that already has its review.** Nothing is posted and no model call is made (Tasks 7 and 8).
8. **The service is in dry run.** No request that writes is ever sent, whatever the job (Tasks 7 and 8).

## File Structure

```
src/engine/render/body.ts          + mentions made inert; renderReview's inline switch
src/db/migrations/0003_publishing.sql
src/db/jobs.ts                     + trigger, requestedBy, commentId, association, installation; who may replace whom
src/db/review-runs.ts              + published, reviewId, publishedAt, inlineDropped; markPublished, unpublishedRun, lastPublishedRun
src/db/review-comments.ts          recordComments, listComments
src/forge/types.ts                 + AppInfo, FeatureOff, AppIdentity, ReviewDraft, PostedComment, ForgeWriter; installation on a general comment
src/forge/github/app-info.ts       the app's own account, permissions and events, and what it lacks for each feature
src/forge/github/writer.ts         createGithubWriter
src/forge/github/events.ts         + the installation of an issue_comment event
src/shell/commands.ts              commandOf, refusal texts
src/shell/receive.ts               + a manual job for /review
src/shell/publish.ts               publishRun
src/shell/review-job.ts            record, then publish; the first review only; the manual job
src/shell/dry-writer.ts            a writer that refuses every call
src/service.ts, src/main.ts        the writer and the app's info, wired
src/config/load.ts                 dryRun may be false
README.md, config.example.yml
```

## Shared Types

Added to `src/forge/types.ts` in Task 3 (`AppInfo`, `FeatureOff`, `AppIdentity`) and Task 4 (the rest). Later tasks use them exactly as written.

```ts
export interface AppInfo {
  botLogin: string;                          // the app's own account: "<slug>[bot]"
  permissions: Record<string, string>;       // as the git service names them: { pull_requests: 'write', contents: 'read', ... }
  events: string[];                          // the events the app is subscribed to
}
export interface FeatureOff { feature: 'reviews' | 'publishing' | 'commands' | 'capture'; missing: string }
export interface AppIdentity {
  read(): Promise<AppInfo>;
  /** What the app lacks: one entry for each permission or event a feature needs and the app has not got. */
  lacks(dryRun: boolean): Promise<FeatureOff[]>;
}
export interface ReviewDraft {
  commit: string;                            // the commit the review was computed for
  body: string;
  comments: Array<{ path: string; side: Side; line: number; body: string }>;
}
export interface PostedComment { id: string; path: string; side: Side; line: number | null; body: string }
export interface ForgeWriter {
  /** Posts one review as a comment, pinned to `draft.commit`. Rejects `review_rejected` when the git service refuses what it holds; any other failure rejects with a short code and says nothing about whether the review was created. */
  publishReview(ref: PullRequestRef, installation: string, draft: ReviewDraft): Promise<{ id: string }>;
  /** The app's own reviews of the pull request that have a body, newest first, each with the commit it is pinned to. */
  listOwnReviews(ref: PullRequestRef, installation: string): Promise<Array<{ id: string; commit: string }>>;
  /** The inline comments of one review, read from the pull request's own comment list. null when that list was cut short. */
  listReviewComments(ref: PullRequestRef, installation: string, reviewId: string): Promise<PostedComment[] | null>;
  /** Puts a reaction on a general comment of a pull request. */
  react(ref: PullRequestRef, installation: string, commentId: string, reaction: 'eyes' | 'confused'): Promise<void>;
  /** Writes a general comment on the pull request. */
  comment(ref: PullRequestRef, installation: string, body: string): Promise<void>;
}
```

`Job` (in `src/db/jobs.ts`) gains five fields in Task 2:

```ts
export interface Job {
  id: number; ref: PullRequestRef;
  reason: string;                       // opened, reopened, ready_for_review, synchronize, retargeted, command or command_retry
  headSha: string;                      // the head the event named; '' for a manual job, which reviews the live head
  trigger: 'automatic' | 'manual';
  requestedBy: string | null;           // who commented /review
  commentId: string | null;             // that comment
  association: string | null;           // the commenter's association with the repository, as the event gave it
  installation: string | null;          // the installation the command came through
  status: JobStatus; outcome: string | null;
  runAt: string; starts: number; createdAt: string;
}
```

`StoredRun` (in `src/db/review-runs.ts`) gains four fields in Task 2: `published: boolean`, `reviewId: string | null`, `publishedAt: string | null`, `inlineDropped: boolean`. `RunRecord`, what a caller hands to `recordRun`, is unchanged: a run is always recorded unpublished.

Each file declares `type Log = (entry: Record<string, unknown>) => void` locally, as the existing files do.

---

### Task 1: Text the model wrote is made inert, and a review can be rendered without inline comments

**Files:**
- Modify: `src/engine/render/body.ts`
- Modify: `src/shell/review-job.ts` (its one call of `renderReview` passes `inline: true`)
- Test: the existing test file of `src/engine/render/body.ts` (its helpers that build a `Meta` gain `inline: true`)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
// src/engine/render/body.ts
/** Text the model wrote, made safe to post. Outside code: a mention gets a zero-width space after its `@`, and every `<` is written as `&lt;`. A fence left open is closed. */
export function inert(text: string): string;
// renderReview's second argument gains one required field:
type Meta = { trigger: 'automatic' | 'manual'; requestedBy: string | null; lineUrl: ...; inline: boolean };
```

**What counts as code.** Only what is certainly code is left as it is; everything else is prose (calls 1 and 17). A rule that is generous here leaves a live mention, so when in doubt it is prose.

- **An inline span:** a run of backticks that is not preceded by a backslash, up to the next run of exactly the same length **on the same line**. A run with no such closing run on its line is prose, backticks included.
- **A fence:** a line indented by at most three spaces that opens with three or more backticks, or three or more tildes. For a backtick fence the rest of that line holds no backtick. It ends at a line indented by at most three spaces that holds only the same character, at the same or a greater length, and spaces; or at the end of the text.

**What is done to prose.**

- **Mentions.** An `@` starts a mention when the character after it is a letter or a digit and the character before it, if any, is not a letter, a digit or an underscore. It gets a zero-width space after it. So `@octo-dev` and `(@acme/reviewers)` are changed, and `dev@example.test` is not.
- **Raw HTML.** Every `<` is written as `&lt;`. It is shown as it was typed and nothing of it is rendered: no comment that hides text, no block that folds the sections after it. This replaces the present `noComment`.
- **An open fence** is closed with the file's `closeOpenFence`, so one piece cannot swallow the next.

**Where.** `inert` is applied to each piece of model-written text **as it is finally written**: the summary; a finding's whole text in an inline comment; a finding's first line in a bullet, after `firstLine` has cut it (a span the cut left open is then prose); an unplaced or beyond-the-diff finding; a score's category and reason. It is not applied to what the service writes itself: its headings, its paths in code spans, and the line "requested by @name".

**The inline switch.** With `inline: true` nothing else changes. With `inline: false`: the result's `comments` is empty; the `## Findings` section lists every finding, not the first 25; and each bullet is followed by the whole inert text its inline comment would have carried, indented by two spaces as a continuation of the bullet, with any line that would be a heading escaped as `noHeading` does. The other sections are as they are.

- [ ] **Step 1: Write the failing tests**

With `const ZW = '\u200b'` and the file's own helpers for a result with findings (written here as `resultWith` and `findingAt`; use what the file has):

```ts
test('a mention in prose is made inert, and one in code is left as it is', () => {
  assert.equal(inert('ask @octo-dev or (@acme/reviewers)'), `ask @${ZW}octo-dev or (@${ZW}acme/reviewers)`);
  assert.equal(inert('use `@Injectable()` here'), 'use `@Injectable()` here');
  assert.equal(inert('```ts\n@Component({})\n```\nthanks @octo-dev'), `\`\`\`ts\n@Component({})\n\`\`\`\nthanks @${ZW}octo-dev`);
});
test('an address, a lone @ and an @ before a symbol are not mentions', () => {
  for (const text of ['dev@example.test', 'a @ b', 'x_@y', '@-x', '@']) assert.equal(inert(text), text);
});
test('what only looks like code is prose', () => {
  const cases = [
    '\\`@victim\\`',                          // escaped backticks
    '`a\n\n@victim b`',                       // a "span" across lines
    'see `@victim',                           // a run that is never closed
    '    ```\n    @victim\n    ```',          // a "fence" indented four spaces
    '``` a`b\n@victim\n```',                  // a backtick fence with a backtick in its first line
  ];
  for (const text of cases) assert.equal(inert(text).includes(`@${ZW}victim`), true, text);
});
test('raw HTML in prose is shown and not rendered, and a fence left open is closed', () => {
  assert.equal(inert('<details><summary>x</summary>'), '&lt;details>&lt;summary>x&lt;/summary>');
  assert.equal(inert('a <!-- b'), 'a &lt;!-- b');
  assert.equal(inert('use `Array<string>` here'), 'use `Array<string>` here');
  assert.equal(inert('```ts\nconst a: Array<string> = [];'), '```ts\nconst a: Array<string> = [];\n```');
});
test('a review writes no live mention from the model, and keeps the one the service writes', () => {
  const r = resultWith({ overview: 'a.ts: see @octo-dev', findings: [findingAt('a.ts', 3, 'ping @octo-dev')] });
  const out = renderReview(r, { trigger: 'manual', requestedBy: 'octo-lead', lineUrl: null, inline: true });
  assert.equal(out.body.includes('@octo-dev'), false);
  assert.equal(out.comments[0]!.body.includes('@octo-dev'), false);
  assert.equal(out.body.includes('requested by @octo-lead'), true);
});
test('a first line cut out of a span is prose', () => {
  const r = resultWith({ findings: [findingAt('a.ts', 3, '`@victim\nrest`')] });
  const out = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  assert.equal(out.body.includes('@victim'), false);
  assert.equal(out.body.includes(`@${ZW}victim`), true);
});
test('without inline comments, every finding carries its whole text in the body and cannot forge a heading', () => {
  const many = Array.from({ length: 30 }, (_, i) => findingAt('a.ts', i + 1, `Finding ${i + 1}.\n\n## Overall\n\nDetail ${i + 1}.`));
  const r = resultWith({ findings: many });
  const inline = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  const bodyOnly = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: false });
  assert.deepEqual([inline.comments.length, bodyOnly.comments.length], [30, 0]);
  assert.equal(inline.body.includes('Detail 1.'), false);
  assert.equal(bodyOnly.body.includes('Detail 1.') && bodyOnly.body.includes('Detail 30.'), true);
  assert.equal(bodyOnly.body.match(/^## Overall$/gm)?.length, 1);
});
```

Existing tests whose expected text holds a `<` the model wrote outside code change to `&lt;`; list them in the report.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | tail -n 12`
Expected: the new tests fail.

- [ ] **Step 3: Implement `inert` and the switch; pass `inline: true` in `src/shell/review-job.ts`**

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/engine/render src/shell/review-job.ts
git commit -m "feat: text the model wrote is made inert; a review can be rendered without inline comments"
```

---

### Task 2: Storage for publishing and for manual jobs

**Files:**
- Create: `src/db/migrations/0003_publishing.sql`, `src/db/review-comments.ts`
- Modify: `src/db/jobs.ts`, `src/db/review-runs.ts`
- Modify (they call `enqueueJob`): `src/shell/receive.ts`, `src/shell/review-job.ts`, and every test file `npm run typecheck` names, `src/service.test.ts` among them
- Test: `src/db/jobs.test.ts`, `src/db/review-runs.test.ts`, `src/db/review-comments.test.ts`, and the migration ledger's test

**Interfaces:**
- Consumes: plan 4's `src/db`.
- Produces (`Job` and the four new fields of `StoredRun` are under Shared Types):

```ts
// src/db/jobs.ts: enqueueJob's argument gains five fields
export function enqueueJob(db: Db, j: {
  ref: PullRequestRef; reason: string; headSha: string; runAt: string; now: string; delivery: string | null; replace: boolean;
  trigger: 'automatic' | 'manual'; requestedBy: string | null; commentId: string | null; association: string | null; installation: string | null;
}): Promise<number | null>;

// src/db/review-runs.ts
/** Fills in a run's publication, once. false when the run was already marked. */
export function markPublished(db: Db, runId: number, p: { reviewId: string; publishedAt: string; body: string; inlineDropped: boolean }): Promise<boolean>;
/** The newest run of the pull request that is not a dry run, ended ok, has a body that is not empty, is not published, has this head and base, and started at or after `since`. */
export function unpublishedRun(db: Db, ref: PullRequestRef, headSha: string, baseSha: string, since: string): Promise<StoredRun | null>;
/** The newest published run of the pull request. */
export function lastPublishedRun(db: Db, ref: PullRequestRef): Promise<StoredRun | null>;

// src/db/review-comments.ts
export interface StoredComment { commentId: string; path: string; side: 'LEFT' | 'RIGHT'; line: number | null; severity: string; quote: string }
/** Stores a run's posted comments. One already stored (same comment id) is left as it is. */
export function recordComments(db: Db, runId: number, ref: PullRequestRef, comments: StoredComment[]): Promise<void>;
/** A pull request's stored comments, lowest id first, each with the run it belongs to. */
export function listComments(db: Db, ref: PullRequestRef): Promise<Array<StoredComment & { run: number }>>;
```

The migration:

```sql
alter table visto_ai.jobs add column trigger text not null default 'automatic';
alter table visto_ai.jobs add column requested_by text;
alter table visto_ai.jobs add column comment_id text;
alter table visto_ai.jobs add column association text;
alter table visto_ai.jobs add column installation text;

alter table visto_ai.review_runs add column published boolean not null default false;
alter table visto_ai.review_runs add column review_id text;
alter table visto_ai.review_runs add column published_at timestamptz;
alter table visto_ai.review_runs add column inline_dropped boolean not null default false;
create index review_runs_published on visto_ai.review_runs (service, owner, repo, number) where published;

create table visto_ai.review_comments (
  id integer generated always as identity primary key,
  run integer not null,
  service text not null, owner text not null, repo text not null, number integer not null,
  comment_id text not null,
  path text not null, side text not null, line integer,
  severity text not null,
  quote text not null,
  unique (service, comment_id)
);
create index review_comments_pull_request on visto_ai.review_comments (service, owner, repo, number);
```

**Who may replace a pending job (call 10).** One pending job per pull request, as before:

- A **manual** job with `replace: true` always replaces the pending one: every field becomes its own, `starts` goes back to 0, and its id is returned. With `replace: false` it is stored only when the pull request has no pending job; otherwise nothing changes and null is returned (call 18).
- An **automatic** job with `replace: true` replaces a pending automatic job as before. A pending **manual** job is left as it is and null is returned. The statement is the upsert of plan 4 with one more condition: `do update set ... where visto_ai.jobs.trigger = 'automatic' returning id`, which returns no row when the pending job is manual.
- An automatic job with `replace: false` is as before.

`markPublished` is one statement: `update visto_ai.review_runs set published = true, review_id = $2, published_at = $3::timestamptz, body = $4, inline_dropped = $5 where id = $1 and published = false returning id`. `listRuns` returns the four new fields. `hasOkRun` and `spentSince` are unchanged.

- [ ] **Step 1: Write the failing tests**

`src/db/jobs.test.ts`. The file's `job()` helper gains the defaults `trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null`, and `const manual = (over = {}) => job({ reason: 'command', headSha: '', trigger: 'manual', requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: '99', ...over })`:

```ts
test('a manual job replaces the pending automatic one and carries who asked', async () => {
  const first = (await enqueueJob(db, job({ runAt: at(180) })))!;
  assert.equal(await enqueueJob(db, manual({ runAt: at(5), now: at(5) })), first);
  const j = await getJob(db, first);
  assert.deepEqual(
    [j?.trigger, j?.reason, j?.headSha, j?.runAt, j?.requestedBy, j?.commentId, j?.association, j?.installation, j?.starts],
    ['manual', 'command', '', at(5), 'octo-lead', '31', 'member', '99', 0]);
});
test('a push does not replace a pending manual job', async () => {
  const first = (await enqueueJob(db, manual()))!;
  assert.equal(await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60) })), null);
  const j = await getJob(db, first);
  assert.deepEqual([j?.trigger, j?.reason, j?.runAt], ['manual', 'command', at(0)]);
});
test('a manual job that may not replace is stored only when nothing is pending', async () => {
  const first = (await enqueueJob(db, job({ runAt: at(180) })))!;
  assert.equal(await enqueueJob(db, manual({ replace: false })), null);
  assert.deepEqual([(await getJob(db, first))?.trigger, (await unfinishedJobs(db)).length], ['automatic', 1]);
  const alone = await enqueueJob(db, manual({ ref: { ...REF, number: 8 }, replace: false }));
  assert.equal((await getJob(db, alone!))?.trigger, 'manual');
});
test('a second manual job replaces the first', async () => {
  const first = (await enqueueJob(db, manual()))!;
  assert.equal(await enqueueJob(db, manual({ requestedBy: 'octo-dev', commentId: '32', now: at(9), runAt: at(9) })), first);
  assert.deepEqual([(await getJob(db, first))?.requestedBy, (await unfinishedJobs(db)).length], ['octo-dev', 1]);
});
test('an automatic job is read back with no requester', async () => {
  const id = (await enqueueJob(db, job()))!;
  const j = await getJob(db, id);
  assert.deepEqual([j?.trigger, j?.requestedBy, j?.commentId, j?.association, j?.installation], ['automatic', null, null, null, null]);
});
```

`src/db/review-runs.test.ts`. The file's `run()` helper is unchanged. A stored run reads back with `published: false, reviewId: null, publishedAt: null, inlineDropped: false`, so the existing tests that compare a stored run with what was recorded add those four fields to what they expect:

```ts
test('a run is recorded unpublished and marked published once', async () => {
  const id = await recordRun(db, run({ dryRun: false }));
  assert.equal(await markPublished(db, id, { reviewId: '501', publishedAt: at(95), body: 'posted text', inlineDropped: true }), true);
  assert.equal(await markPublished(db, id, { reviewId: '502', publishedAt: at(99), body: 'other', inlineDropped: false }), false);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.publishedAt, stored!.body, stored!.inlineDropped], [true, '501', at(95), 'posted text', true]);
});
test('unpublishedRun finds the newest finished live review of that head and base that is not published yet', async () => {
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  await recordRun(db, run({ dryRun: true }));
  await recordRun(db, run({ dryRun: false, outcome: 'failed', failureStage: 'model', failureCode: 'timeout' }));
  await recordRun(db, run({ dryRun: false, headSha: 'h2' }));
  await recordRun(db, run({ dryRun: false, body: '' }));
  await recordRun(db, run({ dryRun: false, startedAt: at(-200) }));
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  const wanted = await recordRun(db, run({ dryRun: false }));
  assert.equal((await unpublishedRun(db, REF, 'h1', 'b1', at(-100)))?.id, wanted);
  await markPublished(db, wanted, { reviewId: '501', publishedAt: at(95), body: 'x', inlineDropped: false });
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
});
test('lastPublishedRun is the newest published run of the pull request', async () => {
  assert.equal(await lastPublishedRun(db, REF), null);
  const a = await recordRun(db, run({ dryRun: false }));
  await recordRun(db, run({ dryRun: false, headSha: 'h2' }));
  await markPublished(db, a, { reviewId: '501', publishedAt: at(95), body: 'x', inlineDropped: false });
  assert.deepEqual([(await lastPublishedRun(db, REF))?.id, (await lastPublishedRun(db, { ...REF, number: 8 }))], [a, null]);
});
```

`src/db/review-comments.test.ts`:

```ts
test('posted comments are stored once, with the finding they came from', async () => {
  const c = { commentId: '9001', path: 'a.ts', side: 'RIGHT' as const, line: 3, severity: 'major', quote: 'x = 1' };
  await recordComments(db, 4, REF, [c, { ...c, commentId: '9002', line: null }]);
  await recordComments(db, 5, REF, [{ ...c, severity: 'minor' }]);
  assert.deepEqual(await listComments(db, REF), [{ ...c, run: 4 }, { ...c, commentId: '9002', line: null, run: 4 }]);
  assert.deepEqual(await listComments(db, { ...REF, number: 8 }), []);
});
```

The migration ledger's test gains `0003_publishing` among the applied names.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test 2>&1 | tail -n 12`
Expected: the new tests fail; files that build a job or a run by hand stop compiling.

- [ ] **Step 3: Write the migration and the queries; give every caller the new fields**

`src/shell/receive.ts` and `src/shell/review-job.ts` pass `trigger: 'automatic'` and nulls to `enqueueJob`. Nothing else in them changes in this task. The database tests of this plan make their database the way each file already does (inside each test, or in a `beforeEach`); `db` in the code below stands for that database.

- [ ] **Step 4: Run everything, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

```bash
git add src/db src/shell src/service.test.ts
git commit -m "feat: storage for a run's publication, its posted comments and manual jobs"
```

---

### Task 3: The app's own account, and what it lacks

**Files:**
- Create: `src/forge/github/app-info.ts`
- Modify: `src/forge/types.ts` (`AppInfo`, `FeatureOff`, `AppIdentity`)
- Test: `src/forge/github/app-info.test.ts`

**Interfaces:**
- Consumes: `AppAuth` (plan 4).
- Produces:

```ts
// src/forge/github/app-info.ts
/** What the app lacks, one entry for each permission or event a feature needs and the app has not got. */
export function missingFor(info: AppInfo, dryRun: boolean): FeatureOff[];
export function createAppInfo(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): AppIdentity;
```

`read` asks `GET <apiBase>/app` with the app token and the headers the project's requests carry. From the answer: `slug` (text, not empty), `permissions` (an object whose values are text) and `events` (a list of text). `botLogin` is `<slug>[bot]`. An answer of another shape rejects `github_bad_response`; a refusal rejects `github_<status>`; a failure to reach it rejects `github_network`. A good answer is kept: later calls make no request. A failure is not kept. Callers that ask together share one request. `lacks(dryRun)` is `missingFor(await read(), dryRun)`.

**What each feature needs (8.4, D16, section 10).** GitHub's names for permissions and events stay inside this file; the shell sees only `FeatureOff`. A permission is at least `read` when its value is `read`, `write` or `admin`, and at least `write` when it is `write` or `admin`.

| Feature | Permissions | Events |
|---|---|---|
| `reviews` | `pull_requests` read, `contents` read | `pull_request` |
| `publishing`, only when not in dry run | `pull_requests` write | |
| `commands` | `issues` write, only when not in dry run | `issue_comment` |
| `capture` | | `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment` |

`missing` is `pull_requests:write` for a permission and `event:issue_comment` for an event. The entries come in the table's order.

- [ ] **Step 1: Write the failing tests**

With `const auth: AppAuth = { appToken: () => 'jwt', installationToken: async () => 'unused' }` and `setup(answers)`: an identity over a stub `fetch` that answers from a queue (an `Error` rejects) and records each request's URL and `authorization` header in `calls`:

```ts
const APP = { slug: 'visto-test', permissions: { pull_requests: 'write', contents: 'read' }, events: ['pull_request', 'issue_comment'] };
const FULL: AppInfo = { botLogin: 'visto-test[bot]', permissions: { pull_requests: 'write', contents: 'read', issues: 'write' },
  events: ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'] };

test('the app is read with its own token and remembered', async () => {
  const { info, calls } = setup([new Response(JSON.stringify(APP))]);
  const expected = { botLogin: 'visto-test[bot]', permissions: { pull_requests: 'write', contents: 'read' }, events: ['pull_request', 'issue_comment'] };
  assert.deepEqual(await info.read(), expected);
  assert.deepEqual(await info.read(), expected);
  assert.deepEqual(calls, [{ url: 'https://api.github.com/app', authorization: 'Bearer jwt' }]);
});
test('a failure is not remembered, and callers that ask together share one request', async () => {
  const { info, calls } = setup([new Response('', { status: 401 }), new Response(JSON.stringify(APP))]);
  await assert.rejects(info.read(), /^Error: github_401$/);
  const [a, b] = await Promise.all([info.read(), info.read()]);
  assert.deepEqual([a.botLogin, b.botLogin, calls.length], ['visto-test[bot]', 'visto-test[bot]', 2]);
});
test('an answer of another shape is refused', async () => {
  for (const broken of [{ ...APP, slug: '' }, { ...APP, permissions: [] }, { ...APP, events: 'all' }, { ...APP, permissions: { contents: 1 } }]) {
    await assert.rejects(setup([new Response(JSON.stringify(broken))]).info.read(), /^Error: github_bad_response$/);
  }
});
test('a failure to reach the git service has its own code', async () => {
  await assert.rejects(setup([new Error('down')]).info.read(), /^Error: github_network$/);
});
test('an app that has everything lacks nothing', () => {
  assert.deepEqual(missingFor(FULL, false), []);
  assert.deepEqual(missingFor({ ...FULL, permissions: { pull_requests: 'admin', contents: 'write', issues: 'admin' } }, false), []);
});
test('in dry run, read access is enough', () => {
  assert.deepEqual(missingFor({ ...FULL, permissions: { pull_requests: 'read', contents: 'read' } }, true), []);
});
test('each thing an app lacks is named with the feature it switches off', () => {
  assert.deepEqual(missingFor({ botLogin: 'visto-test[bot]', permissions: { pull_requests: 'read' }, events: ['pull_request'] }, false), [
    { feature: 'reviews', missing: 'contents:read' },
    { feature: 'publishing', missing: 'pull_requests:write' },
    { feature: 'commands', missing: 'issues:write' },
    { feature: 'commands', missing: 'event:issue_comment' },
    { feature: 'capture', missing: 'event:pull_request_review' },
    { feature: 'capture', missing: 'event:pull_request_review_comment' },
    { feature: 'capture', missing: 'event:pull_request_review_thread' },
    { feature: 'capture', missing: 'event:issue_comment' },
  ]);
});
test('lacks reads the app and says what is missing', async () => {
  const { info } = setup([new Response(JSON.stringify(APP))]);
  assert.deepEqual((await info.lacks(false)).map((m) => m.missing), ['issues:write', 'event:pull_request_review', 'event:pull_request_review_comment', 'event:pull_request_review_thread']);
});
```

- [ ] **Step 2: Run them to see them fail, then add the types and implement**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/forge
git commit -m "feat: read the app's own account and say what it lacks"
```

---

### Task 4: The write side of the GitHub adapter

**Files:**
- Create: `src/forge/github/writer.ts`
- Modify: `src/forge/types.ts` (`ReviewDraft`, `PostedComment`, `ForgeWriter`)
- Test: `src/forge/github/writer.test.ts`

**Interfaces:**
- Consumes: `AppAuth`, `createAppInfo` (Task 3), `createGithubHttp`, `jsonOf`, `isObject`, `authorOf`.
- Produces:

```ts
export const MAX_REVIEW_PAGES = 10;
export const MAX_COMMENT_PAGES = 20;
export function createGithubWriter(opts: { auth: AppAuth; info: { read(): Promise<AppInfo> }; fetch: typeof fetch; apiBase?: string }): ForgeWriter;
```

Every request carries that installation's token. The rules (PM-publish, PM-readback, 8.3):

- **`publishReview`** sends `POST /repos/<owner>/<repo>/pulls/<number>/reviews` with the JSON body `{ "commit_id": draft.commit, "body": draft.body, "event": "COMMENT", "comments": [{ "path", "side", "line", "body" }, ...] }`. The `comments` key is left out when there are none. A 2xx answer whose `id` is a whole number resolves `{ id: String(id) }`. 422 rejects `review_rejected`. Any other answer rejects `github_<status>`, a 2xx answer without an id `github_bad_response`, and a failure to reach the service `github_network`. **It is sent once.** It is not repeated after any failure: the review may have been created, and the caller finds out with `listOwnReviews` (call 5).
- **`listOwnReviews`** reads `GET .../pulls/<number>/reviews`, 100 a page, at most `MAX_REVIEW_PAGES` pages; reaching that limit with more to read rejects `github_too_many_pages`. It keeps a review whose author is the app itself (the login is the app's `botLogin`, from `info.read()`, and the account's type is `Bot`) and whose `body` is not empty. It answers `{ id, commit }` for each, the latest `submitted_at` first.
- **`listReviewComments`** reads `GET .../pulls/<number>/comments`, 100 a page, and keeps those whose `pull_request_review_id` is the review's. Each is `{ id, path, side, line, body }`, `line` being the comment's `line` when that is a whole number and else its `original_line`, else null. Reaching `MAX_COMMENT_PAGES` with more to read answers null: a cut list stores nothing.
- **`react`** sends `POST /repos/<owner>/<repo>/issues/comments/<commentId>/reactions` with `{ "content": reaction }`. Any 2xx is done.
- **`comment`** sends `POST /repos/<owner>/<repo>/issues/<number>/comments` with `{ "body": body }`. Any 2xx is done.
- An id that is not all digits (`installation`, `commentId`, `reviewId`) rejects `github_bad_path` before any request. The owner and the repository name go through `createGithubHttp`'s `repoUrl`.

- [ ] **Step 1: Write the failing tests**

With `REF`, `auth` whose `installationToken` answers `tok-<id>`, `info` answering `botLogin: 'visto-test[bot]'`, and `github(routes)`: a stub `fetch` that answers by `"<METHOD> <path and query>"` (unknown: 404) and records each request's method, path, `authorization` header and parsed JSON body in `seen`:

```ts
const DRAFT = { commit: 'head222', body: 'Review text', comments: [{ path: 'a.ts', side: 'RIGHT' as const, line: 3, body: '**[major]** note' }] };
const REVIEWS = 'POST /repos/acme/shop/pulls/7/reviews';

test('a review is posted once, as a comment pinned to its commit, with the installation token', async () => {
  const { writer, seen } = github({ [REVIEWS]: () => json({ id: 501 }) });
  assert.deepEqual(await writer.publishReview(REF, '99', DRAFT), { id: '501' });
  assert.deepEqual(seen, [{ method: 'POST', path: '/repos/acme/shop/pulls/7/reviews', authorization: 'Bearer tok-99',
    body: { commit_id: 'head222', body: 'Review text', event: 'COMMENT', comments: DRAFT.comments } }]);
});
test('a review with no inline comment is sent without the comments key', async () => {
  const { writer, seen } = github({ [REVIEWS]: () => json({ id: 501 }) });
  await writer.publishReview(REF, '99', { ...DRAFT, comments: [] });
  assert.deepEqual(seen[0]!.body, { commit_id: 'head222', body: 'Review text', event: 'COMMENT' });
});
test('a refusal of the content has its own code, and nothing is ever sent twice', async () => {
  for (const [status, code] of [[422, 'review_rejected'], [502, 'github_502'], [403, 'github_403']] as const) {
    const { writer, seen } = github({ [REVIEWS]: () => json({ message: 'no' }, status) });
    await assert.rejects(writer.publishReview(REF, '99', DRAFT), new RegExp(`^Error: ${code}$`));
    assert.equal(seen.length, 1);
  }
  const down = github({ [REVIEWS]: () => { throw new Error('socket closed'); } });
  await assert.rejects(down.writer.publishReview(REF, '99', DRAFT), /^Error: github_network$/);
  assert.equal(down.seen.length, 1);
});
test("the app's own reviews are listed, newest first: by its own account, with a body", async () => {
  const review = (id: number, login: string, type: string, commit: string, body: string, at: string) =>
    ({ id, user: { login, type }, commit_id: commit, body, submitted_at: at, state: 'COMMENTED' });
  const { writer } = github({ 'GET /repos/acme/shop/pulls/7/reviews?per_page=100&page=1': () => json([
    review(1, 'visto-test[bot]', 'Bot', 'head111', 'old', '2026-03-01T09:00:00Z'),
    review(2, 'visto-test[bot]', 'Bot', 'head222', '', '2026-03-01T10:05:00Z'),
    review(3, 'other-app[bot]', 'Bot', 'head222', 'text', '2026-03-01T10:06:00Z'),
    review(4, 'visto-test[bot]', 'User', 'head222', 'text', '2026-03-01T10:07:00Z'),
    review(5, 'visto-test[bot]', 'Bot', 'head222', 'text', '2026-03-01T10:08:00Z'),
  ]) });
  assert.deepEqual(await writer.listOwnReviews(REF, '99'), [{ id: '5', commit: 'head222' }, { id: '1', commit: 'head111' }]);
});
test("a review's comments are read from the pull request's list, with the line they sit on", async () => {
  const comment = (id: number, reviewId: number, line: number | null, original: number | null) =>
    ({ id, pull_request_review_id: reviewId, path: 'a.ts', side: 'RIGHT', line, original_line: original, body: 'note' });
  const { writer } = github({ 'GET /repos/acme/shop/pulls/7/comments?per_page=100&page=1': () => json([comment(9001, 501, 3, 3), comment(9002, 500, 4, 4), comment(9003, 501, null, 8), comment(9004, 501, null, null)]) });
  assert.deepEqual(await writer.listReviewComments(REF, '99', '501'), [
    { id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' },
    { id: '9003', path: 'a.ts', side: 'RIGHT', line: 8, body: 'note' },
    { id: '9004', path: 'a.ts', side: 'RIGHT', line: null, body: 'note' },
  ]);
});
test('a comment list that was cut short answers null', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, pull_request_review_id: 501, path: 'a.ts', side: 'RIGHT', line: 1, original_line: 1, body: 'n' }));
  const routes = Object.fromEntries(Array.from({ length: 25 }, (_, p) => [`GET /repos/acme/shop/pulls/7/comments?per_page=100&page=${p + 1}`, () => json(full)]));
  assert.equal(await github(routes).writer.listReviewComments(REF, '99', '501'), null);
});
test('a reaction and a general comment are posted to the pull request', async () => {
  const { writer, seen } = github({
    'POST /repos/acme/shop/issues/comments/31/reactions': () => json({ id: 1 }, 201),
    'POST /repos/acme/shop/issues/7/comments': () => json({ id: 2 }, 201),
  });
  await writer.react(REF, '99', '31', 'eyes');
  await writer.comment(REF, '99', 'text');
  assert.deepEqual(seen.map((s) => [s.path, s.body]), [['/repos/acme/shop/issues/comments/31/reactions', { content: 'eyes' }], ['/repos/acme/shop/issues/7/comments', { body: 'text' }]]);
});
test('an id that is not digits is refused before any request', async () => {
  const { writer, seen } = github({});
  await assert.rejects(writer.react(REF, '99', '3/1', 'eyes'), /^Error: github_bad_path$/);
  await assert.rejects(writer.listReviewComments(REF, '99', 'x'), /^Error: github_bad_path$/);
  await assert.rejects(writer.publishReview(REF, '9/9', DRAFT), /^Error: github_bad_path$/);
  assert.equal(seen.length, 0);
});
```

- [ ] **Step 2: Run them to see them fail, then add the types and implement `createGithubWriter`**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/forge
git commit -m "feat: the write side of the GitHub adapter"
```

---

### Task 5: A `/review` comment stores a manual job

**Files:**
- Create: `src/shell/commands.ts`
- Modify: `src/forge/types.ts` (the `general_comment` event gains `installation: string | null`), `src/forge/github/events.ts`, `src/shell/receive.ts`
- Test: `src/shell/commands.test.ts`, `src/shell/receive-jobs.test.ts`, the existing test of `events.ts`; every test that builds a `general_comment` event gains the new field

**Interfaces:**
- Consumes: `enqueueJob` (Task 2).
- Produces:

```ts
// src/shell/commands.ts
/** The command a comment gives, read from its first line that is not empty. */
export function commandOf(body: string): 'review' | null;
/** The one sentence the service answers a refused command with. */
export function refusalText(login: string | null, code: string): string;
/** The one sentence it answers a command that failed with. */
export function failureText(login: string | null, code: string): string;
```

PM-command, the rules:

- The command is on the first line of the comment that is not empty, with spaces around it ignored. It is `/review`, in any letter case, alone on the line or followed by a space or a tab and anything. `/reviews`, `please /review` and a `/review` on a later line are not commands.
- `refusalText('octo-dev', 'not_allowed')` is ``@octo-dev The review was not started (`not_allowed`).`` and `failureText('octo-dev', 'review_failed')` is ``@octo-dev The review did not finish (`review_failed`).`` The mention is written only for a login of 1 to 39 letters, digits and hyphens; otherwise the sentence starts with "The". The code is written only when it is a short code, else `internal_error`.
- In `events.ts`, an `issue_comment` event carries the installation the way a `pull_request` event does: `installation.id` as text, or null.
- In `receive`, a `general_comment` event that `captureOf` handled (so its author is a person, never a bot, the app itself included) and whose body gives a command stores a manual job in the delivery's transaction: `reason: 'command'`, `headSha: ''`, `trigger: 'manual'`, `requestedBy` the comment's author, `commentId` its id, `association` its association, `installation` the event's, due at the receiving time. `replace` is true when the comment's association is `owner`, `member` or `collaborator` and false otherwise: a command from someone without access is stored only when nothing is pending, so it can never push another job out (call 18). The comment is still stored as human activity. The `webhook` log entry of that delivery carries `command: 'review'` and `job`: `'queued'` when the job was stored, null when it was not. `onQueued` is called after the commit when it was stored. Whether the commenter may ask is not decided here (call 9).

- [ ] **Step 1: Write the failing tests**

`src/shell/commands.test.ts`:

```ts
test('/review is a command on the first line that is not empty, in any case, alone or followed by text', () => {
  for (const body of ['/review', '  /Review  ', '\n\n/REVIEW\nthanks', '/review please', '/review\tnow']) assert.equal(commandOf(body), 'review');
});
test('anything else is not a command', () => {
  for (const body of ['', 'please /review', '/reviews', '/reviewed', 'thanks\n/review', '/ review', '/done']) assert.equal(commandOf(body), null);
});
test('the answers are one fixed sentence with a short code', () => {
  assert.equal(refusalText('octo-dev', 'not_allowed'), '@octo-dev The review was not started (`not_allowed`).');
  assert.equal(failureText('octo-dev', 'review_failed'), '@octo-dev The review did not finish (`review_failed`).');
  assert.equal(refusalText(null, 'closed'), 'The review was not started (`closed`).');
  assert.equal(refusalText('not a login', 'closed'), 'The review was not started (`closed`).');
  assert.equal(failureText('octo-dev', 'Something long went wrong'), '@octo-dev The review did not finish (`internal_error`).');
});
```

`src/shell/receive-jobs.test.ts`, added, with `const said = (body: string, over = {}): ForgeEvent => ({ kind: 'general_comment', ref: REF, installation: '99', comment: { id: '31', author: 'octo-lead', authorIsBot: false, association: 'member', at: at(0), body, ...over } })` and `deliver` passing `name: 'issue_comment'`:

```ts
test('a /review comment stores a manual job due now, and the comment itself', async () => {
  assert.deepEqual(await deliver(said('/review'), 'c1'), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual(
    [job!.trigger, job!.reason, job!.headSha, job!.requestedBy, job!.commentId, job!.association, job!.installation, job!.runAt],
    ['manual', 'command', '', 'octo-lead', '31', 'member', '99', at(0)]);
  assert.equal((await listActivity(db, REF)).length, 1);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.command, queued], ['queued', 'review', 1]);
});
test('a /review replaces the pending job of a push, and a later push does not replace it', async () => {
  await deliver(pr('synchronize'), 'd1');
  await deliver(said('/review'), 'c1');
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(9) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.reason, j.runAt]), [['manual', 'command', at(0)]]);
});
test('a comment that is not a command, and a command from a bot, queue nothing', async () => {
  await deliver(said('looks good'), 'c1');
  await deliver(said('/review', { author: 'helper[bot]', authorIsBot: true }), 'c2');
  assert.deepEqual([await unfinishedJobs(db), queued], [[], 0]);
});
test("a stranger's command is stored when nothing is pending, for the job to refuse", async () => {
  await deliver(said('/review', { association: 'none' }), 'c1');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.association]), [['manual', 'none']]);
});
test("a stranger's command never pushes a pending job out", async () => {
  await deliver(pr('synchronize'), 'd1');
  assert.deepEqual(await deliver(said('/review', { association: 'none' }), 'c1'), { status: 202, body: 'accepted' });
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.reason, j.runAt]), [['automatic', 'synchronize', at(180)]]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.job, queued], ['review', null, 1]);
});
```

`deliver` takes any `ForgeEvent`; its reader stub names the event as it is (`pull_request` or `issue_comment`).

The test of `events.ts` gains: an `issue_comment` payload with `installation: { id: 99 }` gives `installation: '99'`, and one without gives `null`.

- [ ] **Step 2: Run them to see them fail, then implement**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/shell src/forge
git commit -m "feat: a /review comment stores a manual job with its delivery"
```

---

### Task 6: Publishing one stored review

**Files:**
- Create: `src/shell/publish.ts`
- Test: `src/shell/publish.test.ts`

**Interfaces:**
- Consumes: `ForgeAccess`, `ForgeWriter` (Task 4), `StoredRun` (Task 2), `renderReview` with its inline switch (Task 1).
- Produces:

```ts
export type PublishOutcome =
  | { kind: 'published'; reviewId: string; body: string; inlineDropped: boolean; adopted: boolean }
  | { kind: 'moved'; head: string }          // the head or the base is not the one the review was computed for
  | { kind: 'closed' }
  | { kind: 'already_reviewed' }             // the app has a review on another commit of this pull request
  | { kind: 'rejected' }
  | { kind: 'failed'; code: string };
export interface PublishDeps {
  forge: ForgeAccess; writer: ForgeWriter;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
}
/** Publishes one recorded review, or says why not. Writes nothing to the database. Never rejects. */
export function publishRun(deps: PublishDeps, args: {
  ref: PullRequestRef; installation: string; run: StoredRun; trigger: 'automatic' | 'manual'; requestedBy: string | null;
}): Promise<PublishOutcome>;
```

It is never called in dry run (Task 7). In this order (8.3, D20, calls 5, 7, 8 and 14):

1. **The pull request now.** `forge.readPullRequest`. A rejection is `failed` with its code. Not there, or not open, is `closed`. A head that is not `run.headSha`, or a base that is not `run.baseSha`, is `moved` with the live head: the review was computed for another diff.
2. **Already posted?** `writer.listOwnReviews(ref, installation)`. A rejection is `failed`.
   - One on `run.headSha` is **adopted**: nothing is posted, and the outcome is `published` with its id and `adopted: true`. Which form it had is read, not guessed: when the run has inline comments, `writer.listReviewComments` for that review tells. An empty list means the earlier attempt posted the body-only form, so the outcome carries `inlineDropped: true` and the body-only text of step 4. Otherwise, a cut list (null) included, it carries `inlineDropped: false` and `run.body`. A rejection of that read is `failed`.
   - Otherwise, one on any other commit is `already_reviewed`: this pull request has its first review, which the database did not know (call 5).
3. **The post.** `writer.publishReview` with `{ commit: run.headSha, body: run.body, comments: run.comments }`. Done is `published` with `adopted: false`.
4. **The fallback.** When step 3 rejects `review_rejected` and the review had inline comments, the review is rendered again from `run.result` with `inline: false` (same `trigger`, `requestedBy` and `lineUrl`, bound to the live pull request) and posted with no comments, still pinned to `run.headSha`. Done is `published` with `inlineDropped: true` and that body. `review_rejected` again, or at step 3 for a review with no inline comment, is `rejected`: the git service refuses the review itself, and nothing unpinned is tried in its place.
5. Any other rejection of a post is `failed` with its code. Whether the review exists is then unknown; step 2 of the next attempt finds out. A post is never repeated.

- [ ] **Step 1: Write the failing tests**

With `REF`, `at`, `LIVE` (head `h1`, base `merge000`) and `okResult()` as plan 4's review-job tests have them, a `run` built from `okResult()` rendered with `inline: true` (`id: 4`, `headSha: 'h1'`, `baseSha: 'merge000'`, `startedAt: at(0)`, `dryRun: false`), and `harness(options)`: a `forge` returning `options.live` (default `LIVE`; an `Error` rejects), a `writer` that records every call in `calls` as `[name, ...what matters]`, whose `listOwnReviews` answers `options.own ?? []`, whose `listReviewComments` answers `options.posted ?? [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }]`, and whose `publishReview` answers or rejects with the next entry of `options.posts` (default `{ id: '501' }`), and `args` with `options.run ?? run`:

```ts
test('a review is posted pinned to the commit it was computed for', async () => {
  const h = harness();
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, adopted: false });
  assert.deepEqual(h.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('a review an earlier attempt already posted is adopted, and nothing is posted', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, adopted: true });
  assert.equal(h.calls.some((c) => c[0] === 'publishReview'), false);
});
test('an adopted review that was posted without its inline comments is recorded as such', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }], posted: [] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.adopted, out.inlineDropped, out.body !== run.body], ['480', true, true, true]);
});
test("a review of the app's own on another commit means the pull request has its first review", async () => {
  const h = harness({ own: [{ id: '470', commit: 'h0' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'already_reviewed' });
  assert.equal(h.calls.some((c) => c[0] === 'publishReview'), false);
});
test('nothing is posted for a head or a base that moved, or on a pull request that is closed or gone', async () => {
  const cases: Array<[LivePullRequest | null, PublishOutcome]> = [
    [{ ...LIVE, info: { ...LIVE.info, headSha: 'h2' } }, { kind: 'moved', head: 'h2' }],
    [{ ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } }, { kind: 'moved', head: 'h1' }],
    [{ ...LIVE, state: 'closed' }, { kind: 'closed' }], [{ ...LIVE, state: 'merged' }, { kind: 'closed' }], [null, { kind: 'closed' }],
  ];
  for (const [live, expected] of cases) {
    const h = harness({ live });
    assert.deepEqual(await publishRun(h.deps, h.args), expected);
    assert.deepEqual(h.calls, []);
  }
});
test('when the inline comments are refused, the review is posted with their text in its body, still pinned', async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.inlineDropped, out.adopted, out.body !== run.body], ['502', true, false, true]);
  assert.deepEqual(h.calls.slice(1), [['publishReview', 'h1', run.body, 1], ['publishReview', 'h1', out.body, 0]]);
});
test('a review the git service refuses twice, or refuses with no inline comment, is rejected', async () => {
  const twice = harness({ posts: [new Error('review_rejected'), new Error('review_rejected')] });
  assert.deepEqual(await publishRun(twice.deps, twice.args), { kind: 'rejected' });
  const bare = harness({ posts: [new Error('review_rejected')], run: { ...run, comments: [] } });
  assert.deepEqual(await publishRun(bare.deps, bare.args), { kind: 'rejected' });
  assert.equal(bare.calls.filter((c) => c[0] === 'publishReview').length, 1);
});
test('any other failure says so with its code, and a post that failed is not repeated', async () => {
  const cases: Array<[Parameters<typeof harness>[0], string]> = [
    [{ live: new Error('github_502') }, 'github_502'], [{ own: new Error('github_network') }, 'github_network'],
    [{ own: [{ id: '480', commit: 'h1' }], posted: new Error('github_502') }, 'github_502'],
    [{ posts: [new Error('github_502')] }, 'github_502'], [{ posts: [new Error('Something private')] }, 'internal_error'],
    [{ posts: [new Error('review_rejected'), new Error('github_network')] }, 'github_network'],
  ];
  for (const [options, code] of cases) {
    const h = harness(options);
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'failed', code });
    assert.equal(h.calls.filter((c) => c[0] === 'publishReview').length, options?.posts?.length ?? 0);
  }
});
```

- [ ] **Step 2: Run them to see them fail, then implement `publishRun`**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/shell
git commit -m "feat: publish one stored review, once, pinned to its commit"
```

---

### Task 7: The review job records, then publishes

**Files:**
- Create: `src/shell/dry-writer.ts`
- Modify: `src/shell/review-job.ts`, `src/service.ts`, `src/main.ts`
- Test: `src/shell/review-job.test.ts`, `src/service.test.ts` (its harness gains a `writer` fake), `src/shell/dry-writer.test.ts`

**Interfaces:**
- Consumes: `publishRun` (Task 6); `markPublished`, `unpublishedRun`, `lastPublishedRun`, `recordComments` (Task 2); `ForgeWriter`, `createGithubWriter` (Task 4); `createAppInfo` (Task 3).
- Produces:

```ts
// src/shell/dry-writer.ts
/** A writer for dry run: every method rejects with Error('dry_run'). */
export function dryWriter(): ForgeWriter;
// src/shell/review-job.ts
export const STORED_REVIEW_MS = 24 * 3_600_000;
// ReviewJobDeps gains: writer: ForgeWriter
// src/service.ts: ServiceDeps gains: writer: ForgeWriter
```

**The wiring, so that the project compiles after this task.** `main` builds one `createAppInfo` and one `createGithubWriter` over the app's identity and passes the writer to `startService`. The service hands the review job `dryWriter()` when `config.dryRun` is true and the real writer otherwise. `serviceConfig` still refuses `dryRun: false` until Task 9, so nothing can post yet outside a test.

This task is about **automatic** jobs. A manual job is Task 8's; until then it takes this same path.

**In dry run nothing changes,** except that the installation is taken as in step 1 below. Every other step and every end of plan 4's job stays as it is, `publishRun` is not called and the writer is not called. Plan 4's tests keep passing unchanged, apart from the new dependency.

**Not in dry run,** the steps of plan 4's job become:

1. **The installation** is the job's own when it has one, else the stored pull request's. None drops the job as `no_installation`.
2. **The live read** and **3. the checks** are as before.
4. **Already reviewed?** `lastPublishedRun(db, job.ref)`. When there is one: the same head and base drops the job as `already_reviewed`; any other drops it as `later_head` (call 2). `hasOkRun` is not asked: a review that was computed and never published does not count.
5. **A stored review?** `unpublishedRun(db, job.ref, head, base, now - STORED_REVIEW_MS)`. When there is one, this start is a **resumed** one: the engine is not called, nothing is rendered, neither the health nor the spend guard is told anything, and step 8 publishes that run (call 6).
6. **The review** is as before.
7. **The record.**
   - A review that failed, a refused key, and a failure of the git service before any model call end as in plan 4. Nothing is published.
   - A review that ended `ok` but whose text could not be rendered (its body is empty) is recorded and the job finished in one transaction, `done` with outcome `render_failed`. It is never posted.
   - Any other review that ended `ok` is recorded alone, with three tries, and the job stays `running`. If the record fails three times, the end is `record_failed` as before.
8. **The publication.** `publishRun` with the recorded run. Then, by its outcome:
   - `published`: one transaction marks the run (`markPublished`) and finishes the job, `done` with outcome `published`. A run that was already marked still finishes the job. Three tries. If all three fail the job is left `running`, the log entry's outcome is `record_failed`, and the read-back is not made; the next start adopts the review (Task 6, step 2). After a successful mark, the read-back: `writer.listReviewComments`; each comment it returns is matched to the finding it came from and stored with `recordComments`. A comment matches the finding at the same position in the run's own lists whose rendered comment has the same path, side and text, each finding matched once; one that matches none is skipped. The read-back is logged as `{ event: 'readback', job, run, posted, stored }`. A list cut short (null), or a failure of the read or of the store, is logged as `{ event: 'readback_failed', job, run, reason }` and changes nothing else.
   - `moved`: one transaction stores a job for the live head (`replace: false`, the job's reason, `trigger: 'automatic'`, due after the quiet period) and finishes this one, `done` with outcome `head_moved`. Nothing was posted.
   - `closed`: the job is finished, `done` with outcome `closed`.
   - `already_reviewed`: the job is finished, `done` with outcome `already_reviewed`.
   - `rejected`: the job is finished, `done` with outcome `publish_rejected`.
   - `failed`: the job is put back with `requeueJob`, due after the retry wait of plan 4, its start counted. Its next start finds the stored review at step 5.

The `review` log entry gains `published` (true or false), `review` (the review's id or null), `publish` (the outcome's kind, or null when nothing was to publish), `publish_code` (the code of a `failed` publication, else null), `resumed` and `adopted`. On a resumed start it carries `calls: 0` and `cost: 0`: the review was logged with its cost when it was computed.

The function's guarantees stand: it never rejects; before it resolves the job is finished, put back, or left `running` on purpose after three failed writes; once the engine has returned, nothing puts the job back except a publication that `failed`.

- [ ] **Step 1: Write the failing tests**

`src/shell/dry-writer.test.ts`:

```ts
test('in dry run every write is refused', async () => {
  const w = dryWriter();
  const ref = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
  await assert.rejects(w.publishReview(ref, '99', { commit: 'h1', body: 'x', comments: [] }), /^Error: dry_run$/);
  await assert.rejects(w.listOwnReviews(ref, '99'), /^Error: dry_run$/);
  await assert.rejects(w.listReviewComments(ref, '99', '1'), /^Error: dry_run$/);
  await assert.rejects(w.react(ref, '99', '31', 'eyes'), /^Error: dry_run$/);
  await assert.rejects(w.comment(ref, '99', 'x'), /^Error: dry_run$/);
});
```

`src/shell/review-job.test.ts`. The file's harness gains: `options.dryRun` (default `true`, so plan 4's tests are untouched); a `writer` fake as in Task 6 whose calls are recorded in `h.writes`; `options.own`, `options.posts`, `options.posted` (what `listReviewComments` answers; default: one comment `{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: <the rendered comment of okResult's finding> }`); `options.liveAfter` (what `readPullRequest` answers from its second call on); `options.head` (the job's head and the live head); `options.pullRequest` (another pull request number, with its own stored facts); `options.reuseJob` (claims that job again; nothing is enqueued); `options.markFailures: n` (the first `n` transactions that hold `markPublished`'s statement reject). `live(options)` is `harness({ dryRun: false, ...options })`.

```ts
test('a finished review is recorded, posted, marked published, and its comments stored', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.dryRun, stored!.outcome, stored!.published, stored!.reviewId, stored!.inlineDropped], [false, 'ok', true, '501', false]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.deepEqual(await listComments(db, REF), [{ commentId: '9001', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', quote: 'x', run: stored!.id }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.published, entry.review, entry.publish, entry.publish_code, entry.resumed, entry.adopted], [true, '501', 'published', null, false, false]);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: stored!.id, posted: 1, stored: 1 });
});
test('in dry run nothing is ever written to the git service', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.writes, (await listRuns(db, REF))[0]!.published, (await getJob(db, h.job.id))?.outcome], [[], false, 'reviewed']);
});
test('a pull request that already has its review is not reviewed again: the same head, or a later one', async () => {
  const first = await live();
  await runReviewJob(first.job, first.deps);
  const same = await live();
  await runReviewJob(same.job, same.deps);
  const later = await live({ head: 'h2' });
  await runReviewJob(later.job, later.deps);
  assert.deepEqual(
    [(await getJob(db, same.job.id))?.outcome, (await getJob(db, later.job.id))?.outcome, same.inputs.length + later.inputs.length, (await listRuns(db, REF)).length],
    ['already_reviewed', 'later_head', 0, 1]);
});
test('when the post cannot be made the review stays stored and the job is put back with its start counted', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.published, j?.status, j?.runAt, j?.starts], ['ok', false, 'pending', at(60), 1]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.requeued], ['failed', 'github_502', true]);
});
test('the next start publishes the stored review without calling the model, and tells no guard', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([runs.length, runs[0]!.published, runs[0]!.reviewId, again.inputs.length, (await getJob(db, again.job.id))?.outcome], [1, true, '501', 0, 'published']);
  const entry = again.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.resumed, entry.calls, entry.cost, again.healthCalls, again.spendCalls.length], [true, 0, 0, [], 0]);
});
test('a review that was posted but not recorded as such is adopted, not posted again', async () => {
  const lost = await live({ markFailures: 3 });
  await runReviewJob(lost.job, lost.deps);
  assert.deepEqual([(await listRuns(db, REF))[0]!.published, (await getJob(db, lost.job.id))?.status, lost.logged.find((e) => e.event === 'review')!.outcome], [false, 'running', 'record_failed']);
  await requeueJob(db, lost.job.id, at(0), at(0), false);        // what start-up recovery does
  const again = await live({ reuseJob: lost.job.id, own: [{ id: '501', commit: 'h1' }] });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, again.inputs.length, again.writes.filter((w) => w[0] === 'publishReview').length], [true, '501', 0, 0]);
});
test('a review posted on an earlier head that the database never learned of stops a second first review', async () => {
  const h = await live({ head: 'h2', own: [{ id: '470', commit: 'h1' }] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.writes.filter((w) => w[0] === 'publishReview').length, (await listRuns(db, REF))[0]!.published], ['already_reviewed', 0, false]);
});
test('a head or a base that moved while the review ran gets nothing posted and a job of its own', async () => {
  const h = await live({ liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.writes.filter((w) => w[0] === 'publishReview').length], ['done', 'head_moved', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.trigger, j.runAt]), [['h2', 'automatic', at(180)]]);
  const based = await live({ pullRequest: 8, liveAfter: OTHER_BASE });
  await runReviewJob(based.job, based.deps);
  assert.equal((await getJob(db, based.job.id))?.outcome, 'head_moved');
});
test('a pull request closed while the review ran, and a review the git service refuses, end the job', async () => {
  const closed = await live({ liveAfter: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.equal((await getJob(db, closed.job.id))?.outcome, 'closed');
  const refused = await live({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual([(await getJob(db, refused.job.id))?.outcome, (await listRuns(db, { ...REF, number: 8 }))[0]!.published], ['publish_rejected', false]);
});
test('refused inline comments are recorded as dropped, with the text that was posted', async () => {
  const h = await live({ posts: [new Error('review_rejected'), { id: '502' }], posted: [] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.inlineDropped, (await listComments(db, REF)).length], [true, '502', true, 0]);
  assert.equal(stored!.body, h.writes.filter((w) => w[0] === 'publishReview').at(-1)![2]);
});
test('a read-back that is cut short or fails is logged and the publication stands', async () => {
  for (const [posted, number] of [[null, 8], [new Error('github_502'), 9]] as const) {
    const h = await live({ posted, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
    assert.equal(h.logged.some((e) => e.event === 'readback_failed'), true);
  }
});
test('a review that failed, or whose text could not be rendered, is recorded and never posted', async () => {
  const failedRun = await live({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual([(await getJob(db, failedRun.job.id))?.outcome, failedRun.writes, (await listRuns(db, REF))[0]!.published], ['failed', [], false]);
  const unrendered = await live({ pullRequest: 8, renderThrows: true });
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.deepEqual([(await getJob(db, unrendered.job.id))?.outcome, unrendered.writes], ['render_failed', []]);
  const next = await live({ pullRequest: 8 });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual([next.inputs.length, (await getJob(db, next.job.id))?.outcome], [1, 'published']);
});
```

`options.renderThrows` makes `deps.lineUrl` throw, which is what makes the render fail in plan 4's job (use a result whose scores need a link, or whatever the file's existing test of a render that throws does). In `src/service.test.ts` the harness passes a `writer` fake; no test there changes.

- [ ] **Step 2: Run them to see them fail, then change `runReviewJob`, add `dryWriter`, and wire the writer in the service and in `main`**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/shell src/service.ts src/service.test.ts src/main.ts
git commit -m "feat: the review job records a review, then publishes it once"
```

---

### Task 8: The manual job

**Files:**
- Modify: `src/shell/review-job.ts`
- Test: `src/shell/review-job.test.ts`

**Interfaces:**
- Consumes: `refusalText`, `failureText` (Task 5); everything Task 7 uses.
- Produces: nothing new.

A job whose `trigger` is `manual` differs from an automatic one in this (8.1, D15, calls 9 to 12 and 18). The order matters: nothing is written to the pull request before the job knows the command will be honoured, and a refusal is recorded before it is answered.

1. **Access.** Before any request, the job's `association` must be `owner`, `member` or `collaborator`. Otherwise the command is **refused** with `not_allowed`. In that same transaction an automatic job is stored for the pull request's stored head (`replace: false`, reason `opened`, due at once) when the pull request is stored and open: the command may have stood in the way of a push's job, and the head must still get its review (call 18).
2. **The pull request.** After the live read, one that is not there ends the job as `dropped`, `not_found`, with no answer. One that is not open is refused with `closed`. The filters of automatic reviews are not applied, and the head is not compared: the job reviews the live head.
3. **Already reviewed.** Out of dry run, a pull request that has a published review is refused with `already_reviewed`, whatever its head. In dry run a head that has an `ok` run is dropped as `already_reviewed`, as an automatic job is.
4. **Accepted.** Only now the service puts an `eyes` reaction on the comment.
5. **The review** runs with `trigger: 'manual'`, and the review text names who asked (`requestedBy`).
6. **The ends.**
   - `published`, `closed`, a put-back after a refused key or a failure of the git service, and a publication that `failed` are as in Task 7. They say nothing on the pull request.
   - `moved`: a job whose reason is `command` starts over once. One transaction stores a new manual job (reason `command_retry`, the same requester, comment, association and installation, due at once, `replace: true`) and finishes this one, `done` with outcome `head_moved`. A job whose reason is already `command_retry` does not start over: one transaction stores an automatic job for the live head (`replace: false`, due after the quiet period) and finishes it, `done` with outcome `head_moved`, and the command **failed** with `head_moved`.
   - `already_reviewed` from the publication is a refusal with `already_reviewed`.
   - A review that ended `failed` and is not put back, a `rejected` publication, a render that failed, and three failed tries to record mean the command **failed**, with `review_failed`, `publish_rejected`, `render_failed` and `record_failed`.
7. **Refused** means, in this order: the job is finished, `done` with outcome `refused` (three tries; if they fail nothing is answered); `{ event: 'job', job, repo, number, outcome: 'refused', reason }` is logged; then a `confused` reaction on the comment and the `refusalText` as a general comment. **Failed** means the same two writes with the `failureText`, after the job got the outcome it would have had anyway. Finishing first is what keeps an answer from being written twice after a crash.
8. **In dry run nothing is written:** no reaction, no answer. The job still refuses, reviews and records as above. Out of dry run each write is guarded: one that cannot be made is logged as `{ event: 'answer_failed', job, reason }` and changes nothing else.

A manual job the runner later drops as out of starts or too old gets no answer; the notes list it.

- [ ] **Step 1: Write the failing tests**

With `manualJob(options)`: the harness of Task 7 with a job enqueued as `manual` (`reason: 'command'`, `requestedBy: 'octo-lead'`, `commentId: '31'`, `association: 'association' in options ? options.association : 'member'`, `installation: '99'`, `headSha: ''`) and `dryRun: false` unless given. `h.reads` counts the calls of `forge.readPullRequest`. `options.writeFails` makes `react` and `comment` reject.

```ts
test('a /review from a member is accepted, reviewed as requested, and published', async () => {
  const h = await manualJob();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes.map((w) => w[0]), ['react', 'listOwnReviews', 'publishReview', 'listReviewComments']);
  assert.deepEqual(h.writes[0], ['react', '31', 'eyes']);
  assert.deepEqual([h.inputs[0]!.trigger, (await listRuns(db, REF))[0]!.trigger, (await getJob(db, h.job.id))?.outcome], ['manual', 'manual', 'published']);
  assert.equal((await listRuns(db, REF))[0]!.body.includes('requested by @octo-lead'), true);
});
test('a /review from someone without access is refused before anything is read, and the head still gets its job', async () => {
  for (const [association, number] of [['none', 7], [null, 8], ['contributor', 9]] as const) {
    const h = await manualJob({ association, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual(h.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`not_allowed`).']]);
    assert.deepEqual([h.reads, h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 0, 'refused']);
    const left = (await unfinishedJobs(db)).filter((j) => j.ref.number === number);
    assert.deepEqual(left.map((j) => [j.trigger, j.reason, j.headSha, j.status]), [['automatic', 'opened', 'h1', 'pending']]);
  }
});
test('a /review on a closed pull request, or on one that has its review, is refused with no eyes first', async () => {
  const closed = await manualJob({ live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.deepEqual(closed.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`closed`).']]);
  const first = await live({ pullRequest: 8 });
  await runReviewJob(first.job, first.deps);
  const second = await manualJob({ pullRequest: 8 });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual([second.writes, second.inputs.length],
    [[['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`already_reviewed`).']], 0]);
});
test('a draft, an ignored author and a filtered base branch do not stop a /review, and the live head is the one reviewed', async () => {
  const h = await manualJob({ live: { ...LIVE, info: { ...LIVE.info, draft: true, author: 'dependabot[bot]', headSha: 'h9' } }, settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, (await listRuns(db, REF))[0]!.headSha], ['published', 'h9']);
});
test('a head that moves under a /review starts it over once, as a new job', async () => {
  const moved = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  const first = await manualJob({ liveAfter: moved });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual([(await getJob(db, first.job.id))?.outcome, first.writes.some((w) => w[0] === 'comment')], ['head_moved', false]);
  const [retry] = await unfinishedJobs(db);
  assert.deepEqual([retry!.trigger, retry!.reason, retry!.requestedBy, retry!.commentId, retry!.association, retry!.runAt], ['manual', 'command_retry', 'octo-lead', '31', 'member', at(0)]);
  const second = await manualJob({ reuseJob: retry!.id, live: moved, liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h3' } } });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual([(await getJob(db, second.job.id))?.outcome, second.writes.at(-1)], ['head_moved', ['comment', '@octo-lead The review did not finish (`head_moved`).']]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.headSha, j.runAt]), [['automatic', 'h3', at(180)]]);
});
test('a /review whose review fails, or whose publication is refused, says so', async () => {
  const failedRun = await manualJob({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual(failedRun.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`review_failed`).']]);
  const refused = await manualJob({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual(refused.writes.at(-1), ['comment', '@octo-lead The review did not finish (`publish_rejected`).']);
});
test('in dry run a /review writes nothing, whether it is honoured, refused or fails', async () => {
  const ok = await manualJob({ dryRun: true });
  await runReviewJob(ok.job, ok.deps);
  const stranger = await manualJob({ dryRun: true, association: 'none', pullRequest: 8 });
  await runReviewJob(stranger.job, stranger.deps);
  const closed = await manualJob({ dryRun: true, pullRequest: 9, live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  const failing = await manualJob({ dryRun: true, pullRequest: 10, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failing.job, failing.deps);
  assert.deepEqual([ok.writes, stranger.writes, closed.writes, failing.writes], [[], [], [], []]);
  assert.deepEqual(
    [(await getJob(db, ok.job.id))?.outcome, (await getJob(db, stranger.job.id))?.outcome, (await getJob(db, closed.job.id))?.outcome, (await getJob(db, failing.job.id))?.outcome, stranger.inputs.length],
    ['reviewed', 'refused', 'refused', 'failed', 0]);
});
test('a refusal is recorded before it is answered, and an answer that cannot be written changes nothing', async () => {
  const h = await manualJob({ association: 'none', writeFails: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.logged.filter((e) => e.event === 'answer_failed').length], ['refused', 2]);
  const unrecorded = await manualJob({ association: 'none', pullRequest: 8, finishFailures: 3 });
  await runReviewJob(unrecorded.job, unrecorded.deps);
  assert.deepEqual([unrecorded.writes, (await getJob(db, unrecorded.job.id))?.status], [[], 'running']);
});
```

`options.finishFailures: n` makes the first `n` transactions (or statements) that finish the job reject.

- [ ] **Step 2: Run them to see them fail, then implement the manual path**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/shell
git commit -m "feat: a /review is checked, answered and run inside its job"
```

---

### Task 9: The app check at start, leaving dry run, and a real run

**Files:**
- Modify: `src/service.ts`, `src/main.ts`, `src/config/load.ts`, `src/forge/github/send-sample.ts`, `README.md`, `config.example.yml`
- Test: `src/service.test.ts`, the test of `src/config/load.ts`, the test of `send-sample.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `ServiceDeps` gains `appInfo: AppIdentity`. `ServiceConfig`'s `dryRun` is `boolean`.

- `serviceConfig` no longer refuses `dryRun: false`.
- **The start-up check (8.4, call 13).** After the first key check and before redelivery, the service asks `appInfo.lacks(config.dryRun)` and, for each entry, logs `{ event: 'feature_off', feature, missing }` and raises the alert `feature_off` with `{ feature, missing }`. With nothing missing it logs `{ event: 'app_check', missing: 0 }`. A check that cannot be made is logged like the other steps that follow listening, and the service goes on; it is not made again until the next start. `settled` waits for it.
- **A step that fails says why.** The `start_step_failed` entry gains `reason`: the error's message when that is a short code, else null. (Its `code` stays the error's own `code` property, which a short-code error does not have.)
- `main` passes the `createAppInfo` it already builds as `appInfo`.
- The sample tool's `comment` kind carries `installation: { id: 99 }` and takes `--body <text>` (default as now), so `--body /review` sends a command.
- `config.example.yml` ships `dryRun: true`, with a comment that says what changing it to `false` does. Until now a forgotten edit of the example stopped the start; from this task on it would post on real pull requests.
- `README.md`, plainly:
  - what leaving dry run does: the first review of each pull request is posted, pinned to its commit;
  - that a pull request is reviewed once: a later push is not reviewed yet, and why; so the review is of the head the pull request had when it was first seen ready;
  - `/review`: who may use it, what it answers, that it is honoured only while the pull request has no review, and that a bot's command is ignored;
  - what the app needs beyond a dry run (`pull_requests` write, `issues` write) and that the service says at start what is missing;
  - that mentions and raw HTML in text the model wrote are made inert, and links are not;
  - that nothing here has been tried against a real app.

- [ ] **Step 1: Write the failing tests**

`src/service.test.ts`, with the harness gaining an `appInfo` whose `lacks` answers `options.lacks` (default `[]`; an `Error` rejects) and `options.dryRun` (default `true`):

```ts
test('out of dry run, a review is posted through the writer the service was given; in dry run that writer is never reached', async () => {
  const out = await harness({ dryRun: false });
  const service = await out.start();
  await service.settled;
  await out.webhook(pr('opened'), 'd1');
  await out.published();                    // resolves when the writer fake's publishReview has been called
  assert.equal(out.writes.some((w) => w[0] === 'publishReview'), true);
  const dry = await harness();
  await (await dry.start()).settled;
  await dry.webhook(pr('opened'), 'd1');
  await dry.reviewed();
  await dry.flush();
  assert.deepEqual(dry.writes, []);
});
test('at start the service says what the app lacks, once for each thing, and keeps running', async () => {
  const h = await harness({ dryRun: false, lacks: [{ feature: 'publishing', missing: 'pull_requests:write' }, { feature: 'commands', missing: 'issues:write' }] });
  const service = await h.start();
  await service.settled;
  assert.deepEqual(h.logged.filter((e) => e.event === 'feature_off'), [
    { event: 'feature_off', feature: 'publishing', missing: 'pull_requests:write' },
    { event: 'feature_off', feature: 'commands', missing: 'issues:write' },
  ]);
  assert.equal(h.logged.filter((e) => e.event === 'alert' && e.code === 'feature_off').length, 2);
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});
test('an app that lacks nothing is logged as such, and a check that cannot be made does not stop the start', async () => {
  const ok = await harness();
  await (await ok.start()).settled;
  assert.deepEqual(ok.logged.filter((e) => e.event === 'app_check'), [{ event: 'app_check', missing: 0 }]);
  const down = await harness({ lacks: new Error('github_network') });
  await (await down.start()).settled;
  assert.equal(down.logged.some((e) => e.event === 'start_step_failed' && e.step === 'app_check' && e.reason === 'github_network'), true);
});
```

Where an existing test of this file compares the whole list of log entries, the `app_check` entry is filtered out with the `recovery` and `model_check` ones.

The config test: `serviceConfig` accepts a config with `dryRun: false` and one with `dryRun: true`, and still names a missing `app` or `database` block; the example file loads with `dryRun: true`. The sample tool's test: `sampleWebhook('comment', 's', 'd1', { body: '/review' })` sends that body and an installation.

- [ ] **Step 2: Run them to see them fail, then implement; update the README and the example config**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src README.md config.example.yml
git commit -m "feat: the service publishes when it is not in dry run, and says what the app lacks"
```

- [ ] **Step 4: A real run on this machine, with the app cut off from the outside**

As in plan 4: its own Compose project, an override and an env file kept outside the repository, an internal network, a key made for the run. The config has `dryRun: false`. Show, and record in the notes:

1. The app starts out of dry run. Its log has `listening`, and a `start_step_failed` for `app_check` whose `reason` is `github_network`, since nothing is reachable. It keeps running.
2. An `opened` sample is answered `202 accepted`; its job fails at `prepare` and is put back, as in plan 4. No row of `review_runs` is marked published.
3. A `comment` sample with `--body /review` is answered `202 accepted` and stores a job whose `trigger` is `manual`, with the requester and the comment's id.
4. The migration ran over a database that plan 4's code had filled: the previous release's image is started first and sent samples, then this one is started on the same volume. The ledger has `0003_publishing`, and the old rows read back with `trigger = 'automatic'` and `published = false`.
5. With `psql`, on rows made by hand: `markPublished`'s statement run twice on one row writes it once; the upsert of an automatic job against a pending manual job returns no row; and the upsert of a manual job with `do nothing` against a pending automatic job returns no row.
6. Everything is removed afterwards.

- [ ] **Step 5: Write the notes file and commit it**

`docs/superpowers/plans/2026-11-19-publishing-the-first-review-notes.md`, in the form of the earlier notes.

---

## To verify with a real app

None of this can be shown by a test or by the run in Task 9. Each needs a GitHub App on a scratch repository and the owner's go-ahead; the review itself also needs a model key.

1. That a review posted with an installation token appears on the pull request, pinned to its commit, with its inline comments, and that GitHub's refusal of a comment off the diff is a 422.
2. That the app's own reviews are listed under the login `<slug>[bot]` with the account type `Bot`, which is how an earlier attempt's review is recognised, and how soon after a post the review is in that list.
3. That `GET /app` answers the app's slug, permissions and events as the check reads them, that the permission names are the ones in section 10, and whether it shows what an installation has actually granted. If it does not, an installation that has not accepted a new permission passes the check and its posts are refused.
4. That the pull request's comment list names each comment's review, and returns each comment's text as it was sent, so the read-back matches them.
5. That a reaction and a general comment need the `issues` permission and not less.
6. The association GitHub reports for a commenter, also for a member whose membership is private (design 20, item 7).
7. That a zero-width space after `@` stops a mention, that `&lt;` shows as `<`, and that both read well in a review.
8. One whole first review of a real pull request, and one `/review`.
