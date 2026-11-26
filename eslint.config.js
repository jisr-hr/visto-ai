import tseslint from 'typescript-eslint';

const githubAdapter = '**/forge/github/**';
const engineForbidden = ['fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', 'cluster'];
const postgresClients = ['pg', '@electric-sql/pglite'];
// The MCP client is built only by the service entry; the eval reaches neither it nor the service entry (section 15).
// Elsewhere only the header names may be imported, which the config's schema refuses.
const mcpPart = ['**/mcp/**', '!**/mcp/headers.ts'];
const evalForbidden = ['**/mcp/**', '**/main.ts'];
// The mcp part imports nothing of the project but its own files and the types of two files (the second rule holds them to
// types). A gitignore pattern cannot let a file through once its folder is refused, so the rest is refused by an expression.
const outsideMcp = (allowed) => ({
  regex: `^\\.\\./(?!(${allowed.map((path) => path.replaceAll('.', '\\.')).join('|')})$)`,
  message: 'The mcp part imports nothing of the project but types of the engine and the config.',
});
const mcpOwn = [{ group: [githubAdapter] }, outsideMcp(['engine/types.ts', 'config/load.ts'])];
// A test of the part may also run a review end to end: the engine's review and its submit tool.
const mcpTestOwn = [{ group: [githubAdapter] }, outsideMcp(['engine/types.ts', 'config/load.ts', 'engine/review.ts', 'engine/model/submit-review.ts'])];
const mcpTypesOnly = ['error', { patterns: [{ group: ['../engine/types.ts', '../config/load.ts'], allowTypeImports: true, message: 'The mcp part imports only types of the project.' }] }];
const engineNodeForbidden = engineForbidden.flatMap((name) => [name, `node:${name}`]);
// The memory part is pure: types and helpers of the engine, types of the git boundary, and its own files; no input or output.
const memoryForbidden = [githubAdapter, '**/db/**', '**/shell/**', '**/eval/**', '**/gate/**', '**/extensions/**', '**/mcp/**', '**/main.ts', '**/service.ts'];
// Only the eval's command line, the seed and the seed's test reach the database.
const evalSeed = ['src/eval/history/seed.ts', 'src/eval/history/seed.test.ts'];

// Flat config does not merge a rule's options across blocks: each block carries every restriction for its files.
export default tseslint.config(
  { ignores: ['node_modules/', 'runs/', '.superpowers/', 'ui/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/forge/github/**', 'src/eval/**', 'src/mcp/**', 'src/main.ts', 'src/db/**', 'src/memory/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, ...mcpPart], paths: postgresClients }],
    },
  },
  {
    files: ['src/eval/**/*.ts'],
    ignores: ['src/eval/cli.ts', ...evalSeed],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, ...evalForbidden, '**/db/**'], paths: postgresClients }],
    },
  },
  {
    files: evalSeed,
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, ...evalForbidden], paths: postgresClients }],
    },
  },
  {
    files: ['src/memory/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: memoryForbidden, paths: [...engineNodeForbidden, 'module', 'node:module', ...postgresClients] }],
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ group: ['**/config/**'], allowTypeImports: true, message: 'The memory part imports only types of the config.' }] }],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'The memory part may not import dynamically.' }],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    ignores: ['src/mcp/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: mcpOwn, paths: postgresClients }],
      '@typescript-eslint/no-restricted-imports': mcpTypesOnly,
    },
  },
  {
    files: ['src/mcp/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: mcpTestOwn, paths: postgresClients }],
      '@typescript-eslint/no-restricted-imports': mcpTypesOnly,
    },
  },
  {
    files: ['src/forge/github/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: mcpPart, paths: postgresClients }],
    },
  },
  {
    files: ['src/eval/cli.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: evalForbidden, paths: postgresClients }],
    },
  },
  {
    files: ['src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: postgresClients }],
    },
  },
  {
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, '**/engine/**', ...mcpPart] }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [githubAdapter, '**/eval/**', '**/db/**', '**/shell/**', '**/extensions/**', '**/mcp/**', '**/memory/**'],
          paths: [...engineNodeForbidden, ...postgresClients],
        },
      ],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'The engine may not import dynamically.' }],
    },
  },
);
