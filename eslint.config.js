// ESLint: base TS rules and import boundaries between layers.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
  * Layer boundaries. Imports are relative with a `.js` suffix (ESM NodeNext),
  * so the rules are regular expressions over the import path.
  * The message states the rule, so a violation is clear without looking anything up.
 */
const layer = (regex, message) => ({ regex, message });

const NO_DB = layer('(^|/)db/', 'This layer may not import db/.');
const NO_STORE = layer('(^|/)store/', 'Only core/ may import store/.');
const NO_CORE = layer('(^|/)core/', 'This layer may not import core/.');
const NO_OPS = layer('(^|/)ops/', 'This layer may not import ops/.');
const NO_ADAPTERS = layer('(^|/)adapters/', 'Only main.ts imports adapters.');

// adapters/: only ops/registry, ops/execute, ops/errors, core/tokens, core/sessions, core/ratelimit.
const ADAPTER_CORE = layer(
  '(^|/)core/(?!(tokens|sessions|ratelimit)\\.js$)',
  'An adapter may import from core/ only tokens, sessions, ratelimit.',
);
const ADAPTER_OPS = layer(
  '(^|/)ops/(?!(registry|execute|errors)\\.js$)',
  'An adapter may import from ops/ only registry, execute, errors.',
);

const restrict = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', '.perf-dist/', 'data/', 'web/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  { files: ['src/db/**'], rules: restrict(NO_STORE, NO_CORE, NO_OPS, NO_ADAPTERS) },
  { files: ['src/store/**'], rules: restrict(NO_CORE, NO_OPS, NO_ADAPTERS) },
  { files: ['src/core/**'], rules: restrict(NO_OPS, NO_ADAPTERS) },
  { files: ['src/ops/**'], rules: restrict(NO_STORE, NO_DB, NO_ADAPTERS) },
  { files: ['src/adapters/**'], rules: restrict(NO_STORE, NO_DB, ADAPTER_CORE, ADAPTER_OPS) },
  {
    // files.ts may additionally use core/documents and core/export.
    files: ['src/adapters/http/files.ts'],
    rules: restrict(
      NO_STORE,
      NO_DB,
      ADAPTER_OPS,
      layer(
        '(^|/)core/(?!(tokens|sessions|ratelimit|documents|export/[a-z-]+)\\.js$)',
        'files.ts may import from core/ only tokens, sessions, ratelimit, documents, export.',
      ),
    ),
  },
);
