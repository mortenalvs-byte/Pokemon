// PR 28 — best-copy scoring engine. Pure tests, no DB.

import { describe, expect, it } from 'vitest';

import { recommendBestCopy } from '../src/services/best-copy-service';
import type {
  CardFinish,
  HoldingRecord,
  HoldingStatus,
  RawCondition,
} from '../src/domain/types';

function holding(
  id: string,
  overrides: Partial<HoldingRecord> = {},
): HoldingRecord {
  return {
    id,
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
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('recommendBestCopy (PR 28)', () => {
  // 1
  it('empty candidates → no_candidates', () => {
    const r = recommendBestCopy({ requiredFinish: 'normal', candidates: [] });
    expect(r.status).toBe('no_candidates');
    expect(r.recommendedHoldingId).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  // 2
  it('single valid candidate → recommended', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [holding('h1')],
    });
    expect(r.status).toBe('recommended');
    expect(r.recommendedHoldingId).toBe('h1');
    expect(r.candidates).toHaveLength(1);
  });

  // 3
  it('wrong finish → never recommended', () => {
    const r = recommendBestCopy({
      requiredFinish: 'reverse_holo',
      candidates: [holding('h1', { finish: 'normal' })],
    });
    expect(r.status).toBe('no_candidates');
    expect(r.recommendedHoldingId).toBeNull();
  });

  // 4
  it('NM raw beats LP raw', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('lp', { rawCondition: 'LP' }),
        holding('nm', { rawCondition: 'NM' }),
      ],
    });
    expect(r.status).toBe('recommended');
    expect(r.recommendedHoldingId).toBe('nm');
  });

  // 5
  it('LP raw beats MP raw', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('mp', { rawCondition: 'MP' }),
        holding('lp', { rawCondition: 'LP' }),
      ],
    });
    expect(r.recommendedHoldingId).toBe('lp');
  });

  // 6
  it('MP raw beats HP raw', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('hp', { rawCondition: 'HP' }),
        holding('mp', { rawCondition: 'MP' }),
      ],
    });
    expect(r.recommendedHoldingId).toBe('mp');
  });

  // 7
  it('raw beats graded when a raw candidate exists', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('graded', {
          conditionType: 'graded',
          rawCondition: null,
          gradingCompany: 'PSA',
          grade: 9,
        }),
        holding('raw', { rawCondition: 'NM' }),
      ],
    });
    expect(r.recommendedHoldingId).toBe('raw');
  });

  // 8
  it('graded can win when no raw candidate exists', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('a', {
          conditionType: 'graded',
          rawCondition: null,
          gradingCompany: 'PSA',
          grade: 9,
        }),
        holding('b', {
          conditionType: 'graded',
          rawCondition: null,
          gradingCompany: 'BGS',
          grade: 9,
          status: 'duplicate',
        }),
      ],
    });
    expect(r.status).toBe('recommended');
    expect(r.recommendedHoldingId).toBe('a');
  });

  // 9
  it('owned beats duplicate', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('dup', { status: 'duplicate' as HoldingStatus }),
        holding('owned'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('owned');
  });

  // 10
  it('owned beats for_sale', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('sale', { status: 'for_sale' }),
        holding('owned'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('owned');
  });

  // 11
  it('owned beats for_trade', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('trade', { status: 'for_trade' }),
        holding('owned'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('owned');
  });

  // 12
  it('owned beats upgrade_needed', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('upgrade', { status: 'upgrade_needed' }),
        holding('owned'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('owned');
  });

  // 13
  it('ordered/wanted are penalised vs owned', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('ordered', { status: 'ordered' }),
        holding('wanted', { status: 'wanted' }),
        holding('owned'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('owned');
  });

  // 14
  it('English beats non-English with otherwise equal candidates', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('jp', { language: 'jp' }),
        holding('en'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('en');
  });

  // 15
  it('specialVariant penalised when a non-special alternative exists', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('special', { specialVariant: true }),
        holding('plain'),
      ],
    });
    expect(r.recommendedHoldingId).toBe('plain');
    const specialScore = r.candidates.find((c) => c.holdingId === 'special');
    expect(specialScore?.penalties).toContain('Spesial-variant nedprioritert');
  });

  // 16
  it('specialVariant NOT penalised if every valid candidate is special', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('a', { specialVariant: true, rawCondition: 'LP' }),
        holding('b', { specialVariant: true, rawCondition: 'NM' }),
      ],
    });
    expect(r.recommendedHoldingId).toBe('b');
    const aScore = r.candidates.find((c) => c.holdingId === 'a');
    expect(aScore?.penalties).not.toContain('Spesial-variant nedprioritert');
  });

  // 17
  it('equal top score → manual_required', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('a'),
        holding('b'),
      ],
    });
    expect(r.status).toBe('manual_required');
    expect(r.recommendedHoldingId).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  // 18
  it('clear winner → recommended (verified deterministic)', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('lp', { rawCondition: 'LP' }),
        holding('nm', { rawCondition: 'NM' }),
        holding('mp', { rawCondition: 'MP' }),
      ],
    });
    expect(r.status).toBe('recommended');
    expect(r.recommendedHoldingId).toBe('nm');
  });

  // 19
  it('candidates returned sorted score descending', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('mp', { rawCondition: 'MP' }),
        holding('nm', { rawCondition: 'NM' }),
        holding('lp', { rawCondition: 'LP' }),
      ],
    });
    const ids = r.candidates.map((c) => c.holdingId);
    expect(ids).toEqual(['nm', 'lp', 'mp']);
  });

  // 20
  it('reasons are populated for the recommended candidate', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [holding('only')],
    });
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons).toContain('Owned');
  });

  // 21
  it('penalties are populated when applicable', () => {
    const r = recommendBestCopy({
      requiredFinish: 'normal',
      candidates: [
        holding('dup', { status: 'duplicate' }),
        holding('owned'),
      ],
    });
    const dup = r.candidates.find((c) => c.holdingId === 'dup');
    expect(dup?.penalties).toContain('Duplikat');
  });

  // 22
  it('input array is not mutated', () => {
    const original = [
      holding('lp', { rawCondition: 'LP' as RawCondition }),
      holding('nm', { rawCondition: 'NM' as RawCondition }),
    ];
    const before = original.map((h) => h.id).join(',');
    recommendBestCopy({
      requiredFinish: 'normal' as CardFinish,
      candidates: original,
    });
    const after = original.map((h) => h.id).join(',');
    expect(after).toBe(before);
  });
});
