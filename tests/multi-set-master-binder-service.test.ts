// Tests for the multi-set master binder write path:
//   - binder-service.createMultiSetMasterBinder (single binder, atomic)
//   - master-set-binder-apply.applyMasterSetPlan (loop + progress)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { ValidationError } from '../src/domain/validators';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import { createBinderService } from '../src/services/binder-service';
import { applyMasterSetPlan } from '../src/services/master-set-binder-apply';
import {
  buildMasterSetPlan,
  MASTER_SET_BINDER_PRESET,
  type MasterSetBinderPlan,
} from '../src/services/master-set-binder-planner';
import type { PokemonTrackerDB } from '../src/db/database';
import type { CardRecord, SetRecord } from '../src/domain/types';

// --- fixtures ----------------------------------------------------------

function makeSet(
  id: string,
  options: { name?: string; series?: string; releaseDate?: string } = {},
): SetRecord {
  return {
    id,
    name: options.name ?? `Set ${id}`,
    series: options.series ?? 'Series A',
    printedTotal: 0,
    total: 0,
    releaseDate: options.releaseDate ?? '2020-01-01',
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-13T00:00:00.000Z',
  };
}

function makeCard(
  setId: string,
  number: string,
  options: { reverseHolo?: boolean } = {},
): CardRecord {
  return {
    id: `${setId}-${number}`,
    setId,
    name: `Card ${setId}-${number}`,
    number,
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer:
      options.reverseHolo === true
        ? { prices: { reverseHolofoil: { market: 1.5 } } }
        : null,
    cardmarket: null,
    updatedAt: '2026-05-13T00:00:00.000Z',
  };
}

function makeCards(setId: string, count: number): CardRecord[] {
  const cards: CardRecord[] = [];
  for (let i = 1; i <= count; i += 1) cards.push(makeCard(setId, String(i)));
  return cards;
}

function buildPlanFor(
  sets: SetRecord[],
  cardsBySetId: ReadonlyMap<string, CardRecord[]>,
): readonly MasterSetBinderPlan[] {
  return buildMasterSetPlan({ sets, cardsBySetId }).binders;
}

// --- createMultiSetMasterBinder ---------------------------------------

describe('binder-service.createMultiSetMasterBinder', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes a 1088-slot binder with sourceSetId=null and one binder_created audit row', async () => {
    const sets = [makeSet('a'), makeSet('b', { releaseDate: '2020-02-01' })];
    const cards = new Map([
      ['a', makeCards('a', 20)],
      ['b', makeCards('b', 25)],
    ]);
    const plan = buildPlanFor(sets, cards)[0];
    expect(plan).toBeDefined();
    if (plan === undefined) return;

    const service = createBinderService(db);
    const { binder, slots } = await service.createMultiSetMasterBinder({
      name: 'Master perm 1/1',
      description: 'two sets',
      plan,
    });

    expect(binder.binderPreset).toBe(MASTER_SET_BINDER_PRESET);
    expect(binder.sourceSetId).toBeNull();
    expect(binder.completionMode).toBe('master');
    expect(binder.totalPages).toBe(68);
    expect(binder.slotsPerPage).toBe(16);
    // 68 × 16 = 1088 slot rows; 20 + 25 = 45 are targets, rest empty.
    expect(slots.length).toBe(1088);
    const targets = slots.filter((s) => s.targetCardId !== null);
    expect(targets.length).toBe(45);
    expect(targets.every((s) => s.status === 'wanted')).toBe(true);
    const empties = slots.filter((s) => s.targetCardId === null);
    expect(empties.every((s) => s.status === 'empty')).toBe(true);

    const stored = await db.binderSlots
      .where('binderId')
      .equals(binder.id)
      .toArray();
    expect(stored.length).toBe(1088);

    const audits = await db.auditLog
      .where('action')
      .equals('binder_created')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.message).toContain('multi-set master binder');
    expect(audits[0]?.message).toContain('sections=2');
    expect(audits[0]?.message).toContain('targets=45');
    expect(audits[0]?.message).toContain('a=20');
    expect(audits[0]?.message).toContain('b=25');
  });

  it('keeps reverse-holo template slots flagged with the correct cardId', async () => {
    const sets = [makeSet('a')];
    const cards = new Map([
      ['a', [makeCard('a', '1', { reverseHolo: true }), makeCard('a', '2')]],
    ]);
    const plan = buildPlanFor(sets, cards)[0];
    if (plan === undefined) return;

    const service = createBinderService(db);
    const { slots } = await service.createMultiSetMasterBinder({
      name: 'rh test',
      description: null,
      plan,
    });

    const rh = slots.filter((s) => s.note === REVERSE_HOLO_TEMPLATE_MARKER);
    expect(rh.length).toBe(1);
    expect(rh[0]?.targetCardId).toBe('a-1');
  });

  it('rejects a plan that exceeds capacity', async () => {
    const sets = [makeSet('a')];
    const cards = new Map([['a', makeCards('a', 5)]]);
    const plan = buildPlanFor(sets, cards)[0];
    if (plan === undefined) return;
    // Tamper: synthesize a plan with too many slots.
    const tampered: MasterSetBinderPlan = {
      ...plan,
      sections: [
        {
          ...plan.sections[0]!,
          slots: Array.from({ length: 1089 }, (_v, i) => ({
            pageNumber: Math.floor(i / 16) + 1,
            slotNumber: (i % 16) + 1,
            targetCardId: `a-${i + 1}`,
            note: null,
          })),
          totalSlotCount: 1089,
        },
      ],
    };

    const service = createBinderService(db);
    await expect(
      service.createMultiSetMasterBinder({
        name: 'bad', description: null, plan: tampered,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a plan with a wrong preset', async () => {
    const sets = [makeSet('a')];
    const cards = new Map([['a', makeCards('a', 5)]]);
    const plan = buildPlanFor(sets, cards)[0];
    if (plan === undefined) return;
    const tampered = { ...plan, preset: 'vaultx_9_360' as never };

    const service = createBinderService(db);
    await expect(
      service.createMultiSetMasterBinder({
        name: 'bad', description: null, plan: tampered,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a plan with duplicate (page, slot) across sections', async () => {
    const sets = [makeSet('a')];
    const cards = new Map([['a', makeCards('a', 2)]]);
    const plan = buildPlanFor(sets, cards)[0];
    if (plan === undefined) return;
    const tampered: MasterSetBinderPlan = {
      ...plan,
      sections: [
        plan.sections[0]!,
        {
          ...plan.sections[0]!,
          setId: 'phantom',
        },
      ],
    };

    const service = createBinderService(db);
    await expect(
      service.createMultiSetMasterBinder({
        name: 'bad', description: null, plan: tampered,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a plan with zero sections', async () => {
    const service = createBinderService(db);
    const plan: MasterSetBinderPlan = {
      binderIndex: 1,
      preset: MASTER_SET_BINDER_PRESET,
      capacity: 1088,
      slotsPerPage: 16,
      totalPages: 68,
      sections: [],
      usedSlotCount: 0,
      unusedSlotCount: 1088,
    };
    await expect(
      service.createMultiSetMasterBinder({
        name: 'empty', description: null, plan,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('persists slots in the exact (page, slot) positions the plan declares', async () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
    ];
    const cards = new Map([
      ['a', makeCards('a', 17)],
      ['b', makeCards('b', 5)],
    ]);
    const plan = buildPlanFor(sets, cards)[0];
    if (plan === undefined) return;

    const service = createBinderService(db);
    const { binder, slots } = await service.createMultiSetMasterBinder({
      name: 'positional', description: null, plan,
    });

    // Section A: 17 slots on pages 1-2 (16+1). Slot (1,1) targets a-1.
    const slotOne = slots.find((s) => s.pageNumber === 1 && s.slotNumber === 1);
    expect(slotOne?.targetCardId).toBe('a-1');
    // Section B starts on page 3 slot 1 (first slot of new page).
    const sectionBStart = slots.find(
      (s) => s.pageNumber === 3 && s.slotNumber === 1,
    );
    expect(sectionBStart?.targetCardId).toBe('b-1');
    // Verify the bridging page 2 slot 2..16 stays empty (A ended at 2.1).
    for (let n = 2; n <= 16; n += 1) {
      const s = slots.find((x) => x.pageNumber === 2 && x.slotNumber === n);
      expect(s?.targetCardId).toBeNull();
      expect(s?.status).toBe('empty');
    }
    void binder;
  });
});

// --- applyMasterSetPlan -----------------------------------------------

describe('applyMasterSetPlan', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('creates every binder in the plan and fires onProgress per binder', async () => {
    // Force a 2-binder split with a large set (1200 slots > 1088).
    const sets = [makeSet('mega')];
    const cards = new Map([['mega', makeCards('mega', 1200)]]);
    const planResult = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(planResult.binders).toHaveLength(2);

    const service = createBinderService(db);
    const progressLog: number[] = [];
    const result = await applyMasterSetPlan(service, planResult, {
      onProgress: (e) => progressLog.push(e.index),
    });

    expect(result.failedAt).toBeNull();
    expect(result.created).toHaveLength(2);
    expect(progressLog).toEqual([1, 2]);

    const binders = await db.binders.toArray();
    expect(binders).toHaveLength(2);
    expect(binders.every((b) => b.sourceSetId === null)).toBe(true);
    // Smart-naming format: the set spans both binders, so each name
    // includes the set id + the "del N" suffix marking the continuation,
    // followed by set count + year range.
    expect(binders.map((b) => b.name).sort()).toEqual([
      'Master 1/2 · mega (del 1) · 1 sett · 2020',
      'Master 2/2 · mega (del 2+) · 1 sett · 2020',
    ]);

    const totalSlots = await db.binderSlots.count();
    expect(totalSlots).toBe(2 * 1088); // each binder is full-grid
    const totalTargets = await db.binderSlots
      .where('status')
      .equals('wanted')
      .count();
    expect(totalTargets).toBe(1200); // every card from "mega" got a slot
  });

  it('uses custom binderNames when provided', async () => {
    const sets = [makeSet('a'), makeSet('b', { releaseDate: '2020-02-01' })];
    const cards = new Map([
      ['a', makeCards('a', 10)],
      ['b', makeCards('b', 10)],
    ]);
    const planResult = buildMasterSetPlan({ sets, cardsBySetId: cards });

    const service = createBinderService(db);
    const result = await applyMasterSetPlan(service, planResult, {
      binderNames: ['Custom navn'],
    });
    expect(result.failedAt).toBeNull();
    expect(result.created[0]?.binder.name).toBe('Custom navn');
  });

  it('rejects mismatched binderNames length up front', async () => {
    const sets = [makeSet('a')];
    const cards = new Map([['a', makeCards('a', 5)]]);
    const planResult = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const service = createBinderService(db);
    await expect(
      applyMasterSetPlan(service, planResult, {
        binderNames: ['too', 'many', 'names'],
      }),
    ).rejects.toThrow(/binderNames length/);
  });

  it('returns failedAt with the failing index when a binder write throws', async () => {
    const sets = [makeSet('mega')];
    const cards = new Map([['mega', makeCards('mega', 1200)]]);
    const planResult = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(planResult.binders).toHaveLength(2);

    const service = createBinderService(db);
    let call = 0;
    const wrappedService = {
      ...service,
      createMultiSetMasterBinder: async (input: Parameters<typeof service.createMultiSetMasterBinder>[0]) => {
        call += 1;
        if (call === 2) throw new Error('simulated DB failure');
        return service.createMultiSetMasterBinder(input);
      },
    };

    const result = await applyMasterSetPlan(wrappedService, planResult);
    expect(result.created).toHaveLength(1);
    expect(result.failedAt?.index).toBe(2);
    expect(result.failedAt?.error).toContain('simulated DB failure');

    // First binder was committed despite the second failing.
    const binders = await db.binders.toArray();
    expect(binders).toHaveLength(1);
  });
});
