import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';

export type SampleKind = 'pull_request' | 'review' | 'comment';

const KINDS: SampleKind[] = ['pull_request', 'review', 'comment'];
const T = '2026-03-01T10:00:00Z';
const repository = { name: 'shop', owner: { login: 'acme' } };
const user = { login: 'octo-dev', type: 'User' };

function payloadOf(kind: SampleKind): { event: string; payload: unknown } {
  switch (kind) {
    case 'pull_request':
      return {
        event: 'pull_request',
        payload: {
          action: 'opened', number: 7, repository, installation: { id: 99 },
          pull_request: {
            user, base: { ref: 'main' }, head: { ref: 'feat', sha: 'abc123' }, draft: false,
            state: 'open', merged: false, merged_at: null, closed_at: null, merge_commit_sha: null, updated_at: T,
          },
        },
      };
    case 'review':
      return {
        event: 'pull_request_review',
        payload: {
          action: 'submitted', repository, pull_request: { number: 7 },
          review: { id: 11, user, author_association: 'MEMBER', state: 'approved', commit_id: 'abc123', submitted_at: T, body: 'Looks fine.' },
        },
      };
    case 'comment':
      return {
        event: 'issue_comment',
        payload: {
          action: 'created', repository, issue: { number: 7, pull_request: {} },
          comment: { id: 31, user, author_association: 'OWNER', created_at: T, body: 'Thanks for the change.' },
        },
      };
  }
}

/** An invented, signed webhook: the headers to send and the body. */
export function sampleWebhook(kind: SampleKind, secret: string, delivery: string): { headers: Record<string, string>; body: string } {
  const { event, payload } = payloadOf(kind);
  const body = JSON.stringify(payload);
  return {
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
  };
}

/** true for http URLs with no user or password whose host is localhost, 127.0.0.1 or [::1]. */
export function isLocalUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && u.username === '' && u.password === '' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function run(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const usage = 'usage: send-sample --url <local url> --secret-env <variable> [--kind pull_request|review|comment] [--delivery <id>]';
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: { url: { type: 'string' }, 'secret-env': { type: 'string' }, kind: { type: 'string' }, delivery: { type: 'string' } },
      strict: true,
    }).values;
  } catch {
    console.log(usage);
    return 2;
  }
  const kind = values.kind ?? 'pull_request';
  const secretName = values['secret-env'];
  if (values.url === undefined || secretName === undefined || !(KINDS as string[]).includes(kind)) {
    console.log(usage);
    return 2;
  }
  if (!isLocalUrl(values.url)) {
    console.log('refused: the url must be http and point to localhost, 127.0.0.1 or [::1]');
    return 2;
  }
  const secret = env[secretName];
  if (secret === undefined || secret === '') {
    console.log(`the variable ${secretName} is not set`);
    return 2;
  }
  const delivery = values.delivery ?? `sample-${Date.now()}`;
  const { headers, body } = sampleWebhook(kind as SampleKind, secret, delivery);
  try {
    const res = await fetch(values.url, { method: 'POST', headers, body, redirect: 'manual' });
    console.log(`${res.status} ${await res.text()}`);
    return 0;
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    console.log(`no answer: ${typeof code === 'string' ? code : 'request failed'}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
