// ESLint 9 flat config for the Pokemon TCG Tracker repo.
//
// Strict for `src/**`: no `any`, real errors only. The point of this
// layer is to catch runtime patterns the TypeScript compiler misses;
// TS already enforces strict + noUncheckedIndexedAccess +
// noUnusedLocals + noUnusedParameters via tsconfig.json.
//
// Targeted, justified test overrides only — no blanket disables.
//
// Out of scope on purpose:
//   - `scripts/ai-supervisor/**` — supervisor self-modification is
//     governed by scope-guard gate #13 (QUORUM approval); any lint fix
//     there must ship in a separate dedicated PR with the required
//     approval records. Ignoring here keeps this hygiene PR small.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      '.claude/**',
      '.local/**',
      '**/*.d.ts',
      // See header: supervisor scope-guard.
      'scripts/ai-supervisor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // TS compiler already enforces noUnusedLocals / noUnusedParameters
      // with stricter semantics; turn off the ESLint duplicate to keep
      // a single source of truth on unused-symbol diagnostics.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // Vitest globals — matches `"types": ["vitest/globals"]` in tsconfig.
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      // Test-doubles and ad-hoc mock objects routinely use `any` to
      // stub partial shapes — typing every mock to the full interface
      // would be a substantial test refactor outside this PR's scope.
      // Tracked for a future test-typing cleanup PR; production code
      // (src/**) keeps `no-explicit-any: error`.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // CSV-export fixtures intentionally include U+00A0 (non-breaking
    // space) and other irregular-whitespace chars in test input
    // strings — the whole point of these tests is to verify that
    // CSV escaping / quoting handles such characters correctly.
    // Linting them away would invalidate the test data.
    files: [
      'tests/binder-csv-export.test.ts',
      'tests/binder-detail-action-audit.test.ts',
      'tests/lot-csv-export.test.ts',
      'tests/mvp-csv-export.test.ts',
    ],
    rules: {
      'no-irregular-whitespace': 'off',
    },
  },
);
