// Minimal but actually-usable Backup view.
//
// The view holds the only browser-side surface for backup/restore in
// PR 4. It calls the pure data-layer functions, drives the file picker,
// shows a small preview before a destructive replace-restore, and
// hands the resulting JSON to `downloadTextFile()` for the user.
//
// Dynamic content (record counts, lastBackupAt, error and warning
// messages, validation feedback) is rendered with `textContent` and
// `createElement` rather than interpolated into innerHTML. The static
// scaffolding is HTML for readability — none of it ever incorporates
// untrusted input.

import { APP_META_KEYS } from '../domain/types';
import { getDb } from '../db/database';
import {
  exportToBackupFile,
  serializeBackupToJson,
} from '../db/backup';
import {
  PreRestoreBackupFailedError,
  parseBackupJson,
  replaceRestore,
  validateBackup,
  type ValidationResult,
} from '../db/restore';
import {
  tryPreRestoreAutoBackup,
  type AutoBackupResult,
} from '../db/auto-backup';
import { downloadTextFile } from '../utils/download';

const BACKUP_AGE_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

// `signal` is accepted for ViewMounter signature parity (PR 15A — F-3).
// The backup view registers no window listeners, only DOM-element
// handlers that disappear with the cleared innerHTML, so the signal is
// unused here.
export function mountBackupView(
  container: HTMLElement,
  _signal?: AbortSignal,
): void {
  container.innerHTML = `
    <section class="backup-view" aria-labelledby="backup-heading">
      <h1 id="backup-heading">Backup</h1>
      <p class="backup-view__intro">
        Eksport og restore av hele databasen som JSON. Brukerdata
        (holdings, binders, lots, wishlist, audit log) er alltid med.
        API-nøkkelen for pokemontcg.io er aldri med i en standard backup.
      </p>

      <div class="backup-view__sections">
        <section class="backup-view__panel" aria-labelledby="backup-status-heading">
          <h2 id="backup-status-heading">Status</h2>
          <dl class="backup-view__status" data-region="status"></dl>
        </section>

        <section class="backup-view__panel" aria-labelledby="backup-export-heading">
          <h2 id="backup-export-heading">Eksporter backup</h2>
          <p class="backup-view__hint">
            Lager en fullstendig JSON-fil av databasen og laster den ned
            til denne maskinen. API-nøkkelen ekskluderes.
          </p>
          <button type="button" class="backup-view__button backup-view__button--primary" data-action="export">
            Eksporter full backup
          </button>
          <p class="backup-view__feedback" data-region="export-feedback" aria-live="polite"></p>
        </section>

        <section class="backup-view__panel" aria-labelledby="backup-restore-heading">
          <h2 id="backup-restore-heading">Restore fra fil</h2>
          <p class="backup-view__hint">
            Erstatter all lokal data med innholdet fra backup-filen.
            Appen lager en pre-restore-kopi av nåværende database først.
          </p>
          <input type="file" accept="application/json,.json" data-region="file-input" aria-label="Velg backup-fil" />
          <div class="backup-view__preview" data-region="preview"></div>
          <button type="button" class="backup-view__button backup-view__button--danger" data-action="confirm-restore" disabled>
            Erstatt database
          </button>
          <button type="button" class="backup-view__button" data-action="merge-restore" disabled title="Merge restore is planned for a later release">
            Merge restore (kommer senere)
          </button>
          <p class="backup-view__feedback" data-region="restore-feedback" aria-live="polite"></p>
        </section>
      </div>
    </section>
  `;

  const statusRegion = container.querySelector<HTMLElement>('[data-region="status"]');
  const fileInput = container.querySelector<HTMLInputElement>('[data-region="file-input"]');
  const previewRegion = container.querySelector<HTMLElement>('[data-region="preview"]');
  const confirmButton = container.querySelector<HTMLButtonElement>(
    '[data-action="confirm-restore"]',
  );
  const exportButton = container.querySelector<HTMLButtonElement>(
    '[data-action="export"]',
  );
  const exportFeedback = container.querySelector<HTMLElement>(
    '[data-region="export-feedback"]',
  );
  const restoreFeedback = container.querySelector<HTMLElement>(
    '[data-region="restore-feedback"]',
  );

  if (
    !statusRegion ||
    !fileInput ||
    !previewRegion ||
    !confirmButton ||
    !exportButton ||
    !exportFeedback ||
    !restoreFeedback
  ) {
    return;
  }

  void renderStatus(statusRegion);

  let pendingValidation: ValidationResult | null = null;

  exportButton.addEventListener('click', () => {
    void handleExport(exportFeedback, statusRegion);
  });

  fileInput.addEventListener('change', () => {
    void handleFileSelected(
      fileInput,
      previewRegion,
      confirmButton,
      restoreFeedback,
      (result) => {
        pendingValidation = result;
      },
    );
  });

  confirmButton.addEventListener('click', () => {
    if (pendingValidation === null || !pendingValidation.ok) {
      return;
    }
    void handleConfirmRestore(
      pendingValidation,
      restoreFeedback,
      statusRegion,
      () => {
        pendingValidation = null;
        fileInput.value = '';
        previewRegion.replaceChildren();
        confirmButton.disabled = true;
      },
    );
  });
}

// ---------------------------------------------------------------------
// Status

async function renderStatus(region: HTMLElement): Promise<void> {
  const db = getDb();
  region.replaceChildren();

  let lastBackupAt: string | null = null;
  let lastBackupHoldingCount: number | null = null;
  let persistentStorageGranted = false;
  try {
    const backupRow = await db.appMeta.get(APP_META_KEYS.lastBackupAt);
    const countRow = await db.appMeta.get(APP_META_KEYS.lastBackupHoldingCount);
    const persistRow = await db.appMeta.get(
      APP_META_KEYS.persistentStorageGranted,
    );
    if (typeof backupRow?.value === 'string') {
      lastBackupAt = backupRow.value;
    }
    if (typeof countRow?.value === 'number') {
      lastBackupHoldingCount = countRow.value;
    }
    if (typeof persistRow?.value === 'boolean') {
      persistentStorageGranted = persistRow.value;
    }
  } catch {
    appendStatusRow(region, 'Database', 'Ikke tilgjengelig');
    return;
  }

  appendStatusRow(
    region,
    'Forrige backup',
    lastBackupAt ?? 'Ingen backup tatt',
    backupAgeChip(lastBackupAt),
  );
  if (lastBackupHoldingCount !== null) {
    appendStatusRow(
      region,
      'Holdings ved forrige backup',
      String(lastBackupHoldingCount),
    );
  }
  appendStatusRow(
    region,
    'Persistent storage',
    persistentStorageGranted ? 'Innvilget' : 'Ikke innvilget',
    persistentStorageGranted ? null : chip('storage_not_persistent', 'warning'),
  );
}

function appendStatusRow(
  region: HTMLElement,
  label: string,
  value: string,
  trailingChip: HTMLElement | null = null,
): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  region.appendChild(dt);

  const dd = document.createElement('dd');
  dd.textContent = value;
  if (trailingChip !== null) {
    dd.appendChild(document.createTextNode(' '));
    dd.appendChild(trailingChip);
  }
  region.appendChild(dd);
}

function backupAgeChip(lastBackupAt: string | null): HTMLElement | null {
  if (lastBackupAt === null) {
    return chip('backup_old', 'warning');
  }
  const parsed = Date.parse(lastBackupAt);
  if (!Number.isFinite(parsed)) {
    return chip('backup_old', 'warning');
  }
  const ageMs = Date.now() - parsed;
  if (ageMs > BACKUP_AGE_WARNING_MS) {
    return chip('backup_old', 'warning');
  }
  return null;
}

function chip(text: string, severity: 'warning' | 'danger' | 'info'): HTMLElement {
  const span = document.createElement('span');
  span.className = `status-chip status-chip--${severity}`;
  span.textContent = text;
  return span;
}

// ---------------------------------------------------------------------
// Export handler

async function handleExport(
  feedbackRegion: HTMLElement,
  statusRegion: HTMLElement,
): Promise<void> {
  feedbackRegion.replaceChildren();
  feedbackRegion.classList.remove('backup-view__feedback--error');

  try {
    const db = getDb();
    const result = await exportToBackupFile(db);
    downloadTextFile(result.filename, result.json);
    feedbackRegion.textContent = `Eksport ferdig: ${result.filename}`;
    await renderStatus(statusRegion);
  } catch (caught) {
    feedbackRegion.classList.add('backup-view__feedback--error');
    feedbackRegion.textContent = `Eksport feilet: ${describeError(caught)}`;
  }
}

// ---------------------------------------------------------------------
// File-selection handler (parse + validate + preview)

async function handleFileSelected(
  fileInput: HTMLInputElement,
  previewRegion: HTMLElement,
  confirmButton: HTMLButtonElement,
  feedbackRegion: HTMLElement,
  onValidation: (result: ValidationResult) => void,
): Promise<void> {
  feedbackRegion.replaceChildren();
  feedbackRegion.classList.remove('backup-view__feedback--error');
  previewRegion.replaceChildren();
  confirmButton.disabled = true;

  const file = fileInput.files?.[0] ?? null;
  if (file === null) {
    return;
  }

  let text: string;
  try {
    text = await file.text();
  } catch (caught) {
    feedbackRegion.classList.add('backup-view__feedback--error');
    feedbackRegion.textContent = `Kunne ikke lese filen: ${describeError(caught)}`;
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseBackupJson(text);
  } catch (caught) {
    feedbackRegion.classList.add('backup-view__feedback--error');
    feedbackRegion.textContent = `Ugyldig JSON: ${describeError(caught)}`;
    return;
  }

  const validation = validateBackup(parsed);
  onValidation(validation);

  if (!validation.ok) {
    feedbackRegion.classList.add('backup-view__feedback--error');
    feedbackRegion.textContent = 'Filen er ikke en gyldig backup. Restore er blokkert.';
    renderErrorList(previewRegion, validation.errors, validation.warnings);
    return;
  }

  renderPreview(previewRegion, validation, file.name);
  confirmButton.disabled = false;
  feedbackRegion.textContent =
    'Forhåndsvisning vises. Bekreft for å erstatte databasen.';
}

function renderPreview(
  region: HTMLElement,
  validation: ValidationResult & { ok: true },
  fileName: string,
): void {
  region.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = 'Forhåndsvisning';
  region.appendChild(heading);

  const meta = document.createElement('dl');
  appendStatusRow(meta, 'Filnavn', fileName);
  appendStatusRow(meta, 'Eksportert', validation.backup.exportedAt);
  appendStatusRow(meta, 'Schema-versjon', String(validation.backup.schemaVersion));
  region.appendChild(meta);

  const counts = document.createElement('dl');
  const stores: ReadonlyArray<readonly [string, number]> = [
    ['Cards', validation.backup.cards.length],
    ['Holdings', validation.backup.holdings.length],
    ['Binders', validation.backup.binders.length],
    ['Binder-slots', validation.backup.binderSlots.length],
    ['Lots', validation.backup.lots.length],
    ['Lot-items', validation.backup.lotItems.length],
    ['Wishlist', validation.backup.wishlist.length],
    ['Audit log', validation.backup.auditLog.length],
  ];
  for (const [label, count] of stores) {
    appendStatusRow(counts, label, String(count));
  }
  region.appendChild(counts);

  if (validation.warnings.length > 0) {
    const warningsHeading = document.createElement('h4');
    warningsHeading.textContent = `Advarsler (${validation.warnings.length})`;
    region.appendChild(warningsHeading);
    region.appendChild(buildList(validation.warnings));
  }

  const danger = document.createElement('p');
  danger.className = 'backup-view__danger';
  danger.textContent =
    'Restore vil erstatte hele lokal database. Appen lager en pre-restore-kopi først.';
  region.appendChild(danger);
}

function renderErrorList(
  region: HTMLElement,
  errors: readonly string[],
  warnings: readonly string[],
): void {
  region.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `Validering feilet (${errors.length})`;
  region.appendChild(heading);
  region.appendChild(buildList(errors));

  if (warnings.length > 0) {
    const warningsHeading = document.createElement('h4');
    warningsHeading.textContent = `Advarsler (${warnings.length})`;
    region.appendChild(warningsHeading);
    region.appendChild(buildList(warnings));
  }
}

function buildList(items: readonly string[]): HTMLUListElement {
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  return list;
}

// ---------------------------------------------------------------------
// Confirm-restore handler

async function handleConfirmRestore(
  validation: ValidationResult & { ok: true },
  feedbackRegion: HTMLElement,
  statusRegion: HTMLElement,
  onSuccess: () => void,
): Promise<void> {
  feedbackRegion.replaceChildren();
  feedbackRegion.classList.remove('backup-view__feedback--error');

  const confirmed = window.confirm(
    'Restore vil erstatte hele lokal database.\n\n' +
      'Appen prøver å eksportere en pre-restore-kopi først. ' +
      'Trykk OK for å fortsette, Avbryt for å la databasen være i fred.',
  );
  if (!confirmed) {
    feedbackRegion.textContent = 'Restore avbrutt.';
    return;
  }

  const db = getDb();
  let preRestoreBackup: AutoBackupResult;
  try {
    preRestoreBackup = await tryPreRestoreAutoBackup(db);
  } catch (caught) {
    // tryPreRestoreAutoBackup is supposed to swallow errors, but be
    // defensive so the view never throws a surprise exception.
    preRestoreBackup = {
      ok: false,
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  }

  if (preRestoreBackup.ok) {
    downloadTextFile(preRestoreBackup.filename, preRestoreBackup.json);
  } else {
    const proceed = window.confirm(
      'Pre-restore-kopi feilet:\n' +
        preRestoreBackup.error.message +
        '\n\n' +
        'Trykk OK for å gjennomføre restore uten sikkerhetsnett. ' +
        'Trykk Avbryt for å stoppe.',
    );
    if (!proceed) {
      feedbackRegion.textContent =
        'Restore avbrutt fordi pre-restore-kopien feilet.';
      return;
    }
  }

  try {
    await replaceRestore(db, validation.backup, {
      preRestoreBackup,
      confirmedWithoutPreBackup: !preRestoreBackup.ok,
    });
    feedbackRegion.textContent = 'Restore ferdig. Databasen er erstattet.';
    onSuccess();
    await renderStatus(statusRegion);
  } catch (caught) {
    feedbackRegion.classList.add('backup-view__feedback--error');
    if (caught instanceof PreRestoreBackupFailedError) {
      feedbackRegion.textContent =
        'Restore stoppet: pre-restore-kopi feilet og bruker bekreftet ikke å fortsette uten.';
    } else {
      feedbackRegion.textContent = `Restore feilet: ${describeError(caught)}`;
    }
  }
}

// ---------------------------------------------------------------------
// Helpers

function describeError(caught: unknown): string {
  if (caught instanceof Error) {
    return caught.message;
  }
  return String(caught);
}

// Helper exposed only for tests so they can drive the same parse +
// validate + replace flow without driving a real <input type="file">.
export const __backupViewInternals = {
  serializeBackupToJson,
  parseBackupJson,
  validateBackup,
  replaceRestore,
};
