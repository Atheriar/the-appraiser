/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Drops feed: detects new limited releases by polling the public collectibles catalog search and keeps
 * their stock fresh from marketplace-items details. READ-ONLY: no purchase endpoint exists anywhere in
 * this app. A matching drop raises a desktop notification whose click opens the roblox.com catalog page,
 * where the user decides and buys it themselves.
 *
 * Sources:
 *  - two global feeds (Roblox-made, all creators), together <= 6 searches / min;
 *  - a creator watchlist, one creator per tick, only from the spare part of the 12 / 60 s search budget;
 *  - a timed-release watcher: drops announced with a future scheduledRelease are rechecked directly by id
 *    (marketplace-items, separate 60 / 60 s budget) around the release time and alerted when buyable.
 */
import type { CatalogSearchItem, CatalogSearchOpts, MarketplaceItemStock, RobloxClient } from '../adapters/interfaces.js';
import { AdapterError, RateLimitError } from '../adapters/limiter.js';
import { catalogUrl, dropKey, IN_GAME_ONLY, isPurchasable, isRecent, isSoldOut, isTradable, isUpcoming, matchesNotify } from '../core/drops.js';
import type { DropItem, Settings } from '../core/types.js';
import type { SqliteRepository } from '../db/sqlite.js';
import { errMsg, type Logger } from '../server/log.js';
import type { Notifier } from '../server/notify.js';

export type DropFeed = 'roblox' | 'all';

export interface DropsStatus {
  /** 'ok' | 'paused' (disabled in Settings) | 'error' (last poll failed) | 'ratelimited' (429, waiting for the window) | 'starting' | 'off' (no Roblox client). */
  state: 'ok' | 'paused' | 'error' | 'ratelimited' | 'starting' | 'off';
  lastPollAt: number | null;
  lastError: string | null;
  feeds: Record<DropFeed, { lastPollAt: number | null; lastError: string | null; seeded: boolean; lastPage?: Set<string> }>;
  tracked: number;
  /** Catalog searches paused until this time after a 429 (null when not limited). */
  rateLimitedUntil: number | null;
  /** Catalog searches made by this app in the last 60 s (budget 12 / 60 s per IP). */
  searchesLastMin: number;
  /** x-ratelimit-remaining as last reported by Roblox (minus our searches since), null if unknown. */
  searchRemaining: number | null;
  creators: { count: number; next: string | null; lastPollAt: number | null; lastName: string | null; skipped: number };
  /** Drops currently waiting for a scheduled release. */
  upcoming: number;
}

export interface DropsDeps {
  repo: SqliteRepository;
  settings: () => Settings;
  roblox: () => RobloxClient | null;
  notifier: Notifier;
  log: Logger;
  /** Local UI base (summary toast opens the Drops tab). */
  uiUrl: string;
  now?: () => number;
}

const fmtRobux = (n: number | null): string => (n == null ? 'price unknown' : n === 0 ? 'free' : `R$${n.toLocaleString('en-US')}`);

/** Max toasts per poll; the rest are summarised in one. */
const MAX_TOASTS = 3;
/** Sold-out drops still get their lowest resale refreshed, at most this often. */
const SOLD_OUT_REFRESH_MS = 60_000;
/** marketplace-items ids per refresh run (2 POSTs of 30). */
const STOCK_MAX_PER_RUN = 60;
/** Catalog search: 12 / 60 s per IP (fixed window), shared by every search this app makes. */
export const SEARCH_LIMIT = 12;
/** The two feeds together stay at or below this many searches per minute; the watchlist gets the rest. */
export const FEED_MAX_PER_MIN = 6;
/** A creator search only runs while at least this many searches stay free (burst page + headroom). */
export const CREATOR_RESERVE = 3;
/** Old off-sale rows probed per search for a scheduled release (marketplace-items, one POST). */
const RELEASE_PROBE_MAX = 30;

/**
 * Release watcher cadence around a scheduled release time R: wait between direct marketplace-items
 * checks of that id. Null = outside the fast window (the regular stock refresh covers it).
 */
export function releaseCheckGapMs(now: number, releaseAt: number): number | null {
  const dt = now - releaseAt;
  if (dt < -10 * 60_000) return null;     // > 10 min out
  if (dt < -60_000) return 30_000;        // 10 .. 1 min before
  if (dt < -5_000) return 10_000;         // last minute
  if (dt < 120_000) return 2_500;         // 5 s before .. 2 min after: every 2.5 s
  if (dt < 10 * 60_000) return 15_000;    // stragglers (sale state can flip late)
  return null;
}

/** Feed intervals scaled up (never down) so the two feeds together stay <= FEED_MAX_PER_MIN. */
export function feedIntervals(s: Settings['drops']): { roblox: number; all: number } {
  const rate = 60_000 / s.robloxPollMs + (s.includeUgc ? 60_000 / s.allPollMs : 0);
  const k = rate > FEED_MAX_PER_MIN ? rate / FEED_MAX_PER_MIN : 1;
  return { roblox: Math.ceil(s.robloxPollMs * k), all: Math.ceil(s.allPollMs * k) };
}

const creatorKey = (c: { id: number | null; type: string | null }) => `${c.type ?? 'User'}:${c.id}`;

export class DropsJob {
  private readonly now: () => number;
  private feeds: DropsStatus['feeds'] = {
    roblox: { lastPollAt: null, lastError: null, seeded: false },
    all: { lastPollAt: null, lastError: null, seeded: false },
  };
  private lastStockError: string | null = null;
  /** Drops whose notification failed: key -> attempts so far (retried on the next polls, max 3). */
  private retry = new Map<string, number>();
  /** Our catalog searches in the last minute (local view of the shared 12 / 60 s budget). */
  private searchLog: number[] = [];
  private rateLimitedUntil = 0;
  private creatorIdx = 0;
  private creatorSeeded = new Set<string>();
  private creatorState = { lastPollAt: null as number | null, lastName: null as string | null, lastError: null as string | null, skipped: 0 };
  /** key -> last direct release check. */
  private releaseChecked = new Map<string, number>();
  /** collectibleItemIds already probed for a scheduled release (old off-sale rows). */
  private probed = new Set<string>();
  private demoLive = false;

  constructor(private readonly d: DropsDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Demo: pretend the feeds and the watchlist have polled. */
  markDemoPolled(at: number): void {
    for (const f of Object.values(this.feeds)) { f.lastPollAt = at; f.seeded = true; }
    this.creatorState.lastPollAt = at;
    this.creatorState.lastName = this.d.settings().drops.creators[0]?.name ?? null;
    this.demoLive = true;
  }

  /** Demo / tests: behave as if Roblox answered 429 until `until`. */
  simulateRateLimit(until: number): void { this.rateLimitedUntil = until; }

  status(): DropsStatus {
    const s = this.d.settings().drops;
    const now = this.now();
    const feeds = structuredClone(this.feeds);
    for (const f of Object.values(feeds)) delete f.lastPage;
    if (this.demoLive) { const t = now - ((now / 1000) % 10) * 1000; feeds.roblox.lastPollAt = t; feeds.all.lastPollAt = t; } // demo: looks live
    const last = Math.max(feeds.roblox.lastPollAt ?? 0, feeds.all.lastPollAt ?? 0) || null;
    const limited = this.rateLimitedUntil > now;
    const err = limited ? null
      : feeds.roblox.lastError ?? (s.includeUgc ? feeds.all.lastError : null) ?? this.creatorState.lastError ?? this.lastStockError;
    const state: DropsStatus['state'] = !s.enabled ? 'paused'
      : !this.d.roblox() && last == null ? 'off'
        : limited ? 'ratelimited'
          : err ? 'error' : last == null ? 'starting' : 'ok';
    const cs = s.creators;
    return {
      state, lastPollAt: last, lastError: err, feeds, tracked: this.d.repo.countDrops(),
      rateLimitedUntil: limited ? this.rateLimitedUntil : null,
      searchesLastMin: this.searchesInWindow(now),
      searchRemaining: this.headerRemaining(now),
      creators: {
        count: cs.length, next: cs.length ? cs[this.creatorIdx % cs.length]!.name : null,
        lastPollAt: this.creatorState.lastPollAt, lastName: this.creatorState.lastName, skipped: this.creatorState.skipped,
      },
      upcoming: this.recent(now).filter((x) => isUpcoming(x, now)).length,
    };
  }

  // ------------------------------------------------------------------ search budget
  private searchesInWindow(now: number): number {
    this.searchLog = this.searchLog.filter((t) => now - t < 60_000);
    return this.searchLog.length;
  }

  /** Roblox's own count (x-ratelimit-remaining) minus the searches we made since that response. */
  private headerRemaining(now: number): number | null {
    const r = this.d.roblox()?.searchRate?.();
    if (!r || r.remaining == null || r.resetAt == null || r.resetAt <= now) return null;
    return Math.max(0, r.remaining - this.searchLog.filter((t) => t > r.at).length);
  }

  /** May a search of this kind run now? Feeds may use the whole budget; the watchlist only what is spare. */
  canSearch(kind: 'feed' | 'creator'): boolean {
    const now = this.now();
    if (this.rateLimitedUntil > now) return false;
    const used = this.searchesInWindow(now);
    const hdr = this.headerRemaining(now);
    if (kind === 'feed') return used < SEARCH_LIMIT && (hdr == null || hdr > 0);
    return used < SEARCH_LIMIT - CREATOR_RESERVE && (hdr == null || hdr > CREATOR_RESERVE);
  }

  /** One catalog search through the budget. A 429 pauses every search until the window resets (never retried inside it). */
  private async search(roblox: RobloxClient, opts: CatalogSearchOpts): Promise<CatalogSearchItem[]> {
    this.searchLog.push(this.now());
    try {
      return await roblox.searchCollectibles!(opts);
    } catch (e) {
      if (e instanceof AdapterError && e.status === 429) {
        const until = e instanceof RateLimitError ? e.resetAt : this.now() + 60_000;
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, until);
        this.d.log.warn(`drops: catalog search rate-limited, searches paused for ${Math.ceil((this.rateLimitedUntil - this.now()) / 1000)}s`);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ feeds
  /** One catalog search; new rows created within the window are stored and (after the silent first poll) notified. */
  async pollFeed(feed: DropFeed): Promise<DropItem[]> {
    const s = this.d.settings().drops;
    const roblox = this.d.roblox();
    // Paused (or UGC feed off): forget the seed so resuming re-seeds silently instead of alerting a backlog.
    if (!s.enabled) {
      for (const f of Object.values(this.feeds)) { f.seeded = false; f.lastPage = undefined; }
      this.creatorSeeded.clear();
      return [];
    }
    if (!roblox?.searchCollectibles) return [];
    const st = this.feeds[feed];
    if (feed === 'all' && !s.includeUgc) { st.seeded = false; st.lastPage = undefined; return []; }
    if (!this.canSearch('feed')) return []; // rate-limited or budget spent: skip this tick quietly
    let rows: CatalogSearchItem[];
    try {
      rows = await this.search(roblox, { robloxOnly: feed === 'roblox', limit: 30 });
      st.lastError = null;
    } catch (e) {
      if (e instanceof AdapterError && e.status === 429) return []; // shown as 'ratelimited', not as an error
      st.lastError = errMsg(e);
      throw e;
    }
    // Burst: no overlap with the previous page means >30 items changed since then and a drop may be on page 2.
    // One extra search (limit=120, same cost) from the spare budget; best effort.
    const ids = (rs: CatalogSearchItem[]) => rs.map((r) => `${r.itemType}:${r.assetId}`);
    if (st.lastPage && rows.length >= 30 && !ids(rows).some((k) => st.lastPage!.has(k)) && this.canSearch('feed')) {
      try {
        rows = await this.search(roblox, { robloxOnly: feed === 'roblox', limit: 120 });
        this.d.log.info(`drops ${feed}: burst (no overlap with last poll), fetched 120 rows`);
      } catch (e) { this.d.log.warn(`drops ${feed}: burst page failed`, errMsg(e)); }
    }
    st.lastPage = new Set(ids(rows));
    st.lastPollAt = this.now();
    const seeded = st.seeded;
    st.seeded = true;
    return this.ingest(roblox, rows, feed, seeded);
  }

  /**
   * Creator watchlist: one creator per call, round-robin, only from the spare search budget. Includes items not
   * for sale yet so announced (timed) releases are found and handed to the release watcher.
   */
  async pollCreators(): Promise<DropItem[]> {
    const s = this.d.settings().drops;
    const roblox = this.d.roblox();
    if (!s.enabled || !s.creators.length || !roblox?.searchCollectibles) return [];
    if (!this.canSearch('creator')) { this.creatorState.skipped++; return []; }
    const c = s.creators[this.creatorIdx % s.creators.length]!;
    this.creatorIdx = (this.creatorIdx + 1) % s.creators.length;
    let rows: CatalogSearchItem[];
    try {
      rows = await this.search(roblox, { robloxOnly: false, creator: { id: c.id, type: c.type }, includeNotForSale: true, limit: 30 });
      this.creatorState.lastError = null;
    } catch (e) {
      if (e instanceof AdapterError && e.status === 429) return [];
      this.creatorState.lastError = `${c.name}: ${errMsg(e)}`;
      throw e;
    }
    this.creatorState.lastPollAt = this.now();
    this.creatorState.lastName = c.name;
    const k = creatorKey(c);
    const seeded = this.creatorSeeded.has(k);
    this.creatorSeeded.add(k);
    return this.ingest(roblox, rows, 'creator', seeded);
  }

  /** Store search rows; returns (and notifies, unless this is a silent seed) the drops not seen before. */
  private async ingest(roblox: RobloxClient, rows: CatalogSearchItem[], source: 'roblox' | 'all' | 'creator', seeded: boolean): Promise<DropItem[]> {
    const s = this.d.settings().drops;
    const now = this.now();
    const watched = new Set(s.creators.map(creatorKey));
    const fresh: DropItem[] = [];
    const probe: CatalogSearchItem[] = [];
    for (const r of rows) {
      const { prev, key } = this.findExisting(r);
      // sortType=3 also surfaces old items being updated. An old off-sale row may be an announced timed release:
      // probe it once for scheduledRelease (marketplace-items, separate budget) instead of ignoring it.
      if (r.createdAt != null && now - r.createdAt > s.newWindowMs && !prev) {
        if (r.collectibleItemId && r.offSale === true && !this.probed.has(r.collectibleItemId)) probe.push(r);
        continue;
      }
      // No creation date from Roblox: treat as first seen now (isRecent falls back to firstSeenAt), but only once.
      if (r.createdAt == null) {
        if (prev && !isRecent(prev, s.newWindowMs, now) && !isUpcoming(prev, now)) continue;
        if (!prev) this.d.log.info(`drop without createdAt treated as new: ${r.itemType} ${r.assetId}`);
      }
      const next = mergeSearch(prev, r, key, now);
      if (!prev) { next.source = source; next.seenLive = seeded; }
      if (watched.has(creatorKey({ id: r.creatorId, type: r.creatorType }))) next.watched = true;
      this.d.repo.upsertDrop(next);
      if (!prev) fresh.push(next);
    }
    if (probe.length) await this.probeReleases(roblox, probe.slice(0, RELEASE_PROBE_MAX), source, watched);
    if (fresh.length) {
      await this.fillThumbnails(roblox, fresh);
      // Per-user limit, exact stock and the scheduled release only come from marketplace-items: fetch them right away.
      await this.refreshStock(new Set(fresh.map((f) => f.key))).catch(() => undefined);
    }
    if (!seeded) return []; // first poll after start: record silently, no alert flood
    const out = fresh.map((f) => this.d.repo.getDrop(f.key) ?? f);
    const retries = [...this.retry.keys()].filter((k) => !fresh.some((f) => f.key === k))
      .map((k) => this.d.repo.getDrop(k)).filter((x): x is DropItem => !!x);
    await this.notify([...out, ...retries]);
    return out;
  }

  /** Old off-sale rows: keep only those Roblox has scheduled to release in the future. */
  private async probeReleases(roblox: RobloxClient, rows: CatalogSearchItem[], source: DropItem['source'], watched: Set<string>): Promise<void> {
    if (!roblox.getMarketplaceItems) return;
    for (const r of rows) this.probed.add(r.collectibleItemId!);
    let stock: Map<string, MarketplaceItemStock>;
    try { stock = await roblox.getMarketplaceItems(rows.map((r) => r.collectibleItemId!)); } catch (e) {
      this.d.log.warn('release probe failed', errMsg(e));
      return;
    }
    const now = this.now();
    const found: DropItem[] = [];
    for (const r of rows) {
      const m = stock.get(r.collectibleItemId!);
      if (m?.releaseAt == null || m.releaseAt <= now || m.saleStatus === 'onSale') continue;
      const key = dropKey(r.collectibleItemId, r.itemType, r.assetId);
      const d = mergeStock({ ...mergeSearch(null, r, key, now), source, seenLive: false }, m, now);
      if (watched.has(creatorKey({ id: r.creatorId, type: r.creatorType }))) d.watched = true;
      this.d.repo.upsertDrop(d);
      found.push(d);
      this.d.log.info(`drops: upcoming release found: ${d.name} at ${new Date(m.releaseAt).toISOString()}`);
    }
    if (found.length) await this.fillThumbnails(roblox, found);
  }

  /**
   * Existing row for a search result under either key form. A row first stored as `itemType:assetId`
   * (no collectibleItemId yet) is moved to the collectibleItemId key once one appears, so it is never duplicated.
   */
  private findExisting(r: CatalogSearchItem): { prev: DropItem | null; key: string } {
    const key = dropKey(r.collectibleItemId, r.itemType, r.assetId);
    const direct = this.d.repo.getDrop(key);
    if (direct) return { prev: direct, key };
    const other = this.d.repo.findDropByAsset(r.itemType, r.assetId);
    if (!other) return { prev: null, key };
    if (r.collectibleItemId && other.key !== key) {
      this.d.repo.deleteDrop(other.key);
      return { prev: { ...other, key, collectibleItemId: other.collectibleItemId ?? r.collectibleItemId }, key };
    }
    return { prev: other, key: other.key };
  }

  /** Stored drops in the window, plus anything with a scheduled release (which may be older than the window). */
  private recent(now: number): DropItem[] {
    const s = this.d.settings().drops;
    const byKey = new Map<string, DropItem>();
    for (const x of this.d.repo.listDrops({ sinceMs: now - s.newWindowMs, limit: 1000 })) byKey.set(x.key, x);
    for (const x of this.d.repo.listDropsWithRelease(now - s.newWindowMs)) byKey.set(x.key, x);
    return [...byKey.values()];
  }

  /** Refresh stock / limit / lowest resale for recent drops (in-stock first, newest first). */
  async refreshStock(only?: Set<string>): Promise<number> {
    const s = this.d.settings().drops;
    const roblox = this.d.roblox();
    if (!s.enabled || !roblox?.getMarketplaceItems) return 0;
    const now = this.now();
    const cand = this.recent(now)
      .filter((x) => x.collectibleItemId && (only ? only.has(x.key) : (!x.soldOutAt || now - (x.stockUpdatedAt ?? 0) >= SOLD_OUT_REFRESH_MS)))
      .sort((a, b) => Number(!!a.soldOutAt) - Number(!!b.soldOutAt) || (b.createdAt ?? b.firstSeenAt) - (a.createdAt ?? a.firstSeenAt))
      .slice(0, STOCK_MAX_PER_RUN);
    if (!cand.length) return 0;
    let stock: Map<string, MarketplaceItemStock>;
    try {
      stock = await roblox.getMarketplaceItems(cand.map((x) => x.collectibleItemId!));
      this.lastStockError = null;
    } catch (e) {
      this.lastStockError = errMsg(e);
      throw e;
    }
    return this.applyStock(cand, stock, now);
  }

  /** Merge marketplace-items rows; an upcoming drop that became purchasable is alerted right away. */
  private async applyStock(cand: DropItem[], stock: Map<string, MarketplaceItemStock>, now: number): Promise<number> {
    let n = 0;
    const released: DropItem[] = [];
    for (const x of cand) {
      const m = stock.get(x.collectibleItemId!);
      if (!m) continue;
      const cur = this.d.repo.getDrop(x.key) ?? x;
      // Waiting = announced timed release, or a live-seen drop that was not on sale yet and never alerted.
      const wasUpcoming = isUpcoming(cur, now) || (!!cur.seenLive && !cur.notifiedAt && (cur.saleStatus === 'pending' || cur.saleStatus === 'offSale'));
      const next = mergeStock(cur, m, now);
      if (wasUpcoming && !isUpcoming(next, now) && isPurchasable(next, now)) {
        next.releasedAt = now;
        released.push(next);
        this.d.log.info(`drops: ${next.name} is on sale (scheduled ${next.releaseAt ? new Date(next.releaseAt).toISOString() : '?'}, seen ${now - (next.releaseAt ?? now)} ms after)`);
      }
      this.d.repo.upsertDrop(next);
      n++;
    }
    if (released.length) await this.notify(released);
    return n;
  }

  /**
   * Timed-release watcher (run every second; usually a no-op). Rechecks upcoming drops directly by id around
   * their scheduled release (marketplace-items POST, 60 / 60 s, separate from the catalog search budget).
   */
  async watchReleases(): Promise<number> {
    const s = this.d.settings().drops;
    if (!s.enabled) return 0;
    const now = this.now();
    if (this.demoLive) return this.demoRelease(now);
    const roblox = this.d.roblox();
    if (!roblox?.getMarketplaceItems) return 0;
    const due = this.recent(now).filter((x) => {
      if (!x.collectibleItemId || x.releaseAt == null || !isUpcoming(x, now)) return false;
      const gap = releaseCheckGapMs(now, x.releaseAt);
      return gap != null && now - (this.releaseChecked.get(x.key) ?? 0) >= gap;
    }).slice(0, 30);
    if (!due.length) return 0;
    for (const x of due) this.releaseChecked.set(x.key, now);
    let stock: Map<string, MarketplaceItemStock>;
    try { stock = await roblox.getMarketplaceItems(due.map((x) => x.collectibleItemId!)); } catch (e) {
      this.d.log.warn('release recheck failed', errMsg(e));
      return 0;
    }
    return this.applyStock(due, stock, now);
  }

  /** Demo: upcoming demo drops go on sale at their release time (no network). */
  private async demoRelease(now: number): Promise<number> {
    const due = this.recent(now).filter((x) => x.collectibleItemId && x.releaseAt != null && x.releaseAt <= now && isUpcoming(x, now));
    if (!due.length) return 0;
    const stock = new Map<string, MarketplaceItemStock>(due.map((x) => [x.collectibleItemId!, {
      collectibleItemId: x.collectibleItemId!, price: x.price, remaining: x.totalQuantity, totalQuantity: x.totalQuantity, sales: 0,
      limitPerUser: x.limitPerUser, lowestResalePrice: null, hasResellers: false, offSaleDeadline: x.offSaleDeadline, saleLocation: x.saleLocation,
      saleStatus: 'onSale', releaseAt: x.releaseAt,
    }]));
    return this.applyStock(due, stock, now);
  }

  private async fillThumbnails(roblox: RobloxClient, drops: DropItem[]): Promise<void> {
    const ids = drops.filter((x) => x.itemType === 'Asset' && !x.thumbnailUrl).map((x) => x.assetId);
    if (!ids.length) return;
    try {
      const th = await roblox.getThumbnails(ids);
      for (const x of drops) {
        const url = th.get(x.assetId);
        if (url) { x.thumbnailUrl = url; this.d.repo.upsertDrop({ ...(this.d.repo.getDrop(x.key) ?? x), thumbnailUrl: url }); }
      }
    } catch (e) { this.d.log.warn('drop thumbnails failed', errMsg(e)); }
  }

  private async notify(fresh: DropItem[]): Promise<void> {
    const s = this.d.settings().drops;
    const now = this.now();
    // Upcoming drops are not alerted yet: the release watcher alerts the moment they can be bought.
    // Not buyable yet (announced, pending or off sale): no alert now; applyStock alerts once it goes on sale.
    const hits = fresh.filter((x) => !x.notifiedAt && !isUpcoming(x, now) && x.saleStatus !== 'pending' && x.saleStatus !== 'offSale' && matchesNotify(x, s));
    for (const x of fresh) if (!hits.includes(x)) this.retry.delete(x.key); // sold out / filtered since: stop retrying
    if (!hits.length) return;
    const failed = (x: DropItem, e: unknown) => {
      const n = (this.retry.get(x.key) ?? 0) + 1;
      if (n >= 3) this.retry.delete(x.key); else this.retry.set(x.key, n);
      this.d.log.warn(`drop notify failed (attempt ${n}/3)`, errMsg(e));
    };
    const mark = (x: DropItem) => {
      this.retry.delete(x.key);
      const cur = this.d.repo.getDrop(x.key) ?? x;
      this.d.repo.upsertDrop({ ...cur, notifiedAt: this.now() });
    };
    for (const x of hits.slice(0, MAX_TOASTS)) {
      const stock = x.remaining != null && x.totalQuantity ? `${x.remaining.toLocaleString('en-US')}/${x.totalQuantity.toLocaleString('en-US')} left` : 'stock unknown';
      const limit = x.limitPerUser ? `, limit ${x.limitPerUser}/user` : '';
      const kind = x.tradable ? 'tradable limited' : 'UGC limited';
      await this.d.notifier.notify(
        x.releasedAt ? `On sale now (${kind}): ${x.name}` : `New ${kind}: ${x.name}`,
        `${fmtRobux(x.price)} · ${stock}${limit}${x.inGameOnly ? ' · in-game only' : ''}. Click to open on roblox.com (you buy it yourself).`,
        catalogUrl(x.assetId, x.itemType),
      ).then(() => mark(x), (e) => failed(x, e));
    }
    const rest = hits.slice(MAX_TOASTS);
    if (rest.length) {
      await this.d.notifier.notify(`${rest.length} more new drops`, 'Open the Drops tab to see them.', `${this.d.uiUrl}/#drops`)
        .then(() => rest.forEach(mark), (e) => rest.forEach((x) => failed(x, e)));
    }
  }

  /** Recent drops plus upcoming ones (upcoming first, then newest first). */
  list(limit = 300): DropItem[] {
    const s = this.d.settings().drops;
    const now = this.now();
    const t = (x: DropItem) => x.createdAt ?? x.firstSeenAt;
    return this.recent(now).filter((x) => isRecent(x, s.newWindowMs, now) || isUpcoming(x, now))
      .sort((a, b) => Number(isUpcoming(b, now)) - Number(isUpcoming(a, now))
        || (isUpcoming(a, now) ? (a.releaseAt ?? 0) - (b.releaseAt ?? 0) : t(b) - t(a)))
      .slice(0, limit);
  }
}

export function mergeSearch(prev: DropItem | null, r: CatalogSearchItem, key: string, now: number): DropItem {
  const base: DropItem = prev ?? {
    key, assetId: r.assetId, itemType: r.itemType, collectibleItemId: r.collectibleItemId, name: r.name,
    creatorName: r.creatorName, creatorId: r.creatorId, creatorType: r.creatorType, creatorVerified: r.creatorVerified,
    tradable: isTradable(r.creatorId, r.creatorType, r.itemRestrictions), restrictions: r.itemRestrictions,
    price: null, totalQuantity: null, remaining: null, sales: null, limitPerUser: null, saleLocation: null, inGameOnly: false,
    offSaleDeadline: null, lowestResalePrice: null, hasResellers: null, favoriteCount: null, thumbnailUrl: null,
    createdAt: r.createdAt, firstSeenAt: now, updatedAt: now, stockUpdatedAt: null, soldOutAt: null, notifiedAt: null,
  };
  // Marketplace-items stock is fresher than search; only take search stock when it is newer than the last stock refresh.
  const takeStock = base.stockUpdatedAt == null || now - base.stockUpdatedAt > 30_000;
  const out: DropItem = {
    ...base,
    name: r.name || base.name,
    collectibleItemId: base.collectibleItemId ?? r.collectibleItemId,
    restrictions: r.itemRestrictions.length ? r.itemRestrictions : base.restrictions,
    tradable: isTradable(r.creatorId, r.creatorType, r.itemRestrictions.length ? r.itemRestrictions : base.restrictions),
    creatorVerified: r.creatorVerified,
    price: r.price ?? base.price,
    totalQuantity: r.totalQuantity ?? base.totalQuantity,
    remaining: takeStock ? r.remaining ?? base.remaining : base.remaining,
    lowestResalePrice: takeStock ? r.lowestResalePrice ?? base.lowestResalePrice : base.lowestResalePrice,
    hasResellers: r.hasResellers ?? base.hasResellers,
    favoriteCount: r.favoriteCount ?? base.favoriteCount,
    offSaleDeadline: r.offSaleDeadline ?? base.offSaleDeadline,
    saleLocation: r.saleLocation ?? base.saleLocation,
    inGameOnly: (r.saleLocation ?? base.saleLocation) === IN_GAME_ONLY,
    createdAt: r.createdAt ?? base.createdAt,
    updatedAt: now,
  };
  return settleSoldOut(out, now);
}

export function mergeStock(x: DropItem, m: MarketplaceItemStock, now: number): DropItem {
  const out: DropItem = {
    ...x,
    price: m.price ?? x.price,
    remaining: m.remaining ?? x.remaining,
    totalQuantity: m.totalQuantity ?? x.totalQuantity,
    sales: m.sales ?? x.sales,
    limitPerUser: m.limitPerUser ?? x.limitPerUser,
    lowestResalePrice: m.lowestResalePrice ?? x.lowestResalePrice,
    hasResellers: m.hasResellers ?? x.hasResellers,
    offSaleDeadline: m.offSaleDeadline ?? x.offSaleDeadline,
    saleLocation: m.saleLocation ?? x.saleLocation,
    inGameOnly: (m.saleLocation ?? x.saleLocation) === IN_GAME_ONLY,
    saleStatus: m.saleStatus !== undefined ? m.saleStatus : x.saleStatus ?? null,
    releaseAt: m.releaseAt ?? x.releaseAt ?? null,
    stockUpdatedAt: now,
    updatedAt: now,
  };
  return settleSoldOut(out, now);
}

/** Not on sale yet and nothing sold: 0 left is not "sold out". */
export const notReleased = (d: DropItem): boolean => d.saleStatus === 'pending' || (d.saleStatus === 'offSale' && !d.sales);

/** Sold-out bookkeeping. Not on sale yet: 0 left means "not released", not sold out. Restocks exist (totalRestockedQuantity). */
function settleSoldOut(out: DropItem, now: number): DropItem {
  if (isUpcoming(out, now) || notReleased(out)) { out.soldOutAt = null; return out; }
  if (isSoldOut(out) && !out.soldOutAt) out.soldOutAt = now;
  if (!isSoldOut(out)) out.soldOutAt = null;
  return out;
}
