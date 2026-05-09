// PR 28 review patch — pure tests for the desktop persistence
// diagnostic module. The full IndexedDB-backed diagnostic is tested
// against a real Dexie/fake-indexeddb instance in
// `tests/desktop-persistence-diagnostic-live.test.ts`. This file
// covers the verdict helper and the QA-report fail rule that uses
// it, both of which are pure.

import { describe, expect, it } from 'vitest';

import {
  evaluatePersistenceDiagnostic,
  type PersistenceDiagnostic,
} from '../src/qa/desktop-persistence-diagnostic';
import {
  buildQaReport,
  evaluateQaPassFail,
  persistenceVerdict,
  renderQaReportMarkdown,
  type QaReportInput,
} from '../src/qa/qa-report';

function baseDiagnostic(
  overrides: Partial<PersistenceDiagnostic> = {},
): PersistenceDiagnostic {
  return {
    capturedAt: '2026-05-09T00:00:00.000Z',
    runtime: 'tauri',
    location: {
      href: 'http://localhost:5173/#qa',
      origin: 'http://localhost:5173',
    },
    userAgent: 'WebView2/test',
    storage: {
      persisted: true,
      estimate: { quota: 1_000_000_000, usage: 5_000_000 },
    },
    indexedDbDatabases: [{ name: 'pokemon-tcg-tracker', version: 2 }],
    dexie: {
      name: 'pokemon-tcg-tracker',
      verno: 2,
      tables: [
        { name: 'cards', schema: '&id, setId, name' },
        { name: 'holdings', schema: '&id, cardId, lotId' },
      ],
    },
    storeCounts: {
      cards: 250,
      sets: 5,
      holdings: 1000,
      binders: 7,
      binderSlots: 3422,
      lots: 5,
      lotItems: 250,
      wishlist: 200,
      auditLog: 5063,
      settings: 0,
      appMeta: 1,
    },
    firstHoldingIds: ['h-1', 'h-2', 'h-3', 'h-4', 'h-5'],
    firstAppMetaKeys: ['desktopPersistenceSentinel'],
    localStorageSentinel: {
      bootCounter: 1,
      timestamp: '2026-05-09T00:00:00.000Z',
      origin: 'http://localhost:5173',
      runtime: 'tauri',
    },
    appMetaSentinel: {
      bootCounter: 1,
      timestamp: '2026-05-09T00:00:00.000Z',
      origin: 'http://localhost:5173',
      runtime: 'tauri',
    },
    notes: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<QaReportInput> = {}): QaReportInput {
  return {
    commitSha: null,
    timestamp: '2026-05-09T00:00:00.000Z',
    runtime: 'tauri',
    nodeVersion: null,
    npmVersion: null,
    rustVersion: null,
    cargoVersion: null,
    seed: null,
    dbCounts: {
      cards: 0,
      sets: 0,
      holdings: 0,
      binders: 0,
      binderSlots: 0,
      lots: 0,
      lotItems: 0,
      wishlist: 0,
      auditLog: 0,
      settings: 0,
    },
    masterGap: null,
    routeChecks: [],
    performance: [],
    console: { errors: 0, warnings: 0 },
    desktopBadgeVisible: null,
    backupRoundtrip: 'not_run',
    persistenceDiagnostic: null,
    persistenceExpectSeededDesktopData: false,
    notes: [],
    ...overrides,
  };
}

describe('evaluatePersistenceDiagnostic', () => {
  it('returns inconclusive_no_sentinel when no sentinel exists', () => {
    expect(
      evaluatePersistenceDiagnostic(
        baseDiagnostic({
          localStorageSentinel: null,
          appMetaSentinel: null,
        }),
      ),
    ).toBe('inconclusive_no_sentinel');
  });

  it('returns inconclusive_no_seed_expected when sentinel exists but caller does not expect seed', () => {
    expect(
      evaluatePersistenceDiagnostic(baseDiagnostic(), {
        expectSeededDesktopData: false,
      }),
    ).toBe('inconclusive_no_seed_expected');
  });

  it('returns pass when sentinel exists and holdings are populated', () => {
    expect(
      evaluatePersistenceDiagnostic(baseDiagnostic(), {
        expectSeededDesktopData: true,
      }),
    ).toBe('pass');
  });

  it('returns fail_seeded_holdings_zero_with_sentinel — the actual desktop bug', () => {
    expect(
      evaluatePersistenceDiagnostic(
        baseDiagnostic({
          storeCounts: {
            ...baseDiagnostic().storeCounts,
            holdings: 0,
          },
        }),
        { expectSeededDesktopData: true },
      ),
    ).toBe('fail_seeded_holdings_zero_with_sentinel');
  });

  it('returns fail_db_open when notes flag a db.open() failure', () => {
    expect(
      evaluatePersistenceDiagnostic(
        baseDiagnostic({
          notes: ['db.open() failed: VersionError'],
        }),
      ),
    ).toBe('fail_db_open');
  });

  it('passes when sentinel is appMeta-only (localStorage was wiped) but holdings are populated', () => {
    expect(
      evaluatePersistenceDiagnostic(
        baseDiagnostic({
          localStorageSentinel: null,
        }),
        { expectSeededDesktopData: true },
      ),
    ).toBe('pass');
  });

  it('fail_seeded_holdings_zero requires the localStorage sentinel specifically', () => {
    // If localStorage sentinel is also missing, we can't distinguish
    // "user never seeded" from "Dexie ate the rows", so the verdict
    // is inconclusive instead of fail.
    expect(
      evaluatePersistenceDiagnostic(
        baseDiagnostic({
          localStorageSentinel: null,
          appMetaSentinel: null,
          storeCounts: { ...baseDiagnostic().storeCounts, holdings: 0 },
        }),
        { expectSeededDesktopData: true },
      ),
    ).toBe('inconclusive_no_sentinel');
  });
});

describe('qa-report integration with persistence diagnostic', () => {
  it('embeds the diagnostic in the markdown when present', () => {
    const md = renderQaReportMarkdown(
      buildQaReport(
        baseInput({
          persistenceDiagnostic: baseDiagnostic(),
          persistenceExpectSeededDesktopData: true,
        }),
      ),
    );
    expect(md).toContain('## Desktop persistence diagnostic');
    expect(md).toContain('**Verdict:** `pass`');
    expect(md).toContain('| holdings | 1000 |');
    expect(md).toContain('bootCounter=1');
  });

  it('flips overall to FAIL when seeded sentinel + zero holdings', () => {
    const report = buildQaReport(
      baseInput({
        persistenceDiagnostic: baseDiagnostic({
          storeCounts: {
            ...baseDiagnostic().storeCounts,
            holdings: 0,
          },
        }),
        persistenceExpectSeededDesktopData: true,
      }),
    );
    expect(report.overall).toBe('fail');
  });

  it('does NOT fail when expect=false even if holdings=0', () => {
    const report = buildQaReport(
      baseInput({
        persistenceDiagnostic: baseDiagnostic({
          storeCounts: {
            ...baseDiagnostic().storeCounts,
            holdings: 0,
          },
        }),
        persistenceExpectSeededDesktopData: false,
      }),
    );
    expect(report.overall).toBe('pass');
  });

  it('fails the run when db.open() fails, regardless of expect flag', () => {
    const report = buildQaReport(
      baseInput({
        persistenceDiagnostic: baseDiagnostic({
          notes: ['db.open() failed: TimeoutError'],
        }),
        persistenceExpectSeededDesktopData: false,
      }),
    );
    expect(report.overall).toBe('fail');
  });

  it('persistenceVerdict() returns the verdict from a built report', () => {
    const report = buildQaReport(
      baseInput({
        persistenceDiagnostic: baseDiagnostic(),
        persistenceExpectSeededDesktopData: true,
      }),
    );
    expect(persistenceVerdict(report)).toBe('pass');
  });

  it('persistenceVerdict() is null when no diagnostic was attached', () => {
    const report = buildQaReport(baseInput());
    expect(persistenceVerdict(report)).toBeNull();
  });
});

describe('evaluateQaPassFail with persistence + other failure modes', () => {
  it('still fails on console errors regardless of persistence verdict', () => {
    expect(
      evaluateQaPassFail(
        baseInput({
          console: { errors: 1, warnings: 0 },
          persistenceDiagnostic: baseDiagnostic(),
          persistenceExpectSeededDesktopData: true,
        }),
      ),
    ).toBe('fail');
  });
});
