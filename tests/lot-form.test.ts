// Lot form (Add/Edit). Validates that save goes through lotsRepo and
// produces an audit row.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { buildLotForm } from '../src/components/lot-form';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('lot-form', () => {
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

  it('add-mode submit creates a lot + writes lot_created audit', async () => {
    void openDialog(buildLotForm({ mode: 'add' }));
    await settle();

    const form = document.querySelector<HTMLFormElement>('form.lot-form');
    expect(form).not.toBeNull();

    const nameInput = form!.querySelector<HTMLInputElement>('input[name="name"]');
    nameInput!.value = 'Booster bundle';
    const totalInput = form!.querySelector<HTMLInputElement>(
      'input[name="totalCost"]',
    );
    totalInput!.value = '1500';
    const dateInput = form!.querySelector<HTMLInputElement>(
      'input[name="purchaseDate"]',
    );
    dateInput!.value = '2026-04-12';

    form!.requestSubmit();

    await vi.waitFor(async () => {
      const audits = await db.auditLog.where('action').equals('lot_created').count();
      expect(audits).toBe(1);
    });

    const lots = await db.lots.toArray();
    expect(lots.length).toBe(1);
    expect(lots[0]?.name).toBe('Booster bundle');
    expect(lots[0]?.totalCost).toBe(1500);
    expect(lots[0]?.currency).toBe('NOK');
    expect(lots[0]?.allocationMethod).toBe('equal');
  });

  it('rejects empty name', async () => {
    void openDialog(buildLotForm({ mode: 'add' }));
    await settle();

    const form = document.querySelector<HTMLFormElement>('form.lot-form');
    const totalInput = form!.querySelector<HTMLInputElement>(
      'input[name="totalCost"]',
    );
    totalInput!.value = '500';
    form!.requestSubmit();
    await settle();

    const error = form!.querySelector<HTMLElement>('[data-region="form-error"]');
    expect(error?.textContent ?? '').toMatch(/Navn|name/i);
    expect(await db.lots.count()).toBe(0);
  });
});
