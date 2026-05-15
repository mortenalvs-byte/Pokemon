// ESLint 9 flat config for the Pokemon TCG Tracker repo.
//
// Strict for `src/**`: no `any`, real errors only. The point of this
// layer is to catch runtime patterns the TypeScript compiler misses;
// TS already enforces strict + noUncheckedIndexedAccess +
// noUnusedLocals + noUnusedParameters via tsconfig.json.
//
// Globals are scoped per runtime so `no-undef` keeps full signal —
// Node-only globals (process, __dirname, Buffer, ...) must not be
// reachable from browser code, and vice versa. The split:
//   - `src/**`              : browser globals only (Vite-bundled app)
//   - `tests/**`            : browser + node + vitest (tests use fs +
//                             jsdom + vitest's globals)
//   - root config TS/JS     : node globals (vite.config.ts,
//                             vitest.config.ts, eslint.config.js)
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
    // Defaults applied to every linted file. Globals are intentionally
    // empty here; per-runtime overrides below add only what each
    // surface actually needs so `no-undef` keeps full signal.
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
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
    // Browser runtime — Vite-bundled app code shipped to the browser.
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // Node runtime — root-level config files loaded by tooling.
    files: [
      'eslint.config.js',
      'vite.config.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Vitest tests run under jsdom + node; they touch both APIs (DOM
    // mocks AND fs/path/crypto in fixtures), and vitest exposes
    // describe/it/expect/etc. as globals via `"types": ["vitest/globals"]`
    // in tsconfig.json. Mirror that here so ESLint sees them too.
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
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
