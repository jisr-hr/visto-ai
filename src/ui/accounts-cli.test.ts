import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, parseConfig } from '../config/load.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from '../db/migrate.ts';
import { pgliteDb } from '../db/pglite.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { countAccounts, MAX_ACCOUNTS, passwordAccount } from '../db/ui-accounts.ts';
import { createSession } from '../db/ui-sessions.ts';
import { main, parseArgs, runCommand } from './accounts-cli.ts';
import { verifyPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

const at = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();
// Call 4: every hash of these tests is made at COST.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
/** 20 characters of the alphabet of call 12, written out here apart from the code. */
const ONE_TIME_LINE = /^one-time password: ([23456789abcdefghjkmnpqrstuvwxyz]{20})$/;
const USAGE = 'usage: accounts make --config <path> --name <name> --role <admin|viewer> | reset --config <path> --name <name> | github --config <path> --login <login> --role <admin|viewer>';
/** The config the parsed commands name; runCommand never reads it. */
const CONFIG = 'config.yml';

/** Every line a command printed, in every test of this file, for the last test to read. */
const printedLines: string[] = [];
/** Every chunk written to stdout or stderr while a command ran, as text: the test runner's own reports are among them. */
const written: string[] = [];

/** Runs `work` with stdout and stderr watched; each chunk still reaches its stream. */
async function watched<T>(work: () => Promise<T>): Promise<T> {
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((stream) => stream.write);
  streams.forEach((stream, i) => {
    stream.write = function write(chunk: unknown, ...rest: unknown[]): boolean {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return (originals[i] as (...args: unknown[]) => boolean).apply(stream, [chunk, ...rest]);
    } as typeof stream.write;
  });
  try {
    return await work();
  } finally {
    streams.forEach((stream, i) => { stream.write = originals[i]!; });
  }
}

/** One command as it is typed, after `npm run accounts --`, on `db` at `now`. */
async function run(db: Db, argv: string[], now = at(0)): Promise<[number, string[]]> {
  const lines: string[] = [];
  const code = await watched(() => runCommand(parseArgs(argv), { db, clock: () => now, out: (line) => lines.push(line), cost: COST }));
  printedLines.push(...lines);
  return [code, lines];
}
const make = (name: string, role: string): string[] => ['make', '--config', CONFIG, '--name', name, '--role', role];
const reset = (name: string): string[] => ['reset', '--config', CONFIG, '--name', name];
const github = (login: string, role: string): string[] => ['github', '--config', CONFIG, '--login', login, '--role', role];

async function runMain(argv: string[], env: Record<string, string | undefined> = {}): Promise<[number, string[]]> {
  const lines: string[] = [];
  const code = await watched(() => main(argv, env, (line) => lines.push(line)));
  printedLines.push(...lines);
  return [code, lines];
}

/** The one-time password of the second line, which must be one. */
function oneTimeOf(lines: string[]): string {
  const match = ONE_TIME_LINE.exec(lines[1] ?? '');
  assert.ok(match !== null, String(lines[1]));
  return match[1]!;
}

const records = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ at: Date }>('select at, by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by id'))
    .map((r) => ({ ...r, at: r.at.toISOString() }));
const record = (seconds: number, change: string, kind: string, name: string, role: string | null): unknown =>
  ({ at: iso(seconds), by_kind: 'command', by_name: null, change, account_kind: kind, account_name: name, role });
/** Every row of the three tables, as text: what a command could have written. */
const everything = async (db: Db): Promise<string> => JSON.stringify([
  await db.query('select * from visto_ai.ui_accounts order by id'),
  await db.query('select * from visto_ai.ui_account_changes order by id'),
  await db.query('select * from visto_ai.ui_sessions order by id_hash'),
]);

test('make prints the one-time password once, with the name, the role and when it expires, and exits 0', async () => {
  const db = await testDb();
  const [code, lines] = await run(db, make('octo-admin', 'admin'));
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0], lines[2]], ['made octo-admin (admin)', 'expires at 2026-03-04T10:00:00.000Z']);
  const oneTime = oneTimeOf(lines);

  const row = await passwordAccount(db, 'octo-admin');
  assert.ok(row !== null && row.password_hash !== null);
  assert.equal(await verifyPassword(oneTime, row.password_hash), true);
  // Made at the cost it was given.
  assert.ok(row.password_hash.startsWith('scrypt$4$1$1$'));
  assert.deepEqual([row.kind, row.role, row.one_time_until?.toISOString(), row.made_by_kind, row.made_by_name], ['password', 'admin', iso(259200), 'command', null]);
  assert.deepEqual(await records(db), [record(0, 'made', 'password', 'octo-admin', 'admin')]);
  await db.close();
});

test("reset prints a new one-time password, and github sets a login's role, making its row", async () => {
  const db = await testDb();
  const [, madeLines] = await run(db, make('octo-admin', 'admin'));
  const first = oneTimeOf(madeLines);
  const row = await passwordAccount(db, 'octo-admin');
  assert.ok(row !== null);
  await createSession(db, { idHash: 'h-admin', login: 'octo-admin', via: 'password', accountId: row.id, at: iso(0), expiresAt: iso(43200) });

  const [code, lines] = await run(db, reset('octo-admin'), at(10));
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0], lines[2]], ['reset octo-admin', `expires at ${iso(10 + 259200)}`]);
  const second = oneTimeOf(lines);
  assert.notEqual(second, first);
  const after = await passwordAccount(db, 'octo-admin');
  assert.ok(after !== null && after.password_hash !== null);
  assert.equal(await verifyPassword(second, after.password_hash), true);
  assert.equal(await verifyPassword(first, after.password_hash), false);
  assert.deepEqual(await db.query('select id_hash from visto_ai.ui_sessions where account_id = $1', [row.id]), []);

  assert.deepEqual(await run(db, github('octo-dev', 'viewer'), at(20)), [0, ['made the GitHub account octo-dev (viewer)']]);
  const dev = await db.query<{ kind: string; name: string; role: string; made_by_kind: string }>(
    "select kind, name, role, made_by_kind from visto_ai.ui_accounts where kind = 'github'");
  assert.deepEqual(dev, [{ kind: 'github', name: 'octo-dev', role: 'viewer', made_by_kind: 'command' }]);
  const three = await records(db);
  assert.equal(three.length, 3);

  // The role it has already: said so, and nothing recorded.
  assert.deepEqual(await run(db, github('octo-dev', 'viewer'), at(30)), [0, ['the GitHub account octo-dev is viewer already']]);
  assert.deepEqual(await records(db), three);

  assert.deepEqual(await run(db, github('octo-dev', 'admin'), at(40)), [0, ['set the GitHub account octo-dev to admin']]);
  assert.deepEqual(await records(db), [
    record(0, 'made', 'password', 'octo-admin', 'admin'),
    record(10, 'reset', 'password', 'octo-admin', 'admin'),
    record(20, 'made', 'github', 'octo-dev', 'viewer'),
    record(40, 'role', 'github', 'octo-dev', 'admin'),
  ]);
  await db.close();
});

test('the command refuses to leave no admin, a name taken, a name of another shape, an unknown account and a full table, with their codes and exit 1', async () => {
  const db = await testDb();
  assert.deepEqual(await run(db, github('octo-lead', 'admin')), [0, ['made the GitHub account octo-lead (admin)']]);
  let before = await everything(db);
  assert.deepEqual(await run(db, github('octo-lead', 'viewer'), at(10)), [1, ['last_admin']]);
  assert.equal(await everything(db), before);

  // An admin who has not chosen a password does not count: octo-lead is still the last.
  assert.equal((await run(db, make('octo-admin', 'admin'), at(20)))[0], 0);
  before = await everything(db);
  assert.deepEqual(await run(db, github('octo-lead', 'viewer'), at(30)), [1, ['last_admin']]);
  assert.deepEqual(await run(db, make('octo-admin', 'viewer'), at(30)), [1, ['name_taken']]);
  assert.deepEqual(await run(db, make('Octo', 'viewer'), at(30)), [1, ['bad_name']]);
  assert.deepEqual(await run(db, reset('octo-nobody'), at(30)), [1, ['not_found']]);
  assert.deepEqual(await run(db, github('octo_lead', 'viewer'), at(30)), [1, ['bad_login']]);
  assert.equal(await everything(db), before);

  // 1,000 accounts of both kinds: neither a password account nor a GitHub row is made.
  await db.query(
    `insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind)
     select 'github', 'octo-user-' || g::text, 'viewer', $1::timestamptz, 'sign_in' from generate_series(1, 998) g`, [iso(0)]);
  assert.equal(await countAccounts(db), MAX_ACCOUNTS);
  before = await everything(db);
  assert.deepEqual(await run(db, make('octo-new', 'viewer'), at(40)), [1, ['full']]);
  assert.deepEqual(await run(db, github('octo-dev', 'viewer'), at(40)), [1, ['full']]);
  assert.equal(await everything(db), before);
  await db.close();
});

test('arguments that are missing, unknown or repeated are a usage error with exit 2, and nothing is opened', async () => {
  // Read, the file would answer `usage: cannot read --config`.
  const missing = join(tmpdir(), 'visto-ai-no-such-dir', 'missing.yml');
  assert.deepEqual(parseArgs(['make', '--role', 'admin', '--name', 'octo-admin', '--config', missing]),
    { kind: 'make', config: missing, name: 'octo-admin', role: 'admin' });
  assert.deepEqual(parseArgs(['reset', '--name', 'octo-admin', '--config', missing]), { kind: 'reset', config: missing, name: 'octo-admin' });
  assert.deepEqual(parseArgs(['github', '--login', 'octo-lead', '--role', 'viewer', '--config', missing]),
    { kind: 'github', config: missing, login: 'octo-lead', role: 'viewer' });

  const bad: Array<[string, string[]]> = [
    ['no arguments', []],
    ['make alone', ['make']],
    ['make without --role', ['make', '--config', missing, '--name', 'octo-admin']],
    ['a role of another name', ['make', '--config', missing, '--name', 'octo-admin', '--role', 'owner']],
    ['--name twice', ['make', '--config', missing, '--name', 'octo-admin', '--name', 'octo-new', '--role', 'admin']],
    ['an extra positional', ['make', '--config', missing, '--name', 'octo-admin', '--role', 'admin', 'octo-new']],
    ['an unknown option', ['make', '--config', missing, '--name', 'octo-admin', '--role', 'admin', '--force', 'yes']],
    ['reset with --role', ['reset', '--config', missing, '--name', 'octo-admin', '--role', 'admin']],
    ['github with --name', ['github', '--config', missing, '--name', 'octo-lead', '--role', 'admin']],
    ['an option with no value', ['make', '--config', missing, '--name', 'octo-admin', '--role']],
    ['an option as a value', ['make', '--config', missing, '--name', '--role', 'admin']],
    ['an option written with =', ['make', '--config', missing, '--name=octo-admin', '--role', 'admin']],
    ['another command', ['remove', '--config', missing, '--name', 'octo-admin']],
    ['the command after an option', ['--config', missing, 'make', '--name', 'octo-admin', '--role', 'admin']],
  ];
  for (const [what, argv] of bad) {
    assert.throws(() => parseArgs(argv), { name: 'UsageError', message: USAGE }, what);
    assert.deepEqual(await runMain(argv), [2, [USAGE]], what);
  }
});

test('a database not migrated to 0015 is refused as not_migrated and nothing is written', async () => {
  const db = await pgliteDb();
  await migrate(db, loadMigrations(MIGRATIONS_DIR).filter((m) => m.name < '0015_accounts'));
  const statements: string[] = [];
  const spy: Db = {
    query: (text, params) => { statements.push(text); return db.query(text, params); },
    script: (sql) => { statements.push(sql); return db.script(sql); },
    transaction: (work) => { statements.push('transaction'); return db.transaction(work); },
    close: () => db.close(),
  };
  const ledger = async (): Promise<unknown[]> => db.query('select name from visto_ai.schema_migrations order by name');
  const before = await ledger();
  for (const argv of [make('octo-admin', 'admin'), reset('octo-admin'), github('octo-lead', 'admin')]) {
    assert.deepEqual(await run(spy, argv), [1, ['not_migrated']], argv.join(' '));
  }
  // Only the two reads of the ledger, each time.
  assert.equal(statements.length, 6);
  for (const text of statements) assert.match(text, /^select /);
  assert.deepEqual(await ledger(), before);
  assert.deepEqual(await db.query("select to_regclass('visto_ai.ui_accounts')::text as t"), [{ t: null }]);
  await db.close();

  // A database with no ledger at all.
  const bare = await pgliteDb();
  assert.deepEqual(await run(bare, make('octo-admin', 'admin')), [1, ['not_migrated']]);
  assert.deepEqual(await bare.query("select to_regclass('visto_ai.schema_migrations')::text as t"), [{ t: null }]);
  await bare.close();
});

test('a config that cannot be read, or refused, or without a database, is a usage error', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'visto-ai-accounts-'));
  try {
    const args = (config: string): string[] => ['make', '--config', config, '--name', 'octo-admin', '--role', 'admin'];
    assert.deepEqual(await runMain(args(join(folder, 'missing.yml'))), [2, ['usage: cannot read --config']]);
    assert.deepEqual(await runMain(args(folder)), [2, ['usage: cannot read --config']]);

    const env = { MODEL_KEY: 'model-secret-value', DB_URL: 'postgres://user:db-password-value@db.invalid/visto' };
    const issuesOf = (text: string, values: Record<string, string | undefined>): string[] => {
      try {
        parseConfig(text, values);
      } catch (error) {
        if (error instanceof ConfigError) return error.issues;
      }
      return assert.fail('a ConfigError');
    };
    const model = 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n';
    const refused: Array<[string, string, Record<string, string | undefined>]> = [
      ['an unknown key', `${model}extra: 1\n`, env],
      ['a database whose variable is not set', `${model}database:\n  url: { env: DB_URL }\n`, { MODEL_KEY: env.MODEL_KEY }],
      ['a database that is not a postgres URL', `${model}database:\n  url: { env: DB_URL }\n`, { ...env, DB_URL: 'mysql://user:db-password-value@db.invalid/visto' }],
      ['a model key not set', `${model}database:\n  url: { env: DB_URL }\n`, { DB_URL: env.DB_URL }],
    ];
    for (const [what, text, values] of refused) {
      const file = join(folder, 'refused.yml');
      writeFileSync(file, text);
      const issues = issuesOf(text, values);
      assert.ok(issues.length > 0, what);
      const [code, lines] = await runMain(args(file), values);
      assert.deepEqual([code, lines], [2, issues.map((issue) => `config: ${issue}`)], what);
      for (const line of lines) for (const value of Object.values(values)) assert.ok(value === undefined || !line.includes(value), what);
    }
    assert.ok(issuesOf(`${model}extra: 1\n`, env)[0]!.includes('extra'));

    const file = join(folder, 'no-database.yml');
    writeFileSync(file, model);
    assert.deepEqual(await runMain(args(file), env), [2, ['usage: accounts needs a database in the config']]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a database step that fails prints its short code or internal_error, and no one-time password, with exit 1', async () => {
  const db = await testDb();
  const failing: { text: string | null; error: Error } = { text: null, error: new Error('db_down') };
  const spy = (inner: Db): Db => ({
    query: (text, params) => (failing.text !== null && text.includes(failing.text) ? Promise.reject(failing.error) : inner.query(text, params)),
    script: (sql) => inner.script(sql),
    transaction: (work) => inner.transaction((tx) => work(spy(tx))),
    close: () => inner.close(),
  });
  const [, madeLines] = await run(db, make('octo-admin', 'admin'));
  const first = oneTimeOf(madeLines);
  const before = await everything(db);

  failing.text = 'update visto_ai.ui_accounts set password_hash = $2';
  assert.deepEqual(await run(spy(db), reset('octo-admin'), at(10)), [1, ['db_down']]);
  failing.error = new Error('relation "visto_ai.ui_accounts" does not exist');
  assert.deepEqual(await run(spy(db), reset('octo-admin'), at(10)), [1, ['internal_error']]);
  failing.text = 'insert into visto_ai.ui_accounts (';
  assert.deepEqual(await run(spy(db), make('octo-new', 'viewer'), at(10)), [1, ['internal_error']]);
  failing.text = 'schema_migrations';
  failing.error = new Error('db_down');
  assert.deepEqual(await run(spy(db), github('octo-lead', 'admin'), at(10)), [1, ['db_down']]);
  // Rolled back: the first one-time password still holds, and nothing was recorded.
  assert.equal(await everything(db), before);
  const row = await passwordAccount(db, 'octo-admin');
  assert.ok(row !== null && row.password_hash !== null);
  assert.equal(await verifyPassword(first, row.password_hash), true);
  await db.close();
});

test("no line but the one-time password's holds a secret, and the command logs nothing", async () => {
  // The command's own run, then every line of the tests above.
  const db = await testDb();
  const [, made] = await run(db, make('octo-admin', 'admin'));
  const [, again] = await run(db, reset('octo-admin'), at(10));
  assert.deepEqual(await run(db, github('octo-lead', 'admin'), at(20)), [0, ['made the GitHub account octo-lead (admin)']]);
  assert.deepEqual(await run(db, make('octo-admin', 'viewer'), at(30)), [1, ['name_taken']]);
  assert.deepEqual(await runMain(['make']), [2, [USAGE]]);
  const hashes = (await db.query<{ password_hash: string }>('select password_hash from visto_ai.ui_accounts where password_hash is not null')).map((r) => r.password_hash);
  await db.close();

  const oneTimes = printedLines.flatMap((line) => ONE_TIME_LINE.exec(line)?.[1] ?? []);
  assert.ok(oneTimes.includes(oneTimeOf(made)) && oneTimes.includes(oneTimeOf(again)));
  for (const line of printedLines) {
    assert.ok(!line.includes('scrypt$'), line);
    for (const hash of hashes) assert.ok(!line.includes(hash), line);
  }
  for (const oneTime of oneTimes) assert.deepEqual(printedLines.filter((line) => line.includes(oneTime)), [`one-time password: ${oneTime}`]);

  // Nothing the command wrote reached stdout or stderr: no line of its own, no log line, no secret.
  // A line of its own holds a space; a code alone may also be a word of a test's name, which the runner reports.
  const own = printedLines.filter((line) => line.includes(' '));
  assert.ok(own.length > 0);
  for (const chunk of written) {
    for (const needle of ['scrypt$', '"event"', ...oneTimes, ...hashes, ...own]) assert.ok(!chunk.includes(needle), needle);
  }
});
