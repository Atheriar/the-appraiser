/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Secret store contract, implemented in src/secrets/**.
 * Windows: OS keyring via @napi-rs/keyring (Credential Manager, DPAPI-backed), service
 * "the-appraiser", account "roblosecurity". Fallback: data/cookie.bin encrypted with
 * DPAPI (CurrentUser scope) via PowerShell ProtectedData. Never plaintext on disk, never logged,
 * only ever sent to hosts matching ROBLOX_COOKIE_HOST_RE.
 */
export interface SecretStore {
  getCookie(): Promise<string | null>;
  setCookie(cookie: string): Promise<void>;
  deleteCookie(): Promise<void>;
  /** "…" + last 4 chars, or null. */
  masked(): Promise<string | null>;
}

/** Redact any .ROBLOSECURITY-looking value from a string (use in every log serializer). */
export const COOKIE_REDACT_RE = /_\|WARNING:-DO-NOT-SHARE-THIS[^\s"';]*/g;
