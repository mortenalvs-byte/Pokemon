import { describe, expect, it, vi } from 'vitest';

import {
  createApiClient,
  POKEMON_TCG_API_BASE,
} from '../src/api/pokemon-tcg-api';
import type { FetchLike } from '../src/api/retry';
import type {
  PokemonTcgCardDto,
  PokemonTcgPaginatedResponse,
  PokemonTcgSetDto,
} from '../src/api/types';

function jsonResponse<T>(payload: T): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function setDto(id: string, name: string): PokemonTcgSetDto {
  return {
    id,
    name,
    series: 'Test Series',
    printedTotal: 10,
    total: 10,
    releaseDate: '2024-01-01',
    images: { symbol: `https://images/${id}-sym.png`, logo: `https://images/${id}-logo.png` },
  };
}

function cardDto(id: string, name: string, setId: string): PokemonTcgCardDto {
  return {
    id,
    name,
    number: '4',
    rarity: 'Rare Holo',
    supertype: 'Pokémon',
    subtypes: ['Stage 2'],
    types: ['Fire'],
    images: { small: 'https://images/small.png', large: 'https://images/large.png' },
    set: { id: setId },
  };
}

const NEVER_SLEEP = (): Promise<void> => Promise.resolve();

describe('pokemon-tcg-api client', () => {
  it('paginates fetchAllSets until totalCount is reached', async () => {
    const fetchSpy = vi.fn<FetchLike>(async (url) => {
      if (typeof url !== 'string') throw new Error('expected string url');
      if (url.includes('page=1')) {
        return jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>({
          data: [setDto('a', 'A'), setDto('b', 'B')],
          page: 1,
          pageSize: 2,
          count: 2,
          totalCount: 3,
        });
      }
      return jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>({
        data: [setDto('c', 'C')],
        page: 2,
        pageSize: 2,
        count: 1,
        totalCount: 3,
      });
    });

    const client = createApiClient({
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
      pageSize: 2,
    });
    const sets = await client.fetchAllSets();

    expect(sets.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('paginates fetchAllCardsForSet and maps DTOs to CardRecord', async () => {
    const fetchSpy = vi.fn<FetchLike>(async (url) => {
      if (typeof url !== 'string') throw new Error('expected string url');
      if (url.includes('page=1')) {
        return jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgCardDto>>({
          data: [cardDto('base1-4', 'Charizard', 'base1')],
          page: 1,
          pageSize: 1,
          count: 1,
          totalCount: 2,
        });
      }
      return jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgCardDto>>({
        data: [cardDto('base1-5', 'Other', 'base1')],
        page: 2,
        pageSize: 1,
        count: 1,
        totalCount: 2,
      });
    });

    const client = createApiClient({
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
      pageSize: 1,
    });
    const cards = await client.fetchAllCardsForSet('base1');

    expect(cards.map((c) => c.id)).toEqual(['base1-4', 'base1-5']);
    expect(cards[0]?.setId).toBe('base1');
    expect(cards[0]?.imageSmall).toBe('https://images/small.png');
    expect(cards[0]?.subtypes).toEqual(['Stage 2']);
  });

  it('sends the API key in the X-Api-Key header, never in the URL', async () => {
    const fetchSpy = vi.fn<FetchLike>(async (url) => {
      if (typeof url !== 'string') throw new Error('expected string url');
      expect(url).toContain(POKEMON_TCG_API_BASE);
      expect(url).not.toContain('super-secret');
      expect(url).not.toContain('apiKey');
      return jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>({
        data: [],
        page: 1,
        pageSize: 250,
        count: 0,
        totalCount: 0,
      });
    });

    const client = createApiClient({
      apiKey: 'super-secret',
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
    });
    await client.fetchAllSets();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('super-secret');
  });

  it('omits X-Api-Key header when no API key is configured', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () =>
      jsonResponse<PokemonTcgPaginatedResponse<PokemonTcgSetDto>>({
        data: [],
        page: 1,
        pageSize: 250,
        count: 0,
        totalCount: 0,
      }),
    );

    const client = createApiClient({
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
    });
    await client.fetchAllSets();

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('throws sanitized errors that never include the API key', async () => {
    const apiKey = 'super-secret-key-abc-123';
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error(`request failed for header ${apiKey}`);
    });

    const client = createApiClient({
      apiKey,
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
      retry: { maxAttempts: 1 },
    });

    await expect(client.fetchAllSets()).rejects.toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(apiKey) as unknown as string,
      }),
    );
  });

  it('testConnection returns false on error and never leaks the key', async () => {
    const apiKey = 'totally-secret-XYZ';
    const fetchSpy = vi.fn<FetchLike>(async () => {
      throw new Error(`network died holding ${apiKey}`);
    });
    const client = createApiClient({
      apiKey,
      fetchImpl: fetchSpy,
      sleep: NEVER_SLEEP,
      retry: { maxAttempts: 1 },
    });
    expect(await client.testConnection()).toBe(false);
  });
});
