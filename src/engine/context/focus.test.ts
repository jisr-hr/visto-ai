import assert from 'node:assert/strict';
import test from 'node:test';
import { takesFindings } from './focus.ts';

test('test, documentation, generated, vendored and lock files take no findings', () => {
  for (const p of [
    'docs/setup.md', 'README.md', 'api/v1/user.pb.go', 'proto/user_pb2.py', 'web/app.min.css', 'src/__tests__/a.ts', 'src/a.test.ts',
    'pkg/a_test.go', 'spec/models/user_spec.rb', 'src/test/java/com/acme/CartTest.java', 'Acme.Tests/CartTests.cs', 'tests/test_cart.py',
    'node_modules/x/index.js', 'third_party/zlib/inflate.c', 'pkg/testdata/in.json', 'src/__mocks__/api.ts', 'yarn.lock',
    'vendor/github.com/x/y.go', 'src/api.generated.ts', 'docs/guide.mdx', 'docs/index.rst', 'src/__snapshots__/a.snap', 'app/src/test/kotlin/CartTest.kt',
  ]) assert.equal(takesFindings(p), false, p);
});

test('source, build and configuration files take findings', () => {
  for (const p of [
    'src/cart.ts', 'src/attestation.ts', 'src/contest/rules.go', 'src/testing/helpers.ts', 'CMakeLists.txt', 'pom.xml', 'Dockerfile',
    '.github/workflows/ci.yml', 'src/Contest.java', 'src/latest.py', 'lib/protest.rb',
  ]) assert.equal(takesFindings(p), true, p);
});
