// Wishlist add/edit form. Renders inside an `<dialog>` provided by
// `openDialog()`. Every save goes through `wishlistRepo.create` /
// `wishlistRepo.update`, never `db.wishlist` directly.
//
// `WishlistRecord` has no `tags` field, so this form does not have a
// tags input — adding one would require a schema migration which is
// out of scope for PR 7b.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { availableVariants } from '../domain/card-variants';
import { ValidationError } from '../domain/validators';
import {
  type CardFinish,
  type CardRecord,
  type CurrencyCode,
  type RawCondition,
  type WishlistPriority,
  type WishlistRecord,
  type WishlistStatus,
} from '../domain/types';
import { createCardsRepo } from '../repositories/cards-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import type { WishlistInput } from '../domain/validators';
import type { DialogContent } from './dialog';

const FINISH_LABELS: Record<CardFinish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  non_holo: 'Non-holo',
  stamped: 'Stamped (manuell — krever notat)',
  unknown: 'Ukjent (krever notat)',
};

const PRIORITIES: ReadonlyArray<{ readonly value: WishlistPriority; readonly label: string }> = [
  { value: 'grail', label: 'Grail' },
  { value: 'high', label: 'Høy' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Lav' },
];

const TARGET_CONDITIONS: ReadonlyArray<{
  readonly value: '' | RawCondition;
  readonly label: string;
}> = [
  { value: '', label: 'Ingen preferanse' },
  { value: 'NM', label: 'NM' },
  { value: 'LP', label: 'LP' },
  { value: 'MP', label: 'MP' },
  { value: 'HP', label: 'HP' },
  { value: 'DMG', label: 'DMG' },
  { value: 'UNKNOWN', label: 'UNKNOWN' },
];

const CURRENCIES: readonly CurrencyCode[] = ['NOK', 'USD', 'EUR', 'PHP'];

const STATUS_OPTIONS: ReadonlyArray<{
  readonly value: WishlistStatus;
  readonly label: string;
}> = [
  { value: 'wanted', label: 'Ønsket' },
  { value: 'ordered', label: 'Bestilt' },
  { value: 'received', label: 'Mottatt' },
  { value: 'cancelled', label: 'Avbrutt' },
];

export interface AddWishlistOptions {
  readonly mode: 'add';
  readonly cardId: string;
}

export interface EditWishlistOptions {
  readonly mode: 'edit';
  readonly entry: WishlistRecord;
}

export type WishlistFormOptions = AddWishlistOptions | EditWishlistOptions;

export function buildWishlistForm(options: WishlistFormOptions): DialogContent {
  return {
    mount(host, close) {
      void mount(options, host, close);
    },
  };
}

async function mount(
  options: WishlistFormOptions,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  const cardId = options.mode === 'add' ? options.cardId : options.entry.cardId;
  const card = await createCardsRepo(getDb()).get(cardId);

  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.wishlist-form');
  if (form === null) return;
  populateForm(form, options, card ?? null);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(form, options, host);
  });

  form
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wishlist-form-wrap';
  wrap.innerHTML = `
    <form class="wishlist-form" novalidate>
      <header class="wishlist-form__header">
        <h2 data-region="title"></h2>
        <p class="wishlist-form__card" data-region="card-summary"></p>
      </header>

      <fieldset class="wishlist-form__section">
        <legend>Hva ønsker du</legend>
        <p class="wishlist-form__hint" data-region="variant-hint" hidden></p>
        <label class="wishlist-form__field">
          <span>Finish</span>
          <select name="finish"></select>
        </label>
        <label class="wishlist-form__field">
          <span>Prioritet</span>
          <select name="priority"></select>
        </label>
        <label class="wishlist-form__field">
          <span>Måltilstand</span>
          <select name="targetCondition"></select>
        </label>
        <label class="wishlist-form__field">
          <span>Status</span>
          <select name="status"></select>
        </label>
      </fieldset>

      <fieldset class="wishlist-form__section">
        <legend>Målpris</legend>
        <label class="wishlist-form__field">
          <span>Beløp</span>
          <input type="number" name="targetPrice" min="0" step="0.01" />
        </label>
        <label class="wishlist-form__field">
          <span>Valuta</span>
          <select name="targetCurrency"></select>
        </label>
      </fieldset>

      <fieldset class="wishlist-form__section">
        <legend>Notat</legend>
        <label class="wishlist-form__field wishlist-form__field--full">
          <span>Notat</span>
          <textarea name="note" rows="3"></textarea>
        </label>
      </fieldset>

      <p class="wishlist-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="wishlist-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="wishlist-form__submit">Lagre</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populateForm(
  form: HTMLFormElement,
  options: WishlistFormOptions,
  card: CardRecord | null,
): void {
  const title = form.querySelector<HTMLElement>('[data-region="title"]');
  if (title !== null) {
    title.textContent =
      options.mode === 'add' ? 'Legg til i ønskeliste' : 'Rediger ønskeliste-oppføring';
  }
  const summary = form.querySelector<HTMLElement>('[data-region="card-summary"]');
  if (summary !== null) {
    if (card !== null) {
      summary.textContent = `${card.name} (${card.id})`;
    } else {
      summary.textContent =
        options.mode === 'add'
          ? `Kort ${options.cardId} (ikke i lokal cache — synk databasen først)`
          : `Kort ${options.entry.cardId}`;
    }
  }

  // Strict variant rules (PR 11): narrow finish to verified options
  // for the chosen card. Always include Stamped + Unknown as escape
  // hatches (require a non-empty note, enforced at submit by repo).
  const variants = card === null
    ? { verified: false as const, finishes: new Set<CardFinish>(), editions: new Set<never>() }
    : availableVariants(card);
  const finishOrder: readonly CardFinish[] = [
    'normal',
    'holo',
    'reverse_holo',
    'non_holo',
    'stamped',
    'unknown',
  ];
  const visibleFinishes = finishOrder.filter(
    (f) => variants.finishes.has(f) || f === 'stamped' || f === 'unknown',
  );
  populateSelect(
    form,
    'finish',
    visibleFinishes.map((value) => ({ value, label: FINISH_LABELS[value] })),
  );
  populateSelect(form, 'priority', PRIORITIES);
  populateSelect(form, 'targetCondition', TARGET_CONDITIONS);
  populateSelect(form, 'status', STATUS_OPTIONS);
  populateSelect(
    form,
    'targetCurrency',
    [{ value: '', label: '–' }, ...CURRENCIES.map((c) => ({ value: c, label: c }))],
  );

  if (options.mode === 'edit') {
    const e = options.entry;
    setValue(form, 'finish', e.finish);
    setValue(form, 'priority', e.priority);
    setValue(form, 'targetCondition', e.targetCondition ?? '');
    setValue(form, 'status', e.status);
    if (e.targetPrice !== null) setValue(form, 'targetPrice', String(e.targetPrice));
    if (e.targetCurrency !== null) setValue(form, 'targetCurrency', e.targetCurrency);
    if (e.note !== null) setValue(form, 'note', e.note);
  } else {
    // Sensible defaults for add mode. Pick the first verified finish
    // when the card has API data; fall back to 'unknown' (escape
    // hatch) when it does not.
    const defaultFinish: CardFinish = (
      ['normal', 'holo', 'reverse_holo'] as const
    ).find((f) => variants.finishes.has(f)) ?? 'unknown';
    setValue(form, 'finish', defaultFinish);
    setValue(form, 'priority', 'medium');
    setValue(form, 'targetCondition', '');
    setValue(form, 'status', 'wanted');
  }

  const hintRegion = form.querySelector<HTMLElement>(
    '[data-region="variant-hint"]',
  );
  if (hintRegion !== null) {
    if (!variants.verified) {
      hintRegion.textContent =
        card === null
          ? 'Kortet er ikke i lokal cache. Velg "Ukjent" og fyll inn et notat for å registrere.'
          : 'Pokémon TCG API har ingen variant-data for dette kortet. Velg "Ukjent" og fyll inn et notat.';
      hintRegion.hidden = false;
    } else {
      hintRegion.textContent = '';
      hintRegion.hidden = true;
    }
  }
}

function populateSelect(
  form: HTMLFormElement,
  name: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
): void {
  const select = form.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (select === null) return;
  select.replaceChildren();
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }
}

function setValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.elements.namedItem(name);
  if (field === null) return;
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement ||
    field instanceof HTMLTextAreaElement
  ) {
    field.value = value;
  }
}

async function handleSubmit(
  form: HTMLFormElement,
  options: WishlistFormOptions,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) {
    errorRegion.textContent = '';
    errorRegion.classList.remove('wishlist-form__error--visible');
  }

  let input: WishlistInput;
  try {
    input = collectFormInput(form, options);
  } catch (caught) {
    showError(errorRegion, describeError(caught));
    return;
  }

  const submitButton = form.querySelector<HTMLButtonElement>('.wishlist-form__submit');
  if (submitButton !== null) submitButton.disabled = true;

  try {
    const repo = createWishlistRepo(getDb());
    if (options.mode === 'add') {
      await repo.create(input);
    } else {
      await repo.update(options.entry.id, input);
    }
  } catch (caught) {
    if (submitButton !== null) submitButton.disabled = false;
    showError(errorRegion, describeError(caught));
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function collectFormInput(
  form: HTMLFormElement,
  options: WishlistFormOptions,
): WishlistInput {
  const cardId = options.mode === 'add' ? options.cardId : options.entry.cardId;
  const formData = new FormData(form);

  const finish = readSelect(
    formData,
    'finish',
    Object.keys(FINISH_LABELS),
  ) as CardFinish;
  const priority = readSelect(
    formData,
    'priority',
    PRIORITIES.map((p) => p.value),
  ) as WishlistPriority;
  const status = readSelect(
    formData,
    'status',
    STATUS_OPTIONS.map((s) => s.value),
  ) as WishlistStatus;

  const targetConditionRaw = readOptionalString(formData, 'targetCondition');
  const targetCondition: RawCondition | null =
    targetConditionRaw !== null &&
    (
      ['NM', 'LP', 'MP', 'HP', 'DMG', 'UNKNOWN'] as readonly string[]
    ).includes(targetConditionRaw)
      ? (targetConditionRaw as RawCondition)
      : null;

  const targetPrice = readOptionalNumber(formData, 'targetPrice');
  const targetCurrency = readOptionalCurrency(formData, 'targetCurrency');
  const note = readOptionalString(formData, 'note');

  return {
    cardId,
    finish,
    priority,
    targetCondition,
    targetPrice,
    targetCurrency,
    status,
    note,
  };
}

function readSelect(
  formData: FormData,
  key: string,
  allowed: readonly string[],
): string {
  const raw = formData.get(key);
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  return allowed[0] ?? '';
}

function readOptionalNumber(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function readOptionalString(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalCurrency(formData: FormData, key: string): CurrencyCode | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (CURRENCIES.includes(raw as CurrencyCode)) return raw as CurrencyCode;
  return null;
}

function showError(region: HTMLElement | null, message: string): void {
  if (region === null) return;
  region.textContent = message;
  region.classList.add('wishlist-form__error--visible');
}

function describeError(caught: unknown): string {
  if (caught instanceof ValidationError) {
    return `Feil: ${caught.message}`;
  }
  if (caught instanceof Error) {
    return `Lagring feilet: ${caught.message}`;
  }
  return 'Lagring feilet av en ukjent grunn.';
}
