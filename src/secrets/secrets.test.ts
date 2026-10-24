/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { dpapiProtect, dpapiUnprotect } from './dpapi.js';
import { MemorySecretStore, maskCookie, normalizeCookie } from './store.js';

describe('secrets', () => {
  it('normalizes pasted cookies', () => {
    expect(normalizeCookie(' .ROBLOSECURITY=_|WARNING:-x|_abc; path=/ ')).toBe('_|WARNING:-x|_abc');
    expect(normalizeCookie('"_|WARNING:-x|_abc"')).toBe('_|WARNING:-x|_abc');
  });

  it('masks to the last 4 characters only', async () => {
    expect(maskCookie('_|WARNING:-secret-value-wxyz')).toBe('_|WARNING…wxyz');
    const s = new MemorySecretStore('_|WARNING:-secret-value-wxyz');
    expect(await s.masked()).not.toContain('secret');
  });

  it.skipIf(process.platform !== 'win32')('DPAPI round-trips (CurrentUser) and output is not plaintext', async () => {
    const blob = await dpapiProtect('dummy-value-123');
    expect(blob.toString('utf8')).not.toContain('dummy-value-123');
    expect(await dpapiUnprotect(blob)).toBe('dummy-value-123');
  }, 20_000);
});
