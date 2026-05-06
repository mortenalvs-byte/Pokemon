// HTTP retry/backoff layer used by the pokemontcg.io client.
//
// Behaviour (KRAVSPEC §3 / "API-sync regler"):
//   - HTTP 429 → respect Retry-After (delta-seconds form). HTTP-date
//     form falls back to the policy backoff because parsing it adds
//     surface area we do not need in MVP.
//   - HTTP 5xx → retry with exponential backoff.
//   - Network errors (fetch throws) → retry with exponential backoff.
//   - HTTP 4xx (other) → throw, no retry.
//   - Up to `maxAttempts` total attempts (default 3).
//
// The runtime makes no assumptions about the daily quota numbers in
// KRAVSPEC; the only contract is the HTTP status code and the
// `Retry-After` header. Daily quotas live in documentation and the UI.
//
// `sleep` is injectable so the test suite can pass a fake that
// resolves immediately instead of waiting real seconds.

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchWithRetryOptions {
  readonly fetchImpl?: FetchLike;
  readonly sleep?: SleepFn;
  readonly maxAttempts?: number;
  /** Backoff for attempt N (0-indexed), in ms. */
  readonly backoffMs?: (attemptIndex: number) => number;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;

  constructor(status: number, statusText: string, message?: string) {
    super(message ?? `HTTP ${status} ${statusText}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

const defaultBackoff = (attemptIndex: number): number =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attemptIndex);

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? defaultBackoff;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);

      if (response.status === 429) {
        if (attempt === maxAttempts - 1) {
          throw new HttpError(
            response.status,
            response.statusText,
            'Rate limited (429) and out of retries',
          );
        }
        const advertisedMs =
          parseRetryAfterMs(response.headers) ?? backoff(attempt);
        // Cap inside the loop so a server-side Retry-After hint
        // larger than our ceiling cannot stall us for hours.
        await sleep(Math.min(MAX_BACKOFF_MS, advertisedMs));
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt === maxAttempts - 1) {
          throw new HttpError(
            response.status,
            response.statusText,
            `Server error ${response.status} after ${maxAttempts} attempts`,
          );
        }
        await sleep(backoff(attempt));
        continue;
      }

      if (!response.ok) {
        // Non-retryable client error.
        throw new HttpError(response.status, response.statusText);
      }

      return response;
    } catch (caught) {
      if (caught instanceof HttpError) {
        // Already classified above; rethrow non-retryable status errors,
        // and surface the final retryable one.
        if (
          caught.status === 429 ||
          (caught.status >= 500 && caught.status < 600)
        ) {
          // We only get here on the last attempt because earlier ones
          // continue the loop. Bubble up.
          throw caught;
        }
        throw caught;
      }
      lastError = caught;
      if (attempt === maxAttempts - 1) {
        throw caught;
      }
      await sleep(backoff(attempt));
    }
  }

  // Unreachable in practice — the loop always returns or throws — but
  // satisfies the type checker.
  throw lastError instanceof Error
    ? lastError
    : new Error('fetchWithRetry exhausted attempts');
}

export function parseRetryAfterMs(headers: Headers): number | null {
  const value = headers.get('Retry-After');
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  // Delta-seconds form: a non-negative integer. The HTTP-date form
  // exists in the spec but we deliberately do not parse it in MVP —
  // we fall back to the policy backoff in that case.
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  // The parser reports what the server said, faithfully. The retry
  // loop applies its own ceiling (`MAX_BACKOFF_MS`) before sleeping,
  // so a hostile or buggy server that advertises hours of backoff
  // cannot stall the app indefinitely.
  return seconds * 1_000;
}
