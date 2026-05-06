// Holding add/edit form. Renders inside an `<dialog>` provided by
// `openDialog()`. The form is the only place in PR 7a that turns user
// input into a holding write — and every write goes through
// `holdingsRepo.create` / `holdingsRepo.update`, never `db.holdings`
// directly. Repo validation runs on save; this form only does
// pre-validation for inline UX.
//
// All dynamic content (existing values, error messages, card name) is
// rendered via `textContent` / `createElement`.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { formatTags, parseTags } from '../domain/tags';
import {
  type CardFinish,
  type CardRecord,
  type ConditionType,
  type CurrencyCode,
  type Edition,
  type GradingCompany,
  type HoldingRecord,
  type HoldingStatus,
  type RawCondition,
  type ValueSource,
} from '../domain/types';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import type { HoldingInput } from '../domain/validators';
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

const CURRENCIES: readonly CurrencyCode[] = ['NOK', 'USD', 'EUR', 'PHP'];

const STATUS_OPTIONS: ReadonlyArray<{
  readonly value: HoldingStatus;
  readonly label: string;
}> = [
  { value: 'owned', label: 'Eid' },
  { value: 'duplicate', label: 'Duplikat' },
  { value: 'for_sale', label: 'Til salgs' },
  { value: 'for_trade', label: 'Bytte' },
  { value: 'upgrade_needed', label: 'Bør oppgraderes' },
  { value: 'ordered', label: 'Bestilt' },
  { value: 'wanted', label: 'Ønsket' },
];

export interface AddHoldingOptions {
  readonly mode: 'add';
  readonly cardId: string;
}

export interface EditHoldingOptions {
  readonly mode: 'edit';
  readonly holding: HoldingRecord;
}

export type HoldingFormOptions = AddHoldingOptions | EditHoldingOptions;

export function buildHoldingForm(options: HoldingFormOptions): DialogContent {
  return {
    mount(host, close) {
      void mount(options, host, close);
    },
  };
}

async function mount(
  options: HoldingFormOptions,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  const cardId = options.mode === 'add' ? options.cardId : options.holding.cardId;
  const db = getDb();
  const card = await createCardsRepo(db).get(cardId);

  host.appendChild(buildSkeleton());
  const root = host.querySelector<HTMLFormElement>('form.holding-form');
  if (root === null) return;
  populateForm(root, options, card ?? null);

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(root, options, host);
  });

  root
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

  // Toggle raw/graded sections when the user changes condition type.
  root.querySelectorAll<HTMLInputElement>('[name="conditionType"]').forEach((input) => {
    input.addEventListener('change', () => {
      updateConditionSections(root);
    });
  });
  updateConditionSections(root);
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'holding-form-wrap';
  wrap.innerHTML = `
    <form class="holding-form" novalidate>
      <header class="holding-form__header">
        <h2 data-region="title"></h2>
        <p class="holding-form__card" data-region="card-summary"></p>
      </header>

      <fieldset class="holding-form__section">
        <legend>Antall og status</legend>
        <label class="holding-form__field">
          <span>Antall</span>
          <input type="number" name="quantity" min="1" step="1" required />
        </label>
        <label class="holding-form__field">
          <span>Status</span>
          <select name="status"></select>
        </label>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Tilstand</legend>
        <div class="holding-form__radio-row">
          <label><input type="radio" name="conditionType" value="raw" /> Raw</label>
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
          <label class="holding-form__field">
            <span>Cert-URL</span>
            <input type="url" name="certUrl" autocomplete="off" />
          </label>
          <label class="holding-form__field">
            <span>Gradet dato</span>
            <input type="date" name="gradedDate" />
          </label>
        </div>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Variant</legend>
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
          <input type="text" name="language" maxlength="8" />
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
        <legend>Manuell verdi</legend>
        <label class="holding-form__field">
          <span>Estimert verdi</span>
          <input type="number" name="estimatedValue" min="0" step="0.01" />
        </label>
        <label class="holding-form__field">
          <span>Verdi-valuta</span>
          <select name="valueCurrency"></select>
        </label>
        <p class="holding-form__hint">
          Hvis du fyller inn estimert verdi, settes <code>valueSource</code>
          til <code>manual</code>.
        </p>
      </fieldset>

      <fieldset class="holding-form__section">
        <legend>Tags og notat</legend>
        <label class="holding-form__field">
          <span>Tags (komma-separert)</span>
          <input type="text" name="tags" autocomplete="off" placeholder="favorite, to_grade" />
        </label>
        <label class="holding-form__field">
          <span>Notat</span>
          <textarea name="note" rows="3"></textarea>
        </label>
        <label class="holding-form__field holding-form__field--checkbox">
          <input type="checkbox" name="specialVariant" />
          <span>Spesial-variant / misprint</span>
        </label>
      </fieldset>

      <p class="holding-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="holding-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="holding-form__submit">Lagre</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populateForm(
  root: HTMLFormElement,
  options: HoldingFormOptions,
  card: CardRecord | null,
): void {
  // Title + card summary
  const title = root.querySelector<HTMLElement>('[data-region="title"]');
  if (title !== null) {
    title.textContent =
      options.mode === 'add' ? 'Legg til i samling' : 'Rediger holding';
  }
  const summary = root.querySelector<HTMLElement>('[data-region="card-summary"]');
  if (summary !== null) {
    if (card !== null) {
      summary.textContent = `${card.name} (${card.id})`;
    } else {
      summary.textContent =
        options.mode === 'add'
          ? `Kort ${options.cardId} (ikke i lokal cache — synk databasen først)`
          : `Kort ${options.holding.cardId}`;
    }
  }

  // Selects
  populateSelect(root, 'rawCondition', RAW_CONDITIONS.map((c) => ({ value: c, label: c })));
  populateSelect(
    root,
    'gradingCompany',
    GRADING_COMPANIES.map((g) => ({ value: g, label: g })),
  );
  populateSelect(root, 'finish', FINISHES);
  populateSelect(root, 'edition', EDITIONS);
  populateSelect(
    root,
    'purchaseCurrency',
    [{ value: '', label: '–' }, ...CURRENCIES.map((c) => ({ value: c, label: c }))],
  );
  populateSelect(
    root,
    'valueCurrency',
    [{ value: '', label: '–' }, ...CURRENCIES.map((c) => ({ value: c, label: c }))],
  );
  populateSelect(root, 'status', STATUS_OPTIONS);

  // Default values
  setValue(root, 'quantity', options.mode === 'edit' ? String(options.holding.quantity) : '1');
  setValue(root, 'language', options.mode === 'edit' ? options.holding.language : 'en');
  setValue(root, 'finish', options.mode === 'edit' ? options.holding.finish : 'unknown');
  setValue(root, 'edition', options.mode === 'edit' ? options.holding.edition : 'unknown');
  setValue(root, 'rawCondition', options.mode === 'edit' ? options.holding.rawCondition ?? 'NM' : 'NM');
  setValue(root, 'gradingCompany', options.mode === 'edit' ? options.holding.gradingCompany ?? 'PSA' : 'PSA');
  setValue(root, 'status', options.mode === 'edit' ? options.holding.status : 'owned');

  // Condition type radio
  const conditionType: ConditionType =
    options.mode === 'edit' ? options.holding.conditionType : 'raw';
  const radio = root.querySelector<HTMLInputElement>(
    `input[name="conditionType"][value="${conditionType}"]`,
  );
  if (radio !== null) radio.checked = true;

  if (options.mode === 'edit') {
    const h = options.holding;
    if (h.grade !== null) setValue(root, 'grade', String(h.grade));
    if (h.certNumber !== null) setValue(root, 'certNumber', h.certNumber);
    if (h.certUrl !== null) setValue(root, 'certUrl', h.certUrl);
    if (h.gradedDate !== null) setValue(root, 'gradedDate', h.gradedDate.slice(0, 10));
    if (h.purchasePrice !== null) setValue(root, 'purchasePrice', String(h.purchasePrice));
    if (h.purchaseCurrency !== null) setValue(root, 'purchaseCurrency', h.purchaseCurrency);
    if (h.estimatedValue !== null) setValue(root, 'estimatedValue', String(h.estimatedValue));
    if (h.valueCurrency !== null) setValue(root, 'valueCurrency', h.valueCurrency);
    setValue(root, 'tags', formatTags(h.tags));
    if (h.note !== null) setValue(root, 'note', h.note);
    const specialVariantCheckbox = root.querySelector<HTMLInputElement>(
      'input[name="specialVariant"]',
    );
    if (specialVariantCheckbox !== null) specialVariantCheckbox.checked = h.specialVariant;
  }
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
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
    field.value = value;
  }
}

function updateConditionSections(root: HTMLFormElement): void {
  const isGraded =
    root.querySelector<HTMLInputElement>('input[name="conditionType"][value="graded"]')
      ?.checked === true;
  const rawSection = root.querySelector<HTMLElement>('[data-region="raw-section"]');
  const gradedSection = root.querySelector<HTMLElement>('[data-region="graded-section"]');
  if (rawSection !== null) rawSection.hidden = isGraded;
  if (gradedSection !== null) gradedSection.hidden = !isGraded;
}

async function handleSubmit(
  root: HTMLFormElement,
  options: HoldingFormOptions,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = root.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) {
    errorRegion.textContent = '';
    errorRegion.classList.remove('holding-form__error--visible');
  }

  let input: HoldingInput;
  try {
    input = collectFormInput(root, options);
  } catch (caught) {
    showError(errorRegion, describeError(caught));
    return;
  }

  const submitButton = root.querySelector<HTMLButtonElement>('.holding-form__submit');
  if (submitButton !== null) submitButton.disabled = true;

  try {
    const repo = createHoldingsRepo(getDb());
    if (options.mode === 'add') {
      await repo.create(input);
    } else {
      await repo.update(options.holding.id, input);
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
  root: HTMLFormElement,
  options: HoldingFormOptions,
): HoldingInput {
  const cardId = options.mode === 'add' ? options.cardId : options.holding.cardId;
  const formData = new FormData(root);

  const conditionType = (formData.get('conditionType') ?? 'raw') as ConditionType;
  const quantity = readInt(formData, 'quantity', 1);
  const rawCondition =
    conditionType === 'raw'
      ? (readSelect(formData, 'rawCondition', RAW_CONDITIONS) as RawCondition | null)
      : null;
  const gradingCompany =
    conditionType === 'graded'
      ? (readSelect(formData, 'gradingCompany', GRADING_COMPANIES) as GradingCompany | null)
      : null;
  const grade =
    conditionType === 'graded' ? readOptionalNumber(formData, 'grade') : null;
  const certNumber = conditionType === 'graded' ? readOptionalString(formData, 'certNumber') : null;
  const certUrl = conditionType === 'graded' ? readOptionalString(formData, 'certUrl') : null;
  const gradedDate =
    conditionType === 'graded' ? readOptionalIsoDate(formData, 'gradedDate') : null;

  const finish = readSelect(formData, 'finish', FINISHES.map((f) => f.value)) as CardFinish;
  const edition = readSelect(formData, 'edition', EDITIONS.map((e) => e.value)) as Edition;
  const language = (readOptionalString(formData, 'language') ?? 'en');

  const purchasePrice = readOptionalNumber(formData, 'purchasePrice');
  const purchaseCurrency = readOptionalCurrency(formData, 'purchaseCurrency');
  const estimatedValue = readOptionalNumber(formData, 'estimatedValue');
  const valueCurrency = readOptionalCurrency(formData, 'valueCurrency');

  const valueUpdatedAt = estimatedValue !== null ? new Date().toISOString() : null;

  const tagsInput = readOptionalString(formData, 'tags') ?? '';
  const tags = parseTags(tagsInput);

  const note = readOptionalString(formData, 'note');
  const specialVariant = formData.get('specialVariant') === 'on';
  const status = readSelect(formData, 'status', STATUS_OPTIONS.map((s) => s.value)) as HoldingStatus;

  const previousValueSource = options.mode === 'edit' ? options.holding.valueSource : 'unknown';
  const finalValueSource: ValueSource =
    estimatedValue !== null ? 'manual' : previousValueSource;
  const previousValueNote = options.mode === 'edit' ? options.holding.valueNote : null;
  const previousLotId = options.mode === 'edit' ? options.holding.lotId : null;
  const previousSource =
    options.mode === 'edit' ? options.holding.source : 'manual';

  return {
    cardId,
    quantity,
    conditionType,
    rawCondition,
    gradingCompany,
    grade,
    certNumber,
    certUrl,
    gradedDate,
    finish,
    edition,
    language,
    purchasePrice,
    purchaseCurrency,
    estimatedValue,
    valueCurrency,
    valueSource: finalValueSource,
    valueNote: previousValueNote,
    valueUpdatedAt,
    source: previousSource,
    note,
    specialVariant,
    tags,
    lotId: previousLotId,
    status,
  };
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

function readOptionalIsoDate(formData: FormData, key: string): string | null {
  const raw = readOptionalString(formData, key);
  if (raw === null) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

function readOptionalCurrency(formData: FormData, key: string): CurrencyCode | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (CURRENCIES.includes(raw as CurrencyCode)) return raw as CurrencyCode;
  return null;
}

function showError(region: HTMLElement | null, message: string): void {
  if (region === null) return;
  region.textContent = message;
  region.classList.add('holding-form__error--visible');
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
