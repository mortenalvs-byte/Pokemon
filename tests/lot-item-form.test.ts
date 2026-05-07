// Lot item form. Save goes through lotItemsRepo and the card picker
// is required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { buildLotItemForm } from '../src/components/lot-item-form';
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

function makeCard(id: string, name: string): CardRecord {
  return {
    id,
    setId: 'base1',
    name,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

describe('lot-item-form', () => {
  let db: PokemonTrackerDB;
  let lotId: string;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createCardsRepo(db).upsertMany([
      makeCard('base1-4', 'Charizard'),
    ]);
    const lot = await createLotsRepo(db).create({
      name: 'Test lot',
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

  it('add-mode submit creates a lot item with selected cardId', async () => {
    void openDialog(buildLotItemForm({ mode: 'add', lotId }));
    await settle();

    // Pick a card via the typeahead.
    const input = document.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'Char';
    input!.dispatchEvent(new Event('input'));
    await settle(220);
    document
      .querySelector<HTMLButtonElement>('.lot-card-picker__result-button')
      ?.click();
    await settle();

    const form = document.querySelector<HTMLFormElement>(
      'form.lot-item-form',
    );
    expect(form).not.toBeNull();
    const quantityInput = form!.querySelector<HTMLInputElement>(
      'input[name="quantity"]',
    );
    quantityInput!.value = '2';
    const marketInput = form!.querySelector<HTMLInputElement>(
      'input[name="marketEstimate"]',
    );
    marketInput!.value = '200';

    form!.requestSubmit();

    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.length).toBe(1);
      expect(items[0]?.cardId).toBe('base1-4');
      expect(items[0]?.quantity).toBe(2);
      expect(items[0]?.marketEstimate).toBe(200);
      expect(items[0]?.lotId).toBe(lotId);
    });
  });

  it('rejects submission without a selected card', async () => {
    void openDialog(buildLotItemForm({ mode: 'add', lotId }));
    await settle();

    const form = document.querySelector<HTMLFormElement>(
      'form.lot-item-form',
    );
    form!.requestSubmit();
    await settle();

    const error = form!.querySelector<HTMLElement>('[data-region="form-error"]');
    expect(error?.textContent ?? '').toMatch(/kort/i);
    expect(await db.lotItems.count()).toBe(0);
  });
});
