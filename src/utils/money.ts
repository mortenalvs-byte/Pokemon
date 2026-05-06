// Currency helpers. Values are stored as plain numbers in the original
// purchase currency; conversion to NOK happens at display time and is not
// part of MVP storage logic.

import type { CurrencyCode } from '../domain/types';

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = [
  'NOK',
  'USD',
  'EUR',
  'PHP',
];

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return (
    typeof value === 'string' &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}
