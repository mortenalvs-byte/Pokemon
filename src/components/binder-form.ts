// Binder add/edit form. Renders inside an `<dialog>` provided by
// `openDialog()`. Create mode goes through `binderService.createManualBinder`
// so the binder + every empty slot land atomically. Edit mode goes through
// `bindersRepo.update` and never touches slots — resizing existing
// binders would need slot migration that is intentionally out of scope.
//
// PR 14 added Vault X presets. The form now shows a "Permtype" picker
// at the top:
//
//   - vaultx_9_360 / vaultx_12_480 / vaultx_12xl_624 / vaultx_16xxl_1088
//     → slotsPerPage + totalPages auto-filled from
//       `binder-presets.ts` and locked (read-only) so a Vault X
//       binder always matches the physical product.
//   - custom → user picks from `4 / 9 / 12 / 16` slots-per-page and
//     enters totalPages freely.
//   - legacy_18 → only used when editing a binder created before PR 14
//     (the v1→v2 migration assigns this to existing 18-slot rows).

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import {
  CREATABLE_SLOTS_PER_PAGE,
  getBinderPresetDefinition,
  getCreatableBinderPresets,
  isLegacyPreset,
  isVaultXPreset,
} from '../domain/binder-presets';
import { ValidationError } from '../domain/validators';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderService } from '../services/binder-service';
import type {
  BinderPreset,
  BinderRecord,
  CompletionMode,
  SlotsPerPage,
} from '../domain/types';
import type { BinderInput } from '../domain/validators';
import type { DialogContent } from './dialog';

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

  // Switching preset re-locks the layout fields and refreshes the
  // capacity hint. Custom unlocks slotsPerPage and totalPages.
  form
    .querySelector<HTMLSelectElement>('[data-region="preset-select"]')
    ?.addEventListener('change', () => applyPresetSelection(form));
  form
    .querySelector<HTMLSelectElement>('[data-region="slots-per-page"]')
    ?.addEventListener('change', () => updateLayoutHint(form));
  form
    .querySelector<HTMLInputElement>('input[name="totalPages"]')
    ?.addEventListener('input', () => updateLayoutHint(form));
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
        <legend>Permtype</legend>
        <label class="binder-form__field">
          <span>Velg layout</span>
          <select name="binderPreset" data-region="preset-select"></select>
        </label>
      </fieldset>

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

  populatePresetSelect(form, options);
  // PR 15A — F-5: only include the legacy 18 option when editing an
  // existing legacy_18 binder. New binders should never offer 18 as a
  // custom layout — `getCreatableSlotsPerPageOptions()` is the single
  // source of truth for selectable sizes.
  const includeLegacy18 =
    options.mode === 'edit' &&
    (options.binder.binderPreset === 'legacy_18' ||
      options.binder.slotsPerPage === 18);
  populateSlotsPerPageSelect(form, includeLegacy18);
  populateSelect(form, 'completionMode', COMPLETION_MODES);

  if (options.mode === 'add') {
    setValue(form, 'name', '');
    setValue(form, 'binderType', '');
    setValue(form, 'description', '');
    setValue(form, 'completionMode', 'standard');
    // Default to Vault X 12-pocket XL — that's the user's most common
    // physical binder for a master set.
    setValue(form, 'binderPreset', 'vaultx_12xl_624');
  } else {
    const b = options.binder;
    setValue(form, 'name', b.name);
    setValue(form, 'binderType', b.binderType ?? '');
    setValue(form, 'description', b.description ?? '');
    setValue(form, 'completionMode', b.completionMode);
    // Resolved preset for the existing binder. Migration ensures
    // every persisted binder has a non-null binderPreset; a backup
    // restored before that migration may still pass null, in which
    // case we fall back to legacy_18 if the row is 18-slots and
    // custom otherwise.
    const resolvedPreset: BinderPreset =
      b.binderPreset ?? (b.slotsPerPage === 18 ? 'legacy_18' : 'custom');
    setValue(form, 'binderPreset', resolvedPreset);
  }

  applyPresetSelection(form);

  if (options.mode === 'edit') {
    const b = options.binder;
    setValue(form, 'slotsPerPage', String(b.slotsPerPage));
    setValue(form, 'totalPages', String(b.totalPages));
    // Layout fields are read-only in edit mode regardless of preset.
    disableField(form, 'binderPreset');
    disableField(form, 'slotsPerPage');
    disableField(form, 'totalPages');
  }

  updateLayoutHint(form);
}

function populatePresetSelect(
  form: HTMLFormElement,
  options: BinderFormOptions,
): void {
  const select = form.querySelector<HTMLSelectElement>(
    '[data-region="preset-select"]',
  );
  if (select === null) return;
  select.replaceChildren();
  for (const def of getCreatableBinderPresets()) {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    select.appendChild(opt);
  }
  // In edit mode, surface the legacy preset so the user sees what
  // their binder is. Add it to the visible options so the select can
  // hold the value without falling back.
  if (
    options.mode === 'edit' &&
    options.binder.binderPreset !== null &&
    isLegacyPreset(options.binder.binderPreset)
  ) {
    const def = getBinderPresetDefinition(options.binder.binderPreset);
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    select.appendChild(opt);
  }
}

function populateSlotsPerPageSelect(
  form: HTMLFormElement,
  includeLegacy18: boolean,
): void {
  // Default offering covers the four values a new binder may use
  // (`getCreatableSlotsPerPageOptions()`). Vault X presets lock the
  // value via `applyPresetSelection`.
  const opts = CREATABLE_SLOTS_PER_PAGE.map((s) => ({
    value: String(s),
    label: `${s} (${describeGrid(s)})`,
  }));
  // PR 15A — F-5: only include the legacy 18 option when editing an
  // existing legacy_18 binder. The form locks the field in that case
  // (via `applyPresetSelection`), so the option is only there to
  // render the locked value, not to be selectable.
  if (includeLegacy18) {
    opts.push({ value: '18', label: '18 (3×3 dobbel — legacy)' });
  }
  populateSelect(form, 'slotsPerPage', opts);
}

function describeGrid(s: SlotsPerPage): string {
  switch (s) {
    case 4:
      return '2×2';
    case 9:
      return '3×3';
    case 12:
      return '3×4';
    case 16:
      return '4×4';
    case 18:
      return '3×3 dobbel';
  }
}

function applyPresetSelection(form: HTMLFormElement): void {
  const presetValue = readValue(form, 'binderPreset') as BinderPreset | '';
  if (presetValue === '' || presetValue === undefined) return;
  const def = getBinderPresetDefinition(presetValue);
  if (isVaultXPreset(presetValue)) {
    // Lock layout to preset.
    setValue(form, 'slotsPerPage', String(def.slotsPerPage));
    setValue(form, 'totalPages', String(def.totalPages));
    disableField(form, 'slotsPerPage');
    disableField(form, 'totalPages');
  } else if (isLegacyPreset(presetValue)) {
    setValue(form, 'slotsPerPage', '18');
    disableField(form, 'slotsPerPage');
    // Legacy total pages are whatever was already there; leave
    // editable when adding (shouldn't happen) and locked in edit.
  } else {
    // custom — unlock unless we're in edit mode (handled by caller).
    enableField(form, 'slotsPerPage');
    enableField(form, 'totalPages');
  }
  updateLayoutHint(form);
}

function updateLayoutHint(form: HTMLFormElement): void {
  const hint = form.querySelector<HTMLElement>('[data-region="layout-hint"]');
  if (hint === null) return;
  const slotsPerPage = readNumberValue(form, 'slotsPerPage');
  const totalPages = readNumberValue(form, 'totalPages');
  if (slotsPerPage === null || totalPages === null) {
    hint.textContent = '';
    return;
  }
  const total = slotsPerPage * totalPages;
  hint.textContent = `${totalPages} sider × ${slotsPerPage} slots = ${total} kort.`;
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

function readValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement ||
    field instanceof HTMLTextAreaElement
  ) {
    return field.value;
  }
  return '';
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

function enableField(form: HTMLFormElement, name: string): void {
  const field = form.elements.namedItem(name);
  if (field === null) return;
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLSelectElement
  ) {
    field.disabled = false;
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
    return {
      name,
      binderType: binderTypeRaw,
      description,
      totalPages: options.binder.totalPages,
      slotsPerPage: options.binder.slotsPerPage,
      binderPreset:
        options.binder.binderPreset ??
        (options.binder.slotsPerPage === 18 ? 'legacy_18' : 'custom'),
      completionMode,
      sourceSetId: options.binder.sourceSetId,
    };
  }

  const presetRaw = readSelect(
    formData,
    'binderPreset',
    getCreatableBinderPresets().map((p) => p.id),
  ) as BinderPreset;
  const def = getBinderPresetDefinition(presetRaw);

  let slotsPerPage: SlotsPerPage;
  let totalPages: number;
  if (isVaultXPreset(presetRaw)) {
    slotsPerPage = def.slotsPerPage;
    totalPages = def.totalPages;
  } else {
    // custom — read user-entered values, validate against creatable set.
    const slotsRaw = readSelect(
      formData,
      'slotsPerPage',
      [
        ...CREATABLE_SLOTS_PER_PAGE.map(String),
      ],
    );
    const parsedSlots = Number.parseInt(slotsRaw, 10);
    if (
      !CREATABLE_SLOTS_PER_PAGE.includes(parsedSlots as SlotsPerPage)
    ) {
      throw new ValidationError(
        'slotsPerPage',
        `må være en av ${CREATABLE_SLOTS_PER_PAGE.join(', ')}`,
      );
    }
    slotsPerPage = parsedSlots as SlotsPerPage;

    const totalPagesRaw = formData.get('totalPages');
    totalPages =
      typeof totalPagesRaw === 'string'
        ? Number.parseInt(totalPagesRaw, 10)
        : Number.NaN;
    if (!Number.isFinite(totalPages) || totalPages < 1) {
      throw new ValidationError('totalPages', 'må være et heltall ≥ 1');
    }
  }

  return {
    name,
    binderType: binderTypeRaw,
    description,
    totalPages,
    slotsPerPage,
    binderPreset: presetRaw,
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
