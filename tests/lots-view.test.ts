// Lots list view — empty state, render, "Ny lot" submit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountLotsView } from '../src/views/lots';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Lots list view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows the empty state when there are no lots', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotsView(root);
    await settle();
    expect(root.querySelector('.lots-view__empty')?.textContent).toMatch(
      /Ingen lotter/,
    );
  });

  it('renders one row per live lot with the status chip', async () => {
    await createLotsRepo(db).create({
      name: 'Existing',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotsView(root);
    await settle();
    const rows = root.querySelectorAll<HTMLTableRowElement>('.lots-table__row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.querySelector('.status-chip')?.textContent).toMatch(
      /Ufordelt/,
    );
  });

  it('"Ny lot" submit creates a new lot and rerenders', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotsView(root);
    await settle();

    const newBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="new-lot"]',
    );
    newBtn?.click();
    await settle();

    const form = document.querySelector<HTMLFormElement>('form.lot-form');
    expect(form).not.toBeNull();
    const nameInput = form!.querySelector<HTMLInputElement>('input[name="name"]');
    nameInput!.value = 'Just made';
    const totalInput = form!.querySelector<HTMLInputElement>(
      'input[name="totalCost"]',
    );
    totalInput!.value = '700';
    form!.requestSubmit();

    await vi.waitFor(async () => {
      const lots = await db.lots.toArray();
      expect(lots.length).toBe(1);
      expect(lots[0]?.name).toBe('Just made');
    });

    await settle();
    const rows = root.querySelectorAll<HTMLTableRowElement>('.lots-table__row');
    expect(rows.length).toBe(1);
  });

  it('mount + render is read-only on user data', async () => {
    await createLotsRepo(db).create({
      name: 'Untouched',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    const beforeLots = await db.lots.toArray();
    const beforeAudits = await db.auditLog.toArray();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotsView(root);
    await settle();

    expect(await db.lots.toArray()).toEqual(beforeLots);
    expect(await db.auditLog.toArray()).toEqual(beforeAudits);
  });
});
