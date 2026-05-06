// Card Detail view. Reads the card id from `getCurrentCardId()` and
// renders a single card from the cached `cards` + `sets` stores. The
// holdings/binder/wishlist sections that UI_DESIGN_SPEC §13 describes
// land in PR 7 (when user-data writes arrive); here those slots
// simply do not render and the action buttons are disabled with the
// "kommer i PR 7" tooltip.

import { getDb } from '../db/database';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import {
  extractCardmarketPrices,
  extractTcgplayerPrices,
  type PriceRow,
} from '../domain/price-extractors';
import { getCurrentCardId, navigate } from '../router';
import { createLazyImage } from '../utils/lazy-image';
import type { CardRecord, SetRecord } from '../domain/types';

export function mountCardDetailView(container: HTMLElement): void {
  void renderInto(container);
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
  root.appendChild(buildActions());
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

  // Image
  const imageWrap = document.createElement('div');
  imageWrap.className = 'card-detail-view__image';
  const image = createLazyImage({
    src: card.imageLarge ?? card.imageSmall,
    alt: card.name,
    className: 'card-detail-view__image-img',
  });
  imageWrap.appendChild(image);
  wrap.appendChild(imageWrap);

  // Metadata
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

function buildActions(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'card-detail-view__actions';

  const addToCollection = document.createElement('button');
  addToCollection.type = 'button';
  addToCollection.disabled = true;
  addToCollection.title = 'Legg til i samling — kommer i PR 7';
  addToCollection.textContent = 'Legg til i samling';
  wrap.appendChild(addToCollection);

  const addToWishlist = document.createElement('button');
  addToWishlist.type = 'button';
  addToWishlist.disabled = true;
  addToWishlist.title = 'Legg til i ønskeliste — kommer i PR 7';
  addToWishlist.textContent = 'Legg til i ønskeliste';
  wrap.appendChild(addToWishlist);

  return wrap;
}
