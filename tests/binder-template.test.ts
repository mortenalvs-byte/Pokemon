// Pure tests for binder template generator.

import { describe, expect, it } from 'vitest';

import {
  compareCardNumbers,
  generateFromSetSlots,
} from '../src/domain/binder-template';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import type { CardRecord } from '../src/domain/types';

function makeCard(
  number: string,
  options: { id?: string; reverseHolo?: boolean } = {},
): CardRecord {
  return {
    id: options.id ?? `base1-${number}`,
    setId: 'base1',
    name: `Card ${number}`,
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
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

describe('compareCardNumbers', () => {
  it('orders pure integers numerically', () => {
    const arr = ['10', '2', '1', '102', '9'].sort(compareCardNumbers);
    expect(arr).toEqual(['1', '2', '9', '10', '102']);
  });

  it('puts pure integers before mixed strings', () => {
    const arr = ['TG01', '5', 'SV001', '12'].sort(compareCardNumbers);
    expect(arr.slice(0, 2)).toEqual(['5', '12']);
    expect(arr.slice(2).sort()).toEqual(['SV001', 'TG01']);
  });

  it('falls back to lexicographic for two non-numeric strings', () => {
    expect(compareCardNumbers('TG01', 'TG02')).toBeLessThan(0);
    expect(compareCardNumbers('TG10', 'TG02')).toBeGreaterThan(0);
  });
});

describe('generateFromSetSlots', () => {
  it('standard mode produces one slot per card with correct page/slot indexing for 9-slot pages', () => {
    const cards = [makeCard('1'), makeCard('2'), makeCard('3'), makeCard('4'), makeCard('5'), makeCard('6'), makeCard('7'), makeCard('8'), makeCard('9'), makeCard('10')];
    const result = generateFromSetSlots(cards, {
      slotsPerPage: 9,
      completionMode: 'standard',
      includeReverseHolos: false,
    });
    expect(result.summary.baseSlotCount).toBe(10);
    expect(result.summary.reverseHoloSlotCount).toBe(0);
    expect(result.summary.totalSlotCount).toBe(10);
    expect(result.summary.totalPages).toBe(2);

    expect(result.slots[0]).toEqual({
      pageNumber: 1,
      slotNumber: 1,
      targetCardId: 'base1-1',
      note: null,
    });
    expect(result.slots[8]).toEqual({
      pageNumber: 1,
      slotNumber: 9,
      targetCardId: 'base1-9',
      note: null,
    });
    expect(result.slots[9]).toEqual({
      pageNumber: 2,
      slotNumber: 1,
      targetCardId: 'base1-10',
      note: null,
    });
  });

  it('master mode adds a reverse-holo slot only for cards with the marker', () => {
    const cards = [
      makeCard('1', { reverseHolo: true }),
      makeCard('2', { reverseHolo: false }),
      makeCard('3', { reverseHolo: true }),
    ];
    const result = generateFromSetSlots(cards, {
      slotsPerPage: 18,
      completionMode: 'master',
      includeReverseHolos: true,
    });
    expect(result.summary.baseSlotCount).toBe(3);
    expect(result.summary.reverseHoloSlotCount).toBe(2);
    expect(result.summary.totalSlotCount).toBe(5);
    expect(result.summary.totalPages).toBe(1);

    // base1-1 normal, base1-1 reverse, base1-2 normal, base1-3 normal, base1-3 reverse
    const ids = result.slots.map((s) => s.targetCardId);
    expect(ids).toEqual(['base1-1', 'base1-1', 'base1-2', 'base1-3', 'base1-3']);
    const notes = result.slots.map((s) => s.note);
    expect(notes).toEqual([
      null,
      REVERSE_HOLO_TEMPLATE_MARKER,
      null,
      null,
      REVERSE_HOLO_TEMPLATE_MARKER,
    ]);
  });

  it('master mode skips reverse-holo slots when includeReverseHolos is false', () => {
    const cards = [
      makeCard('1', { reverseHolo: true }),
      makeCard('2', { reverseHolo: true }),
    ];
    const result = generateFromSetSlots(cards, {
      slotsPerPage: 9,
      completionMode: 'master',
      includeReverseHolos: false,
    });
    expect(result.summary.reverseHoloSlotCount).toBe(0);
    expect(result.summary.totalSlotCount).toBe(2);
  });

  it('standard mode never adds reverse-holo slots even if cards have the marker', () => {
    const cards = [makeCard('1', { reverseHolo: true })];
    const result = generateFromSetSlots(cards, {
      slotsPerPage: 9,
      completionMode: 'standard',
      includeReverseHolos: true,
    });
    expect(result.summary.reverseHoloSlotCount).toBe(0);
    expect(result.summary.totalSlotCount).toBe(1);
  });

  it('rejects grand_master', () => {
    expect(() =>
      generateFromSetSlots([makeCard('1')], {
        slotsPerPage: 9,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        completionMode: 'grand_master' as any,
        includeReverseHolos: false,
      }),
    ).toThrow();
  });

  it('rejects an invalid slotsPerPage', () => {
    expect(() =>
      generateFromSetSlots([makeCard('1')], {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        slotsPerPage: 12 as any,
        completionMode: 'standard',
        includeReverseHolos: false,
      }),
    ).toThrow();
  });

  it('returns at least totalPages=1 even for 0 cards', () => {
    const result = generateFromSetSlots([], {
      slotsPerPage: 9,
      completionMode: 'standard',
      includeReverseHolos: false,
    });
    expect(result.summary.totalSlotCount).toBe(0);
    expect(result.summary.totalPages).toBe(1);
    expect(result.slots).toHaveLength(0);
  });

  it('orders cards naturally by number, then by id as final tiebreak', () => {
    const cards = [
      makeCard('10'),
      makeCard('1'),
      makeCard('2'),
      makeCard('TG01'),
      makeCard('TG02'),
    ];
    const result = generateFromSetSlots(cards, {
      slotsPerPage: 9,
      completionMode: 'standard',
      includeReverseHolos: false,
    });
    expect(result.slots.map((s) => s.targetCardId)).toEqual([
      'base1-1',
      'base1-2',
      'base1-10',
      'base1-TG01',
      'base1-TG02',
    ]);
  });
});
