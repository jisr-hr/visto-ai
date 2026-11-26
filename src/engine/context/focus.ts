// Which files the review asks findings for, after open-code-review's default file filter, in our own words and
// narrower: a directory name counts anywhere only when it never holds production code (`node_modules`, `__tests__`,
// `test`); names that also hold production code in common layouts (`docs`, `dist`, `vendor`, `spec`) count only at the
// repository root; `build` and `coverage` never count.
const ANYWHERE = new Set(['node_modules', '__tests__', '__mocks__', '__snapshots__', '__generated__', 'testdata', 'test', 'tests']);
const AT_ROOT = new Set(['docs', 'doc', 'dist', 'vendor', 'third_party', 'third-party', 'spec', 'specs']);
const DOCUMENT = /\.(md|mdx|markdown|rst|adoc)$/;
const LOCK = /(\.lock|\.lockb)$|^(package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|go\.sum)$/;
const GENERATED = /(\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.g\.dart|\.min\.js|\.min\.css|\.map|\.snap)$|^zz_generated\.|\.generated\./;
const SCRIPT_TEST = /([._](test|spec)|\.cy|\.stories)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const OTHER_TEST = /(_test\.go|_spec\.rb|_test\.rb|_test\.py)$|^test_.*\.py$|^conftest\.py$/;

/**
 * Whether the review asks for findings in a file, by its path in the pull request. A test, documentation, generated,
 * vendored or lock file takes none: it is still read and scored, and a finding on it is dropped.
 */
export function takesFindings(path: string): boolean {
  const segments = path.toLowerCase().split('/').filter((s) => s !== '');
  const name = segments.pop() ?? '';
  if (segments.some((s) => ANYWHERE.has(s) || s.endsWith('.tests') || s.endsWith('.test'))) return false;   // a C# test project: Acme.Tests/
  if (segments.length > 0 && AT_ROOT.has(segments[0]!)) return false;
  return !(DOCUMENT.test(name) || LOCK.test(name) || GENERATED.test(name) || SCRIPT_TEST.test(name) || OTHER_TEST.test(name));
}
