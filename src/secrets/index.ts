/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
export { WindowsSecretStore, MemorySecretStore, maskCookie, normalizeCookie, KEYRING_ACCOUNT, KEYRING_SERVICE } from './store.js';
export { COOKIE_REDACT_RE } from './interfaces.js';
export type { SecretStore } from './interfaces.js';
import { COOKIE_REDACT_RE } from './interfaces.js';

/** Redact cookie-looking values from any string (logs, error messages). */
export function redact(s: string): string {
  return s.replace(COOKIE_REDACT_RE, '[REDACTED]').replace(/(\.ROBLOSECURITY=)[^;\s"']+/gi, '$1[REDACTED]').replace(/(_RoliVerification=)[^;\s"']+/gi, '$1[REDACTED]');
}
