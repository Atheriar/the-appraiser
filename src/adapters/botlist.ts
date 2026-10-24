/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Historical bot-defender list (gist 03043d47… by C-Cody, last updated 2023-01-16).
 * WEAK signal only. Format: JSON array of [userId, username]; entry 0 is a placeholder.
 */
import type { UserId } from '../core/types.js';
import type { BotListSource } from './interfaces.js';
import { AdapterError, RateLimitedHttp, type HttpDeps } from './limiter.js';

export const BOT_LIST_GIST_API = 'https://api.github.com/gists/03043d47689a6ee645366d327b11944c';

export function parseBotList(text: string): Set<UserId> {
  const out = new Set<UserId>();
  let arr: unknown;
  try { arr = JSON.parse(text); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const row of arr) {
    const id = Array.isArray(row) ? Number(row[0]) : Number(row);
    if (Number.isInteger(id) && id > 0) out.add(id);
  }
  return out;
}

export class GistBotList implements BotListSource {
  readonly asOf = '2023-01-16';
  private cache: Set<UserId> | null = null;
  private readonly http: RateLimitedHttp;
  /** `url` overrides the default gist (settings.botList.url). */
  constructor(deps?: HttpDeps, private readonly url: string = BOT_LIST_GIST_API) {
    this.http = new RateLimitedHttp({ name: 'botlist', globalMinTimeMs: 0, groups: { gist: { limit: 5, windowMs: 60_000 } }, deps, userAgent: 'the-appraiser' });
  }
  async load(): Promise<Set<UserId>> {
    if (this.cache) return this.cache;
    const res = await this.http.request('gist', this.url);
    if (res.status !== 200) throw new AdapterError(`bot list: HTTP ${res.status}`, res.status);
    const files = (res.json as { files?: Record<string, { content?: string }> } | null)?.files ?? {};
    const content = Object.values(files)[0]?.content ?? '';
    this.cache = parseBotList(content);
    return this.cache;
  }
}
