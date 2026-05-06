// Centralized helper for stripping a known API key out of any string
// before it can leak into a UI panel, an audit row, the appMeta
// `lastSyncError` field, or a thrown Error message.
//
// Anything that turns into user-visible or persisted text from the
// sync code path goes through this function. KRAVSPEC §11 demands the
// API key never leaks; the only safe approach is to redact at every
// boundary, even if a particular path "shouldn't" carry the key.

const REDACTED_PLACEHOLDER = '[REDACTED]';

export function sanitizeErrorMessage(
  error: unknown,
  apiKey?: string | null,
): string {
  const raw = errorToString(error);
  return redactApiKey(raw, apiKey);
}

export function redactApiKey(text: string, apiKey?: string | null): string {
  if (
    text.length === 0 ||
    apiKey === undefined ||
    apiKey === null ||
    apiKey.length === 0
  ) {
    return text;
  }
  return text.split(apiKey).join(REDACTED_PLACEHOLDER);
}

function errorToString(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Unknown error';
  }
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
