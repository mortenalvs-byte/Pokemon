// Form-level UX for strict variant validation (PR 11). The three
// forms (holding, lot-item, wishlist) must narrow the finish + edition
// dropdowns to the verified set the API exposes for the chosen card,
// plus the always-on escape-hatch options (Stamped + Unknown for
// finish; Shadowless + Unknown for edition). When the card is not
// verified, only the escape-hatch options remain and a hint surfaces.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { buildHoldingForm } from '../src/components/holding-form';
import { buildLotItemForm } from '../src/components/lot-item-form';
import { buildWishlistForm } from '../src/components/wishlist-form';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cardWith(
  id: string,
  prices: Record<string, unknown> | null,
): CardRecord {
  return {
    id,
    setId: 'base1',
    name: `Card ${id}`,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: prices === null ? null : { prices },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function finishOptions(): string[] {
  const select = document.querySelector<HTMLSelectElement>(
    'select[name="finish"]',
  );
  return Array.from(select?.options ?? []).map((o) => o.value);
}

function editionOptions(): string[] {
  const select = document.querySelector<HTMLSelectElement>(
    'select[name="edition"]',
  );
  return Array.from(select?.options ?? []).map((o) => o.value);
}

describe('form-variant-narrowing — holding-form', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('shows only verified finishes + escape hatches when card has normal only', async () => {
    await createCardsRepo(db).upsert(cardWith('c-1', { normal: { market: 1 } }));
    void openDialog(buildHoldingForm({ mode: 'add', cardId: 'c-1' }));
    await settle();

    expect(finishOptions().sort()).toEqual(['normal', 'stamped', 'unknown']);
    // Edition: only `unlimited` exposed by the API; `shadowless` and
    // `unknown` always visible as escape hatches.
    expect(editionOptions().sort()).toEqual(
      ['shadowless', 'unknown', 'unlimited'],
    );
  });

  it('shows holo + reverse_holo when API exposes them', async () => {
    await createCardsRepo(db).upsert(
      cardWith('c-2', {
        normal: { market: 1 },
        holofoil: { market: 1 },
        reverseHolofoil: { market: 1 },
      }),
    );
    void openDialog(buildHoldingForm({ mode: 'add', cardId: 'c-2' }));
    await settle();
    const finishes = finishOptions();
    expect(finishes).toContain('normal');
    expect(finishes).toContain('holo');
    expect(finishes).toContain('reverse_holo');
  });

  it('shows only escape hatches and a hint when card has no tcgplayer.prices', async () => {
    await createCardsRepo(db).upsert(cardWith('c-3', null));
    void openDialog(buildHoldingForm({ mode: 'add', cardId: 'c-3' }));
    await settle();
    expect(finishOptions().sort()).toEqual(['stamped', 'unknown']);
    expect(editionOptions().sort()).toEqual(['shadowless', 'unknown']);
    const hint = document.querySelector<HTMLElement>(
      '[data-region="variant-hint"]',
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent ?? '').toMatch(/Ukjent|note|specialVariant/i);
  });

  it('exposes first_edition only when API has 1stEdition* keys', async () => {
    await createCardsRepo(db).upsert(
      cardWith('c-4', {
        normal: { market: 1 },
        '1stEditionHolofoil': { market: 1 },
      }),
    );
    void openDialog(buildHoldingForm({ mode: 'add', cardId: 'c-4' }));
    await settle();
    expect(editionOptions()).toContain('first_edition');
    expect(editionOptions()).toContain('unlimited');
  });

  it('does NOT show first_edition when no 1stEdition* keys are present', async () => {
    await createCardsRepo(db).upsert(cardWith('c-5', { normal: { market: 1 } }));
    void openDialog(buildHoldingForm({ mode: 'add', cardId: 'c-5' }));
    await settle();
    expect(editionOptions()).not.toContain('first_edition');
  });
});

describe('form-variant-narrowing — wishlist-form', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('narrows finish to API-verified set + escape hatches', async () => {
    await createCardsRepo(db).upsert(
      cardWith('c-1', { normal: { market: 1 }, holofoil: { market: 1 } }),
    );
    void openDialog(buildWishlistForm({ mode: 'add', cardId: 'c-1' }));
    await settle();
    const finishes = finishOptions().sort();
    // verified: normal, holo. escape: stamped, unknown.
    expect(finishes).toEqual(['holo', 'normal', 'stamped', 'unknown']);
  });

  it('shows only escape hatches when card has no tcgplayer.prices', async () => {
    await createCardsRepo(db).upsert(cardWith('c-2', null));
    void openDialog(buildWishlistForm({ mode: 'add', cardId: 'c-2' }));
    await settle();
    expect(finishOptions().sort()).toEqual(['stamped', 'unknown']);
  });
});

describe('form-variant-narrowing — lot-item-form', () => {
  let db: PokemonTrackerDB;
  let lotId: string;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    lotId = lot.id;
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('shows only escape-hatch options before a card is picked', async () => {
    void openDialog(buildLotItemForm({ mode: 'add', lotId }));
    await settle();
    expect(finishOptions().sort()).toEqual(['stamped', 'unknown']);
    expect(editionOptions().sort()).toEqual(['shadowless', 'unknown']);
  });

  it('re-narrows the dropdowns when the card picker selection changes', async () => {
    await createCardsRepo(db).upsert(
      cardWith('c-pick', {
        normal: { market: 1 },
        holofoil: { market: 1 },
        reverseHolofoil: { market: 1 },
      }),
    );
    void openDialog(buildLotItemForm({ mode: 'add', lotId }));
    await settle();
    // Drive the picker.
    const input = document.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'c-pick';
    input!.dispatchEvent(new Event('input'));
    await settle(220);
    document
      .querySelector<HTMLButtonElement>('.lot-card-picker__result-button')
      ?.click();
    await settle();

    const finishes = finishOptions();
    expect(finishes).toContain('normal');
    expect(finishes).toContain('holo');
    expect(finishes).toContain('reverse_holo');
  });
});
