// PR 36 — self-tests for the new shared test helpers.
//
// Goal: catch regressions in the helpers themselves (default
// shape, override merging, sort order). Tiny coverage — the
// helpers are thin and the consumer tests would catch most
// breakage anyway, but a one-line factory output assertion makes
// the intent explicit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeCard, makeUnverifiedCard } from './cards';
import { holdingInput } from './holdings';
import { seedBinderWithSlots } from './binders';
import { settle, clickByText } from './dom';
import { closeAndDelete, freshDb } from './fresh-db';
import type { PokemonTrackerDB } from '../../src/db/database';

describe('helpers/cards — makeCard', () => {
  it('derives setId from id by splitting on the first hyphen', () => {
    expect(makeCard('base1-4').setId).toBe('base1');
  });

  it('default tcgplayer.prices contains the five common variant keys', () => {
    const card = makeCard('base1-4');
    const tcgplayer = card.tcgplayer as { prices: Record<string, unknown> };
    expect(Object.keys(tcgplayer.prices).sort()).toEqual([
      '1stEditionHolofoil',
      '1stEditionNormal',
      'holofoil',
      'normal',
      'reverseHolofoil',
    ]);
  });

  it('overrides take precedence over defaults', () => {
    const card = makeCard('base1-4', { overrides: { name: 'Charizard' } });
    expect(card.name).toBe('Charizard');
  });

  it('makeUnverifiedCard returns tcgplayer: null', () => {
    expect(makeUnverifiedCard('base1-4').tcgplayer).toBeNull();
  });
});

describe('helpers/holdings — holdingInput', () => {
  it('returns a HoldingInput with NM raw + finish=normal + edition=unlimited defaults', () => {
    const h = holdingInput('base1-4');
    expect(h.cardId).toBe('base1-4');
    expect(h.quantity).toBe(1);
    expect(h.conditionType).toBe('raw');
    expect(h.rawCondition).toBe('NM');
    expect(h.finish).toBe('normal');
    expect(h.edition).toBe('unlimited');
    expect(h.status).toBe('owned');
    expect(h.specialVariant).toBe(false);
    expect(h.tags).toEqual([]);
  });

  it('overrides any field via the second argument', () => {
    const h = holdingInput('base1-4', {
      finish: 'reverse_holo',
      rawCondition: 'LP',
      tags: ['favorite'],
    });
    expect(h.finish).toBe('reverse_holo');
    expect(h.rawCondition).toBe('LP');
    expect(h.tags).toEqual(['favorite']);
  });
});

describe('helpers/binders — seedBinderWithSlots', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('returns a binder with the requested slot count, sorted by (page, slot)', async () => {
    const seeded = await seedBinderWithSlots(db, {
      name: 'Test',
      totalPages: 2,
      slotsPerPage: 9,
    });
    expect(seeded.binder.name).toBe('Test');
    expect(seeded.slots.length).toBe(18);
    // Sorted: page 1 slots 1..9, then page 2 slots 1..9.
    expect(seeded.slots[0]?.pageNumber).toBe(1);
    expect(seeded.slots[0]?.slotNumber).toBe(1);
    expect(seeded.slots[8]?.pageNumber).toBe(1);
    expect(seeded.slots[8]?.slotNumber).toBe(9);
    expect(seeded.slots[9]?.pageNumber).toBe(2);
    expect(seeded.slots[9]?.slotNumber).toBe(1);
  });

  it('assigns targetCardIds to the first N slots and flips status to wanted', async () => {
    const seeded = await seedBinderWithSlots(db, {
      totalPages: 1,
      slotsPerPage: 9,
      targetCardIds: ['base1-1', 'base1-2', 'base1-3'],
    });
    expect(seeded.slots[0]?.targetCardId).toBe('base1-1');
    expect(seeded.slots[0]?.status).toBe('wanted');
    expect(seeded.slots[1]?.targetCardId).toBe('base1-2');
    expect(seeded.slots[2]?.targetCardId).toBe('base1-3');
    // Untouched slots keep their default null / empty status.
    expect(seeded.slots[3]?.targetCardId).toBeNull();
    expect(seeded.slots[3]?.status).toBe('empty');
  });
});

describe('helpers/dom — settle + clickByText', () => {
  it('settle(0) resolves on the next tick', async () => {
    const start = Date.now();
    await settle(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });

  it('settle() defaults to 80 ms', async () => {
    const start = Date.now();
    await settle();
    expect(Date.now() - start).toBeGreaterThanOrEqual(70); // small jsdom slack
  });

  it('clickByText finds and clicks the matching button', () => {
    const root = document.createElement('div');
    const a = document.createElement('button');
    a.textContent = 'Cancel';
    const b = document.createElement('button');
    b.textContent = 'Save';
    root.appendChild(a);
    root.appendChild(b);
    let clicks = 0;
    b.addEventListener('click', () => {
      clicks += 1;
    });
    clickByText(root, 'Save');
    expect(clicks).toBe(1);
  });

  it('clickByText throws with a helpful list when no button matches', () => {
    const root = document.createElement('div');
    const a = document.createElement('button');
    a.textContent = 'Cancel';
    root.appendChild(a);
    expect(() => clickByText(root, 'Save')).toThrow(/clickByText.*"Save".*Cancel/);
  });
});
