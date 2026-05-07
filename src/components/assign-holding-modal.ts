// Assign-holding modal. Lets the user pick a live holding and assign it
// to a binder slot. The save sets `holdingId`, sets `status` to `owned`
// (the only path to `owned` in PR 8a per the binder semantics) and — for
// blank manual slots — back-fills `targetCardId` so the completion math
// has a well-defined denominator.
//
// Filter rule:
//   - If the slot has `targetCardId` set (from-set template or already
//     bound to a card), only holdings for that card are listed.
//   - If `targetCardId` is null (blank manual slot), every live holding
//     is listed and the user picks one freely. PR 17 adds a free-text
//     search input on top of the picker for that case so 600+ holdings
//     stay manageable; the input uses `cardMatchesQuery` so the same
//     search rules apply as in Browse / Collection / Wishlist.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { cardMatchesQuery, isEmptyQuery } from '../domain/card-search';
import { ValidationError } from '../domain/validators';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { formatTags } from '../domain/tags';
import type {
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  SetRecord,
  SlotsPerPage,
} from '../domain/types';
import type { DialogContent } from './dialog';

export interface AssignHoldingModalOptions {
  readonly slot: BinderSlotRecord;
  readonly slotsPerPage: SlotsPerPage;
}

export function buildAssignHoldingModal(
  options: AssignHoldingModalOptions,
): DialogContent {
  return {
    mount(host, close) {
      void mount(options, host, close);
    },
  };
}

async function mount(
  options: AssignHoldingModalOptions,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  host.appendChild(buildSkeleton(options));
  const root = host.querySelector<HTMLElement>('.assign-holding-modal');
  if (root === null) return;

  const db = getDb();
  const liveHoldings = await createHoldingsRepo(db).listLive();
  const cardsRepo = createCardsRepo(db);
  const cards = await cardsRepo.list();
  const cardsById = new Map<string, CardRecord>();
  for (const c of cards) cardsById.set(c.id, c);
  // PR 17 — load sets for the cardMatchesQuery set-name path.
  const sets = await createSetsRepo(db).list();
  const setsById = new Map<string, SetRecord>();
  for (const s of sets) setsById.set(s.id, s);

  const candidateHoldings: readonly HoldingRecord[] =
    options.slot.targetCardId === null
      ? liveHoldings
      : liveHoldings.filter((h) => h.cardId === options.slot.targetCardId);

  const select = root.querySelector<HTMLSelectElement>(
    '[data-region="holding-select"]',
  );
  const empty = root.querySelector<HTMLElement>('[data-region="empty"]');
  const searchWrap = root.querySelector<HTMLElement>(
    '[data-region="search-wrap"]',
  );
  const searchInput = root.querySelector<HTMLInputElement>(
    '[data-region="search-input"]',
  );
  const resultCount = root.querySelector<HTMLElement>(
    '[data-region="result-count"]',
  );
  const submitButton = root.querySelector<HTMLButtonElement>(
    '.assign-holding-modal__submit',
  );
  if (select === null || empty === null) return;

  // PR 17 — show the search field only when the slot is target-free.
  // Target slots already filter to one card, so a search input there
  // is just clutter.
  if (options.slot.targetCardId === null && searchWrap !== null) {
    searchWrap.hidden = false;
  }

  // Render holdings into the select; called whenever the search
  // changes. Re-runs the filter and updates the empty state.
  const renderHoldings = (query: string): void => {
    const matched = isEmptyQuery(query)
      ? candidateHoldings
      : candidateHoldings.filter((h) => {
          const card = cardsById.get(h.cardId);
          if (card === undefined) return false;
          return cardMatchesQuery(card, query, { setsById });
        });

    if (matched.length === 0) {
      select.hidden = true;
      empty.hidden = false;
      if (candidateHoldings.length === 0) {
        empty.textContent =
          options.slot.targetCardId === null
            ? 'Ingen live holdings i samlingen ennå. Legg til en holding først via Browse eller Min samling.'
            : `Ingen live holdings for kortet (${options.slot.targetCardId}). Legg til en holding først.`;
      } else {
        empty.textContent = `Ingen holdings matcher "${query}".`;
      }
      if (submitButton !== null) submitButton.disabled = true;
    } else {
      select.hidden = false;
      empty.hidden = true;
      if (submitButton !== null) submitButton.disabled = false;
      select.replaceChildren();
      for (const holding of matched) {
        const opt = document.createElement('option');
        opt.value = holding.id;
        opt.textContent = describeHolding(
          holding,
          cardsById.get(holding.cardId) ?? null,
        );
        select.appendChild(opt);
      }
    }

    if (resultCount !== null) {
      const total = candidateHoldings.length;
      resultCount.textContent =
        isEmptyQuery(query) || matched.length === total
          ? `${total} ${total === 1 ? 'holding' : 'holdings'}`
          : `${matched.length} av ${total} match`;
    }
  };

  renderHoldings('');

  if (searchInput !== null) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        renderHoldings(searchInput.value);
      }, 150);
    });
  }

  root
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

  // `root` IS the <form> (its class is `assign-holding-modal`); attach
  // the submit handler directly to it instead of querying for a nested
  // form that does not exist.
  if (root instanceof HTMLFormElement) {
    root.addEventListener('submit', (event) => {
      event.preventDefault();
      void handleSubmit(options, root, host, candidateHoldings);
    });
  }
}

function buildSkeleton(options: AssignHoldingModalOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'assign-holding-modal-wrap';
  const targetText =
    options.slot.targetCardId !== null
      ? `Mål: ${options.slot.targetCardId}`
      : 'Mål: ingen (åpen slot)';
  wrap.innerHTML = `
    <form class="assign-holding-modal" novalidate>
      <header class="assign-holding-modal__header">
        <h2>Tilordne holding til slot</h2>
        <p>Side ${options.slot.pageNumber} · slot ${options.slot.slotNumber} · ${escapeHtml(
          targetText,
        )}</p>
      </header>

      <label class="assign-holding-modal__field" data-region="search-wrap" hidden>
        <span>Søk i samlingen</span>
        <input
          type="search"
          data-region="search-input"
          autocomplete="off"
          placeholder="Kortnavn, kort-id, nummer…"
        />
        <small class="assign-holding-modal__hint" data-region="result-count" aria-live="polite"></small>
      </label>

      <label class="assign-holding-modal__field">
        <span>Velg holding</span>
        <select data-region="holding-select" name="holdingId" required></select>
      </label>
      <p class="assign-holding-modal__empty" data-region="empty" hidden></p>

      <p class="assign-holding-modal__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="assign-holding-modal__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="assign-holding-modal__submit">Tilordne</button>
      </footer>
    </form>
  `;
  return wrap;
}

function describeHolding(
  holding: HoldingRecord,
  card: CardRecord | null,
): string {
  const cardName = card !== null ? `${card.name} (${holding.cardId})` : holding.cardId;
  const condition =
    holding.conditionType === 'graded'
      ? `${holding.gradingCompany ?? '?'} ${
          holding.grade !== null ? holding.grade.toFixed(1) : '?'
        }`
      : (holding.rawCondition ?? '–');
  const tags = holding.tags.length > 0 ? ` · ${formatTags(holding.tags)}` : '';
  return `${cardName} · ${holding.finish} · ${condition} × ${holding.quantity}${tags}`;
}

async function handleSubmit(
  options: AssignHoldingModalOptions,
  root: HTMLElement,
  host: HTMLElement,
  candidates: readonly HoldingRecord[],
): Promise<void> {
  const errorRegion = root.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';

  const select = root.querySelector<HTMLSelectElement>(
    '[data-region="holding-select"]',
  );
  if (select === null) return;
  const holdingId = select.value;
  const holding = candidates.find((h) => h.id === holdingId);
  if (holding === undefined) {
    if (errorRegion !== null) {
      errorRegion.textContent = 'Velg en holding å tilordne.';
    }
    return;
  }

  const submit = root.querySelector<HTMLButtonElement>(
    '.assign-holding-modal__submit',
  );
  if (submit !== null) submit.disabled = true;

  try {
    const repo = createBinderSlotsRepo(getDb());
    await repo.update(
      options.slot.id,
      {
        holdingId: holding.id,
        // Backfill targetCardId for blank manual slots so the completion
        // denominator is well-defined and the slot gains a stable
        // identity going forward.
        targetCardId: options.slot.targetCardId ?? holding.cardId,
        status: 'owned',
      },
      options.slotsPerPage,
    );
  } catch (caught) {
    if (submit !== null) submit.disabled = false;
    if (errorRegion !== null) {
      errorRegion.textContent = describeError(caught);
    }
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function describeError(caught: unknown): string {
  if (caught instanceof ValidationError) {
    return `Feil: ${caught.message}`;
  }
  if (caught instanceof Error) {
    return `Tilordning feilet: ${caught.message}`;
  }
  return 'Tilordning feilet av en ukjent grunn.';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
