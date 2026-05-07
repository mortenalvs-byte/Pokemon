import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../src/components/events';
import { buildWishlistForm } from '../src/components/wishlist-form';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

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
  tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getForm(): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>('form.wishlist-form');
  if (form === null) throw new Error('expected wishlist-form to be mounted');
  return form;
}

function setValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.elements.namedItem(name);
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement ||
    field instanceof HTMLTextAreaElement
  ) {
    field.value = value;
  }
}

describe('buildWishlistForm — add mode', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createCardsRepo(db).upsert(sampleCard);
  });

  afterEach(async () => {
    await tick(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('renders the documented sections and the title for add mode', async () => {
    const promise = openDialog(
      buildWishlistForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getForm();
    expect(form.querySelector('[data-region="title"]')?.textContent).toBe(
      'Legg til i ønskeliste',
    );
    expect(
      form.querySelector('[data-region="card-summary"]')?.textContent,
    ).toContain('Charizard');
    expect(form.querySelectorAll('fieldset').length).toBe(3);
    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });

  it('saves a valid wishlist entry through the repo and dispatches user-data-changed', async () => {
    const eventListener = vi.fn();
    window.addEventListener(USER_DATA_CHANGED_EVENT, eventListener);

    const promise = openDialog(
      buildWishlistForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getForm();
    setValue(form, 'priority', 'high');
    setValue(form, 'targetPrice', '1500');
    setValue(form, 'targetCurrency', 'NOK');
    setValue(form, 'note', 'helst PSA 9');
    form.requestSubmit();

    await vi.waitFor(async () => {
      expect(await db.wishlist.count()).toBe(1);
    });

    const result = await promise;
    expect(result).toBe('submitted');

    const entry = (await db.wishlist.toArray())[0];
    expect(entry?.cardId).toBe('base1-4');
    expect(entry?.priority).toBe('high');
    expect(entry?.targetPrice).toBe(1500);
    expect(entry?.targetCurrency).toBe('NOK');
    expect(entry?.status).toBe('wanted');
    expect(eventListener).toHaveBeenCalled();

    const audits = await db.auditLog
      .where('action')
      .equals('wishlist_item_created')
      .toArray();
    expect(audits.length).toBe(1);

    window.removeEventListener(USER_DATA_CHANGED_EVENT, eventListener);
  });

  it('blocks save with an inline error on negative target price', async () => {
    const promise = openDialog(
      buildWishlistForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getForm();
    setValue(form, 'targetPrice', '-1');
    form.requestSubmit();
    await tick(40);

    const error = form.querySelector<HTMLElement>('[data-region="form-error"]');
    expect(error?.classList.contains('wishlist-form__error--visible')).toBe(true);
    expect(await db.wishlist.count()).toBe(0);

    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });

  it('does not write a tags field — wishlist has no tags column', async () => {
    const promise = openDialog(
      buildWishlistForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getForm();
    expect(form.querySelector('[name="tags"]')).toBeNull();
    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });
});

describe('buildWishlistForm — edit mode', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createCardsRepo(db).upsert(sampleCard);
  });

  afterEach(async () => {
    await tick(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('prefills fields from the existing entry and updates via the repo', async () => {
    const repo = createWishlistRepo(db);
    const created = await repo.create({
      cardId: 'base1-4',
      finish: 'reverse_holo',
      priority: 'high',
      targetCondition: 'NM',
      targetPrice: 800,
      targetCurrency: 'USD',
      status: 'wanted',
      note: 'first one',
    });

    const promise = openDialog(
      buildWishlistForm({ mode: 'edit', entry: created }),
    );
    await tick();
    const form = getForm();
    expect(form.querySelector('[data-region="title"]')?.textContent).toBe(
      'Rediger ønskeliste-oppføring',
    );
    expect(
      form.querySelector<HTMLSelectElement>('select[name="priority"]')?.value,
    ).toBe('high');
    expect(
      form.querySelector<HTMLSelectElement>('select[name="targetCondition"]')
        ?.value,
    ).toBe('NM');
    expect(
      form.querySelector<HTMLInputElement>('input[name="targetPrice"]')?.value,
    ).toBe('800');

    setValue(form, 'status', 'ordered');
    form.requestSubmit();

    await vi.waitFor(async () => {
      const updated = await repo.get(created.id);
      expect(updated?.status).toBe('ordered');
    });

    const audits = await db.auditLog
      .where('action')
      .equals('wishlist_item_updated')
      .toArray();
    expect(audits.length).toBeGreaterThanOrEqual(1);

    await promise;
  });
});
