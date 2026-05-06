// Wire types for the pokemontcg.io v2 REST API plus the mappers that
// turn them into our own typed records. The DTOs here intentionally
// mirror the API shape; the mappers normalize fields the API may omit
// or return as undefined into the strict null/empty-array contract our
// `SetRecord` and `CardRecord` types require.

import { nowIso } from '../utils/dates';
import type { CardRecord, SetRecord } from '../domain/types';

export interface PokemonTcgPaginatedResponse<T> {
  readonly data: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly count: number;
  readonly totalCount: number;
}

export interface PokemonTcgSetDto {
  readonly id: string;
  readonly name: string;
  readonly series?: string;
  readonly printedTotal?: number;
  readonly total?: number;
  readonly releaseDate?: string;
  readonly images?: {
    readonly symbol?: string;
    readonly logo?: string;
  };
}

export interface PokemonTcgCardDto {
  readonly id: string;
  readonly name: string;
  readonly number?: string;
  readonly rarity?: string;
  readonly supertype?: string;
  readonly subtypes?: string[];
  readonly types?: string[];
  readonly images?: {
    readonly small?: string;
    readonly large?: string;
  };
  readonly tcgplayer?: unknown;
  readonly cardmarket?: unknown;
  readonly set?: { readonly id?: string };
}

export function mapApiSet(
  dto: PokemonTcgSetDto,
  refreshedAt: string = nowIso(),
): SetRecord {
  return {
    id: dto.id,
    name: dto.name,
    series: dto.series ?? '',
    printedTotal: typeof dto.printedTotal === 'number' ? dto.printedTotal : 0,
    total: typeof dto.total === 'number' ? dto.total : 0,
    releaseDate: dto.releaseDate ?? '',
    symbolUrl: dto.images?.symbol ?? null,
    logoUrl: dto.images?.logo ?? null,
    updatedAt: refreshedAt,
  };
}

export function mapApiCard(
  dto: PokemonTcgCardDto,
  refreshedAt: string = nowIso(),
): CardRecord {
  return {
    id: dto.id,
    setId: dto.set?.id ?? deriveSetIdFromCardId(dto.id),
    name: dto.name,
    number: dto.number ?? '',
    rarity: dto.rarity ?? null,
    supertype: dto.supertype ?? null,
    subtypes: dto.subtypes ?? [],
    types: dto.types ?? [],
    imageSmall: dto.images?.small ?? null,
    imageLarge: dto.images?.large ?? null,
    tcgplayer: dto.tcgplayer ?? null,
    cardmarket: dto.cardmarket ?? null,
    updatedAt: refreshedAt,
  };
}

// pokemontcg.io card ids look like `<setId>-<number>` (e.g. `base1-4`).
// The API also includes `set.id`, but if a future response variant
// omits it we fall back to splitting on the first hyphen. This is a
// pragmatic safety net, not a contract — the mapper still works either
// way.
function deriveSetIdFromCardId(cardId: string): string {
  const dashIndex = cardId.indexOf('-');
  return dashIndex > 0 ? cardId.slice(0, dashIndex) : cardId;
}
