// Lot-item Add/Edit form. Goes through `lotItemsRepo` so PR 3's
// validators + audit run. Uses the typeahead card picker to let the
// user search the cached cards by name.
//
// `LotItemRecord` has no `language`, `tags`, or `status` fields — the
// form intentionally does not surface them, even as hidden defaults,
// so we don't accidentally expand the persisted shape. Materialise
// flow uses `language: 'en'` as the holding default.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { buildLotCardPicker } from './lot-card-picker';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import type {
  CardFinish,
  ConditionType,
  Edition,
  GradingCompany,
  LotItemRecord,
  RawCondition,
} from '../domain/types';
import type { LotItemInput } from '../domain/validators';
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

const FINISHES: ReadonlyArray<{ readonly value: CardFinish; readonly label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'holo', label: 'Holo' },
  { value: 'reverse_holo', label: 'Reverse holo' },
  { value: 'non_holo', label: 'Non-holo' },
  { value: 'stamped', label: 'Stamped' },
  { value: 'unknown', label: 'Ukjent' },
];

const EDITIONS: ReadonlyArray<{ readonly value: Edition; readonly label: string }> = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'first_edition', label: '1st Edition' },
  { value: 'shadowless', label: 'Shadowless' },
  { value: 'unknown', label: 'Ukjent' },
];

export interface AddLotItemOptions {
  readonly mode: 'add';
  readonly lotId: string;
}

export interface EditLotItemOptions {
  readonly mode: 'edit';
  readonly item: LotItemRecord;
}

export type LotItemFormOptions = AddLotItemOptions | EditLotItemOptions;

export function buildLotItemForm(options: LotItemFormOptions): DialogContent {
  return {
    mount(host, close) {
      mount(options, host, close);
    },
  };
}

function mount(
  options: LotItemFormOptions,
  host: HTMLElement,
  close: () => void,
): void {
  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.lot-item-form');
  if (form === null) return;

  // Mount the card picker into its slot.
  let selectedCardId: string | null =
    options.mode === 'edit' ? options.item.cardId : null;
  const pickerSlot = form.querySelector<HTMLElement>('[data-region="card-picker"]');
  const picker = buildLotCardPicker({
    initialCardId: options.mode === 'edit' ? options.item.cardId : null,
    onSelect: (cardId) => {
      selectedCardId = cardId;
    },
  });
  if (pickerSlot !== null) {
    pickerSlot.replaceChildren(picker.element);
  }

  populate(form, options);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(form, options, host, () => selectedCardId);
  });
  form
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());
  form.querySelectorAll<HTMLInputElement>('input[name="conditionType"]').forEach((input) => {
    input.addEventListener('change', () => {
      updateConditionSections(form);
    });
  });
  updateConditionSections(form);
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lot-item-form-wrap';
  wrap.innerHTML = `
    <form class="lot-item-form" novalidate>
      <header class="lot-item-form__header">
        <h2 data-region="title"></h2>
      </header>

      <fieldset class="lot-item-form__section">
        <legend>Kort</legend>
        <div data-region="card-picker"></div>
      </fieldset>

      <fieldset class="lot-item-form__section">
        <legend>Antall og variant</legend>
        <label class="lot-item-form__field">
          <span>Antall</span>
          <input type="number" name="quantity" min="1" step="1" required />
        </label>
        <label class="lot-item-form__field">
          <span>Finish</span>
          <select name="finish"></select>
        </label>
        <label class="lot-item-form__field">
          <span>Edition</span>
          <select name="edition"></select>
        </label>
      </fieldset>

      <fieldset class="lot-item-form__section">
        <legend>Tilstand</legend>
        <div class="lot-item-form__radio-row">
          <label><input type="radio" name="conditionType" value="raw" /> Raw</label>
          <label><input type="radio" name="conditionType" value="graded" /> Gradet</label>
        </div>

        <div data-region="raw-section" class="lot-item-form__sub-section">
          <label class="lot-item-form__field">
            <span>Tilstand (raw)</span>
            <select name="rawCondition"></select>
          </label>
        </div>

        <div data-region="graded-section" class="lot-item-form__sub-section">
          <label class="lot-item-form__field">
            <span>Selskap</span>
            <select name="gradingCompany"></select>
          </label>
          <label class="lot-item-form__field">
            <span>Grade (1.0–10.0)</span>
            <input type="number" name="grade" min="1" max="10" step="0.5" />
          </label>
        </div>
      </fieldset>

      <fieldset class="lot-item-form__section">
        <legend>Pris</legend>
        <label class="lot-item-form__field">
          <span>Manuell pris-override</span>
          <input type="number" name="manualPriceOverride" min="0" step="0.01" />
        </label>
        <label class="lot-item-form__field">
          <span>Markedspris (estimat)</span>
          <input type="number" name="marketEstimate" min="0" step="0.01" />
        </label>
        <p class="lot-item-form__hint">
          Manuell brukes i manual-modus. Markedspris brukes i weighted-modus.
        </p>
      </fieldset>

      <fieldset class="lot-item-form__section">
        <legend>Notat</legend>
        <label class="lot-item-form__field lot-item-form__field--full">
          <span>Notat</span>
          <textarea name="note" rows="3"></textarea>
        </label>
      </fieldset>

      <p class="lot-item-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="lot-item-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="lot-item-form__submit">Lagre</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populate(form: HTMLFormElement, options: LotItemFormOptions): void {
  const title = form.querySelector<HTMLElement>('[data-region="title"]');
  if (title !== null) {
    title.textContent =
      options.mode === 'add' ? 'Nytt lot-item' : 'Rediger lot-item';
  }

  populateSelect(form, 'finish', FINISHES);
  populateSelect(form, 'edition', EDITIONS);
  populateSelect(
    form,
    'rawCondition',
    RAW_CONDITIONS.map((c) => ({ value: c, label: c })),
  );
  populateSelect(
    form,
    'gradingCompany',
    GRADING_COMPANIES.map((g) => ({ value: g, label: g })),
  );

  if (options.mode === 'add') {
    setValue(form, 'quantity', '1');
    setValue(form, 'finish', 'unknown');
    setValue(form, 'edition', 'unlimited');
    setValue(form, 'rawCondition', 'NM');
    setValue(form, 'gradingCompany', 'PSA');
    const rawRadio = form.querySelector<HTMLInputElement>(
      'input[name="conditionType"][value="raw"]',
    );
    if (rawRadio !== null) rawRadio.checked = true;
  } else {
    const i = options.item;
    setValue(form, 'quantity', String(i.quantity));
    setValue(form, 'finish', i.finish);
    setValue(form, 'edition', i.edition);
    setValue(form, 'rawCondition', i.rawCondition ?? 'NM');
    setValue(form, 'gradingCompany', i.gradingCompany ?? 'PSA');
    if (i.grade !== null) setValue(form, 'grade', String(i.grade));
    if (i.manualPriceOverride !== null) {
      setValue(form, 'manualPriceOverride', String(i.manualPriceOverride));
    }
    if (i.marketEstimate !== null) {
      setValue(form, 'marketEstimate', String(i.marketEstimate));
    }
    if (i.note !== null) setValue(form, 'note', i.note);
    const radio = form.querySelector<HTMLInputElement>(
      `input[name="conditionType"][value="${i.conditionType}"]`,
    );
    if (radio !== null) radio.checked = true;
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
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement ||
    field instanceof HTMLTextAreaElement
  ) {
    field.value = value;
  }
}

function updateConditionSections(form: HTMLFormElement): void {
  const isGraded =
    form.querySelector<HTMLInputElement>(
      'input[name="conditionType"][value="graded"]',
    )?.checked === true;
  const rawSection = form.querySelector<HTMLElement>('[data-region="raw-section"]');
  const gradedSection = form.querySelector<HTMLElement>('[data-region="graded-section"]');
  if (rawSection !== null) rawSection.hidden = isGraded;
  if (gradedSection !== null) gradedSection.hidden = !isGraded;
}

async function handleSubmit(
  form: HTMLFormElement,
  options: LotItemFormOptions,
  host: HTMLElement,
  getCardId: () => string | null,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';

  let input: LotItemInput;
  try {
    const cardId = getCardId();
    if (cardId === null) {
      throw new ValidationError('cardId', 'Velg et kort fra typeahead-listen.');
    }
    input = collect(form, options, cardId);
  } catch (caught) {
    showError(errorRegion, describeError(caught));
    return;
  }

  const submit = form.querySelector<HTMLButtonElement>('.lot-item-form__submit');
  if (submit !== null) submit.disabled = true;

  try {
    const repo = createLotItemsRepo(getDb());
    if (options.mode === 'add') {
      await repo.create(input);
    } else {
      await repo.update(options.item.id, input);
    }
  } catch (caught) {
    if (submit !== null) submit.disabled = false;
    showError(errorRegion, describeError(caught));
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function collect(
  form: HTMLFormElement,
  options: LotItemFormOptions,
  cardId: string,
): LotItemInput {
  const formData = new FormData(form);
  const lotId = options.mode === 'add' ? options.lotId : options.item.lotId;

  const conditionType = readSelect(
    formData,
    'conditionType',
    ['raw', 'graded'],
  ) as ConditionType;
  const quantityRaw = formData.get('quantity');
  const quantity =
    typeof quantityRaw === 'string'
      ? Number.parseInt(quantityRaw, 10)
      : NaN;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ValidationError('quantity', 'må være et heltall ≥ 1');
  }

  const rawCondition =
    conditionType === 'raw'
      ? (readSelect(formData, 'rawCondition', RAW_CONDITIONS) as RawCondition)
      : null;
  const gradingCompany =
    conditionType === 'graded'
      ? (readSelect(
          formData,
          'gradingCompany',
          GRADING_COMPANIES,
        ) as GradingCompany)
      : null;
  const grade =
    conditionType === 'graded' ? readOptionalNumber(formData, 'grade') : null;
  const finish = readSelect(formData, 'finish', FINISHES.map((f) => f.value)) as CardFinish;
  const edition = readSelect(formData, 'edition', EDITIONS.map((e) => e.value)) as Edition;
  const manualPriceOverride = readOptionalNumber(formData, 'manualPriceOverride');
  const marketEstimate = readOptionalNumber(formData, 'marketEstimate');
  const note = readOptionalString(formData, 'note');

  const previousAllocatedCost =
    options.mode === 'edit' ? options.item.allocatedCost : null;
  const previousHoldingId = options.mode === 'edit' ? options.item.holdingId : null;

  return {
    lotId,
    cardId,
    finish,
    edition,
    conditionType,
    rawCondition,
    gradingCompany,
    grade,
    quantity,
    manualPriceOverride,
    marketEstimate,
    allocatedCost: previousAllocatedCost,
    holdingId: previousHoldingId,
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

function showError(region: HTMLElement | null, message: string): void {
  if (region === null) return;
  region.textContent = message;
  region.classList.add('lot-item-form__error--visible');
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
