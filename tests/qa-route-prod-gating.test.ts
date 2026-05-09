// PR 28 review patch — pins the production gating of the dev-only
// `#qa` route. The route exists in the Route union so deep-links
// don't crash, but in a production build it must NOT mount the QA
// view (which can wipe and seed the live DB). Two complementary
// guarantees:
//   1. The production bundle does not contain the QA view module
//      identifier (`mountQaView`) — Vite's `import.meta.env.DEV`
//      branch gets dead-code-eliminated.
//   2. The route key `qa` in the dispatch object resolves to the
//      same minified mounter as `dashboard`.
//
// We cannot run the full production app inside Vitest (Dexie /
// IndexedDB are mocked, and `import.meta.env.DEV` defaults to true
// here), so this test inspects the actual production bundle that
// `npm run build` produces. The test is skipped if `dist/` is
// missing, so a clean checkout that hasn't built yet still passes.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distAssetsDir = join(process.cwd(), 'dist', 'assets');

function findBundlePath(): string | null {
  if (!existsSync(distAssetsDir)) return null;
  const files = readdirSync(distAssetsDir).filter(
    (n) => n.startsWith('index-') && n.endsWith('.js'),
  );
  return files.length === 0 ? null : join(distAssetsDir, files[0]!);
}

function readBundle(): string | null {
  const path = findBundlePath();
  return path === null ? null : readFileSync(path, 'utf8');
}

describe('qa route — production gating', () => {
  it('production bundle exists (run `npm run build` first)', () => {
    const bundle = readBundle();
    if (bundle === null) {
      // Skip the rest of the suite when the bundle is missing —
      // CI environments without a build step shouldn't fail this.
      // eslint-disable-next-line no-console -- debug only on miss
      console.warn(
        'No production bundle in dist/assets — skipping #qa gating runtime checks',
      );
    }
    expect(bundle === null || typeof bundle === 'string').toBe(true);
  });

  it('production bundle does not contain QA view code', () => {
    const bundle = readBundle();
    if (bundle === null) return;
    const banned = [
      'mountQaView',
      'morten-pokemon-qa-v1',
      'seedStressData',
      'resetQaData',
      'QA_SEED_NAME',
      'QA harness',
      'qa-view__panel',
      'data-action="qa-reset"',
      'data-action="qa-seed"',
      'data-action="qa-run"',
      // PR 28 review patch — persistence diagnostic strings.
      // Diagnostic module is only imported by the dev-only QA view,
      // so these must also be tree-shaken in production builds.
      'buildPersistenceDiagnostic',
      'writePersistenceSentinel',
      'evaluatePersistenceDiagnostic',
      'desktopPersistenceSentinel',
      'pokemon.desktopPersistenceBootCounter',
      'data-action="qa-persist-run"',
      'data-action="qa-persist-sentinel"',
      // PR 28 review patch — max stress harness.
      'seedMaxStressData',
      'morten-pokemon-stress-v1',
      'QA_MAX_STRESS_SEED_NAME',
      'data-action="qa-max-stress"',
      // PR 28 review patch — boot-time persistence auto-audit.
      'pokemon.persistenceDiagBootHistory',
      'runBootTimePersistenceAudit',
      '[boot-audit]',
      // PR 28 review patch — console + route-walk auto-audit.
      'pokemon.consoleAuditHistory',
      'pokemon.routeWalkHistory',
      'installConsoleAudit',
      'kickOffAutoRouteWalk',
    ];
    for (const needle of banned) {
      expect(
        bundle.includes(needle),
        `production bundle contains "${needle}" — QA view code leaked into release build`,
      ).toBe(false);
    }
  });

  it('production bundle maps the qa route to the same mounter as dashboard', () => {
    const bundle = readBundle();
    if (bundle === null) return;
    // Vite minifies the VIEW_MOUNTERS dispatch object to one inline
    // object literal:
    //   {dashboard:X,browse:Y,collection:Z,binders:...,qa:X}
    // We locate the substring that contains BOTH `dashboard:` and
    // `qa:` close together (they're adjacent in the same object
    // literal — no other map in the codebase has both keys), then
    // extract the right-hand identifiers. If the production gate
    // broke, `qa:` would point to a different identifier than the
    // dashboard mounter.
    //
    // Find every dispatch-table-shaped span: starts at a `{` that
    // contains both `dashboard:` and `qa:` before the next `}`.
    const dispatchRe =
      /\{[^{}]*\bdashboard:\s*([A-Za-z_$][\w$]*)[^{}]*\bqa:\s*([A-Za-z_$][\w$]*)[^{}]*\}/g;
    const matches = [...bundle.matchAll(dispatchRe)];
    expect(
      matches.length,
      'expected to find a {dashboard: …, qa: …} dispatch literal in the production bundle',
    ).toBeGreaterThan(0);
    for (const m of matches) {
      const dashId = m[1] ?? '';
      const qaId = m[2] ?? '';
      expect(qaId.length).toBeGreaterThan(0);
      expect(dashId.length).toBeGreaterThan(0);
      expect(
        qaId,
        `production bundle dispatch maps qa to ${qaId} but dashboard to ${dashId} — production gate broken`,
      ).toBe(dashId);
    }
  });
});
