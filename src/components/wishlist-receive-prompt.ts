// PR 22 — receive-prompt dialog. Single component used by both the
// "single create" path (full holding form, Quick Add, single-card
// flows on Card Detail) and the "grouped" path (Bulk Add, Lot
// Materialise summaries) to ask the user "skal disse wishlist-
// oppføringene markeres som mottatt?" with checkboxes per row.
//
// UX rules (KRAVSPEC PR 22):
//   - Exact matches default-checked.
//   - condition_mismatch matches default-UNchecked (user must opt in).
//   - "Marker som mottatt" only flips the checked rows.
//   - "Ikke nå" leaves wishlist + holdings untouched.
//   - All writes go through `markWishlistCandidatesReceived` which
//     uses `wishlistRepo.update`, so audit + validators are preserved.
//
// Dispatches `USER_DATA_CHANGED_EVENT` on success so other mounted
// views (Card Detail, Wishlist, Dashboard) refresh once.
//
// The dialog is async — callers `await openWishlistReceivePrompt(...)`
// and get back the list of wishlist ids that were marked received
// (empty array if the user picked "Ikke nå" or had no candidates).

import { DIALOG_SUBMITTED_EVENT, openDialog } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import {
  markWishlistCandidatesReceived,
  type WishlistReceiveCandidate,
} from '../services/wishlist-receive-service';
import { wishlistStatusLabel } from '../domain/wishlist-status';
import type { CardRecord, WishlistPriority } from '../domain/types';

const PRIORITY_LABELS: Record<WishlistPriority, string> = {
  grail: 'Grail',
  high: 'Høy',
  medium: 'Medium',
  low: 'Lav',
};

export interface OpenWishlistReceivePromptOptions {
  readonly candidates: readonly WishlistReceiveCandidate[];
  /**
   * Optional context label rendered above the list ("Lagt til i
   * samling: …", "Materialiserte 12 kort fra lott …").
   */
  readonly heading?: string;
}

/**
 * Opens the receive prompt dialog. Resolves with the wishlist ids that
 * were actually flipped to `received`. Callers do NOT need to dispatch
 * `USER_DATA_CHANGED_EVENT` themselves — the dialog does it on success.
 */
export async function openWishlistReceivePrompt(
  options: OpenWishlistReceivePromptOptions,
): Promise<string[]> {
  if (options.candidates.length === 0) return [];

  // Pre-resolve cards so the dialog can render names without a re-flow.
  const cardIds = Array.from(
    new Set(options.candidates.map((c) => c.wishlist.cardId)),
  );
  const cardsRepo = createCardsRepo(getDb());
  const cardsById = new Map<string, CardRecord>();
  for (const id of cardIds) {
    const card = await cardsRepo.get(id);
    if (card !== undefined) cardsById.set(id, card);
  }

  // Captured by the submit handler's closure; returned to the caller
  // after the dialog closes.
  const receivedIds: string[] = [];

  await openDialog({
    mount(host, close) {
      host.appendChild(buildSkeleton(options, cardsById));
      const form = host.querySelector<HTMLFormElement>(
        'form.wishlist-receive-prompt',
      );
      if (form === null) return;
      form
        .querySelector<HTMLButtonElement>('[data-action="cancel"]')
        ?.addEventListener('click', () => close());
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const checked: string[] = [];
        form
          .querySelectorAll<HTMLInputElement>(
            'input[name="receive"]:checked',
          )
          .forEach((cb) => {
            const id = cb.dataset['wishlistId'];
            if (id !== undefined && id.length > 0) checked.push(id);
          });
        void submit(checked, host);
      });
    },
  });

  return receivedIds;

  async function submit(
    wishlistIds: readonly string[],
    host: HTMLElement,
  ): Promise<void> {
    if (wishlistIds.length === 0) {
      host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
      return;
    }
    try {
      const repo = createWishlistRepo(getDb());
      const updated = await markWishlistCandidatesReceived(
        repo,
        wishlistIds,
        'Marked received via receive-prompt',
      );
      receivedIds.push(...updated.map((w) => w.id));
      window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    } catch (caught) {
      const error = host.querySelector<HTMLElement>(
        '[data-region="prompt-error"]',
      );
      if (error !== null) {
        error.textContent =
          caught instanceof Error
            ? `Kunne ikke markere som mottatt: ${caught.message}`
            : 'Kunne ikke markere som mottatt.';
        error.classList.add('wishlist-receive-prompt__error--visible');
      }
      return;
    }
    host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
  }
}

function buildSkeleton(
  options: OpenWishlistReceivePromptOptions,
  cardsById: Map<string, CardRecord>,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wishlist-receive-prompt-wrap';

  const form = document.createElement('form');
  form.className = 'wishlist-receive-prompt';
  form.noValidate = true;

  const header = document.createElement('header');
  header.className = 'wishlist-receive-prompt__header';
  const title = document.createElement('h2');
  title.textContent = 'Marker som mottatt?';
  header.appendChild(title);
  if (options.heading !== undefined && options.heading.length > 0) {
    const sub = document.createElement('p');
    sub.className = 'wishlist-receive-prompt__heading';
    sub.textContent = options.heading;
    header.appendChild(sub);
  }
  const intro = document.createElement('p');
  intro.className = 'wishlist-receive-prompt__intro';
  intro.textContent =
    options.candidates.length === 1
      ? 'Følgende ønskeliste-oppføring matcher det du nettopp la til. Marker den som mottatt for å lukke flowen.'
      : `${options.candidates.length} ønskeliste-oppføringer matcher det du nettopp la til. Velg hvilke som skal markeres mottatt.`;
  header.appendChild(intro);
  form.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'wishlist-receive-prompt__list';
  list.dataset['region'] = 'candidate-list';
  for (const candidate of options.candidates) {
    list.appendChild(buildRow(candidate, cardsById));
  }
  form.appendChild(list);

  const error = document.createElement('p');
  error.className = 'wishlist-receive-prompt__error';
  error.dataset['region'] = 'prompt-error';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'polite');
  form.appendChild(error);

  const footer = document.createElement('footer');
  footer.className = 'wishlist-receive-prompt__footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.dataset['action'] = 'cancel';
  cancel.textContent = 'Ikke nå';
  footer.appendChild(cancel);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'wishlist-receive-prompt__submit';
  submit.dataset['action'] = 'mark-received';
  submit.textContent = 'Marker som mottatt';
  footer.appendChild(submit);
  form.appendChild(footer);

  wrap.appendChild(form);
  return wrap;
}

function buildRow(
  candidate: WishlistReceiveCandidate,
  cardsById: Map<string, CardRecord>,
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'wishlist-receive-prompt__row';
  li.dataset['matchType'] = candidate.matchType;

  const label = document.createElement('label');
  label.className = 'wishlist-receive-prompt__label';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.name = 'receive';
  checkbox.dataset['wishlistId'] = candidate.wishlist.id;
  // Exact matches default checked; condition_mismatch starts unchecked
  // so the user must opt in.
  checkbox.checked = candidate.matchType === 'exact';
  label.appendChild(checkbox);

  const text = document.createElement('div');
  text.className = 'wishlist-receive-prompt__text';

  const card = cardsById.get(candidate.wishlist.cardId);
  const name = document.createElement('strong');
  name.textContent = card?.name ?? candidate.wishlist.cardId;
  text.appendChild(name);

  const details = document.createElement('div');
  details.className = 'wishlist-receive-prompt__details';
  const parts: string[] = [
    `Status: ${wishlistStatusLabel(candidate.wishlist.status)}`,
    `Prioritet: ${PRIORITY_LABELS[candidate.wishlist.priority]}`,
    `Finish: ${candidate.wishlist.finish}`,
  ];
  if (candidate.wishlist.targetCondition !== null) {
    parts.push(`Måltilstand: ${candidate.wishlist.targetCondition}`);
  }
  details.textContent = parts.join(' · ');
  text.appendChild(details);

  if (candidate.matchType === 'condition_mismatch') {
    const mismatch = document.createElement('div');
    mismatch.className = 'wishlist-receive-prompt__mismatch';
    mismatch.textContent = candidate.reason;
    text.appendChild(mismatch);
  }

  if (candidate.wishlist.note !== null && candidate.wishlist.note.length > 0) {
    const note = document.createElement('div');
    note.className = 'wishlist-receive-prompt__note';
    note.textContent = `Notat: ${candidate.wishlist.note}`;
    text.appendChild(note);
  }

  label.appendChild(text);
  li.appendChild(label);
  return li;
}
