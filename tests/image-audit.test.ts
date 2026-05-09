// PR 28 review patch (Phase 5) — image audit + fallback tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetImageAuditForTests,
  auditCardImageCoverage,
  installImageAudit,
} from '../src/qa/image-audit';
import { createLazyImage } from '../src/utils/lazy-image';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import type { CardRecord } from '../src/domain/types';

function fixtureCard(
  id: string,
  setId: string,
  imageSmall: string | null,
  imageLarge: string | null = null,
): CardRecord {
  return {
    id,
    setId,
    name: `Card ${id}`,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall,
    imageLarge,
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-09T00:00:00.000Z',
  };
}

describe('createLazyImage — Phase 5 fallback rendering', () => {
  it('renders an <img> with src/alt/loading="lazy" when src is present', () => {
    const node = createLazyImage({
      src: 'https://images.pokemontcg.io/base1/1.png',
      alt: 'Alakazam',
      width: 32,
      height: 44,
    });
    expect(node.tagName).toBe('IMG');
    const img = node as HTMLImageElement;
    expect(img.alt).toBe('Alakazam');
    expect(img.loading).toBe('lazy');
    expect(img.src).toBe('https://images.pokemontcg.io/base1/1.png');
  });

  it('renders a visible "No image" placeholder when src is null', () => {
    const node = createLazyImage({ src: null, alt: 'Alakazam' });
    expect(node.tagName).toBe('SPAN');
    expect(node.textContent).toBe('No image');
    expect(node.getAttribute('data-lazy-image-fallback')).toBe('missing');
    expect(node.getAttribute('aria-label')).toBe('Alakazam');
    expect(node.getAttribute('role')).toBe('img');
  });

  it('renders a visible "No image" placeholder when src is empty string', () => {
    const node = createLazyImage({ src: '', alt: 'Alakazam' });
    expect(node.tagName).toBe('SPAN');
    expect(node.textContent).toBe('No image');
    expect(node.getAttribute('data-lazy-image-fallback')).toBe('missing');
  });

  it('swaps the <img> for a load-error placeholder on error and dispatches the audit event', () => {
    _resetImageAuditForTests();
    installImageAudit();
    const events: Array<{ src: string; route: string }> = [];
    window.addEventListener('pokemon:image-load-error', ((e: Event) => {
      const ce = e as CustomEvent<{ src: string; route: string }>;
      events.push(ce.detail);
    }) as EventListener);

    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const node = createLazyImage({
      src: 'https://broken.invalid/missing.png',
      alt: 'broken',
      width: 32,
      height: 44,
    });
    parent.appendChild(node);
    node.dispatchEvent(new Event('error'));

    const fallback = parent.querySelector('[data-lazy-image-fallback]');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('data-lazy-image-fallback')).toBe(
      'load-error',
    );
    expect(fallback?.textContent).toBe('No image');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.src).toBe('https://broken.invalid/missing.png');
    document.body.removeChild(parent);
  });
});

describe('auditCardImageCoverage', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    _resetImageAuditForTests();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('returns zero coverage when no cards exist', async () => {
    const audit = await auditCardImageCoverage(db);
    expect(audit.totalCards).toBe(0);
    expect(audit.cardsWithImageSmall).toBe(0);
    expect(audit.cardsWithImageLarge).toBe(0);
    expect(audit.cardsMissingBoth).toBe(0);
    expect(audit.missingSample).toEqual([]);
  });

  it('counts each axis independently', async () => {
    await db.cards.bulkPut([
      fixtureCard('a', 's1', 'small.png', 'large.png'), // both
      fixtureCard('b', 's1', 'small.png', null), // small only
      fixtureCard('c', 's1', null, 'large.png'), // large only
      fixtureCard('d', 's1', null, null), // neither
    ]);
    const audit = await auditCardImageCoverage(db);
    expect(audit.totalCards).toBe(4);
    expect(audit.cardsWithImageSmall).toBe(2);
    expect(audit.cardsWithImageLarge).toBe(2);
    expect(audit.cardsWithBoth).toBe(1);
    expect(audit.cardsMissingBoth).toBe(1);
    expect(audit.missingSample).toHaveLength(1);
    expect(audit.missingSample[0]?.id).toBe('d');
  });

  it('caps the missing-card sample at 20', async () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      fixtureCard(`m${i}`, 's', null, null),
    );
    await db.cards.bulkPut(cards);
    const audit = await auditCardImageCoverage(db);
    expect(audit.cardsMissingBoth).toBe(30);
    expect(audit.missingSample).toHaveLength(20);
  });

  it('treats empty-string image fields as missing', async () => {
    await db.cards.bulkPut([fixtureCard('e', 's', '', '')]);
    const audit = await auditCardImageCoverage(db);
    expect(audit.cardsWithImageSmall).toBe(0);
    expect(audit.cardsWithImageLarge).toBe(0);
    expect(audit.cardsMissingBoth).toBe(1);
  });

  it('captures runtime load failures dispatched via the lazy-image event', async () => {
    installImageAudit();
    window.dispatchEvent(
      new CustomEvent('pokemon:image-load-error', {
        detail: {
          src: 'https://broken.example/1.png',
          alt: 'card 1',
          route: 'browse',
          ts: '2026-05-09T00:00:00.000Z',
        },
      }),
    );
    const audit = await auditCardImageCoverage(db);
    expect(audit.loadFailuresTotal).toBe(1);
    expect(audit.loadFailuresSample[0]?.src).toBe(
      'https://broken.example/1.png',
    );
    expect(audit.loadFailuresSample[0]?.route).toBe('browse');
  });
});
