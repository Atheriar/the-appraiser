/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { COOKIE_REDACT_RE } from '../secrets/interfaces.js';

/** Strip anything cookie-like from a string before it can reach a log or an error. */
export function redact(s: string): string {
  return s
    .replace(COOKIE_REDACT_RE, '[REDACTED]')
    .replace(/\.ROBLOSECURITY=[^;\s"']*/gi, '.ROBLOSECURITY=[REDACTED]')
    .replace(/_RoliVerification=[^;\s"']*/gi, '_RoliVerification=[REDACTED]')
    .replace(/(cookie["']?\s*[:=]\s*["']?)[^"',;\s]+/gi, '$1[REDACTED]');
}
