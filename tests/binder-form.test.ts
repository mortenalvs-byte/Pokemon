// PR A1 — Tests for binder-form requiring a sett (set) selection on
// manual-binder creation. v2-compatible: schema stays at SCHEMA_VERSION=2;
// legacy binders with sourceSetId=null still load + render in edit mode.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { buildBinderForm } from '../src/components/binder-form';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { BinderRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

const setBase: SetRecord = {
  id: 'base1',
  name: 'Base Set',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-11T00:00:00.000Z',
};
const setJungle: SetRecord = {
  id: 'jungle',
  name: 'Jungle',
  series: 'Base',
  printedTotal: 64,
  total: 64,
  releaseDate: '1999-06-16',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-11T00:00:00.000Z',
};

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getDialogForm(): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>('form.binder-form');
  if (form === null) throw new Error('expected binder-form to be mounted');
  return form;
}

describe('buildBinderForm — add mode set picker (PR A1)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    const sets = createSetsRepo(db);
    await sets.upsert(setBase);
    await sets.upsert(setJungle);
  });

  afterEach(async () => {
    await tick(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('renders a sett fieldset with required select', async () => {
    void openDialog(buildBinderForm({ mode: 'add' }));
    await tick();

    const form = getDialogForm();
    const setSection = form.querySelector<HTMLFieldSetElement>(
      '[data-region="set-section"]',
    );
    expect(setSection).not.toBeNull();
    const select = form.querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select).not.toBeNull();
    expect(select!.required).toBe(true);
    expect(select!.name).toBe('sourceSetId');
  });

  it('populates the set picker with synced sets sorted newest-first', async () => {
    void openDialog(buildBinderForm({ mode: 'add' }));
    // Allow the async loadAndPopulateSets to complete.
    await tick(80);

    const select = getDialogForm().querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select).not.toBeNull();
    const optionValues = Array.from(select!.options).map((o) => o.value);
    // First option is the disabled placeholder, then sets in newest-first order.
    expect(optionValues.length).toBeGreaterThanOrEqual(3);
    expect(optionValues[0] ?? '').toBe('');
    expect(optionValues[1] ?? '').toBe('jungle');  // 1999-06-16
    expect(optionValues[2] ?? '').toBe('base1');   // 1999-01-09
  });

  it('rejects submit when no set is selected', async () => {
    void openDialog(buildBinderForm({ mode: 'add' }));
    await tick(80);

    const form = getDialogForm();
    (form.elements.namedItem('name') as HTMLInputElement).value = 'My Binder';
    // Deliberately leave the disabled placeholder selected.

    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await tick();

    const errorRegion = form.querySelector<HTMLElement>(
      '[data-region="form-error"]',
    );
    expect(errorRegion?.textContent ?? '').toContain('sett');

    // No binder should have been written.
    const binders = await createBindersRepo(db).list();
    expect(binders).toHaveLength(0);
  });

  it('creates a set-scoped binder when a set is selected', async () => {
    void openDialog(buildBinderForm({ mode: 'add' }));
    await tick(80);

    const form = getDialogForm();
    (form.elements.namedItem('name') as HTMLInputElement).value =
      'Base Set Master';
    const select = form.elements.namedItem('sourceSetId') as HTMLSelectElement;
    select.value = 'base1';

    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await tick(120);

    const binders = await createBindersRepo(db).list();
    expect(binders).toHaveLength(1);
    const created = binders[0];
    if (created === undefined) {
      throw new Error('expected one binder to have been created');
    }
    expect(created.sourceSetId).toBe('base1');
    expect(created.name).toBe('Base Set Master');
  });

  it('surfaces a sync-first hint when no sets are loaded', async () => {
    // Wipe sets so the picker has nothing to show.
    await createSetsRepo(db).clear();

    void openDialog(buildBinderForm({ mode: 'add' }));
    await tick(80);

    const select = getDialogForm().querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select).not.toBeNull();
    const placeholder = select!.options[0];
    if (placeholder === undefined) {
      throw new Error('expected at least one option in the set picker');
    }
    expect(placeholder.textContent ?? '').toMatch(/sync|Synket|synket|sett/i);
    // Selecting nothing → submit must still fail.
    expect(placeholder.value).toBe('');
    expect(placeholder.disabled).toBe(true);
  });
});

describe('buildBinderForm — edit mode preserves legacy binders (PR A1)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(setBase);
  });

  afterEach(async () => {
    await tick(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  function makeBinder(overrides: Partial<BinderRecord>): BinderRecord {
    return {
      id: 'binder-1',
      name: 'Existing binder',
      binderType: 'Manual',
      description: null,
      slotsPerPage: 9,
      totalPages: 5,
      binderPreset: 'custom',
      completionMode: 'standard',
      sourceSetId: null,
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z',
      deletedAt: null,
      ...overrides,
    };
  }

  it('shows a read-only sett label when binder has sourceSetId', async () => {
    const binder = makeBinder({ sourceSetId: 'base1' });
    void openDialog(buildBinderForm({ mode: 'edit', binder }));
    await tick(80);

    const select = getDialogForm().querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(true);
    expect(select!.value).toBe('base1');
  });

  it('shows a legacy-binder hint when sourceSetId is null', async () => {
    const binder = makeBinder({ sourceSetId: null });
    void openDialog(buildBinderForm({ mode: 'edit', binder }));
    await tick(80);

    const select = getDialogForm().querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(true);

    const hint = getDialogForm().querySelector<HTMLElement>(
      '[data-region="set-readonly-hint"]',
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent ?? '').toMatch(/eldre|legacy|uendret/i);
  });
});
