import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Nothing of the service is imported but its answers' types, through src/api-types.ts (call 28).
const outsideUi = { regex: '^(\\.\\./)+src/', message: 'The UI reaches the service only through src/api-types.ts.' };

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/api-types.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [outsideUi] }],
    },
  },
  {
    files: ['src/api-types.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ ...outsideUi, allowTypeImports: true }] }],
    },
  },
);
