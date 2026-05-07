// Lot Add/Edit form. Renders inside an `<dialog>`. All persistence
// goes through `lotsRepo` so PR 3's validation + audit run.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createLotsRepo } from '../repositories/lots-repo';
import type {
  AllocationMethod,
  CurrencyCode,
  LotRecord,
} from '../domain/types';
import type { LotInput } from '../domain/validators';
import type { DialogContent } from './dialog';

const CURRENCIES: readonly CurrencyCode[] = ['NOK', 'USD', 'EUR', 'PHP'];

const ALLOCATION_METHODS: ReadonlyArray<{
  readonly value: AllocationMethod;
  readonly label: string;
}> = [
  { value: 'equal', label: 'Lik fordeling' },
  { value: 'weighted_by_market_price', label: 'Vektet etter markedspris' },
  { value: 'manual', label: 'Manuell' },
];

export interface AddLotOptions {
  readonly mode: 'add';
}

export interface EditLotOptions {
  readonly mode: 'edit';
  readonly lot: LotRecord;
}

export type LotFormOptions = AddLotOptions | EditLotOptions;

export function buildLotForm(options: LotFormOptions): DialogContent {
  return {
    mount(host, close) {
      mount(options, host, close);
    },
  };
}

function mount(
  options: LotFormOptions,
  host: HTMLElement,
  close: () => void,
): void {
  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.lot-form');
  if (form === null) return;
  populate(form, options);

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
  wrap.className = 'lot-form-wrap';
  wrap.innerHTML = `
    <form class="lot-form" novalidate>
      <header class="lot-form__header">
        <h2 data-region="title"></h2>
      </header>

      <fieldset class="lot-form__section">
        <legend>Lot</legend>
        <label class="lot-form__field">
          <span>Navn</span>
          <input type="text" name="name" required maxlength="120" />
        </label>
        <label class="lot-form__field">
          <span>Kjøpsdato</span>
          <input type="date" name="purchaseDate" required />
        </label>
        <label class="lot-form__field">
          <span>Total kostnad</span>
          <input type="number" name="totalCost" min="0" step="0.01" required />
        </label>
        <label class="lot-form__field">
          <span>Valuta</span>
          <select name="currency"></select>
        </label>
        <label class="lot-form__field">
          <span>Fordelingsmetode</span>
          <select name="allocationMethod"></select>
        </label>
        <label class="lot-form__field lot-form__field--full">
          <span>Notat</span>
          <textarea name="notes" rows="3"></textarea>
        </label>
      </fieldset>

      <p class="lot-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="lot-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="lot-form__submit">Lagre</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populate(form: HTMLFormElement, options: LotFormOptions): void {
  const title = form.querySelector<HTMLElement>('[data-region="title"]');
  if (title !== null) {
    title.textContent = options.mode === 'add' ? 'Ny lot' : `Rediger "${options.lot.name}"`;
  }
  populateSelect(
    form,
    'currency',
    CURRENCIES.map((c) => ({ value: c, label: c })),
  );
  populateSelect(form, 'allocationMethod', ALLOCATION_METHODS);

  if (options.mode === 'add') {
    setValue(form, 'name', '');
    setValue(form, 'purchaseDate', new Date().toISOString().slice(0, 10));
    setValue(form, 'totalCost', '');
    setValue(form, 'currency', 'NOK');
    setValue(form, 'allocationMethod', 'equal');
    setValue(form, 'notes', '');
  } else {
    const l = options.lot;
    setValue(form, 'name', l.name);
    setValue(form, 'purchaseDate', l.purchaseDate.slice(0, 10));
    setValue(form, 'totalCost', String(l.totalCost));
    setValue(form, 'currency', l.currency);
    setValue(form, 'allocationMethod', l.allocationMethod);
    if (l.notes !== null) setValue(form, 'notes', l.notes);
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

async function handleSubmit(
  form: HTMLFormElement,
  options: LotFormOptions,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';

  let input: LotInput;
  try {
    input = collect(form);
  } catch (caught) {
    showError(errorRegion, describeError(caught));
    return;
  }

  const submit = form.querySelector<HTMLButtonElement>('.lot-form__submit');
  if (submit !== null) submit.disabled = true;

  try {
    const repo = createLotsRepo(getDb());
    if (options.mode === 'add') {
      await repo.create(input);
    } else {
      await repo.update(options.lot.id, input);
    }
  } catch (caught) {
    if (submit !== null) submit.disabled = false;
    showError(errorRegion, describeError(caught));
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function collect(form: HTMLFormElement): LotInput {
  const formData = new FormData(form);
  const name = readRequiredString(formData, 'name', 'Navn er påkrevd');
  const purchaseDateRaw = readRequiredString(
    formData,
    'purchaseDate',
    'Kjøpsdato er påkrevd',
  );
  // Normalize to a full ISO timestamp at start of day so it sorts
  // correctly alongside other timestamps in the audit log.
  const purchaseDate = `${purchaseDateRaw}T00:00:00.000Z`;
  const totalCostRaw = formData.get('totalCost');
  const totalCost =
    typeof totalCostRaw === 'string' ? Number.parseFloat(totalCostRaw) : NaN;
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    throw new ValidationError('totalCost', 'må være et tall ≥ 0');
  }
  const currency = readSelect(formData, 'currency', CURRENCIES) as CurrencyCode;
  const allocationMethod = readSelect(
    formData,
    'allocationMethod',
    ALLOCATION_METHODS.map((m) => m.value),
  ) as AllocationMethod;
  const notes = readOptionalString(formData, 'notes');

  return {
    name,
    purchaseDate,
    totalCost,
    currency,
    allocationMethod,
    notes,
  };
}

function readRequiredString(
  formData: FormData,
  key: string,
  message: string,
): string {
  const raw = formData.get(key);
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError(key, message);
  }
  return raw.trim();
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

function showError(region: HTMLElement | null, message: string): void {
  if (region === null) return;
  region.textContent = message;
  region.classList.add('lot-form__error--visible');
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
