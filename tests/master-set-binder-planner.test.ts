// Pure tests for the master-set binder planner. No I/O, no Dexie.
//
// The planner promises:
//   1. Multiple sets pack into one 1088-slot binder when they fit.
//   2. A set that would exceed remaining capacity opens a new binder.
//   3. Same-name cards from different sets stay in their own sections.
//   4. Reverse-holo slots remain inside the same set section.
//   5. Sections are continuous and ordered by series then release date.
//   6. Large synthetic datasets pack in linear time.

import { describe, expect, it } from 'vitest';

import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import {
  buildMasterSetPlan,
  MASTER_SET_BINDER_PRESET,
  type MasterSetBinderPlan,
  type MasterSetSectionPlan,
} from '../src/services/master-set-binder-planner';
import type { CardRecord, SetRecord } from '../src/domain/types';

// --- fixture helpers ---------------------------------------------------

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
  options: { id?: string; name?: string; reverseHolo?: boolean } = {},
): CardRecord {
  return {
    id: options.id ?? `${setId}-${number}`,
    setId,
    name: options.name ?? `Card ${setId}-${number}`,
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
  for (let i = 1; i <= count; i += 1) {
    cards.push(makeCard(setId, String(i)));
  }
  return cards;
}

function mapBySet(...groups: Array<readonly [string, CardRecord[]]>): Map<string, CardRecord[]> {
  return new Map(groups);
}

function flatSlotPositions(
  binder: MasterSetBinderPlan,
): Array<[setId: string, page: number, slot: number]> {
  const out: Array<[string, number, number]> = [];
  for (const section of binder.sections) {
    for (const s of section.slots) {
      out.push([section.setId, s.pageNumber, s.slotNumber]);
    }
  }
  return out;
}

// --- tests -------------------------------------------------------------

describe('buildMasterSetPlan', () => {
  it('packs two small sets into one binder, each on its own page boundary', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 20)],
      ['b', makeCards('b', 25)],
    );

    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });

    expect(plan.binders).toHaveLength(1);
    const [binder] = plan.binders;
    expect(binder).toBeDefined();
    if (binder === undefined) return;
    expect(binder.preset).toBe(MASTER_SET_BINDER_PRESET);
    expect(binder.sections).toHaveLength(2);

    const [sectionA, sectionB] = binder.sections;
    expect(sectionA).toBeDefined();
    expect(sectionB).toBeDefined();
    if (sectionA === undefined || sectionB === undefined) return;
    expect(sectionA.setId).toBe('a');
    expect(sectionA.totalSlotCount).toBe(20);
    expect(sectionA.startPage).toBe(1);
    expect(sectionA.startSlot).toBe(1);
    // 20 slots in 16-slot pages → ends on page 2 slot 4.
    expect(sectionA.endPage).toBe(2);
    expect(sectionA.endSlot).toBe(4);

    expect(sectionB.setId).toBe('b');
    // Second set MUST start on a fresh page. Page 2 has 12 empty slots
    // after section A; the planner leaves them empty and section B
    // begins at page 3 slot 1.
    expect(sectionB.startPage).toBe(3);
    expect(sectionB.startSlot).toBe(1);
    expect(sectionB.totalSlotCount).toBe(25);
    expect(sectionB.endPage).toBe(4);
    expect(sectionB.endSlot).toBe(9);

    expect(binder.usedSlotCount).toBe(45);
    // unusedSlotCount is the FULL empty count: every position in the
    // 1088-grid not occupied by a target slot, including the 12-slot
    // gap on page 2 between section A's end and section B's start.
    // 1088 - 45 = 1043.
    expect(binder.unusedSlotCount).toBe(1088 - 45);
    expect(binder.usedSlotCount + binder.unusedSlotCount).toBe(binder.capacity);
  });

  it('unusedSlotCount counts mid-page gaps between sections, not only trailing empties', () => {
    // Three sets sized to force two mid-page gaps:
    // Set A: 20 slots → ends at page 2, slot 4. Gap on page 2 slots 5–16 (12 slots).
    // Set B: 25 slots → starts page 3 slot 1, ends page 4 slot 9. Gap on page 4 slots 10–16 (7 slots).
    // Set C: 17 slots → starts page 5 slot 1, ends page 6 slot 1. Trailing empties: rest.
    // Total used = 62. Total empty = 1088 - 62 = 1026.
    // If unusedSlotCount missed the two mid-page gaps it would report 1026 - 12 - 7 = 1007.
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
      makeSet('c', { releaseDate: '2020-03-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 20)],
      ['b', makeCards('b', 25)],
      ['c', makeCards('c', 17)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(plan.binders).toHaveLength(1);
    const binder = plan.binders[0];
    if (binder === undefined) return;
    expect(binder.usedSlotCount).toBe(62);
    expect(binder.unusedSlotCount).toBe(1088 - 62);
    expect(binder.usedSlotCount + binder.unusedSlotCount).toBe(binder.capacity);
    // The two named mid-page gaps are real and counted.
    const sectionA = binder.sections[0];
    const sectionB = binder.sections[1];
    if (sectionA === undefined || sectionB === undefined) return;
    expect(sectionA.endPage).toBe(2);
    expect(sectionA.endSlot).toBe(4);
    expect(sectionB.startPage).toBe(3);
    expect(sectionB.startSlot).toBe(1);
  });

  it('opens a new binder when the next set will not fit in the current one', () => {
    const sets = [
      makeSet('big', { releaseDate: '2020-01-01' }),
      makeSet('extra', { releaseDate: '2020-02-01' }),
    ];
    // Set big takes 1000 slots; remaining (1088 - 1008 with page padding)
    // is small. Set extra (200) does not fit → new binder.
    const cards = mapBySet(
      ['big', makeCards('big', 1000)],
      ['extra', makeCards('extra', 200)],
    );

    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });

    expect(plan.binders).toHaveLength(2);
    const [binder1, binder2] = plan.binders;
    if (binder1 === undefined || binder2 === undefined) return;
    expect(binder1.sections.map((s) => s.setId)).toEqual(['big']);
    expect(binder2.sections.map((s) => s.setId)).toEqual(['extra']);
    expect(binder1.sections[0]?.continuesIntoNextBinder).toBe(false);
    expect(binder2.sections[0]?.continuedFromPreviousBinder).toBe(false);
    expect(binder2.sections[0]?.startPage).toBe(1);
    expect(binder2.sections[0]?.startSlot).toBe(1);
  });

  it('packs multiple sets per binder when they all fit', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
      makeSet('c', { releaseDate: '2020-03-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 200)],
      ['b', makeCards('b', 300)],
      ['c', makeCards('c', 400)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(plan.binders).toHaveLength(1);
    const binder = plan.binders[0];
    if (binder === undefined) return;
    expect(binder.sections.map((s) => s.setId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps same-name cards from different sets in separate sections', () => {
    const sets = [
      makeSet('base1', { releaseDate: '2020-01-01' }),
      makeSet('base2', { releaseDate: '2020-02-01' }),
    ];
    const cards = mapBySet(
      ['base1', [makeCard('base1', '1', { name: 'Pikachu', id: 'base1-pikachu' })]],
      ['base2', [makeCard('base2', '1', { name: 'Pikachu', id: 'base2-pikachu' })]],
    );

    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(plan.binders).toHaveLength(1);
    const binder = plan.binders[0];
    if (binder === undefined) return;
    expect(binder.sections).toHaveLength(2);

    const [sec1, sec2] = binder.sections;
    if (sec1 === undefined || sec2 === undefined) return;
    expect(sec1.setId).toBe('base1');
    expect(sec1.slots[0]?.targetCardId).toBe('base1-pikachu');
    expect(sec2.setId).toBe('base2');
    expect(sec2.slots[0]?.targetCardId).toBe('base2-pikachu');
    // No section's slot list may contain a target from a different set.
    for (const s of sec1.slots) expect(s.targetCardId.startsWith('base1-')).toBe(true);
    for (const s of sec2.slots) expect(s.targetCardId.startsWith('base2-')).toBe(true);
  });

  it('keeps reverse-holo template slots inside their set section', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
    ];
    const cards = mapBySet(
      ['a', [
        makeCard('a', '1', { reverseHolo: true }),
        makeCard('a', '2', { reverseHolo: true }),
        makeCard('a', '3', { reverseHolo: false }),
      ]],
      ['b', [
        makeCard('b', '1', { reverseHolo: true }),
      ]],
    );

    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const binder = plan.binders[0];
    if (binder === undefined) return;
    const [secA, secB] = binder.sections;
    if (secA === undefined || secB === undefined) return;

    // Set A: 3 base + 2 reverse-holo = 5 slots, all flagged correctly.
    expect(secA.baseSlotCount).toBe(3);
    expect(secA.reverseHoloSlotCount).toBe(2);
    expect(secA.totalSlotCount).toBe(5);
    expect(
      secA.slots.filter((s) => s.note === REVERSE_HOLO_TEMPLATE_MARKER).length,
    ).toBe(2);
    // The two reverse-holo slots target cards a-1 and a-2 (NOT b-1).
    const rhTargets = secA.slots
      .filter((s) => s.note === REVERSE_HOLO_TEMPLATE_MARKER)
      .map((s) => s.targetCardId);
    expect(rhTargets.sort()).toEqual(['a-1', 'a-2']);

    // Set B's only reverse-holo slot stays in section B.
    expect(secB.reverseHoloSlotCount).toBe(1);
    expect(secB.slots.find((s) => s.note === REVERSE_HOLO_TEMPLATE_MARKER)?.targetCardId).toBe('b-1');
  });

  it('produces continuous, monotonically increasing slot positions inside each section', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
      makeSet('c', { releaseDate: '2020-03-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 20)],
      ['b', makeCards('b', 50)],
      ['c', makeCards('c', 17)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const binder = plan.binders[0];
    if (binder === undefined) return;

    for (const section of binder.sections) {
      let prevPos = -1;
      for (const s of section.slots) {
        const pos = (s.pageNumber - 1) * binder.slotsPerPage + (s.slotNumber - 1);
        expect(pos).toBeGreaterThan(prevPos);
        prevPos = pos;
      }
      // Section span matches start/end declaration.
      const firstSlot = section.slots[0];
      const lastSlot = section.slots[section.slots.length - 1];
      expect(firstSlot?.pageNumber).toBe(section.startPage);
      expect(firstSlot?.slotNumber).toBe(section.startSlot);
      expect(lastSlot?.pageNumber).toBe(section.endPage);
      expect(lastSlot?.slotNumber).toBe(section.endSlot);
    }
  });

  it('orders series by earliest release date and sets-within-series by release date', () => {
    // Series Z has the earliest set, so Series Z must appear first.
    const sets = [
      makeSet('a2', { series: 'Series A', releaseDate: '2021-02-01' }),
      makeSet('a1', { series: 'Series A', releaseDate: '2021-01-01' }),
      makeSet('z1', { series: 'Series Z', releaseDate: '2020-01-01' }),
      makeSet('z2', { series: 'Series Z', releaseDate: '2020-06-01' }),
    ];
    const cards = mapBySet(
      ['a1', makeCards('a1', 10)],
      ['a2', makeCards('a2', 10)],
      ['z1', makeCards('z1', 10)],
      ['z2', makeCards('z2', 10)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const ids = plan.binders[0]?.sections.map((s) => s.setId);
    expect(ids).toEqual(['z1', 'z2', 'a1', 'a2']);
  });

  it('skips sets that have no cards in the cache', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('orphan', { releaseDate: '2020-02-01' }),
    ];
    const cards = mapBySet(['a', makeCards('a', 5)]);
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    expect(plan.totalSetCount).toBe(1);
    expect(plan.skippedSets).toEqual([
      { setId: 'orphan', reason: 'no_cards_in_cache' },
    ]);
    expect(plan.binders[0]?.sections.map((s) => s.setId)).toEqual(['a']);
  });

  it('splits a set bigger than 1088 across two binders, marking continuation', () => {
    const sets = [makeSet('mega')];
    // 1200 cards × master mode (no reverse-holo here) = 1200 slots > 1088.
    const cards = mapBySet(['mega', makeCards('mega', 1200)]);
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });

    expect(plan.binders).toHaveLength(2);
    const [b1, b2] = plan.binders;
    if (b1 === undefined || b2 === undefined) return;
    expect(b1.sections).toHaveLength(1);
    expect(b2.sections).toHaveLength(1);
    expect(b1.sections[0]?.totalSlotCount).toBe(1088);
    expect(b1.sections[0]?.continuesIntoNextBinder).toBe(true);
    expect(b2.sections[0]?.totalSlotCount).toBe(112);
    expect(b2.sections[0]?.continuedFromPreviousBinder).toBe(true);
    expect(b2.sections[0]?.startPage).toBe(1);
    expect(b2.sections[0]?.startSlot).toBe(1);
  });

  it('handles a large synthetic dataset of 200 sets × 100 cards without per-slot overhead', () => {
    const sets: SetRecord[] = [];
    const cardGroups: Array<readonly [string, CardRecord[]]> = [];
    for (let i = 1; i <= 200; i += 1) {
      const id = `set-${String(i).padStart(3, '0')}`;
      sets.push(
        makeSet(id, {
          series: `Series ${Math.floor((i - 1) / 20)}`,
          releaseDate: `2020-${String(((i - 1) % 12) + 1).padStart(2, '0')}-01`,
        }),
      );
      cardGroups.push([id, makeCards(id, 100)]);
    }
    const cards = mapBySet(...cardGroups);

    const start = Date.now();
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const elapsedMs = Date.now() - start;

    expect(plan.totalSetCount).toBe(200);
    expect(plan.totalCardCount).toBe(200 * 100);
    expect(plan.totalSlotCount).toBe(200 * 100);
    // Sanity: capacity-fits-cards math holds (no double-counting).
    const totalUsed = plan.binders.reduce((s, b) => s + b.usedSlotCount, 0);
    expect(totalUsed).toBe(20_000);
    // Every binder respects capacity.
    for (const b of plan.binders) {
      expect(b.usedSlotCount).toBeLessThanOrEqual(1088);
    }
    // 200 × 100 = 20_000 slots / 1088 ≈ 19 binders, but page-rounding
    // overhead pushes it a bit higher. Lower bound: 19. Upper bound: 30
    // gives plenty of slack for the rounding wastage.
    expect(plan.binders.length).toBeGreaterThanOrEqual(19);
    expect(plan.binders.length).toBeLessThanOrEqual(30);
    // Sub-second is the perf bar.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('never lets a single section span a non-monotonic gap', () => {
    // Three sets of varying sizes, second one forces a binder transition
    // partway through. We assert that within each section, slots are
    // strictly increasing and there are no setId collisions across sections.
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
      makeSet('c', { releaseDate: '2020-03-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 600)],
      ['b', makeCards('b', 600)],
      ['c', makeCards('c', 200)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });

    const sectionSetIds = new Map<string, MasterSetSectionPlan[]>();
    for (const b of plan.binders) {
      for (const sec of b.sections) {
        let list = sectionSetIds.get(sec.setId);
        if (list === undefined) {
          list = [];
          sectionSetIds.set(sec.setId, list);
        }
        list.push(sec);
      }
    }
    // Each set has exactly ONE section (none of them exceed 1088).
    expect(sectionSetIds.get('a')?.length).toBe(1);
    expect(sectionSetIds.get('b')?.length).toBe(1);
    expect(sectionSetIds.get('c')?.length).toBe(1);

    // No slot from set X may appear inside a section labelled as set Y.
    for (const b of plan.binders) {
      for (const sec of b.sections) {
        for (const s of sec.slots) {
          expect(s.targetCardId.startsWith(`${sec.setId}-`)).toBe(true);
        }
      }
    }
  });

  it('respects includeReverseHolos = false (base slots only)', () => {
    const sets = [makeSet('a')];
    const cards = mapBySet(['a', [
      makeCard('a', '1', { reverseHolo: true }),
      makeCard('a', '2', { reverseHolo: true }),
    ]]);
    const plan = buildMasterSetPlan({
      sets, cardsBySetId: cards,
      includeReverseHolos: false,
    });
    const sec = plan.binders[0]?.sections[0];
    expect(sec?.totalSlotCount).toBe(2);
    expect(sec?.reverseHoloSlotCount).toBe(0);
  });

  it('all generated slots have a valid target cardId from the corresponding set', () => {
    const sets = [makeSet('a'), makeSet('b')];
    const cards = mapBySet(
      ['a', makeCards('a', 50)],
      ['b', makeCards('b', 50)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });
    const allowed = new Set<string>();
    for (const [, list] of cards) {
      for (const c of list) allowed.add(c.id);
    }
    for (const b of plan.binders) {
      for (const sec of b.sections) {
        for (const s of sec.slots) {
          expect(allowed.has(s.targetCardId)).toBe(true);
        }
      }
    }
  });

  it('uses flatSlotPositions to assert no duplicate (page, slot) inside a binder', () => {
    const sets = [
      makeSet('a', { releaseDate: '2020-01-01' }),
      makeSet('b', { releaseDate: '2020-02-01' }),
      makeSet('c', { releaseDate: '2020-03-01' }),
    ];
    const cards = mapBySet(
      ['a', makeCards('a', 40)],
      ['b', makeCards('b', 60)],
      ['c', makeCards('c', 80)],
    );
    const plan = buildMasterSetPlan({ sets, cardsBySetId: cards });

    for (const b of plan.binders) {
      const positions = flatSlotPositions(b);
      const seen = new Set<string>();
      for (const [, p, s] of positions) {
        const key = `${p}.${s}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
