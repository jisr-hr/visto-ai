# Evals With Lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both evals can be shown lessons as of each case, so that what a lesson does to findings and to the score can be measured on a deployment's own history before learning is switched on. A deployment's operator exports the reviewer's findings, the replies under them and the later reviews' verdicts from its database into a file. The eval's judge makes lessons from that file night by night, by the very rules the service's nightly run follows, and keeps every answer, so a second run pays nothing. From the export, the lessons file and a history file of the same repositories, a command writes findings-replay cases with a date and labels. The replay and the backtest take `--lessons`, free counts say whether a paid run can show anything, and the two comparisons read runs with and without lessons.

**Architecture:** The night's rules leave `src/shell/judge.ts` for a pure `runNight(store, deps)` in `src/memory/night.ts`; the shell backs the store with the database, the eval with the export file. Everything new in the eval lives in `src/eval/lessons/`: the export's format and its one database read, the night-by-night simulation, the answer cache and the lessons file, and the case builder. The replay and the backtest are shown lessons through `createMemory` with a source whose `lessons(at)` reads the lessons file; the engine is not touched.

**Tech Stack:** Unchanged. Node 26, erasable TypeScript, `node:test`, zod, the in-process Postgres of `testDb()`. No new library, no migration, no config key.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 6.6 (the backtest, "as of", a case never shown its own), 7.2 and 7.3 (lessons, the nightly run and its guardrails), 7.4 (retrieval, the read-only interface the eval backs), 15 and 15.1 (the findings replay, its labels and noise), 15.3 (case files are private), 18 (item 8), 19 (nothing internal in the repository).

**Notes:** the notes file beside this plan is written when the build ends. This is the fourth and last plan of stage 8. The plans before it, `2026-11-23-memory-for-the-score.md`, `2026-11-23-lessons-from-replies.md` and `2026-11-23-reverts.md`, and their notes stand whole.

**Words used below.** *The export*: the file `eval:export-findings` writes from a deployment's database. *A night*: one 00:00 UTC; the night of day D judges replies written before D's 00:00. *The lessons file*: `lessons.json`, written by `eval:judge-replies`. *Shown a lesson*: a case whose review was handed at least one lesson. *A decisive reply*: one whose classification is `confirmed_fix`, `valid_pushback` or `invalid_pushback`. *With access*: association `owner`, `member` or `collaborator`.

## Scope

| In this plan | Left out, and why |
|---|---|
| 7.3: the night's rules made pure and shared by the service and the eval | **Reading the deployment's own lesson records** (call 3): learning is off by default, so most deployments have none |
| The export of findings, replies and later verdicts, read-only | **A switch for a lesson in the eval** (call 10) |
| 15.1: lessons made night by night from the export, every answer kept | **Signals and reverts in the replay, block scores in the replay's results** (call 11): the score is measured in the backtest |
| 15.1: dated, labelled replay cases from a deployment; the replay with lessons; `compare` | **The frozen case file with lessons** (call 12): it has no dates and predates every lesson |
| 6.6, 15.2: the backtest, `memory-count`, `score-compare` and `score-noise` with lessons | **Embedding search** (7.4): the first experiment after this plan, judged on Safety |
| The documents, a run under Docker, the measurement once the owner hands over the data | **A paid run below the floors** (call 13) |

## Not in this plan

- **Any change to the engine, the service's behaviour, the database schema or the config.** The shell's judge changes only in where its rules live (call 2).
- **A case builder for pull requests that were never merged** (call 8).
- **Any dropped idea** (call 15).

## Calls made in this plan

"(builder)" marks a call the session lead took before the plan was written, restated with its cost; every other call is the planner's. Where the design says otherwise, the call says so.

1. **(builder) One plan, ten tasks.** Nine build and check the code; the tenth is the measurement, which waits for the owner's data ("For the owner", 1 to 3). The plan can be merged before Task 10 runs. Cost: until it runs the README still says what lessons do is not measured.
2. **(builder) The night's rules move unchanged.** `runOnce` from its "Rule 1" through the reckoning of `out.complete` (`src/shell/judge.ts`, the lines under the comments Rule 1 to Rule 8 and the first lines under Rule 11: the day, the queue and its strangers, the cap, the stop and the pause, the replies with no words, the unknown finding, the call, the provider failures, the answers with no verdict, the verdict, the later review, the restatement, the record of a lesson, `more` and `end`) moves to `runNight` in `src/memory/night.ts`, over a `NightStore`. The shell keeps its reads and writes (as the store), its log lines, its learning row and its errors. The pin is `src/shell/judge.test.ts`, which passes with no edit. Cost: none known.
3. **(builder) The eval makes its own lessons.** The judge is asked again for every reply in the export, by the same code; the deployment's `memory_records` and `reply_verdicts` are not read. Learning is off unless switched on, so most deployments hold no lesson, and the question the eval answers is whether to switch it on. Cost: one judge call per reply, and one more for an answer with no verdict (cents per hundred replies); the judge does not answer as it did at night, so the eval's lessons are not a deployment's.
4. **(builder) The operator runs the export.** `eval:export-findings` is the only new code that reaches a database. It reads in one read-only transaction and writes one file, mode 600, outside the project. Nobody but the operator connects to a deployment. Cost: the measurement needs the operator's hands; the file holds finding texts and replies, which are private (15.3).
5. **What the export holds.** Every finding comment of a published run (severity not `note`), with its run's id, head, base and start; the finding's text, resolved at export by `findingBody` over that run's stored findings, so the file holds no whole run result; every inline comment that replies to it; and every published run of the pull request that kept a verdict for its thread, with its start and its publication. No login, no title, no description, no record of memory. The service's queue joins the runs with no `published` filter; the two agree because a comment is stored only once its run is published. Cost: a finding whose text cannot be told is exported with `finding: null` and is `finding_unknown` at its night, as in the service.
6. **The nights.** Every 00:00 UTC from the day after the earliest reply up to and including the 00:00 of the export's day; none when there is no reply. Each night is `runNight` over the file, with that 00:00 as its clock. A later verdict counts at a night only when its run started after the reply and was published before that 00:00. A lesson is visible from the night that made it: `madeAt <= at`, as well as `createdAt <= at < expiresAt`; `createdAt` (rule 9, the 00:00 after the reply) is never later than `madeAt`. Cost: the service runs at the first tick after 00:00, or an hour or more later after a retry or an outage, so it can see a run published in between, and a review that starts in between is shown a lesson in the eval that the service had not made yet. The service ran no night while learning was off; the eval runs them all, as if learning had been on from the first reply.
7. **A run that is not whole is kept and refused.** The simulation stops after the first night that ended for any reason but `done` or `lesson_cap`, or in which a call failed at the provider; `lessons.json` then says `complete: false`, and every consumer refuses it (`lessons_incomplete`). Every answer with a verdict, and every answer with none, is kept in `answers.jsonl`, keyed by the reply, the attempt, the model (`config.model.model`), its fallbacks, the tool choice and the sha256 of the judge's input (`JUDGE_RULES`, `JUDGE_TOOL` and the `JudgeInput`). A run answers from the kept answers first and asks only what is not kept. A failure at the provider is never kept. Cost: a changed rule, tool, finding text, reply, model, fallback or tool choice asks every affected reply again; a run cut by a failure costs a second run that pays only for the rest.
8. **Where a replay case comes from.** One case for each published run, of a pull request the history file holds, with at least one labelled finding (call 9): at the run's head, against its base, dated by its start (`review_at`), its labels those of its own findings. Title, description, branches and author come from the history case: the database keeps no description. The history case is found by repository, compared in lower case, and number. Cost: a pull request not in the history file, which holds merged ones only, has no case (`not_in_history`); a run with no base is skipped (`no_base`); a second run at a head that already made a case is skipped (`same_head`). The case is reviewed whole at the run's head, though the run itself may have been an incremental review.
9. **Labels.** The first decisive reply by a person with access, in time order, labels the finding: `valid_pushback` is `invalid`; `confirmed_fix` and `invalid_pushback` are `valid`. With no decisive reply, the newest later verdict of the thread is read, whatever its time: `fixed` is `valid`. Anything else gives no label. A label carries the finding's comment id, path, side, line and severity; no text. Cost: a label is a model's reading of a reply, not a person's; a stranger's reply labels nothing; the judge that makes lessons also makes labels, but a case is never shown a lesson of its own pull request, so it is never shown the lesson made from the reply that labelled it.
10. **No switch.** The eval cannot tell a lesson a team switched off. Cost: a lesson a team rejected in the deployment is shown in the eval, which can only make lessons look worse than they are.
11. **The replay is shown lessons alone; the score is measured in the backtest.** The replay's memory has no signals and no reverts (they are for the score), and its results hold no block scores. The backtest takes `--lessons` beside `--memory`. Cost: what a lesson does to the score is seen only on the history file's pull requests; the sketch in the reverts plan (call 1 there) had block scores in the replay, and this departs from it; the README row "the findings replay with memory" becomes "lessons in both evals".
12. **A date for a replay case.** `EvalCase` gains an optional `review_at`. A replay with `--lessons` refuses a case file in which a case has none (`case_without_date`), so the frozen case file is never run with lessons. Cost: none; its cases predate every lesson.
13. **Count first, for nothing, and floors.** `eval:lesson-cases` prints the cases shown a lesson and the `invalid` labels in them; `eval:memory-count --lessons` prints the cases shown a lesson and those of them with a labelled file. Both count with the history case's final files, which approximate the files the review is handed. A paid run is made only when the replay's count has at least 20 cases shown a lesson and 10 `invalid` labels in them, and the backtest's at least 20 and 10: starting values, as plan 11's were. `--only-shown` writes only the cases the count says would be shown a lesson. Cost: a count can be off by the files that changed between the run's head and the merge.
14. **The comparisons.** `eval:compare` stays as it is, refuses two runs that both have lessons with different `lessons_sha256` (`different_lessons`), and, only when a run has lessons, ends with a line naming each run's lessons file. `score-compare` gains a second form: a candidate with lessons against a baseline without them, both with the same memory file or none, compared on the cases the candidate was shown a lesson; the first form is unchanged. `score-noise` refuses two runs whose lessons differ (`different_lessons`). Cost: neither command can tell a lesson that changed a finding from noise on a small count; the noise between two baselines is the bar.
15. **No new library, no migration, no config key, no dropped idea.** The eval's judge uses the config's `model`, `model.toolChoice` and `model.timeoutSeconds`, as the service's night does.
16. **What is printed.** The new commands print counts, costs and short codes. No reply, finding, lesson text, quote, path or login is logged or printed, as the night's logs hold none; a file that cannot be read is named by its line number only.

## For the owner

1. **The export is his to run.** On the deployment, with its config: `npm run eval:export-findings -- --config config.yml --out <file outside the project>`. It reads and writes nothing in the database. He hands the file over, and it stays in the eval workspace, never in the repository.
2. **A history file of the deployment's repositories over the same window**, made with `eval:import-history` and the eval's read-only token: it reads his company's GitHub, so it needs his go-ahead.
3. **The paid runs** (Task 10): the judge (cents), then, above the floors only, two replay baselines and one candidate, and two backtest baselines and one candidate. Each run's cost is estimated before it starts and stays within what is left of his cap.
4. **Rulings he may want to change,** each a small change: labels from the judge's classification (call 9); lessons made again rather than read from the deployment (call 3); the score measured in the backtest only (call 11); the floors (call 13).

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task the ASCII check prints nothing: `perl -ne 'print "$ARGV:$.:$_" if /[^\x00-\x7F]/'` over the files of `src`, `contract`, `test` and `examples`.
- **No test reaches the network, a real database or a model.** A database is `testDb()`. A model is a fake `ModelClient`. A clock is passed in.
- **Private data (15.3, 19).** The export, the history file, `answers.jsonl`, `lessons.json` and the case files are read and written only outside the project (`assertOutsideProject`); the export, `answers.jsonl` and `lessons.json` are written mode 600. A file that cannot be read fails with a code that names a line number and nothing else. Every fixture is invented: `acme/shop`, `acme/web`, pull requests 7 to 12, logins `ana`, `bo`, `cy`.
- **Boundaries.** `src/memory/night.ts` imports nothing of `src/db`, `src/shell` or `src/eval` (the lint already forbids it). In `src/eval/**` only `src/eval/cli.ts`, the seed's two files and, new, `src/eval/lessons/export.ts` and `src/eval/lessons/export.test.ts` may import `src/db`: the one lint change of this plan adds those two to `evalSeed`'s list in `eslint.config.js`.
- **The engine is not touched.** Lessons reach a review only through `createMemory(source, own)` and `ReviewDeps.memory`.
- **No existing test is edited,** but for these, each named in its task with the exact change: none known. `src/shell/judge.test.ts` in particular passes unedited (call 2). An implementer who finds a test that cannot hold stops and reports it.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A lesson seen too early:** before the night that made it, from the case's own pull request, from a reply written on the case's day, or after it expired. Task 4 `a lesson is live from the night that made it until it expires, and never for its own pull request`; Task 5 `a case is never shown a lesson made from a reply on its own pull request or on its own day`.
2. **The eval's nights drift from the service's.** Task 3 `a database and its export judged night by night with the same answers give the same verdicts and the same lessons`; Task 2 keeps `src/shell/judge.test.ts` unedited.
3. **Hindsight in the night:** a later verdict from a run published after the night, a reply written after it. Task 3 `a later review counts at a night only when its run started after the reply and was published before the night`.
4. **A cut run read as whole, or a cached answer reused for another question.** Task 4 `a run that met a failure at the provider writes complete false, and every reader refuses it` and `an answer is kept by reply, attempt, setting and input, and a changed reply, attempt, model, fallback or tool choice asks again`.
5. **Private text where it must not be:** in a printed line, a log line, `summary.md`, or a file inside the project. Task 4 `nothing printed or in summary.md holds a reply, a finding, a lesson, a quote, a path or a login`; Task 1 `export-findings refuses an out path inside the project` and `the export command writes its file mode 600, refuses an existing file without force and an unmigrated database`.
6. **The export writing to a deployment.** Task 1 `the export reads in a read-only transaction and leaves every row as it was`.
7. **A history case matched wrongly:** another letter case of the repository, the same number in another repository. Task 5 `a run finds its history case by repository in lower case and number, and no other`.
8. **Two runs compared that measure something else:** different lessons files, a baseline with lessons, different memory files. Task 7 `score-compare compares lessons only between runs with the same memory, and refuses the rest`.

---

### Task 1: The export of findings and replies

**Files:**
- Create: `src/eval/lessons/findings.ts`, `src/eval/lessons/findings.test.ts`, `src/eval/lessons/export.ts`, `src/eval/lessons/export.test.ts`
- Modify: `src/eval/cli.ts` (the command `export-findings`), `src/eval/cli.test.ts` (new tests only), `package.json` (script `eval:export-findings`), `eslint.config.js` (call 4, Global Constraints)

**Interfaces:**
- Consumes, as they are: `Db`, `testDb()`; `findingBody` (`src/memory/judge.ts`); `isApplied` as the seed uses it; `recordRun`, `recordComments`, `recordActivity`, `savePullRequest` (for fixtures); `assertOutsideProject`.
- Produces:

```ts
// src/eval/lessons/findings.ts
export interface ExportedReply { id: string; order: number; association: Association | null; body: string; at: string }   // order: human_activity.id
export interface ExportedLater { run: number; started_at: string; published_at: string | null; verdict: string }
export interface ExportedFinding {
  repo: string; pr_number: number;                         // repo: owner/name as stored (lower case)
  run: { id: number; head_sha: string; base_sha: string | null; started_at: string };
  comment_id: string; path: string; side: Side; line: number | null; severity: string;
  finding: string | null;                                  // findingBody of the comment over its run's stored findings
  replies: ExportedReply[];                                // by order
  later: ExportedLater[];                                  // published runs of the pull request that kept a verdict for this thread, by run id
}
export interface FindingsFile { exported_at: string; findings: ExportedFinding[] }
export function findingsText(file: FindingsFile): string;                 // the JSONL: a header line, then one line per finding
export function parseFindings(jsonl: string): FindingsFile;               // throws bad_findings_line_<n>
export function loadFindings(path: string): { file: FindingsFile; sha256: string };
// src/eval/lessons/export.ts
export async function exportFindings(db: Db, now: Date): Promise<FindingsFile>;
/** The command's steps once connected, as seedCommand: refuses a database 0003_publishing is not applied to, exports, writes `out` mode 600, returns the one line to print. */
export async function exportCommand(db: Db, out: string, force: boolean, now: Date): Promise<string>;
```

**Rules (calls 4, 5, 16):**

1. The header line is `{"version":1,"kind":"findings_export","exported_at":"<ISO>"}`; each finding line is the `ExportedFinding` with `"version":1` first. `parseFindings` refuses a missing or second header, an unknown version, a field of the wrong type (zod, as `parseHistory` does), and names only the line.
2. `exportFindings` runs in `db.transaction`, whose first statement is `set transaction isolation level repeatable read, read only`, so its three reads see one snapshot. Findings: `review_comments` joined to their `review_runs` where `published` and `severity <> 'note'`, ordered by repository, number, run id, comment row id. Replies: `human_activity` rows of kind `inline_comment` of the same pull request whose `reply_to` is the comment's id, ordered by `id`. Later: `review_runs` of the same pull request, `published`, whose `result -> 'threadVerdicts'` holds an element with `commentId` equal to the comment's id; its `verdict`, `started_at` and `published_at`; by run id. Times as ISO strings.
3. `exportCommand` refuses a database `0003_publishing` is not applied to (`database_not_migrated`) before any read, and an existing `out` without `force` (`out_exists`); it prints `findings <n>, with replies <n>, replies <n>, pull requests <n>`. The command `export-findings --config <file> --out <file> [--force]` refuses `--out` inside the project, then reads `config.database` and connects as `seed-memory` does, and calls `exportCommand`. Its own tests reach only the usage lines: the suite blocks sockets.

- [ ] **Step 1: Write the failing tests.**

```ts
test('a findings file reads back what was written, and a bad line is named by its number only', () => { /* findingsText then parseFindings: deepEqual; a line with line: 'x' -> bad_findings_line_3, and the message holds nothing of the line */ });
test('a findings file without its header, or with two, is refused', () => { /* bad_findings_line_1; bad_findings_line_2 */ });
test('the export holds each finding of a published run with its text, its replies in order and the later verdicts of its thread', () => {
  /* testDb: acme/shop 7, run 1 published at h1 with findings [major on src/a.ts:10, note on src/b.ts:3], comments for both;
     replies by ana (member) and bo (none) to the major; run 2 published at h2 keeping { commentId: <major id>, verdict: 'open' }; run 3 not published keeping 'fixed'.
     One finding (the note is left out); its finding text is the stored finding's body; replies [ana, bo] by order with associations; later [{ run: 2, verdict: 'open' }] */
});
test('a finding whose text cannot be told is exported with finding null', () => { /* run result without findings: finding null */ });
test('the export reads in a read-only transaction and leaves every row as it was', () => {
  /* the first statement the transaction sends is set transaction isolation level repeatable read, read only (a Db over testDb that records queries); counts of every table of visto_ai before and after are equal */
});
test('the export command writes its file mode 600, refuses an existing file without force and an unmigrated database', () => {
  /* exportCommand over testDb into a temp dir outside the project: stat mode & 0o777 === 0o600; again: out_exists; with force: written; a fresh testDb with no migration: database_not_migrated */
});
test('the export command prints counts and no reply, finding, path or login', () => { /* the line matches /^findings \d+, with replies \d+, replies \d+, pull requests \d+$/ */ });
test('export-findings refuses an out path inside the project', () => { /* cli: usage: --out must be outside the project folder */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/lessons/findings.test.ts src/eval/lessons/export.test.ts src/eval/cli.test.ts`
- [ ] **Step 3: Implement** the format, the read and the command.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: an export of the reviewer's findings, the replies under them and the later verdicts of their threads, read-only`.

### Task 2: The night's rules, pure and shared

**Files:**
- Create: `src/memory/night.ts`, `src/memory/night.test.ts`
- Modify: `src/shell/judge.ts` (it runs `runNight` over a database store)

**Interfaces:**
- Consumes, as they are: `askJudge`, `lessonOf`, `restates`, `findingBody`, `JudgeInput`, `Asked`, `Outcome`, `Classification` (`src/memory/judge.ts`); `LESSON_DAYS`, `LESSONS_READ`; `dayStart`; `directoryOf`, `ownWords`; `stripControl`.
- Produces:

```ts
// src/memory/night.ts. The constants and types move here from src/shell/judge.ts, which re-exports them under the same names.
export const JUDGE_REPLIES = 100, JUDGE_STRANGERS = 20, JUDGE_ATTEMPTS = 3, LESSONS_PER_RUN = 10, JUDGE_FAILURES = 3;
export type RunEnd = 'done' | 'lesson_cap' | 'stopped' | 'spend_limit' | 'model_error' | 'auth' | 'no_credit' | 'rate_limited' | 'timeout' | 'provider';
export interface Judged { judged: number; lessons: number; givenUp: number; failed: number; calls: number; cost: number; more: boolean; end: RunEnd; complete: boolean }
export interface NightReply {
  ref: PullRequestRef; reply: string; association: Association | null; body: string; at: string;
  finding: string; path: string; side: Side; line: number | null; severity: string;
  findingText: string | null;   // the shell's store: findingBody over the stored findings; the eval's: the export's `finding`
  attempts: number;
}
export interface NightLesson { sourceRef: string; number: number; path: string; directory: string; quote: string; reply: string; text: string; createdAt: string; expiresAt: string }
export interface NightVerdict { ref: PullRequestRef; reply: string; finding: string; classification: Classification | null; outcome: Outcome; attempts: number; judgedAt: string }
export interface NightStore {
  replies(since: string, before: string, limit: number, maxAttempts: number): Promise<NightReply[]>;
  lessonsMadeSince(since: string): Promise<number>;
  laterVerdict(ref: PullRequestRef, finding: string, after: string): Promise<string | null>;
  standingLessons(repo: { service: 'github'; owner: string; repo: string }, at: string, limit: number): Promise<string[]>;
  /** The verdict, the call's usage (null: no call) and the lesson (null: none), as one unit. */
  noteVerdict(v: NightVerdict, call: Usage | null, lesson: NightLesson | null): Promise<void>;
  /** The usage of a call that failed at the provider. */
  noteCall(ref: PullRequestRef, reply: string, at: string, usage: Usage): Promise<void>;
}
export interface NightDeps {
  clock: () => Date;
  ask: (reply: NightReply, input: JudgeInput, stopped: () => boolean) => Promise<Asked>;
  paused: () => Promise<string | null>;
  noteUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number }) => void;
  stopping?: () => boolean; replies?: number;
}
export async function runNight(store: NightStore, deps: NightDeps): Promise<Judged>;
```

**Rules (call 2):**

1. `runNight` is `runOnce` from "Rule 1" through the loop's end and the `more` and `end` reckoning, with each database call replaced by its store method and `askJudge(...)` by `deps.ask(r, input, stopping)`. `lessonRecord` moves with it and returns a `NightLesson`; the shell maps it to its `NewRecord` (`kind: 'lesson'`, `category: null`, `reason: null`, `missed: false`, `excerpt: quote`, `comment: reply`, `lesson: text`).
2. The shell's `judgeOnce` keeps the early stop, the `lessons` and `lessons_failed` log lines, the learning row (`noteLearning` or `addToLearning`) and its rejection; it builds the database store from the functions it calls today (`repliesToJudge` mapped to `NightReply` with `findingText: findingBody(...)`, `lessonsMadeSince`, `laterVerdict`, `standingLessons`, `recordJudgeCall`) and an `ask` that calls `askJudge(deps.model, input, deps.token(), deps.auto, deps.timeoutMs, stopped)`. The store's `noteVerdict(v, null, null)` is one `noteVerdict` statement outside any transaction, as rule 4 and the unknown finding write today; with a call it is one transaction of `recordJudgeCall`, `noteVerdict` and, with a lesson, `addRecords` for `v.ref`'s repository, in that order. Tests of `src/shell/judge.test.ts` count those transactions.
3. No rule, constant, order, write or log changes. `src/shell/judge.test.ts` passes unedited.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/memory/night.test.ts, over an in-memory store written in the test
test('a night judges the replies its store hands it, writes each verdict with its call, and makes a lesson from a valid pushback', () => { /* one reply by ana (member), answer valid_pushback with a rule and a quote in the reply: one noteVerdict with outcome lesson and a NightLesson whose createdAt is the 00:00 after the reply and expiresAt 90 days later */ });
test('the night asks the store with its day, the 90 days before it, the queue size and the attempts', () => { /* clock 2026-03-10T00:05Z: replies('2025-12-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', 101, 3) */ });
test('the night stops at ten lessons, counting those made since its day began', () => { /* lessonsMadeSince answers 9: one lesson, end lesson_cap */ });
test('a later review that kept the finding open, and a lesson that restates a standing one, make no lesson', () => { /* outcomes review_disagreed and restates */ });
test('three failures at the provider in a row end the night with that code, and their usage is noted', () => { /* ask answers timeout three times, each with one call answered: end timeout, noteCall three times */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/memory/night.test.ts src/shell/judge.test.ts`
- [ ] **Step 3: Implement** the move.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check; `git diff --stat src/shell/judge.test.ts` prints nothing.
- [ ] **Step 5: Commit** `refactor: the night's rules of the judge are pure, in src/memory, and the service runs them over the database`.

### Task 3: The nights over an export

**Files:**
- Create: `src/eval/lessons/nights.ts`, `src/eval/lessons/nights.test.ts`
- Modify: `src/eval/lessons/export.test.ts` (one new test: the parity of the two stores)

**Interfaces:**
- Consumes: `FindingsFile`, `ExportedFinding` (Task 1); `runNight`, `NightStore`, `NightReply`, `NightDeps`, `RunEnd`, `Judged` (Task 2); `dayStart`; `LESSONS_READ`.
- Produces:

```ts
// src/eval/lessons/nights.ts
export interface SimVerdict { repo: string; number: number; reply: string; finding: string; classification: Classification | null; outcome: Outcome; attempts: number; night: string }
export interface SimLesson { ref: string; repo: string; number: number; reply: string; path: string; text: string; createdAt: string; madeAt: string; expiresAt: string }   // no quote: nothing reads it
export interface Simulated {
  complete: boolean; end: RunEnd | null;          // end: why it stopped; null when every night ended done or lesson_cap
  nights: number; first_night: string | null; last_night: string | null;
  waiting: number;                                // replies with no classification and fewer than JUDGE_ATTEMPTS attempts after the last night
  verdicts: SimVerdict[]; lessons: SimLesson[];
  judged: number; given_up: number; failed: number; calls: number; cost: number;
}
export type SimAsk = (reply: NightReply, input: JudgeInput) => Promise<Asked>;
export async function simulateNights(file: FindingsFile, ask: SimAsk, paused: () => string | null): Promise<Simulated>;
```

**Rules (calls 6, 7):**

1. Nights as call 6. Each runs `runNight` with the clock at its 00:00, `paused` wrapped as a promise, no stop, and a store over the file and the state so far.
2. The store, as the database answers: `replies` are the export's replies whose finding is not a note, written at or after `since` and before `before`, with no classification and fewer than `maxAttempts` attempts; those with access first, then by time, then by `order`; at most `limit`. `lessonsMadeSince` counts the verdicts with outcome `lesson` judged at or after `since`. `laterVerdict` is the verdict of the finding's `later` entry with the highest run id among those started after `after` and published before the night's 00:00 (a `published_at` of null counts as not published). `standingLessons` are the texts of the repository's lessons made so far that expire after `at`, newest `createdAt` first, then the later made first, at most `limit`. `noteVerdict` leaves a verdict that has a classification as it is and replaces one that has none; a lesson is kept with `madeAt` the night's 00:00. `noteCall` keeps nothing.
3. A call that fails at the provider (an `Asked` that is not ok and not `invalid_output`) marks the night. After a night that ended other than `done` or `lesson_cap`, or that was marked, the simulation stops: `complete` false, `end` the night's end, or the code of the last failure when the night ended `done` or `lesson_cap`.
4. Repositories are compared in lower case. Nothing is logged.

- [ ] **Step 1: Write the failing tests.**

```ts
test('the nights run from the day after the first reply to the day of the export', () => { /* replies on 03-01 and 03-04, exported 03-06T09:00Z: nights 03-02 to 03-06, five; no reply: zero nights, complete true */ });
test('a reply waits for the night after its day, and a reply of the export day is left waiting', () => { /* a reply at 03-06T08:00Z: waiting 1 */ });
test('a later review counts at a night only when its run started after the reply and was published before the night', () => {
  /* reply 03-02; later 'open' started and published 03-03T10:00Z: night 03-03 makes a lesson; the same reply judged at 03-04 (after an answer with no verdict at 03-03): review_disagreed;
     a later 'open' started 03-03T23:50Z and published 03-04T00:10Z: not read at night 03-04 */
});
test('the queue takes people with access first, then by time, and at most twenty strangers a night', () => { /* 25 strangers and 2 members on one day: night 1 judges the 2 members and 20 strangers, night 2 the other 5 */ });
test('ten lessons end a night and the rest wait for the next', () => { /* 12 valid pushbacks on one day: 10 lessons at night 1, 2 at night 2 */ });
test('an answer with no verdict is asked again the next night, and the third retires the reply', () => { /* outcomes unjudged, unjudged, unjudged; given_up 1 */ });
test('a failure at the provider ends the simulation after its night, incomplete, with its code', () => { /* ask answers rate_limited once at night 1: complete false, end rate_limited, nights 1 */ });
test('a spend limit stops the simulation incomplete', () => { /* paused answers spend_limit before the second call: end spend_limit */ });
// src/eval/lessons/export.test.ts
test('a database and its export judged night by night with the same answers give the same verdicts and the same lessons', () => {
  /* testDb with six replies over three days on acme/shop 7 and acme/web 8: members, one stranger, one with no words of its own, one whose finding is unknown, one that restates;
     every run is recorded and then published (the fixture of src/shell/judge.test.ts records runs it never publishes, which the export leaves out);
     every later run in the fixture is published before the night that judges the replies under it (the database holds it from the start, and the service never sees a run from the future).
     Database side: the shell's judgeOnce at each 00:00 with a fake ModelClient that answers by the reply's words. Export side: simulateNights over exportFindings of the same database,
     its ask askJudge over the same fake. The verdicts (reply, classification, outcome, attempts) and the lessons (source reference, path, text, createdAt) are equal. */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/lessons/nights.test.ts src/eval/lessons/export.test.ts`
- [ ] **Step 3: Implement** the store and the simulation.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: lessons made night by night from an export, by the service's rules`.

### Task 4: The eval's judge, its kept answers and the lessons file

**Files:**
- Create: `src/eval/lessons/answers.ts`, `src/eval/lessons/answers.test.ts`, `src/eval/lessons/lessons-file.ts`, `src/eval/lessons/lessons-file.test.ts`
- Modify: `src/eval/cli.ts` (the command `judge-replies`), `src/eval/cli.test.ts` (new tests only), `package.json` (script `eval:judge-replies`)

**Interfaces:**
- Consumes: `simulateNights`, `Simulated`, `SimLesson` (Task 3); `loadFindings` (Task 1); `askJudge`, `JUDGE_RULES`, `JUDGE_TOOL`; `createModelClient`, `loadConfig`; `LiveLesson`, `LESSONS_READ`; `createMemory`, `RecordSource`.
- Produces:

```ts
// src/eval/lessons/answers.ts
export interface JudgeSetting { model: string; fallbacks: string[]; toolChoice: 'forced' | 'auto' }   // config.model.model, config.model.fallbacks, and auto when config.model.toolChoice is 'auto'
export interface KeptAnswer { reply: string; attempt: number; setting: JudgeSetting; input_sha256: string; asked: { ok: true; value: JudgeAnswer } | { ok: false; code: 'invalid_output' }; usage: Usage }
export function judgeInputSha256(input: JudgeInput): string;   // sha256 of JSON.stringify([JUDGE_RULES, JUDGE_TOOL, input])
/** An ask that answers from the kept answers first; on a miss it calls `fresh`, keeps what it may (call 7) and appends it to `path`.
    A line of `path` that cannot be read: bad_answers_line_<n>; a last line with no line end (a run killed while writing) is dropped. */
export function keptAsk(path: string, setting: JudgeSetting, fresh: (input: JudgeInput) => Promise<Asked>): { ask: SimAsk; spent: () => number; asked: () => number };
// src/eval/lessons/lessons-file.ts
export interface LessonsFile {
  version: 1; findings_file: string; findings_sha256: string; exported_at: string; setting: JudgeSetting; rules_sha256: string;
  complete: boolean; end: string | null; nights: number; first_night: string | null; last_night: string | null; cost: number;
  verdicts: SimVerdict[]; lessons: SimLesson[];
}
export function writeLessons(dir: string, file: LessonsFile): void;            // lessons.json (mode 600) and summary.md
export function loadLessons(path: string): { file: LessonsFile; sha256: string };   // bad_lessons_file; lessons_incomplete
/** The repository's lessons live at `at`: made at or before it (madeAt and createdAt), expiring after it; newest createdAt first, then ref; at most LESSONS_READ + 1. */
export function lessonsAt(file: LessonsFile, repo: string, at: Date): LiveLesson[];
/** Memory with no records and these lessons, for one pull request: createMemory over a source whose live() is empty. */
export function lessonsMemory(file: LessonsFile, repo: string, own: number): Memory;
```

**Rules (calls 7, 15, 16):**

1. `judge-replies --findings <export> --config <file> --out <dir> [--max-cost <usd>]`: both paths outside the project; `--out` may already hold `answers.jsonl` (that is the point) and nothing in it is removed but `lessons.json` and `summary.md`, which are rewritten (removed first, as the replay removes its files). `--max-cost` defaults to 2 and counts only what this run spends. `GITHUB_TOKEN` is not needed.
2. The fresh ask is `askJudge(model, input, randomToken, config.model.toolChoice === 'auto', config.model.timeoutSeconds * 1000)` with the client `createModelClient(config.model, ...)` builds; the setting kept is `{ model: config.model.model, fallbacks: config.model.fallbacks, toolChoice }`. `paused` answers `spend_limit` once `spent() >= maxCost`.
3. `rules_sha256` is the sha256 of `JSON.stringify([JUDGE_RULES, JUDGE_TOOL])`. `summary.md` holds the counts by classification and by outcome, the nights, the cost and whether the run is whole: no text of a reply, a finding or a lesson.
4. The command prints `nights <n>, judged <n>, lessons <n>, given up <n>, waiting <n>, calls <n>, asked now <n>, cost <n>, spent now <n>`, then `stopped: <end>` when the run is not whole.
5. `loadLessons` refuses a file that is not a `LessonsFile` (`bad_lessons_file`) and one with `complete: false` (`lessons_incomplete`).

- [ ] **Step 1: Write the failing tests.**

```ts
test('an answer is kept by reply, attempt, setting and input, and a changed reply, attempt, model, fallback or tool choice asks again', () => {
  /* fresh called once for (r1, 0); a second keptAsk over the same file answers (r1, 0) without calling; another body, another attempt, another model, another fallback list, auto in place of forced: each calls fresh */
});
test('a kept-answers file with a bad line is refused by its number, and a last line cut short is dropped', () => { /* bad_answers_line_2; a file ending in half a line: read, and that answer asked again */ });
test('a failure at the provider is never kept, and an answer with no verdict is', () => { /* timeout: nothing appended; invalid_output: appended */ });
test('a second run over the same export asks nothing and writes the same lessons', () => { /* cli twice with a fake model counting calls: second run asked now 0, spent now 0, lessons.json byte for byte the same */ });
test('a run that met a failure at the provider writes complete false, and every reader refuses it', () => { /* lessons.json complete false, stopped: rate_limited printed; loadLessons -> lessons_incomplete */ });
test('the spend limit counts only what this run spends', () => { /* --max-cost 0.5 with answers of 0.25: two calls, then stopped: spend_limit */ });
test('nothing printed or in summary.md holds a reply, a finding, a lesson, a quote, a path or a login', () => { /* each fixture text absent from stdout and summary.md */ });
test('a lesson is live from the night that made it until it expires, and never for its own pull request', () => {
  /* lessonsAt at madeAt - 1 ms: none; at madeAt: one; at expiresAt: none; another repository: none; acme/SHOP: the same as acme/shop;
     lessonsMemory(file, 'acme/shop', 7).lessons(files, at) drops the lesson made on 7 */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/lessons/answers.test.ts src/eval/lessons/lessons-file.test.ts src/eval/cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the eval's judge of replies keeps every answer and writes the lessons as of each night`.

### Task 5: Dated, labelled replay cases from a deployment

**Files:**
- Create: `src/eval/lessons/cases.ts`, `src/eval/lessons/cases.test.ts`
- Modify: `src/eval/cases.ts` (`review_at`), `src/eval/cases.test.ts` (new tests only), `src/eval/cli.ts` (the command `lesson-cases`), `src/eval/cli.test.ts` (new tests only), `package.json` (script `eval:lesson-cases`)

**Interfaces:**
- Consumes: `HistoryCase`, `loadHistory`; `FindingsFile`, `loadFindings` (Task 1); `LessonsFile`, `loadLessons`, `lessonsAt` (Task 4); `lessonsFor`; `EvalCase`, `Label`, `caseKey`.
- Produces:

```ts
// src/eval/cases.ts: EvalCase gains `review_at?: string` (an ISO time), read when present and refused when it is no time.
// src/eval/lessons/cases.ts
export interface LessonCaseRow { key: string; shown: number; invalid: number; valid: number }   // shown: lessons the count says it would be shown
export interface LessonCases {
  cases: EvalCase[]; rows: LessonCaseRow[];
  skipped: { not_in_history: number; no_base: number; same_head: number };
  labels: { valid: number; invalid: number }; shown_cases: number; shown_invalid: number;
}
export function labelOf(f: ExportedFinding, verdicts: ReadonlyMap<string, SimVerdict>): 'valid' | 'invalid' | null;   // call 9
export function lessonCases(history: HistoryCase[], findings: FindingsFile, lessons: LessonsFile): LessonCases;
```

**Rules (calls 8, 9, 12, 13):**

1. `lesson-cases --history <file> --findings <export> --lessons <lessons.json> --out <cases.jsonl> [--only-shown] [--force]`: every path outside the project; the lessons file's `findings_sha256` must be the export's (`different_export`).
2. The runs are the export's findings grouped by repository, number and run id, in run id order. Only a run with at least one labelled finding is looked at; the skips then count runs, in this order: no history case (`not_in_history`), no base (`no_base`), a head that already made a case (`same_head`). A pull request held twice in the history file is read from its first case, as the backtest's memory reads it. A case's `key` is `caseKey`; its `review_round` is its 1-based place among the cases of its pull request; its `labels` are its own findings' labels in comment order.
3. A row's `shown` is `lessonsFor(<the history case's final files>, lessonsAt(lessons, repo, review_at) without its own number).lessons.length`.
4. The command writes the cases as JSONL (every case, or with `--only-shown` those whose `shown` is above 0) and prints `cases <n>, labels valid <n> invalid <n>, cases shown a lesson <n>, invalid labels in them <n>, skipped not in history <n>, no base <n>, same head <n>`, then one line `<key>: lessons <n>, invalid <n>, valid <n>` for each row.

- [ ] **Step 1: Write the failing tests.**

```ts
test('a case file reads a review_at when there is one, and refuses one that is no time', () => { /* review_at '2026-03-04T10:00:00Z' kept; 'soon' -> bad_case_line_1 */ });
test('a finding is labelled by the first decisive reply of a person with access, else by a later verdict of fixed', () => {
  /* member valid_pushback then member confirmed_fix: invalid; stranger valid_pushback then member confirmed_fix: valid; member question only: null;
     no reply, later [open, fixed]: valid; no reply, later [fixed, open]: null; member invalid_pushback: valid */
});
test('a published run of a pull request in the history file with a labelled finding is one dated case at its head', () => {
  /* head, compare_base, title, body, branch, base_branch and author from the run and the history case; review_at the run's start; labels in comment order with comment_id, path, line, side, severity */
});
test('a run finds its history case by repository in lower case and number, and no other', () => { /* export acme/shop 7, history Acme/Shop 7 and acme/web 7: the case takes Acme/Shop 7's description */ });
test('a run with no base, a second run at the same head and a pull request not in the history file make no case, and are counted', () => { /* skipped { not_in_history: 1, no_base: 1, same_head: 1 } */ });
test('a case is never shown a lesson made from a reply on its own pull request or on its own day', () => {
  /* a lesson from acme/shop 7, and one from acme/shop 8 whose reply is on the day of 7's run: 7's row shown 0; a lesson from 8 made the night before 7's run: shown 1 */
});
test('--only-shown writes only the cases the count says would be shown a lesson', () => { /* three cases, one shown: one line written; the printed counts are of all three */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/lessons/cases.test.ts src/eval/cases.test.ts src/eval/cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: dated, labelled replay cases from a deployment's findings, the judge's verdicts and a history file, after a count that needs no model`.

### Task 6: The replay with lessons

**Files:**
- Modify: `src/eval/replay.ts`, `src/eval/replay.test.ts` (new tests only), `src/eval/compare.ts`, `src/eval/compare.test.ts` (new tests only), `src/eval/cli.ts`, `src/eval/cli.test.ts` (new tests only)

**Interfaces:**
- Consumes: `lessonsMemory`, `loadLessons`, `LessonsFile` (Task 4); `EvalCase.review_at` (Task 5); `MemoryStatus`, `LessonsStatus`.
- Produces: `runReplay` gains `lessons?: { file: LessonsFile; path: string; sha256: string }`. With it, `replayCase` reviews with `{ ...deps, memory: lessonsMemory(file, c.repo, c.pr_number) }` and `asOf` `new Date(c.review_at)`; `CaseResult` gains `lessons?: LessonsStatus | null` (only in a run with lessons: `result.dependencies.memory?.lessons`, or null); `SummaryFile` gains `lessons_file?`, `lessons_sha256?`, `lessons_cases?: { ok: number; empty: number; skipped: number; error: number; none: number }`.

**Rules (calls 11, 12, 14):**

1. `replay --lessons <lessons.json>`: outside the project; refused with `--plain` (`usage: --lessons cannot be used with --plain`); refused when a case has no `review_at` (`case_without_date`), before any case starts.
2. Without `--lessons` every row, the summary and every request are what they are today.
3. `summary.md` gains one line: `Lessons: as of each case, from <file name>. Cases shown a lesson: <ok> of <cases>; with none to show: <empty>; not shown: <skipped>; failed: <error>; not asked: <none>.`
4. `compareSummaries` refuses two runs that both have a `lessons_sha256` and differ in it (`different_lessons`). Only when at least one run has lessons does it end, after the warnings, with the line `lessons: <baseline's file name or none>; <candidate's file name or none>`; without lessons its output is what it is today (`src/eval/compare.test.ts` reads the lines after the table as the warnings alone).

- [ ] **Step 1: Write the failing tests.**

```ts
test('a replay with lessons reviews each case as of its date with the lessons of other pull requests, and records how lessons did', () => {
  /* fake model recording requests; case acme/shop 7 at 03-05 with a lesson from 8 made 03-04 and one from 7: the request holds the first lesson's text and not the second; the row's lessons { status: 'ok', shown: 1 } */
});
test('a replay without lessons is what it was', () => { /* rows have no lessons key; the summary has no lessons_ key; the deps handed to review have no memory key */ });
test('a replay with lessons refuses a case without a date and the plain control', () => { /* case_without_date; usage line for --plain */ });
test('the summary counts the cases by how lessons did, and summary.md says so in one line', () => { /* ok 1, empty 1 */ });
test('compare refuses two runs of different lessons, and names each run\'s lessons file only when one has lessons', () => { /* different sha256: different_lessons; same name, different sha256: different_lessons; one with lessons: last line lessons: none; lessons.json; neither: no such line */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/replay.test.ts src/eval/compare.test.ts src/eval/cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the findings replay can be shown lessons as of each case`.

### Task 7: The backtest, the free count and the comparisons with lessons

**Files:**
- Modify: `src/eval/backtest/memory.ts`, `src/eval/backtest/memory.test.ts` (new tests only), `src/eval/backtest/run.ts`, `src/eval/backtest/run.test.ts` (new tests only), `src/eval/cli.ts`, `src/eval/cli.test.ts` (new tests only)

**Interfaces:**
- Consumes: `LessonsFile`, `lessonsAt`, `loadLessons` (Task 4); `historyMemory`, `memoryCount`, `BacktestMemory`, `BacktestSummary`.
- Produces: `historyMemory(cases, lessons?: LessonsFile)`: its `of(c)` source gains `lessons(at)` from `lessonsAt(lessons, c.repo, at)` when given. `BacktestMemory` becomes `{ of(c: HistoryCase): Memory; file?: string; sha256?: string; lessons?: { file: string; sha256: string } }`: `file` and `sha256` are `--memory`'s, absent with `--lessons` alone, and the summary's `memory_file`, `memory_sha256` and `memory_cases` are written only when they are there. A backtest row's `memory` gains `lessons` (`LessonsStatus`, absent when not asked); `BacktestSummary` gains `lessons_file?`, `lessons_sha256?`, `lessons_cases?`. `memoryCount` gains `lessons: { cases: number; with_labelled_file: number; rows: Array<{ key: string; lessons: number }> }` when lessons are given.

**Rules (calls 11, 13, 14):**

1. `backtest --lessons <lessons.json>`, with or without `--memory`: outside the project; refused with a scorer in the config (`usage: --lessons cannot be used with a scorer in the config`): with a scorer the score does not come from the model that is shown lessons. With `--lessons` alone the memory has no records: `historyMemory([], lessons)`.
2. `summary.md` gains the line of Task 6, rule 3, for lessons.
3. `memory-count --lessons <file>`, with `--memory` now optional when `--lessons` is given, prints after its other lines `lessons: cases shown a lesson <n>, with a labelled file <n>` and one line `<key>: lessons <n>` for each case shown one; a case's lessons are `lessonsFor(<its final files>, lessonsAt(..., review_at) without its own number)`.
4. `score-noise` refuses two runs whose `lessons_sha256` differ, one with lessons and one without included (`different_lessons`).
5. `score-compare`: when the candidate has lessons and the baseline has none, it requires the same `memory_sha256` or none in both (`different_memory`), prints `comparing lessons` first, and reads "shown" as the candidate rows whose `memory.lessons.status` is `ok` and "none to show" as those whose is `empty`; everything else it prints is as today. Otherwise it is as today, and a baseline with lessons is refused (`baseline_with_lessons`).

- [ ] **Step 1: Write the failing tests.**

```ts
test('a backtest case is shown the lessons live at its date, of other pull requests of its repository', () => { /* historyMemory([], lessons).of(case 7 at 03-05).lessons: the lesson of 8 made 03-04, not 7's, not one made 03-06 */ });
test('a backtest with lessons records how lessons did on each row and counts them in its summary', () => { /* rows memory.lessons; summary lessons_cases; summary.md line */ });
test('a backtest with lessons is refused with a scorer in the config', () => { /* the usage line */ });
test('memory-count with lessons counts the cases shown a lesson and those with a labelled file', () => { /* two cases, one shown with a file a person commented on: lessons: cases shown a lesson 1, with a labelled file 1 */ });
test('score-compare compares lessons only between runs with the same memory, and refuses the rest', () => {
  /* baseline no memory, candidate lessons only: comparing lessons, shown counts the ok rows; baseline memory A, candidate memory A and lessons: compared;
     baseline memory A, candidate memory B and lessons: different_memory; baseline with lessons: baseline_with_lessons;
     the existing refusals hold: different_history_files, different_contracts, different_scorers, candidate_without_memory, baseline_with_memory, and different_memory through --noise */
});
test('score-noise refuses two runs whose lessons differ', () => { /* different_lessons */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/backtest/memory.test.ts src/eval/backtest/run.test.ts src/eval/cli.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the backtest, its free count and its comparisons with lessons as of each case`.

### Task 8: The documents

**Files:**
- Modify: `docs/guide/lessons-and-reverts.md`, `docs/guide/replay.md`, `docs/guide/backtest.md`, `docs/guide/index.md`, `docs/guide/repository-layout.md`, `README.md`, `docs/superpowers/specs/2026-11-13-visto-ai-design.md`

- [ ] **Step 1: Write.**
   - `lessons-and-reverts.md`: a section `Measuring lessons`: the export and who runs it, the history file of the same window, `judge-replies` and its kept answers, `lesson-cases` and its count, the floors (call 13), the four runs, the two comparisons, and what the eval cannot show (calls 3, 9, 10, 11).
   - `replay.md`: `--lessons`, `review_at`, `lesson-cases`; the frozen file cannot be run with lessons.
   - `backtest.md`: the paragraph "It is shown no lesson" becomes how `--lessons` is shown; `memory-count --lessons`; the second form of `score-compare`; `different_lessons`.
   - `index.md` line on learning: the evals with lessons are built; what lessons do is measured only once a deployment's data is run (Task 10 says whether it was).
   - `repository-layout.md`: a row for `src/eval/lessons`; `src/memory` gains the night's rules.
   - `README.md` `## Status`: the row `Evals with lessons as of each case: ...` becomes `Evals with lessons as of each case: lessons made from a deployment's export, in the findings replay and the backtest`, built, and says plainly that it is measured only when Task 10's runs were made.
   - The design: 15, first paragraph: memory joins both evals in stage 8, lessons from a deployment's export (call 3), the replay shown lessons alone (call 11); 15.1: a bullet on lessons as of each case, the cases made from a deployment and their labels (calls 8, 9); 7.4, last paragraph: the eval also backs lessons, from a lessons file; 18, item 8: "Cut in four plans: memory for the score, lessons from replies, reverts, and the evals with lessons as of each case, all built."
- [ ] **Step 2: Run** `npm test` (the guide's tests read its files) and the ASCII check over `docs` too.
- [ ] **Step 3: Commit** `docs: lessons in both evals, the export, the judge of replies and the cases from a deployment`.

### Task 9: A run under Docker

The one boundary the tests stand in for is the real Postgres the export reads.

- [ ] **Step 1:** Start the Compose file's Postgres, migrate it by starting the service image once in dry run (as the earlier plans' runs do), and write invented rows through `src/db` helpers from a script in the scratchpad: two published runs on `acme/shop` 7 and 8 with findings, replies by `ana` (member) and `bo` (none) over three days, a later run keeping a verdict.
- [ ] **Step 2:** `eval:export-findings` against it: the counts printed, the file mode 600, every table's row count unchanged.
- [ ] **Step 3:** `eval:judge-replies` against a small model endpoint on localhost made for the run (answers `submit_verdict` from a table keyed by reply): the lessons expected, then a second run that asks nothing.
- [ ] **Step 4:** `eval:lesson-cases` with an invented history file of the two pull requests, and `eval:memory-count --lessons`: the counts expected.
- [ ] **Step 5:** Write what was tried, and what was not (the replay and the backtest read GitHub, which this run does not stub), in `docs/guide/lessons-and-reverts.md`; remove the containers, the volume and the scratch files. Commit `docs: the run of the export and the judge of replies under Docker`.

### Task 10: The measurement

Waits for "For the owner", items 1 to 3. Every file below is in the eval workspace; no number from a run goes into a commit.

- [ ] **Step 1:** `eval:judge-replies` over the owner's export. If it is not whole, run it again (it pays only for the rest).
- [ ] **Step 2:** `eval:lesson-cases --only-shown` and `eval:memory-count --lessons` with the history file. Below either floor (call 13): no paid run; go to Step 5.
- [ ] **Step 3:** Replay: two runs without lessons and one with, on the cases of Step 2; `eval:compare` of the first baseline with the candidate, `--noise` the second baseline.
- [ ] **Step 4:** Backtest: two runs without lessons and one with, the same `--memory` in all three or none; `eval:score-compare` with `--noise`.
- [ ] **Step 5:** The notes file: whether the floors were met, what was run, whether any metric left the noise band, in words. The README's row and `index.md` say whether lessons were measured. Commit `docs: what lessons did in both evals on a deployment's history`.
