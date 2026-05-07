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
//     is listed and the user picks one freely.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { formatTags } from '../domain/tags';
import type {
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
} from '../domain/types';
import type { DialogContent } from './dialog';

export interface AssignHoldingModalOptions {
  readonly slot: BinderSlotRecord;
  readonly slotsPerPage: 9 | 18;
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

  const filtered =
    options.slot.targetCardId === null
      ? liveHoldings
      : liveHoldings.filter((h) => h.cardId === options.slot.targetCardId);

  const select = root.querySelector<HTMLSelectElement>(
    '[data-region="holding-select"]',
  );
  const empty = root.querySelector<HTMLElement>('[data-region="empty"]');
  if (select === null || empty === null) return;

  if (filtered.length === 0) {
    select.hidden = true;
    empty.hidden = false;
    empty.textContent =
      options.slot.targetCardId === null
        ? 'Ingen live holdings i samlingen ennå. Legg til en holding først via Browse eller Min samling.'
        : `Ingen live holdings for kortet (${options.slot.targetCardId}). Legg til en holding først.`;
    const submitButton = root.querySelector<HTMLButtonElement>(
      '.assign-holding-modal__submit',
    );
    if (submitButton !== null) submitButton.disabled = true;
  } else {
    select.replaceChildren();
    for (const holding of filtered) {
      const opt = document.createElement('option');
      opt.value = holding.id;
      opt.textContent = describeHolding(holding, cardsById.get(holding.cardId) ?? null);
      select.appendChild(opt);
    }
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
      void handleSubmit(options, root, host, filtered);
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
