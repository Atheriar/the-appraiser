/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Rolimons client. Politeness: itemdetails at most once per 60s (served from cache otherwise),
 * other non-feed endpoints <= 10/min, activity feeds on their own ~3s spacing.
 * Remote data is data: names/usernames are never interpreted.
 */
import { z } from 'zod';
import type { AssetId, Demand, ReconstructedSale, SourceHealth, Trend, UserId } from '../../core/types.js';
import type { RolimonsClient, RolimonsDeal, RolimonsItem, RolimonsPlayer, RolimonsTradeAd } from '../interfaces.js';
import { AdapterError, RateLimitedHttp, type HttpDeps } from '../limiter.js';

const BASE = 'https://api.rolimons.com';
export const ROLIMONS_GROUPS = {
  general: { limit: 10, windowMs: 60_000 },
  feed: { limit: 20, windowMs: 60_000 }, // ~3s spacing
};

// Rows are parsed per field (see ROW): an extra or retyped column in some rows must not sink the whole refresh.
const ItemDetailsSchema = z.object({
  success: z.boolean(),
  items: z.record(z.string(), z.unknown()),
});
const SaleSchema = z.object({ success: z.boolean(), activities: z.array(z.unknown()) });
const AdsSchema = z.object({ success: z.boolean(), trade_ads: z.array(z.array(z.unknown())) });
const PlayerSchema = z.object({
  success: z.boolean(),
  playerTerminated: z.boolean().nullish(),
  playerPrivacyEnabled: z.boolean().nullish(),
  playerAssets: z.record(z.string(), z.unknown()).nullish(),
});

const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
function clampIdx(v: unknown): -1 | 0 | 1 | 2 | 3 | 4 {
  const x = n(v);
  return Number.isInteger(x) && x >= 0 && x <= 4 ? (x as 0 | 1 | 2 | 3 | 4) : -1;
}

/**
 * itemdetails row layout. THE ONLY PLACE to change if Rolimons reorders or inserts a column.
 * [0 name, 1 acronym, 2 RAP, 3 value, 4 defaultValue, 5 demand, 6 trend, 7 projected, 8 hyped(unused), 9 rare, 10 ?]
 */
export const ROW = { name: 0, acronym: 1, rap: 2, value: 3, defaultValue: 4, demand: 5, trend: 6, projected: 7, rare: 9 } as const;

/** Index fields Rolimons documents as -1..4; anything else in many rows means the layout moved. */
function idxOk(v: unknown): boolean {
  if (v == null) return true;
  const x = n(v);
  return Number.isInteger(x) && x >= -1 && x <= 4;
}

/** Structural check of one row: name is text, RAP a non-negative number, demand/trend in -1..4. */
export function rowLooksRight(row: unknown): boolean {
  if (!Array.isArray(row) || row.length <= ROW.trend) return false;
  const rap = n(row[ROW.rap]);
  return typeof row[ROW.name] === 'string' && Number.isFinite(rap) && rap >= 0 && idxOk(row[ROW.demand]) && idxOk(row[ROW.trend]);
}

export function parseItemRow(assetId: AssetId, row: unknown): RolimonsItem | null {
  if (!Array.isArray(row)) return null;
  const rap = n(row[ROW.rap]);
  if (!Number.isFinite(assetId) || !Number.isFinite(rap)) return null;
  const value = n(row[ROW.value]);
  const def = n(row[ROW.defaultValue]);
  const acr = typeof row[ROW.acronym] === 'string' && row[ROW.acronym] ? (row[ROW.acronym] as string) : null;
  const name = row[ROW.name];
  return {
    assetId, name: typeof name === 'string' || typeof name === 'number' ? String(name) : '', acronym: acr, rap,
    value: Number.isFinite(value) && value >= 0 ? value : null,
    defaultValue: Number.isFinite(def) ? def : rap,
    demand: clampIdx(row[ROW.demand]) as Demand,
    trend: clampIdx(row[ROW.trend]) as Trend,
    projected: n(row[ROW.projected]) === 1,
    rare: n(row[ROW.rare]) === 1,
  };
}

/** Above this share of structurally wrong rows the whole payload is treated as API drift and rejected. */
export const MAX_BAD_ROW_SHARE = 0.2;

export interface ItemDetailsParse { map: Map<AssetId, RolimonsItem>; total: number; bad: number }

/**
 * Parse an itemdetails `items` record row by row. Bad rows are skipped and counted; when more than
 * MAX_BAD_ROW_SHARE of rows look wrong (a reordered or inserted column), throws an AdapterError
 * ("API drift") so the last good values stay in use instead of being silently corrupted.
 */
export function parseItemDetails(items: Record<string, unknown>): ItemDetailsParse {
  const map = new Map<AssetId, RolimonsItem>();
  let total = 0, bad = 0;
  for (const [id, row] of Object.entries(items)) {
    total++;
    const it = rowLooksRight(row) ? parseItemRow(Number(id), row) : null;
    if (it) map.set(it.assetId, it); else bad++;
  }
  if (total === 0) throw new AdapterError('rolimons itemdetails: empty item list (API drift or outage); keeping the last good values');
  if (bad / total > MAX_BAD_ROW_SHARE) {
    throw new AdapterError(`rolimons itemdetails: API drift (${bad} of ${total} rows do not match the expected layout); keeping the last good values`);
  }
  return { map, total, bad };
}

/** salePrice = oldRAP + 10*(newRAP-oldRAP); oldRAP=0 -> newRAP (first sale). */
export function reconstructSalePrice(oldRap: number, newRap: number): number {
  if (oldRap <= 0) return newRap;
  const p = Math.round(oldRap + 10 * (newRap - oldRap));
  // Too steep for one sale: keep it as a low sale at the new RAP (upper bound) rather than dropping it.
  return p > 0 ? p : Math.max(0, newRap);
}

export interface RolimonsClientOptions { deps?: HttpDeps; itemDetailsTtlMs?: number; userAgent?: string }

export class HttpRolimonsClient implements RolimonsClient {
  readonly http: RateLimitedHttp;
  private readonly now: () => number;
  private readonly ttl: number;
  private items: { at: number; map: Map<AssetId, RolimonsItem> } | null = null;
  /** Rows skipped in the last itemdetails parse (shown in health). */
  lastBadRows = 0;

  constructor(opts: RolimonsClientOptions = {}) {
    this.now = opts.deps?.now ?? Date.now;
    this.ttl = opts.itemDetailsTtlMs ?? 60_000;
    this.http = new RateLimitedHttp({
      name: 'rolimons', globalMinTimeMs: 0, groups: { ...ROLIMONS_GROUPS }, deps: opts.deps,
      userAgent: opts.userAgent ?? 'the-appraiser/0.1 (personal, read-only)',
    });
  }

  health(): SourceHealth[] {
    const h = this.http.health();
    if (this.lastBadRows > 0) {
      return h.map((x) => (x.id.endsWith('general')
        ? { ...x, note: [x.note, `itemdetails: ${this.lastBadRows} malformed row(s) skipped`].filter(Boolean).join('; ') }
        : x));
    }
    return h;
  }

  private async getJson(group: 'general' | 'feed', path: string): Promise<unknown> {
    const res = await this.http.request(group, BASE + path);
    if (res.status < 200 || res.status >= 300) throw new AdapterError(`rolimons ${path}: HTTP ${res.status}`, res.status);
    return res.json;
  }

  async getItemDetails(): Promise<Map<AssetId, RolimonsItem>> {
    if (this.items && this.now() - this.items.at < this.ttl) {
      this.http.noteCache('general', true);
      return this.items.map;
    }
    this.http.noteCache('general', false);
    const p = ItemDetailsSchema.safeParse(await this.getJson('general', '/items/v2/itemdetails'));
    if (!p.success || !p.data.success) throw new AdapterError('rolimons itemdetails: unexpected payload');
    const { map, bad } = parseItemDetails(p.data.items);
    this.lastBadRows = bad;
    this.items = { at: this.now(), map };
    return map;
  }

  async getSaleActivity(): Promise<ReconstructedSale[]> {
    const p = SaleSchema.safeParse(await this.getJson('feed', '/market/v1/saleactivity'));
    if (!p.success || !p.data.success) throw new AdapterError('rolimons saleactivity: unexpected payload');
    const out: ReconstructedSale[] = [];
    for (const a of p.data.activities) {
      if (!Array.isArray(a)) continue;
      const [ts, id, oldR, newR, saleId] = a.map(n);
      if (![ts, id, oldR, newR].every((x) => Number.isFinite(x))) continue;
      out.push({
        assetId: id!, t: ts! * 1000, price: reconstructSalePrice(oldR!, newR!), oldRap: oldR!, newRap: newR!,
        source: 'rolimons_feed', ...(a[4] != null ? { saleId: String(Number.isFinite(saleId) ? saleId : a[4]) } : {}),
      });
    }
    return out.sort((x, y) => y.t - x.t);
  }

  async getDealActivity(): Promise<RolimonsDeal[]> {
    const p = SaleSchema.safeParse(await this.getJson('feed', '/market/v1/dealactivity'));
    if (!p.success || !p.data.success) throw new AdapterError('rolimons dealactivity: unexpected payload');
    const out: RolimonsDeal[] = [];
    for (const a of p.data.activities) {
      if (!Array.isArray(a)) continue;
      const [ts, type, id, price] = a.map(n);
      if (![ts, type, id, price].every((x) => Number.isFinite(x))) continue;
      out.push({ t: ts! * 1000, kind: type === 1 ? 'rap' : 'price', assetId: id!, value: price! });
    }
    return out.sort((x, y) => y.t - x.t);
  }

  async getRecentTradeAds(): Promise<RolimonsTradeAd[]> {
    const p = AdsSchema.safeParse(await this.getJson('feed', '/tradeads/v1/getrecentads'));
    if (!p.success || !p.data.success) throw new AdapterError('rolimons tradeads: unexpected payload');
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(n).filter(Number.isFinite) : []);
    const out: RolimonsTradeAd[] = [];
    for (const row of p.data.trade_ads) {
      const [adId, ts, userId, , offer, request] = row;
      const o = (offer && typeof offer === 'object' ? offer : {}) as Record<string, unknown>;
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      if (!Number.isFinite(n(adId)) || !Number.isFinite(n(ts))) continue;
      out.push({
        adId: n(adId), t: n(ts) * 1000, userId: n(userId),
        offerAssetIds: ids(o.items), offerRobux: Number.isFinite(n(o.robux)) ? n(o.robux) : 0,
        requestAssetIds: ids(r.items), requestTags: ids(r.tags),
      });
    }
    return out;
  }

  async getPlayer(userId: UserId): Promise<RolimonsPlayer | null> {
    const res = await this.http.request('general', `${BASE}/players/v1/playerassets/${userId}`);
    if (res.status === 404 || res.status === 400) return null;
    if (res.status < 200 || res.status >= 300) throw new AdapterError(`rolimons playerassets: HTTP ${res.status}`, res.status);
    const p = PlayerSchema.safeParse(res.json);
    if (!p.success || !p.data.success) return null;
    const assetIds: AssetId[] = [];
    for (const [id, uaids] of Object.entries(p.data.playerAssets ?? {})) {
      const count = Array.isArray(uaids) ? Math.max(1, uaids.length) : 1;
      for (let i = 0; i < count; i++) assetIds.push(Number(id));
    }
    return {
      userId, terminated: p.data.playerTerminated ?? false, privacyEnabled: p.data.playerPrivacyEnabled ?? false,
      assetIds: assetIds.filter(Number.isFinite), fetchedAt: this.now(),
    };
  }
}
