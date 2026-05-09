// PR 28 review patch — QA report builder. Pure: takes whatever the
// QA runner has measured + the live DB snapshot and returns a JSON
// report object plus a Markdown rendering of the same data.
//
// The report is what the QA view writes to `.local/qa/` (in dev) and
// what the desktop QA path attaches to PR #29 once the user has run
// the seed inside Tauri. It contains exactly the counts + timings
// the runner observed, never extrapolations.

import type { QaSeedSummary } from './qa-seed';
import type {
  PersistenceDiagnostic,
  PersistenceDiagnosticVerdict,
} from './desktop-persistence-diagnostic';
import { evaluatePersistenceDiagnostic } from './desktop-persistence-diagnostic';

export interface QaReportRouteCheck {
  readonly route: string;
  readonly hash: string;
  readonly ok: boolean;
  readonly note: string | null;
}

export interface QaReportConsoleCounts {
  readonly errors: number;
  readonly warnings: number;
}

export interface QaReportPerformance {
  readonly label: string;
  readonly ms: number;
}

export interface QaReportInput {
  readonly commitSha: string | null;
  readonly timestamp: string;
  readonly runtime: 'browser' | 'tauri' | 'unknown';
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly rustVersion: string | null;
  readonly cargoVersion: string | null;
  readonly seed: QaSeedSummary | null;
  readonly dbCounts: Record<string, number>;
  readonly masterGap: {
    readonly recommendedAmbiguousCount: number;
    readonly manualAmbiguousCount: number;
    readonly ambiguousOwned: number;
    readonly canPlaceDirectlyCount: number;
    readonly invalidCount: number;
    readonly totalTargetSlots: number;
    readonly complete: number;
  } | null;
  readonly routeChecks: readonly QaReportRouteCheck[];
  readonly performance: readonly QaReportPerformance[];
  readonly console: QaReportConsoleCounts;
  readonly desktopBadgeVisible: boolean | null;
  readonly backupRoundtrip: 'ok' | 'failed' | 'not_run';
  /**
   * Optional desktop persistence diagnostic (PR 28 review patch).
   * Captured by `buildPersistenceDiagnostic` and embedded in the
   * report so the operator can see store counts + sentinel state
   * inline without opening a separate JSON.
   */
  readonly persistenceDiagnostic: PersistenceDiagnostic | null;
  /**
   * Whether the operator expects this run to read back seeded
   * desktop data. The persistence verdict only fires when this is
   * `true` AND the sentinel is present AND holdings drop to zero —
   * otherwise the diagnostic is `inconclusive`.
   */
  readonly persistenceExpectSeededDesktopData: boolean;
  readonly notes: readonly string[];
}

export type QaReportPassFail = 'pass' | 'fail';

export interface QaReport extends QaReportInput {
  readonly overall: QaReportPassFail;
}

/**
 * Decide whether the run as a whole passed. We're conservative —
 * console errors, missing master-gap signals, or a failed backup
 * roundtrip all fail the run; warnings alone don't.
 */
export function evaluateQaPassFail(input: QaReportInput): QaReportPassFail {
  if (input.console.errors > 0) return 'fail';
  if (input.backupRoundtrip === 'failed') return 'fail';
  if (input.routeChecks.some((r) => !r.ok)) return 'fail';
  if (input.seed !== null && input.masterGap === null) return 'fail';
  if (
    input.seed !== null &&
    input.masterGap !== null &&
    (input.masterGap.recommendedAmbiguousCount === 0 ||
      input.masterGap.manualAmbiguousCount === 0)
  ) {
    // The seed is supposed to produce both. If it didn't, the
    // master-gap classifier or the seed regressed.
    return 'fail';
  }
  if (
    input.persistenceDiagnostic !== null &&
    evaluatePersistenceDiagnostic(input.persistenceDiagnostic, {
      expectSeededDesktopData: input.persistenceExpectSeededDesktopData,
    }) === 'fail_seeded_holdings_zero_with_sentinel'
  ) {
    // PR 28 review patch — desktop persistence regression.
    // localStorage sentinel survived but Dexie reads holdings=0.
    // The user explicitly asked for this to fail the run.
    return 'fail';
  }
  if (
    input.persistenceDiagnostic !== null &&
    evaluatePersistenceDiagnostic(input.persistenceDiagnostic) === 'fail_db_open'
  ) {
    return 'fail';
  }
  return 'pass';
}

/**
 * Re-export the persistence verdict from a complete QA report. Pure;
 * used by the QA view to render the right chip without re-running
 * the diagnostic.
 */
export function persistenceVerdict(
  report: QaReport,
): PersistenceDiagnosticVerdict | null {
  if (report.persistenceDiagnostic === null) return null;
  return evaluatePersistenceDiagnostic(report.persistenceDiagnostic, {
    expectSeededDesktopData: report.persistenceExpectSeededDesktopData,
  });
}

export function buildQaReport(input: QaReportInput): QaReport {
  return { ...input, overall: evaluateQaPassFail(input) };
}

/**
 * Render the report as Markdown. The format mirrors what we'd want
 * in the PR #29 body — headings + a "Verification matrix"-style
 * checklist + raw counts table.
 */
export function renderQaReportMarkdown(report: QaReport): string {
  const lines: string[] = [];
  lines.push('# QA report');
  lines.push('');
  lines.push(`- **Overall:** ${report.overall.toUpperCase()}`);
  lines.push(`- **Runtime:** ${report.runtime}`);
  lines.push(`- **Timestamp:** ${report.timestamp}`);
  lines.push(`- **Commit SHA:** ${report.commitSha ?? '(not detected)'}`);
  lines.push(`- **Node:** ${report.nodeVersion ?? '(unknown)'}`);
  lines.push(`- **npm:** ${report.npmVersion ?? '(unknown)'}`);
  lines.push(`- **rustc:** ${report.rustVersion ?? '(unknown)'}`);
  lines.push(`- **cargo:** ${report.cargoVersion ?? '(unknown)'}`);
  if (report.desktopBadgeVisible !== null) {
    lines.push(
      `- **Desktop badge:** ${report.desktopBadgeVisible ? 'visible' : 'hidden'}`,
    );
  }
  lines.push('');

  if (report.seed !== null) {
    lines.push('## Seed');
    lines.push('');
    lines.push(`- **Seed name:** \`${report.seed.seed}\``);
    lines.push(`- Cards: ${report.seed.cards}`);
    lines.push(`- Sets: ${report.seed.sets}`);
    lines.push(`- Holdings: ${report.seed.holdings}`);
    lines.push(`- Wishlist: ${report.seed.wishlist}`);
    lines.push(`- Lots: ${report.seed.lots}`);
    lines.push(`- Lot items: ${report.seed.lotItems}`);
    lines.push(`- Binders: ${report.seed.binders}`);
    lines.push(`- Slots: ${report.seed.slots}`);
    lines.push(`- Assigned slots: ${report.seed.assignedSlots}`);
    lines.push(`- Reverse-template slots: ${report.seed.reverseTemplateSlots}`);
    lines.push(`- Invalid-assignment slots: ${report.seed.invalidAssignmentSlots}`);
    lines.push(`- Invalid-variant slots: ${report.seed.invalidVariantSlots}`);
    lines.push(`- Elapsed: ${report.seed.elapsedMs} ms`);
    lines.push('');
  }

  if (report.masterGap !== null) {
    lines.push('## Master gap');
    lines.push('');
    lines.push(`- Total target slots: ${report.masterGap.totalTargetSlots}`);
    lines.push(`- Complete: ${report.masterGap.complete}`);
    lines.push(`- Ambiguous (total): ${report.masterGap.ambiguousOwned}`);
    lines.push(`- Recommended ambiguous: ${report.masterGap.recommendedAmbiguousCount}`);
    lines.push(`- Manual ambiguous: ${report.masterGap.manualAmbiguousCount}`);
    lines.push(`- Can place directly: ${report.masterGap.canPlaceDirectlyCount}`);
    lines.push(`- Invalid: ${report.masterGap.invalidCount}`);
    lines.push('');
  }

  lines.push('## DB counts');
  lines.push('');
  for (const [k, v] of Object.entries(report.dbCounts).sort()) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push('');

  if (report.routeChecks.length > 0) {
    lines.push('## Route checks');
    lines.push('');
    lines.push('| Route | Hash | Status | Note |');
    lines.push('|---|---|---|---|');
    for (const r of report.routeChecks) {
      lines.push(
        `| ${r.route} | \`${r.hash}\` | ${r.ok ? '✅' : '❌'} | ${r.note ?? ''} |`,
      );
    }
    lines.push('');
  }

  if (report.performance.length > 0) {
    lines.push('## Performance');
    lines.push('');
    lines.push('| Operation | Time (ms) |');
    lines.push('|---|---:|');
    for (const p of report.performance) {
      lines.push(`| ${p.label} | ${p.ms} |`);
    }
    lines.push('');
  }

  lines.push('## Console');
  lines.push('');
  lines.push(`- Errors: ${report.console.errors}`);
  lines.push(`- Warnings: ${report.console.warnings}`);
  lines.push('');

  lines.push('## Backup roundtrip');
  lines.push('');
  lines.push(`Status: \`${report.backupRoundtrip}\``);
  lines.push('');

  if (report.persistenceDiagnostic !== null) {
    const verdict = evaluatePersistenceDiagnostic(
      report.persistenceDiagnostic,
      { expectSeededDesktopData: report.persistenceExpectSeededDesktopData },
    );
    const d = report.persistenceDiagnostic;
    lines.push('## Desktop persistence diagnostic');
    lines.push('');
    lines.push(`- **Verdict:** \`${verdict}\``);
    lines.push(`- **Expected seeded desktop data:** ${report.persistenceExpectSeededDesktopData ? 'yes' : 'no'}`);
    lines.push(`- **Captured at:** ${d.capturedAt}`);
    lines.push(`- **Runtime:** ${d.runtime}`);
    lines.push(`- **Origin:** \`${d.location.origin}\``);
    lines.push(`- **Dexie DB:** \`${d.dexie.name}\` v${d.dexie.verno} (${d.dexie.tables.length} tables)`);
    lines.push(`- **navigator.storage.persisted:** ${d.storage.persisted === null ? '(n/a)' : String(d.storage.persisted)}`);
    if (d.storage.estimate !== null) {
      lines.push(
        `- **storage.estimate:** quota=${d.storage.estimate.quota} usage=${d.storage.estimate.usage}`,
      );
    }
    if (d.indexedDbDatabases !== null) {
      lines.push(`- **indexedDB.databases() count:** ${d.indexedDbDatabases.length}`);
    }
    lines.push(`- **localStorage sentinel:** ${d.localStorageSentinel === null ? '(missing)' : `bootCounter=${d.localStorageSentinel.bootCounter} timestamp=${d.localStorageSentinel.timestamp}`}`);
    lines.push(`- **appMeta sentinel:** ${d.appMetaSentinel === null ? '(missing)' : `bootCounter=${d.appMetaSentinel.bootCounter} timestamp=${d.appMetaSentinel.timestamp}`}`);
    lines.push('');
    lines.push('| Store | Count |');
    lines.push('|---|---:|');
    for (const [k, v] of Object.entries(d.storeCounts).sort()) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
    if (d.firstHoldingIds.length > 0) {
      lines.push(`First 5 holding IDs: \`${d.firstHoldingIds.join(', ')}\``);
      lines.push('');
    }
    if (d.firstAppMetaKeys.length > 0) {
      lines.push(`First 5 appMeta keys: \`${d.firstAppMetaKeys.join(', ')}\``);
      lines.push('');
    }
    if (d.notes.length > 0) {
      lines.push('### Diagnostic notes');
      lines.push('');
      for (const note of d.notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }

  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format the report as JSON suitable for `.local/qa/desktop-qa-report.json`.
 */
export function renderQaReportJson(report: QaReport): string {
  return JSON.stringify(report, null, 2);
}
