import tseslint from 'typescript-eslint';

const githubAdapter = '**/forge/github/**';
const engineForbidden = ['fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', 'cluster'];

export default tseslint.config(
  { ignores: ['node_modules/', 'runs/', '.superpowers/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/forge/github/**', 'src/eval/cli.ts'],
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
          patterns: [githubAdapter, '**/eval/**'],
          paths: engineForbidden.flatMap((name) => [name, `node:${name}`]),
        },
      ],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'The engine may not import dynamically.' }],
    },
  },
);
