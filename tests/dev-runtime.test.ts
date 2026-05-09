// PR 31 — dev/QA runtime separation tests.
//
// `src/qa/dev-runtime.ts` lifts the four `pokemon.devAuto*` boot
// triggers + the console audit + the auto route walk out of
// `src/main.ts`. These tests pin three contracts:
//
//   1. The module exports the two entry-point functions
//      (`installConsoleAudit`, `runDevAutoTriggersAfterInit`) that
//      `src/main.ts` calls inside `if (import.meta.env.DEV)`.
//   2. `installConsoleAudit` patches `console.error` /
//      `console.warn` so subsequent calls land in
//      `localStorage[pokemon.consoleAuditHistory]` with the same
//      `{ ts, route, level, message }` shape PR 28 documented.
//   3. `runDevAutoTriggersAfterInit` is a no-op when none of the
//      four `pokemon.devAuto*` flags are set — the lift must NOT
//      change the "no flag → no work" behaviour.
//
// Production-bundle exclusion of `runDevAutoTriggersAfterInit` and
// every other dev-only identifier is enforced by
// `tests/qa-route-prod-gating.test.ts` (banned-string list).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installConsoleAudit,
  runDevAutoTriggersAfterInit,
} from '../src/qa/dev-runtime';

const FLAG_KEYS = [
  'pokemon.devAutoFixtureImport',
  'pokemon.devAutoImageAudit',
  'pokemon.devAutoPublicSync',
  'pokemon.devAutoMaxStress',
];

const RESULT_KEYS = [
  'pokemon.devAutoFixtureImportResult',
  'pokemon.devAutoImageAuditResult',
  'pokemon.devAutoPublicSyncResult',
  'pokemon.devAutoMaxStressResult',
];

const CONSOLE_HISTORY_KEY = 'pokemon.consoleAuditHistory';
const ROUTE_WALK_KEY = 'pokemon.routeWalkHistory';

function clearAllDevRuntimeState(): void {
  for (const k of [...FLAG_KEYS, ...RESULT_KEYS, CONSOLE_HISTORY_KEY, ROUTE_WALK_KEY]) {
    localStorage.removeItem(k);
  }
}

describe('dev-runtime — module shape', () => {
  it('exports installConsoleAudit and runDevAutoTriggersAfterInit', () => {
    expect(typeof installConsoleAudit).toBe('function');
    expect(typeof runDevAutoTriggersAfterInit).toBe('function');
  });
});

describe('dev-runtime — runDevAutoTriggersAfterInit no-op when no flags set', () => {
  beforeEach(() => clearAllDevRuntimeState());
  afterEach(() => clearAllDevRuntimeState());

  it('does NOT fetch, sync, seed, or write any result key when all four flags are absent', async () => {
    // Pre-condition sanity: no flags set.
    for (const k of FLAG_KEYS) expect(localStorage.getItem(k)).toBeNull();

    // Patch fetch so a stray call would be visible.
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error('fetch should not be called'));
    }) as typeof fetch;

    try {
      await runDevAutoTriggersAfterInit();
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(fetchCalls).toBe(0);
    // None of the four result keys should have been written.
    for (const k of RESULT_KEYS) {
      expect(localStorage.getItem(k)).toBeNull();
    }
  });
});

describe('dev-runtime — installConsoleAudit captures errors and warns', () => {
  let origError: typeof console.error;
  let origWarn: typeof console.warn;

  beforeEach(() => {
    clearAllDevRuntimeState();
    origError = console.error;
    origWarn = console.warn;
    // Pre-stamp ROUTE_WALK_KEY so kickOffAutoRouteWalk's setTimeout
    // chain returns immediately and does not fight subsequent tests.
    localStorage.setItem(ROUTE_WALK_KEY, '[]');
  });

  afterEach(() => {
    console.error = origError;
    console.warn = origWarn;
    clearAllDevRuntimeState();
  });

  it('persists console.error events to pokemon.consoleAuditHistory', () => {
    installConsoleAudit();
    console.error('boom', 1, { x: 2 });
    const raw = localStorage.getItem(CONSOLE_HISTORY_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Array<{
      ts: string;
      route: string;
      level: string;
      message: string;
    }>;
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.level).toBe('error');
    expect(parsed[0]?.message).toContain('boom');
    expect(parsed[0]?.message).toContain('1');
    expect(parsed[0]?.message).toContain('"x":2');
    // ts must be a parseable ISO timestamp.
    expect(Number.isFinite(Date.parse(parsed[0]?.ts ?? ''))).toBe(true);
  });

  it('persists console.warn events with the warn level', () => {
    installConsoleAudit();
    console.warn('careful');
    const parsed = JSON.parse(
      localStorage.getItem(CONSOLE_HISTORY_KEY)!,
    ) as Array<{ level: string; message: string }>;
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.level).toBe('warn');
    expect(parsed[0]?.message).toBe('careful');
  });

  it('still calls through to the original console.error / console.warn', () => {
    let errCalls = 0;
    let warnCalls = 0;
    console.error = ((..._args: unknown[]) => {
      errCalls += 1;
    }) as typeof console.error;
    console.warn = ((..._args: unknown[]) => {
      warnCalls += 1;
    }) as typeof console.warn;
    // Re-capture origs so the audit's stored references point at
    // these test-spies, not the suite-level afterEach restore target.
    installConsoleAudit();
    console.error('forward me');
    console.warn('forward me too');
    expect(errCalls).toBe(1);
    expect(warnCalls).toBe(1);
  });

  it('caps history at 200 entries (drops oldest first)', () => {
    installConsoleAudit();
    for (let i = 0; i < 205; i += 1) {
      console.error('msg-' + i);
    }
    const parsed = JSON.parse(
      localStorage.getItem(CONSOLE_HISTORY_KEY)!,
    ) as Array<{ message: string }>;
    expect(parsed.length).toBe(200);
    // Oldest dropped: msg-0 .. msg-4 should be gone, msg-5 should be first.
    expect(parsed[0]?.message).toBe('msg-5');
    expect(parsed[parsed.length - 1]?.message).toBe('msg-204');
  });
});
