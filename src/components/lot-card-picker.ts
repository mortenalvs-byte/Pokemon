// Tiny card-typeahead used inside the lot-item form. Reads from the
// cached `cards` store (no API calls). Searches by name (case-insensitive
// substring) and falls back to exact id match. Returns at most 10
// results so a 20k-card cache stays cheap.
//
// The picker owns no state outside its DOM. Callers provide an
// `onSelect(cardId)` callback and read the current selection via the
// hidden input we attach to the wrapper. Clearing the typeahead
// clears the selection.

import { getDb } from '../db/database';
import { createCardsRepo } from '../repositories/cards-repo';
import type { CardRecord } from '../domain/types';

const MAX_RESULTS = 10;

export interface LotCardPickerOptions {
  readonly initialCardId?: string | null;
  readonly onSelect: (cardId: string | null) => void;
}

export interface LotCardPickerHandle {
  /** The DOM root the caller appends. */
  readonly element: HTMLElement;
  /** Read the currently selected cardId, or null when nothing is picked. */
  getSelectedCardId(): string | null;
  /** Programmatically reset the picker. */
  clear(): void;
}

export function buildLotCardPicker(
  options: LotCardPickerOptions,
): LotCardPickerHandle {
  const wrap = document.createElement('div');
  wrap.className = 'lot-card-picker';
  wrap.innerHTML = `
    <input type="search" class="lot-card-picker__input" data-region="picker-input"
      placeholder="Søk på kortnavn eller kort-ID…" autocomplete="off" />
    <p class="lot-card-picker__selected" data-region="picker-selected" hidden></p>
    <ul class="lot-card-picker__results" data-region="picker-results" role="listbox" hidden></ul>
  `;

  const inputMaybe = wrap.querySelector<HTMLInputElement>(
    '[data-region="picker-input"]',
  );
  const selectedLabelMaybe = wrap.querySelector<HTMLElement>(
    '[data-region="picker-selected"]',
  );
  const resultsListMaybe = wrap.querySelector<HTMLElement>(
    '[data-region="picker-results"]',
  );
  if (
    inputMaybe === null ||
    selectedLabelMaybe === null ||
    resultsListMaybe === null
  ) {
    throw new Error('lot-card-picker bootstrap failed');
  }
  // Re-bind to non-nullable locals so the closures below see narrowed
  // types. `function` declarations would be hoisted past the null
  // check, so we use arrow expressions instead.
  const input: HTMLInputElement = inputMaybe;
  const selectedLabel: HTMLElement = selectedLabelMaybe;
  const resultsList: HTMLElement = resultsListMaybe;

  const initialCardId: string | null =
    options.initialCardId === undefined ? null : options.initialCardId;
  let selectedCardId: string | null = initialCardId;
  let cards: readonly CardRecord[] | null = null;
  let loadPromise: Promise<readonly CardRecord[]> | null = null;
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  const loadCards = (): Promise<readonly CardRecord[]> => {
    if (cards !== null) return Promise.resolve(cards);
    if (loadPromise !== null) return loadPromise;
    loadPromise = createCardsRepo(getDb())
      .list()
      .then((list) => {
        cards = list;
        return list;
      });
    return loadPromise;
  };

  const commitSelection = (card: CardRecord | null): void => {
    selectedCardId = card?.id ?? null;
    if (card === null) {
      selectedLabel.hidden = true;
      selectedLabel.textContent = '';
    } else {
      selectedLabel.hidden = false;
      selectedLabel.textContent = `Valgt: ${card.name} (${card.id})`;
    }
    resultsList.hidden = true;
    resultsList.replaceChildren();
    options.onSelect(selectedCardId);
  };

  const renderResults = (
    query: string,
    list: readonly CardRecord[],
  ): void => {
    resultsList.replaceChildren();
    if (query.length === 0) {
      resultsList.hidden = true;
      return;
    }
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      resultsList.hidden = true;
      return;
    }
    const matches: CardRecord[] = [];
    for (const card of list) {
      if (
        card.id.toLowerCase() === normalized ||
        card.name.toLowerCase().includes(normalized)
      ) {
        matches.push(card);
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'lot-card-picker__empty';
      empty.textContent = 'Ingen treff i lokal cache.';
      resultsList.appendChild(empty);
      resultsList.hidden = false;
      return;
    }
    for (const match of matches) {
      const item = document.createElement('li');
      item.className = 'lot-card-picker__result';
      item.dataset['cardId'] = match.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lot-card-picker__result-button';
      button.textContent = `${match.name} (${match.id})`;
      button.addEventListener('click', () => {
        input.value = match.name;
        commitSelection(match);
      });
      item.appendChild(button);
      resultsList.appendChild(item);
    }
    resultsList.hidden = false;
  };

  input.addEventListener('input', () => {
    if (searchTimeout !== null) clearTimeout(searchTimeout);
    const query = input.value;
    if (query.length === 0) {
      commitSelection(null);
      return;
    }
    searchTimeout = setTimeout(() => {
      void loadCards().then((list) => renderResults(query, list));
    }, 120);
  });

  // Pre-fill with an existing selection (edit mode).
  if (initialCardId !== null) {
    void loadCards().then((list) => {
      const found = list.find((c) => c.id === initialCardId);
      if (found !== undefined) {
        input.value = found.name;
        commitSelection(found);
      } else {
        // Card not in cache; preserve the id but show the bare label.
        selectedLabel.hidden = false;
        selectedLabel.textContent = `Valgt: ${initialCardId} (ikke i lokal cache)`;
        selectedCardId = initialCardId;
        options.onSelect(selectedCardId);
      }
    });
  }

  return {
    element: wrap,
    getSelectedCardId() {
      return selectedCardId;
    },
    clear() {
      input.value = '';
      commitSelection(null);
    },
  };
}
