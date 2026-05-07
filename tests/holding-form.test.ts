import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../src/components/events';
import { buildHoldingForm } from '../src/components/holding-form';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
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

function getDialogForm(): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>('form.holding-form');
  if (form === null) throw new Error('expected holding-form to be mounted');
  return form;
}

describe('buildHoldingForm — add mode', () => {
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

  it('renders all top-level sections and the title for add mode', async () => {
    const promise = openDialog(
      buildHoldingForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getDialogForm();
    expect(form.querySelector('[data-region="title"]')?.textContent).toBe(
      'Legg til i samling',
    );
    // The card summary uses the cached card name.
    expect(form.querySelector('[data-region="card-summary"]')?.textContent).toContain(
      'Charizard',
    );
    expect(form.querySelectorAll('fieldset').length).toBe(6);
    // Cancel to release the promise.
    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });

  it('saves a valid raw holding through the repo and dispatches user-data-changed', async () => {
    const eventListener = vi.fn();
    window.addEventListener(USER_DATA_CHANGED_EVENT, eventListener);

    const promise = openDialog(
      buildHoldingForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getDialogForm();
    setValue(form, 'tags', 'favorite, to_grade');
    form.requestSubmit();
    await vi.waitFor(async () => {
      const holdings = await db.holdings.toArray();
      expect(holdings.length).toBe(1);
    });

    const result = await promise;
    expect(result).toBe('submitted');

    const holding = (await db.holdings.toArray())[0];
    expect(holding?.cardId).toBe('base1-4');
    expect(holding?.conditionType).toBe('raw');
    expect(holding?.rawCondition).toBe('NM');
    expect(holding?.tags).toEqual(['favorite', 'to_grade']);
    expect(eventListener).toHaveBeenCalled();

    const audits = await db.auditLog
      .where('action')
      .equals('holding_created')
      .toArray();
    expect(audits.length).toBe(1);

    window.removeEventListener(USER_DATA_CHANGED_EVENT, eventListener);
  });

  it('blocks save with an inline error when graded fields are missing', async () => {
    const promise = openDialog(
      buildHoldingForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getDialogForm();

    // Switch to graded but leave gradingCompany blank: the select still
    // has a default value (PSA), so to force a real failure we clear
    // the grade — graded validation requires a number.
    const gradedRadio = form.querySelector<HTMLInputElement>(
      'input[name="conditionType"][value="graded"]',
    );
    gradedRadio!.checked = true;
    gradedRadio!.dispatchEvent(new Event('change'));
    setValue(form, 'grade', '');

    form.requestSubmit();
    await tick(40);

    const error = form.querySelector<HTMLElement>('[data-region="form-error"]');
    expect(error?.textContent ?? '').toMatch(/grade/i);
    expect(error?.classList.contains('holding-form__error--visible')).toBe(true);

    expect(await db.holdings.count()).toBe(0);

    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });

  it('rejects negative purchase price and does not write', async () => {
    const promise = openDialog(
      buildHoldingForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getDialogForm();
    setValue(form, 'purchasePrice', '-5');

    form.requestSubmit();
    await tick(40);

    const error = form.querySelector<HTMLElement>('[data-region="form-error"]');
    expect(error?.classList.contains('holding-form__error--visible')).toBe(true);
    expect(await db.holdings.count()).toBe(0);

    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await promise;
  });

  it('marks valueSource=manual when an estimated value is entered', async () => {
    const promise = openDialog(
      buildHoldingForm({ mode: 'add', cardId: 'base1-4' }),
    );
    await tick();
    const form = getDialogForm();
    setValue(form, 'estimatedValue', '1200');
    setValue(form, 'valueCurrency', 'NOK');
    form.requestSubmit();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });
    const holding = (await db.holdings.toArray())[0];
    expect(holding?.estimatedValue).toBe(1200);
    expect(holding?.valueSource).toBe('manual');
    expect(holding?.valueUpdatedAt).not.toBeNull();
    await promise;
  });
});

describe('buildHoldingForm — edit mode', () => {
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

  it('prefills fields from the existing holding and updates via the repo', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'LP',
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
      tags: ['original'],
      lotId: null,
      status: 'owned',
    });

    const promise = openDialog(
      buildHoldingForm({ mode: 'edit', holding: created }),
    );
    await tick();
    const form = getDialogForm();
    expect(form.querySelector('[data-region="title"]')?.textContent).toBe(
      'Rediger holding',
    );
    expect(
      form.querySelector<HTMLInputElement>('input[name="quantity"]')?.value,
    ).toBe('1');
    expect(
      form.querySelector<HTMLInputElement>('input[name="tags"]')?.value,
    ).toContain('original');

    setValue(form, 'quantity', '3');
    form.requestSubmit();

    await vi.waitFor(async () => {
      const updated = await repo.get(created.id);
      expect(updated?.quantity).toBe(3);
    });

    const audits = await db.auditLog
      .where('action')
      .equals('holding_updated')
      .toArray();
    expect(audits.length).toBeGreaterThanOrEqual(1);

    await promise;
  });
});

function setValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
    field.value = value;
  }
}
