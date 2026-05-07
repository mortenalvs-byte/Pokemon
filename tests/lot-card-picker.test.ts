// Card picker (typeahead) — searches cached cards by name + id, no
// API calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLotCardPicker } from '../src/components/lot-card-picker';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
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

describe('lot-card-picker', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createCardsRepo(db).upsertMany([
      makeCard('base1-4', 'Charizard'),
      makeCard('base1-25', 'Pikachu'),
      makeCard('base1-58', 'Charmeleon'),
    ]);
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('renders results matching by name (case-insensitive substring)', async () => {
    const onSelect = vi.fn();
    const picker = buildLotCardPicker({ onSelect });
    document.body.appendChild(picker.element);

    const input = picker.element.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'char';
    input!.dispatchEvent(new Event('input'));
    await settle(200);

    const results = picker.element.querySelectorAll<HTMLLIElement>(
      '[data-region="picker-results"] li',
    );
    expect(results.length).toBe(2); // Charizard + Charmeleon
    const ids = Array.from(results).map((r) => r.dataset['cardId']);
    expect(ids.sort()).toEqual(['base1-4', 'base1-58']);
  });

  it('clicking a result commits the selection and notifies onSelect', async () => {
    const onSelect = vi.fn();
    const picker = buildLotCardPicker({ onSelect });
    document.body.appendChild(picker.element);

    const input = picker.element.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'pika';
    input!.dispatchEvent(new Event('input'));
    await settle(200);

    const button = picker.element.querySelector<HTMLButtonElement>(
      '.lot-card-picker__result-button',
    );
    expect(button).not.toBeNull();
    button?.click();

    expect(picker.getSelectedCardId()).toBe('base1-25');
    expect(onSelect).toHaveBeenCalledWith('base1-25');
    const selected = picker.element.querySelector<HTMLElement>(
      '[data-region="picker-selected"]',
    );
    expect(selected?.hidden).toBe(false);
    expect(selected?.textContent).toContain('Pikachu');
  });

  it('exact id match returns the single card even without name match', async () => {
    const picker = buildLotCardPicker({ onSelect: () => {} });
    document.body.appendChild(picker.element);
    const input = picker.element.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'base1-25';
    input!.dispatchEvent(new Event('input'));
    await settle(200);

    const results = picker.element.querySelectorAll<HTMLLIElement>(
      '[data-region="picker-results"] li',
    );
    expect(results.length).toBe(1);
    expect(results[0]?.dataset['cardId']).toBe('base1-25');
  });

  it('no matches show the empty hint without an interactive button', async () => {
    const picker = buildLotCardPicker({ onSelect: () => {} });
    document.body.appendChild(picker.element);
    const input = picker.element.querySelector<HTMLInputElement>(
      '[data-region="picker-input"]',
    );
    input!.value = 'mewtwo';
    input!.dispatchEvent(new Event('input'));
    await settle(200);

    const empty = picker.element.querySelector<HTMLElement>(
      '.lot-card-picker__empty',
    );
    expect(empty?.textContent).toMatch(/Ingen treff/);
  });

  it('initialCardId hydrates the selection from the cache', async () => {
    const onSelect = vi.fn();
    const picker = buildLotCardPicker({
      initialCardId: 'base1-4',
      onSelect,
    });
    document.body.appendChild(picker.element);
    await settle(120);

    expect(picker.getSelectedCardId()).toBe('base1-4');
    expect(onSelect).toHaveBeenCalledWith('base1-4');
    const selected = picker.element.querySelector<HTMLElement>(
      '[data-region="picker-selected"]',
    );
    expect(selected?.textContent).toContain('Charizard');
  });
});
