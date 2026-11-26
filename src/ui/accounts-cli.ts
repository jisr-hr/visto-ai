// The command for the first admin and the way back in (the password design 4.6; calls 9 and 23): `npm run accounts --
// <make|reset|github> --config <path> ...`, run where the service runs. It reads the config with the service's own loadConfig
// and uses only database.url, and whether GitHub sign-in is on (`github` is refused while it is off); it never migrates and
// refuses a database without 0015_accounts. A name of `make` and `reset` is lower-cased and checked before anything is read.
// Its changes go through createAccountChanges as the command, recorded as `command`. It writes no log line: its database has a
// no-op log, and so do the changes. The one-time password is printed once, on its own line, and nothing else secret is printed.
import { ConfigError, githubSignInOn, loadConfig } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { isApplied } from '../db/migrate.ts';
import { postgresDb } from '../db/postgres.ts';
import type { Db } from '../db/types.ts';
import type { Role } from '../db/ui-accounts.ts';
import { codeOf } from '../shell/codes.ts';
import { createAccountChanges } from './accounts.ts';
import type { Actor } from './accounts.ts';
import { NAME } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

export type Command =
  | { kind: 'make'; config: string; name: string; role: Role }
  | { kind: 'reset'; config: string; name: string }
  | { kind: 'github'; config: string; login: string; role: Role };

const USAGE = 'usage: accounts make --config <path> --name <name> --role <admin|viewer> | reset --config <path> --name <name> | github --config <path> --login <login> --role <admin|viewer>';
const NO_DATABASE = 'usage: accounts needs a database in the config';
const GITHUB_OFF = 'github sign-in is off';
/** The options each command takes, each exactly once. */
const OPTIONS: Record<Command['kind'], string[]> = { make: ['config', 'name', 'role'], reset: ['config', 'name'], github: ['config', 'login', 'role'] };
const COMMAND: Actor = { by: 'command' };

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function roleOf(value: string | undefined): Role {
  if (value === 'admin' || value === 'viewer') return value;
  throw new UsageError(USAGE);
}

/** The arguments; a usage error throws UsageError (its message the usage line). */
export function parseArgs(argv: string[]): Command {
  const [kind, ...rest] = argv;
  if (kind !== 'make' && kind !== 'reset' && kind !== 'github') throw new UsageError(USAGE);
  const allowed = OPTIONS[kind];
  const given = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const option = rest[i]!;
    const value = rest[i + 1];
    const name = option.startsWith('--') ? option.slice(2) : '';
    // A positional, an option of another command or none, one given twice, or one with no value (or another option as its value).
    if (!allowed.includes(name) || given.has(name) || value === undefined || value.startsWith('--')) throw new UsageError(USAGE);
    given.set(name, value);
  }
  const get = (name: string): string => {
    const value = given.get(name);
    if (value === undefined) throw new UsageError(USAGE);
    return value;
  };
  const config = get('config');
  if (kind === 'github') {
    const login = get('login');
    return { kind, config, login, role: roleOf(given.get('role')) };
  }
  const name = get('name');
  return kind === 'make' ? { kind, config, name, role: roleOf(given.get('role')) } : { kind, config, name };
}

/** make's and reset's name lower-cased; one that is then not of a password account's shape throws UsageError (a login is left as written). */
export function nameChecked(command: Command): Command {
  if (command.kind === 'github') return command;
  const name = command.name.toLowerCase();
  if (!NAME.test(name)) throw new UsageError(USAGE);
  return { ...command, name };
}

/** One command on a database that has 0015_accounts; the lines go to `out`. The exit code. */
export async function runCommand(command: Command, deps: { db: Db; clock: () => Date; out: (line: string) => void; cost?: PasswordCost }): Promise<number> {
  const { out } = deps;
  try {
    if (!(await isApplied(deps.db, '0015_accounts'))) {
      out('not_migrated');
      return 1;
    }
    const changes = createAccountChanges({ db: deps.db, clock: deps.clock, log: () => {}, cost: deps.cost });
    if (command.kind === 'github') {
      const set = await changes.setRole(COMMAND, { github: command.login }, command.role);
      if (typeof set === 'string') {
        out(set);
        return 1;
      }
      out(set.made ? `made the GitHub account ${command.login} (${command.role})`
        : set.changed ? `set the GitHub account ${command.login} to ${command.role}`
          : `the GitHub account ${command.login} is ${command.role} already`);
      return 0;
    }
    const made = command.kind === 'make'
      ? await changes.make(COMMAND, command.name, command.role)
      : await changes.reset(COMMAND, { name: command.name });
    if (typeof made === 'string') {
      out(made);
      return 1;
    }
    out(command.kind === 'make' ? `made ${command.name} (${command.role})` : `reset ${command.name}`);
    out(`one-time password: ${made.oneTimePassword}`);
    out(`expires at ${made.expiresAt}`);
    return 0;
  } catch (error) {
    // A failure is its short code alone, never its message.
    out(codeOf(error));
    return 1;
  }
}

/** A config file that cannot be read is a usage error; one that is read but refused is a ConfigError. */
function readConfig(path: string, env: Record<string, string | undefined>): DeploymentConfig {
  try {
    return loadConfig(path, env);
  } catch (error) {
    const fileError = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && typeof (error as NodeJS.ErrnoException).syscall === 'string';
    if (fileError) throw new UsageError('usage: cannot read --config');
    throw error;
  }
}

/**
 * Reads the config with loadConfig, opens postgresDb(database.url, () => {}) (a no-op log: the command writes no log line), runs, closes.
 * `github` while GitHub sign-in is off is refused on `err` before anything is opened.
 */
export async function main(
  argv: string[], env: Record<string, string | undefined>, out: (line: string) => void,
  err: (line: string) => void = (line) => { process.stderr.write(line + '\n'); },
): Promise<number> {
  let command: Command;
  let url: string;
  try {
    command = nameChecked(parseArgs(argv));
    const config = readConfig(command.config, env);
    // A GitHub account made while GitHub sign-in is off could never sign in, and as an admin it would count toward the last admin.
    if (command.kind === 'github' && (config.ui === undefined || !githubSignInOn(config.ui))) {
      err(GITHUB_OFF);
      return 1;
    }
    if (config.database === null) throw new UsageError(NO_DATABASE);
    url = config.database.url;
  } catch (error) {
    if (error instanceof UsageError) {
      out(error.message);
      return 2;
    }
    // Issues name keys and variables, never values.
    if (error instanceof ConfigError) {
      for (const issue of error.issues) out(`config: ${issue}`);
      return 2;
    }
    out(codeOf(error));
    return 1;
  }
  // The pool's own database_error lines go nowhere: nothing reaches stdout or stderr but the command's lines.
  const db = postgresDb(url, () => {});
  try {
    // The close after a run is not tested in the suite, which opens no database here: the run under Docker checks it.
    return await runCommand(command, { db, clock: () => new Date(), out });
  } finally {
    try {
      await db.close();
    } catch {
      // a close that fails changes nothing of what was written
    }
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) => { process.stdout.write(line + '\n'); }, (line) => { process.stderr.write(line + '\n'); });
}
