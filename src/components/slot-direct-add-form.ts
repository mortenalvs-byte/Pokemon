// PR 24 — slot direct-add form. Smaller variant of the holding-form
// scoped to a binder target slot:
//   - cardId is fixed (the slot's `targetCardId`).
//   - For reverse-holo template slots the finish defaults to
//     `reverse_holo` and is locked.
//   - The variant validator runs at the repo layer when the
//     `binder-assignment-service.createHoldingForSlotAndAssign` flow
//     calls `holdingsRepo.create`; this form does pre-validation only
//     for inline UX.
//
// On submit the form:
//   1. Calls `createHoldingForSlotAndAssign` (which creates the holding
//      then assigns the slot atomically with rollback).
//   2. Dispatches `USER_DATA_CHANGED_EVENT` once.
//   3. Returns the newly created holding via the dialog submit event
//      so callers can run the wishlist receive prompt afterwards.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import {
  ESCAPE_HATCH_EDITIONS,
  ESCAPE_HATCH_FINISHES,
  availableVariants,
  isReverseHoloTemplateSlot,
} from '../domain/card-variants';
import { ValidationError } from '../domain/validators';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import {
  SlotAssignmentError,
  createHoldingForSlotAndAssign,
} from '../services/binder-assignment-service';
import type {
  BinderSlotRecord,
  CardFinish,
  CardRecord,
  ConditionType,
  CurrencyCode,
  Edition,
  GradingCompany,
  HoldingRecord,
  RawCondition,
  SlotsPerPage,
} from '../domain/types';
import type { DialogContent } from './dialog';

const RAW_CONDITIONS: readonly RawCondition[] = [
  'NM',
  'LP',
  'MP',
  'HP',
  'DMG',
  'UNKNOWN',
];

const GRADING_COMPANIES: readonly GradingCompany[] = [
  'PSA',
  'BGS',
  'CGC',
  'TAG',
  'ACE',
  'OTHER',
];

const FINISH_LABELS: Record<CardFinish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  non_holo: 'Non-holo',
  stamped: 'Stamped (manuell — krever note/specialVariant)',
  unknown: 'Ukjent (krever note/specialVariant)',
};

const EDITION_LABELS: Record<Edition, string> = {
  unlimited: 'Unlimited',
  first_edition: '1st Edition',
  shadowless: 'Shadowless (manuell — krever note/specialVariant)',
  unknown: 'Ukjent (krever note/specialVariant)',
};

const CURRENCIES: readonly CurrencyCode[] = ['NOK', 'USD', 'EUR', 'PHP'];

export interface SlotDirectAddOptions {
  readonly slot: BinderSlotRecord;
  readonly slotsPerPage: SlotsPerPage;
  /** Called with the freshly-created holding after a successful submit. */
  readonly onCreated?: (holding: HoldingRecord) => void;
}

export function buildSlotDirectAddForm(
  options: SlotDirectAddOptions,
): DialogContent {
  return {
    mount(host, close) {
      void mount(options, host, close);
    },
  };
}

async function mount(
  options: SlotDirectAddOptions,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  const cardId = options.slot.targetCardId;
  if (cardId === null) {
    host.appendChild(buildBlankError());
    return;
  }
  const card = (await createCardsRepo(getDb()).get(cardId)) ?? null;
  const reverseTemplate = isReverseHoloTemplateSlot(options.slot.note);

  host.appendChild(buildSkeleton(options.slot, card, reverseTemplate));
  const root = host.querySelector<HTMLFormElement>('form.slot-direct-add');
  if (root === null) return;
  populate(root, card, reverseTemplate);

  root
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

  root.querySelectorAll<HTMLInputElement>('[name="conditionType"]').forEach((input) => {
    input.addEventListener('change', () => updateConditionSections(root));
  });
  updateConditionSections(root);

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(options, root, host);
  });
}

function buildBlankError(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'slot-direct-add-wrap';
  const p = document.createElement('p');
  p.className = 'slot-direct-add__error';
  p.textContent =
    'Slotten har ingen målkort. Bruk "Tilordne holding" og bygg slot-identitet derfra.';
  wrap.appendChild(p);
  return wrap;
}

function buildSkeleton(
  slot: BinderSlotRecord,
  card: CardRecord | null,
  reverseTemplate: boolean,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'slot-direct-add-wrap';
  wrap.innerHTML = `
    <form class="slot-direct-add holding-form" novalidate>
      <header class="holding-form__header">
        <h2>Legg til kort i slot</h2>
        <p class="holding-form__card" data-region="card-summary"></p>
        <p class="holding-form__hint" data-region="slot-hint"></p>
      </header>

      <fieldset class="holding-form__section">
        <legend>Antall og tilstand</legend>
        <label class="holding-form__field">
          <span>Antall</span>
          <input type="number" name="quantity" min="1" step="1" value="1" required />
        </label>
        <div class="holding-form__radio-row">
          <label><input type="radio" name="conditionType" value="raw" checked /> Raw</label>
          <label><input type="radio" name="conditionType" value="graded" /> Gradet</label>
        </div>

        <div data-region="raw-section" class="holding-form__sub-section">
          <label class="holding-form__field">
            <span>Tilstand (raw)</span>
            <select name="rawCondition"></select>
          </label>
        </div>

        <div data-region="graded-section" class="holding-form__sub-section">
          <label class="holding-form__field">
            <span>Grading-selskap</span>
            <select name="gradingCompany"></select>
          </label>
          <label class="holding-form__field">
            <span>Grade (1.0–10.0)</span>
            <input type="number" name="grade" min="1" max="10" step="0.5" />
          </label>
          <label class="holding-form__field">
            <span>Cert-nummer</span>
            <input type="text" name="certNumber" autocomplete="off" />
          </label>
        </div>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Variant</legend>
        <p class="holding-form__hint" data-region="variant-hint" hidden></p>
        <label class="holding-form__field">
          <span>Finish</span>
          <select name="finish"></select>
        </label>
        <label class="holding-form__field">
          <span>Edition</span>
          <select name="edition"></select>
        </label>
        <label class="holding-form__field">
          <span>Språk</span>
          <input type="text" name="language" maxlength="8" value="en" />
        </label>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Kjøpspris</legend>
        <label class="holding-form__field">
          <span>Kjøpspris</span>
          <input type="number" name="purchasePrice" min="0" step="0.01" />
        </label>
        <label class="holding-form__field">
          <span>Kjøpsvaluta</span>
          <select name="purchaseCurrency"></select>
        </label>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Notat</legend>
        <label class="holding-form__field">
          <span>Notat</span>
          <textarea name="note" rows="2"></textarea>
        </label>
        <label class="holding-form__field holding-form__field--checkbox">
          <input type="checkbox" name="specialVariant" />
          <span>Spesial-variant / misprint</span>
        </label>
      </fieldset>

      <p class="holding-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="holding-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="holding-form__submit">Lagre og tilordne</button>
      </footer>
    </form>
  `;
  void slot;
  void card;
  void reverseTemplate;
  return wrap;
}

function populate(
  root: HTMLFormElement,
  card: CardRecord | null,
  reverseTemplate: boolean,
): void {
  const summary = root.querySelector<HTMLElement>('[data-region="card-summary"]');
  if (summary !== null) {
    summary.textContent =
      card !== null
        ? `${card.name} (${card.id})`
        : `Kort i slot (ikke i lokal cache)`;
  }
  const slotHint = root.querySelector<HTMLElement>('[data-region="slot-hint"]');
  if (slotHint !== null) {
    slotHint.textContent = reverseTemplate
      ? 'Reverse-holo template-slot — finish er låst til reverse_holo.'
      : '';
  }

  const variants = card === null
    ? { verified: false as const, finishes: new Set<CardFinish>(), editions: new Set<Edition>() }
    : availableVariants(card);

  populateFinishSelect(root, variants.finishes, reverseTemplate);
  populateEditionSelect(root, variants.editions);
  populateSelect(
    root,
    'rawCondition',
    RAW_CONDITIONS.map((c) => ({ value: c, label: c })),
  );
  populateSelect(
    root,
    'gradingCompany',
    GRADING_COMPANIES.map((g) => ({ value: g, label: g })),
  );
  populateSelect(
    root,
    'purchaseCurrency',
    [{ value: '', label: '–' }, ...CURRENCIES.map((c) => ({ value: c, label: c }))],
  );

  if (reverseTemplate) {
    const finishSelect = root.querySelector<HTMLSelectElement>(
      'select[name="finish"]',
    );
    if (finishSelect !== null) {
      finishSelect.value = 'reverse_holo';
      finishSelect.disabled = true;
    }
  } else {
    setValue(root, 'finish', pickDefault(variants.finishes, ['normal', 'holo', 'reverse_holo'], 'unknown'));
  }
  setValue(root, 'edition', pickDefault(variants.editions, ['unlimited', 'first_edition'], 'unknown'));

  const variantHint = root.querySelector<HTMLElement>('[data-region="variant-hint"]');
  if (variantHint !== null) {
    if (!variants.verified) {
      variantHint.hidden = false;
      variantHint.textContent = card === null
        ? 'Kortet er ikke i lokal cache. Velg "Ukjent" og fyll inn et notat eller spesial-variant.'
        : 'Pokémon TCG API har ingen kjente variant-data for dette kortet.';
    } else {
      variantHint.hidden = true;
      variantHint.textContent = '';
    }
  }
}

function populateFinishSelect(
  root: HTMLFormElement,
  verified: ReadonlySet<CardFinish>,
  reverseTemplate: boolean,
): void {
  const order: readonly CardFinish[] = [
    'normal',
    'holo',
    'reverse_holo',
    'non_holo',
    'stamped',
    'unknown',
  ];
  const visible = reverseTemplate
    ? (['reverse_holo'] as readonly CardFinish[])
    : order.filter(
        (f) => verified.has(f) || ESCAPE_HATCH_FINISHES.has(f),
      );
  populateSelect(
    root,
    'finish',
    visible.map((value) => ({ value, label: FINISH_LABELS[value] })),
  );
}

function populateEditionSelect(
  root: HTMLFormElement,
  verified: ReadonlySet<Edition>,
): void {
  const order: readonly Edition[] = [
    'unlimited',
    'first_edition',
    'shadowless',
    'unknown',
  ];
  const visible = order.filter(
    (e) => verified.has(e) || ESCAPE_HATCH_EDITIONS.has(e),
  );
  populateSelect(
    root,
    'edition',
    visible.map((value) => ({ value, label: EDITION_LABELS[value] })),
  );
}

function pickDefault<T extends string>(
  verified: ReadonlySet<T>,
  preferred: readonly T[],
  fallback: T,
): T {
  for (const candidate of preferred) {
    if (verified.has(candidate)) return candidate;
  }
  return fallback;
}

function populateSelect(
  root: HTMLFormElement,
  name: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
): void {
  const select = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (select === null) return;
  select.replaceChildren();
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }
}

function setValue(root: HTMLFormElement, name: string, value: string): void {
  const field = root.elements.namedItem(name);
  if (field === null) return;
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement ||
    field instanceof HTMLTextAreaElement
  ) {
    field.value = value;
  }
}

function updateConditionSections(root: HTMLFormElement): void {
  const isGraded =
    root.querySelector<HTMLInputElement>(
      'input[name="conditionType"][value="graded"]',
    )?.checked === true;
  const rawSection = root.querySelector<HTMLElement>('[data-region="raw-section"]');
  const gradedSection = root.querySelector<HTMLElement>('[data-region="graded-section"]');
  if (rawSection !== null) rawSection.hidden = isGraded;
  if (gradedSection !== null) gradedSection.hidden = !isGraded;
}

async function handleSubmit(
  options: SlotDirectAddOptions,
  root: HTMLFormElement,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = root.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';
  const submit = root.querySelector<HTMLButtonElement>(
    '.holding-form__submit',
  );
  if (submit !== null) submit.disabled = true;

  const formData = new FormData(root);
  const conditionType = (formData.get('conditionType') ?? 'raw') as ConditionType;
  const rawCondition = conditionType === 'raw'
    ? (readSelect(formData, 'rawCondition', RAW_CONDITIONS) as RawCondition)
    : null;
  const gradingCompany = conditionType === 'graded'
    ? (readSelect(formData, 'gradingCompany', GRADING_COMPANIES) as GradingCompany)
    : null;
  const grade = conditionType === 'graded' ? readOptionalNumber(formData, 'grade') : null;
  const certNumber = conditionType === 'graded' ? readOptionalString(formData, 'certNumber') : null;
  const finishField = root.querySelector<HTMLSelectElement>('select[name="finish"]');
  const finish = (finishField?.value ?? 'unknown') as CardFinish;
  const edition = readSelect(formData, 'edition', Object.keys(EDITION_LABELS)) as Edition;
  const language = readOptionalString(formData, 'language') ?? 'en';
  const quantity = readInt(formData, 'quantity', 1);
  const purchasePrice = readOptionalNumber(formData, 'purchasePrice');
  const purchaseCurrency = readOptionalCurrency(formData, 'purchaseCurrency');
  const note = readOptionalString(formData, 'note');
  const specialVariant = formData.get('specialVariant') === 'on';

  const db = getDb();
  const deps = {
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    cardsRepo: createCardsRepo(db),
  };
  try {
    const { holding } = await createHoldingForSlotAndAssign(
      deps,
      options.slot,
      options.slotsPerPage,
      {
        conditionType,
        rawCondition,
        gradingCompany,
        grade,
        certNumber,
        certUrl: null,
        gradedDate: null,
        finish,
        edition,
        language,
        quantity,
        purchasePrice,
        purchaseCurrency,
        note,
        specialVariant,
        tags: [],
      },
    );
    options.onCreated?.(holding);
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
  } catch (caught) {
    if (submit !== null) submit.disabled = false;
    if (errorRegion !== null) errorRegion.textContent = describeError(caught);
  }
}

function readInt(formData: FormData, key: string, fallback: number): number {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
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

function readSelect(
  formData: FormData,
  key: string,
  allowed: readonly string[],
): string {
  const raw = formData.get(key);
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  return allowed[0] ?? '';
}

function readOptionalCurrency(
  formData: FormData,
  key: string,
): CurrencyCode | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (CURRENCIES.includes(raw as CurrencyCode)) return raw as CurrencyCode;
  return null;
}

function describeError(caught: unknown): string {
  if (caught instanceof SlotAssignmentError) return `Feil: ${caught.message}`;
  if (caught instanceof ValidationError) return `Feil: ${caught.message}`;
  if (caught instanceof Error) return `Lagring feilet: ${caught.message}`;
  return 'Lagring feilet av en ukjent grunn.';
}
