# File Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No finding is asked for, or kept, in a test, documentation, generated, vendored or lock file; such files are still read and scored.

**Architecture:** One pure predicate, `takesFindings(path)`, built on the existing `isLowPriority` and `isTestPath` plus a few names they miss. The file context carries it; a file's section tells the model; the contract says it; reconcile drops any finding on such a file, whatever the model does, and never re-files a finding onto one.

**Tech Stack:** TypeScript on Node, `node:test`.

**Spec:** this plan carries its design (as built: after the final review, `takesFindings` got rules of its own instead of reusing `isLowPriority` and `isTestPath`, which marked production code under `docs`, `build`, `vendor`, `spec` and similar directories; see `src/engine/context/focus.ts`), agreed in conversation on 2026-11-26 ("Adopt the file focus"), from the AACR-Bench runs in `docs/benchmarks/2026-11-26-the-finding-contract.md` and the lab run with open-code-review's default file filter (precision 0.42 to 0.45 at the same recall).

## Design

- **What takes no findings** (`src/engine/context/focus.ts`, `takesFindings(path: string): boolean`, by the file's path as the pull request has it now):
  - `isLowPriority(path)` as it is today (documentation, generated, fixtures, snapshots, vendored, dist, build and coverage directories; `.md`, images, `.lock`, `.map`, `.snap`, `.min.js`; `package-lock.json`, `pnpm-lock.yaml`, `go.sum`);
  - `isTestPath(path)` as it is today (`spec`, `specs`, `test`, `tests`, `__tests__` directories; `.test.`/`.spec.`/`_test.`/`_spec.` names);
  - and, case-insensitively: a `node_modules`, `third_party`, `testdata`, `__mocks__` or `__snapshots__` segment; a name ending `Test.java`, `Tests.java`, `Test.kt`, `Tests.kt`, `Test.cs`, `Tests.cs` (with the capital `T`), or starting `test_` and ending `.py`; a name ending `.pb.go`, `_pb2.py`, `.min.css`, `.mdx` or `.rst`, or containing `.generated.`.
- **The context.** `FileContext.findings: boolean`. A secret file is `false` too (it is never sent).
- **The section.** A file with `findings: false` gets the header line `findings: not asked. Report no finding in this file.`
- **The contract** (both files), under "What you do not report": `- A finding in a file whose header says \`findings: not asked\`: a test, documentation, generated, vendored or lock file. It is scored, not reviewed for findings.`
- **Reconcile.** A finding (placed, not placed, or beyond the diff) on a file with `findings: false` is dropped with the audit entry `{ stage: 'reconcile', action: 'dropped', subject: <path>, reason: 'findings_not_asked' }`; re-filing by quote never picks such a file.
- **Unchanged:** scoring of such files, threads already open on them, incremental reviews, the gate and approval rules.

## Global Constraints

- `npm test`, `npm run typecheck` and `npm run lint` pass before each commit; a single file runs with `node --import ./test/setup.ts --test <file>`.
- Every literal in a test is invented.
- Commits end with the co-author line your own session's attribution gives.

## Review Focus

- A source file whose path contains a word like `test` inside a name (`src/attestation.ts`, `src/contest/rules.go`): takes findings.
- A test helper outside a test directory with no test name (`src/testing/helpers.ts`): takes findings (not covered; stated in the README).
- `CMakeLists.txt`, `pom.xml`, `Dockerfile`, workflow files: take findings.
- A finding on a test file that a model files anyway: dropped, audited, never moved to another file.

---

### Task 1: `takesFindings`

**Files:** Create `src/engine/context/focus.ts`, `src/engine/context/focus.test.ts`.

- [ ] Write the failing test: false for `docs/setup.md`, `README.md`, `api/v1/user.pb.go`, `proto/user_pb2.py`, `web/app.min.css`, `src/__tests__/a.ts`, `src/a.test.ts`, `pkg/a_test.go`, `spec/models/user_spec.rb`, `src/test/java/com/acme/CartTest.java`, `Acme.Tests/CartTests.cs`, `tests/test_cart.py`, `node_modules/x/index.js`, `third_party/zlib/inflate.c`, `pkg/testdata/in.json`, `src/__mocks__/api.ts`, `yarn.lock`, `vendor/github.com/x/y.go`, `src/api.generated.ts`, `docs/guide.mdx`; true for `src/cart.ts`, `src/attestation.ts`, `src/contest/rules.go`, `src/testing/helpers.ts`, `CMakeLists.txt`, `pom.xml`, `Dockerfile`, `.github/workflows/ci.yml`, `src/Contest.java`.
- [ ] Run it: fails (module missing). Implement. Run it: passes. Commit with Task 2.

### Task 2: context, section, contract and reconcile

**Files:** Modify `src/engine/context/build.ts`, `src/engine/context/section.ts`, `src/engine/reconcile/index.ts`, `contract/review-contract.md`, `contract/review-contract-scorer.md`. Tests: `build.test.ts`, `section` tests in `build.test.ts`, `reconcile/index.test.ts`, `contract/review-contract.test.ts`.

- [ ] Failing tests: a test file's context has `findings: false`, a source file's `true`; its section holds the header line, a source file's does not; reconcile drops a placed, an unplaced and a beyond-the-diff finding on a `findings: false` file with the audit entry, and re-filing by quote does not pick such a file; both contracts hold the new line, and the scorer contract still mirrors the review contract up to the blocks.
- [ ] Implement; run the touched tests, then `npm test`, `npm run typecheck`, `npm run lint`. Commit.

### Task 3: docs

- [ ] README ("How the engine works", step 5, and "What it is designed to do"), design section 5.6 (a new reconcile step) and 5.3 (the header line). Commit.
