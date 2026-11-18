import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookReader, WebhookReading } from '../types.ts';
import { eventOf } from './events.ts';
import { isObject } from './http.ts';

function signedBy(secret: string, header: unknown, body: Buffer): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

export function createGithubWebhookReader(secret: string): WebhookReader {
  if (secret === '') throw new Error('empty_webhook_secret');
  return {
    read(headers, body): WebhookReading {
      if (!signedBy(secret, headers['x-hub-signature-256'], body)) return { ok: false, reason: 'bad_signature' };
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return { ok: false, reason: 'not_json' };
      }
      const delivery = headers['x-github-delivery'];
      if (!nonEmpty(delivery)) return { ok: false, reason: 'no_delivery_id' };
      const name = headers['x-github-event'];
      if (!nonEmpty(name)) return { ok: false, reason: 'no_event_name' };
      const action = isObject(payload) && typeof payload.action === 'string' ? payload.action : null;
      return { ok: true, delivery, name, action, event: eventOf(name, payload) };
    },
  };
}
