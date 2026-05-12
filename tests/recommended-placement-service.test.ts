// PR 28 — bulk recommended placement service. Driven by real Dexie
// (via fake-indexeddb) so we exercise the actual assign contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { placeRecommendedForReport } from '../src/services/recommended-placement-service';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createMasterSetGapService } from '../src/services/master-set-gap-service';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type {
  BinderRecord,
  SlotsPerPage,
} from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';
import type { MasterGapReport, MasterGapRow } from '../src/domain/master-set-gap';
import * as binderAssignment from '../src/services/binder-assignment-service';

const SLOTS_PER_PAGE: SlotsPerPage = 9;

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
    cardId: 'base1-4',
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    certNumber: null,
    certUrl: null,
    gradedDate: null,
    finish: 'normal',
    edition: 'unlimited',
    language: 'en',
    purchasePrice: null,
    purchaseCurrency: null,
    estimatedValue: null,
    valueCurrency: null,
    valueSource: 'unknown',
    valueNote: null,
    valueUpdatedAt: null,
    source: 'manual',
    note: null,
    specialVariant: false,
    tags: [],
    lotId: null,
    status: 'owned',
    ...overrides,
  };
}

async function buildScenario(
  db: PokemonTrackerDB,
  variant: 'recommended' | 'manual' | 'mixed',
): Promise<{
  binder: BinderRecord;
  report: MasterGapReport;
  recommendedHoldingId: string;
}> {
  await createSetsRepo(db).upsert({
    id: 'base1',
    name: 'Base',
    series: 'Base',
    printedTotal: 102,
    total: 102,
    releaseDate: '1999-01-09',
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  });
  await createCardsRepo(db).upsert(makeCard('base1-4'));
  await createCardsRepo(db).upsert(makeCard('base1-58'));
  const binder = await createBindersRepo(db).create({
    name: 'B',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: SLOTS_PER_PAGE,
    binderPreset: 'custom',
    completionMode: 'master',
    sourceSetId: null,
  });
  const slotsRepo = createBinderSlotsRepo(db);
  const holdingsRepo = createHoldingsRepo(db);

  // Slot 1: clear winner (NM vs LP).
  const nm = await holdingsRepo.create(holdingInput({ rawCondition: 'NM' }));
  if (variant === 'recommended' || variant === 'mixed') {
    await holdingsRepo.create(holdingInput({ rawCondition: 'LP' }));
    await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
  }

  if (variant === 'manual' || variant === 'mixed') {
    // Slot 2: tied top → manual_required.
    await holdingsRepo.create(
      holdingInput({ cardId: 'base1-58', rawCondition: 'NM' }),
    );
    await holdingsRepo.create(
      holdingInput({ cardId: 'base1-58', rawCondition: 'NM', note: 'twin' }),
    );
    await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
  }

  const service = createMasterSetGapService({
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: slotsRepo,
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo,
    wishlistRepo: createWishlistRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
  });
  const report = await service.buildBinderReport(binder.id);
  if (report === null) throw new Error('report build failed');
  return { binder, report, recommendedHoldingId: nm.id };
}

function buildDeps(db: PokemonTrackerDB) {
  return {
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    cardsRepo: createCardsRepo(db),
  };
}

// PR 38a — synth ambiguous-owned row pointing at a specific holding.
// Used by tests that hand-craft a `MasterGapReport` to exercise the
// pre-loaded snapshot path; the real service never emits two rows
// recommending the same holding, but the placement service must
// defend against it via the maintained snapshot anyway.
function makeAmbiguousRow(
  binder: BinderRecord,
  slotId: string,
  slotNumber: number,
  recommendedHoldingId: string,
): MasterGapRow {
  return {
    binderId: binder.id,
    binderName: binder.name,
    slotId,
    pageNumber: 1,
    slotNumber,
    cardId: 'base1-4',
    cardName: 'Charizard',
    setId: 'base1',
    setName: 'Base',
    cardNumber: '4',
    required: {
      finish: 'normal',
      edition: 'unlimited',
      verified: true,
      reason: 'pre-loaded snapshot test',
    },
    status: 'ambiguous_owned',
    severity: 'warning',
    reason: 'pre-loaded snapshot test',
    assignedHoldingId: null,
    matchingUnplacedHoldingIds: [recommendedHoldingId],
    activeWishlistIds: [],
    orderedWishlistIds: [],
    unmaterializedLotItemIds: [],
    canPlaceDirectly: false,
    bestCopyRecommendation: {
      status: 'recommended',
      recommendedHoldingId,
      score: 1,
      reasons: ['sole candidate'],
      candidateCount: 1,
    },
  };
}

describe('placeRecommendedForReport (PR 28)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  // 1
  it('places all recommended rows', async () => {
    const { report, recommendedHoldingId } = await buildScenario(
      db,
      'recommended',
    );
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]?.holdingId).toBe(recommendedHoldingId);
  });

  // 2
  it('skips manual_required rows', async () => {
    const { report } = await buildScenario(db, 'manual');
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.skippedManualRequired).toBe(1);
  });

  // 3
  it('skips no_candidates rows', async () => {
    // Fake a report that has an ambiguous_owned row but recommendation
    // status="no_candidates" — we patch the report directly to
    // exercise the branch without depending on the service's
    // internal classification.
    const { report } = await buildScenario(db, 'recommended');
    const patched: MasterGapReport = {
      ...report,
      rows: report.rows.map((r) =>
        r.status === 'ambiguous_owned'
          ? {
              ...r,
              bestCopyRecommendation: {
                status: 'no_candidates',
                recommendedHoldingId: null,
                score: null,
                reasons: [],
                candidateCount: 0,
              },
            }
          : r,
      ),
    };
    const result = await placeRecommendedForReport({
      report: patched,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.skippedNoRecommendation).toBe(1);
  });

  // 4
  it('skips rows with null recommendedHoldingId', async () => {
    const { report } = await buildScenario(db, 'recommended');
    const patched: MasterGapReport = {
      ...report,
      rows: report.rows.map((r) =>
        r.status === 'ambiguous_owned'
          ? {
              ...r,
              bestCopyRecommendation: {
                status: 'recommended',
                recommendedHoldingId: null,
                score: 100,
                reasons: [],
                candidateCount: 1,
              },
            }
          : r,
      ),
    };
    const result = await placeRecommendedForReport({
      report: patched,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.skippedNoRecommendation).toBe(1);
  });

  // 5
  it('skips non-ambiguous rows entirely', async () => {
    const { report } = await buildScenario(db, 'recommended');
    // Force every row to status=missing (also drop recommendation).
    const patched: MasterGapReport = {
      ...report,
      rows: report.rows.map((r) => ({
        ...r,
        status: 'missing' as const,
        bestCopyRecommendation: null,
      })),
    };
    const result = await placeRecommendedForReport({
      report: patched,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.skippedNoRecommendation).toBe(0);
    expect(result.skippedManualRequired).toBe(0);
  });

  // 6
  it('uses assignHoldingToSlot via the binder-assignment service', async () => {
    const spy = vi.spyOn(binderAssignment, 'assignHoldingToSlot');
    const { report } = await buildScenario(db, 'recommended');
    await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // 7
  it('does NOT call binderSlotsRepo.update directly', async () => {
    const slotsRepo = createBinderSlotsRepo(db);
    const updateSpy = vi.spyOn(slotsRepo, 'update');
    const { report } = await buildScenario(db, 'recommended');
    await placeRecommendedForReport({
      report,
      deps: {
        ...buildDeps(db),
        binderSlotsRepo: slotsRepo,
      },
    });
    // The assign service may itself call .update, but THIS service
    // only does so via the assign service. We verify the call
    // happened (via the contract) but the recommended placement
    // service does not contain a direct `binderSlotsRepo.update`
    // anywhere — guarded by a separate static-source test below.
    expect(updateSpy).toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('source code does not call binderSlotsRepo.update directly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(
        process.cwd(),
        'src',
        'services',
        'recommended-placement-service.ts',
      ),
      'utf-8',
    );
    // We allow comment-mentions of the API (the file documents that
    // it deliberately does NOT use it); we just need to verify there
    // is no actual call.
    expect(src).not.toMatch(/binderSlotsRepo\.update\(/);
  });

  // 8 — re-reads slot before assignment
  it('re-reads the slot from the repo before assigning', async () => {
    const slotsRepo = createBinderSlotsRepo(db);
    const getSpy = vi.spyOn(slotsRepo, 'get');
    const { report } = await buildScenario(db, 'recommended');
    await placeRecommendedForReport({
      report,
      deps: {
        ...buildDeps(db),
        binderSlotsRepo: slotsRepo,
      },
    });
    expect(getSpy).toHaveBeenCalledWith(report.rows[0]?.slotId);
    getSpy.mockRestore();
  });

  // 9 — re-reads holding before assignment
  it('re-reads the holding from the repo before assigning', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    const getSpy = vi.spyOn(holdingsRepo, 'get');
    const { report, recommendedHoldingId } = await buildScenario(
      db,
      'recommended',
    );
    await placeRecommendedForReport({
      report,
      deps: {
        ...buildDeps(db),
        holdingsRepo,
      },
    });
    expect(getSpy).toHaveBeenCalledWith(recommendedHoldingId);
    getSpy.mockRestore();
  });

  // 10 — handles stale slot
  it('records a failure when the slot has been deleted between report and click', async () => {
    const { report } = await buildScenario(db, 'recommended');
    // Soft-delete the slot the report points at.
    const slotId = report.rows[0]?.slotId;
    if (slotId === undefined) throw new Error('no slot id');
    await createBinderSlotsRepo(db).softDelete(slotId);
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.slotId).toBe(slotId);
  });

  // 11 — handles stale holding
  it('records a failure when the recommended holding has been deleted', async () => {
    const { report } = await buildScenario(db, 'recommended');
    const holdingId =
      report.rows[0]?.bestCopyRecommendation?.recommendedHoldingId;
    if (holdingId === null || holdingId === undefined) {
      throw new Error('no recommended holding id');
    }
    await createHoldingsRepo(db).softDelete(holdingId);
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });

  // 12 — records failure reason
  it('records a human-readable reason for each failure', async () => {
    const { report } = await buildScenario(db, 'recommended');
    const slotId = report.rows[0]?.slotId;
    if (slotId === undefined) throw new Error('no slot id');
    await createBinderSlotsRepo(db).softDelete(slotId);
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.failed[0]?.reason).toBeTruthy();
    expect(typeof result.failed[0]?.reason).toBe('string');
  });

  // 13 — continues after individual failure
  it('continues processing after an individual failure', async () => {
    const { report, recommendedHoldingId } = await buildScenario(
      db,
      'mixed',
    );
    // Soft-delete the manual_required row's slot? It's already
    // skipped. Instead delete the recommended row's slot, expect
    // the manual one is still skipped (not failed).
    const recommendedRow = report.rows.find(
      (r) =>
        r.bestCopyRecommendation?.status === 'recommended' &&
        r.bestCopyRecommendation.recommendedHoldingId === recommendedHoldingId,
    );
    if (!recommendedRow) throw new Error('recommended row not found');
    await createBinderSlotsRepo(db).softDelete(recommendedRow.slotId);
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.skippedManualRequired).toBe(1);
  });

  // 14 + 15 — returns placed list and skipped counts
  it('returns the placed list and skipped counts on a mixed report', async () => {
    const { report } = await buildScenario(db, 'mixed');
    const result = await placeRecommendedForReport({
      report,
      deps: buildDeps(db),
    });
    expect(result.placed).toHaveLength(1);
    expect(result.skippedManualRequired).toBe(1);
    expect(result.skippedNoRecommendation).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  // PR 38a — assigning the same holding to two slots in one batch:
  // the maintained snapshot blocks the second placement. Without the
  // pre-loaded set + post-call update the second assignHoldingToSlot
  // would still pass the per-call listLive check (because the first
  // update hasn't been re-read), and PR 24's one-holding-one-slot
  // invariant would break inside a batch.
  it('PR 38a: pre-loaded set blocks the same holding from landing in two slots in one batch', async () => {
    await createSetsRepo(db).upsert({
      id: 'base1',
      name: 'Base',
      series: 'Base',
      printedTotal: 102,
      total: 102,
      releaseDate: '1999-01-09',
      symbolUrl: null,
      logoUrl: null,
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
    await createCardsRepo(db).upsert(makeCard('base1-4'));
    const binder = await createBindersRepo(db).create({
      name: 'Dupe',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const holdingsRepo = createHoldingsRepo(db);
    // One holding — but two empty slots that both want base1-4.
    const onlyHolding = await holdingsRepo.create(holdingInput({ rawCondition: 'NM' }));
    const slot1 = await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    const slot2 = await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );

    // Hand-crafted report: both slots recommend the same holding. The
    // master-gap service would never emit this in practice (one
    // recommendation per slot, and the same holding is `manual_required`
    // on the second slot if it qualifies for both), but the placement
    // service must defend against it regardless.
    const dupeReport: MasterGapReport = {
      generatedAt: '2026-05-12T00:00:00.000Z',
      binder: {
        binderId: binder.id,
        binderName: binder.name,
        totalTargetSlots: 2,
        complete: 0,
        missing: 0,
        ownedUnplaced: 0,
        wishlistWanted: 0,
        wishlistOrdered: 0,
        inLotUnmaterialized: 0,
        ambiguousOwned: 2,
        invalidAssignment: 0,
        invalidVariant: 0,
        unverifiedVariantData: 0,
        completionPercent: 0,
        actionableCount: 2,
        canPlaceDirectlyCount: 0,
        recommendedAmbiguousCount: 2,
        manualAmbiguousCount: 0,
      },
      rows: [
        makeAmbiguousRow(binder, slot1.id, 1, onlyHolding.id),
        makeAmbiguousRow(binder, slot2.id, 2, onlyHolding.id),
      ],
    };

    const result = await placeRecommendedForReport({
      report: dupeReport,
      deps: buildDeps(db),
    });

    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]?.holdingId).toBe(onlyHolding.id);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/allerede plassert i en annen slot/);
  });

  // PR 38a — `binderSlotsRepo.listLive` is called once for the
  // pre-loaded snapshot regardless of how many rows the batch
  // processes. Pre-PR 38a it was called twice per placement
  // (one for the assigned-id set; one for the legacy-binder set
  // path was already shared). After PR 38a the per-call check uses
  // the pre-loaded snapshot in O(1).
  it('PR 38a: binderSlotsRepo.listLive is called once per batch (not once per placement)', async () => {
    const { report } = await buildScenario(db, 'mixed');
    const deps = buildDeps(db);
    const spy = vi.spyOn(deps.binderSlotsRepo, 'listLive');
    const result = await placeRecommendedForReport({
      report,
      deps,
    });
    expect(result.placed.length + result.failed.length).toBeGreaterThan(0);
    // One call for the snapshot. The batch may still call listLive
    // indirectly via other code paths (e.g. the audit-emission path
    // for legacy binders runs its own queries via cardsRepo, not
    // binderSlotsRepo) — assert the upper bound is 1 for the batch's
    // own use, allowing a small buffer for setup/teardown.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 16 — empty report
  it('handles an empty report', async () => {
    const { binder } = await buildScenario(db, 'recommended');
    void binder;
    const empty: MasterGapReport = {
      generatedAt: '2026-05-08T00:00:00.000Z',
      binder: {
        binderId: 'b',
        binderName: 'Empty',
        totalTargetSlots: 0,
        complete: 0,
        missing: 0,
        ownedUnplaced: 0,
        wishlistWanted: 0,
        wishlistOrdered: 0,
        inLotUnmaterialized: 0,
        ambiguousOwned: 0,
        invalidAssignment: 0,
        invalidVariant: 0,
        unverifiedVariantData: 0,
        completionPercent: 0,
        actionableCount: 0,
        canPlaceDirectlyCount: 0,
        recommendedAmbiguousCount: 0,
        manualAmbiguousCount: 0,
      },
      rows: [],
    };
    const result = await placeRecommendedForReport({
      report: empty,
      deps: buildDeps(db),
    });
    expect(result.placed).toEqual([]);
    expect(result.skippedManualRequired).toBe(0);
    expect(result.skippedNoRecommendation).toBe(0);
    expect(result.failed).toEqual([]);
  });
});
