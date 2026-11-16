import assert from 'node:assert/strict';
import test from 'node:test';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import { isGrounded } from './grounding.ts';

const PR_FILES = [
  'src/models/account.ts',
  'src/services/billing/refund_request_service.ts',
  'settings/defaults.yml',
  'test/api/orders_controller_refund_spec.ts',
];

const finding = (path: string, body = 'This looks wrong.') =>
  ({ path, side: 'RIGHT', line: 3, severity: 'minor', body, quote: '', beyond_diff: false }) as const;
const overviewOnly = (overview: string): SubmitReviewArgs => ({ overview, findings: [] });
const answerOn = (path: string): SubmitReviewArgs => ({ overview: 'A short summary.', findings: [finding(path)] });

const ARTICLE = `Gardening in a small city apartment

Growing vegetables on a balcony is a pleasant hobby that rewards patience. Most herbs need about six hours of sunlight each day, so the first step is to watch how the light moves across the space during a week. Containers should have drainage holes, and a light potting mix works better than heavy garden earth, which tends to compact and hold too much water. Tomatoes, peppers and lettuce all do well in pots of moderate size, while carrots prefer deeper containers. Watering in the early morning reduces evaporation and keeps leaves dry through the hot afternoon. A little compost every few weeks provides enough nutrition for most plants. Neighbours often share cuttings and seeds, which makes the hobby social as well as productive. Beginners should start with only a handful of plants and add more as confidence grows, since a crowded balcony is hard to maintain and easy to neglect.`;

test('a finding on a pull request file grounds the answer', () => {
  assert.equal(isGrounded(answerOn('src/a.ts'), ['src/a.ts']), true);
});

test('a finding path is compared after normalisation', () => {
  assert.equal(isGrounded(answerOn('./src/a.ts'), ['src/a.ts']), true);
  assert.equal(isGrounded(answerOn('a/src/a.ts'), ['src/a.ts']), true);
  assert.equal(isGrounded(answerOn('lib/src/a.ts'), ['src/a.ts']), false);
});

test('an essay about something else is not grounded', () => {
  assert.equal(isGrounded({ overview: 'A long article about city gardens and soil.', findings: [] }, ['src/a.ts']), false);
});

test('an empty file list skips grounding', () => {
  assert.equal(isGrounded({ overview: 'x', findings: [] }, []), true);
});

test('a full path in the overview grounds the answer', () => {
  const answer = overviewOnly('Adds a guard in `src/models/account.ts` that blocks closed accounts.');
  assert.equal(isGrounded(answer, PR_FILES), true);
});

test('the text checked is the overview followed by the finding bodies', () => {
  const answer: SubmitReviewArgs = { overview: 'Looks reasonable.', findings: [finding('other/file.ts', 'The guard in account.ts is inverted.')] };
  assert.equal(isGrounded(answer, PR_FILES), true);
});

test('a base name in the overview is enough', () => {
  assert.equal(isGrounded(overviewOnly('Account.ts now rejects closed accounts.'), PR_FILES), true);
  assert.equal(isGrounded(overviewOnly('ACCOUNT.TS now rejects closed accounts.'), PR_FILES), true);
});

test('a base name inside a shortened path is enough', () => {
  const answer = overviewOnly('Batches the loading in `billing/refund_request_service.ts`.');
  assert.equal(isGrounded(answer, ['src/services/billing/refund_request_service.ts']), true);
});

test('a base name glued to other word characters does not count', () => {
  assert.equal(isGrounded(overviewOnly('See some_account.dat for the details here.'), ['src/models/account.dat']), false);
  assert.equal(isGrounded(overviewOnly('See my-account.dat for the details here.'), ['src/models/account.dat']), false);
});

test('a stem of at least 6 characters is enough; a shorter one is not', () => {
  assert.equal(isGrounded(overviewOnly('The refund_request_service retries twice.'), PR_FILES), true);
  assert.equal(isGrounded(overviewOnly('The order logic retries twice.'), ['src/a/order.rb']), false);
});

test('the CamelCase form of a stem counts', () => {
  assert.equal(isGrounded(overviewOnly('RefundRequestService now retries twice.'), PR_FILES), true);
});

test('an overview holding only a backticked code identifier is not grounded', () => {
  const text = 'It limits retries with `MAX_RETRY_COUNT` and drops `refund_requests_scope`.';
  assert.equal(isGrounded(overviewOnly(text), PR_FILES), false);
});

test('a source path that is not a file of the pull request is not grounded', () => {
  assert.equal(isGrounded(overviewOnly('The new lib/cart/total.ts is not covered.'), PR_FILES), false);
});

test('backticked English words do not ground an answer', () => {
  assert.equal(isGrounded(overviewOnly('The `maybe` here is `acceptable` overall.'), PR_FILES), false);
});

test('prose domain names do not ground an answer', () => {
  assert.equal(isGrounded(overviewOnly('Visit docs.example.com or help.example.com.'), PR_FILES), false);
});

test('an unrelated article is not grounded', () => {
  assert.equal(isGrounded(overviewOnly(ARTICLE), PR_FILES), false);
});

test('a leaked reasoning fragment is not grounded', () => {
  assert.equal(isGrounded(overviewOnly('Thinking about what to write next, I will draft it now.'), PR_FILES), false);
});
