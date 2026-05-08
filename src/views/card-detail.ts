// Card Detail view. Reads a single card from the cached `cards` +
// `sets` stores and shows the user's holdings ("Dine kort") and
// wishlist entries ("Ønskeliste-status") for that card. Both Add
// buttons are enabled and open their respective form modals.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { buildHoldingForm } from '../components/holding-form';
import { buildWishlistForm } from '../components/wishlist-form';
import { getDb } from '../db/database';
import { formatTags } from '../domain/tags';
import {
  extractCardmarketPrices,
  extractTcgplayerPrices,
  type PriceRow,
} from '../domain/price-extractors';
import {
  getCurrentCardId,
  navigate,
  navigateToBinder,
  navigateToBinderSlot,
} from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import {
  createBinderSlotService,
  type SlotForCard,
} from '../services/binder-slot-service';
import {
  createCollectionService,
  type CollectionRow,
} from '../services/collection-service';
import {
  createWishlistService,
  type WishlistRow,
} from '../services/wishlist-service';
import { isActiveWishlistStatus } from '../domain/wishlist-status';
import {
  findReceiveCandidatesForHoldings,
  markWishlistCandidatesReceived,
  type WishlistReceiveCandidate,
} from '../services/wishlist-receive-service';
import { openWishlistReceivePrompt } from '../components/wishlist-receive-prompt';
import { createLazyImage } from '../utils/lazy-image';
import type {
  BinderSlotStatus,
  CardRecord,
  HoldingRecord,
  HoldingStatus,
  SetRecord,
  WishlistPriority,
  WishlistRecord,
  WishlistStatus,
} from '../domain/types';

const STATUS_LABELS: Record<HoldingStatus, string> = {
  owned: 'Eid',
  duplicate: 'Duplikat',
  for_sale: 'Til salgs',
  for_trade: 'Bytte',
  upgrade_needed: 'Bør oppgraderes',
  ordered: 'Bestilt',
  wanted: 'Ønsket',
};

const WISHLIST_STATUS_LABELS: Record<WishlistStatus, string> = {
  wanted: 'Ønsket',
  ordered: 'Bestilt',
  received: 'Mottatt',
  cancelled: 'Avbrutt',
};

const WISHLIST_PRIORITY_LABELS: Record<WishlistPriority, string> = {
  grail: 'Grail',
  high: 'Høy',
  medium: 'Medium',
  low: 'Lav',
};

const SLOT_STATUS_LABELS: Record<BinderSlotStatus, string> = {
  empty: 'Tom',
  wanted: 'Ønsket',
  owned: 'Eid',
  missing: 'Mangler',
  ordered: 'Bestilt',
  duplicate: 'Duplikat',
  upgrade_needed: 'Oppgrader',
};

const MATCH_LABELS: Record<SlotForCard['matchedBy'], string> = {
  target: 'Mål-kort',
  assigned: 'Tilordnet holding',
};

export function mountCardDetailView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  void renderInto(container);

  // PR 15A — F-3: pass the router-supplied `signal` so this listener is
  // removed when the user navigates away from card-detail. Previously
  // the leftover handler re-rendered card-detail content into `<main>`
  // after the next view (e.g. `#lots`) had already taken it over,
  // visible as the "Ingen kort valgt" placeholder appearing under
  // `#lots` after a save.
  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container);
  };
  onUserDataChanged(refresh, signal);
}

async function renderInto(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const cardId = getCurrentCardId();

  const root = document.createElement('section');
  root.className = 'card-detail-view';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'card-detail-view__header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'card-detail-view__back';
  back.dataset['action'] = 'back';
  back.textContent = '← Tilbake til Browse';
  back.addEventListener('click', () => {
    navigate('browse');
  });
  header.appendChild(back);
  root.appendChild(header);

  if (cardId === null) {
    appendMessage(
      root,
      'Ingen kort valgt. Velg et kort fra Browse for å se detaljer.',
    );
    return;
  }

  const db = getDb();
  const cardsRepo = createCardsRepo(db);
  const setsRepo = createSetsRepo(db);
  const card = await cardsRepo.get(cardId);
  if (card === undefined) {
    appendMessage(
      root,
      'Kortet finnes ikke i lokal cache. Synk databasen i Innstillinger.',
    );
    return;
  }
  const set = await setsRepo.get(card.setId);

  root.appendChild(buildBody(card, set ?? null));
  root.appendChild(buildActions(cardId));
  // PR 22 — surface the "owned + active wishlist" conflict above the
  // holdings + wishlist tables so the user sees it without scrolling.
  // Reads the same data the two sections below use; cheap.
  const conflictBanner = await buildOwnedActiveWishlistBanner(cardId);
  if (conflictBanner !== null) root.appendChild(conflictBanner);
  root.appendChild(await buildHoldingsSection(cardId));
  root.appendChild(await buildBindersSection(cardId));
  root.appendChild(await buildWishlistSection(cardId));
}

async function buildOwnedActiveWishlistBanner(
  cardId: string,
): Promise<HTMLElement | null> {
  // PR 22 review patch — the banner must respect the same match rule
  // as the rest of the receive flow (cardId + finish). The earlier
  // revision used cardId-only "anything live + anything active" which
  // could mark a `reverse_holo` wishlist row as received when the user
  // only owned the `normal` print. Route through the shared service
  // so the banner offers the *same* candidate set the prompt would.
  const db = getDb();
  const holdingsRepo = createHoldingsRepo(db);
  const wishlistRepo = createWishlistRepo(db);
  const holdings = await holdingsRepo.listByCardId(cardId);
  const liveHoldings = holdings.filter((h) => h.deletedAt === null);
  if (liveHoldings.length === 0) return null;
  const candidates = await findReceiveCandidatesForHoldings(
    wishlistRepo,
    liveHoldings,
  );
  if (candidates.length === 0) return null;

  const wrap = document.createElement('section');
  wrap.className = 'card-detail-view__conflict';
  wrap.dataset['region'] = 'owned-active-wishlist-banner';

  const heading = document.createElement('h3');
  heading.className = 'card-detail-view__conflict-heading';
  heading.textContent = 'Eid + aktiv ønskeliste';
  wrap.appendChild(heading);

  const body = document.createElement('p');
  body.className = 'card-detail-view__conflict-body';
  body.textContent =
    candidates.length === 1
      ? 'Kortet ligger fortsatt aktivt på ønskelisten — vil du markere oppføringen som mottatt?'
      : `${candidates.length} aktive ønskeliste-oppføringer matcher dine holdings — marker som mottatt?`;
  wrap.appendChild(body);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'card-detail-view__conflict-action';
  action.dataset['action'] = 'mark-active-received';
  action.textContent =
    candidates.length === 1
      ? 'Marker som mottatt'
      : `Marker ${candidates.length} som mottatt`;
  action.addEventListener('click', () => {
    void openCardDetailReceivePrompt(candidates);
  });
  wrap.appendChild(action);
  return wrap;
}

async function openCardDetailReceivePrompt(
  candidates: readonly WishlistReceiveCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;
  await openWishlistReceivePrompt({
    candidates,
    heading:
      candidates.length === 1
        ? 'Eid + aktiv ønskeliste — én match på samme kort + finish.'
        : `Eid + aktiv ønskeliste — ${candidates.length} matcher på samme kort + finish.`,
  });
}

async function handleMarkSingleWishlistReceived(
  wishlistId: string,
): Promise<void> {
  await markWishlistCandidatesReceived(
    createWishlistRepo(getDb()),
    [wishlistId],
    'Marked received from Card Detail wishlist row',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

function appendMessage(root: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'card-detail-view__message';
  p.textContent = text;
  root.appendChild(p);
}

function buildBody(card: CardRecord, set: SetRecord | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'card-detail-view__body';

  const imageWrap = document.createElement('div');
  imageWrap.className = 'card-detail-view__image';
  const image = createLazyImage({
    src: card.imageLarge ?? card.imageSmall,
    alt: card.name,
    className: 'card-detail-view__image-img',
  });
  imageWrap.appendChild(image);
  wrap.appendChild(imageWrap);

  const meta = document.createElement('div');
  meta.className = 'card-detail-view__meta';

  const name = document.createElement('h2');
  name.className = 'card-detail-view__name';
  name.textContent = card.name;
  meta.appendChild(name);

  const dl = document.createElement('dl');
  dl.className = 'card-detail-view__metadata';
  appendDt(dl, 'Sett', set?.name ?? card.setId);
  appendDt(dl, 'Nummer', card.number);
  appendDt(dl, 'Rarity', card.rarity ?? '–');
  if (card.supertype !== null) appendDt(dl, 'Supertype', card.supertype);
  if (card.subtypes.length > 0) appendDt(dl, 'Subtyper', card.subtypes.join(', '));
  if (card.types.length > 0) appendDt(dl, 'Typer', card.types.join(', '));
  meta.appendChild(dl);

  meta.appendChild(buildPriceSection(card));

  wrap.appendChild(meta);
  return wrap;
}

function appendDt(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

function buildPriceSection(card: CardRecord): HTMLElement {
  const section = document.createElement('section');
  section.className = 'card-detail-view__prices';
  const heading = document.createElement('h3');
  heading.textContent = 'Priser';
  section.appendChild(heading);

  const tcgplayer = extractTcgplayerPrices(card.tcgplayer);
  const cardmarket = extractCardmarketPrices(card.cardmarket);

  if (tcgplayer.length === 0 && cardmarket.length === 0) {
    const p = document.createElement('p');
    p.className = 'card-detail-view__empty-prices';
    p.textContent = 'Ingen prisdata.';
    section.appendChild(p);
    return section;
  }

  if (tcgplayer.length > 0) {
    const subheading = document.createElement('h4');
    subheading.textContent = 'TCGplayer';
    section.appendChild(subheading);
    section.appendChild(buildPriceList(tcgplayer));
  }

  if (cardmarket.length > 0) {
    const subheading = document.createElement('h4');
    subheading.textContent = 'Cardmarket';
    section.appendChild(subheading);
    section.appendChild(buildPriceList(cardmarket));
  }

  return section;
}

function buildPriceList(rows: readonly PriceRow[]): HTMLDListElement {
  const dl = document.createElement('dl');
  dl.className = 'card-detail-view__price-list';
  for (const row of rows) {
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    dl.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = `${row.price.toFixed(2)} ${row.currency}`;
    dl.appendChild(dd);
  }
  return dl;
}

function buildActions(cardId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'card-detail-view__actions';

  const addToCollection = document.createElement('button');
  addToCollection.type = 'button';
  addToCollection.dataset['action'] = 'add-to-collection';
  addToCollection.textContent = 'Legg til i samling';
  addToCollection.addEventListener('click', () => {
    void openDialog(buildHoldingForm({ mode: 'add', cardId }));
  });
  wrap.appendChild(addToCollection);

  const addToWishlist = document.createElement('button');
  addToWishlist.type = 'button';
  addToWishlist.dataset['action'] = 'add-to-wishlist';
  addToWishlist.textContent = 'Legg til i ønskeliste';
  addToWishlist.addEventListener('click', () => {
    void openDialog(buildWishlistForm({ mode: 'add', cardId }));
  });
  wrap.appendChild(addToWishlist);

  return wrap;
}

async function buildHoldingsSection(cardId: string): Promise<HTMLElement> {
  const section = document.createElement('section');
  section.className = 'card-detail-view__holdings';

  const heading = document.createElement('h3');
  heading.textContent = 'Dine kort';
  section.appendChild(heading);

  const db = getDb();
  const service = createCollectionService(
    createHoldingsRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );
  const rows = await service.listForCard(cardId);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'card-detail-view__empty-holdings';
    empty.textContent =
      'Ingen holdings for dette kortet ennå. Bruk "Legg til i samling" over.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.className = 'card-detail-view__holdings-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Tilstand</th>
        <th>Finish</th>
        <th>Edition</th>
        <th>Antall</th>
        <th>Manuell verdi</th>
        <th>Status</th>
        <th>Tags</th>
        <th>Notat</th>
        <th>Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="holdings-body"></tbody>
  `;
  const body = table.querySelector<HTMLElement>('[data-region="holdings-body"]');
  if (body !== null) {
    for (const row of rows) {
      body.appendChild(buildHoldingRow(row));
    }
  }
  section.appendChild(table);
  return section;
}

function buildHoldingRow(row: CollectionRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (row.holding.deletedAt !== null) {
    tr.classList.add('card-detail-view__holdings-row--deleted');
  }
  tr.dataset['holdingId'] = row.holding.id;

  appendCell(tr, describeCondition(row.holding));
  appendCell(tr, row.holding.finish);
  appendCell(tr, row.holding.edition);
  appendCell(tr, String(row.holding.quantity));
  appendCell(
    tr,
    row.holding.estimatedValue !== null && row.holding.valueCurrency !== null
      ? `${row.holding.estimatedValue.toFixed(2)} ${row.holding.valueCurrency}`
      : '–',
  );
  appendCell(tr, STATUS_LABELS[row.holding.status]);
  appendCell(
    tr,
    row.holding.tags.length > 0 ? formatTags(row.holding.tags) : '–',
  );
  appendCell(tr, row.holding.note ?? '–');

  const actions = document.createElement('td');
  actions.className = 'browse-table__actions';
  if (row.holding.deletedAt !== null) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'browse-table__action';
    restore.textContent = 'Gjenopprett';
    restore.addEventListener('click', () => {
      void handleRestore(row.holding.id);
    });
    actions.appendChild(restore);
  } else {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'browse-table__action';
    edit.textContent = 'Rediger';
    edit.addEventListener('click', () => {
      void handleEdit(row.holding);
    });
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'browse-table__action browse-table__action--danger';
    del.textContent = 'Slett';
    del.addEventListener('click', () => {
      void handleSoftDelete(row.holding.id);
    });
    actions.appendChild(del);
  }
  tr.appendChild(actions);

  return tr;
}

function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

function describeCondition(holding: HoldingRecord): string {
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '?';
    const grade = holding.grade !== null ? holding.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return holding.rawCondition ?? '–';
}

async function buildBindersSection(cardId: string): Promise<HTMLElement> {
  const section = document.createElement('section');
  section.className = 'card-detail-view__binders';

  const heading = document.createElement('h3');
  heading.textContent = 'Binder-lokasjoner';
  section.appendChild(heading);

  const db = getDb();
  const service = createBinderSlotService(
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const matches = await service.slotsForCardId(cardId);

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'card-detail-view__binders-empty';
    empty.textContent =
      'Kortet er ikke tilordnet noen perm-slot. Åpne en perm fra "Permer" for å tilordne en holding.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.className = 'card-detail-view__binders-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Perm</th>
        <th>Side</th>
        <th>Slot</th>
        <th>Status</th>
        <th>Match</th>
        <th>Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="binders-body"></tbody>
  `;
  const body = table.querySelector<HTMLElement>('[data-region="binders-body"]');
  if (body !== null) {
    for (const match of matches) {
      body.appendChild(buildBinderRow(match));
    }
  }
  section.appendChild(table);
  return section;
}

function buildBinderRow(match: SlotForCard): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset['binderId'] = match.binder.id;
  tr.dataset['slotId'] = match.slot.id;

  appendCell(tr, match.binder.name);
  appendCell(tr, String(match.slot.pageNumber));
  appendCell(tr, String(match.slot.slotNumber));
  appendCell(tr, SLOT_STATUS_LABELS[match.slot.status]);
  appendCell(tr, MATCH_LABELS[match.matchedBy]);

  const actions = document.createElement('td');
  actions.className = 'browse-table__actions';
  // PR 17 — deep-link to the specific slot. Old behaviour navigated
  // to the binder list view and made the user scroll to find the
  // slot. Now we land on the binder with the slot scrolled into view
  // and visually highlighted.
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'browse-table__action';
  open.textContent = `Gå til side ${match.slot.pageNumber}.${match.slot.slotNumber}`;
  open.addEventListener('click', () => {
    navigateToBinderSlot(match.binder.id, match.slot.id);
  });
  actions.appendChild(open);
  // Keep a "go to binder list-view" fallback so users who want the
  // overview have a one-click path too.
  const openBinder = document.createElement('button');
  openBinder.type = 'button';
  openBinder.className = 'browse-table__action';
  openBinder.textContent = 'Åpne perm';
  openBinder.addEventListener('click', () => {
    navigateToBinder(match.binder.id);
  });
  actions.appendChild(openBinder);
  tr.appendChild(actions);

  return tr;
}

async function buildWishlistSection(cardId: string): Promise<HTMLElement> {
  const section = document.createElement('section');
  section.className = 'card-detail-view__wishlist';

  const heading = document.createElement('h3');
  heading.textContent = 'Ønskeliste-status';
  section.appendChild(heading);

  const db = getDb();
  const service = createWishlistService(
    createWishlistRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );
  const allRows = await service.listForCard(cardId);
  const liveRows = allRows.filter((row) => row.wishlist.deletedAt === null);

  if (liveRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'card-detail-view__wishlist-empty';
    empty.textContent =
      'Kortet ligger ikke på ønskelisten. Bruk "Legg til i ønskeliste" over.';
    section.appendChild(empty);
    return section;
  }

  const table = document.createElement('table');
  table.className = 'card-detail-view__wishlist-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Finish</th>
        <th>Prioritet</th>
        <th>Måltilstand</th>
        <th>Målpris</th>
        <th>Status</th>
        <th>Notat</th>
        <th>Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="wishlist-body"></tbody>
  `;
  const body = table.querySelector<HTMLElement>('[data-region="wishlist-body"]');
  if (body !== null) {
    for (const row of liveRows) {
      body.appendChild(buildWishlistRow(row));
    }
  }
  section.appendChild(table);
  return section;
}

function buildWishlistRow(row: WishlistRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset['wishlistId'] = row.wishlist.id;

  appendCell(tr, row.wishlist.finish);
  appendCell(tr, WISHLIST_PRIORITY_LABELS[row.wishlist.priority]);
  appendCell(tr, row.wishlist.targetCondition ?? '–');
  appendCell(
    tr,
    row.wishlist.targetPrice !== null && row.wishlist.targetCurrency !== null
      ? `${row.wishlist.targetPrice.toFixed(2)} ${row.wishlist.targetCurrency}`
      : '–',
  );
  appendCell(tr, WISHLIST_STATUS_LABELS[row.wishlist.status]);
  appendCell(tr, row.wishlist.note ?? '–');

  const actions = document.createElement('td');
  actions.className = 'browse-table__actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'browse-table__action';
  edit.textContent = 'Rediger';
  edit.addEventListener('click', () => {
    void handleWishlistEdit(row.wishlist);
  });
  actions.appendChild(edit);

  // PR 22 — Marker mottatt available on active rows only. This is an
  // explicit per-row action, so we go straight to
  // `markWishlistCandidatesReceived` without re-opening the prompt
  // (the user already picked the specific row they want closed).
  if (isActiveWishlistStatus(row.wishlist.status)) {
    const markReceived = document.createElement('button');
    markReceived.type = 'button';
    markReceived.className =
      'browse-table__action browse-table__action--success';
    markReceived.dataset['action'] = 'mark-received';
    markReceived.textContent = 'Marker mottatt';
    markReceived.addEventListener('click', () => {
      void handleMarkSingleWishlistReceived(row.wishlist.id);
    });
    actions.appendChild(markReceived);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'browse-table__action browse-table__action--danger';
  remove.textContent = 'Fjern';
  remove.addEventListener('click', () => {
    void handleWishlistSoftDelete(row.wishlist.id);
  });
  actions.appendChild(remove);

  tr.appendChild(actions);
  return tr;
}

async function handleWishlistEdit(entry: WishlistRecord): Promise<void> {
  await openDialog(buildWishlistForm({ mode: 'edit', entry }));
}

async function handleWishlistSoftDelete(wishlistId: string): Promise<void> {
  const confirmed = window.confirm(
    'Fjern denne oppføringen fra ønskelisten?\n\n' +
      'Oppføringen merkes som slettet og kan gjenopprettes fra ønskeliste-vyen.',
  );
  if (!confirmed) return;
  await createWishlistRepo(getDb()).softDelete(
    wishlistId,
    'Soft-deleted from Card Detail',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

async function handleEdit(holding: HoldingRecord): Promise<void> {
  await openDialog(buildHoldingForm({ mode: 'edit', holding }));
}

async function handleSoftDelete(holdingId: string): Promise<void> {
  const confirmed = window.confirm(
    'Slett dette kortet fra samlingen?\n\n' +
      'Holdingen merkes som slettet og kan gjenopprettes senere fra Min samling.',
  );
  if (!confirmed) return;
  await createHoldingsRepo(getDb()).softDelete(
    holdingId,
    'Soft-deleted from Card Detail',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

async function handleRestore(holdingId: string): Promise<void> {
  await createHoldingsRepo(getDb()).restore(
    holdingId,
    'Restored from Card Detail',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}
