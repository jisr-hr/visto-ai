import tseslint from 'typescript-eslint';

const githubAdapter = '**/forge/github/**';
const engineForbidden = ['fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', 'cluster'];
const postgresClients = ['pg', '@electric-sql/pglite'];

// Flat config does not merge a rule's options across blocks: each block carries every restriction for its files.
export default tseslint.config(
  { ignores: ['node_modules/', 'runs/', '.superpowers/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/forge/github/**', 'src/eval/cli.ts', 'src/main.ts', 'src/db/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter], paths: postgresClients }],
    },
  },
  {
    files: ['src/forge/github/**/*.ts', 'src/eval/cli.ts', 'src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: postgresClients }],
    },
  },
  {
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [githubAdapter] }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [githubAdapter, '**/eval/**', '**/db/**', '**/shell/**'],
          paths: [...engineForbidden.flatMap((name) => [name, `node:${name}`]), ...postgresClients],
        },
      ],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'The engine may not import dynamically.' }],
    },
  },
);
