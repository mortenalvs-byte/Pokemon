// PR 29 review patch — Phase A (red repro).
//
// This file is the action-level proof the operator's manual click-through
// found missing. It asserts the contract the operator approved on
// 2026-05-09:
//
//   1. The auto-button label number = the banner `canPlaceDirectly` number
//      = the safe placements `autoAssignBinder` actually performs. One
//      source of truth.
//   2. Clicking the auto-button causes a visible DOM change AND a DB
//      change for every safe placement; the summary chip appears with
//      the placed/skipped breakdown; the banner refreshes; the button
//      label updates.
//   3. Clicking `Gap-analyse` navigates to the binder-specific master-gap
//      route, and the report's summary numbers reconcile with the banner
//      the user just left.
//   4. The CSV export from binder-detail produces a file usable as a
//      physical-binder checklist: operator-spec column set, row count =
//      target slots, physical ordering, no `[object Object]` cells,
//      Norwegian-character-safe.
//
// Several assertions in this file are EXPECTED RED on HEAD `d4c817e` and
// flip green only after the Phase B / C / D fixes land. The point of
// Phase A is to capture the operator-observed gaps as failing
// regression tests, NOT to fix anything yet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import {
  _resetDbSingletonForTests,
  getDb,
  type PokemonTrackerDB,
} from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBinderService } from '../src/services/binder-service';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createMasterSetGapService } from '../src/services/master-set-gap-service';
import { closeAndDelete } from './helpers/fresh-db';
// PR 36 — shared fixture / DOM helpers. Replaces the local
// `makeCard(n)` / `holdingInput(...)` / `settle(...)` declarations
// that lived inline in this file before the cleanup.
import { makeCard as helperMakeCard } from './helpers/cards';
import { holdingInput } from './helpers/holdings';
import { settle } from './helpers/dom';
import type { CardRecord, SetRecord } from '../src/domain/types';

// `download` module is mocked so we can assert the CSV click path
// invoked it with the expected filename and content. Mocking is
// scoped to this file — the real downloadTextFile is unaffected
// outside vitest.
vi.mock('../src/utils/download', () => ({
  downloadTextFile: vi.fn(),
}));
import * as downloadModule from '../src/utils/download';

// Tiny adapter so call-sites stay `makeCard(n)`. Test-specific
// fields (Stress-prefixed name, per-row image URLs, dated
// updatedAt) are passed as overrides; the helper supplies the
// boilerplate (setId derivation, default tcgplayer.prices for
// the five common variant keys, supertype/subtypes defaults).
function makeCard(n: number): CardRecord {
  return helperMakeCard(`stress-${n}`, {
    overrides: {
      name: `Stress Card ${n}`,
      number: String(n),
      imageSmall: 'https://example.test/i.png',
      imageLarge: 'https://example.test/l.png',
      updatedAt: '2026-05-09T00:00:00.000Z',
    },
  });
}

// ─── Stress-shape fixture ────────────────────────────────────────────
//
// Topologically equivalent to the operator's failing screenshot: a
// binder with target slots that split into safe-single, ambiguous, and
// missing buckets. Counts deliberately small (9 slots) so the test
// output is human-readable, but the same code paths exercise.
//
//   targets        : 9
//   safe-single    : 5  (cards 1..5 each have exactly 1 unassigned holding)
//   ambiguous      : 2  (cards 6..7 each have 2 unassigned holdings)
//   missing        : 2  (cards 8..9 have no holdings)
//
// Expected on HEAD d4c817e (BEFORE Phase B fix):
//   - banner says "5 kan plasseres direkte"            ← correct
//   - auto-button label says "(7)"                     ← BUG: counts ambiguous
//   - clicking auto-button: 5 placed, 2 ambiguous skipped (DB)
//   - operator's perception: button promised 7, only 5 happened.
//
// Expected AFTER Phase B fix (single source of truth):
//   - banner says "5 kan plasseres direkte"
//   - auto-button label says "(5)"
//   - secondary chip can show "5 trygge · 2 krever manuelt valg"
//   - clicking auto-button: 5 placed, banner shifts, button label drops.

const sampleSet: SetRecord = {
  id: 'stress',
  name: 'Stress Vault',
  series: 'Stress',
  printedTotal: 9,
  total: 9,
  releaseDate: '2026-01-01',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-09T00:00:00.000Z',
};

interface StressFixture {
  readonly binderId: string;
  readonly targetSlotIds: readonly string[];
  readonly safeSingleCardIds: readonly string[];
  readonly ambiguousCardIds: readonly string[];
  readonly missingCardIds: readonly string[];
}

async function seedStressFixture(db: PokemonTrackerDB): Promise<StressFixture> {
  const cards: CardRecord[] = [];
  for (let n = 1; n <= 9; n++) cards.push(makeCard(n));
  await createSetsRepo(db).upsert(sampleSet);
  await createCardsRepo(db).upsertMany(cards);

  // 1 binder, 1 page × 9 slots, every slot is a target slot.
  const created = await createBinderService(db).createManualBinder({
    name: 'Stress Vault9 mini',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: 9,
    binderPreset: null,
    completionMode: 'standard',
    sourceSetId: null,
  });
  const slotsRepo = createBinderSlotsRepo(db);
  const slots = (await slotsRepo.listByBinderId(created.binder.id)).sort(
    (a, b) => a.slotNumber - b.slotNumber,
  );
  const targetSlotIds: string[] = [];
  for (let i = 0; i < 9; i++) {
    const slot = slots[i];
    if (slot === undefined) throw new Error('seed: missing slot');
    await slotsRepo.update(
      slot.id,
      { targetCardId: `stress-${i + 1}`, status: 'wanted', note: null },
      9,
    );
    targetSlotIds.push(slot.id);
  }

  const safeSingleCardIds = ['stress-1', 'stress-2', 'stress-3', 'stress-4', 'stress-5'];
  const ambiguousCardIds = ['stress-6', 'stress-7'];
  const missingCardIds = ['stress-8', 'stress-9'];

  // 5 single-candidate holdings (one each, NM normal)
  for (const id of safeSingleCardIds) {
    await createHoldingsRepo(db).create(holdingInput(id));
  }
  // 2 ambiguous slots — 2 holdings each, different conditions
  for (const id of ambiguousCardIds) {
    await createHoldingsRepo(db).create(holdingInput(id, { rawCondition: 'NM' }));
    await createHoldingsRepo(db).create(holdingInput(id, { rawCondition: 'LP' }));
  }
  // missingCardIds get no holdings.

  return {
    binderId: created.binder.id,
    targetSlotIds,
    safeSingleCardIds,
    ambiguousCardIds,
    missingCardIds,
  };
}

function buttonCount(label: string | null): number | null {
  if (label === null) return null;
  const m = label.match(/\((\d+)\)/);
  if (m === null) return null;
  return Number.parseInt(m[1] ?? '', 10);
}

function bannerCanPlaceDirectly(banner: Element | null): number | null {
  if (banner === null) return null;
  const text = banner.textContent ?? '';
  const m = text.match(/(\d+)\s*kan plasseres direkte/);
  if (m === null) return null;
  return Number.parseInt(m[1] ?? '', 10);
}

function bannerComplete(banner: Element | null): number | null {
  if (banner === null) return null;
  const text = banner.textContent ?? '';
  const m = text.match(/Master gap:\s*(\d+)\s*\/\s*(\d+)\s*fullført/);
  if (m === null) return null;
  return Number.parseInt(m[1] ?? '', 10);
}

function bannerOwnedUnplaced(banner: Element | null): number | null {
  if (banner === null) return null;
  const text = banner.textContent ?? '';
  const m = text.match(/(\d+)\s*eies men ikke plassert/);
  if (m === null) return null;
  return Number.parseInt(m[1] ?? '', 10);
}

async function waitForBanner(root: HTMLElement): Promise<HTMLElement> {
  await vi.waitFor(() => {
    const banner = root.querySelector(
      '[data-region="binder-gap-summary"] .binder-detail-view__gap-summary-line',
    );
    expect(banner).not.toBeNull();
  });
  const el = root.querySelector<HTMLElement>(
    '[data-region="binder-gap-summary"]',
  );
  if (el === null) throw new Error('banner never rendered');
  return el;
}

describe('PR 29 — binder-detail action audit (Phase A: red repro)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
    vi.mocked(downloadModule.downloadTextFile).mockReset();
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  // ────────────────────────────────────────────────────────────────
  // Test 1 — count mismatch repro
  //
  // Banner reads `canPlaceDirectly` from the master-gap classifier
  // (= 5: only safe singles). Auto-button reads `assignableInfo.size`
  // from `computeAssignableInfo` (= 7: includes ambiguous). These two
  // disagree on HEAD d4c817e — that is the operator's "125 vs 166" in
  // miniature.
  //
  // After Phase B fix, both come from `buildAutoPlacementPlan(...).safe`
  // and equal 5.
  // ────────────────────────────────────────────────────────────────
  it('auto-button count and banner canPlaceDirectly count agree (one source of truth)', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const banner = await waitForBanner(root);
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    expect(btn).not.toBeNull();
    const labelCount = buttonCount(btn?.textContent ?? null);
    const bannerCount = bannerCanPlaceDirectly(banner);
    // Operator-approved contract: button = banner = 5 safe placements.
    expect(bannerCount).toBe(5);
    expect(labelCount).toBe(5);
    expect(labelCount).toBe(bannerCount);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 2 — clicking auto-place actually places safe holdings (DB).
  // ────────────────────────────────────────────────────────────────
  it('auto-place click writes 5 safe placements to the DB', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();
    await vi.waitFor(async () => {
      const slots = (
        await createBinderSlotsRepo(db).listByBinderId(fixture.binderId)
      ).filter((s) => s.deletedAt === null);
      const owned = slots.filter(
        (s) => s.status === 'owned' && s.holdingId !== null,
      );
      // Exactly 5 — the safe singles. Ambiguous slots stay unowned.
      expect(owned.length).toBe(5);
      const ownedTargetCardIds = new Set(
        owned.map((s) => s.targetCardId).filter((c): c is string => c !== null),
      );
      for (const safeId of fixture.safeSingleCardIds) {
        expect(ownedTargetCardIds.has(safeId)).toBe(true);
      }
      for (const ambiguousId of fixture.ambiguousCardIds) {
        expect(ownedTargetCardIds.has(ambiguousId)).toBe(false);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 3 — banner refreshes after click.
  //
  // The classifier in domain/master-set-gap.ts separates
  // `ownedUnplaced` (exactly 1 candidate) from `ambiguousOwned`
  // (>1 candidate). The banner text only shows `ownedUnplaced`, so
  // for the stress fixture:
  //   pre-click  : complete=0, ownedUnplaced=5
  //   post-click : complete=5, ownedUnplaced=0
  // The 2 ambiguous slots are tracked separately and don't move.
  // ────────────────────────────────────────────────────────────────
  it('banner counts shift after auto-place click (complete +5, ownedUnplaced -5)', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const beforeBanner = await waitForBanner(root);
    const beforeComplete = bannerComplete(beforeBanner);
    const beforeOwnedUnplaced = bannerOwnedUnplaced(beforeBanner);
    expect(beforeComplete).toBe(0);
    expect(beforeOwnedUnplaced).toBe(5);

    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();

    await vi.waitFor(async () => {
      // Banner re-renders asynchronously after USER_DATA_CHANGED_EVENT.
      const banner = root.querySelector<HTMLElement>(
        '[data-region="binder-gap-summary"]',
      );
      const completeAfter = bannerComplete(banner);
      const ownedUnplacedAfter = bannerOwnedUnplaced(banner);
      expect(completeAfter).toBe(5);
      expect(ownedUnplacedAfter).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 4 — auto-button label updates after click (no stale "(7)").
  // ────────────────────────────────────────────────────────────────
  it('auto-button label updates after click (drops to 0 safe remaining)', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();

    await vi.waitFor(() => {
      const refreshed = root.querySelector<HTMLButtonElement>(
        '[data-action="auto-assign"]',
      );
      // Operator-approved contract: button label always reflects what
      // the next click will do. After all 5 safe placements landed, the
      // remaining 2 ambiguous slots are NOT in the safe count, so the
      // label drops to (0) — or the button is disabled — but never
      // shows a stale (7) or (5).
      const count = buttonCount(refreshed?.textContent ?? null);
      const disabled = refreshed?.disabled ?? false;
      expect(count === 0 || count === null || disabled).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 5 — auto-place summary chip renders with placed/skipped.
  // ────────────────────────────────────────────────────────────────
  it('auto-place summary chip shows "5 plassert" and skipped breakdown', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();

    await vi.waitFor(() => {
      const summary = root.querySelector(
        '[data-region="auto-assign-summary"]',
      );
      const text = summary?.textContent ?? '';
      expect(text).toContain('5 plassert');
      expect(text).toContain('2 tvetydige');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 6 — Gap-analyse navigates to the binder-specific master-gap
  // route. NOT global #master-gap.
  // ────────────────────────────────────────────────────────────────
  it('Gap-analyse click sets hash to #master-gap/<binderId>', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const gap = root.querySelector<HTMLButtonElement>(
      '[data-action="open-gap-analysis"]',
    );
    expect(gap).not.toBeNull();
    gap?.click();
    await settle(40);
    expect(window.location.hash).toContain(
      `master-gap/${encodeURIComponent(fixture.binderId)}`,
    );
  });

  // ────────────────────────────────────────────────────────────────
  // Test 7 — Banner ↔ master-gap binder report agree on every count.
  //
  // Phase C contract: the banner counts and the master-gap report
  // summary chips come from the SAME `buildBinderReport` output. If a
  // future refactor accidentally introduces a second classifier, this
  // test fails and forces the discussion.
  // ────────────────────────────────────────────────────────────────
  it('banner counts equal master-gap binder report summary counts', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const banner = await waitForBanner(root);

    const service = createMasterSetGapService({
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      cardsRepo: createCardsRepo(db),
      setsRepo: createSetsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      wishlistRepo: createWishlistRepo(db),
      lotItemsRepo: createLotItemsRepo(db),
    });
    const report = await service.buildBinderReport(fixture.binderId);
    expect(report).not.toBeNull();
    if (report === null) return;
    const s = report.binder;

    // Each of these must show up in the banner text exactly.
    const text = banner.textContent ?? '';
    expect(text).toContain(`${s.complete} / ${s.totalTargetSlots} fullført`);
    expect(text).toContain(`${s.missing} mangler`);
    expect(text).toContain(`${s.ownedUnplaced} eies men ikke plassert`);
    if (s.canPlaceDirectlyCount > 0) {
      expect(text).toContain(`${s.canPlaceDirectlyCount} kan plasseres direkte`);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Test 8 — gap-report reasons are contextual (Phase C).
  //
  // Operator critique: "Gap analysis is poor/bad". Concrete fix:
  // reasons must say what's blocking each row (required finish,
  // candidate count, etc.) instead of a flat per-status string.
  // ────────────────────────────────────────────────────────────────
  it('gap-report row reasons embed required finish + candidate counts', async () => {
    const fixture = await seedStressFixture(db);
    const service = createMasterSetGapService({
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      cardsRepo: createCardsRepo(db),
      setsRepo: createSetsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      wishlistRepo: createWishlistRepo(db),
      lotItemsRepo: createLotItemsRepo(db),
    });
    const report = await service.buildBinderReport(fixture.binderId);
    expect(report).not.toBeNull();
    if (report === null) return;

    const ambiguousRows = report.rows.filter(
      (r) => r.status === 'ambiguous_owned',
    );
    const ownedUnplacedRows = report.rows.filter(
      (r) => r.status === 'owned_unplaced',
    );
    const missingRows = report.rows.filter((r) => r.status === 'missing');

    expect(ambiguousRows.length).toBe(2);
    expect(ownedUnplacedRows.length).toBe(5);
    expect(missingRows.length).toBe(2);

    for (const row of ambiguousRows) {
      // "2 holdings matcher (normal). Velg manuelt."
      expect(row.reason).toMatch(/2 holdings matcher/);
      expect(row.reason).toContain('Velg manuelt');
    }
    for (const row of ownedUnplacedRows) {
      // "Du eier 1 normal-holding — kan plasseres direkte."
      expect(row.reason).toContain('kan plasseres direkte');
      expect(row.reason).toMatch(/normal/);
    }
    for (const row of missingRows) {
      // "Mangler. Trenger normal."
      expect(row.reason).toContain('Mangler');
      expect(row.reason).toContain('Trenger');
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Test 9 — CSV export columns match the operator-approved spec.
  //
  // Operator spec (2026-05-09): the CSV must be usable as a
  // physical-binder checklist. That means binderName, physicalPosition,
  // requiredFinish, holdingFinish, holdingCondition, holdingStatus,
  // language, issue must all be present. The current `binder-csv-export.ts`
  // is missing several of these and uses snake_case where the spec uses
  // camelCase — Phase D fixes both.
  // ────────────────────────────────────────────────────────────────
  it('CSV export click produces operator-spec column header', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const exportBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="export-csv"]',
    );
    expect(exportBtn).not.toBeNull();
    exportBtn?.click();

    await vi.waitFor(() => {
      expect(downloadModule.downloadTextFile).toHaveBeenCalledTimes(1);
    });
    const calls = vi.mocked(downloadModule.downloadTextFile).mock.calls;
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error('download was not invoked');
    const [filename, content] = firstCall as [string, string, ...unknown[]];
    expect(typeof filename).toBe('string');
    expect(typeof content).toBe('string');

    // Strip BOM if present, take header line.
    const cleaned = content.replace(/^﻿/, '');
    const headerLine = cleaned.split(/\r\n|\n/)[0] ?? '';
    const requiredColumns = [
      'binderName',
      'pageNumber',
      'slotNumber',
      'physicalPosition',
      'slotStatus',
      'targetCardId',
      'targetCardName',
      'setId',
      'setName',
      'cardNumber',
      'rarity',
      'requiredFinish',
      'holdingId',
      'holdingCardName',
      'holdingFinish',
      'holdingCondition',
      'holdingStatus',
      'language',
      'note',
      'issue',
    ];
    for (const col of requiredColumns) {
      expect(
        headerLine,
        `CSV header is missing the operator-required column "${col}". Header was: ${headerLine}`,
      ).toContain(col);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Test 9 — CSV row count = target-slot count, in physical order.
  // ────────────────────────────────────────────────────────────────
  it('CSV export emits one row per live binder slot in (page,slot) order', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const exportBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="export-csv"]',
    );
    exportBtn?.click();
    await vi.waitFor(() => {
      expect(downloadModule.downloadTextFile).toHaveBeenCalledTimes(1);
    });
    const firstCall = vi.mocked(downloadModule.downloadTextFile).mock.calls[0];
    if (firstCall === undefined) throw new Error('download was not invoked');
    const content = (firstCall as [string, string, ...unknown[]])[1];
    const cleaned = content.replace(/^﻿/, '');
    const lines = cleaned.split(/\r\n|\n/).filter((l) => l.length > 0);
    // Header + 9 data rows (one per target slot).
    expect(lines.length).toBe(1 + 9);
    // Row 1 (index 1) is page 1 slot 1 (slotNumber=1). Row 9 is slotNumber=9.
    // The fixture has only 1 page so the order is simply 1..9.
    for (let i = 1; i <= 9; i++) {
      const dataLine = lines[i];
      expect(
        dataLine,
        `expected row ${i} to mention slot number ${i}`,
      ).toContain(`,${i},`);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // Test 10 — CSV must never contain "[object Object]" anywhere.
  // ────────────────────────────────────────────────────────────────
  it('CSV export never contains [object Object]', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const exportBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="export-csv"]',
    );
    exportBtn?.click();
    await vi.waitFor(() => {
      expect(downloadModule.downloadTextFile).toHaveBeenCalledTimes(1);
    });
    const firstCall = vi.mocked(downloadModule.downloadTextFile).mock.calls[0];
    if (firstCall === undefined) throw new Error('download was not invoked');
    const content = (firstCall as [string, string, ...unknown[]])[1];
    expect(content.includes('[object Object]')).toBe(false);
  });

  // ════════════════════════════════════════════════════════════════
  // Phase E — full binder-detail action matrix.
  //
  // Phase A–D pinned the three operator-reported failures + count
  // mismatch. Phase E ensures the rest of the binder-detail toolbar
  // (tabs, search, filter chips, back-nav) still works after the
  // refactor and survives future churn. Per operator decision
  // 2026-05-09, no boot auto-trigger is added — these are pure Vitest
  // DOM tests with real click events.
  // ════════════════════════════════════════════════════════════════

  // ────────────────────────────────────────────────────────────────
  // Test 11 — Sider tab is active by default.
  // ────────────────────────────────────────────────────────────────
  it('Sider tab is active by default; Sjekkliste tab clickable', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const pagesTab = root.querySelector<HTMLButtonElement>('[data-mode="pages"]');
    const checklistTab = root.querySelector<HTMLButtonElement>(
      '[data-mode="checklist"]',
    );
    expect(pagesTab?.getAttribute('aria-selected')).toBe('true');
    expect(checklistTab?.getAttribute('aria-selected')).toBe('false');

    checklistTab?.click();
    await settle(40);
    const pagesTab2 = root.querySelector<HTMLButtonElement>('[data-mode="pages"]');
    const checklistTab2 = root.querySelector<HTMLButtonElement>(
      '[data-mode="checklist"]',
    );
    expect(checklistTab2?.getAttribute('aria-selected')).toBe('true');
    expect(pagesTab2?.getAttribute('aria-selected')).toBe('false');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 12 — Filter dropdown narrows the visible slot set.
  // ────────────────────────────────────────────────────────────────
  it('Filter "Mangler" leaves the auto-button label intact (filter is purely visual)', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const beforeBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    const beforeLabel = beforeBtn?.textContent ?? '';
    const beforeCount = buttonCount(beforeLabel);

    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    expect(filterSelect).not.toBeNull();
    if (filterSelect === null) return;
    filterSelect.value = 'missing';
    filterSelect.dispatchEvent(new Event('change'));
    await settle(40);

    // Filter is a view-only transformation — the auto-button count
    // (sourced from `placementPlan.safe.length`) reflects the binder's
    // full state, not what's currently visible. Operator-approved.
    const afterBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    expect(buttonCount(afterBtn?.textContent ?? '')).toBe(beforeCount);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 13 — Search input filters slot rows but doesn't change banner.
  // ────────────────────────────────────────────────────────────────
  it('Search input survives a render without losing its value', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const searchInput = root.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    expect(searchInput).not.toBeNull();
    if (searchInput === null) return;
    searchInput.value = 'Stress Card 5';
    searchInput.dispatchEvent(new Event('input'));
    await settle(60);

    const searchAfter = root.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    expect(searchAfter?.value).toBe('Stress Card 5');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 14 — Back-to-binders nav.
  // ────────────────────────────────────────────────────────────────
  it('Back button navigates to #binders', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const back = root.querySelector<HTMLButtonElement>('[data-action="back"]');
    expect(back).not.toBeNull();
    back?.click();
    await settle(40);
    expect(window.location.hash).toContain('binders');
    expect(window.location.hash).not.toContain('binder/');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 15 — Auto-place + manual-required secondary chip
  //
  // Operator-approved 2026-05-09: when both `safe` and `ambiguous`
  // are non-empty, render `{safe} trygge · {ambiguous} krever
  // manuelt valg` so the user knows the auto-place button only
  // covers the safe portion.
  // ────────────────────────────────────────────────────────────────
  it('renders "{safe} trygge · {ambiguous} krever manuelt valg" chip when both buckets are non-empty', async () => {
    const fixture = await seedStressFixture(db);
    window.location.hash = `binder/${encodeURIComponent(fixture.binderId)}`;
    const root = document.getElementById('content');
    if (root === null) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    await waitForBanner(root);

    const breakdown = root.querySelector(
      '[data-region="auto-assign-breakdown"]',
    );
    expect(breakdown).not.toBeNull();
    expect(breakdown?.textContent).toContain('5 trygge');
    expect(breakdown?.textContent).toContain('2 krever manuelt valg');
  });
});
