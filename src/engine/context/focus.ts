import { isLowPriority } from './priority.ts';
import { isTestPath } from './test-pair.ts';

// What the low-priority and test-path rules leave out, after open-code-review's default file filter, in our own words.
const NO_FINDINGS_SEGMENTS = new Set(['node_modules', 'third_party', 'testdata', '__mocks__', '__snapshots__']);
const TEST_CLASS = /Tests?\.(java|kt|cs)$/;               // CartTest.java, CartTests.cs: the capital T is the convention
const PYTHON_TEST = /^test_.*\.py$/i;
const GENERATED_NAME = /(\.pb\.go|_pb2\.py|\.min\.css|\.mdx|\.rst)$|\.generated\./i;

/**
 * Whether the review asks for findings in a file. A test, documentation, generated, vendored or lock file takes none:
 * it is still read and scored, and a finding on it is dropped.
 */
export function takesFindings(path: string): boolean {
  if (isLowPriority(path) || isTestPath(path)) return false;
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  if (segments.some((s) => NO_FINDINGS_SEGMENTS.has(s.toLowerCase()))) return false;
  return !(TEST_CLASS.test(name) || PYTHON_TEST.test(name) || GENERATED_NAME.test(name));
}
