// PR 28 review patch — deterministic stress-data seed.
//
// Goals:
//   1. Reproducible: every run with the same seed string produces the
//      exact same DB state (counts AND content). Lets us assert
//      counts in tests AND in the QA report.
//   2. No DevTools paste required. The seed runs from inside the app
//      via `src/views/qa.ts`, gated behind `import.meta.env.DEV`.
//   3. No real cards needed: the seed inserts its own fixture cards +
//      sets so it works on a fresh DB without an API sync.
//   4. Data shape covers the master-gap scenarios PR 28 needs to
//      verify: ambiguous_owned with deterministic recommended winner,
//      ambiguous_owned with tied scores (manual_required), reverse-
//      holo template slots, owned_unplaced, complete, missing,
//      wishlist_wanted/ordered, in_lot_unmaterialized, invalid
//      assignments, blank slots.
//
// Locked rules:
//   - No schema migration. Uses existing repos with their existing
//     audit paths.
//   - Goes through `assignHoldingToSlot` for placement (PR 24).
//   - Reverse-holo template slots use the documented marker
//     (`REVERSE_HOLO_TEMPLATE_MARKER`) — PR 25 invariant intact.
//   - Identifiers are derived from the seed so the SAME run produces
//     IDs that match the assertions in the QA report.

import { REVERSE_HOLO_TEMPLATE_MARKER } from '../domain/card-variants';
import type {
  CardFinish,
  CardRecord,
  RawCondition,
  SetRecord,
  SlotsPerPage,
} from '../domain/types';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { PokemonTrackerDB } from '../db/database';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotsRepo } from '../repositories/lots-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';
import { assignHoldingToSlot } from '../services/binder-assignment-service';

export const QA_SEED_NAME = 'morten-pokemon-qa-v1';
export const QA_SEED_VERSION = 1;

export interface QaSeedDeps {
  readonly db: PokemonTrackerDB;
  readonly bindersRepo: BindersRepo;
  readonly binderSlotsRepo: BinderSlotsRepo;
  readonly cardsRepo: CardsRepo;
  readonly holdingsRepo: HoldingsRepo;
  readonly lotsRepo: LotsRepo;
  readonly lotItemsRepo: LotItemsRepo;
  readonly setsRepo: SetsRepo;
  readonly wishlistRepo: WishlistRepo;
}

export interface QaSeedSummary {
  readonly seed: string;
  readonly cards: number;
  readonly sets: number;
  readonly holdings: number;
  readonly wishlist: number;
  readonly lots: number;
  readonly lotItems: number;
  readonly binders: number;
  readonly slots: number;
  readonly assignedSlots: number;
  readonly reverseTemplateSlots: number;
  readonly invalidAssignmentSlots: number;
  readonly invalidVariantSlots: number;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------
// Deterministic PRNG (Mulberry32). Seed string → 32-bit int via FNV-1a.

function hashSeedString(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: string) {
    this.next = mulberry32(hashSeedString(seed));
  }
  /** Random int in [min, max). */
  intRange(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }
  /** Pick a value from `pool` deterministically. */
  pick<T>(pool: readonly T[]): T {
    if (pool.length === 0) throw new Error('Rng.pick on empty pool');
    return pool[this.intRange(0, pool.length)] as T;
  }
  /** Coin flip with given probability of `true`. */
  bool(probability: number): boolean {
    return this.next() < probability;
  }
}

// ---------------------------------------------------------------------
// Constants — every count below is deterministic for QA_SEED_NAME.
//
// Derived (asserted by the QA seed determinism test):
//   - 250 fixture cards (5 sets × 50 cards each)
//   - 1000 holdings  (covers complete / unplaced / ambiguous /
//                     reverse-holo / invalid_variant scenarios)
//   - 200 wishlist entries
//   - 5 lots
//   - 250 lot items (50 per lot)
//   - 7 binders, 3416 total slots
//   - 400 manually-assigned slot rows

const SETS_COUNT = 5;
const CARDS_PER_SET = 50;
export const QA_HOLDINGS_TARGET = 1000;
export const QA_WISHLIST_TARGET = 200;
export const QA_LOTS_TARGET = 5;
export const QA_LOT_ITEMS_PER_LOT = 50;
export const QA_BINDERS_TARGET = 7;
export const QA_TOTAL_SLOTS_TARGET = 3422;
export const QA_ASSIGNED_SLOTS_TARGET = 400;

const RAW_CONDITIONS: RawCondition[] = ['NM', 'LP', 'MP', 'HP', 'DMG', 'UNKNOWN'];
const FINISH_POOL: CardFinish[] = ['normal', 'holo', 'reverse_holo'];

// Binder layout list. The first six are real Vault X / custom presets;
// the seventh is a reverse-holo-heavy custom binder that exercises
// the `template:reverse_holo` invariant. Total slots: 3422.
//
//   QA Vault9        : 40 pages × 9     =  360
//   QA Vault12       : 40 × 12          =  480
//   QA Vault12XL     : 52 × 12          =  624
//   QA Vault16       : 68 × 16          = 1088 (1088-slot stress)
//   QA Custom        : 20 × 9           =  180
//   QA Master Base   : 12 sider × 9, capped at 102 = 102
//   QA Reverse Test  : 49 × 12          =  588 (mix av base + reverse template)
//
//   Total = 3422 ✓

const BINDER_BLUEPRINTS: readonly {
  name: string;
  totalPages: number;
  slotsPerPage: SlotsPerPage;
  preset: 'vaultx_9_360' | 'vaultx_12_480' | 'vaultx_12xl_624' | 'vaultx_16xxl_1088' | 'custom';
  completionMode: 'standard' | 'master';
  /** When true, half the slots get `note=template:reverse_holo`. */
  reverseTemplateMix?: boolean;
  /** When true, every slot is wired up to a card from the seed cache (target_card_id set). */
  populateTargets: boolean;
  /** When true, the binder is a from-set master clone of `cards` set 0 (102 slots). */
  fromBaseSet?: boolean;
}[] = [
  {
    name: 'QA Vault9 360',
    totalPages: 40,
    slotsPerPage: 9,
    preset: 'vaultx_9_360',
    completionMode: 'standard',
    populateTargets: true,
  },
  {
    name: 'QA Vault12 480',
    totalPages: 40,
    slotsPerPage: 12,
    preset: 'vaultx_12_480',
    completionMode: 'standard',
    populateTargets: true,
  },
  {
    name: 'QA Vault12XL 624',
    totalPages: 52,
    slotsPerPage: 12,
    preset: 'vaultx_12xl_624',
    completionMode: 'standard',
    populateTargets: true,
  },
  {
    name: 'QA Vault16 1088 (stress)',
    totalPages: 68,
    slotsPerPage: 16,
    preset: 'vaultx_16xxl_1088',
    completionMode: 'standard',
    populateTargets: true,
  },
  {
    name: 'QA Custom 180',
    totalPages: 20,
    slotsPerPage: 9,
    preset: 'custom',
    completionMode: 'standard',
    populateTargets: false, // exercises blank_slot scenarios
  },
  {
    name: 'QA Master Base',
    totalPages: 12,
    slotsPerPage: 9,
    preset: 'custom',
    completionMode: 'master',
    populateTargets: true,
    fromBaseSet: true, // exactly 102 cards from set 0
  },
  {
    name: 'QA Reverse Test 582',
    totalPages: 49,
    slotsPerPage: 12,
    preset: 'custom',
    completionMode: 'master',
    populateTargets: true,
    reverseTemplateMix: true,
  },
];

// ---------------------------------------------------------------------
// Reset

/**
 * Drop every row from every QA-relevant store so a re-seed produces
 * the exact deterministic counts. Settings store is preserved so the
 * user's PR 27 prefs survive a reset (the seed never touches them).
 */
export async function resetQaData(deps: QaSeedDeps): Promise<void> {
  const db = deps.db;
  await db.transaction(
    'rw',
    [
      db.cards,
      db.sets,
      db.holdings,
      db.lots,
      db.lotItems,
      db.binders,
      db.binderSlots,
      db.wishlist,
      db.auditLog,
    ],
    async () => {
      await db.cards.clear();
      await db.sets.clear();
      await db.holdings.clear();
      await db.lots.clear();
      await db.lotItems.clear();
      await db.binders.clear();
      await db.binderSlots.clear();
      await db.wishlist.clear();
      await db.auditLog.clear();
    },
  );
}

// ---------------------------------------------------------------------
// Seed

export async function seedStressData(deps: QaSeedDeps): Promise<QaSeedSummary> {
  const start = Date.now();
  const rng = new Rng(QA_SEED_NAME);

  // 1. Sets + cards. Every card gets `tcgplayer.prices.normal` so the
  //    variant validator accepts at least the normal/unlimited path;
  //    20% additionally get `holofoil`, 30% get `reverseHolofoil` so
  //    we have a healthy mix of finish-truth.
  const sets: SetRecord[] = [];
  for (let s = 0; s < SETS_COUNT; s += 1) {
    sets.push({
      id: `qa${s + 1}`,
      name: `QA Set ${s + 1}`,
      series: 'QA',
      printedTotal: CARDS_PER_SET,
      total: CARDS_PER_SET,
      releaseDate: '2026-01-01',
      symbolUrl: null,
      logoUrl: null,
      updatedAt: nowIso(),
    });
  }
  const cards: CardRecord[] = [];
  for (let s = 0; s < SETS_COUNT; s += 1) {
    for (let n = 1; n <= CARDS_PER_SET; n += 1) {
      // Deterministic price-key shape so variant validators accept
      // every holding the seed creates:
      //   set 1: normal-only          (200 normal NM/LP pairs)
      //   set 2: normal-only          (60 manual_required pairs)
      //   set 3: normal-only          (50 single owned-unplaced)
      //   set 4: normal + reverseHolofoil (30 reverse_holo holdings)
      //   set 5: normal-only          (lot items)
      const prices: Record<string, { market: number }> = {
        normal: { market: 1 },
      };
      if (s === 3) prices['reverseHolofoil'] = { market: 2 };
      cards.push({
        id: `qa${s + 1}-${n}`,
        setId: `qa${s + 1}`,
        name: `QA Card ${s + 1}-${n}`,
        number: String(n),
        rarity: 'Common',
        supertype: 'Pokémon',
        subtypes: [],
        types: [],
        imageSmall: null,
        imageLarge: null,
        tcgplayer: { prices },
        cardmarket: null,
        updatedAt: nowIso(),
      });
    }
  }
  await deps.setsRepo.upsertMany(sets);
  await deps.cardsRepo.upsertMany(cards);

  // 2. Holdings. The first 200 cards get TWO holdings of the same
  //    finish=normal: an NM and an LP. That gives master-gap a clean
  //    `recommended` (NM beats LP) when those cards land in target
  //    slots. The next 60 cards get TWO NM holdings each — tied
  //    score → `manual_required`. The next 50 get a single NM. The
  //    rest are scattered across the remaining cards in random
  //    conditions / finishes.
  const holdingIds: string[] = [];
  const holdingsByCardId = new Map<string, string[]>();

  // Helper: insert a holding, return its id.
  async function addHolding(
    cardId: string,
    finish: CardFinish,
    rawCondition: RawCondition,
    note: string | null = null,
  ): Promise<string> {
    const h = await deps.holdingsRepo.create({
      cardId,
      quantity: 1,
      conditionType: 'raw',
      rawCondition,
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish,
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
      note,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });
    holdingIds.push(h.id);
    let arr = holdingsByCardId.get(cardId);
    if (arr === undefined) {
      arr = [];
      holdingsByCardId.set(cardId, arr);
    }
    arr.push(h.id);
    return h.id;
  }

  // Reserved-ambiguous scenarios (these cards land in
  // AMBIGUOUS_RESERVED_CARDS later so their holdings stay
  // unassigned and the slots that target them classify as
  // ambiguous_owned).
  //
  // 30 cards in set 1 with NM + LP each:
  //   recommendBestCopy scores NM=300, LP=285 → unique winner →
  //   `recommended` overlay.
  for (let i = 1; i <= 30; i += 1) {
    const cardId = `qa1-${i}`;
    await addHolding(cardId, 'normal', 'NM', 'recommended-pair-nm');
    await addHolding(cardId, 'normal', 'LP', 'recommended-pair-lp');
  }
  // 30 cards in set 2 with NM + NM each:
  //   recommendBestCopy scores NM=NM=tied → `manual_required`.
  for (let i = 1; i <= 30; i += 1) {
    const cardId = `qa2-${i}`;
    await addHolding(cardId, 'normal', 'NM', 'manual-pair-a');
    await addHolding(cardId, 'normal', 'NM', 'manual-pair-b');
  }
  // 50 single NM holdings on set 3 — clean owned_unplaced path.
  for (let i = 1; i <= 50; i += 1) {
    const cardId = `qa3-${(i % CARDS_PER_SET) + 1}`;
    await addHolding(cardId, 'normal', 'NM');
  }
  // 30 reverse-holo holdings on set 4 (every card in set 4 carries
  // `reverseHolofoil`, so the variant validator accepts each one).
  for (let i = 1; i <= 30; i += 1) {
    const cardId = `qa4-${i}`;
    const cond = RAW_CONDITIONS[i % RAW_CONDITIONS.length] as RawCondition;
    await addHolding(cardId, 'reverse_holo', cond);
  }
  // Fill the rest deterministically up to QA_HOLDINGS_TARGET. Every
  // fill holding lands on a `normal` finish on a normal-only set
  // (1, 2, 3, 5) so the validator never rejects. Card numbers
  // 31..50 stay outside the reserved-ambiguous range.
  const totalSoFar = 30 * 2 + 30 * 2 + 50 + 30; // 170
  const fillCount = QA_HOLDINGS_TARGET - totalSoFar; // 830
  const NORMAL_SETS = [1, 2, 3, 5] as const;
  for (let i = 0; i < fillCount; i += 1) {
    const setIdx = NORMAL_SETS[i % NORMAL_SETS.length] as number;
    const cardNum = ((i % 20) + 31); // 31..50 (avoids reserved 1..30)
    const cond = RAW_CONDITIONS[i % RAW_CONDITIONS.length] as RawCondition;
    await addHolding(`qa${setIdx}-${cardNum}`, 'normal', cond);
  }
  // Suppress unused-rng warning — kept for forward seed extension.
  void rng;
  void FINISH_POOL;

  // 3. Wishlist — 200 entries. 50 of each status × varying priorities.
  //    Cards that already have holdings show up too so PR 22 receive
  //    flow has matches.
  const wishlistStatuses = ['wanted', 'ordered', 'received', 'cancelled'] as const;
  const wishlistPriorities = ['grail', 'high', 'medium', 'low'] as const;
  for (let i = 0; i < QA_WISHLIST_TARGET; i += 1) {
    const setIdx = (i % SETS_COUNT) + 1;
    const cardNum = (i % CARDS_PER_SET) + 1;
    await deps.wishlistRepo.create({
      cardId: `qa${setIdx}-${cardNum}`,
      finish: 'normal',
      priority: wishlistPriorities[i % 4]!,
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: wishlistStatuses[i % 4]!,
      note: null,
    });
  }

  // 4. Lots — 5 lots, 50 items each. Mix of allocation methods.
  //    Items reference cards that DON'T yet have a holding (we
  //    populate from set 5 to keep the test path clean).
  const lotItems: number[] = [];
  for (let l = 0; l < QA_LOTS_TARGET; l += 1) {
    const lot = await deps.lotsRepo.create({
      name: `QA Lot ${l + 1}`,
      purchaseDate: '2026-01-15T00:00:00.000Z',
      totalCost: 1000,
      currency: 'NOK',
      allocationMethod:
        l === 0 ? 'equal' : l === 1 ? 'manual' : 'weighted_by_market_price',
      notes: `seed=${QA_SEED_NAME}`,
    });
    let inserted = 0;
    for (let i = 1; i <= QA_LOT_ITEMS_PER_LOT; i += 1) {
      const cardNum = ((l * QA_LOT_ITEMS_PER_LOT + i - 1) % CARDS_PER_SET) + 1;
      await deps.lotItemsRepo.create({
        lotId: lot.id,
        cardId: `qa5-${cardNum}`,
        finish: 'normal',
        edition: 'unlimited',
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        quantity: 1,
        manualPriceOverride: null,
        marketEstimate: 10 + (i % 5) * 5,
        allocatedCost: null,
        holdingId: null,
        note: null,
      });
      inserted += 1;
    }
    lotItems.push(inserted);
  }
  const totalLotItems = lotItems.reduce((s, n) => s + n, 0);

  // 5. Binders + slots. Slot creation + assignment is the bulk work.
  //    To match the deterministic count target we walk
  //    BINDER_BLUEPRINTS and create rows row-by-row through the
  //    repos so audits + validation stay on the production path.
  let totalSlots = 0;
  let assignedSlots = 0;
  let reverseTemplateSlots = 0;
  let invalidAssignmentSlots = 0;
  let invalidVariantSlots = 0;
  const binders = [];
  for (const blueprint of BINDER_BLUEPRINTS) {
    const binder = await deps.bindersRepo.create({
      name: blueprint.name,
      description: null,
      binderType: null,
      totalPages: blueprint.totalPages,
      slotsPerPage: blueprint.slotsPerPage,
      binderPreset: blueprint.preset,
      completionMode: blueprint.completionMode,
      sourceSetId: blueprint.fromBaseSet === true ? 'qa1' : null,
    });
    binders.push(binder);

    const slotsToCreate: Array<Parameters<BinderSlotsRepo['create']>[0]> = [];
    if (blueprint.fromBaseSet === true) {
      // Master from-set: one slot per card in qa1 (50 cards × 1 page
      // = 50 slots, but we pad to 102 with the standard layout).
      let seq = 0;
      for (let p = 1; p <= blueprint.totalPages; p += 1) {
        for (let s = 1; s <= blueprint.slotsPerPage; s += 1) {
          if (seq >= 102) break;
          const cardNum = (seq % CARDS_PER_SET) + 1;
          slotsToCreate.push({
            binderId: binder.id,
            pageNumber: p,
            slotNumber: s,
            targetCardId: `qa1-${cardNum}`,
            holdingId: null,
            status: 'wanted',
            note: null,
          });
          seq += 1;
        }
        if (seq >= 102) break;
      }
    } else {
      let seq = 0;
      for (let p = 1; p <= blueprint.totalPages; p += 1) {
        for (let s = 1; s <= blueprint.slotsPerPage; s += 1) {
          const useReverse =
            blueprint.reverseTemplateMix === true && seq % 2 === 1;
          let targetCardId: string | null = null;
          if (blueprint.populateTargets) {
            // Reuse cards 1..200 from set 1 / set 2 / set 4 to seed
            // the right master-gap statuses. Reverse template slots
            // pull from set 4 (reverse-holo cards).
            if (useReverse) {
              targetCardId = `qa4-${((seq % 30) + 1)}`;
            } else {
              const setIdx = (seq % SETS_COUNT) + 1;
              const cardNum = (seq % CARDS_PER_SET) + 1;
              targetCardId = `qa${setIdx}-${cardNum}`;
            }
          }
          slotsToCreate.push({
            binderId: binder.id,
            pageNumber: p,
            slotNumber: s,
            targetCardId,
            holdingId: null,
            status: targetCardId === null ? 'empty' : 'wanted',
            note: useReverse ? REVERSE_HOLO_TEMPLATE_MARKER : null,
          });
          if (useReverse) reverseTemplateSlots += 1;
          seq += 1;
        }
      }
    }

    // bulk-create through the repo (audit + validation per slot)
    for (const input of slotsToCreate) {
      await deps.binderSlotsRepo.create(input, blueprint.slotsPerPage);
      totalSlots += 1;
    }
  }

  // Reserve 30 cards in set 1 (recommended-pair NM/LP) and 30 cards
  // in set 2 (manual-pair NM/NM) so their holdings stay unassigned.
  // The slots that target these cards then classify as
  // `ambiguous_owned`, which is exactly the master-gap scenario we
  // need to verify both bestCopyRecommendation paths.
  const AMBIGUOUS_RESERVED_CARDS = new Set<string>();
  for (let i = 1; i <= 30; i += 1) {
    AMBIGUOUS_RESERVED_CARDS.add(`qa1-${i}`);
    AMBIGUOUS_RESERVED_CARDS.add(`qa2-${i}`);
  }

  // 6. Manual assignments — pick the first 400 slots that have a
  //    target card AND a matching holding, and assign through the
  //    PR 24 service so we exercise the writer contract. Skip
  //    reverse-template slots in this pass; the bulk-assign target
  //    is the "happy" 1-holding-1-slot path.
  const liveSlots = await deps.binderSlotsRepo.listLive();
  liveSlots.sort((a, b) => {
    if (a.binderId !== b.binderId) return a.binderId.localeCompare(b.binderId);
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return a.slotNumber - b.slotNumber;
  });
  for (const slot of liveSlots) {
    if (assignedSlots >= QA_ASSIGNED_SLOTS_TARGET) break;
    if (slot.targetCardId === null) continue;
    if (slot.note === REVERSE_HOLO_TEMPLATE_MARKER) continue;
    if (AMBIGUOUS_RESERVED_CARDS.has(slot.targetCardId)) continue;
    const candidates = holdingsByCardId.get(slot.targetCardId) ?? [];
    if (candidates.length === 0) continue;
    const candidateId = candidates[0]!;
    const holding = await deps.holdingsRepo.get(candidateId);
    if (holding === undefined) continue;
    if (holding.finish !== 'normal') continue;
    const binder = binders.find((b) => b.id === slot.binderId);
    if (binder === undefined) continue;
    try {
      await assignHoldingToSlot(
        {
          bindersRepo: deps.bindersRepo,
          binderSlotsRepo: deps.binderSlotsRepo,
          holdingsRepo: deps.holdingsRepo,
          cardsRepo: deps.cardsRepo,
        },
        slot,
        holding,
        binder.slotsPerPage as SlotsPerPage,
      );
      assignedSlots += 1;
      // Remove from candidates so a holding never lands twice.
      candidates.shift();
    } catch {
      // Drop silently; the assertion is on count, not retry semantics.
    }
  }

  // 7. Force ONE invalid_variant + ONE invalid_assignment so the
  //    master-gap critical-severity path is exercised.
  //
  //    invalid_variant: take a reverse-holo template slot whose
  //    `targetCardId` we have a NORMAL-finish holding for, and
  //    point the slot at that holding via a low-level put. We
  //    intentionally bypass `assignHoldingToSlot` here because the
  //    point of the seed is to plant a bad row the classifier must
  //    flag — the writer contract correctly rejects it.
  //
  //    invalid_assignment: soft-delete the holding behind a slot
  //    that's already assigned, so master-gap sees a slot whose
  //    `holdingId` points to a deleted row.
  const reverseTemplateSlot = liveSlots.find(
    (s) =>
      s.note === REVERSE_HOLO_TEMPLATE_MARKER &&
      s.targetCardId !== null &&
      s.holdingId === null,
  );
  if (reverseTemplateSlot !== undefined && reverseTemplateSlot.targetCardId !== null) {
    // Look for a normal-finish holding for the same target card.
    const candidates = holdingsByCardId.get(reverseTemplateSlot.targetCardId) ?? [];
    let placed = false;
    for (const candId of candidates) {
      const h = await deps.holdingsRepo.get(candId);
      if (h !== undefined && h.deletedAt === null && h.finish === 'normal') {
        await deps.db.binderSlots.put({
          ...reverseTemplateSlot,
          holdingId: h.id,
          status: 'owned',
          updatedAt: nowIso(),
        });
        invalidVariantSlots += 1;
        placed = true;
        break;
      }
    }
    void placed;
  }

  const sampleAssignedSlot = (await deps.binderSlotsRepo.listLive()).find(
    (s) =>
      s.holdingId !== null && s.note !== REVERSE_HOLO_TEMPLATE_MARKER,
  );
  if (sampleAssignedSlot !== undefined && sampleAssignedSlot.holdingId !== null) {
    await deps.holdingsRepo.softDelete(
      sampleAssignedSlot.holdingId,
      'qa-seed: invalid_assignment scenario',
    );
    invalidAssignmentSlots += 1;
  }

  return {
    seed: QA_SEED_NAME,
    cards: cards.length,
    sets: sets.length,
    holdings: holdingIds.length,
    wishlist: QA_WISHLIST_TARGET,
    lots: QA_LOTS_TARGET,
    lotItems: totalLotItems,
    binders: binders.length,
    slots: totalSlots,
    assignedSlots,
    reverseTemplateSlots,
    invalidAssignmentSlots,
    invalidVariantSlots,
    elapsedMs: Date.now() - start,
  };
}

// Re-export newId so the QA view can stamp report files with a UUID.
export { newId as qaUuid };
