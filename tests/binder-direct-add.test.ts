// PR 24 — UI integration tests for the binder direct-add + auto-assign
// flows. Uses the real binder-detail view (no mocks) so the badge,
// toolbar action, slot Plasser button and direct-add dialog all
// exercise the full repo path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
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

const cardA: CardRecord = {
  id: 'base1-1',
  setId: 'base1',
  name: 'Card A',
  number: '1',
  rarity: 'Common',
  supertype: 'Pokémon',
  subtypes: [],
  types: [],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, '1stEditionNormal': { market: 1 }, '1stEditionHolofoil': { market: 1 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const cardB: CardRecord = { ...cardA, id: 'base1-2', name: 'Card B', number: '2' };

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
    cardId: 'base1-1',
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
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
    tags: [],
    lotId: null,
    status: 'owned',
    ...overrides,
  };
}

describe('Binder direct-add + auto-assign (PR 24)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([cardA, cardB]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  async function makeBinderWithTargetSlot(
    targetCardId: string | null = 'base1-1',
    note: string | null = null,
  ): Promise<{ binderId: string; slotId: string }> {
    const created = await createBinderService(db).createManualBinder({
      name: 'PR 24 binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slots = await createBinderSlotsRepo(db).listByBinderId(
      created.binder.id,
    );
    const firstSlot = slots[0];
    if (firstSlot === undefined) throw new Error('binder has no slots');
    await createBinderSlotsRepo(db).update(
      firstSlot.id,
      { targetCardId, note, status: targetCardId !== null ? 'wanted' : 'empty' },
      9,
    );
    return { binderId: created.binder.id, slotId: firstSlot.id };
  }

  it('toolbar shows "Auto-plasser matching holdings" button', async () => {
    const { binderId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    expect(btn).not.toBeNull();
  });

  it('Auto-plasser button is enabled when target slots exist (even without holdings) so the user can see the report', async () => {
    const { binderId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    // No holdings → eligible count is 0, but the button stays enabled
    // so clicking shows "X mangler holding" feedback. Disabled only
    // when there are no missing target slots at all.
    expect(btn?.disabled).toBe(false);
    btn?.click();
    await vi.waitFor(() => {
      const summary = root.querySelector(
        '[data-region="auto-assign-summary"]',
      );
      expect(summary?.textContent ?? '').toContain('mangler holding');
    });
  });

  it('Auto-plasser button is disabled when every target slot is already filled', async () => {
    const h = await createHoldingsRepo(db).create(holdingInput());
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    // Pre-fill the slot.
    await createBinderSlotsRepo(db).update(
      slotId,
      { holdingId: h.id, status: 'owned' },
      9,
    );
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    // Need to find the FIRST target slot — but the binder default has
    // 9 blank slots; only the first one was set as a target. With it
    // owned, no unfilled targets remain.
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    expect(btn?.disabled).toBe(true);
  });

  it('slot tile shows "Kan plasseres" badge when matching holding exists', async () => {
    await createHoldingsRepo(db).create(holdingInput());
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const tile = root.querySelector<HTMLElement>(
      `.binder-slot[data-slot-id="${slotId}"]`,
    );
    const badge = tile?.querySelector('[data-region="assignable-badge"]');
    expect(badge?.textContent ?? '').toContain('Kan plasseres');
  });

  it('clicking Plasser assigns the holding and flips status to owned', async () => {
    const h = await createHoldingsRepo(db).create(holdingInput());
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const tile = root.querySelector<HTMLElement>(
      `.binder-slot[data-slot-id="${slotId}"]`,
    );
    const place = tile?.querySelector<HTMLButtonElement>(
      'button[data-action="place-eligible"]',
    );
    expect(place).not.toBeNull();
    place?.click();
    await vi.waitFor(async () => {
      const stored = await createBinderSlotsRepo(db).get(slotId);
      expect(stored?.holdingId).toBe(h.id);
      expect(stored?.status).toBe('owned');
    });
  });

  it('Auto-plasser action assigns 1:1 obvious matches and shows summary', async () => {
    const h = await createHoldingsRepo(db).create(holdingInput());
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    expect(btn?.disabled).toBe(false);
    btn?.click();
    await vi.waitFor(async () => {
      const stored = await createBinderSlotsRepo(db).get(slotId);
      expect(stored?.holdingId).toBe(h.id);
      expect(stored?.status).toBe('owned');
    });
    const summary = root.querySelector(
      '[data-region="auto-assign-summary"]',
    );
    expect(summary?.textContent ?? '').toContain('1 plassert');
  });

  it('Auto-plasser leaves ambiguous slots untouched and reports them', async () => {
    // Two NM normal holdings for the same cardId → ambiguous.
    await createHoldingsRepo(db).create(holdingInput());
    await createHoldingsRepo(db).create(holdingInput({ rawCondition: 'LP' }));
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();
    await vi.waitFor(() => {
      const summary = root.querySelector(
        '[data-region="auto-assign-summary"]',
      );
      expect(summary?.textContent ?? '').toContain('1 tvetydige');
    });
    const stored = await createBinderSlotsRepo(db).get(slotId);
    expect(stored?.holdingId).toBeNull();
  });

  it('reverse-holo template slot does not auto-assign normal holding', async () => {
    await createHoldingsRepo(db).create(holdingInput({ finish: 'normal' }));
    const { binderId, slotId } = await makeBinderWithTargetSlot(
      'base1-1',
      REVERSE_HOLO_TEMPLATE_MARKER,
    );
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-action="auto-assign"]',
    );
    btn?.click();
    await vi.waitFor(() => {
      const summary = root.querySelector(
        '[data-region="auto-assign-summary"]',
      );
      expect(summary?.textContent ?? '').toContain('feil variant');
    });
    const stored = await createBinderSlotsRepo(db).get(slotId);
    expect(stored?.holdingId).toBeNull();
  });

  it('"Legg til her" button renders for empty target slots', async () => {
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const tile = root.querySelector<HTMLElement>(
      `.binder-slot[data-slot-id="${slotId}"]`,
    );
    const directAdd = tile?.querySelector(
      'button[data-action="direct-add"]',
    );
    expect(directAdd).not.toBeNull();
  });

  it('"Legg til her" not rendered for blank slots (route via assign modal)', async () => {
    const { binderId, slotId } = await makeBinderWithTargetSlot(null);
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    const tile = root.querySelector<HTMLElement>(
      `.binder-slot[data-slot-id="${slotId}"]`,
    );
    const directAdd = tile?.querySelector(
      'button[data-action="direct-add"]',
    );
    expect(directAdd).toBeNull();
  });

  it('checklist row shows "Kan plasseres" + Plasser action when match exists', async () => {
    const h = await createHoldingsRepo(db).create(holdingInput());
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    // Switch to checklist mode.
    root
      .querySelector<HTMLButtonElement>('button[data-mode="checklist"]')
      ?.click();
    await settle(60);
    const row = root.querySelector<HTMLElement>(
      `tr[data-slot-id="${slotId}"]`,
    );
    expect(row).not.toBeNull();
    const badge = row?.querySelector('[data-region="assignable-badge"]');
    expect(badge?.textContent ?? '').toContain('Kan plasseres');
    const place = row?.querySelector<HTMLButtonElement>(
      'button[data-action="place-eligible"]',
    );
    expect(place).not.toBeNull();
    place?.click();
    await vi.waitFor(async () => {
      const stored = await createBinderSlotsRepo(db).get(slotId);
      expect(stored?.holdingId).toBe(h.id);
    });
  });

  it('clicking Legg til her opens direct-add form, submitting creates holding + assigns slot', async () => {
    const { binderId, slotId } = await makeBinderWithTargetSlot();
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const directAddBtn = root.querySelector<HTMLButtonElement>(
      `.binder-slot[data-slot-id="${slotId}"] button[data-action="direct-add"]`,
    );
    expect(directAddBtn).not.toBeNull();
    directAddBtn?.click();

    // The dialog mounts on `document.body`, not inside `root`. Wait for
    // the form to render, fill defaults, and submit.
    const form = await vi.waitFor<HTMLFormElement>(() => {
      const f = document.querySelector<HTMLFormElement>(
        'form.slot-direct-add',
      );
      if (f === null) throw new Error('direct-add form did not open');
      return f;
    });
    // Card summary should reflect the slot's targetCardId.
    const cardSummary = form.querySelector<HTMLElement>(
      '[data-region="card-summary"]',
    );
    expect(cardSummary?.textContent ?? '').toContain('base1-1');

    // Submit. The form pre-populates with raw NM normal/unlimited
    // defaults, which match the seeded card's verified variants.
    form.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );

    await vi.waitFor(async () => {
      const slot = await createBinderSlotsRepo(db).get(slotId);
      expect(slot?.status).toBe('owned');
      expect(slot?.holdingId).not.toBeNull();
    });
    // Verify a holding was actually created and is now bound to the slot.
    const slot = await createBinderSlotsRepo(db).get(slotId);
    const holding =
      slot?.holdingId !== null && slot?.holdingId !== undefined
        ? await createHoldingsRepo(db).get(slot.holdingId)
        : undefined;
    expect(holding?.cardId).toBe('base1-1');
    expect(holding?.conditionType).toBe('raw');
    expect(holding?.finish).toBe('normal');
    expect(holding?.deletedAt).toBeNull();
  });

  it('reverse-holo template direct-add locks finish to reverse_holo in the form', async () => {
    const { binderId, slotId } = await makeBinderWithTargetSlot(
      'base1-1',
      REVERSE_HOLO_TEMPLATE_MARKER,
    );
    window.location.hash = `binder/${encodeURIComponent(binderId)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const directAddBtn = root.querySelector<HTMLButtonElement>(
      `.binder-slot[data-slot-id="${slotId}"] button[data-action="direct-add"]`,
    );
    directAddBtn?.click();
    const form = await vi.waitFor<HTMLFormElement>(() => {
      const f = document.querySelector<HTMLFormElement>(
        'form.slot-direct-add',
      );
      if (f === null) throw new Error('direct-add form did not open');
      return f;
    });
    const finishSelect = form.querySelector<HTMLSelectElement>(
      'select[name="finish"]',
    );
    expect(finishSelect?.value).toBe('reverse_holo');
    expect(finishSelect?.disabled).toBe(true);
    // Submit and verify the holding has finish=reverse_holo.
    form.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      const slot = await createBinderSlotsRepo(db).get(slotId);
      expect(slot?.status).toBe('owned');
    });
    const slot = await createBinderSlotsRepo(db).get(slotId);
    const holding =
      slot?.holdingId !== null && slot?.holdingId !== undefined
        ? await createHoldingsRepo(db).get(slot.holdingId)
        : undefined;
    expect(holding?.finish).toBe('reverse_holo');
  });

  it('one holding cannot be assigned to two slots in a single auto-assign run', async () => {
    await createHoldingsRepo(db).create(holdingInput());
    const created = await createBinderService(db).createManualBinder({
      name: 'Two-slot',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slots = await createBinderSlotsRepo(db).listByBinderId(
      created.binder.id,
    );
    // Make first two slots target the same card.
    const repo = createBinderSlotsRepo(db);
    await repo.update(
      slots[0]!.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    await repo.update(
      slots[1]!.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-action="auto-assign"]')
      ?.click();
    await vi.waitFor(() => {
      const summary = root.querySelector(
        '[data-region="auto-assign-summary"]',
      );
      expect(summary?.textContent ?? '').toContain('1 plassert');
    });
    const after0 = await repo.get(slots[0]!.id);
    const after1 = await repo.get(slots[1]!.id);
    // Exactly one of the two slots got the holding.
    const assignedCount = [after0, after1].filter(
      (s) => s !== undefined && s.holdingId !== null,
    ).length;
    expect(assignedCount).toBe(1);
  });
});
