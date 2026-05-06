import { describe, expect, it, vi } from 'vitest';

import {
  fetchWithRetry,
  HttpError,
  parseRetryAfterMs,
  type FetchLike,
  type SleepFn,
} from '../src/api/retry';

function fakeSleep(): { fn: SleepFn; calls: number[] } {
  const calls: number[] = [];
  const fn: SleepFn = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

function makeResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers(headers),
  });
}

describe('fetchWithRetry', () => {
  it('returns the response immediately on 2xx', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => makeResponse(200, { ok: true }));
    const sleep = fakeSleep();

    const response = await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleep.calls).toEqual([]);
  });

  it('retries on HTTP 429 and respects Retry-After (seconds)', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(makeResponse(200));
    const sleep = fakeSleep();

    await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleep.calls).toEqual([2_000]);
  });

  it('retries on HTTP 5xx with exponential backoff', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));
    const sleep = fakeSleep();

    await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleep.calls).toEqual([1_000, 2_000]);
  });

  it('retries on network errors and eventually succeeds', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError('failed to fetch'))
      .mockResolvedValueOnce(makeResponse(200));
    const sleep = fakeSleep();

    await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleep.calls).toEqual([1_000]);
  });

  it('throws after exhausting maxAttempts on persistent 5xx', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => makeResponse(500));
    const sleep = fakeSleep();

    await expect(
      fetchWithRetry(
        'https://example.com',
        {},
        { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(HttpError);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleep.calls).toEqual([1_000, 2_000]);
  });

  it('does not retry on non-429/5xx 4xx errors', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => makeResponse(403));
    const sleep = fakeSleep();

    await expect(
      fetchWithRetry(
        'https://example.com',
        {},
        { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(HttpError);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleep.calls).toEqual([]);
  });

  it('uses the injected sleep, never wall-clock time', async () => {
    // If the implementation accidentally fell back to a real setTimeout,
    // this test would block for several seconds. The fake sleep
    // resolves synchronously, so the whole retry chain finishes in
    // microtasks.
    const start = Date.now();
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '30' }))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));

    await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: fakeSleep().fn, maxAttempts: 3 },
    );
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds form', () => {
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '42' }))).toBe(42_000);
  });

  it('returns null for missing header', () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
  });

  it('returns null for HTTP-date form (PR 5 falls back to policy backoff)', () => {
    expect(
      parseRetryAfterMs(
        new Headers({ 'Retry-After': 'Fri, 31 Dec 1999 23:59:59 GMT' }),
      ),
    ).toBeNull();
  });

  it('rejects negative values', () => {
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '-5' }))).toBeNull();
  });

  it('reports the advertised value as-is; the retry loop applies its own cap', () => {
    // The parser is deliberately faithful. `fetchWithRetry` clamps the
    // sleep inside the loop so an unreasonable Retry-After cannot stall
    // the app — the dedicated test below verifies that.
    const result = parseRetryAfterMs(new Headers({ 'Retry-After': '999999' }));
    expect(result).toBe(999_999_000);
  });
});

describe('fetchWithRetry — Retry-After clamp', () => {
  it('caps a very large server-supplied Retry-After to <=30s before sleeping', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '999999' }))
      .mockResolvedValueOnce(makeResponse(200));
    const sleep = fakeSleep();

    await fetchWithRetry(
      'https://example.com',
      {},
      { fetchImpl: fetchSpy, sleep: sleep.fn, maxAttempts: 3 },
    );

    expect(sleep.calls).toHaveLength(1);
    expect(sleep.calls[0]).toBeLessThanOrEqual(30_000);
  });
});
