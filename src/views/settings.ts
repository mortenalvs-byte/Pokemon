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
import {
  type DashboardFocusMode,
  type MasterGapDefaultFilter,
  type PersonalStartRoute,
} from '../domain/personal-preferences';
import type { ViewDensity } from '../domain/view-density';
import { createAppMetaRepo } from '../repositories/app-meta-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createSettingsRepo } from '../repositories/settings-repo';
import { createPersonalPreferencesService } from '../services/personal-preferences-service';

// PR 32 — both event names live in `src/domain/events.ts`. Re-exported
// here so existing import paths (`import { SYNC_STATUS_CHANGED_EVENT }
// from './views/settings'`) keep working. Same dispatchers, same
// listeners, same string values — only the source-of-truth file moved.
export {
  SYNC_STATUS_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
} from '../domain/events';
import {
  SYNC_STATUS_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
} from '../domain/events';

// `signal` is accepted for ViewMounter signature parity (PR 15A — F-3).
// Settings registers no window listeners; the signal is unused.
export function mountSettingsView(
  container: HTMLElement,
  _signal?: AbortSignal,
): void {
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
          <!--
            PR 15A - F-1: align with the creatable Vault X / custom
            set from getCreatableSlotsPerPageOptions(). Legacy 18 is
            excluded from new-binder defaults; existing legacy_18
            binders keep their layout via the binder-form edit path,
            which never reads this default.
          -->
          <select data-region="default-slots">
            <option value="4">4</option>
            <option value="9">9</option>
            <option value="12">12</option>
            <option value="16">16</option>
          </select>
        </label>
        <button type="button" class="settings-view__button settings-view__button--primary" data-action="save-defaults">Lagre standardvalg</button>
        <p class="settings-view__feedback" data-region="defaults-feedback" aria-live="polite"></p>
      </section>

      <section class="settings-view__panel" aria-labelledby="personal-heading">
        <h2 id="personal-heading">Personlig app</h2>
        <p class="settings-view__hint">
          Dette er din personlige Pokémon-arbeidsstasjon. Endringer her
          gjelder kun denne maskinen og lagres lokalt i innstillinger.
        </p>
        <label class="settings-view__field">
          <span>App-navn</span>
          <input type="text" data-region="app-display-name" maxlength="60" />
        </label>
        <label class="settings-view__field">
          <span>Startside</span>
          <select data-region="default-start-route">
            <option value="dashboard">Dashboard</option>
            <option value="master-gap">Master gap</option>
            <option value="browse">Browse</option>
            <option value="collection">Min samling</option>
            <option value="binders">Permer</option>
            <option value="lots">Lotter</option>
            <option value="wishlist">Ønskeliste</option>
            <option value="backup">Backup</option>
            <option value="settings">Innstillinger</option>
          </select>
        </label>
        <label class="settings-view__field">
          <span>Dashboard-fokus</span>
          <select data-region="dashboard-focus-mode">
            <option value="balanced">Balansert</option>
            <option value="master_set">Master set</option>
            <option value="binder_work">Permarbeid</option>
            <option value="wishlist">Ønskeliste</option>
            <option value="lots">Lotter</option>
            <option value="collection_health">Samlingshelse</option>
          </select>
        </label>
        <label class="settings-view__field">
          <span>Master gap tetthet</span>
          <select data-region="master-gap-density">
            <option value="compact">Kompakt</option>
            <option value="comfortable">Komfortabel</option>
          </select>
        </label>
        <label class="settings-view__field">
          <span>Master gap standardfilter</span>
          <select data-region="master-gap-default-filter">
            <option value="all">Alle</option>
            <option value="missing">Mangler</option>
            <option value="owned_unplaced">Eier, ikke plassert</option>
            <option value="wishlist">Ønsket / bestilt</option>
            <option value="in_lot">Lot</option>
            <option value="invalid">Feil</option>
          </select>
        </label>
        <label class="settings-view__field settings-view__field--inline">
          <input type="checkbox" data-region="master-gap-hide-complete" />
          <span>Skjul fullførte rader i master gap som standard</span>
        </label>
        <label class="settings-view__field settings-view__field--inline">
          <input type="checkbox" data-region="master-gap-only-actionable" />
          <span>Vis kun rader som krever handling i master gap</span>
        </label>
        <label class="settings-view__field">
          <span>Arbeidskø: maks elementer</span>
          <select data-region="command-center-max-items">
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="8">8</option>
            <option value="10">10</option>
            <option value="12">12</option>
          </select>
        </label>
        <label class="settings-view__field settings-view__field--inline">
          <input type="checkbox" data-region="command-center-show-all-clear" />
          <span>Vis "alt ryddig"-melding når arbeidskøen er tom</span>
        </label>
        <label class="settings-view__field settings-view__field--inline">
          <input type="checkbox" data-region="show-shortcut-hints" />
          <span>Vis Snarveier-knapp i topplinjen</span>
        </label>
        <label class="settings-view__field settings-view__field--inline">
          <input type="checkbox" data-region="show-personal-workspace-summary" />
          <span>Vis personlig arbeidsstasjon-oversikt på dashboard</span>
        </label>
        <button type="button" class="settings-view__button settings-view__button--primary" data-action="save-personal-preferences">Lagre personlig app</button>
        <p class="settings-view__feedback" data-region="personal-preferences-feedback" aria-live="polite"></p>
      </section>

      <section class="settings-view__panel" aria-labelledby="storage-heading">
        <h2 id="storage-heading">Lagring</h2>
        <dl class="settings-view__status" data-region="storage-status"></dl>
      </section>
      ${
        import.meta.env.DEV
          ? `
      <section class="settings-view__panel settings-view__panel--dev" aria-labelledby="developer-qa-heading" data-region="developer-qa">
        <h2 id="developer-qa-heading">Developer QA</h2>
        <p class="settings-view__hint">
          Dev-only. Not included in production builds.
          Brukes til seed, persistence diagnostic, console audit, og max-stress.
          Sidebar-tabben for QA er fjernet (Phase 2 cleanup) — denne knappen og
          tastatur-snarveien <code>g q</code> er de offisielle dev-only
          inngangene til <code>#qa</code>.
        </p>
        <a class="settings-view__button settings-view__button--primary" href="#qa" data-action="open-qa-harness" data-region="developer-qa-link">
          Open QA harness
        </a>
      </section>
      `
          : ''
      }
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

  // PR 27 — personal preferences controls.
  const personalRegions = {
    appDisplayName: container.querySelector<HTMLInputElement>(
      '[data-region="app-display-name"]',
    ),
    defaultStartRoute: container.querySelector<HTMLSelectElement>(
      '[data-region="default-start-route"]',
    ),
    dashboardFocusMode: container.querySelector<HTMLSelectElement>(
      '[data-region="dashboard-focus-mode"]',
    ),
    masterGapDensity: container.querySelector<HTMLSelectElement>(
      '[data-region="master-gap-density"]',
    ),
    masterGapDefaultFilter: container.querySelector<HTMLSelectElement>(
      '[data-region="master-gap-default-filter"]',
    ),
    masterGapHideComplete: container.querySelector<HTMLInputElement>(
      '[data-region="master-gap-hide-complete"]',
    ),
    masterGapOnlyActionable: container.querySelector<HTMLInputElement>(
      '[data-region="master-gap-only-actionable"]',
    ),
    commandCenterMaxItems: container.querySelector<HTMLSelectElement>(
      '[data-region="command-center-max-items"]',
    ),
    commandCenterShowAllClear: container.querySelector<HTMLInputElement>(
      '[data-region="command-center-show-all-clear"]',
    ),
    showShortcutHints: container.querySelector<HTMLInputElement>(
      '[data-region="show-shortcut-hints"]',
    ),
    showPersonalWorkspaceSummary: container.querySelector<HTMLInputElement>(
      '[data-region="show-personal-workspace-summary"]',
    ),
  };
  const savePersonalButton = container.querySelector<HTMLButtonElement>(
    '[data-action="save-personal-preferences"]',
  );
  const personalFeedback = container.querySelector<HTMLElement>(
    '[data-region="personal-preferences-feedback"]',
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
    !storageStatusRegion ||
    !savePersonalButton ||
    !personalFeedback ||
    !personalRegions.appDisplayName ||
    !personalRegions.defaultStartRoute ||
    !personalRegions.dashboardFocusMode ||
    !personalRegions.masterGapDensity ||
    !personalRegions.masterGapDefaultFilter ||
    !personalRegions.masterGapHideComplete ||
    !personalRegions.masterGapOnlyActionable ||
    !personalRegions.commandCenterMaxItems ||
    !personalRegions.commandCenterShowAllClear ||
    !personalRegions.showShortcutHints ||
    !personalRegions.showPersonalWorkspaceSummary
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
  // After the early return above we know every personal region is
  // non-null; narrow into the strict shape `PersonalRegions` expects.
  const narrowedPersonal: PersonalRegions = {
    appDisplayName: personalRegions.appDisplayName,
    defaultStartRoute: personalRegions.defaultStartRoute,
    dashboardFocusMode: personalRegions.dashboardFocusMode,
    masterGapDensity: personalRegions.masterGapDensity,
    masterGapDefaultFilter: personalRegions.masterGapDefaultFilter,
    masterGapHideComplete: personalRegions.masterGapHideComplete,
    masterGapOnlyActionable: personalRegions.masterGapOnlyActionable,
    commandCenterMaxItems: personalRegions.commandCenterMaxItems,
    commandCenterShowAllClear: personalRegions.commandCenterShowAllClear,
    showShortcutHints: personalRegions.showShortcutHints,
    showPersonalWorkspaceSummary: personalRegions.showPersonalWorkspaceSummary,
  };
  void hydratePersonalPreferences(narrowedPersonal);

  savePersonalButton.addEventListener('click', () => {
    void handleSavePersonalPreferences(narrowedPersonal, personalFeedback);
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
    // PR 15A — F-1: accept any creatable size; ignore the legacy 18
    // for new defaults but keep the read tolerant of older values.
    if (
      defaultSlots === 4 ||
      defaultSlots === 9 ||
      defaultSlots === 12 ||
      defaultSlots === 16
    ) {
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
  const isPublicMode = apiKey.length === 0;
  const db = getDb();

  // PR 28 review patch — surface the API mode in the progress line
  // so the user sees whether they're hitting the rate-limited public
  // tier (28 req/min) or the authenticated tier (no client-side
  // pacing). Audited in `db.auditLog` via the orchestrator too.
  const modeLabel = isPublicMode
    ? 'public API mode (no key, ~28 req/min)'
    : 'authenticated';

  // Assigned by syncCardDatabase below; the inner catch returns
  // unconditionally so reads of `result` after the inner try-catch are
  // unreachable when the call fails. Definite-assignment matches the
  // actual control flow and avoids a useless `null` seed.
  let result!: SyncResult;
  try {
    try {
      result = await syncCardDatabase({
        db,
        apiKey: apiKey.length > 0 ? apiKey : null,
        onProgress: (progress) => {
          if (progress.phase === 'sets') {
            refs.syncProgress.textContent = `[${modeLabel}] Henter sett… ${progress.fetched} / ${progress.total}`;
          } else {
            refs.syncProgress.textContent = `[${modeLabel}] Henter kort i ${progress.setId}: ${progress.fetched} / ${progress.total}`;
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
      refs.syncFeedback.textContent = `Synk ferdig (${modeLabel}): ${result.setsCount} sett, ${result.cardsCount} kort.`;
    } else {
      refs.syncFeedback.classList.add('settings-view__feedback--error');
      refs.syncFeedback.textContent = `Synk feilet (${modeLabel}): ${result.error}. Samlingen er trygg.`;
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

// PR 27 — personal preferences hydrate / save.
//
// Hydrate reads the live preferences once at mount time, falling back
// to defaults if the read fails. We do NOT subscribe to live updates
// here — the user is editing the form, and refreshing form values
// from a USER_DATA_CHANGED_EVENT mid-edit would silently drop their
// in-progress changes.

interface PersonalRegions {
  readonly appDisplayName: HTMLInputElement;
  readonly defaultStartRoute: HTMLSelectElement;
  readonly dashboardFocusMode: HTMLSelectElement;
  readonly masterGapDensity: HTMLSelectElement;
  readonly masterGapDefaultFilter: HTMLSelectElement;
  readonly masterGapHideComplete: HTMLInputElement;
  readonly masterGapOnlyActionable: HTMLInputElement;
  readonly commandCenterMaxItems: HTMLSelectElement;
  readonly commandCenterShowAllClear: HTMLInputElement;
  readonly showShortcutHints: HTMLInputElement;
  readonly showPersonalWorkspaceSummary: HTMLInputElement;
}

async function hydratePersonalPreferences(
  regions: PersonalRegions,
): Promise<void> {
  try {
    const svc = createPersonalPreferencesService(createSettingsRepo(getDb()));
    const prefs = await svc.getPreferences();
    regions.appDisplayName.value = prefs.appDisplayName;
    regions.defaultStartRoute.value = prefs.defaultStartRoute;
    regions.dashboardFocusMode.value = prefs.dashboardFocusMode;
    regions.masterGapDensity.value = prefs.masterGapDensity;
    regions.masterGapDefaultFilter.value = prefs.masterGapDefaultFilter;
    regions.masterGapHideComplete.checked = prefs.masterGapHideComplete;
    regions.masterGapOnlyActionable.checked = prefs.masterGapOnlyActionable;
    regions.commandCenterMaxItems.value = String(prefs.commandCenterMaxItems);
    regions.commandCenterShowAllClear.checked = prefs.commandCenterShowAllClear;
    regions.showShortcutHints.checked = prefs.showShortcutHints;
    regions.showPersonalWorkspaceSummary.checked =
      prefs.showPersonalWorkspaceSummary;
  } catch {
    // The form will display its initial fallback values from the
    // markup; we never crash the settings view because the prefs
    // read failed.
  }
}

async function handleSavePersonalPreferences(
  regions: PersonalRegions,
  feedback: HTMLElement,
): Promise<void> {
  feedback.replaceChildren();
  feedback.classList.remove('settings-view__feedback--error');
  try {
    const svc = createPersonalPreferencesService(createSettingsRepo(getDb()));
    await svc.updatePreferences({
      appDisplayName: regions.appDisplayName.value,
      defaultStartRoute: regions.defaultStartRoute.value as PersonalStartRoute,
      dashboardFocusMode:
        regions.dashboardFocusMode.value as DashboardFocusMode,
      masterGapDensity: regions.masterGapDensity.value as ViewDensity,
      masterGapDefaultFilter:
        regions.masterGapDefaultFilter.value as MasterGapDefaultFilter,
      masterGapHideComplete: regions.masterGapHideComplete.checked,
      masterGapOnlyActionable: regions.masterGapOnlyActionable.checked,
      commandCenterMaxItems: Number.parseInt(
        regions.commandCenterMaxItems.value,
        10,
      ),
      commandCenterShowAllClear: regions.commandCenterShowAllClear.checked,
      showShortcutHints: regions.showShortcutHints.checked,
      showPersonalWorkspaceSummary:
        regions.showPersonalWorkspaceSummary.checked,
    });
    feedback.textContent = 'Personlige valg lagret.';
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
  } catch (caught) {
    feedback.classList.add('settings-view__feedback--error');
    feedback.textContent = `Kunne ikke lagre: ${sanitizeErrorMessage(caught)}`;
  }
}
