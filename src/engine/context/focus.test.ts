import assert from 'node:assert/strict';
import test from 'node:test';
import { takesFindings } from './focus.ts';

test('test, documentation, generated, vendored and lock files take no findings', () => {
  for (const p of [
    // documentation and lock files
    'docs/setup.md', 'README.md', 'docs/guide.mdx', 'docs/index.rst', 'guide.adoc', 'yarn.lock', 'Cargo.lock', 'package-lock.json',
    'pnpm-lock.yaml', 'go.sum', 'bun.lockb', 'npm-shrinkwrap.json',
    // generated
    'api/v1/user.pb.go', 'proto/user_pb2.py', 'proto/user_pb2_grpc.py', 'lib/user.g.dart', 'pkg/apis/zz_generated.deepcopy.go',
    'src/api.generated.ts', 'src/__generated__/schema.ts', 'web/app.min.css', 'web/app.min.js', 'web/app.js.map',
    // tests
    'src/__tests__/a.ts', 'src/a.test.ts', 'src/a.spec.tsx', 'e2e/login.cy.ts', 'src/Button.stories.tsx', 'pkg/a_test.go',
    'spec/models/user_spec.rb', 'test/models/user_test.rb', 'src/test/java/com/acme/CartTest.java', 'src/test/java/com/acme/Helpers.java',
    'app/src/test/kotlin/CartTest.kt', 'Acme.Tests/CartTests.cs', 'Acme.Tests/Helpers.cs', 'tests/test_cart.py', 'cart_test.py',
    'conftest.py', 'Tests/AcmeTests/CartTests.swift', 'pkg/testdata/in.json', 'src/__mocks__/api.ts', 'src/__snapshots__/a.snap',
    // vendored and build output at the root
    'node_modules/x/index.js', 'web/node_modules/x/index.js', 'vendor/github.com/x/y.go', 'third_party/zlib/inflate.c',
    'third-party/lib/a.c', 'dist/app.js',
  ]) assert.equal(takesFindings(p), false, p);
});

test('source, build and configuration files take findings, also under words that mark tests or docs elsewhere', () => {
  for (const p of [
    'src/cart.ts', 'src/attestation.ts', 'src/contest/rules.go', 'src/testing/helpers.ts', 'CMakeLists.txt', 'pom.xml', 'Dockerfile',
    '.github/workflows/ci.yml', 'src/Contest.java', 'src/latest.py', 'lib/protest.rb',
    // production code under segments that only count at the root, or not at all
    'apps/docs/app/page.tsx', 'app/docs/[slug]/page.tsx', 'app/controllers/docs/pages_controller.rb', 'app/controllers/vendor/accounts_controller.rb',
    'packages/next/src/build/index.ts', 'build/Dockerfile', 'Build/Package.cs', 'scripts/build', 'core/snapshots/manager.go',
    'server/src/main/java/org/acme/snapshots/SnapshotsService.java', 'app/models/coverage/policy.rb', 'pkg/validation/spec/schema.go',
    'api/openapi.spec.yaml', 'src/Docs/Renderer.cs', 'src/main/java/com/acme/ABTest.java', 'Models/LabTest.cs', 'src/SpeedTest.kt',
    'src/dist/index.ts',
  ]) assert.equal(takesFindings(p), true, p);
});
