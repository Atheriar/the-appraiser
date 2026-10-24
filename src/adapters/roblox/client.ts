/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Roblox client. HARD RULE: no trade-action endpoints exist here or anywhere (never accept / decline / counter / send).
 * Other POSTs are read-only detail lookups: catalog batch details (CSRF handshake via 403 + x-csrf-token)
 * and marketplace-items details (stock). NEVER a purchase endpoint: drops are bought by the user on roblox.com.
 */
import type { z } from 'zod';
import type {
  AssetId, CollectibleItemId, PricePoint, SourceHealth, TradeDirection, TradeId, TradeMetadata, TradeSnapshot, UserId,
} from '../../core/types.js';
import { DEFAULT_SETTINGS } from '../../core/types.js';
import type {
  AuthenticatedUser, CanTrade, CatalogItem, CatalogSearchItem, CatalogSearchOpts, RateInfo, MarketplaceItemStock, CollectibleInstance, CookieProvider, OwnerRow, PurchaseTransaction, Page, ResaleData,
  Reseller, RobloxClient, TradableItem, TradeListEntry, UserProfile,
} from '../interfaces.js';
import { AdapterError, RateLimitError, RateLimitedHttp, robloxErrorCode, type HttpDeps, type HttpResponse } from '../limiter.js';
import * as S from './schemas.js';
import { buildTradeSnapshot, parseItemType } from './join.js';
import { parseDeadline, parseScheduledRelease, saleStatusFrom } from '../../core/drops.js';

/** Seeded from observed x-ratelimit-limit headers. */
export const ROBLOX_GROUPS = {
  users: { limit: 30, windowMs: 60_000 },
  tradesV1: { limit: 500, windowMs: 60_000 },
  tradesV2: { limit: 50, windowMs: 60_000 },
  tradesMeta: { limit: 600, windowMs: 60_000 },
  canTrade: { limit: 30, windowMs: 60_000 },
  tradable: { limit: 1, windowMs: 1_000 },
  catalog: { limit: 10, windowMs: 60_000 },
  marketplace: { limit: 50, windowMs: 60_000 },
  economy: { limit: 50, windowMs: 60_000 },
  /** Own transaction history (Purchase rows, for hold starts). Polled at most every 30 min by the analyst. */
  transactions: { limit: 10, windowMs: 60_000 },
  collectibles: { limit: 60, windowMs: 60_000 },
  owners: { limit: 15, windowMs: 60_000 },
  thumbnails: { limit: 50, windowMs: 1_000 },
  canView: { limit: 30, windowMs: 60_000 },
  groups: { limit: 30, windowMs: 60_000 },
  /** catalog v1/v2 search share 12 / 60 s per IP. Used only by the Drops feed. */
  catalogSearch: { limit: 12, windowMs: 60_000 },
  marketplaceItems: { limit: 60, windowMs: 60_000 },
} as const;

/** How long a refused (403) endpoint is left alone before trying again. */
export const RESTRICTED_BACKOFF_MS = 30 * 60_000;

const DIRECTION_NUM: Record<TradeDirection, number> = { inbound: 1, outbound: 2, completed: 3, inactive: 4 };
const STALE_MS = 30 * 86_400_000;

export interface RobloxClientOptions {
  cookie: CookieProvider;
  deps?: HttpDeps;
  onCookieRotated?: (cookie: string) => void;
}

function parse<T extends z.ZodTypeAny>(schema: T, res: HttpResponse, what: string): z.output<T> {
  const r = schema.safeParse(res.json);
  if (!r.success) throw new AdapterError(`${what}: unexpected payload (${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message})`, res.status);
  return r.data;
}

function expectOk(res: HttpResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return;
  const code = robloxErrorCode(res.json);
  if (res.status === 401) throw new AdapterError(`${what}: not authenticated (code ${code ?? '?'}) — cookie missing or expired`, 401, code);
  throw new AdapterError(`${what}: HTTP ${res.status}${code != null ? ` code ${code}` : ''}`, res.status, code);
}

function points(arr: Array<{ value: number; date: string }> | null | undefined): PricePoint[] {
  return (arr ?? [])
    .map((p) => ({ t: Date.parse(p.date), value: p.value }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => b.t - a.t);
}

export class HttpRobloxClient implements RobloxClient {
  readonly http: RateLimitedHttp;
  private csrf: string | null = null;
  private listMode: 'word' | 'number' | null = null;
  /** v1 trade detail answered 403 while v2 worked (no trading on this account): skip v1 until then. */
  private v1DetailOffUntil = 0;
  private readonly now: () => number;

  constructor(opts: RobloxClientOptions) {
    this.now = opts.deps?.now ?? Date.now;
    this.http = new RateLimitedHttp({
      name: 'roblox', globalMinTimeMs: 1000, groups: { ...ROBLOX_GROUPS }, deps: opts.deps,
      cookie: opts.cookie, onCookieRotated: opts.onCookieRotated,
    });
  }

  health(): SourceHealth[] { return this.http.health(); }

  markRestricted(group: string, note: string | null): void { this.http.markRestricted(group, note, RESTRICTED_BACKOFF_MS); }
  clearRestricted(): void { this.v1DetailOffUntil = 0; this.http.clearRestricted('tradesV1'); }
  isRestricted(group: string): boolean {
    if (group === 'tradesV1:detail') return this.now() < this.v1DetailOffUntil;
    return this.http.isRestricted(group);
  }

  private get(group: keyof typeof ROBLOX_GROUPS, url: string, auth = false) {
    return this.http.request(group, url, { auth });
  }

  // ---------------- auth ----------------
  async getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
    const res = await this.get('users', 'https://users.roblox.com/v1/users/authenticated', true);
    if (res.status === 401) return null;
    expectOk(res, 'users/authenticated');
    const u = parse(S.AuthenticatedUserSchema, res, 'users/authenticated');
    return { id: u.id, name: u.name, displayName: u.displayName ?? u.name };
  }

  // ---------------- trades (read only) ----------------
  async getTradeCount(direction: 'inbound'): Promise<number> {
    const res = await this.get('tradesV1', `https://trades.roblox.com/v1/trades/${direction}/count`, true);
    expectOk(res, 'trade count');
    return parse(S.CountSchema, res, 'trade count').count;
  }

  async listTrades(direction: TradeDirection, cursor?: string, limit: 10 | 25 | 50 | 100 = 25): Promise<Page<TradeListEntry>> {
    const qs = `limit=${limit}&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const url = (seg: string | number) => `https://trades.roblox.com/v1/trades/${seg}?${qs}`;
    let res: HttpResponse;
    if (this.listMode === 'number') {
      res = await this.get('tradesV1', url(DIRECTION_NUM[direction]), true);
    } else {
      res = await this.get('tradesV1', url(direction), true);
      if (res.status === 400 || res.status === 404) {
        const alt = await this.get('tradesV1', url(DIRECTION_NUM[direction]), true);
        if (alt.status >= 200 && alt.status < 300) { this.listMode = 'number'; res = alt; }
      } else if (res.status >= 200 && res.status < 300) this.listMode = 'word';
    }
    expectOk(res, `trades ${direction}`);
    const p = parse(S.TradeListSchema, res, `trades ${direction}`);
    return {
      nextPageCursor: p.nextPageCursor ?? null,
      previousPageCursor: p.previousPageCursor ?? null,
      data: p.data.map((t) => ({
        id: t.id,
        user: { id: t.user?.id ?? 0, name: t.user?.name ?? '', displayName: t.user?.displayName ?? t.user?.name ?? '' },
        created: S.toMs(t.created) ?? 0,
        expiration: S.toMs(t.expiration),
        isActive: t.isActive ?? false,
        statusRaw: t.status == null ? '' : String(t.status),
      })),
    };
  }

  async getTradeDetail(tradeId: TradeId, me: UserId, direction: TradeDirection): Promise<TradeSnapshot> {
    const skipV1 = this.isRestricted('tradesV1:detail');
    const [r1, r2] = await Promise.all([
      skipV1 ? Promise.resolve(null) : this.get('tradesV1', `https://trades.roblox.com/v1/trades/${tradeId}`, true),
      this.get('tradesV2', `https://trades.roblox.com/v2/trades/${tradeId}`, true),
    ]);
    if (r1?.status === 401 || r2.status === 401) expectOk(r1?.status === 401 ? r1 : r2, `trade ${tradeId}`);
    const v1 = r1 && r1.status < 300 ? S.V1DetailSchema.safeParse(r1.json) : null;
    const v2 = r2.status < 300 ? S.V2DetailSchema.safeParse(r2.json) : null;
    const d1 = v1?.success ? v1.data : null;
    const d2 = v2?.success ? v2.data : null;
    if (r1?.status === 403 && d2) {
      // Accounts that cannot trade (no Roblox Plus) get 403 on v1 details; v2 still answers. Back off v1 quietly.
      this.v1DetailOffUntil = this.now() + RESTRICTED_BACKOFF_MS;
      this.http.markRestricted('tradesV1', 'v1 trade details refused (403): this account cannot trade; using v2', RESTRICTED_BACKOFF_MS);
    }
    if (!d1 && !d2) expectOk(r1 && r1.status >= 300 ? r1 : r2, `trade ${tradeId}`);
    return buildTradeSnapshot({ tradeId, me, direction, v1: d1, v2: d2, now: this.now() });
  }

  /**
   * Throws on HTTP / parse failure: the caller keeps the last good values instead of reverting to the
   * hard-coded fallbacks. Fields Roblox leaves out are listed as not live (see mergeTradeMetadata).
   */
  async getTradeMetadata(): Promise<TradeMetadata> {
    const fb = DEFAULT_SETTINGS.tradeMetadataFallback;
    const res = await this.get('tradesMeta', 'https://trades.roblox.com/v1/trades/metadata', true);
    expectOk(res, 'trade metadata');
    const m = parse(S.MetadataSchema, res, 'trade metadata');
    const liveFields: NonNullable<TradeMetadata['liveFields']> = [];
    if (m.maxItemsPerSide != null) liveFields.push('maxItemsPerSide');
    if (m.minValueRatio != null) liveFields.push('minValueRatio');
    if (m.tradeSystemMaxRobuxPercent != null) liveFields.push('tradeSystemMaxRobuxPercent');
    if (m.tradeSystemRobuxFee != null) liveFields.push('tradeSystemRobuxFee');
    return {
      maxItemsPerSide: m.maxItemsPerSide ?? fb.maxItemsPerSide,
      minValueRatio: m.minValueRatio ?? null,
      tradeSystemMaxRobuxPercent: m.tradeSystemMaxRobuxPercent ?? fb.tradeSystemMaxRobuxPercent,
      tradeSystemRobuxFee: m.tradeSystemRobuxFee ?? fb.tradeSystemRobuxFee,
      verified: m.maxItemsPerSide != null && m.tradeSystemRobuxFee != null,
      fetchedAt: this.now(),
      liveFields,
    };
  }

  async getCanTrade(): Promise<CanTrade> {
    const res = await this.get('canTrade', 'https://trades.roblox.com/v2/users/me/can-trade', true);
    expectOk(res, 'can-trade');
    const c = parse(S.CanTradeSchema, res, 'can-trade');
    const fa = c.freeTradesAllowance;
    return {
      canTrade: c.canTrade ?? false,
      tradeEligibility: c.tradeEligibility == null ? 'Unknown' : String(c.tradeEligibility),
      freeTradesAllowance: fa ? { limit: fa.limit ?? 0, remaining: fa.remaining ?? 0, window: fa.window == null ? '' : String(fa.window) } : null,
      currencyTransferEligibility: c.currencyTransferEligibility == null ? null : typeof c.currencyTransferEligibility === 'object' ? JSON.stringify(c.currencyTransferEligibility) : String(c.currencyTransferEligibility),
    };
  }

  async getTradableItems(userId: UserId, cursor?: string): Promise<Page<TradableItem>> {
    const res = await this.get('tradable',
      `https://trades.roblox.com/v2/users/${userId}/tradableItems?limit=50&sortBy=CreationTime&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, true);
    expectOk(res, 'tradableItems');
    const p = parse(S.TradableItemsSchema, res, 'tradableItems');
    return {
      nextPageCursor: p.nextPageCursor ?? null,
      previousPageCursor: p.previousPageCursor ?? null,
      data: (p.items ?? []).map((i) => ({
        collectibleItemId: i.collectibleItemId,
        itemType: parseItemType(i.itemTarget?.itemType),
        targetId: String(i.itemTarget?.targetId ?? ''),
        itemName: i.itemName ?? '',
        originalPrice: i.originalPrice ?? null,
        recentAveragePrice: i.recentAveragePrice ?? null,
        assetStock: i.assetStock ?? null,
        instances: (i.instances ?? []).map((x) => ({ collectibleItemInstanceId: x.collectibleItemInstanceId, serialNumber: x.serialNumber || null, isOnHold: x.isOnHold ?? false })),
      })),
    };
  }

  /**
   * Own Purchase transactions, newest first. GET economy.roblox.com/v2/users/{id}/transactions?transactionType=Purchase
   * (same endpoint noblox.js getUserTransactions uses; rows: { id, created, isPending, agent, details: { id, name, type }, currency }).
   * Read-only history; never a buy call. Rows without a positive asset id or a parsable date are dropped.
   */
  async getPurchaseTransactions(userId: UserId, cursor?: string): Promise<Page<PurchaseTransaction>> {
    const res = await this.get('transactions',
      `https://economy.roblox.com/v2/users/${userId}/transactions?transactionType=Purchase&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, true);
    expectOk(res, 'transactions');
    const p = parse(S.TransactionsSchema, res, 'transactions');
    const data: PurchaseTransaction[] = [];
    for (const r of p.data ?? []) {
      const created = S.toMs(r.created ?? null);
      const assetId = Number(r.details?.id);
      const type = r.details?.type != null ? String(r.details.type) : null;
      if (created == null || !Number.isInteger(assetId) || assetId <= 0) continue;
      if (type && !/asset/i.test(type)) continue; // game passes, developer products, ...
      data.push({ id: r.id != null ? Number(r.id) : null, created, assetId, detailsType: type, name: r.details?.name ?? null });
    }
    return { data, nextPageCursor: p.nextPageCursor ?? null, previousPageCursor: p.previousPageCursor ?? null };
  }

  // ---------------- items ----------------
  private toCatalog(e: z.infer<typeof S.CatalogEntry>): CatalogItem {
    return {
      assetId: e.id, itemType: parseItemType(e.itemType), name: e.name ?? `Asset ${e.id}`,
      collectibleItemId: e.collectibleItemId || null, itemRestrictions: e.itemRestrictions ?? [],
      lowestResalePrice: e.lowestResalePrice ?? null, lowestPrice: e.lowestPrice ?? null,
      totalQuantity: e.totalQuantity ?? null, hasResellers: e.hasResellers ?? null, isOffSale: e.isOffSale ?? null,
      favoriteCount: e.favoriteCount ?? null, creatorName: e.creatorName ?? null,
      createdAt: S.toMs(e.itemCreatedUtc) ?? null,
    };
  }

  /** Single GET (shares the 10/60s catalog budget — prefer the batch). */
  async getCatalogDetail(assetId: AssetId): Promise<CatalogItem | null> {
    const res = await this.get('catalog', `https://catalog.roblox.com/v1/catalog/items/${assetId}/details?itemType=Asset`);
    if (res.status === 400 || res.status === 404) return null;
    expectOk(res, 'catalog detail');
    return this.toCatalog(parse(S.CatalogEntry, res, 'catalog detail'));
  }

  async getCatalogDetails(assetIds: AssetId[]): Promise<Map<AssetId, CatalogItem>> {
    const out = new Map<AssetId, CatalogItem>();
    const ids = [...new Set(assetIds)];
    for (let i = 0; i < ids.length; i += 120) {
      const body = { items: ids.slice(i, i + 120).map((id) => ({ itemType: 'Asset', id })) };
      const res = await this.postCatalog(body);
      for (const e of parse(S.CatalogBatchSchema, res, 'catalog batch').data) out.set(e.id, this.toCatalog(e));
    }
    return out;
  }

  private async postCatalog(body: unknown): Promise<HttpResponse> {
    const res = await this.postWithCsrf('catalog', 'https://catalog.roblox.com/v1/catalog/items/details', body, false, 'catalog batch');
    expectOk(res, 'catalog batch');
    return res;
  }

  /** POST with the X-CSRF-TOKEN handshake: a 403 carrying a new token is retried once with it. */
  private async postWithCsrf(group: keyof typeof ROBLOX_GROUPS, url: string, body: unknown, auth: boolean, what: string,
    extra: { retry429?: boolean } = {}): Promise<HttpResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = this.csrf ? { 'x-csrf-token': this.csrf } : {};
      const res = await this.http.request(group, url, { method: 'POST', body, headers, auth, ...extra });
      const tok = res.headers.get('x-csrf-token');
      if (res.status === 403 && tok && tok !== this.csrf) { this.csrf = tok; continue; }
      return res;
    }
    throw new AdapterError(`${what}: CSRF handshake failed`, 403);
  }

  async getResaleData(assetId: AssetId, collectibleItemId: CollectibleItemId | null): Promise<ResaleData | null> {
    if (collectibleItemId) {
      const res = await this.get('marketplace', `https://apis.roblox.com/marketplace-sales/v1/item/${encodeURIComponent(collectibleItemId)}/resale-data`);
      if (res.status === 400 || res.status === 404) return null;
      expectOk(res, 'marketplace resale-data');
      return this.toResale(parse(S.ResaleSchema, res, 'marketplace resale-data'), 'marketplace_sales');
    }
    const res = await this.get('economy', `https://economy.roblox.com/v1/assets/${assetId}/resale-data`);
    if (res.status === 400 || res.status === 404) return null; // 400 code 5 = migrated/invalid: no data
    expectOk(res, 'economy resale-data');
    const r = this.toResale(parse(S.ResaleSchema, res, 'economy resale-data'), 'economy_fallback');
    return r.stale && r.priceDataPoints.length === 0 ? null : r;
  }

  private toResale(r: z.infer<typeof S.ResaleSchema>, source: ResaleData['source']): ResaleData {
    // value <= 0 points are placeholders (e.g. the series-origin point), not sales.
    const price = points(r.priceDataPoints).filter((p) => p.value > 0);
    const volume = points(r.volumeDataPoints);
    const newest = price[0]?.t ?? null;
    return {
      source, recentAveragePrice: r.recentAveragePrice, originalPrice: r.originalPrice ?? null,
      assetStock: r.assetStock ?? null, numberRemaining: r.numberRemaining ?? null, sales: r.sales ?? null,
      priceDataPoints: price, volumeDataPoints: volume, newestPointAt: newest,
      stale: newest == null ? source === 'economy_fallback' : this.now() - newest > STALE_MS,
    };
  }

  async getResellers(collectibleItemId: CollectibleItemId, limit = 30): Promise<{ rows: Reseller[]; capped: boolean }> {
    const rows: Reseller[] = [];
    let cursor: string | null = null;
    do {
      const pageSize = Math.min(100, Math.max(10, limit - rows.length));
      const res = await this.get('marketplace',
        `https://apis.roblox.com/marketplace-sales/v1/item/${encodeURIComponent(collectibleItemId)}/resellers?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expectOk(res, 'resellers');
      const p = parse(S.ResellersSchema, res, 'resellers');
      for (const r of p.data) rows.push({ price: r.price, serialNumber: r.serialNumber || null, collectibleItemInstanceId: r.collectibleItemInstanceId ?? null, sellerId: r.seller?.sellerId ?? null });
      cursor = p.nextPageCursor ?? null;
    } while (cursor && rows.length < limit);
    rows.sort((a, b) => a.price - b.price);
    return { rows: rows.slice(0, limit), capped: cursor != null };
  }

  async getOwners(assetId: AssetId, maxPages = 3): Promise<OwnerRow[]> {
    const out: OwnerRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get('owners',
        `https://inventory.roblox.com/v2/assets/${assetId}/owners?limit=100&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, true);
      expectOk(res, 'owners');
      const p = parse(S.OwnersSchema, res, 'owners');
      for (const r of p.data) out.push({ userAssetId: r.id, serialNumber: r.serialNumber || null, ownerId: r.owner?.id ?? null, updated: S.toMs(r.updated) ?? 0, created: S.toMs(r.created) ?? 0 });
      cursor = p.nextPageCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async getThumbnails(assetIds: AssetId[]): Promise<Map<AssetId, string | null>> {
    const out = new Map<AssetId, string | null>();
    const ids = [...new Set(assetIds)];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.get('thumbnails', `https://thumbnails.roblox.com/v1/assets?assetIds=${ids.slice(i, i + 100).join(',')}&size=150x150&format=Png&isCircular=false`);
      expectOk(res, 'thumbnails');
      for (const r of parse(S.ThumbsSchema, res, 'thumbnails').data) out.set(r.targetId, r.state === 'Completed' ? r.imageUrl ?? null : null);
    }
    return out;
  }

  // ---------------- drops (read-only discovery) ----------------
  /**
   * Collectibles sorted by recently updated; `robloxOnly` restricts to Roblox-made (tradable) items, `creator` to one
   * watched creator. A 429 is thrown at once as RateLimitError (never retried inside the same 60 s window).
   */
  async searchCollectibles(opts: CatalogSearchOpts): Promise<CatalogSearchItem[]> {
    const c = opts.creator ?? (opts.robloxOnly ? { id: 1, type: 'User' as const } : null);
    const creator = c ? `&creatorTargetId=${Math.trunc(c.id)}&creatorType=${c.type}` : '';
    const nfs = opts.includeNotForSale ? '&includeNotForSale=true' : '';
    const res = await this.http.request('catalogSearch',
      `https://catalog.roblox.com/v2/search/items/details?category=All&salesTypeFilter=2&sortType=3&limit=${opts.limit ?? 30}${creator}${nfs}`, { retry429: false });
    expectOk(res, 'catalog search');
    return parse(S.CatalogSearchSchema, res, 'catalog search').data.map((r) => ({
      assetId: r.id, itemType: parseItemType(r.itemType), name: r.name ?? `Item ${r.id}`,
      collectibleItemId: r.collectibleItemId || null, itemRestrictions: r.itemRestrictions ?? [],
      creatorName: r.creatorName ?? '', creatorId: r.creatorTargetId ?? null, creatorType: r.creatorType ?? null,
      creatorVerified: r.creatorHasVerifiedBadge ?? false, price: r.price, lowestResalePrice: r.lowestResalePrice,
      remaining: r.unitsAvailableForConsumption, totalQuantity: r.totalQuantity, favoriteCount: r.favoriteCount,
      offSaleDeadline: parseDeadline(r.offSaleDeadline), saleLocation: r.saleLocationType == null ? null : String(r.saleLocationType),
      hasResellers: r.hasResellers ?? null, createdAt: S.toMs(r.itemCreatedUtc),
      offSale: r.isOffSale ?? (r.priceStatus ? r.priceStatus === 'Off Sale' : null),
    }));
  }

  searchRate(): RateInfo | null { return this.http.rateInfo('catalogSearch'); }

  /** Watchlist creator by numeric id or exact name. Read-only lookups (users / groups), no cookie. */
  async lookupCreator(query: string, type: 'User' | 'Group'): Promise<{ id: number; type: 'User' | 'Group'; name: string } | null> {
    const q = query.trim();
    if (!q) return null;
    if (/^\d{1,15}$/.test(q)) {
      const id = Number(q);
      if (type === 'User') { const u = await this.getUser(id); return u ? { id, type, name: u.name } : null; }
      const res = await this.get('groups', `https://groups.roblox.com/v1/groups/${id}`);
      if (res.status === 400 || res.status === 404) return null;
      expectOk(res, 'group');
      return { id, type, name: parse(S.GroupSchema, res, 'group').name };
    }
    if (type === 'User') {
      const res = await this.http.request('users', 'https://users.roblox.com/v1/usernames/users',
        { method: 'POST', body: { usernames: [q], excludeBannedUsers: true }, auth: false });
      expectOk(res, 'usernames');
      const u = parse(S.UsernamesSchema, res, 'usernames').data[0];
      return u ? { id: u.id, type, name: u.name } : null;
    }
    const res = await this.get('groups', `https://groups.roblox.com/v1/groups/search/lookup?groupName=${encodeURIComponent(q)}`);
    expectOk(res, 'group lookup');
    const rows = parse(S.GroupLookupSchema, res, 'group lookup').data ?? [];
    const g = rows.find((x) => x.name.toLowerCase() === q.toLowerCase()) ?? rows[0];
    return g ? { id: g.id, type, name: g.name } : null;
  }

  /** Stock / per-user limit / lowest resale by collectibleItemId. Unauthenticated read-only lookup. */
  async getMarketplaceItems(ids: CollectibleItemId[]): Promise<Map<CollectibleItemId, MarketplaceItemStock>> {
    const out = new Map<CollectibleItemId, MarketplaceItemStock>();
    const uniq = [...new Set(ids)].filter(Boolean);
    for (let i = 0; i < uniq.length; i += 30) {
      const res = await this.http.request('marketplaceItems', 'https://apis.roblox.com/marketplace-items/v1/items/details',
        { method: 'POST', body: { itemIds: uniq.slice(i, i + 30) }, auth: false });
      expectOk(res, 'marketplace-items');
      for (const r of parse(S.MarketplaceItemsSchema, res, 'marketplace-items')) {
        out.set(r.collectibleItemId, {
          collectibleItemId: r.collectibleItemId, price: r.price, remaining: r.unitsAvailableForConsumption,
          totalQuantity: r.assetStock, sales: r.sales, limitPerUser: r.quantityLimitPerUser,
          lowestResalePrice: r.lowestResalePrice, hasResellers: r.hasResellers ?? null,
          offSaleDeadline: parseDeadline(r.offSaleDeadline), saleLocation: r.saleLocationType == null ? null : String(r.saleLocationType),
          saleStatus: saleStatusFrom(r.productSaleStatus), releaseAt: parseScheduledRelease(r.scheduledRelease),
        });
      }
    }
    return out;
  }

  // ---------------- users / inventory ----------------
  async getCollectibles(userId: UserId): Promise<CollectibleInstance[] | 'hidden'> {
    const out: CollectibleInstance[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const res = await this.get('collectibles',
        `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, true);
      if (res.status === 403) return 'hidden';
      expectOk(res, 'collectibles');
      const p = parse(S.CollectiblesSchema, res, 'collectibles');
      for (const r of p.data) out.push({
        userAssetId: r.userAssetId, assetId: r.assetId, name: r.name ?? `Asset ${r.assetId}`, serialNumber: r.serialNumber || null,
        recentAveragePrice: r.recentAveragePrice ?? 0, originalPrice: r.originalPrice ?? null, assetStock: r.assetStock ?? null,
        isOnHold: r.isOnHold ?? false,
      });
      cursor = p.nextPageCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async canViewInventory(userId: UserId): Promise<boolean> {
    const res = await this.get('canView', `https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`, true);
    expectOk(res, 'can-view-inventory');
    return parse(S.CanViewSchema, res, 'can-view-inventory');
  }

  async getUser(userId: UserId): Promise<UserProfile | null> {
    const res = await this.get('users', `https://users.roblox.com/v1/users/${userId}`);
    if (res.status === 404 || res.status === 400) return null;
    expectOk(res, 'user');
    const u = parse(S.UserSchema, res, 'user');
    return { id: u.id, name: u.name, displayName: u.displayName ?? u.name, created: S.toMs(u.created) ?? 0, isBanned: u.isBanned ?? false, hasVerifiedBadge: u.hasVerifiedBadge ?? false };
  }
}
