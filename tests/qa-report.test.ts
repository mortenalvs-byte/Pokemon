// PR 28 review patch — pure tests for the QA report builder.
//
// `qa-report.ts` is the only piece of the QA harness that has no
// I/O: it takes a snapshot object and returns a JSON / Markdown
// rendering. These tests pin the pass/fail rules and the markdown
// shape so the `.local/qa/` artefacts stay diffable across runs.

import { describe, expect, it } from 'vitest';

import {
  buildQaReport,
  evaluateQaPassFail,
  renderQaReportJson,
  renderQaReportMarkdown,
  type QaReportInput,
} from '../src/qa/qa-report';

function baseInput(overrides: Partial<QaReportInput> = {}): QaReportInput {
  return {
    commitSha: null,
    timestamp: '2026-05-08T12:00:00.000Z',
    runtime: 'browser',
    nodeVersion: 'v20.0.0',
    npmVersion: '10.0.0',
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
    notes: [],
    ...overrides,
  };
}

describe('qa-report', () => {
  describe('evaluateQaPassFail', () => {
    it('returns pass for a clean read-only run', () => {
      expect(evaluateQaPassFail(baseInput())).toBe('pass');
    });

    it('fails when console errors are non-zero', () => {
      expect(
        evaluateQaPassFail(baseInput({ console: { errors: 1, warnings: 0 } })),
      ).toBe('fail');
    });

    it('does not fail on warnings alone', () => {
      expect(
        evaluateQaPassFail(baseInput({ console: { errors: 0, warnings: 5 } })),
      ).toBe('pass');
    });

    it('fails when backup roundtrip is failed', () => {
      expect(
        evaluateQaPassFail(baseInput({ backupRoundtrip: 'failed' })),
      ).toBe('fail');
    });

    it('does not fail when backup roundtrip is not_run', () => {
      expect(
        evaluateQaPassFail(baseInput({ backupRoundtrip: 'not_run' })),
      ).toBe('pass');
    });

    it('fails when any route check is not ok', () => {
      expect(
        evaluateQaPassFail(
          baseInput({
            routeChecks: [
              { route: 'Dashboard', hash: '#dashboard', ok: true, note: null },
              { route: 'Browse', hash: '#browse', ok: false, note: 'broken' },
            ],
          }),
        ),
      ).toBe('fail');
    });

    it('fails when seed ran but master-gap snapshot is null', () => {
      expect(
        evaluateQaPassFail(
          baseInput({
            seed: {
              seed: 'morten-pokemon-qa-v1',
              cards: 250,
              sets: 5,
              holdings: 1000,
              wishlist: 200,
              lots: 5,
              lotItems: 250,
              binders: 7,
              slots: 3422,
              assignedSlots: 400,
              reverseTemplateSlots: 294,
              invalidAssignmentSlots: 1,
              invalidVariantSlots: 1,
              elapsedMs: 50_000,
            },
            masterGap: null,
          }),
        ),
      ).toBe('fail');
    });

    it('fails when seed ran and master-gap shows zero recommended ambiguous', () => {
      expect(
        evaluateQaPassFail(
          baseInput({
            seed: {
              seed: 'morten-pokemon-qa-v1',
              cards: 250,
              sets: 5,
              holdings: 1000,
              wishlist: 200,
              lots: 5,
              lotItems: 250,
              binders: 7,
              slots: 3422,
              assignedSlots: 400,
              reverseTemplateSlots: 294,
              invalidAssignmentSlots: 1,
              invalidVariantSlots: 1,
              elapsedMs: 50_000,
            },
            masterGap: {
              recommendedAmbiguousCount: 0,
              manualAmbiguousCount: 30,
              ambiguousOwned: 30,
              canPlaceDirectlyCount: 5,
              invalidCount: 2,
              totalTargetSlots: 3422,
              complete: 100,
            },
          }),
        ),
      ).toBe('fail');
    });

    it('passes when seed ran and master-gap has both ambiguous types', () => {
      expect(
        evaluateQaPassFail(
          baseInput({
            seed: {
              seed: 'morten-pokemon-qa-v1',
              cards: 250,
              sets: 5,
              holdings: 1000,
              wishlist: 200,
              lots: 5,
              lotItems: 250,
              binders: 7,
              slots: 3422,
              assignedSlots: 400,
              reverseTemplateSlots: 294,
              invalidAssignmentSlots: 1,
              invalidVariantSlots: 1,
              elapsedMs: 50_000,
            },
            masterGap: {
              recommendedAmbiguousCount: 30,
              manualAmbiguousCount: 30,
              ambiguousOwned: 60,
              canPlaceDirectlyCount: 5,
              invalidCount: 2,
              totalTargetSlots: 3422,
              complete: 100,
            },
          }),
        ),
      ).toBe('pass');
    });
  });

  describe('buildQaReport', () => {
    it('attaches the overall verdict', () => {
      const report = buildQaReport(baseInput());
      expect(report.overall).toBe('pass');
    });

    it('preserves every input field', () => {
      const input = baseInput({ notes: ['note A'] });
      const report = buildQaReport(input);
      expect(report.notes).toEqual(['note A']);
      expect(report.timestamp).toBe(input.timestamp);
    });
  });

  describe('renderQaReportMarkdown', () => {
    it('starts with the QA report heading and overall verdict', () => {
      const md = renderQaReportMarkdown(buildQaReport(baseInput()));
      expect(md.startsWith('# QA report')).toBe(true);
      expect(md).toContain('**Overall:** PASS');
      expect(md).toContain('**Runtime:** browser');
    });

    it('renders desktop badge state when present', () => {
      const md = renderQaReportMarkdown(
        buildQaReport(baseInput({ desktopBadgeVisible: true })),
      );
      expect(md).toContain('**Desktop badge:** visible');
    });

    it('omits the seed section when no seed ran', () => {
      const md = renderQaReportMarkdown(buildQaReport(baseInput()));
      expect(md).not.toContain('## Seed');
    });

    it('renders DB counts in alphabetical order', () => {
      const md = renderQaReportMarkdown(buildQaReport(baseInput()));
      const auditAt = md.indexOf('**auditLog**');
      const cardsAt = md.indexOf('**cards**');
      const settingsAt = md.indexOf('**settings**');
      expect(auditAt).toBeGreaterThan(0);
      expect(cardsAt).toBeGreaterThan(auditAt);
      expect(settingsAt).toBeGreaterThan(cardsAt);
    });

    it('renders route checks as a markdown table when provided', () => {
      const md = renderQaReportMarkdown(
        buildQaReport(
          baseInput({
            routeChecks: [
              { route: 'Dashboard', hash: '#dashboard', ok: true, note: null },
              { route: 'Browse', hash: '#browse', ok: false, note: 'fail' },
            ],
          }),
        ),
      );
      expect(md).toContain('| Route | Hash | Status | Note |');
      expect(md).toContain('| Dashboard | `#dashboard` | ✅ |');
      expect(md).toContain('| Browse | `#browse` | ❌ | fail |');
    });

    it('renders the master-gap section when present', () => {
      const md = renderQaReportMarkdown(
        buildQaReport(
          baseInput({
            masterGap: {
              recommendedAmbiguousCount: 30,
              manualAmbiguousCount: 30,
              ambiguousOwned: 60,
              canPlaceDirectlyCount: 5,
              invalidCount: 2,
              totalTargetSlots: 3422,
              complete: 100,
            },
          }),
        ),
      );
      expect(md).toContain('## Master gap');
      expect(md).toContain('Recommended ambiguous: 30');
      expect(md).toContain('Manual ambiguous: 30');
    });
  });

  describe('renderQaReportJson', () => {
    it('produces valid JSON parseable into the same shape', () => {
      const report = buildQaReport(baseInput({ notes: ['hello'] }));
      const json = renderQaReportJson(report);
      const parsed = JSON.parse(json) as { notes: string[]; overall: string };
      expect(parsed.overall).toBe('pass');
      expect(parsed.notes).toEqual(['hello']);
    });

    it('uses 2-space indentation', () => {
      const json = renderQaReportJson(buildQaReport(baseInput()));
      expect(json).toContain('\n  "');
    });
  });
});
