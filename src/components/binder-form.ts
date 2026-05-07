// Binder add/edit form. Renders inside an `<dialog>` provided by
// `openDialog()`. Create mode goes through `binderService.createManualBinder`
// so the binder + every empty slot land atomically. Edit mode goes through
// `bindersRepo.update` and never touches slots — there is intentionally no
// "resize binder" path in PR 8a, since that would require deciding what to
// do with slots that fall outside the new range and is well beyond the
// scope of "create + rename + describe".

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderService } from '../services/binder-service';
import type {
  BinderRecord,
  CompletionMode,
} from '../domain/types';
import type { BinderInput } from '../domain/validators';
import type { DialogContent } from './dialog';

const SLOTS_PER_PAGE_OPTIONS: ReadonlyArray<{
  readonly value: '9' | '18';
  readonly label: string;
}> = [
  { value: '9', label: '9 (3×3)' },
  { value: '18', label: '18 (3×3 dobbel)' },
];

const COMPLETION_MODES: ReadonlyArray<{
  readonly value: CompletionMode;
  readonly label: string;
}> = [
  { value: 'standard', label: 'Standard' },
  { value: 'master', label: 'Master' },
];

export interface AddBinderOptions {
  readonly mode: 'add';
}

export interface EditBinderOptions {
  readonly mode: 'edit';
  readonly binder: BinderRecord;
}

export type BinderFormOptions = AddBinderOptions | EditBinderOptions;

export function buildBinderForm(options: BinderFormOptions): DialogContent {
  return {
    mount(host, close) {
      mount(options, host, close);
    },
  };
}

function mount(
  options: BinderFormOptions,
  host: HTMLElement,
  close: () => void,
): void {
  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.binder-form');
  if (form === null) return;
  populateForm(form, options);

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
  wrap.className = 'binder-form-wrap';
  wrap.innerHTML = `
    <form class="binder-form" novalidate>
      <header class="binder-form__header">
        <h2 data-region="title"></h2>
      </header>

      <fieldset class="binder-form__section">
        <legend>Permdetaljer</legend>
        <label class="binder-form__field">
          <span>Navn</span>
          <input type="text" name="name" required maxlength="120" />
        </label>
        <label class="binder-form__field">
          <span>Type / merke (valgfritt)</span>
          <input type="text" name="binderType" maxlength="80" autocomplete="off" />
        </label>
        <label class="binder-form__field binder-form__field--full">
          <span>Beskrivelse (valgfritt)</span>
          <textarea name="description" rows="3"></textarea>
        </label>
      </fieldset>

      <fieldset class="binder-form__section">
        <legend>Layout</legend>
        <label class="binder-form__field">
          <span>Slots per side</span>
          <select name="slotsPerPage" data-region="slots-per-page"></select>
        </label>
        <label class="binder-form__field">
          <span>Antall sider</span>
          <input type="number" name="totalPages" min="1" step="1" required />
        </label>
        <label class="binder-form__field">
          <span>Completion-modus</span>
          <select name="completionMode" data-region="completion-mode"></select>
        </label>
        <p class="binder-form__hint" data-region="layout-hint"></p>
      </fieldset>

      <p class="binder-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="binder-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="binder-form__submit">Lagre</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populateForm(form: HTMLFormElement, options: BinderFormOptions): void {
  const title = form.querySelector<HTMLElement>('[data-region="title"]');
  if (title !== null) {
    title.textContent =
      options.mode === 'add' ? 'Ny perm' : `Rediger "${options.binder.name}"`;
  }

  populateSelect(
    form,
    'slotsPerPage',
    SLOTS_PER_PAGE_OPTIONS.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  );
  populateSelect(form, 'completionMode', COMPLETION_MODES);

  if (options.mode === 'add') {
    setValue(form, 'name', '');
    setValue(form, 'binderType', '');
    setValue(form, 'description', '');
    setValue(form, 'slotsPerPage', '9');
    setValue(form, 'totalPages', '1');
    setValue(form, 'completionMode', 'standard');
  } else {
    const b = options.binder;
    setValue(form, 'name', b.name);
    setValue(form, 'binderType', b.binderType ?? '');
    setValue(form, 'description', b.description ?? '');
    setValue(form, 'slotsPerPage', String(b.slotsPerPage));
    setValue(form, 'totalPages', String(b.totalPages));
    setValue(form, 'completionMode', b.completionMode);

    // Layout fields are read-only in edit mode — changing them would
    // need a slot migration which PR 8a does not ship.
    disableField(form, 'slotsPerPage');
    disableField(form, 'totalPages');
  }

  updateLayoutHint(form, options.mode);
  form
    .querySelector<HTMLElement>('[data-region="slots-per-page"]')
    ?.addEventListener('change', () => updateLayoutHint(form, options.mode));
  form
    .querySelector<HTMLInputElement>('input[name="totalPages"]')
    ?.addEventListener('input', () => updateLayoutHint(form, options.mode));
}

function updateLayoutHint(form: HTMLFormElement, mode: 'add' | 'edit'): void {
  const hint = form.querySelector<HTMLElement>('[data-region="layout-hint"]');
  if (hint === null) return;
  if (mode === 'edit') {
    hint.textContent =
      'Antall sider og slots per side kan ikke endres etter at permen er opprettet.';
    return;
  }
  const slotsPerPage = readNumberValue(form, 'slotsPerPage');
  const totalPages = readNumberValue(form, 'totalPages');
  if (slotsPerPage === null || totalPages === null) {
    hint.textContent = '';
    return;
  }
  const total = slotsPerPage * totalPages;
  hint.textContent = `Det opprettes ${total} tomme slots (${totalPages} sider × ${slotsPerPage}).`;
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

function disableField(form: HTMLFormElement, name: string): void {
  const field = form.elements.namedItem(name);
  if (field === null) return;
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement
  ) {
    field.disabled = true;
  }
}

function readNumberValue(form: HTMLFormElement, name: string): number | null {
  const field = form.elements.namedItem(name);
  if (
    !(field instanceof HTMLInputElement) &&
    !(field instanceof HTMLSelectElement)
  ) {
    return null;
  }
  const n = Number.parseInt(field.value, 10);
  return Number.isFinite(n) ? n : null;
}

async function handleSubmit(
  form: HTMLFormElement,
  options: BinderFormOptions,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) {
    errorRegion.textContent = '';
    errorRegion.classList.remove('binder-form__error--visible');
  }

  let input: BinderInput;
  try {
    input = collectFormInput(form, options);
  } catch (caught) {
    showError(errorRegion, describeError(caught));
    return;
  }

  const submitButton = form.querySelector<HTMLButtonElement>('.binder-form__submit');
  if (submitButton !== null) submitButton.disabled = true;

  try {
    const db = getDb();
    if (options.mode === 'add') {
      await createBinderService(db).createManualBinder(input);
    } else {
      // Layout fields are immutable in edit mode; only forward the
      // text-style fields so a future migration can't accidentally
      // change slot count without touching the slots store.
      await createBindersRepo(db).update(options.binder.id, {
        name: input.name,
        binderType: input.binderType,
        description: input.description,
        completionMode: input.completionMode,
      });
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
  options: BinderFormOptions,
): BinderInput {
  const formData = new FormData(form);
  const name = readRequiredString(formData, 'name', 'Navn er påkrevd');
  const binderTypeRaw = readOptionalString(formData, 'binderType');
  const description = readOptionalString(formData, 'description');
  const completionMode = readSelect(
    formData,
    'completionMode',
    COMPLETION_MODES.map((m) => m.value),
  ) as CompletionMode;

  if (options.mode === 'edit') {
    // Reuse the immutable layout fields from the original binder so the
    // resulting `BinderInput` always validates and never changes slot
    // count. The repo .update() call only forwards mutable fields anyway.
    return {
      name,
      binderType: binderTypeRaw,
      description,
      totalPages: options.binder.totalPages,
      slotsPerPage: options.binder.slotsPerPage,
      completionMode,
      sourceSetId: options.binder.sourceSetId,
    };
  }

  const slotsPerPageStr = readSelect(
    formData,
    'slotsPerPage',
    SLOTS_PER_PAGE_OPTIONS.map((o) => o.value),
  );
  const slotsPerPage = slotsPerPageStr === '18' ? 18 : 9;

  const totalPagesRaw = formData.get('totalPages');
  const totalPages =
    typeof totalPagesRaw === 'string'
      ? Number.parseInt(totalPagesRaw, 10)
      : NaN;
  if (!Number.isFinite(totalPages) || totalPages < 1) {
    throw new ValidationError('totalPages', 'må være et heltall ≥ 1');
  }

  return {
    name,
    binderType: binderTypeRaw,
    description,
    totalPages,
    slotsPerPage,
    completionMode,
    sourceSetId: null,
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
  region.classList.add('binder-form__error--visible');
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
