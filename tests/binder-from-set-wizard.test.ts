// Wizard component test. Uses the dialog wrapper to mount the wizard
// and exercise the flow: pick set → preview → submit → binder + slots
// + audit appear in one go.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDialog } from '../src/components/dialog';
import { buildBinderFromSetWizard } from '../src/components/binder-from-set-wizard';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const baseSet: SetRecord = {
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

const sv151Set: SetRecord = {
  id: 'sv3pt5',
  name: 'S&V 151',
  series: 'Scarlet & Violet',
  printedTotal: 165,
  total: 207,
  releaseDate: '2023-09-22',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

function makeCard(setId: string, n: number, options: { reverseHolo?: boolean } = {}): CardRecord {
  return {
    id: `${setId}-${n}`,
    setId,
    name: `Card ${n}`,
    number: String(n),
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer:
      options.reverseHolo === true
        ? { prices: { reverseHolofoil: { market: 1.5 } } }
        : null,
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

describe('binder-from-set wizard', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(baseSet);
    await createSetsRepo(db).upsert(sv151Set);
    await createCardsRepo(db).upsertMany([
      makeCard('base1', 1),
      makeCard('base1', 2, { reverseHolo: true }),
      makeCard('base1', 3),
      makeCard('sv3pt5', 1),
      makeCard('sv3pt5', 2),
    ]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows the empty state when there are no cached sets', async () => {
    // Wipe sets to simulate "never synced".
    await db.sets.clear();
    await db.cards.clear();

    void openDialog(buildBinderFromSetWizard());
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    const error = dialog?.querySelector('[data-region="form-error"]');
    expect(error?.textContent).toMatch(/Ingen sett/i);
    const submitBtn = dialog?.querySelector<HTMLButtonElement>(
      '.binder-from-set-wizard__submit',
    );
    expect(submitBtn?.disabled).toBe(true);
  });

  it('lists sets sorted by releaseDate desc and auto-fills the name', async () => {
    void openDialog(buildBinderFromSetWizard());
    await settle();

    const select = document.querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    expect(select?.options.length).toBe(2);
    expect(select?.options[0]?.value).toBe('sv3pt5'); // newest first
    expect(select?.options[1]?.value).toBe('base1');

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-region="name-input"]',
    );
    expect(nameInput?.value).toBe('S&V 151'); // standard mode default
  });

  it('updates auto-name when completion mode toggles to master', async () => {
    void openDialog(buildBinderFromSetWizard());
    await settle();

    const modeSelect = document.querySelector<HTMLSelectElement>(
      '[data-region="completion-mode"]',
    );
    modeSelect!.value = 'master';
    modeSelect!.dispatchEvent(new Event('change'));
    await settle();

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-region="name-input"]',
    );
    expect(nameInput?.value).toBe('S&V 151 (master)');
  });

  it('preview shows base + reverse holo counts in master mode', async () => {
    void openDialog(buildBinderFromSetWizard());
    await settle();

    // Switch to base set + master to exercise reverse-holo count.
    const setSelect = document.querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    setSelect!.value = 'base1';
    setSelect!.dispatchEvent(new Event('change'));
    await settle();

    const modeSelect = document.querySelector<HTMLSelectElement>(
      '[data-region="completion-mode"]',
    );
    modeSelect!.value = 'master';
    modeSelect!.dispatchEvent(new Event('change'));
    await settle();

    const previewItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-region="preview-list"] dt, [data-region="preview-list"] dd',
      ),
    ).map((el) => el.textContent ?? '');
    expect(previewItems.join(' | ')).toContain('Mål-slots (base)');
    expect(previewItems.join(' | ')).toContain('Reverse holo');
    // 3 base cards, 1 with reverse holo → 4 total
    expect(previewItems).toContain('4');
  });

  it('submit creates binder + slots + 1 audit in one go (atomic)', async () => {
    const dialogP = openDialog(buildBinderFromSetWizard());
    await settle();

    // Pick base set in standard mode (3 cards → 3 slots).
    const setSelect = document.querySelector<HTMLSelectElement>(
      '[data-region="set-select"]',
    );
    setSelect!.value = 'base1';
    setSelect!.dispatchEvent(new Event('change'));
    await settle();

    const form = document.querySelector<HTMLFormElement>(
      'form.binder-from-set-wizard',
    );
    form!.requestSubmit();

    await vi.waitFor(async () => {
      const audits = await db.auditLog
        .where('action')
        .equals('binder_created')
        .count();
      expect(audits).toBe(1);
    });

    const binders = await db.binders.toArray();
    expect(binders.length).toBe(1);
    expect(binders[0]?.sourceSetId).toBe('base1');
    expect(binders[0]?.completionMode).toBe('standard');

    const slots = await db.binderSlots
      .where('binderId')
      .equals(binders[0]!.id)
      .toArray();
    expect(slots.length).toBe(3);
    expect(slots.every((s) => s.targetCardId !== null)).toBe(true);
    expect(slots.every((s) => s.status === 'wanted')).toBe(true);

    // Cleanup the dialog so it does not leak state.
    await dialogP;
  });
});
