import tseslint from 'typescript-eslint';

const githubAdapter = '**/forge/github/**';

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
          paths: ['node:fs', 'node:fs/promises', 'node:net', 'node:http', 'node:https', 'node:child_process'],
        },
      ],
    },
  },
);
