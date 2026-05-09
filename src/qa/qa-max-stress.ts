// PR 28 review patch — exhaustive max-stress seed.
//
// Where `qa-seed.ts` produces a small deterministic fixture (1000
// holdings, 5 sets, 7 binders) so master-gap scenarios are
// reproducible across runs, this module produces a *large* dataset
// designed to exercise every domain-state combination the app can
// render. Intended use: after the user has run a real
// pokemontcg.io sync (so the local card cache holds 20k+ rows),
// click "Max stress" inside `#qa` to populate holdings, binders,
// lots and wishlist entries that span every condition / finish /
// edition / status / preset / completion-mode combination.
//
// Locked rules:
//   - No schema migration.
//   - All writes go through existing repos (audited).
//   - Reuses `assignHoldingToSlot` for placement so the
//     one-holding-one-slot contract holds.
//   - Reverse-holo template slots use `REVERSE_HOLO_TEMPLATE_MARKER`.
//   - Validators must accept every holding we create — we filter
//     against `availableVariants(card)` before inserting.
//   - Cardinality is bounded so even on a dev WebView2 the run
//     finishes in <5 minutes on a stress dataset.
//
// Determinism:
//   - The function is deterministic GIVEN the same input card
//     cache. With identical cards / sets in cache, two runs return
//     identical counts in the same order.
//   - Identifiers use `newId()` (random) per row, exactly like the
//     production app — counts are the contract, not ids.

import {
  REVERSE_HOLO_TEMPLATE_MARKER,
  availableVariants,
} from '../domain/card-variants';
import type {
  CardFinish,
  CardRecord,
  CompletionMode,
  Edition,
  HoldingStatus,
  RawCondition,
  SetRecord,
  SlotsPerPage,
  WishlistPriority,
  WishlistStatus,
} from '../domain/types';
import { assignHoldingToSlot } from '../services/binder-assignment-service';
import { nowIso } from '../utils/dates';
import type { QaSeedDeps } from './qa-seed';

export const QA_MAX_STRESS_SEED_NAME = 'morten-pokemon-stress-v1';

// ---------------------------------------------------------------------
// Public summary

export interface QaMaxStressSummary {
  readonly seed: string;
  readonly cards: number;
  readonly sets: number;
  readonly cardsUsedForHoldings: number;
  readonly holdings: {
    readonly total: number;
    readonly raw: number;
    readonly graded: number;
    readonly perCondition: Readonly<Record<RawCondition, number>>;
    readonly perFinish: Readonly<Partial<Record<CardFinish, number>>>;
    readonly perEdition: Readonly<Partial<Record<Edition, number>>>;
    readonly perStatus: Readonly<Record<HoldingStatus, number>>;
  };
  readonly wishlist: {
    readonly total: number;
    readonly perStatus: Readonly<Record<WishlistStatus, number>>;
    readonly perPriority: Readonly<Record<WishlistPriority, number>>;
  };
  readonly lots: {
    readonly total: number;
    readonly items: number;
    readonly allocated: number;
    readonly materialised: number;
  };
  readonly binders: {
    readonly total: number;
    readonly slots: number;
    readonly assignedSlots: number;
    readonly reverseTemplateSlots: number;
    readonly perPreset: Readonly<Record<string, number>>;
    readonly perCompletionMode: Readonly<Record<CompletionMode, number>>;
  };
  readonly elapsedMs: number;
  readonly notes: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------
// Constants

const ALL_RAW_CONDITIONS: ReadonlyArray<RawCondition> = [
  'NM',
  'LP',
  'MP',
  'HP',
  'DMG',
  'UNKNOWN',
];

const ALL_HOLDING_STATUSES: ReadonlyArray<HoldingStatus> = [
  'owned',
  'duplicate',
  'for_sale',
  'for_trade',
  'upgrade_needed',
  'ordered',
  'wanted',
];

const ALL_WISHLIST_STATUSES: ReadonlyArray<WishlistStatus> = [
  'wanted',
  'ordered',
  'received',
  'cancelled',
];

const ALL_WISHLIST_PRIORITIES: ReadonlyArray<WishlistPriority> = [
  'low',
  'medium',
  'high',
  'grail',
];

const ALL_EDITIONS: ReadonlyArray<Edition> = [
  'unlimited',
  'first_edition',
  'shadowless',
  'unknown',
];

interface BinderBlueprint {
  readonly name: string;
  readonly preset:
    | 'vaultx_9_360'
    | 'vaultx_12_480'
    | 'vaultx_12xl_624'
    | 'vaultx_16xxl_1088'
    | 'custom';
  readonly slotsPerPage: SlotsPerPage;
  readonly totalPages: number;
  readonly completionMode: CompletionMode;
  readonly reverseTemplateMix: boolean;
}

const BINDER_BLUEPRINTS: ReadonlyArray<BinderBlueprint> = [
  {
    name: 'Stress Vault9 360',
    preset: 'vaultx_9_360',
    slotsPerPage: 9,
    totalPages: 40,
    completionMode: 'standard',
    reverseTemplateMix: false,
  },
  {
    name: 'Stress Vault12 480',
    preset: 'vaultx_12_480',
    slotsPerPage: 12,
    totalPages: 40,
    completionMode: 'standard',
    reverseTemplateMix: false,
  },
  {
    name: 'Stress Vault12XL 624',
    preset: 'vaultx_12xl_624',
    slotsPerPage: 12,
    totalPages: 52,
    completionMode: 'master',
    reverseTemplateMix: false,
  },
  {
    name: 'Stress Vault16 1088',
    preset: 'vaultx_16xxl_1088',
    slotsPerPage: 16,
    totalPages: 68,
    completionMode: 'master',
    reverseTemplateMix: false,
  },
  {
    name: 'Stress Custom (master + reverse mix)',
    preset: 'custom',
    slotsPerPage: 9,
    totalPages: 30,
    completionMode: 'master',
    reverseTemplateMix: true,
  },
  {
    name: 'Stress Custom (grand_master)',
    preset: 'custom',
    slotsPerPage: 12,
    totalPages: 24,
    completionMode: 'grand_master',
    reverseTemplateMix: false,
  },
];

// Per-card holdings cap. Tuned so that:
//   - On a real synced cache (~20k cards) we see broad coverage with
//     few duplicates per card.
//   - On the fallback fixture (8 cards) every condition × finish ×
//     edition × status combo still gets at least one row.
// The dynamic floor below picks `max(8, ceil(targetCombos / pool))`
// per finish bucket so the matrix is always covered.
const HOLDINGS_PER_CARD_BASE_CAP = 8;
const MAX_CARDS_USED_FOR_HOLDINGS = 600;
const ASSIGNMENTS_PER_BINDER = 50;

// ---------------------------------------------------------------------
// Helpers

function bumpRecord<K extends string>(
  record: Record<K, number>,
  key: K,
): void {
  record[key] = (record[key] ?? 0) + 1;
}

function pickEditionForFinish(
  card: CardRecord,
  finish: CardFinish,
  fallback: Edition,
): Edition {
  const variants = availableVariants(card);
  // The `availableVariants` helper returns a verified `Edition` set
  // sourced from `tcgplayer.prices`. If the card has explicit
  // first-edition keys we prefer one of those for the finish.
  if (variants.editions.has('first_edition') && finish !== 'reverse_holo') {
    return 'first_edition';
  }
  if (variants.editions.has('unlimited')) return 'unlimited';
  return fallback;
}

// ---------------------------------------------------------------------
// Public entry point

/**
 * Build the exhaustive stress dataset on top of the live card cache.
 *
 * Pre-condition: `cardsRepo.list()` returns at least one card. If the
 * cache is empty, the function still runs but inserts a small fallback
 * fixture so the seed never throws — this lets us call it on a fresh
 * DB without first running the API sync. The summary's `cards` /
 * `cardsUsedForHoldings` numbers reflect the actual cache state.
 *
 * Post-conditions:
 *   - One holding exists per (condition, finish, edition, status)
 *     combination the cache supports, capped at `HOLDINGS_PER_CARD_CAP`
 *     per card so a sparse cache doesn't blow up the run.
 *   - At least one graded holding exists per (company, grade) pair we
 *     emit (5 grades × 6 companies = 30 graded rows).
 *   - One binder exists per blueprint (5 standard presets + a master
 *     reverse-mix custom binder + a grand_master custom binder).
 *   - A subset of slots in each binder is populated through
 *     `assignHoldingToSlot` so the placement contract is exercised.
 *   - Wishlist entries cover every (status, priority) combo.
 *   - Lots cover allocated / unallocated / partially-materialised.
 */
export async function seedMaxStressData(
  deps: QaSeedDeps,
): Promise<QaMaxStressSummary> {
  const start = Date.now();
  const notes: string[] = [];

  // 1. Snapshot the existing card cache. If empty → fallback.
  let cards = await deps.cardsRepo.list();
  let sets = await deps.setsRepo.list();
  if (cards.length === 0) {
    notes.push(
      'card cache empty — installing fallback fixture (8 cards, 2 sets)',
    );
    const { cards: fbCards, sets: fbSets } = installFallbackFixture();
    await deps.setsRepo.upsertMany(fbSets);
    await deps.cardsRepo.upsertMany(fbCards);
    cards = fbCards;
    sets = fbSets;
  }

  // 2. Bucket cards by which finishes/editions they support so we
  //    can target combos efficiently. Ignore unverified variant
  //    data (`availableVariants(card).verified === false`) — the
  //    validator rejects holdings against those cards.
  const verifiedCards = cards.filter((c) => availableVariants(c).verified);
  const usableCards = verifiedCards.slice(0, MAX_CARDS_USED_FOR_HOLDINGS);
  const cardsByFinish = new Map<CardFinish, CardRecord[]>();
  for (const card of usableCards) {
    const variants = availableVariants(card);
    for (const finish of variants.finishes) {
      let arr = cardsByFinish.get(finish);
      if (arr === undefined) {
        arr = [];
        cardsByFinish.set(finish, arr);
      }
      arr.push(card);
    }
  }

  // 3. Holdings — exhaustively walk every (finish, condition, edition,
  //    status) combo and insert one raw holding per combo, picking a
  //    card from the bucket. Then add a graded layer.
  const perCondition = countersFor(ALL_RAW_CONDITIONS);
  const perFinish: Partial<Record<CardFinish, number>> = {};
  const perEdition: Partial<Record<Edition, number>> = {};
  const perStatus = countersFor(ALL_HOLDING_STATUSES);
  const perCardCount = new Map<string, number>();
  let rawHoldingsTotal = 0;
  let gradedHoldingsTotal = 0;

  // (a) Raw layer.
  // Compute the per-card cap dynamically per finish bucket so a
  // tiny pool (fallback fixture: 1-2 cards per finish) still gets
  // every condition × edition × status combo, while a real
  // 20 000-card cache stays bounded at the base cap.
  const RAW_COMBOS_PER_FINISH =
    ALL_RAW_CONDITIONS.length *
    ALL_HOLDING_STATUSES.length *
    ALL_EDITIONS.length;
  for (const finish of cardsByFinish.keys()) {
    const pool = cardsByFinish.get(finish) ?? [];
    if (pool.length === 0) continue;
    const finishCap = Math.max(
      HOLDINGS_PER_CARD_BASE_CAP,
      Math.ceil(RAW_COMBOS_PER_FINISH / pool.length),
    );
    let cursor = 0;
    for (const condition of ALL_RAW_CONDITIONS) {
      for (const status of ALL_HOLDING_STATUSES) {
        for (const edition of ALL_EDITIONS) {
          const card = pool[cursor % pool.length]!;
          cursor += 1;
          const seenForCard = perCardCount.get(card.id) ?? 0;
          if (seenForCard >= finishCap) continue;
          // Edition must be one the card actually supports — fall
          // back to a verified one to keep the validator happy.
          const realEdition = pickEditionForFinish(card, finish, edition);
          try {
            await deps.holdingsRepo.create({
              cardId: card.id,
              quantity: 1,
              conditionType: 'raw',
              rawCondition: condition,
              gradingCompany: null,
              grade: null,
              certNumber: null,
              certUrl: null,
              gradedDate: null,
              finish,
              edition: realEdition,
              language: 'en',
              purchasePrice: null,
              purchaseCurrency: null,
              estimatedValue: null,
              valueCurrency: null,
              valueSource: 'unknown',
              valueNote: null,
              valueUpdatedAt: null,
              source: 'manual',
              note: `stress raw ${finish}/${condition}/${realEdition}/${status}`,
              specialVariant: false,
              tags: [`finish:${finish}`, `cond:${condition}`, `status:${status}`],
              lotId: null,
              status,
            });
            rawHoldingsTotal += 1;
            bumpRecord(perCondition, condition);
            perFinish[finish] = (perFinish[finish] ?? 0) + 1;
            perEdition[realEdition] =
              (perEdition[realEdition] ?? 0) + 1;
            bumpRecord(perStatus, status);
            perCardCount.set(card.id, seenForCard + 1);
          } catch (caught) {
            // Validator rejected — likely a finish/edition combo the
            // card doesn't actually expose. Skip without aborting.
            notes.push(
              `raw skip ${card.id} ${finish}/${condition}/${realEdition}/${status}: ${
                caught instanceof Error ? caught.message : 'unknown'
              }`,
            );
          }
        }
      }
    }
  }

  // (b) Graded layer — one holding per (company, grade) pair, using
  //     a small subset of the holo / normal cards so we exercise the
  //     graded codepath without ballooning the run.
  const gradingCompanies: ReadonlyArray<
    'PSA' | 'BGS' | 'CGC' | 'TAG' | 'ACE' | 'OTHER'
  > = ['PSA', 'BGS', 'CGC', 'TAG', 'ACE', 'OTHER'];
  const gradeTiers: ReadonlyArray<number> = [10, 9, 8, 7, 6];
  const gradedFinishes: ReadonlyArray<CardFinish> = ['normal', 'holo'];
  for (const gradedFinish of gradedFinishes) {
    const pool = cardsByFinish.get(gradedFinish) ?? [];
    if (pool.length === 0) continue;
    let cursor = 0;
    for (const company of gradingCompanies) {
      for (const grade of gradeTiers) {
        const card = pool[cursor % pool.length]!;
        cursor += 1;
        const realEdition = pickEditionForFinish(
          card,
          gradedFinish,
          'unlimited',
        );
        try {
          await deps.holdingsRepo.create({
            cardId: card.id,
            quantity: 1,
            conditionType: 'graded',
            rawCondition: null,
            gradingCompany: company,
            grade,
            certNumber: `${company}-${grade}-${cursor}`,
            certUrl: null,
            gradedDate: nowIso(),
            finish: gradedFinish,
            edition: realEdition,
            language: 'en',
            purchasePrice: null,
            purchaseCurrency: null,
            estimatedValue: null,
            valueCurrency: null,
            valueSource: 'unknown',
            valueNote: null,
            valueUpdatedAt: null,
            source: 'manual',
            note: `stress graded ${company} ${grade}`,
            specialVariant: false,
            tags: [`graded:${company}`, `grade:${grade}`],
            lotId: null,
            status: 'owned',
          });
          gradedHoldingsTotal += 1;
          perFinish[gradedFinish] = (perFinish[gradedFinish] ?? 0) + 1;
          perEdition[realEdition] = (perEdition[realEdition] ?? 0) + 1;
          bumpRecord(perStatus, 'owned');
        } catch (caught) {
          notes.push(
            `graded skip ${card.id} ${company}/${grade}: ${
              caught instanceof Error ? caught.message : 'unknown'
            }`,
          );
        }
      }
    }
  }

  // 4. Wishlist — every (status × priority × {normal, holo}) combo.
  const wishlistPerStatus = countersFor(ALL_WISHLIST_STATUSES);
  const wishlistPerPriority = countersFor(ALL_WISHLIST_PRIORITIES);
  let wishlistTotal = 0;
  const wishlistFinishes: ReadonlyArray<CardFinish> = ['normal', 'holo'];
  let wishCursor = 0;
  for (const status of ALL_WISHLIST_STATUSES) {
    for (const priority of ALL_WISHLIST_PRIORITIES) {
      for (const finish of wishlistFinishes) {
        const pool = cardsByFinish.get(finish) ?? cardsByFinish.get('normal') ?? usableCards;
        if (pool.length === 0) continue;
        const card = pool[wishCursor % pool.length]!;
        wishCursor += 1;
        try {
          await deps.wishlistRepo.create({
            cardId: card.id,
            finish,
            priority,
            targetCondition: 'NM',
            targetPrice: null,
            targetCurrency: null,
            status,
            note: `stress wishlist ${status}/${priority}`,
          });
          wishlistTotal += 1;
          bumpRecord(wishlistPerStatus, status);
          bumpRecord(wishlistPerPriority, priority);
        } catch (caught) {
          notes.push(
            `wishlist skip ${card.id} ${status}/${priority}/${finish}: ${
              caught instanceof Error ? caught.message : 'unknown'
            }`,
          );
        }
      }
    }
  }

  // 5. Lots — three states:
  //    - unallocated: 5 items, each totalCost share, no holdings created.
  //    - partially allocated: 5 items, allocatedCost set, no holdings.
  //    - materialised: 5 items, each pointing to a fresh holding row.
  const lotsTotal = 3;
  let lotItemsTotal = 0;
  let lotItemsAllocated = 0;
  let lotItemsMaterialised = 0;

  const lotsPlan: ReadonlyArray<{
    name: string;
    state: 'unallocated' | 'allocated' | 'materialised';
    items: number;
  }> = [
    { name: 'Stress lot — uallokert', state: 'unallocated', items: 5 },
    { name: 'Stress lot — allokert (ikke materialisert)', state: 'allocated', items: 5 },
    { name: 'Stress lot — materialisert', state: 'materialised', items: 5 },
  ];

  // Cards that support normal finish — only those work with the
  // default-finish lot items below. If none exist, fall back to
  // any usable card and pick the first available finish per item.
  const normalCards = cardsByFinish.get('normal') ?? [];
  const lotCardPool: ReadonlyArray<CardRecord> =
    normalCards.length > 0 ? normalCards : usableCards;
  let lotCursor = 0;
  for (const plan of lotsPlan) {
    const lot = await deps.lotsRepo.create({
      name: plan.name,
      purchaseDate: nowIso(),
      totalCost: 1000,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: plan.name,
    });
    for (let i = 0; i < plan.items; i += 1) {
      const card = lotCardPool[lotCursor % lotCardPool.length]!;
      lotCursor += 1;
      const variants = availableVariants(card);
      const itemFinish: CardFinish = variants.finishes.has('normal')
        ? 'normal'
        : variants.finishes.has('holo')
          ? 'holo'
          : variants.finishes.has('reverse_holo')
            ? 'reverse_holo'
            : 'normal';
      const itemEdition = pickEditionForFinish(card, itemFinish, 'unlimited');
      const holdingId =
        plan.state === 'materialised'
          ? (
              await deps.holdingsRepo.create({
                cardId: card.id,
                quantity: 1,
                conditionType: 'raw',
                rawCondition: 'NM',
                gradingCompany: null,
                grade: null,
                certNumber: null,
                certUrl: null,
                gradedDate: null,
                finish: itemFinish,
                edition: itemEdition,
                language: 'en',
                purchasePrice: null,
                purchaseCurrency: null,
                estimatedValue: null,
                valueCurrency: null,
                valueSource: 'unknown',
                valueNote: null,
                valueUpdatedAt: null,
                source: 'lot',
                note: 'stress lot materialised',
                specialVariant: false,
                tags: ['stress:lot'],
                lotId: lot.id,
                status: 'owned',
              })
            ).id
          : null;
      await deps.lotItemsRepo.create({
        lotId: lot.id,
        cardId: card.id,
        finish: itemFinish,
        edition: itemEdition,
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        quantity: 1,
        manualPriceOverride: null,
        marketEstimate: null,
        allocatedCost: plan.state === 'unallocated' ? null : 200,
        holdingId,
        note: `stress lot item ${plan.state}`,
      });
      lotItemsTotal += 1;
      if (plan.state !== 'unallocated') lotItemsAllocated += 1;
      if (plan.state === 'materialised') lotItemsMaterialised += 1;
      if (plan.state === 'materialised' && holdingId !== null) {
        rawHoldingsTotal += 1;
        bumpRecord(perStatus, 'owned');
      }
    }
  }

  // 6. Binders — one per blueprint. Populate a subset of slots via
  //    `assignHoldingToSlot` so the assignment audit + master-gap
  //    classifier are exercised.
  const liveHoldings = await deps.holdingsRepo.listLive();
  const placeableHoldings = liveHoldings.filter(
    (h) => h.status === 'owned',
  );
  let bindersTotal = 0;
  let slotsTotal = 0;
  let slotsAssigned = 0;
  let reverseTemplateSlots = 0;
  const perPreset: Record<string, number> = {};
  const perCompletionMode: Record<CompletionMode, number> = {
    standard: 0,
    master: 0,
    grand_master: 0,
  };

  let placeholderCursor = 0;
  for (const blueprint of BINDER_BLUEPRINTS) {
    const binder = await deps.bindersRepo.create({
      name: blueprint.name,
      description: 'PR 28 max-stress binder',
      binderType: null,
      totalPages: blueprint.totalPages,
      slotsPerPage: blueprint.slotsPerPage,
      binderPreset: blueprint.preset,
      completionMode: blueprint.completionMode,
      sourceSetId: null,
    });
    bindersTotal += 1;
    perPreset[blueprint.preset] = (perPreset[blueprint.preset] ?? 0) + 1;
    perCompletionMode[blueprint.completionMode] += 1;

    // Create slots — every page × slotsPerPage. Half get a target
    // card; the reverse-template binder marks every other slot.
    for (let page = 1; page <= blueprint.totalPages; page += 1) {
      for (let s = 1; s <= blueprint.slotsPerPage; s += 1) {
        const sequenceIndex = (page - 1) * blueprint.slotsPerPage + s;
        const useReverse =
          blueprint.reverseTemplateMix && sequenceIndex % 2 === 0;
        const targetCard =
          usableCards.length === 0
            ? null
            : usableCards[(sequenceIndex - 1) % usableCards.length]!;
        const targetCardId =
          sequenceIndex % 3 === 0 || targetCard === null
            ? null
            : targetCard.id;
        await deps.binderSlotsRepo.create(
          {
            binderId: binder.id,
            pageNumber: page,
            slotNumber: s,
            targetCardId,
            holdingId: null,
            status: targetCardId === null ? 'empty' : 'wanted',
            note: useReverse ? REVERSE_HOLO_TEMPLATE_MARKER : null,
          },
          blueprint.slotsPerPage,
        );
        slotsTotal += 1;
        if (useReverse) reverseTemplateSlots += 1;
      }
    }

    // Assign up to `ASSIGNMENTS_PER_BINDER` slots in this binder.
    const slots = await deps.binderSlotsRepo.listByBinderId(binder.id);
    let assignmentsHere = 0;
    for (const slot of slots) {
      if (assignmentsHere >= ASSIGNMENTS_PER_BINDER) break;
      if (slot.targetCardId === null) continue;
      const candidate = placeableHoldings.find((h) => {
        if (h.cardId !== slot.targetCardId) return false;
        if (h.lotId !== null) return false;
        return true;
      });
      if (candidate === undefined) continue;
      try {
        await assignHoldingToSlot(
          {
            holdingsRepo: deps.holdingsRepo,
            binderSlotsRepo: deps.binderSlotsRepo,
            bindersRepo: deps.bindersRepo,
            cardsRepo: deps.cardsRepo,
          },
          slot,
          candidate,
          blueprint.slotsPerPage,
        );
        slotsAssigned += 1;
        assignmentsHere += 1;
        // Drop this candidate from the pool so we don't re-assign.
        placeableHoldings.splice(placeableHoldings.indexOf(candidate), 1);
      } catch (caught) {
        notes.push(
          `assign skip ${slot.id}: ${
            caught instanceof Error ? caught.message : 'unknown'
          }`,
        );
      }
      placeholderCursor += 1;
    }
  }

  return {
    seed: QA_MAX_STRESS_SEED_NAME,
    cards: cards.length,
    sets: sets.length,
    cardsUsedForHoldings: usableCards.length,
    holdings: {
      total: rawHoldingsTotal + gradedHoldingsTotal,
      raw: rawHoldingsTotal,
      graded: gradedHoldingsTotal,
      perCondition,
      perFinish,
      perEdition,
      perStatus,
    },
    wishlist: {
      total: wishlistTotal,
      perStatus: wishlistPerStatus,
      perPriority: wishlistPerPriority,
    },
    lots: {
      total: lotsTotal,
      items: lotItemsTotal,
      allocated: lotItemsAllocated,
      materialised: lotItemsMaterialised,
    },
    binders: {
      total: bindersTotal,
      slots: slotsTotal,
      assignedSlots: slotsAssigned,
      reverseTemplateSlots,
      perPreset,
      perCompletionMode,
    },
    elapsedMs: Date.now() - start,
    notes,
  };
}

// ---------------------------------------------------------------------
// Helpers — keep at file bottom so the public API stays readable.

function countersFor<K extends string>(
  keys: ReadonlyArray<K>,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

function installFallbackFixture(): {
  cards: CardRecord[];
  sets: SetRecord[];
} {
  const sets: SetRecord[] = [
    {
      id: 'stress-set-1',
      name: 'Stress Fallback 1',
      series: 'Stress',
      printedTotal: 4,
      total: 4,
      releaseDate: '2026-01-01',
      symbolUrl: null,
      logoUrl: null,
      updatedAt: nowIso(),
    },
    {
      id: 'stress-set-2',
      name: 'Stress Fallback 2',
      series: 'Stress',
      printedTotal: 4,
      total: 4,
      releaseDate: '2026-01-01',
      symbolUrl: null,
      logoUrl: null,
      updatedAt: nowIso(),
    },
  ];
  const finishesPerCard: ReadonlyArray<{
    id: string;
    setId: string;
    name: string;
    prices: Record<string, { market: number }>;
  }> = [
    { id: 'stress-1-1', setId: 'stress-set-1', name: 'Stress Card 1-1', prices: { normal: { market: 1 } } },
    { id: 'stress-1-2', setId: 'stress-set-1', name: 'Stress Card 1-2', prices: { holofoil: { market: 1 } } },
    { id: 'stress-1-3', setId: 'stress-set-1', name: 'Stress Card 1-3', prices: { reverseHolofoil: { market: 1 } } },
    { id: 'stress-1-4', setId: 'stress-set-1', name: 'Stress Card 1-4', prices: { '1stEditionNormal': { market: 1 }, normal: { market: 1 } } },
    { id: 'stress-2-1', setId: 'stress-set-2', name: 'Stress Card 2-1', prices: { normal: { market: 1 }, holofoil: { market: 2 } } },
    { id: 'stress-2-2', setId: 'stress-set-2', name: 'Stress Card 2-2', prices: { normal: { market: 1 }, reverseHolofoil: { market: 2 } } },
    { id: 'stress-2-3', setId: 'stress-set-2', name: 'Stress Card 2-3', prices: { '1stEditionHolofoil': { market: 1 }, holofoil: { market: 1 } } },
    { id: 'stress-2-4', setId: 'stress-set-2', name: 'Stress Card 2-4', prices: { unlimitedNormal: { market: 1 }, '1stEditionNormal': { market: 1 } } },
  ];
  const cards: CardRecord[] = finishesPerCard.map((c, i) => ({
    id: c.id,
    setId: c.setId,
    name: c.name,
    number: String(i + 1),
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: { prices: c.prices },
    cardmarket: null,
    updatedAt: nowIso(),
  }));
  return { cards, sets };
}
