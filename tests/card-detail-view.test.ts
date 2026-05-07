import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountCardDetailView } from '../src/views/card-detail';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const sampleSet: SetRecord = {
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

const sampleCard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: ['Stage 2'],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: {
    prices: {
      holofoil: { market: 350.5, mid: 320, low: 290 },
      reverseHolofoil: { market: 80, mid: 75, low: 60 },
    },
  },
  cardmarket: {
    prices: {
      averageSellPrice: 285.4,
      trendPrice: 310,
      lowPrice: 250,
    },
  },
  updatedAt: '2026-05-06T00:00:00.000Z',
};

describe('Card detail view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(sampleCard);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(30);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders the card metadata + prices when the card is cached', async () => {
    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(root.querySelector('.card-detail-view__name')?.textContent).toBe(
      'Charizard',
    );
    const meta = root.querySelector('.card-detail-view__metadata');
    expect(meta?.textContent ?? '').toMatch(/Sett[\s\S]*Base/);
    expect(meta?.textContent ?? '').toMatch(/Nummer[\s\S]*4/);
    expect(meta?.textContent ?? '').toMatch(/Rarity[\s\S]*Rare Holo/);

    // Prices: tcgplayer should produce two rows (holofoil, reverseHolofoil).
    const prices = root.querySelector('.card-detail-view__prices');
    expect(prices?.textContent ?? '').toMatch(/TCGplayer/);
    expect(prices?.textContent ?? '').toMatch(/Cardmarket/);
    expect(prices?.textContent ?? '').toMatch(/350\.50/);
    expect(prices?.textContent ?? '').toMatch(/EUR/);
  });

  it('shows a "not in cache" message when the cardId is unknown', async () => {
    window.location.hash = `card/${encodeURIComponent('does-not-exist')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(root.textContent ?? '').toMatch(/finnes ikke i lokal cache/i);
  });

  it('shows a generic message when no card id is in the URL', async () => {
    // Force getCurrentCardId to return null via a hash with empty id.
    window.location.hash = 'card/';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(root.textContent ?? '').toMatch(/Velg et kort fra Browse/i);
  });

  it('back button navigates to #browse', async () => {
    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const back = root.querySelector<HTMLButtonElement>(
      '[data-action="back"]',
    ) as HTMLButtonElement;
    back.click();
    expect(window.location.hash).toBe('#browse');
  });

  it('Both Add to collection and Add to wishlist are enabled (PR 7a + 7b)', async () => {
    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const collectionButton = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-collection"]',
    );
    expect(collectionButton).not.toBeNull();
    expect(collectionButton?.disabled).toBe(false);

    const wishlistButton = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-wishlist"]',
    );
    expect(wishlistButton).not.toBeNull();
    expect(wishlistButton?.disabled).toBe(false);
  });

  it('renders "Ingen prisdata" when both price fields are null', async () => {
    await createCardsRepo(db).upsert({
      ...sampleCard,
      id: 'base1-99',
      tcgplayer: null,
      cardmarket: null,
    });
    window.location.hash = `card/${encodeURIComponent('base1-99')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(root.textContent ?? '').toMatch(/Ingen prisdata/i);
  });

  it('does not crash when the price field has an unfamiliar shape', async () => {
    await createCardsRepo(db).upsert({
      ...sampleCard,
      id: 'base1-weird',
      tcgplayer: { random: 'garbage' } as unknown,
      cardmarket: 'not even an object' as unknown,
    });
    window.location.hash = `card/${encodeURIComponent('base1-weird')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    // Falls back to "Ingen prisdata" — no thrown error, no script element
    // injected from the unknown shape.
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent ?? '').toMatch(/Ingen prisdata/i);
  });

  it('renders raw card name and set name as text, not as HTML', async () => {
    await createSetsRepo(db).upsert({
      ...sampleSet,
      id: 'evil',
      name: '<script>alert(1)</script>',
    });
    await createCardsRepo(db).upsert({
      ...sampleCard,
      id: 'evil-1',
      setId: 'evil',
      name: '<img src=x onerror=alert(2)>',
    });
    window.location.hash = `card/${encodeURIComponent('evil-1')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img[src="x"]')).toBeNull();
    expect(root.textContent ?? '').toContain(
      '<script>alert(1)</script>',
    );
    expect(root.textContent ?? '').toContain('<img src=x onerror=alert(2)>');
  });
});
