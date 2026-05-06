// pokemontcg.io v2 client. Reads only — never writes — and does not
// know about IndexedDB or any of our repositories. The sync
// orchestrator (src/db/sync.ts) is the only consumer that bridges
// this client into the data layer.
//
// Hard rules (KRAVSPEC §11):
//   - The API key is sent in the `X-Api-Key` header. Never in the URL,
//     never in the query string.
//   - The API key is not logged. Errors thrown from this module pass
//     through `sanitizeErrorMessage()` so even an accidental dump of
//     headers cannot leak it.

import {
  fetchWithRetry,
  type FetchLike,
  type FetchWithRetryOptions,
  type SleepFn,
} from './retry';
import { sanitizeErrorMessage } from './sanitize';
import {
  mapApiCard,
  mapApiSet,
  type PokemonTcgCardDto,
  type PokemonTcgPaginatedResponse,
  type PokemonTcgSetDto,
} from './types';
import type { CardRecord, SetRecord } from '../domain/types';

export const POKEMON_TCG_API_BASE = 'https://api.pokemontcg.io/v2';
export const DEFAULT_PAGE_SIZE = 250;

export interface ApiClientOptions {
  readonly apiKey?: string | null;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: SleepFn;
  readonly baseUrl?: string;
  readonly pageSize?: number;
  readonly retry?: Pick<FetchWithRetryOptions, 'maxAttempts' | 'backoffMs'>;
}

export interface SetsProgress {
  readonly phase: 'sets';
  readonly fetched: number;
  readonly total: number;
}

export interface CardsProgress {
  readonly phase: 'cards';
  readonly setId: string;
  readonly fetched: number;
  readonly total: number;
}

export type FetchProgress = SetsProgress | CardsProgress;

export interface PokemonTcgApi {
  fetchAllSets(
    onProgress?: (progress: SetsProgress) => void,
  ): Promise<SetRecord[]>;
  fetchAllCardsForSet(
    setId: string,
    onProgress?: (progress: CardsProgress) => void,
  ): Promise<CardRecord[]>;
  testConnection(): Promise<boolean>;
}

export function createApiClient(options: ApiClientOptions = {}): PokemonTcgApi {
  const apiKey = options.apiKey ?? null;
  const baseUrl = options.baseUrl ?? POKEMON_TCG_API_BASE;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const retryOptions: FetchWithRetryOptions = {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.retry?.maxAttempts !== undefined
      ? { maxAttempts: options.retry.maxAttempts }
      : {}),
    ...(options.retry?.backoffMs !== undefined
      ? { backoffMs: options.retry.backoffMs }
      : {}),
  };

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey !== null && apiKey.length > 0) {
    headers['X-Api-Key'] = apiKey;
  }

  async function getJson<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetchWithRetry(url, { headers }, retryOptions);
      return (await response.json()) as T;
    } catch (caught) {
      // Re-throw with a sanitized message so any header echo or fetch
      // implementation chatter cannot bubble the API key into the UI.
      throw new Error(sanitizeErrorMessage(caught, apiKey));
    }
  }

  async function fetchAllSets(
    onProgress?: (progress: SetsProgress) => void,
  ): Promise<SetRecord[]> {
    const records: SetRecord[] = [];
    let page = 1;
    let total = 0;
    do {
      const response = await getJson<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>(
        `/sets?page=${page}&pageSize=${pageSize}`,
      );
      total = response.totalCount;
      for (const dto of response.data) {
        records.push(mapApiSet(dto));
      }
      onProgress?.({ phase: 'sets', fetched: records.length, total });
      if (response.data.length < pageSize) {
        break;
      }
      page += 1;
    } while (records.length < total);
    return records;
  }

  async function fetchAllCardsForSet(
    setId: string,
    onProgress?: (progress: CardsProgress) => void,
  ): Promise<CardRecord[]> {
    const encodedQuery = encodeURIComponent(`set.id:${setId}`);
    const records: CardRecord[] = [];
    let page = 1;
    let total = 0;
    do {
      const response = await getJson<PokemonTcgPaginatedResponse<PokemonTcgCardDto>>(
        `/cards?q=${encodedQuery}&page=${page}&pageSize=${pageSize}`,
      );
      total = response.totalCount;
      for (const dto of response.data) {
        records.push(mapApiCard(dto));
      }
      onProgress?.({
        phase: 'cards',
        setId,
        fetched: records.length,
        total,
      });
      if (response.data.length < pageSize) {
        break;
      }
      page += 1;
    } while (records.length < total);
    return records;
  }

  async function testConnection(): Promise<boolean> {
    // A tiny request that the API will respond to even on the
    // unauthenticated tier. If anything in the chain throws, we report
    // false; the Settings view can show the sanitized error message.
    try {
      await getJson<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>(
        `/sets?page=1&pageSize=1`,
      );
      return true;
    } catch {
      return false;
    }
  }

  return { fetchAllSets, fetchAllCardsForSet, testConnection };
}
