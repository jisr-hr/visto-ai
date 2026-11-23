// Memory: where people stepped in on this repository before (7.4). Its fixed sizes, in one place.
// A memory hands the engine places, days, kinds and counts the service computed, never words a person wrote.
// It is an injected object and is not trusted: what it answers is read inside a guard, field by field, and each line is built anew.
import type { AuditEntry, Memory, MemoryCount, MemoryLine, MemoryStatus } from '../types.ts';
import { CATEGORIES } from '../score/types.ts';
import { inlineText } from './untrusted.ts';

export const MEMORY_TIMEOUT_MS = 5_000;
export const MEMORY_DIRECTORIES = 10;         // directories in the repository block
export const MEMORY_CATEGORIES = 8;           // categories in the repository block
export const MEMORY_MIN_PULL_REQUESTS = 2;    // a directory or a category is listed from this many pull requests
export const MEMORY_LINES = 30;               // lines in the pull request block
export const MEMORY_LINES_PER_FILE = 3;       // records on one changed file
export const MEMORY_NEAR_PER_FILE = 2;        // records near one changed file that has none
export const MEMORY_NAME = /^[A-Za-z0-9._\/\-\[\]()@+$~]{1,120}$/;   // a path or a directory that may be put in a block

// Entries of one list that are read at all: a memory never needs more than its sizes, so a longer list is a bad answer.
const MEMORY_READ = 1_000;
const SHORT_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const CODE_CHARS = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN: ReadonlySet<string> = new Set(CATEGORIES);

// The rules for memory (call 26): two texts in the code, each shown only with its block.
export const REPOSITORY_MEMORY_RULES = [
  '## Where people stepped in before',
  '',
  "The review service counted the lists below from earlier pull requests of this repository: the directories and the kinds of change where a person who was not the author commented on the code. They are the service's own counts and hold nothing a person wrote. They are context, not rules. A directory or a kind that is listed is a reason to look closely at a block there, and may be a reason that the block needs a person. Nothing here is a reason that a block needs none: a directory or a kind that is not listed tells you nothing, and no score may be lower because of this section. It says nothing about whether the code you are given is right, and it changes no finding.",
].join('\n');

export const PULL_REQUEST_MEMORY_RULES = [
  '## Where people stepped in on these files',
  '',
  'The review service wrote each line below. A line stands for one earlier pull request of this repository in which a person who was not its author commented on the code, and it holds nothing that person wrote. It has five fields with " | " between them: `changed` for a file this pull request changes, or `near` for a file near one; the file; the day; the kind of change the review had given that code, or `-`; and `missed` when the review had left that code to the bot and a person stepped in anyway, or `-`. A line says that a person had to step in there. It is a reason to look closely at a block there, and may be a reason that the block needs a person. It is never a reason that a block needs none: a file with no line is no safer for it, and no score may be lower because of this section. It is no evidence about the code you are given, and it changes no finding. Pick the band from what the change does, as the rules for the score say.',
].join('\n');

export const DIRECTORIES_LINE = 'Directories, each with its number of pull requests:';
export const CATEGORIES_LINE = 'Kinds of change, each with its number of pull requests:';

/** What a review shows of memory, checked. `lines` is never empty. */
export interface MemoryContext { directories: MemoryCount[]; categories: MemoryCount[]; lines: MemoryLine[] }

interface Asked { context: MemoryContext | undefined; status: MemoryStatus; audit: AuditEntry[] }

const audit = (action: string, subject: string, reason: string): AuditEntry => ({ stage: 'context', action, subject, reason });
const failed = (code: string): Asked =>
  ({ context: undefined, status: { status: 'error', code, lines: 0 }, audit: [audit('memory_failed', 'memory', code)] });
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// Thrown when an answer does not have the shape of one; any other throw while reading means the same.
class BadAnswer extends Error {}

// Reads a list entry by entry into one of our own: no method of the memory's object is called and no iterator of it is run.
// A hole reads as undefined, which is passed over like any other entry that is not kept.
function entries(list: unknown): unknown[] {
  if (!Array.isArray(list)) throw new BadAnswer();
  const length: unknown = (list as { length: unknown }).length;
  if (!whole(length) || length < 0 || length > MEMORY_READ) throw new BadAnswer();
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) out.push((list as unknown[])[i]);
  return out;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

// Counts kept by rule 2; `names`: directories passed over for their name.
function readCounts(list: unknown, kind: 'directory' | 'category'): { kept: MemoryCount[]; names: number } {
  const kept: MemoryCount[] = [];
  let names = 0;
  for (const entry of entries(list)) {
    const e = record(entry);
    if (e === undefined) continue;
    const name: unknown = e.name;
    const pullRequests: unknown = e.pullRequests;
    if (!whole(pullRequests) || pullRequests < MEMORY_MIN_PULL_REQUESTS || typeof name !== 'string') continue;
    if (kind === 'directory' ? !MEMORY_NAME.test(name) : !KNOWN.has(name)) {
      if (kind === 'directory') names += 1;
      continue;
    }
    kept.push({ name, pullRequests });
  }
  return { kept, names };
}

// Lines kept by rule 2, each built anew from its six fields; `names`: lines passed over for their path.
function readLines(list: unknown): { kept: MemoryLine[]; names: number } {
  const kept: MemoryLine[] = [];
  let names = 0;
  for (const entry of entries(list)) {
    const e = record(entry);
    if (e === undefined) continue;
    // Each field is read once: a getter may answer otherwise the second time.
    const ref: unknown = e.ref;
    const near: unknown = e.near;
    const path: unknown = e.path;
    const day: unknown = e.day;
    const category: unknown = e.category;
    const missed: unknown = e.missed;
    if (typeof ref !== 'string' || typeof near !== 'boolean' || typeof missed !== 'boolean') continue;
    if (typeof day !== 'string' || !DAY.test(day)) continue;
    if (category !== null && typeof category !== 'string') continue;
    const shownRef = inlineText(ref);
    if (shownRef === '') continue;
    if (typeof path !== 'string' || !MEMORY_NAME.test(path)) {
      if (typeof path === 'string') names += 1;
      continue;
    }
    kept.push({ ref: shownRef, near, path, day, category: category !== null && KNOWN.has(category) ? category : null, missed });
  }
  return { kept, names };
}

// Reads one answer. Throws when the answer cannot be read: the caller's guard makes that bad_answer.
function readAnswer(answer: unknown): Asked {
  const a = record(answer);
  if (a === undefined) throw new BadAnswer();
  const repository = record(a.repository);
  if (repository === undefined) throw new BadAnswer();
  const directories = readCounts(repository.directories, 'directory');
  const categories = readCounts(repository.categories, 'category');
  const lines = readLines(a.pullRequest);
  const cut = record(a.cut) ?? {};
  const given = (v: unknown): number => (whole(v) && v > 0 ? v : 0);
  const shown = {
    directories: directories.kept.slice(0, MEMORY_DIRECTORIES),
    categories: categories.kept.slice(0, MEMORY_CATEGORIES),
    lines: lines.kept.slice(0, MEMORY_LINES),
  };
  const cuts: Array<[string, number]> = [
    ['directories', given(cut.directories) + directories.kept.length - shown.directories.length],
    ['categories', given(cut.categories) + categories.kept.length - shown.categories.length],
    ['lines', given(cut.lines) + lines.kept.length - shown.lines.length],
    ['names', given(cut.names) + directories.names + lines.names],
  ];
  const entries = cuts.filter(([, n]) => n > 0).map(([subject, n]) => audit('memory_cut', subject, String(n)));
  if (cut.records === true) entries.push(audit('memory_cut', 'records', 'over_read_limit'));
  if (shown.lines.length === 0) return { context: undefined, status: { status: 'empty', code: 'no_records', lines: 0 }, audit: entries };
  return { context: shown, status: { status: 'ok', code: 'ok', lines: shown.lines.length }, audit: entries };
}

function codeOf(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string' && message.length <= CODE_CHARS && SHORT_CODE.test(message)) return message;
    }
  } catch {
    // an error that throws when it is read says nothing
  }
  return 'lookup_failed';
}

/** Asks once, under `timeoutMs` (absent: MEMORY_TIMEOUT_MS). Never rejects. `context` is undefined when there is nothing to show. */
export function askMemory(memory: Memory, files: Array<{ path: string; previousPath: string | null }>, asOf: Date, timeoutMs?: number):
  Promise<{ context: MemoryContext | undefined; status: MemoryStatus; audit: AuditEntry[] }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let done = false;
    const finish = (read: () => Asked): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let out: Asked;
      try {
        out = read();
      } catch {
        out = failed('bad_answer');
      }
      resolve(out);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => failed('timeout'));
    }, timeoutMs ?? MEMORY_TIMEOUT_MS);
    timer.unref?.();
    // The memory is given a copy: nothing it does to the list reaches the review.
    const given = files.map((f) => ({ path: f.path, previousPath: f.previousPath }));
    // A promise of our own: what the memory returns is only ever resolved into it, so a hostile
    // thenable, or a throw before any promise is returned, is a rejection here and never a throw.
    const pending = new Promise<unknown>((settle, refuse) => {
      try {
        settle(memory.blocks(given, asOf, controller.signal));
      } catch (error) {
        refuse(error);
      }
    });
    pending.then(
      (answer) => finish(() => readAnswer(answer)),
      (error) => finish(() => failed(codeOf(error))),
    );
  });
}

const countLines = (heading: string, counts: MemoryCount[]): string[] =>
  counts.length === 0 ? [] : ['', heading, ...counts.map((c) => `- ${c.name}: ${c.pullRequests}`)];

/** The two parts as the model is shown them. `repository` is '' when both lists are empty. Neither holds a token. */
export function memoryParts(context: MemoryContext): { repository: string; pullRequest: string } {
  const { directories, categories, lines } = context;
  const repository = directories.length === 0 && categories.length === 0
    ? ''
    : [REPOSITORY_MEMORY_RULES, ...countLines(DIRECTORIES_LINE, directories), ...countLines(CATEGORIES_LINE, categories)].join('\n');
  // Every character of a line is the service's own or passed MEMORY_NAME: no data marker is needed.
  const shown = lines.map((l) => [l.near ? 'near' : 'changed', l.path, l.day, l.category ?? '-', l.missed ? 'missed' : '-'].join(' | '));
  return { repository, pullRequest: [PULL_REQUEST_MEMORY_RULES, '', ...shown].join('\n') };
}
