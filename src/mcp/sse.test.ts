import test from 'node:test';
import assert from 'node:assert/strict';
import { eventData } from './sse.ts';

interface Source {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
}

/** A stream that hands out one chunk on each pull, and then closes, or never closes. */
function source(chunks: (string | Uint8Array)[], close = true): Source {
  const bytes = chunks.map((chunk) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled < bytes.length) {
          controller.enqueue(bytes[pulled]!);
          pulled += 1;
          return;
        }
        if (close) {
          controller.close();
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

async function collect(stream: ReadableStream<Uint8Array>, maxBytes = 1_000_000): Promise<string[]> {
  const out: string[] = [];
  for await (const data of eventData(stream, maxBytes)) out.push(data);
  return out;
}

test('events are read whatever the chunks, the line endings and the space after the colon', async () => {
  const text = 'data: {"a":1}\n\ndata:{"b":"\u00e9"}\r\n\r\ndata: x\rdata: y\r\rdata: p\r\ndata: q\r\n\r\n';
  const all = new TextEncoder().encode(text);
  const expected = ['{"a":1}', '{"b":"\u00e9"}', 'x\ny', 'p\nq'];
  let crlfCut = false;
  for (let cut = 0; cut <= all.length; cut += 1) {
    if (all[cut - 1] === 13 && all[cut] === 10) crlfCut = true;
    const got = await collect(source([all.slice(0, cut), all.slice(cut)]).stream);
    assert.deepEqual(got, expected, `cut at ${cut}`);
  }
  assert.ok(crlfCut);
  assert.ok(all.length > text.length, 'the accented letter is two bytes');
});

test('comment lines, events with no data, and the fields event, id and retry are passed over', async () => {
  const text = ': keep-alive\n\nid: 1\ndata:\n\nevent: message\nid: 2\nretry: 500\ndata: {"ok":true}\n\ndata: {"last":true}\n';
  assert.deepEqual(await collect(source([text]).stream), ['{"ok":true}']);
});

test('reading stops, and the stream is cancelled, once more bytes came than allowed', async () => {
  const s = source(['0123456789', 'a', 'more', 'and more'], false);
  await assert.rejects(collect(s.stream, 10), (error: Error) => error.message === 'answer_too_large');
  assert.equal(s.cancelled(), true);
  assert.equal(s.pulled(), 2);
  const exact = source(['data: 0123\n\n'], true);
  assert.deepEqual(await collect(exact.stream, 12), ['0123']);
});

test('a consumer that stops early cancels the stream', async () => {
  const s = source(['data: one\n\ndata: two\n\n'], false);
  for await (const data of eventData(s.stream, 1000)) {
    assert.equal(data, 'one');
    break;
  }
  assert.equal(s.cancelled(), true);
});

test('a byte order mark is dropped at the start of the stream only', async () => {
  const text = '\ufeffdata: a\n\n\ufeffdata: b\n\ndata: c\n\n';
  assert.deepEqual(await collect(source([text]).stream), ['a', 'c']);
});
