import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgliteDb } from './db/pglite.ts';
import { testDb } from './db/testing.ts';
import type { Db } from './db/types.ts';
import type { ForgeEvent, WebhookReader } from './forge/types.ts';
import { serviceConfig, parseConfig } from './config/load.ts';
import { startService } from './service.ts';
import type { Listening } from './service.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';

const config = serviceConfig(parseConfig(
  'model:\n  apiKey: { env: K }\n  model: vendor/model-a\napp:\n  webhookSecret: { env: S }\ndatabase:\n  url: { env: U }\nserver:\n  port: 9191\n', { K: 'k', S: 's', U: 'postgres://u:p@h/d' }));

const reader: WebhookReader = {
  read: () => ({ ok: true, delivery: 'd-1', name: 'ping', action: null, event: { kind: 'ping' } as ForgeEvent }),
};

function request(): RequestLike {
  return { method: 'POST', url: '/webhooks/github', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
}
function response(done: () => void): ResponseLike & { status: number | null } {
  const res = { status: null as number | null, writeHead(s: number) { res.status = s; }, end() { done(); } };
  return res;
}

function recording(db: Db, log: string[]): Db {
  return { ...db, close: async () => { log.push('db closed'); await db.close(); } };
}

test('startService migrates before it listens, on the configured port, and serves webhooks', async () => {
  const log: string[] = [];
  const db = recording(await pgliteDb(), log);
  let port = 0;
  let listener: ((req: RequestLike, res: ResponseLike) => void) | null = null;
  let tableAtListen: unknown[] = [];
  const service = await startService(config, {
    db, reader, clock: () => new Date('2026-03-01T10:00:00.000Z'), log: () => {},
    listen: async (l, p) => {
      port = p; listener = l;
      tableAtListen = await db.query("select 1 as x from information_schema.tables where table_schema = 'visto_ai' and table_name = 'deliveries'");
      return { close: async () => {} };
    },
  });
  assert.equal(port, 9191);
  assert.equal(tableAtListen.length, 1);
  await new Promise<void>((resolve) => { listener!(request(), response(resolve)); });
  assert.deepEqual(await db.query('select id from visto_ai.deliveries'), [{ id: 'd-1' }]);
  await service.stop();
});

test('stop closes the listener, then waits for a request in flight, then closes the database', async () => {
  const real = await testDb();
  const log: string[] = [];
  const db = recording(real, log);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowReader: WebhookReader = { read: () => { log.push('read'); return reader.read({}, Buffer.alloc(0)); } };
  const slowDb: Db = { ...db, transaction: async (work) => { await gate; log.push('stored'); return db.transaction(work); } };
  let listener!: (req: RequestLike, res: ResponseLike) => void;
  const service = await startService(config, {
    db: slowDb, reader: slowReader, clock: () => new Date('2026-03-01T10:00:00.000Z'), log: () => {},
    listen: async (l) => { listener = l; const l2: Listening = { close: async () => { log.push('listener closed'); } }; return l2; },
  });
  const answered = new Promise<void>((resolve) => { listener(request(), response(() => { log.push('answered'); resolve(); })); });
  await new Promise((r) => setImmediate(r));
  const stopped = service.stop().then(() => log.push('stopped'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['read', 'listener closed']);
  release();
  await answered;
  await stopped;
  assert.deepEqual(log, ['read', 'listener closed', 'stored', 'answered', 'db closed', 'stopped']);
});

test('when listen rejects startService rejects and the database is closed', async () => {
  const log: string[] = [];
  const db = recording(await testDb(), log);
  await assert.rejects(() => startService(config, {
    db, reader, clock: () => new Date(), log: () => {}, listen: () => Promise.reject(new Error('port busy')),
  }), { message: 'port busy' });
  assert.deepEqual(log, ['db closed']);
});

test('when a migration rejects startService rejects and the database is closed', async () => {
  const log: string[] = [];
  const real = await testDb();
  const db: Db = { ...recording(real, log), script: () => Promise.reject(new Error('bad sql')), transaction: () => Promise.reject(new Error('bad sql')) };
  let listened = false;
  await assert.rejects(() => startService(config, {
    db, reader, clock: () => new Date(), log: () => {}, listen: async () => { listened = true; return { close: async () => {} }; },
  }));
  assert.equal(listened, false);
  assert.deepEqual(log, ['db closed']);
});
