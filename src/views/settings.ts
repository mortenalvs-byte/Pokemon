// Minimal but actually-usable Settings view.
//
// Sections:
//   - API: API-key input (password), Save, Test, last status.
//   - Sync: lastSyncAt, sets/cards counts, Sync now, progress, error.
//   - Defaults: preferred currency, default condition, default
//     binder slots per page.
//   - Storage: persistent storage status, schema version.
//
// Settings owns reading/saving the API key through `settingsRepo`.
// The sync orchestrator never reads or writes settings — it receives
// the API key as input. The Settings view is the only surface that
// dispatches `pokemon:sync-completed` so the topbar (and any future
// dashboard) can refresh without a global state framework.
//
// All dynamic content is rendered with `textContent` /
// `createElement`. The API key never appears in error text.

import { createApiClient } from '../api/pokemon-tcg-api';
import { sanitizeErrorMessage } from '../api/sanitize';
import { syncCardDatabase, type SyncResult } from '../db/sync';
import { getDb } from '../db/database';
import {
  APP_META_KEYS,
  SETTINGS_KEYS,
  type CurrencyCode,
  type RawCondition,
} from '../domain/types';
import { createAppMetaRepo } from '../repositories/app-meta-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createSettingsRepo } from '../repositories/settings-repo';

// Dispatched after every sync attempt — both successful and failed.
// Listeners (currently the topbar; later possibly the dashboard) read
// `appMeta.lastSyncAt` and `appMeta.lastSyncStatus` to decide what to
// show. Using one event for both outcomes means the chip never gets
// stuck on a stale "ok" state after a subsequent failure.
export const SYNC_STATUS_CHANGED_EVENT = 'pokemon:sync-status-changed';

export function mountSettingsView(container: HTMLElement): void {
  container.innerHTML = `
    <section class="settings-view" aria-labelledby="settings-heading">
      <h1 id="settings-heading">Innstillinger</h1>

      <section class="settings-view__panel" aria-labelledby="api-heading">
        <h2 id="api-heading">API</h2>
        <p class="settings-view__hint">
          API-nøkkelen for pokemontcg.io lagres lokalt i IndexedDB. Den
          sendes kun i X-Api-Key-headeren, aldri i URL, aldri i logger,
          og ekskluderes fra standard backups.
        </p>
        <label class="settings-view__field">
          <span>API-nøkkel</span>
          <input type="password" autocomplete="off" data-region="api-key-input" />
        </label>
        <button type="button" class="settings-view__button settings-view__button--primary" data-action="save-api-key">Lagre</button>
        <button type="button" class="settings-view__button" data-action="test-api-key">Test tilkobling</button>
        <p class="settings-view__feedback" data-region="api-feedback" aria-live="polite"></p>
      </section>

      <section class="settings-view__panel" aria-labelledby="sync-heading">
        <h2 id="sync-heading">Synk</h2>
        <dl class="settings-view__status" data-region="sync-status"></dl>
        <button type="button" class="settings-view__button settings-view__button--primary" data-action="sync-now">Synk nå</button>
        <p class="settings-view__feedback" data-region="sync-progress" aria-live="polite"></p>
        <p class="settings-view__feedback" data-region="sync-feedback" aria-live="polite"></p>
      </section>

      <section class="settings-view__panel" aria-labelledby="defaults-heading">
        <h2 id="defaults-heading">Standardvalg</h2>
        <label class="settings-view__field">
          <span>Foretrukket valuta</span>
          <select data-region="preferred-currency">
            <option value="NOK">NOK</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="PHP">PHP</option>
          </select>
        </label>
        <label class="settings-view__field">
          <span>Standard tilstand (raw)</span>
          <select data-region="default-condition">
            <option value="NM">NM</option>
            <option value="LP">LP</option>
            <option value="MP">MP</option>
            <option value="HP">HP</option>
            <option value="DMG">DMG</option>
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </label>
        <label class="settings-view__field">
          <span>Slots per perme-side</span>
          <select data-region="default-slots">
            <option value="9">9</option>
            <option value="18">18</option>
          </select>
        </label>
        <button type="button" class="settings-view__button settings-view__button--primary" data-action="save-defaults">Lagre standardvalg</button>
        <p class="settings-view__feedback" data-region="defaults-feedback" aria-live="polite"></p>
      </section>

      <section class="settings-view__panel" aria-labelledby="storage-heading">
        <h2 id="storage-heading">Lagring</h2>
        <dl class="settings-view__status" data-region="storage-status"></dl>
      </section>
    </section>
  `;

  const apiKeyInput = container.querySelector<HTMLInputElement>(
    '[data-region="api-key-input"]',
  );
  const apiFeedback = container.querySelector<HTMLElement>(
    '[data-region="api-feedback"]',
  );
  const saveApiKeyButton = container.querySelector<HTMLButtonElement>(
    '[data-action="save-api-key"]',
  );
  const testApiKeyButton = container.querySelector<HTMLButtonElement>(
    '[data-action="test-api-key"]',
  );

  const syncStatusRegion = container.querySelector<HTMLElement>(
    '[data-region="sync-status"]',
  );
  const syncNowButton = container.querySelector<HTMLButtonElement>(
    '[data-action="sync-now"]',
  );
  const syncProgress = container.querySelector<HTMLElement>(
    '[data-region="sync-progress"]',
  );
  const syncFeedback = container.querySelector<HTMLElement>(
    '[data-region="sync-feedback"]',
  );

  const preferredCurrencySelect = container.querySelector<HTMLSelectElement>(
    '[data-region="preferred-currency"]',
  );
  const defaultConditionSelect = container.querySelector<HTMLSelectElement>(
    '[data-region="default-condition"]',
  );
  const defaultSlotsSelect = container.querySelector<HTMLSelectElement>(
    '[data-region="default-slots"]',
  );
  const saveDefaultsButton = container.querySelector<HTMLButtonElement>(
    '[data-action="save-defaults"]',
  );
  const defaultsFeedback = container.querySelector<HTMLElement>(
    '[data-region="defaults-feedback"]',
  );

  const storageStatusRegion = container.querySelector<HTMLElement>(
    '[data-region="storage-status"]',
  );

  if (
    !apiKeyInput ||
    !apiFeedback ||
    !saveApiKeyButton ||
    !testApiKeyButton ||
    !syncStatusRegion ||
    !syncNowButton ||
    !syncProgress ||
    !syncFeedback ||
    !preferredCurrencySelect ||
    !defaultConditionSelect ||
    !defaultSlotsSelect ||
    !saveDefaultsButton ||
    !defaultsFeedback ||
    !storageStatusRegion
  ) {
    return;
  }

  void hydrateFromDb({
    apiKeyInput,
    syncStatusRegion,
    preferredCurrencySelect,
    defaultConditionSelect,
    defaultSlotsSelect,
    storageStatusRegion,
  });

  saveApiKeyButton.addEventListener('click', () => {
    void handleSaveApiKey(apiKeyInput.value, apiFeedback);
  });

  testApiKeyButton.addEventListener('click', () => {
    void handleTestApiKey(apiKeyInput.value, apiFeedback);
  });

  syncNowButton.addEventListener('click', () => {
    void handleSyncNow({
      apiKeyInput,
      syncFeedback,
      syncProgress,
      syncStatusRegion,
      syncNowButton,
    });
  });

  saveDefaultsButton.addEventListener('click', () => {
    void handleSaveDefaults({
      preferredCurrencySelect,
      defaultConditionSelect,
      defaultSlotsSelect,
      defaultsFeedback,
    });
  });
}

// ---------------------------------------------------------------------
// Hydration

interface HydrateRefs {
  readonly apiKeyInput: HTMLInputElement;
  readonly syncStatusRegion: HTMLElement;
  readonly preferredCurrencySelect: HTMLSelectElement;
  readonly defaultConditionSelect: HTMLSelectElement;
  readonly defaultSlotsSelect: HTMLSelectElement;
  readonly storageStatusRegion: HTMLElement;
}

async function hydrateFromDb(refs: HydrateRefs): Promise<void> {
  const db = getDb();
  const settingsRepo = createSettingsRepo(db);
  const appMetaRepo = createAppMetaRepo(db);
  const setsRepo = createSetsRepo(db);
  const cardsRepo = createCardsRepo(db);

  try {
    const apiKey = await settingsRepo.get<string>(SETTINGS_KEYS.pokemonTcgApiKey);
    if (typeof apiKey === 'string') {
      refs.apiKeyInput.value = apiKey;
    }

    const preferredCurrency = await settingsRepo.get<CurrencyCode>(
      SETTINGS_KEYS.preferredCurrency,
    );
    if (typeof preferredCurrency === 'string') {
      refs.preferredCurrencySelect.value = preferredCurrency;
    }

    const defaultCondition = await settingsRepo.get<RawCondition>(
      SETTINGS_KEYS.defaultCondition,
    );
    if (typeof defaultCondition === 'string') {
      refs.defaultConditionSelect.value = defaultCondition;
    }

    const defaultSlots = await settingsRepo.get<number>(
      SETTINGS_KEYS.defaultBinderSlotsPerPage,
    );
    if (defaultSlots === 9 || defaultSlots === 18) {
      refs.defaultSlotsSelect.value = String(defaultSlots);
    }
  } catch {
    // Settings can't be read — likely a fresh DB. Use the defaults
    // already encoded in the <option selected> attributes.
  }

  await renderSyncStatus(refs.syncStatusRegion, appMetaRepo, setsRepo, cardsRepo);
  await renderStorageStatus(refs.storageStatusRegion, appMetaRepo);
}

interface AppMetaReader {
  get<T>(key: string): Promise<T | undefined>;
}

interface CountReader {
  count(): Promise<number>;
}

async function renderSyncStatus(
  region: HTMLElement,
  appMeta: AppMetaReader,
  setsRepo: CountReader,
  cardsRepo: CountReader,
): Promise<void> {
  region.replaceChildren();

  const lastSyncAt = await appMeta.get<string>(APP_META_KEYS.lastSyncAt);
  const lastSyncStatus = await appMeta.get<string>(APP_META_KEYS.lastSyncStatus);
  const lastSyncError = await appMeta.get<string>(APP_META_KEYS.lastSyncError);
  const setsCount = await setsRepo.count();
  const cardsCount = await cardsRepo.count();

  appendStatusRow(region, 'Forrige synk', lastSyncAt ?? 'Aldri synket');
  appendStatusRow(
    region,
    'Status',
    lastSyncStatus === 'failed'
      ? 'Sist forsøk feilet'
      : lastSyncStatus === 'ok'
        ? 'OK'
        : 'Ingen status',
  );
  if (typeof lastSyncError === 'string' && lastSyncError.length > 0) {
    appendStatusRow(region, 'Siste feil', lastSyncError);
  }
  appendStatusRow(region, 'Sett i cache', String(setsCount));
  appendStatusRow(region, 'Kort i cache', String(cardsCount));
}

async function renderStorageStatus(
  region: HTMLElement,
  appMeta: AppMetaReader,
): Promise<void> {
  region.replaceChildren();
  const persistent = await appMeta.get<boolean>(
    APP_META_KEYS.persistentStorageGranted,
  );
  const schemaVersion = await appMeta.get<number>(APP_META_KEYS.schemaVersion);
  appendStatusRow(
    region,
    'Persistent storage',
    persistent === true ? 'Innvilget' : 'Ikke innvilget',
  );
  appendStatusRow(
    region,
    'Schema-versjon',
    typeof schemaVersion === 'number' ? String(schemaVersion) : '–',
  );
}

function appendStatusRow(
  region: HTMLElement,
  label: string,
  value: string,
): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  region.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  region.appendChild(dd);
}

// ---------------------------------------------------------------------
// API key handlers

async function handleSaveApiKey(
  rawValue: string,
  feedback: HTMLElement,
): Promise<void> {
  feedback.replaceChildren();
  feedback.classList.remove('settings-view__feedback--error');
  const value = rawValue.trim();
  try {
    const repo = createSettingsRepo(getDb());
    await repo.set(SETTINGS_KEYS.pokemonTcgApiKey, value);
    feedback.textContent =
      value.length === 0
        ? 'API-nøkkel slettet (lagret som tom).'
        : 'API-nøkkel lagret.';
  } catch (caught) {
    feedback.classList.add('settings-view__feedback--error');
    feedback.textContent = `Kunne ikke lagre: ${sanitizeErrorMessage(caught, value)}`;
  }
}

async function handleTestApiKey(
  rawValue: string,
  feedback: HTMLElement,
): Promise<void> {
  feedback.replaceChildren();
  feedback.classList.remove('settings-view__feedback--error');
  const value = rawValue.trim();
  feedback.textContent = 'Tester tilkobling…';
  try {
    const apiClient = createApiClient(
      value.length > 0 ? { apiKey: value } : {},
    );
    const ok = await apiClient.testConnection();
    if (ok) {
      feedback.textContent =
        'Tilkobling OK. Ferdig å teste — husk å lagre nøkkelen før synk.';
    } else {
      feedback.classList.add('settings-view__feedback--error');
      feedback.textContent =
        'Tilkobling feilet. Sjekk at nøkkelen er riktig og at du er online. Samlingen er trygg.';
    }
  } catch (caught) {
    feedback.classList.add('settings-view__feedback--error');
    feedback.textContent = `Tilkobling feilet: ${sanitizeErrorMessage(caught, value)}. Samlingen er trygg.`;
  }
}

// ---------------------------------------------------------------------
// Sync handler

interface SyncRefs {
  readonly apiKeyInput: HTMLInputElement;
  readonly syncFeedback: HTMLElement;
  readonly syncProgress: HTMLElement;
  readonly syncStatusRegion: HTMLElement;
  readonly syncNowButton: HTMLButtonElement;
}

async function handleSyncNow(refs: SyncRefs): Promise<void> {
  refs.syncFeedback.replaceChildren();
  refs.syncFeedback.classList.remove('settings-view__feedback--error');
  refs.syncProgress.replaceChildren();
  refs.syncNowButton.disabled = true;

  const apiKey = refs.apiKeyInput.value.trim();
  const db = getDb();

  let result: SyncResult | null = null;
  try {
    try {
      result = await syncCardDatabase({
        db,
        apiKey: apiKey.length > 0 ? apiKey : null,
        onProgress: (progress) => {
          if (progress.phase === 'sets') {
            refs.syncProgress.textContent = `Henter sett… ${progress.fetched} / ${progress.total}`;
          } else {
            refs.syncProgress.textContent = `Henter kort i ${progress.setId}: ${progress.fetched} / ${progress.total}`;
          }
        },
      });
    } catch (caught) {
      // syncCardDatabase is supposed to swallow errors and return a
      // SyncFailure, but be defensive: if the orchestrator itself
      // throws (e.g. a Dexie failure that escapes its own catch),
      // record it locally and let the finally block notify listeners.
      refs.syncFeedback.classList.add('settings-view__feedback--error');
      refs.syncFeedback.textContent = `Synk feilet: ${sanitizeErrorMessage(caught, apiKey)}. Samlingen er trygg.`;
      return;
    }

    if (result.ok) {
      refs.syncFeedback.textContent = `Synk ferdig: ${result.setsCount} sett, ${result.cardsCount} kort.`;
    } else {
      refs.syncFeedback.classList.add('settings-view__feedback--error');
      refs.syncFeedback.textContent = `Synk feilet: ${result.error}. Samlingen er trygg.`;
    }

    await renderSyncStatus(
      refs.syncStatusRegion,
      createAppMetaRepo(db),
      createSetsRepo(db),
      createCardsRepo(db),
    );
  } finally {
    // Always clear the progress line and notify listeners — the
    // topbar (and any future listener) needs to refresh the chip
    // whether the sync succeeded or failed.
    refs.syncProgress.replaceChildren();
    refs.syncNowButton.disabled = false;
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_CHANGED_EVENT));
  }
}

// ---------------------------------------------------------------------
// Defaults handler

interface DefaultsRefs {
  readonly preferredCurrencySelect: HTMLSelectElement;
  readonly defaultConditionSelect: HTMLSelectElement;
  readonly defaultSlotsSelect: HTMLSelectElement;
  readonly defaultsFeedback: HTMLElement;
}

async function handleSaveDefaults(refs: DefaultsRefs): Promise<void> {
  refs.defaultsFeedback.replaceChildren();
  refs.defaultsFeedback.classList.remove('settings-view__feedback--error');
  try {
    const repo = createSettingsRepo(getDb());
    await repo.set(
      SETTINGS_KEYS.preferredCurrency,
      refs.preferredCurrencySelect.value,
    );
    await repo.set(
      SETTINGS_KEYS.defaultCondition,
      refs.defaultConditionSelect.value,
    );
    await repo.set(
      SETTINGS_KEYS.defaultBinderSlotsPerPage,
      Number.parseInt(refs.defaultSlotsSelect.value, 10),
    );
    refs.defaultsFeedback.textContent = 'Standardvalg lagret.';
  } catch (caught) {
    refs.defaultsFeedback.classList.add('settings-view__feedback--error');
    refs.defaultsFeedback.textContent = `Kunne ikke lagre: ${sanitizeErrorMessage(caught)}`;
  }
}
