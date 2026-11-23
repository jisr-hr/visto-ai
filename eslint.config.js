import tseslint from 'typescript-eslint';

const githubAdapter = '**/forge/github/**';
const engineForbidden = ['fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', 'cluster'];
const postgresClients = ['pg', '@electric-sql/pglite'];
// The MCP client is built only by the service entry; the eval reaches neither it nor the service entry (section 15).
const mcpClient = '**/mcp/client.ts';
const evalForbidden = ['**/mcp/**', '**/main.ts'];

// Flat config does not merge a rule's options across blocks: each block carries every restriction for its files.
export default tseslint.config(
  { ignores: ['node_modules/', 'runs/', '.superpowers/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/forge/github/**', 'src/eval/**', 'src/mcp/**', 'src/main.ts', 'src/db/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, mcpClient], paths: postgresClients }],
    },
  },
  {
    files: ['src/eval/**/*.ts'],
    ignores: ['src/eval/cli.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, ...evalForbidden], paths: postgresClients }],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter, '**/main.ts'], paths: postgresClients }],
    },
  },
  {
    files: ['src/forge/github/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [mcpClient], paths: postgresClients }],
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
      'no-restricted-imports': ['error', { patterns: [githubAdapter, '**/engine/**', mcpClient] }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [githubAdapter, '**/eval/**', '**/db/**', '**/shell/**', '**/extensions/**', '**/mcp/**'],
          paths: [...engineForbidden.flatMap((name) => [name, `node:${name}`]), ...postgresClients],
        },
      ],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'The engine may not import dynamically.' }],
    },
  },
);
