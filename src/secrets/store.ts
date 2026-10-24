/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStore } from './interfaces.js';
import { dpapiProtect, dpapiUnprotect } from './dpapi.js';

export const KEYRING_SERVICE = 'the-appraiser';
export const KEYRING_ACCOUNT = 'roblosecurity';

export function maskCookie(c: string | null): string | null {
  if (!c) return null;
  return `_|WARNING…${c.slice(-4)}`;
}

/** Strip whitespace, surrounding quotes and an accidental ".ROBLOSECURITY=" prefix. */
export function normalizeCookie(raw: string): string {
  let c = raw.trim();
  if (/^\.?ROBLOSECURITY=/i.test(c)) c = c.replace(/^\.?ROBLOSECURITY=/i, '');
  c = c.replace(/^["']|["']$/g, '').replace(/;.*$/, '').trim();
  return c;
}

interface KeyringEntry {
  setPassword(p: string): void;
  getPassword(): string | null | undefined;
  deletePassword(): unknown;
}

async function loadKeyring(): Promise<KeyringEntry | null> {
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as { Entry: new (s: string, a: string) => KeyringEntry };
    return new mod.Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
  } catch {
    return null;
  }
}

/**
 * Cookie store: OS keyring (Windows Credential Manager, DPAPI-backed) first; when the keyring
 * is unavailable or rejects the value (Credential Manager blobs are size-limited), a
 * DPAPI-encrypted file. Never writes plaintext. Caches the value in memory for the process.
 */
export class WindowsSecretStore implements SecretStore {
  private cache: string | null | undefined;

  constructor(private readonly fallbackFile: string) {}

  async getCookie(): Promise<string | null> {
    if (this.cache !== undefined) return this.cache;
    const entry = await loadKeyring();
    if (entry) {
      try {
        const v = entry.getPassword();
        if (v) return (this.cache = v);
      } catch { /* NoEntry or backend failure -> try file */ }
    }
    if (existsSync(this.fallbackFile)) {
      try {
        const v = await dpapiUnprotect(readFileSync(this.fallbackFile));
        return (this.cache = v || null);
      } catch {
        return (this.cache = null);
      }
    }
    return (this.cache = null);
  }

  async setCookie(cookie: string): Promise<void> {
    const c = normalizeCookie(cookie);
    if (!c) throw new Error('empty cookie');
    const entry = await loadKeyring();
    let stored = false;
    if (entry) {
      try {
        entry.setPassword(c);
        stored = entry.getPassword() === c;
      } catch { stored = false; }
    }
    if (stored) {
      if (existsSync(this.fallbackFile)) rmSync(this.fallbackFile, { force: true });
    } else {
      const blob = await dpapiProtect(c);
      mkdirSync(dirname(this.fallbackFile), { recursive: true });
      writeFileSync(this.fallbackFile, blob, { mode: 0o600 });
    }
    this.cache = c;
  }

  async deleteCookie(): Promise<void> {
    const entry = await loadKeyring();
    if (entry) { try { entry.deletePassword(); } catch { /* none */ } }
    if (existsSync(this.fallbackFile)) rmSync(this.fallbackFile, { force: true });
    this.cache = null;
  }

  async masked(): Promise<string | null> { return maskCookie(await this.getCookie()); }
}

/** In-memory store for tests / demo mode. */
export class MemorySecretStore implements SecretStore {
  constructor(private value: string | null = null) {}
  async getCookie(): Promise<string | null> { return this.value; }
  async setCookie(c: string): Promise<void> { this.value = normalizeCookie(c); }
  async deleteCookie(): Promise<void> { this.value = null; }
  async masked(): Promise<string | null> { return maskCookie(this.value); }
}
