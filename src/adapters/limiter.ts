/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Rate-limited, retrying HTTP layer shared by the Roblox and Rolimons clients.
 *
 *  - One global Bottleneck (e.g. 1 req/s for Roblox) chained under per-endpoint-group limiters.
 *  - Groups honour x-ratelimit-remaining / x-ratelimit-reset: remaining 0 => wait for reset.
 *  - 429 => exponential backoff 2s..60s, and the group's spacing is doubled (rate halved).
 *  - 5xx / network errors => bounded retries.
 *  - The cookie is attached ONLY when the URL host matches ROBLOX_COOKIE_HOST_RE, and every
 *    error message passes through redact() so it can never leak into logs.
 */
import Bottleneck from 'bottleneck';
import type { SourceHealth } from '../core/types.js';
import { ROBLOX_COOKIE_HOST_RE, type CookieProvider } from './interfaces.js';
import { redact } from './redact.js';

export interface GroupConfig { limit: number; windowMs: number }

export interface HttpDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** false disables all spacing (tests). */
  limits?: boolean;
}

export interface HttpOptions {
  name: string;
  globalMinTimeMs: number;
  groups: Record<string, GroupConfig>;
  deps?: HttpDeps;
  maxRetries?: number;
  cookie?: CookieProvider;
  /** Called with the new value when Roblox rotates .ROBLOSECURITY via set-cookie. */
  onCookieRotated?: (cookie: string) => void;
  userAgent?: string;
}

export interface RequestInit2 {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  /** false: a 429 throws RateLimitError at once (no retry inside the same window). */
  retry429?: boolean;
}


export interface HttpResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

export class AdapterError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly code: number | null = null) {
    super(redact(message));
    this.name = 'AdapterError';
  }
}

/** 429 surfaced without retrying; `resetAt` is when the window is expected to reset. */
export class RateLimitError extends AdapterError {
  constructor(message: string, readonly resetAt: number) {
    super(message, 429);
    this.name = 'RateLimitError';
  }
}

interface GroupState {
  limiter: Bottleneck;
  blockedUntil: number;
  health: SourceHealth;
  minTime: number;
  /** While > now the group is 'restricted' (Roblox refuses it for this account): 403s are expected, not errors. */
  restrictedUntil: number;
  rate: { limit: number | null; remaining: number | null; resetAt: number | null; at: number } | null;
}

export function parseRateHeaders(h: Headers): { limit: number | null; remaining: number | null; resetSec: number | null } {
  const num = (v: string | null) => {
    if (v == null) return null;
    const n = Number.parseFloat(v.split(',')[0]!.trim());
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num(h.get('x-ratelimit-limit')),
    remaining: num(h.get('x-ratelimit-remaining')),
    resetSec: num(h.get('x-ratelimit-reset')),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitedHttp {
  private readonly global: Bottleneck;
  private readonly groups = new Map<string, GroupState>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limits: boolean;
  private readonly maxRetries: number;

  constructor(private readonly opts: HttpOptions) {
    const d = opts.deps ?? {};
    this.fetchFn = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? defaultSleep;
    this.limits = d.limits !== false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.global = new Bottleneck({ maxConcurrent: 1, minTime: this.limits ? opts.globalMinTimeMs : 0 });
    for (const [id, cfg] of Object.entries(opts.groups)) this.addGroup(id, cfg);
  }

  private addGroup(id: string, cfg: GroupConfig): GroupState {
    const minTime = this.limits ? Math.ceil(cfg.windowMs / cfg.limit) : 0;
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime });
    limiter.chain(this.global);
    const st: GroupState = {
      limiter, blockedUntil: 0, minTime, restrictedUntil: 0, rate: null,
      health: { id: `${this.opts.name}:${id}`, ok: true, lastSuccessAt: null, lastErrorAt: null, lastError: null, count429: 0, cacheHits: 0, cacheMisses: 0 },
    };
    this.groups.set(id, st);
    return st;
  }

  private group(id: string): GroupState {
    return this.groups.get(id) ?? this.addGroup(id, { limit: 60, windowMs: 60_000 });
  }

  health(): SourceHealth[] {
    return [...this.groups.values()].map((g) => {
      const h = { ...g.health };
      if (g.restrictedUntil > this.now()) { h.state = 'restricted'; h.ok = true; } else { delete h.state; delete h.note; if (g.restrictedUntil && h.lastError === 'HTTP 403') { h.lastError = null; h.lastErrorAt = null; } }
      return h;
    });
  }

  /** Neutral 'restricted' state for `ms` (default 30 min): shown as such, not as an error. */
  markRestricted(group: string, note: string | null, ms = 30 * 60_000): void {
    const g = this.group(group);
    g.restrictedUntil = this.now() + ms;
    g.health.ok = true;
    g.health.state = 'restricted';
    g.health.note = note;
    if (g.health.lastError === 'HTTP 403') { g.health.lastError = null; g.health.lastErrorAt = null; } // the 403 that triggered this
  }

  /** Lift a restriction early (e.g. the account became able to trade). */
  clearRestricted(group: string): void {
    const g = this.groups.get(group);
    if (!g) return;
    g.restrictedUntil = 0;
    delete g.health.state;
    delete g.health.note;
  }

  /** Last x-ratelimit headers seen on this group (null before the first response carrying them). */
  rateInfo(group: string): GroupState['rate'] { const r = this.groups.get(group)?.rate; return r ? { ...r } : null; }

  isRestricted(group: string): boolean { return (this.groups.get(group)?.restrictedUntil ?? 0) > this.now(); }

  noteCache(group: string, hit: boolean): void {
    const h = this.group(group).health;
    if (hit) h.cacheHits++; else h.cacheMisses++;
  }

  private async headersFor(url: URL, init: RequestInit2): Promise<Record<string, string>> {
    const h: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
    if (this.opts.userAgent) h['user-agent'] = this.opts.userAgent;
    if (init.body !== undefined) h['content-type'] = 'application/json';
    if (init.auth && this.opts.cookie && ROBLOX_COOKIE_HOST_RE.test(url.hostname) && url.protocol === 'https:') {
      const c = await this.opts.cookie();
      if (c) h['cookie'] = `.ROBLOSECURITY=${c}`;
    }
    return h;
  }

  private checkRotation(res: Response): void {
    if (!this.opts.onCookieRotated) return;
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
    for (const line of raw) {
      const m = /\.ROBLOSECURITY=([^;]+)/.exec(line);
      if (m && m[1] && m[1].length > 20) this.opts.onCookieRotated(m[1]);
    }
  }

  /** Performs a request. Returns non-2xx responses (except 429/5xx, which are retried) to the caller. */
  async request(groupId: string, urlStr: string, init: RequestInit2 = {}): Promise<HttpResponse> {
    const g = this.group(groupId);
    const url = new URL(urlStr);
    let attempt = 0;
    for (;;) {
      const wait = g.blockedUntil - this.now();
      if (wait > 0 && this.limits) await this.sleep(wait);
      let res: Response;
      try {
        const headers = await this.headersFor(url, init);
        res = await g.limiter.schedule(() => this.fetchFn(url, {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          redirect: 'error',
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.fail(g, `network: ${msg}`);
        if (attempt++ >= this.maxRetries) throw new AdapterError(`${groupId} request failed: ${msg}`);
        await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
        continue;
      }
      const rl = parseRateHeaders(res.headers);
      if (rl.limit !== null || rl.remaining !== null || rl.resetSec !== null) {
        g.rate = { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetSec !== null ? this.now() + rl.resetSec * 1000 : null, at: this.now() };
      }
      if (rl.remaining !== null && rl.remaining <= 0 && rl.resetSec !== null) {
        g.blockedUntil = this.now() + rl.resetSec * 1000;
      }
      this.checkRotation(res);
      if (res.status === 429) {
        g.health.count429++;
        this.fail(g, 'HTTP 429');
        if (init.retry429 === false) {
          const ra = Number(res.headers.get('retry-after'));
          const resetAt = rl.resetSec !== null && rl.resetSec > 0 ? this.now() + rl.resetSec * 1000
            : Number.isFinite(ra) && ra > 0 ? this.now() + ra * 1000 : this.now() + 60_000;
          g.blockedUntil = Math.max(g.blockedUntil, resetAt);
          throw new RateLimitError(`${groupId} rate limited (429)`, resetAt);
        }
        if (this.limits) {
          g.minTime = Math.max(g.minTime * 2, 1000);
          g.limiter.updateSettings({ minTime: g.minTime });
        }
        if (attempt++ >= this.maxRetries) throw new AdapterError(`${groupId} rate limited (429)`, 429);
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** (attempt - 1), 60_000));
        continue;
      }
      if (res.status >= 500) {
        this.fail(g, `HTTP ${res.status}`);
        if (attempt++ >= this.maxRetries) throw new AdapterError(`${groupId} server error ${res.status}`, res.status);
        await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
        continue;
      }
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.ok) {
        g.health.ok = true;
        g.health.lastSuccessAt = this.now();
      } else if (res.status !== 403 || !res.headers.get('x-csrf-token')) {
        this.fail(g, `HTTP ${res.status}`);
      }
      return { status: res.status, headers: res.headers, json, text };
    }
  }

  private fail(g: GroupState, msg: string): void {
    if (msg === 'HTTP 403' && g.restrictedUntil > this.now()) return; // expected while restricted
    g.health.ok = false;
    g.health.lastErrorAt = this.now();
    g.health.lastError = redact(msg);
  }

  async stop(): Promise<void> {
    for (const g of this.groups.values()) await g.limiter.stop({ dropWaitingJobs: true }).catch(() => undefined);
    await this.global.stop({ dropWaitingJobs: true }).catch(() => undefined);
  }
}

/** First Roblox error code in a `{errors:[{code}]}` body, else null. */
export function robloxErrorCode(json: unknown): number | null {
  if (json && typeof json === 'object' && 'errors' in json) {
    const errs = (json as { errors?: unknown }).errors;
    if (Array.isArray(errs) && errs[0] && typeof errs[0] === 'object') {
      const c = (errs[0] as { code?: unknown }).code;
      return typeof c === 'number' ? c : null;
    }
  }
  return null;
}
