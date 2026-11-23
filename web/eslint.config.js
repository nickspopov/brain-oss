// ESLint for the UI: the same base rules as the server (packages from the root), plus a boundary:
// web/ imports only types from ops/types out of the server code.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Inside web/src, own modules are never addressed via `src/`: such a path leads
    // into the root's server code.
    files: ['src/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\./)+src/(?!ops/types$)',
              message: 'web/ imports only types from ops/types out of the server code.',
            },
            {
              regex: '^(\\.\\./)+src/ops/types$',
              allowTypeImports: true,
              message: 'From ops/types, only `import type` is allowed.',
            },
          ],
        },
      ],
    },
  },
);
