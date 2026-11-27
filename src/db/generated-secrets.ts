import type { Db } from './types.ts';

/**
 * The audit key the service keeps in its database: `fresh()` is stored, made at `at`, when none is yet, and the one stored is
 * returned either way, so two starts at once keep the same. Its value is in no log line, error or answer.
 */
export async function storedAuditKey(db: Db, fresh: () => string, at: string): Promise<string> {
  await db.query(
    `insert into visto_ai.generated_secrets (name, value, created_at) values ('audit_key', $1, $2::timestamptz)
     on conflict (name) do nothing`,
    [fresh(), at]);
  const rows = await db.query<{ value: string }>("select value from visto_ai.generated_secrets where name = 'audit_key'");
  if (rows[0] === undefined) throw new Error('audit_key_missing');
  return rows[0].value;
}
