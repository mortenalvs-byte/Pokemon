// PR 25 — master-set-gap service. Repo-driven tests over a fresh DB.
// Covers every status class plus aggregation and the 1088-slot
// performance contract (no per-slot Dexie reads).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createMasterSetGapService } from '../src/services/master-set-gap-service';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard, makeUnverifiedCard } from './helpers/cards';
import type {
  BinderRecord,
  BinderSlotRecord,
  SetRecord,
  SlotsPerPage,
} from '../src/domain/types';
import type { HoldingInput, WishlistInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const SLOTS_PER_PAGE: SlotsPerPage = 9;

const baseSet: SetRecord = {
  id: 'base1',
  name: 'Base',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

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

function wishlistInput(overrides: Partial<WishlistInput> = {}): WishlistInput {
  return {
    cardId: 'base1-4',
    finish: 'normal',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    ...overrides,
  };
}

function buildDeps(db: PokemonTrackerDB) {
  return {
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    wishlistRepo: createWishlistRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
  };
}

describe('master-set-gap-service (PR 25)', () => {
  let db: PokemonTrackerDB;
  let binder: BinderRecord;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(baseSet);
    await createCardsRepo(db).upsert(
      makeCard('base1-4', { overrides: { name: 'Charizard', number: '4' } }),
    );
    await createCardsRepo(db).upsert(
      makeCard('base1-58', { overrides: { name: 'Pikachu', number: '58' } }),
    );
    binder = await createBindersRepo(db).create({
      name: 'Test binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  async function makeSlot(
    overrides: Partial<{
      pageNumber: number;
      slotNumber: number;
      targetCardId: string | null;
      holdingId: string | null;
      status: BinderSlotRecord['status'];
      note: string | null;
    }> = {},
  ): Promise<BinderSlotRecord> {
    return createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: overrides.pageNumber ?? 1,
        slotNumber: overrides.slotNumber ?? 1,
        targetCardId:
          'targetCardId' in overrides
            ? (overrides.targetCardId as string | null)
            : 'base1-4',
        holdingId: overrides.holdingId ?? null,
        status: overrides.status ?? 'wanted',
        note: overrides.note ?? null,
      },
      SLOTS_PER_PAGE,
    );
  }

  // -- 1. empty DB → zero summary ----------------------------------
  it('empty DB returns a zero dashboard summary', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const summary = await service.buildDashboardSummary();
    expect(summary.binderCount).toBe(1); // The fresh binder we created
    expect(summary.totalTargetSlots).toBe(0);
    expect(summary.complete).toBe(0);
    expect(summary.missing).toBe(0);
    expect(summary.canPlaceDirectlyCount).toBe(0);
    // Closest/weakest only populate for binders that actually have
    // target slots, so an empty fresh binder yields null for both.
    expect(summary.closestBinder).toBeNull();
    expect(summary.weakestBinder).toBeNull();
  });

  // -- 2. complete normal slot -------------------------------------
  it('complete normal slot is classified complete', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot({ holdingId: h.id, status: 'owned' });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows).toHaveLength(1);
    expect(report?.rows[0]?.status).toBe('complete');
    expect(report?.binder.complete).toBe(1);
    expect(report?.binder.completionPercent).toBe(100);
  });

  // -- 3. missing normal slot --------------------------------------
  it('missing normal slot with no coverage classifies missing', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('missing');
    expect(report?.binder.missing).toBe(1);
  });

  // -- 4. owned_unplaced + canPlaceDirectly ------------------------
  it('owned_unplaced with exactly one matching unassigned holding sets canPlaceDirectly', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('owned_unplaced');
    expect(report?.rows[0]?.canPlaceDirectly).toBe(true);
    expect(report?.rows[0]?.matchingUnplacedHoldingIds).toEqual([h.id]);
    expect(report?.binder.canPlaceDirectlyCount).toBe(1);
  });

  // -- 5. ambiguous_owned ------------------------------------------
  it('two matching unplaced holdings counts ambiguous_owned, canPlaceDirectly false', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await createHoldingsRepo(db).create(holdingInput());
    await createHoldingsRepo(db).create(
      holdingInput({ rawCondition: 'LP' }),
    );
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('ambiguous_owned');
    expect(report?.rows[0]?.canPlaceDirectly).toBe(false);
    expect(report?.rows[0]?.matchingUnplacedHoldingIds).toHaveLength(2);
  });

  // -- 6. reverse-holo template requires reverse_holo --------------
  it('reverse-holo template slot requires reverse_holo finish', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'reverse_holo' }),
    );
    await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.required.finish).toBe('reverse_holo');
    expect(report?.rows[0]?.status).toBe('owned_unplaced');
    expect(report?.rows[0]?.matchingUnplacedHoldingIds).toEqual([h.id]);
  });

  // -- 7. reverse-holo template with normal holding → invalid_variant
  it('reverse-holo template slot with normal-finish holding → invalid_variant', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'normal' }),
    );
    await makeSlot({
      note: REVERSE_HOLO_TEMPLATE_MARKER,
      holdingId: h.id,
      status: 'owned',
    });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('invalid_variant');
    expect(report?.rows[0]?.severity).toBe('critical');
    expect(report?.binder.invalidVariant).toBe(1);
  });

  // -- 8. normal slot must NOT invent reverse_holo gap -------------
  it('normal slot does not invent a reverse_holo requirement', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'normal' }),
    );
    await makeSlot({ holdingId: h.id, status: 'owned' });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.required.finish).toBe('normal');
    expect(report?.rows[0]?.status).toBe('complete');
  });

  // -- 9. holo-only card requires holo when normal absent ----------
  it('holo-only card requires holo when no normal printing exists', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    // Card with only holofoil pricing — no normal, no reverse.
    await createCardsRepo(db).upsert(
      makeCard('base1-1', {
        priceKeys: ['holofoil'],
        overrides: { name: 'Alakazam', number: '1' },
      }),
    );
    const h = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-1', finish: 'holo' }),
    );
    await makeSlot({
      targetCardId: 'base1-1',
      holdingId: h.id,
      status: 'owned',
    });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.required.finish).toBe('holo');
    expect(report?.rows[0]?.status).toBe('complete');
  });

  // -- 10. unverified tcgplayer.prices → unverified_variant_data ---
  it('card with no tcgplayer.prices reports unverified_variant_data', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await createCardsRepo(db).upsert(
      makeUnverifiedCard('base1-99', { name: 'Mystery card', number: '99' }),
    );
    await makeSlot({ targetCardId: 'base1-99' });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('unverified_variant_data');
    expect(report?.rows[0]?.required.verified).toBe(false);
    expect(report?.binder.unverifiedVariantData).toBe(1);
  });

  // -- 11. wanted wishlist → wishlist_wanted -----------------------
  it('active wanted wishlist (no holding) classifies wishlist_wanted', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await createWishlistRepo(db).create(wishlistInput());
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('wishlist_wanted');
    expect(report?.rows[0]?.activeWishlistIds).toHaveLength(1);
  });

  // -- 12. ordered beats wanted ------------------------------------
  it('ordered wishlist beats wanted', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await createWishlistRepo(db).create(wishlistInput({ status: 'wanted' }));
    await createWishlistRepo(db).create(wishlistInput({ status: 'ordered' }));
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('wishlist_ordered');
    expect(report?.rows[0]?.orderedWishlistIds).toHaveLength(1);
    expect(report?.rows[0]?.activeWishlistIds).toHaveLength(1);
  });

  // -- 13. unmaterialised lot item → in_lot_unmaterialized ---------
  it('unmaterialised live lot item with matching cardId classifies in_lot_unmaterialized', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const lot = await createLotsRepo(db).create({
      name: 'Test lot',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'normal',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: 100,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });
    await makeSlot();
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('in_lot_unmaterialized');
    expect(report?.rows[0]?.unmaterializedLotItemIds).toHaveLength(1);
  });

  // -- 13a. reverse-holo template + normal lot item → missing -----
  // Review patch: lot coverage must respect required finish.
  it('reverse-holo template slot with normal-finish lot item classifies missing, not in_lot', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const lot = await createLotsRepo(db).create({
      name: 'Test lot',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'normal',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: 100,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });
    await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('missing');
    expect(report?.rows[0]?.unmaterializedLotItemIds).toHaveLength(0);
  });

  // -- 13b. reverse-holo template + reverse_holo lot item → in_lot --
  it('reverse-holo template slot with reverse_holo lot item classifies in_lot_unmaterialized', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const lot = await createLotsRepo(db).create({
      name: 'Test lot',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'reverse_holo',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: 100,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });
    await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('in_lot_unmaterialized');
    expect(report?.rows[0]?.unmaterializedLotItemIds).toHaveLength(1);
  });

  // -- 13c. normal slot + reverse_holo-only lot item → missing -----
  it('normal slot with reverse_holo-only lot item classifies missing', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const lot = await createLotsRepo(db).create({
      name: 'Test lot',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'reverse_holo',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: 100,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });
    await makeSlot(); // normal target slot for base1-4 (required=normal)
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.required.finish).toBe('normal');
    expect(report?.rows[0]?.status).toBe('missing');
    expect(report?.rows[0]?.unmaterializedLotItemIds).toHaveLength(0);
  });

  // -- 14. assigned holding wrong cardId → invalid_assignment ------
  it('slot referencing a holding for the wrong cardId classifies invalid_assignment', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const wrong = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-58' }),
    );
    // We have to construct the slot directly via Dexie because the
    // assign-holding-modal would reject this in the UI layer.
    const slotsRepo = createBinderSlotsRepo(db);
    const slot = await slotsRepo.create(
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
    // Force the cross-card binding via a low-level Dexie put.
    await db.binderSlots.put({ ...slot, holdingId: wrong.id });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('invalid_assignment');
  });

  // -- 15. soft-deleted holding assigned → invalid_assignment ------
  it('soft-deleted holding assigned to slot classifies invalid_assignment', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot({ holdingId: h.id, status: 'owned' });
    await createHoldingsRepo(db).softDelete(h.id);
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows[0]?.status).toBe('invalid_assignment');
  });

  // -- 16. blank slot excluded from totalTargetSlots ---------------
  it('blank slot is excluded from totalTargetSlots', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await makeSlot({ targetCardId: null, status: 'empty' });
    await makeSlot({ slotNumber: 2 });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows).toHaveLength(2);
    expect(report?.rows.find((r) => r.status === 'blank_slot')).toBeDefined();
    expect(report?.binder.totalTargetSlots).toBe(1);
  });

  // -- 17. soft-deleted slots ignored ------------------------------
  it('soft-deleted slots are not in the report', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const slot = await makeSlot();
    await createBinderSlotsRepo(db).softDelete(slot.id);
    const report = await service.buildBinderReport(binder.id);
    expect(report?.rows).toHaveLength(0);
    expect(report?.binder.totalTargetSlots).toBe(0);
  });

  // -- 18. soft-deleted binders ignored ----------------------------
  it('soft-deleted binders are not in the dashboard summary', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    await createBindersRepo(db).softDelete(binder.id);
    const summary = await service.buildDashboardSummary();
    expect(summary.binderCount).toBe(0);
    const report = await service.buildBinderReport(binder.id);
    expect(report).toBeNull();
  });

  // -- 19. dashboard aggregation across multiple binders -----------
  it('dashboard summary aggregates across multiple binders', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    const second = await createBindersRepo(db).create({
      name: 'Second',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const h = await createHoldingsRepo(db).create(holdingInput());
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: h.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    await createBinderSlotsRepo(db).create(
      {
        binderId: second.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    const summary = await service.buildDashboardSummary();
    expect(summary.binderCount).toBe(2);
    expect(summary.totalTargetSlots).toBe(2);
    expect(summary.complete).toBe(1);
    expect(summary.missing).toBe(1);
  });

  // -- 20. closestBinder + weakestBinder ---------------------------
  it('closestBinder is highest-completion (<100%), weakestBinder is lowest', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    // Binder A: 1 of 1 complete (100%) — should NOT be the closest.
    const h1 = await createHoldingsRepo(db).create(holdingInput());
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: h1.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    // Binder B: 1 of 2 complete (50%).
    const second = await createBindersRepo(db).create({
      name: 'Second',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const h2 = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-58' }),
    );
    await createBinderSlotsRepo(db).create(
      {
        binderId: second.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-58',
        holdingId: h2.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    await createBinderSlotsRepo(db).create(
      {
        binderId: second.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    // Binder C: 0 of 1 complete (0%) — should be weakest.
    const third = await createBindersRepo(db).create({
      name: 'Third',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    await createBinderSlotsRepo(db).create(
      {
        binderId: third.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    const summary = await service.buildDashboardSummary();
    expect(summary.closestBinder?.binderId).toBe(second.id);
    expect(summary.weakestBinder?.binderId).toBe(third.id);
  });

  // -- 21. canPlaceDirectlyCount counts only safe single-candidates -
  it('canPlaceDirectlyCount only counts safe single-candidate slots', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    // Slot 1: exactly 1 candidate → can place
    await createHoldingsRepo(db).create(holdingInput({ cardId: 'base1-4' }));
    await makeSlot({ pageNumber: 1, slotNumber: 1, targetCardId: 'base1-4' });
    // Slot 2: 2 candidates → ambiguous
    await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-58', rawCondition: 'NM' }),
    );
    await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-58', rawCondition: 'LP' }),
    );
    await makeSlot({ pageNumber: 1, slotNumber: 2, targetCardId: 'base1-58' });
    const report = await service.buildBinderReport(binder.id);
    expect(report?.binder.canPlaceDirectlyCount).toBe(1);
  });

  // -- 22. multi-slot binder runs without per-slot Dexie reads -----
  // Performance contract: a binder of N slots must cost exactly one
  // listLive() per store, not N. We seed 50 slots here (production has
  // up to 1088 in a Vault X 16-pocket); the call-count invariance
  // proves it scales without per-slot work. The QA-data smoke test
  // confirms the same on the 7-binder / 3284-slot stress dataset.
  it('multi-slot binder runs without per-slot Dexie reads', async () => {
    // Spy on each repo's listLive / list to count calls. The service
    // should call each one at most once per buildBinderReport.
    const deps = buildDeps(db);
    const slotsLiveSpy = vi.spyOn(deps.binderSlotsRepo, 'listLive');
    const holdingsLiveSpy = vi.spyOn(deps.holdingsRepo, 'listLive');
    const wishlistLiveSpy = vi.spyOn(deps.wishlistRepo, 'listLive');
    const lotItemsLiveSpy = vi.spyOn(deps.lotItemsRepo, 'listLive');
    const cardsListSpy = vi.spyOn(deps.cardsRepo, 'list');
    const setsListSpy = vi.spyOn(deps.setsRepo, 'list');
    const holdingsByCardSpy = vi.spyOn(deps.holdingsRepo, 'listByCardId');
    const wishlistByCardSpy = vi.spyOn(deps.wishlistRepo, 'listByCardId');
    const lotItemsByCardSpy = vi.spyOn(deps.lotItemsRepo, 'listByCardId');
    const slotsByBinderIdSpy = vi.spyOn(
      deps.binderSlotsRepo,
      'listByBinderId',
    );

    const slotsRepo = createBinderSlotsRepo(db);
    for (let i = 1; i <= 50; i += 1) {
      await slotsRepo.create(
        {
          binderId: binder.id,
          pageNumber: Math.ceil(i / SLOTS_PER_PAGE),
          slotNumber: ((i - 1) % SLOTS_PER_PAGE) + 1,
          targetCardId: 'base1-4',
          holdingId: null,
          status: 'wanted',
          note: null,
        },
        SLOTS_PER_PAGE,
      );
    }
    slotsLiveSpy.mockClear();
    holdingsLiveSpy.mockClear();
    wishlistLiveSpy.mockClear();
    lotItemsLiveSpy.mockClear();
    cardsListSpy.mockClear();
    setsListSpy.mockClear();

    const service = createMasterSetGapService(deps);
    await service.buildBinderReport(binder.id);

    expect(slotsLiveSpy).toHaveBeenCalledTimes(1);
    expect(holdingsLiveSpy).toHaveBeenCalledTimes(1);
    expect(wishlistLiveSpy).toHaveBeenCalledTimes(1);
    expect(lotItemsLiveSpy).toHaveBeenCalledTimes(1);
    expect(cardsListSpy).toHaveBeenCalledTimes(1);
    expect(setsListSpy).toHaveBeenCalledTimes(1);
    expect(holdingsByCardSpy).not.toHaveBeenCalled();
    expect(wishlistByCardSpy).not.toHaveBeenCalled();
    expect(lotItemsByCardSpy).not.toHaveBeenCalled();
    expect(slotsByBinderIdSpy).not.toHaveBeenCalled();
  });

  // -- 23. averageCompletionPercent is weighted by total slots -----
  // Review patch: empty / unbalanced binders must not drag the global
  // dashboard average down. averageCompletionPercent = complete /
  // totalTargetSlots, not the unweighted mean of per-binder %.
  it('averageCompletionPercent is weighted by total target slots', async () => {
    const service = createMasterSetGapService(buildDeps(db));
    // Binder A: 1 target slot, complete (100%).
    const h = await createHoldingsRepo(db).create(holdingInput());
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: h.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    // Binder B: 100 target slots, 0 complete (0%) — adding more weight
    // to the 0% side. Unweighted mean would be 50%; weighted average
    // is 1/(1+100) ≈ 1%.
    const second = await createBindersRepo(db).create({
      name: 'Big empty',
      description: null,
      binderType: null,
      totalPages: 12,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    for (let i = 1; i <= 100; i += 1) {
      await slotsRepo.create(
        {
          binderId: second.id,
          pageNumber: Math.ceil(i / SLOTS_PER_PAGE),
          slotNumber: ((i - 1) % SLOTS_PER_PAGE) + 1,
          targetCardId: 'base1-58',
          holdingId: null,
          status: 'wanted',
          note: null,
        },
        SLOTS_PER_PAGE,
      );
    }
    const summary = await service.buildDashboardSummary();
    expect(summary.totalTargetSlots).toBe(101);
    expect(summary.complete).toBe(1);
    // 1 / 101 = 0.99% → rounds to 1%.
    expect(summary.averageCompletionPercent).toBe(1);
  });
});
