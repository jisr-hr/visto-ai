# The Audit Sample Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With automatic approval on, a share of the pull requests the bot would approve, 5% unless the deployment config says otherwise for all repositories or for one, is sent to a person anyway: the review is posted as a comment whose last paragraph says the pull request was drawn for the audit sample, and its decision is recorded as `audit_sample`. The draw is a keyed hash of the pull request's identity, so pushing again does not draw it again and nobody without the deployment's audit key can tell beforehand which pull request will be drawn. A share of 0 switches the sample off and needs no key. The refusal of `autoApprove` unless `auditShare: 0` goes; in its place the config refuses to start without the audit key while some repository has approval on with a share above 0.

**Architecture:** The draw is one pure function, `drawnForAudit` (`src/approval/audit.ts`): HMAC-SHA-256 keyed with the audit key over the pull request's identity as the service stores it, its first four bytes read as a number below 2^32 and compared with the share. It is condition 6, and the decision at publish (`decide` in `src/shell/publish.ts`) asks it last, once every other condition holds, through a function the review job puts in the `ApprovalContext`; the key reaches the review job from the loaded config through the service and goes nowhere else. The answer is a new `ApprovalCode`, `audit_sample`, with a sentence of its own in `src/approval/text.ts`; it is posted, recorded, logged and withdrawn from as every code that does not approve already is. The config gains one top-level key, `auditKey`, by reference.

**Tech Stack:** Unchanged. `node:crypto`'s `createHmac`. No new library, no model call, no migration.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 2 (anti-goals); 3 (D9, D10); 6.4 (condition 6, and the order the conditions are read in); 6.5 (the audit sample); 11.1 (the audit key, by reference); 11.2 (what the team file may not loosen); 13 (`review_runs`); 14 (alerts: none added); 18 (item 9); 20; 21; 22.

**Notes:** the notes file beside this plan is written when the build ends. This is the second of two plans of stage 9; the first, `2026-11-24-automatic-approval.md`, and its notes stand whole.

**Words used below.** *Approval on*, *a standing approval*, *the decision*, *the rule*: as in the plan before. *The share*: `approvalOf(settingsFor(repo)).auditShare`, read when the job is about to publish. *The key*: the value of the environment variable that the config's `auditKey` names. *The identity*: `JSON.stringify([ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number])`, the pull request as `review_runs` stores it. *Drawn*: `drawnForAudit(key, ref, share)` is true. *An audited review*: a published review whose `approval_code` is `audit_sample`.

## Scope

| In this plan | Left out, and why |
|---|---|
| The draw (6.5, D9): keyed, pure, no head and no time, pinned by vectors and a count over many pull requests | **A label or a review request on GitHub** (call 4): the review's own text is the label |
| Condition 6 at publish, read last (call 3); its text, its code, its record, its log line | **A count of audits for the UI, and audits in the numbers of 6.6**: stage 10; the code is the source |
| The config: `auditShare` drawn as written, `auditKey` by reference, the old refusal replaced by the key's | **`.visto-ai.yml` raising the share** (11.2): the file holds paths only, and stays so |
| The documents, a run under Docker | **A check against GitHub**: none can show an audited review on the scratch repository ("For the owner", 3) |

**Dry run:** nothing is decided (the plan before), so nothing is drawn. The key's refusal holds in dry run too (call 5).

## Not in this plan

- **A label, an assignee, a requested reviewer, a check or an alert for an audit** (call 4).
- **Storing the draw, the share or the key's fingerprint** (calls 6, 9).
- **A UI count of audits, audits in the three numbers of 6.6, a notifier field** (stage 10; `ReviewNotice` is unchanged).
- **Any dropped idea** (call 7).

## Calls made in this plan

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where the design says otherwise, the call says so.

1. **(builder) One plan, five tasks:** the draw; its sentence; condition 6 at publish and in the job; the key in the config and its wiring; the documents and the run. The config's refusal is lifted only in Task 4, after the draw is wired (Task 3), so no commit accepts a share above 0 without drawing. Cost: none known.
2. **(builder) The draw is pure and keyed; the planner fixes its bytes.** `createHmac('sha256', key)` with the key's UTF-8 bytes as the variable holds them (no trim, no decoding), over the identity's UTF-8 bytes; the first four bytes of the digest read big-endian as an unsigned number `u` (`readUInt32BE(0)`); drawn exactly when `u * 100 < share * 2 ** 32`. Both sides are exact in a double (`u * 100` is below 2^39, and `share * 2 ** 32` only moves the exponent), so a fractional share such as 37.5 is drawn as written, with no rounding; at 0 nothing is drawn, at 100 everything. The draw reads no head, no base and no time. Cost: a new pull request for the same change is a new draw (the design accepts it); the identity's encoding cannot change later without drawing every open pull request again; the share's steps are 1 in 2^32, far finer than any share written.
3. **(builder) The draw is the last condition.** `decide` asks it only after the rule answered `dismissed`, so `audit_sample` means "every other condition held, and this would have been an approval". The design lists the audit sixth; it gives no order of reading, and Task 5 amends 6.4 to say so. Cost: a drawn pull request has its threads and the branch's rule read from GitHub (up to the reads of call 3 of the plan before) though it is not approved; a refusal found earlier is named instead of the draw, so a pull request drawn at a head where it is refused for another reason says only that reason.
4. **(builder) The label is the review's own text, and the code `audit_sample`, recorded in `approval_code`** like every decision. No GitHub label, no review request, no assignee, no new permission, no new kind of write. Cost: nothing in GitHub's lists or filters marks an audited pull request; a person finds one by reading the review, or with the README's statement; nothing makes a person review it but the repository's own rule that requires an approving review, as for any review that does not approve (21, point 1).
5. **(builder) A missing key fails closed, and the planner sets the details.** While the defaults, or some override merged with them, have `autoApprove` true and a share above 0, a config with no `auditKey` is refused with one issue naming `auditKey`; an `auditKey` written is resolved whatever the repositories say (as `alerts` and `scorer` are): a variable not set or set empty is refused by name, and so is a value of fewer than 32 characters (planner's: a short key could be found from the draws an author has seen). Both hold in dry run, as the refusal they replace did, and for the eval commands, which read the same config. No issue quotes a value. Cost: a dry-run deployment with approval on needs a key though nothing is drawn; an eval run with the deployment's config needs the variable set; an operator with a short key makes a longer one.
6. **(builder) No migration.** `approval_code` holds the code; `approved` is false. Cost: nothing records which share or which key drew an audit; an audit is told from its code only.
7. **(builder) No new library, no model call, no dropped idea.** The draw spends nothing.
8. **How the share is written and read.** `auditShare` stays what it is: a number from 0 to 100 (fractions allowed by the schema), 5 when not written, under `repositories.defaults.score` and per repository under `repositories.overrides.<owner/name>.score`, each replacing the default's. It is read with the other settings when the job is about to publish. 0 (and -0) draws nothing, needs no key, and never reads one. Cost: none known.
9. **Where the key lives, and a key changed.** A top-level `auditKey: { env: NAME }`; the loaded `DeploymentConfig` carries `auditKey` only when it is written; the service hands it to the review job (`ReviewJobDeps.auditKey`) and to nothing else. Nothing of a draw is stored, so a new key draws every open pull request again at its next review, unrelated to the old draw. Cost: rotating the key re-draws every open pull request; the record cannot tell which key drew an audit.
10. **The text, and where it stands.** One sentence, after `**Not approved automatically:** ` like every other reason, the same under both thread rules, showing no code (Task 2). It is the last reason in the order the decision reads (call 3). Cost: the paragraph does not start with the word audit; it tells the author that the pull request would otherwise have been approved, which makes the accepted gap (a new pull request draws again) easy to see.
11. **The log.** Nothing new: the `review` line carries `approved: false` and `approval: 'audit_sample'` by the code as it is. `drawnForAudit` returns a boolean and nothing else, so no line, record, text, issue or alert holds the key, the digest or `u`. Cost: the line does not carry the share.
12. **Every head, and a change of the share.** A pull request drawn is drawn at every head at which every other condition holds (the identity has no head), until the share or the key changes. Draws are nested: one drawn at a share is drawn at every higher share, so raising the share only adds pull requests and lowering it only removes some. A change takes effect at each pull request's next publication; nothing is withdrawn or posted because of it alone. Cost: an approval posted before a raise stands until its next push or review; a pull request the lower share no longer draws is approved at its next review, and a push that tells nothing new after an audited review still ends `nothing_new` (the newest review was no approval, call 12 of the plan before), so it waits for a push with something new or `/review`.
13. **The withdraw job, the gate and receiving do nothing new.** An audited review is a review that does not approve: after its publication the job asks for a withdraw job when the pull request has a standing approval, which (calls 10 and 11 of the plan before) withdraws an earlier approval, possible only after a share or a key changed. The gate does not read `approval_code`; receiving does not read it. Cost: none known.
14. **What cannot be told is drawn.** In `drawnForAudit`: a share of 0 is not drawn; a share that is no number from 0 to 100, a key that is not a non-empty string, and an identity that cannot be made are drawn. In `decide`: an answer of the draw that is not `false`, or a throw, is `audit_sample`. Cost: a key missing at run time (only outside `parseConfig`, as in a test) sends every approvable pull request to a person, labelled as an audit.
15. **What can be checked:** test vectors (an invented key, three identities, shares that bracket each one's number, 0 and 100), a count over 20,000 invented identities at three shares, nesting and independence, the order inside `decide`, the job and the service end to end with fakes, and a run under Docker (the refusals, a start that listens, the vectors computed inside the image). Against GitHub nothing can show an audited review on the private scratch repository ("For the owner", 3). Cost: an audited review posted through the service is shown only by the fakes.
16. **The example config writes `auditShare: 5`,** the default, where the refusal made it write 0, and a commented `auditKey`. Cost: none known.

## For the owner

1. **Nothing here cannot be undone:** no migration. Going back to the previous release needs the config changed back: it refuses `auditKey` as an unknown key, and `autoApprove` with a share above 0.
2. **Before approval goes on with a share above 0,** a key of at least 32 characters is set and kept like the webhook secret. A new key draws every open pull request again.
3. **Nothing against GitHub can show an audited review on the private scratch repository.** The draw is asked last, and there both reads of the branch's rule answer 403, so every review there ends `rule_unreadable` before the draw. It needs what item 2 of the plan before's "For the owner" names: a repository whose rules dismiss stale approvals. The default: not made.
4. **Rulings he may want to change,** each a small change: the draw read last (call 3); the label as the review's text alone (call 4); the key's 32 characters and its refusal in dry run (call 5); the paragraph telling the author the pull request would otherwise have been approved (call 10).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task the ASCII check of the plans before prints nothing.
- **No test reaches the network, a real database or a model.** A database is `testDb()`. GitHub is a fake. A clock is passed in.
- **The key.** It is read from the environment in `parseConfig` and used in `drawnForAudit`, and travels only from the config through `startService` to `ReviewJobDeps.auditKey`. It is never logged, stored, posted, rendered, put in an issue, an alert, a notice, a prompt or an error's text. The digest and `u` never leave `drawnForAudit`.
- **A share of 0 changes nothing.** Every existing test of approval is written with `auditShare: 0` and no key, and passes unchanged: that is the pin. With approval off nothing changes at all, but a config may now write `auditKey`, which is then resolved.
- **Fail closed:** call 14. `approved` is the decision only when the draw answered exactly `false`.
- **Boundaries, by the lint as it is.** `src/approval/audit.ts` imports `node:crypto`, `storable` from `src/db/text.ts` and the type `PullRequestRef` from `src/forge/types.ts`, and nothing else. `src/engine/**` imports nothing of it. No lint rule changes.
- **Texts:** the sentence of Task 2 and the issues of Task 4, character for character.
- **No new statement, no migration.**
- **No existing test is edited, but for these, each named in its task with the exact change:** `src/shell/publish.test.ts`, the helper `ctx` (Task 3); `src/config/load.test.ts`, the test `automatic approval is refused while the audit share is not written as 0, for the defaults and for one repository` and its constants `AUDIT_ISSUE`, `DEFAULTS_AUDIT` and `SHOP_AUDIT`, deleted, and the constant `ENV` (Task 4); `src/service.test.ts`, the constant `ENV` (Task 4); `src/config/load.test.ts`, the test `the example with its score block switched on reads approval as written: off, strict, share 0` (Task 5). Every new field of an existing type is optional, but `ApprovalContext.drawn`, which only `review-job.ts` and the `ctx` helper build. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test`; `REF = acme/shop` number 7; heads `h1`, `h2`; `KEY = 'audit-key-for-tests-only-0123456789'` (35 characters); `KEY_CHANGED = 'audit-key-for-tests-only-0123456788'`; `OTHER_KEY = 'another-audit-key-for-tests-0123456789'`; the variables `AUDIT` (config tests), `V` (service test) and `AUDIT_KEY` (the example). Every fixture is invented. The planner's reference numbers, made with Node 26's `node:crypto` (100 times `u / 2^32`): under `KEY`, acme/shop 7 is 18.8899, acme/shop 8 is 4.5701, acme/other 7 is 42.4439; under `KEY_CHANGED`, 20.3722, 6.8261 and 66.0023.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A draw an author could steer or predict:** another head, the letter case of the repository, a new key. Task 1 `the draw is pinned by three vectors` and `the identity is the pull request as the service stores it: JSON of the service, the owner and the repository lower-cased, and the number`; Task 3 `a pull request drawn at one head is drawn at the next; a lower share or another key can let it be approved`.
2. **The draw read too early, read as approved when it cannot be told, or asked on a path that posts nothing.** Task 3 `the draw is asked once, last, and only when every other condition held` and `a draw that throws or answers anything but false is an audit, never an approval`.
3. **The key missing, empty, short, written while not needed, in dry run; a value printed.** Task 4 `automatic approval with an audit share above 0 is refused without the audit key, once, for the defaults and for one repository` and `the audit key is read from its variable, and refused when unset, empty or shorter than 32 characters, by name and with no value`.
4. **The key not handed on:** without it every pull request would be drawn, and a test at a share of 100 would not notice. Task 4 `the service hands the review job the audit key the config names` (18.88 approves, 18.9 draws).
5. **The key or the digest in a log line.** Task 3 `with a share above 0 the job draws with the deployment's key: one drawn is posted with the audit paragraph and recorded as audit_sample, one not drawn is approved`.
6. **The share drawn is not the share written.** Task 1 `over 20,000 pull requests the share drawn is the share written`.

---

### Task 1: The draw

**Files:**
- Create: `src/approval/audit.ts`, `src/approval/audit.test.ts`

**Interfaces:**
- Consumes: `storable` (`src/db/text.ts`), `PullRequestRef` (`src/forge/types.ts`).
- Produces:

```ts
// src/approval/audit.ts
/** The pull request as the service stores it: JSON of [service, owner, repo, number], owner and repo through storable() and lower-cased. */
export function auditIdentity(ref: PullRequestRef): string;
/** Whether the pull request is drawn for the audit sample (6.5): keyed with `key`, over its identity, against `share` (0 to 100). Pure; never throws. */
export function drawnForAudit(key: string | undefined, ref: PullRequestRef, share: number): boolean;
```

**Rules (6.5, D9; calls 2, 8, 14):**

1. `share === 0` (so `-0` too): false, and the key is not read.
2. `share` not a number, `NaN`, below 0 or above 100: true. `key` not a string, or `''`: true.
3. `auditIdentity(ref)` is `JSON.stringify([ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number])`; for `REF` it is `["github","acme","shop",7]`.
4. `const u = createHmac('sha256', key).update(auditIdentity(ref), 'utf8').digest().readUInt32BE(0)`; drawn is `u * 100 < share * 2 ** 32`.
5. Anything that throws (a ref of the wrong shape): true. Nothing is logged; only the boolean leaves the function.

- [ ] **Step 1: Write the failing tests.**

```ts
test('the identity is the pull request as the service stores it: JSON of the service, the owner and the repository lower-cased, and the number', () => {
  /* REF: '["github","acme","shop",7]'; { owner: 'Acme', repo: 'Shop' }: the same; an owner 'ac\u0000me': '["github","acme","shop",7]' */
});
test('the draw is pinned by three vectors', () => {
  /* under KEY: acme/shop 7 false at 18.88, true at 18.9; acme/shop 8 false at 4.5, true at 5; acme/other 7 false at 42.44, true at 42.45;
     each false at 0 and true at 100; at 5 only acme/shop 8; Acme/Shop 8 drawn at 5 as acme/shop 8;
     under KEY_CHANGED at 5 none of the three; under KEY at 37.5 acme/shop 7 and 8, not acme/other 7 */
});
test('at 0 nothing is drawn, and no key is needed', () => { /* (undefined, REF, 0), ('', REF, 0), (KEY, REF, -0), (undefined, REF, -0): false */ });
test('what cannot be told is drawn: no key, an empty key, a share that is no number from 0 to 100, a pull request of the wrong shape', () => {
  /* (undefined, REF, 5), ('', REF, 5), (KEY, REF, NaN), (KEY, REF, -1), (KEY, REF, 101), (KEY, REF, '5' as never), (7 as never, REF, 5),
     (KEY, null as never, 5), (KEY, { ...REF, owner: 7 } as never, 5): each true */
});
test('over 20,000 pull requests the share drawn is the share written', () => {
  /* acme/shop 1 to 20,000 under KEY: drawn at 5 between 877 and 1,123; at 37.5 between 7,226 and 7,774; at 50 between 9,717 and 10,283
     (four standard deviations; the reference counts are 978, 7,531 and 10,117); at 0 none; at 100 all */
});
test('a pull request drawn at a share is drawn at every higher one, and another key or repository draws another set', () => {
  /* acme/shop 1 to 2,000: every one drawn at 5 under KEY is drawn at 10 and at 37.5; drawn at 5 under KEY and under OTHER_KEY: fewer than 20
     in both (reference: 101, 103, 1 in both); acme/shop and acme/other under KEY at 5: fewer than 20 numbers in both (reference: 101, 89, 3) */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/approval/audit.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the audit sample's draw, keyed over the pull request and pure`.

---

### Task 2: What a review drawn for the audit sample says

**Files:**
- Modify: `src/approval/rule.ts` (the type only), `src/approval/text.ts`
- Test: `src/approval/text.test.ts` (new tests only)

**Interfaces:**

```ts
// src/approval/rule.ts
// ApprovalCode gains: | 'audit_sample'
```

**Rules (6.5; calls 4, 10):**

1. `REASONS` gains `audit_sample`, so the paragraph is exactly:

```text
**Not approved automatically:** this pull request was drawn for the audit sample. Every other condition for an automatic approval holds, and a share of the pull requests this reviewer would approve is sent to a person anyway, so that people keep checking what it approves. A person should review it.
```

2. It reads neither `meta.code` nor the threshold, and is the same under both thread rules. Nothing else of the file changes.

- [ ] **Step 1: Write the failing tests.**

```ts
test('a review drawn for the audit sample says so, pinned whole, under both rules, and shows no code', () => {
  /* approvalParagraph('audit_sample', META) equals the text of rule 1; with rule 'gate', with threshold 40, without code: the same;
     with code 'github_403': does not hold 'github_403'; with the hostile meta of the ASCII test: the same text */
});
test('the audit sentence is ASCII and holds no mention, link, tag or heading', () => {
  /* the checks of 'the texts are ASCII and hold no mention, link, tag or heading', on approvalParagraph('audit_sample', ...) for both rules */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the sentence a review drawn for the audit sample ends with`.

---

### Task 3: Condition 6 at publish, drawn by the review job

**Files:**
- Modify: `src/shell/publish.ts`, `src/shell/review-job.ts`
- Test: `src/shell/publish.test.ts` (the helper `ctx`, and new tests), `src/shell/review-job.test.ts` (new tests only)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:

```ts
// src/shell/publish.ts
// ApprovalContext gains:  drawn: () => boolean;   // 6.5: asked once, last, only when every other condition held; a throw or any answer but false is drawn
// src/shell/review-job.ts
// ReviewJobDeps gains:    auditKey?: string;       // the deployment's audit key; absent: a share above 0 draws every pull request
```

**Rules (6.4 condition 6, 6.5; calls 3, 11, 13, 14):**

1. **`decide`:** where the rule answers `'dismissed'`, it asks `ctx.drawn()` once: `false` is `approved`; any other answer, or a throw, is `audit_sample`, with no detail. Every step before is as it is, so a refusal returns before the draw is asked; an adopted review and a held one never reach `decide`.
2. **The post:** `audit_sample` posts as a comment through today's chain (every comment, then without notes, then body only), each body ending with Task 2's paragraph; the outcome's `approval` is `{ approved: false, code: 'audit_sample', dismissed: false }`.
3. **The job:** `approvalContext()` gains `drawn: () => drawnForAudit(deps.auditKey, job.ref, approval.auditShare)`, with the settings it already read.
4. Everything after is the code as it is: `markPublished` stores `approved` false and `approval_code` `'audit_sample'`; a standing approval asks for a withdraw job; the `review` line carries `approved: false, approval: 'audit_sample'`.
5. **The helper `ctx` of `src/shell/publish.test.ts`** becomes `({ rule: 'strict', clearByReply: true, threshold: 70, runs: [RUN_OK], stored: [], drawn: () => false, ...over })`. No other line of an existing test changes.

- [ ] **Step 1: Write the failing tests.**

```ts
// publish.test.ts
test('a review drawn for the audit sample is posted as a comment that ends with its paragraph, after the threads and the rule were read', async () => {
  /* onHarness({ approval: ctx({ drawn: () => true }) }): calls [readPullRequest], [listOwnReviews], [listThreads], [staleApprovals, 'main'], [publishReview, 'h1', body, 1];
     body = withPara(approvable(), para('audit_sample')); the draft has no event; approval { approved: false, code: 'audit_sample', dismissed: false }.
     The rule answering 'kept' with drawn () => true: rule_off */
});
test('the draw is asked once, last, and only when every other condition held', async () => {
  /* a drawn that counts its calls: approvable: 1. Asked 0 times for runs null (record_unreadable), not covered, a draft, an open thread,
     the rule 'kept', the rule rejecting github_403, a held review (unlisted), an adopted review */
});
test('a draw that throws or answers anything but false is an audit, never an approval', async () => {
  /* drawn throws, answers undefined, 'false', 0, null: audit_sample, no event; answers false: approved, event approve */
});
test('when GitHub refuses the comment of an audited review it is posted as today, ending with the audit paragraph', async () => {
  /* posts [REJECTED(), { id: '502' }]: the second draft is body only, with no comment and no event, and ends with para('audit_sample') */
});
// review-job.test.ts
test("with a share above 0 the job draws with the deployment's key: one drawn is posted with the audit paragraph and recorded as audit_sample, one not drawn is approved", async () => {
  /* settings { enabled: true, threads: 'strict', auditShare: 5 }, live LIVE_OK, approvable(), approving(h), h.deps.auditKey = KEY.
     Pull request 8: the draft has no event, its body ends with paragraphOf('audit_sample'); row [false, 'audit_sample']; the line approved false,
     approval 'audit_sample'; staleApprovals was read. Pull request 7: event approve; row [true, 'approved'].
     JSON.stringify of every logged entry holds neither KEY nor the hex of either identity's digest under KEY (made in the test with
     createHmac), whole or its first 8 characters */
});
test('a pull request drawn at one head is drawn at the next; a lower share or another key can let it be approved', async () => {
  /* pull request 8, share 5, KEY: drawn at h1; the job of a push to h2 (liveAt('h2')): drawn again.
     Share 4.5 with KEY: approved. Share 5 with KEY_CHANGED: approved */
});
test('without a key a share above 0 draws every pull request, and a share of 0 draws none', async () => {
  /* no auditKey, share 5, pull request 7: audit_sample; share 0 with no key and with KEY: approved */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: condition 6: a pull request drawn for the audit sample goes to a person, and its review says why`.

---

### Task 4: The audit key in the configuration, in place of the refusal

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `src/service.ts`
- Test: `src/config/load.test.ts` (one test and three constants deleted, `ENV` gains a variable, new tests), `src/service.test.ts` (`ENV` gains a variable, one new test)

**Interfaces:**

```ts
// src/config/schema.ts: configSchema gains   auditKey: secretRef.optional()
// src/config/load.ts
// DeploymentConfig gains:  auditKey?: string;   // the value of the variable auditKey names; present only when auditKey is written
// src/service.ts: reviewDeps gains            ...(config.auditKey === undefined ? {} : { auditKey: config.auditKey })
```

**Rules (6.5, 11.1, D10; calls 5, 8, 9):**

1. **Removed:** `AUDIT_NOT_DRAWN`, `auditShareIssues` and its place in `repositoryIssues`. `APPROVAL_OFF`, the keys and their merge are unchanged.
2. **Needed:** the defaults, or an override merged as `repoSettingsFor` merges it (`{ ...APPROVAL_OFF, ...defaults, ...override }`), with `enabled` true and `auditShare > 0` (`-0` is 0). Needed with no `auditKey` written is one issue, whatever the number of repositories, exactly `auditKey: must be written while autoApprove is true with an auditShare above 0`, in the error that holds the gate's issues, after them. It holds in dry run too.
3. **Written:** resolved after `database`, needed or not, each issue thrown alone as for the other secrets: the variable not set or set to `''` is `auditKey: environment variable <NAME> is not set`; a value whose `length` is below 32 is `auditKey: environment variable <NAME> must hold at least 32 characters`. The value is kept as it is, spaces included. No issue quotes it.
4. **Loaded:** `auditKey` is a key of the loaded config only when written. `repoSettingsFor`, `approvalOf` and `approvalUseOf` are unchanged.
5. **The service** hands `config.auditKey` to the review job's deps, and to nothing else.
6. **Tests changed:** in `src/config/load.test.ts` the test `automatic approval is refused while the audit share is not written as 0, for the defaults and for one repository` is deleted with `AUDIT_ISSUE`, `DEFAULTS_AUDIT` and `SHOP_AUDIT`; `ENV` (beside `SERVICE_YAML`) gains `AUDIT: 'audit-key-for-tests-only-0123456789'`. In `src/service.test.ts`, `ENV` gains `V: 'audit-key-for-tests-only-0123456789'`.

- [ ] **Step 1: Write the failing tests.**

```ts
// load.test.ts; KEY_NEEDED = 'auditKey: must be written while autoApprove is true with an auditShare above 0'
test('automatic approval with an audit share above 0 is refused without the audit key, once, for the defaults and for one repository', () => {
  /* exactly [KEY_NEEDED] for defaults { autoApprove: true }, { autoApprove: true, auditShare: 5 }, { autoApprove: true, auditShare: 37.5, approvalThreads: gate };
     an override acme/shop { autoApprove: true }; defaults { autoApprove: true, auditShare: 0 } with an override { auditShare: 5 };
     defaults { autoApprove: true } with overrides acme/shop { autoApprove: true } and acme/off { auditShare: 7 }: still one issue.
     With the gate's bad branches too: [gate issue, KEY_NEEDED]. The same with dryRun true and false.
     Accepted with no key: { autoApprove: false, auditShare: 5 }, { auditShare: 0 }, { approvalThreads: gate }, { autoApprove: true, auditShare: 0 },
     { autoApprove: true, auditShare: -0 }, each for the defaults and for an override */
});
test('the audit key is read from its variable, and refused when unset, empty or shorter than 32 characters, by name and with no value', () => {
  /* 'auditKey: { env: AUDIT }' with defaults { autoApprove: true }: c.auditKey === ENV.AUDIT; AUDIT absent and '' : exactly
     ['auditKey: environment variable AUDIT is not set']; 'k'.repeat(31): exactly ['auditKey: environment variable AUDIT must hold at least 32 characters'],
     the issue holds no run of k; 'k'.repeat(32) and ` ${'k'.repeat(32)} ` accepted, kept as written. With approval off, or no repositories block:
     still read, and refused when unset. 'auditKey: AUDIT', 'auditKey: { env: "" }', 'auditKey: { env: AUDIT, x: 1 }': each issue starts with 'auditKey'.
     dryRun true and false alike */
});
test('a config that writes no audit key has none, and gives the settings it gave', () => {
  /* minimal, SERVICE_YAML, example(): 'auditKey' in c is false; repoSettingsFor and approvalUseOf as before */
});
// service.test.ts
test('the service hands the review job the audit key the config names', async () => {
  /* as 'a push on an approved pull request withdraws its approval in its own lane', with repositoriesYaml
     'auditKey: { env: V }\nrepositories:\n  defaults: { score: { autoApprove: true, auditShare: 18.88 } }\n': pull request 7 opened, approved
     ([true, 'approved']); with auditShare 18.9: [false, 'audit_sample'] and no approval posted */
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the audit key by reference, needed while approval draws a share above 0, in place of the refusal`.

---

### Task 5: The documents, the real run, and the notes

**Files:**
- Modify: `README.md`, `config.example.yml`, `env.example`, `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built
- Create: `docs/superpowers/plans/2026-11-24-the-audit-sample-notes.md`
- Test: `src/config/load.test.ts` (one test changed, one new)

**Rules:**

1. **README.** Each sentence states only what the code does, and names its cost where it has one.
   - The status paragraph, the feature line on approval and the `## Status` rows: "refused while the audit share is not 0" goes; the row `Audit sample` becomes built, with what was tried (rule 5) and that it was not tried against GitHub.
   - `### Automatic approval (optional)`: the opening sentence says the sample instead of the refusal; the keys bullet gives `auditShare` its meaning and names `auditKey`; the bullet "The refusal" becomes "The audit key": the key, by reference, 32 characters, the three issues of Task 4 exactly, dry run and the eval commands, a key written must be set; the conditions gain step 10, `audit_sample`, and the sentence "Condition 6, the audit sample, holds because this release draws none" becomes that it is read last (call 3), with its reads; the paragraph block gains the line `audit_sample:           this pull request was drawn for the audit sample. ...` (Task 2's sentence whole); "What it costs" gains the reads of a drawn pull request; "What was tried" states this plan's run and drops the old refusal.
   - A new part `**The audit sample (condition 6).**` after "The base branch's rule": the share (calls 8, 12), the draw (call 2, its bytes and comparison as rule 1 of Task 1 and rule 4), every head, a new pull request, the share and the key changed (calls 9, 12), the paragraph (call 10), the record, the log (call 11), what the withdraw job, the gate and receiving do (call 13), what it costs (calls 3, 4), and the statement, exactly:

```sql
-- the reviews drawn for the audit sample, newest first
select id, number, head_sha, published_at from visto_ai.review_runs
where owner = 'acme' and repo = 'shop' and published and approval_code = 'audit_sample' order by id desc;
```

   - `## Configuration`: a sentence on the top-level `auditKey`. `## Repository layout`: `src/approval` names `audit.ts`, the draw.
2. **`config.example.yml`.** The line `    # auditShare must be written as 0 while autoApprove is true: this release does not draw the audit sample yet.` becomes the first three lines below, and `    #   auditShare: 0` becomes `    #   auditShare: 5`. The last block below, with a blank line after it, stands after the blank line that ends the commented `# app:` group, before `# Optional extension modules`:

```yaml
    # auditShare: of the pull requests autoApprove would approve, the percentage (0 to 100) sent to a person anyway as an audit sample,
    # drawn by a keyed hash of the pull request, so that pushing again does not draw it again; its review says it was drawn. It is 5 when
    # not written, and 0 switches the sample off. Above 0, with autoApprove true, the top-level auditKey must be written.
# The audit sample's key (see auditShare under repositories), named by reference: the secret its draw is keyed with, so that
# nobody without it can tell beforehand which pull request will be drawn. At least 32 characters, for example the output of
# openssl rand -hex 32. Required while autoApprove is true with an auditShare above 0; a key written must be set. A new key draws
# every pull request again.
# auditKey: { env: AUDIT_KEY }
```

   **Tests.** `the example with its score block switched on reads approval as written: off, strict, share 0` becomes `... off, strict, share 5`: its three `auditShare: 0` become `auditShare: 5`, and the line `'auditShare: 0'` becomes `'auditShare: 5'`. New: `the example with its audit key and its score block switched on, and autoApprove true, reads the key from its variable`: `uncomment` of `# auditKey: { env: AUDIT_KEY }` and of `    # score:`, `      autoApprove: false` replaced by `      autoApprove: true`; with `AUDIT_KEY: 'k'.repeat(64)`: the key read, approval `{ enabled: true, threads: 'strict', auditShare: 5 }`; without the variable: `auditKey: environment variable AUDIT_KEY is not set`; without the key uncommented: `KEY_NEEDED`; the shipped example holds the line `# auditKey: { env: AUDIT_KEY }` followed by an empty line.
3. **`env.example`,** after the scorer's lines:

```text
# Only if a repository has autoApprove true with an auditShare above 0 (config.local.yml's auditKey): the audit sample's key,
# at least 32 characters, for example the output of openssl rand -hex 32. A new key draws every pull request again.
# AUDIT_KEY=change-me-audit-key-of-at-least-32-characters
```

4. **The design is amended,** in the same commit, one sentence for each place this plan reads it narrowly, adds to it or departs from it:

| Section | Where | The sentence | Call |
|---|---|---|---|
| 6.4 | after the paragraph of condition 8 | Condition 6 is read last, once every other condition holds, so a pull request drawn for the audit sample is one the bot would otherwise have approved. | 3 |
| 6.5 | "It is built in the plan after automatic approval; until then automatic approval is refused unless the share is 0." | It becomes: The review of a pull request drawn says so in its last paragraph, and its decision is recorded as `audit_sample`. The hash is HMAC-SHA-256 over the service, the owner and the repository in lower case, and the number; nothing of a draw is stored, so a new key draws every pull request again. | 2, 4, 9 |
| 11.1 | after "The audit key, by reference: the secret that keys the audit draw (section 6.5)." | It is at least 32 characters, and the deployment refuses to start without it while automatic approval is on for some repository with a share above 0. | 5 |
| 18 | item 9, "and the audit sample, which is next." | It becomes: and the audit sample, which is built too. | 1 |

5. **A real run under Docker,** made by the controller after the last fix, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before.
   - **No migration:** this branch on the previous release's database (`main` at `8ea6716`): the ledger is unchanged, its last entry `0013_approval`, and the service listens; the previous release started again on it listens with a config that writes no `auditKey`, and refuses one that writes it (an unknown key).
   - **The refusals,** with `autoApprove: true` and no `auditShare`: no `auditKey` prints `config: auditKey: must be written while autoApprove is true with an auditShare above 0` and exits with 2; `auditKey: { env: AUDIT_KEY }` with the variable unset, empty, and of 31 characters, each its issue and 2; with `dryRun` true and false; no output holds the 31 characters. With `auditShare: 0` and no key: it listens.
   - **A start with the draw on:** `autoApprove: true`, the share not written, a key of 64 characters made for the run: it listens.
   - **The draw in the image:** `node --input-type=module -e` in the built image, from `/app`, importing `./src/approval/audit.ts` and printing the booleans of Task 1's vectors under `KEY` (each bracket, 0 and 100): the same as the test.
   - **Throughout,** every log line is one JSON object but the refusals' own lines, and none holds the run's key. Everything the run made is removed.
6. **No check against GitHub** ("For the owner", 3).
7. **The notes file,** in the form of the plans before: the status, the decisions taken while building, what the reviews found, what the run showed, what is for the owner, what is known and left, and what is not verified.

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 3: Commit** `docs: the audit sample in the README, the config example, the design, and the plan as built`.

---

## To verify

None of these is shown by a test of this plan.

1. **An audited review posted through the service on GitHub.** For the owner ("For the owner", 3).
2. **That `node:crypto` in the built image draws as the tests do.** Task 5, rule 5, the draw in the image.
3. **The sizes:** a share's step of 1 in 2^32, the 32 characters of a key.
