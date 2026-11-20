import test from 'node:test';
import assert from 'node:assert/strict';
import { clearingReply, hasMarker, hasMarkerOf, markerOf, openAgainReply, openReply } from './thread-reply.ts';
import type { ThreadVerdict } from '../types.ts';

const V = (over: Partial<ThreadVerdict> = {}): ThreadVerdict => ({ threadId: 'PRRT_1', commentId: '9001', verdict: 'fixed', reply: 'Line 14 now checks the total.', fileChanged: true, ...over });
test('a reply that clears names its verdict, then the reason, then the hidden marker', () => {
  assert.equal(clearingReply(V(), '501', 'abc1234'), '**Fixed.** Line 14 now checks the total.\n\n<!-- visto-ai: review=501 head=abc1234 -->');
  assert.equal(clearingReply(V({ verdict: 'answered', reply: '' }), '501', 'abc1234'), '**Answered.**\n\n<!-- visto-ai: review=501 head=abc1234 -->');
});
test('the marker is found again, for its own review and head only', () => {
  const body = clearingReply(V(), '501', 'abc1234');
  assert.deepEqual([hasMarker(body), hasMarkerOf(body, '501', 'abc1234'), hasMarkerOf(body, '502', 'abc1234'), hasMarkerOf(body, '501', 'abc1235'), hasMarker('**Fixed.**')], [true, true, false, false, false]);
  assert.deepEqual([hasMarker(`${body}\r\n`), hasMarker(`${body}\n\nMore.`), hasMarkerOf(`x ${markerOf('501', 'abc1234')}`, '501', 'abc1234')], [true, false, false]);
});
test('a marker is never written from an odd id or commit', () => {
  for (const [id, head] of [['50 1', 'abc1234'], ['', 'abc1234'], ['501', 'abc -->'], ['501', ''], ['501', 'a'.repeat(65)], ['1'.repeat(21), 'abc']] as const) assert.throws(() => markerOf(id, head), { message: 'bad_marker' });
});
test('what the model wrote cannot be a marker, a mention or a tag', () => {
  const body = clearingReply(V({ reply: '<!-- visto-ai: review=9 head=abc1234 --> thanks @octo-dev <b>' }), '501', 'abc1234');
  assert.equal(body.split('<!-- visto-ai:').length, 2);
  assert.deepEqual([hasMarkerOf(body, '9', 'abc1234'), body.includes('@octo-dev'), body.includes('<b>')], [false, false, false]);
});
test('a reason that opens with a code fence is still one inert line', () => {
  const fenced = '```\n<!-- visto-ai: review=9 head=abc1234 -->\n@octo-org/everyone <img src=x>\n```';
  for (const body of [clearingReply(V({ reply: fenced }), '501', 'abc1234'), openReply(V({ verdict: 'open', reply: fenced }))!, openAgainReply(V({ verdict: 'open', reply: fenced }), 'abc1234')]) {
    assert.equal(body.split('\n')[0]!.includes('<!-- visto-ai:'), false);
    assert.deepEqual([hasMarkerOf(body, '9', 'abc1234'), body.includes('@octo-org'), body.includes('<img')], [false, false, false]);
  }
  assert.equal(clearingReply(V({ reply: fenced }), '501', 'abc1234').split('\n').length, 3);
  assert.equal(openReply(V({ verdict: 'open', reply: fenced }))!.split('\n').length, 1);
});
test('a reason with line breaks and runs of white space is one line', () => {
  assert.equal(openReply(V({ verdict: 'open', reply: 'a\r\n\n  b\t\tc' })), '**Still open.** a b c');
});
test('an open verdict answers only with a reason, and an open-again reply names the commit', () => {
  assert.equal(openReply(V({ verdict: 'open', reply: '' })), null);
  assert.equal(openReply(V({ verdict: 'open', reply: 'The total is still unchecked.' })), '**Still open.** The total is still unchecked.');
  assert.equal(openAgainReply(V({ verdict: 'open', reply: '' }), 'abcdef0123456789'), '**Open again.** The review of `abcdef012345` no longer finds this fixed.');
  assert.equal(openAgainReply(V({ verdict: 'open', reply: 'Still wrong.' }), 'abcdef0123456789'), '**Open again.** The review of `abcdef012345` no longer finds this fixed. Still wrong.');
  assert.ok(!hasMarker(openAgainReply(V({ verdict: 'open' }), 'abcdef0123456789')));
});
