/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * The service brain: owns adapter clients, pollers and the score pipeline.
 * READ-ONLY with respect to trades: it never accepts, declines, counters or sends anything.
 */
import type {
  AdapterFactory, AuthenticatedUser, CollectibleInstance, RobloxClient, RolimonsClient, RolimonsItem,
  RolimonsTradeAd, TradeListEntry,
} from '../adapters/interfaces.js';
import type { TradableItem } from '../adapters/interfaces.js';
import { mergeTradableIntoInventory } from './inventoryMerge.js';
import type { CoreEngine, PortfolioContext } from '../core/contracts.js';
import type {
  AssetId, ItemSnapshot, MarketAnomaly, PartnerInfo, Settings, SourceHealth, TradeDirection, TradeId, TradeItem,
  TradeMetadata, TradeScore, TradeSnapshot, ValuedItem,
} from '../core/types.js';
import type { SqliteRepository } from '../db/sqlite.js';
import type { SecretStore } from '../secrets/interfaces.js';
import { errMsg, type Logger } from '../server/log.js';
import type { Notifier } from '../server/notify.js';
import { Scheduler } from './scheduler.js';
import { PartnerInventory } from './partnerInventory.js';
import { LearningJob } from './learning.js';
import { DropsJob, feedIntervals } from './drops.js';
import { RESTRICTED_BACKOFF_MS } from '../adapters/roblox/client.js';
import { applyReconstructedSales, emptySnapshot, marketRefreshOrder, marketSnapshot, overlayRoli, overlayTradeItem, ownerStats, parseStatus } from './snapshots.js';
import { consolidationPremium } from '../core/valuation.js';
import { catalogDue, computeMarketIndex, marketScale, mergeTradeMetadata, scaleModelSettings, type MarketIndex } from '../core/marketData.js';
import { liquidityCfg } from '../core/tradeScoring.js';
import { tradeStatusFrom, type CanTradeRaw } from '../core/tradeEligibility.js';
import {
  HOLD_FAST_REFRESH_MS, emptyHoldState, estimateHold, holdLength, holdLengths, holdNeedsFastRefresh, instanceKey, matchTradeStart, updateHoldState,
  type CompletedTradeRef, type HoldEstimate, type HoldLength, type HoldLengths, type HoldState, type PurchaseRef,
} from '../core/holds.js';

/** Minimum spacing between manual own-inventory refreshes (collectibles endpoint is rate limited). */
export const INVENTORY_REFRESH_MIN_MS = 60_000;

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Max items per market refresh: 2 marketplace-sales calls each, well inside 50/60s per run spacing. */
const MARKET_REFRESH_MAX = 40;

export type CookieStatus = 'missing' | 'valid' | 'invalid' | 'unchecked';

export interface AnalystDeps {
  repo: SqliteRepository;
  secrets: SecretStore;
  engine: CoreEngine;
  engineReal: boolean;
  adapters: AdapterFactory | null;
  notifier: Notifier;
  log: Logger;
  uiUrl: string;
  /** Demo mode: no Roblox client, fixed account, injected Rolimons client. */
  demo?: { account: AuthenticatedUser; rolimons: RolimonsClient | null } | null;
}

interface OwnersCache { fetchedAt: number; publicCopies: number; topOwnerCopies: number; top3OwnerShare: number; recentOwnerChurn30d: number }
export interface InventoryCache { fetchedAt: number; items: CollectibleInstance[] }

/** Never-snapshotted items fetched per backfill run (each costs ~2 Roblox requests). */
export const MARKET_BACKFILL_BATCH = 12;
/** Purchase-history lookups per held copy: one answer, or one retry after a failure. */
export const PURCHASE_TX_MAX_TRIES_PER_COPY = 2;

/** Use the trade list's creation date when the stored one differs (v2-only details have none). */
export function withListDate<T extends { createdAt: number }>(t: T, e: { created: number }): T {
  if (!Number.isFinite(e.created) || e.created <= 0 || Math.abs(t.createdAt - e.created) < 60_000) return t;
  return { ...t, createdAt: e.created };
}

/** Cached Purchase transactions (hold-start matching). */
interface PurchaseTxCache { fetchedAt: number | null; attemptAt: number; rows: PurchaseRef[]; failed: string | null }
/** Transaction history is fetched at most this often, and only while an unmatched copy is on hold. */
export const PURCHASE_TX_MIN_INTERVAL_MS = 30 * 60_000;
const PURCHASE_TX_MAX_PAGES = 2;

export class Analyst {
  readonly repo: SqliteRepository;
  readonly engine: CoreEngine;
  readonly engineReal: boolean;
  readonly scheduler: Scheduler;
  readonly startedAt = Date.now();
  readonly demo: boolean;
  /** Partner tradable items for counter search (lazy, 24h cache). */
  readonly partnerInv: PartnerInventory;
  readonly learning: LearningJob;
  readonly drops: DropsJob;

  roblox: RobloxClient | null = null;
  rolimons: RolimonsClient | null = null;
  account: AuthenticatedUser | null = null;
  cookieStatus: CookieStatus = 'unchecked';
  cookieCheckedAt: number | null = null;
  lastPollAt: number | null = null;

  roli = new Map<AssetId, RolimonsItem>();
  private ads = new Map<number, RolimonsTradeAd>();
  private adCounts = new Map<AssetId, { req: number; off: number }>();
  private botIds = new Set<number>();
  private lastInboundCount: number | null = null;
  private lastInboundListAt = 0;
  private settingsCache: Settings | null = null;
  private manualValues: Record<string, number> = {};
  /** Detail-fetch failures for active trades that left the list (retry before marking Gone). */
  private goneMisses = new Map<TradeId, number>();
  /** Re-fetch attempts for snapshots whose v1/v2 join was partial. */
  private rejoinAttempts = new Map<TradeId, number>();
  /** Trade list/count calls Roblox refused with 403 (account cannot trade): skipped until this time. */
  private restrictedUntil = new Map<string, number>();

  constructor(private readonly d: AnalystDeps) {
    this.repo = d.repo;
    this.engine = d.engine;
    this.engineReal = d.engineReal;
    this.scheduler = new Scheduler(d.log);
    this.demo = !!d.demo;
    this.partnerInv = new PartnerInventory(d.repo);
    this.learning = new LearningJob({
      repo: d.repo, engine: d.engine, settings: () => this.settings(), log: d.log,
      valueFor: (id) => this.valueFor(id), computeScore: (t, o) => this.computeScore(t, o),
    });
    if (d.demo) {
      this.account = d.demo.account;
      this.cookieStatus = 'valid';
      this.rolimons = d.demo.rolimons;
    } else if (d.adapters) {
      this.rolimons = d.adapters.rolimons();
      this.roblox = d.adapters.roblox(() => d.secrets.getCookie());
    }
    this.drops = new DropsJob({
      repo: d.repo, settings: () => this.settings(), roblox: () => this.roblox, notifier: d.notifier, log: d.log, uiUrl: d.uiUrl,
    });
    this.manualValues = this.repo.getKv<Record<string, number>>('manualValues') ?? {};
    const cachedRoli = this.repo.getKv<RolimonsItem[]>('rolimonsItems');
    if (cachedRoli) for (const r of cachedRoli) this.roli.set(r.assetId, r);
    const cachedAds = this.repo.getKv<RolimonsTradeAd[]>('tradeAds');
    if (cachedAds) { for (const a of cachedAds) this.ads.set(a.adId, a); this.recountAds(); }
    this.registerJobs();
  }

  // ------------------------------------------------------------------ settings
  settings(): Settings {
    if (!this.settingsCache) {
      const s = this.repo.getSettings();
      // Older saves polled the feeds faster than the current 6 / min cap: scale them so the watchlist keeps spare budget.
      const iv = feedIntervals(s.drops);
      s.drops.robloxPollMs = iv.roblox;
      s.drops.allPollMs = iv.all;
      this.settingsCache = s;
    }
    return this.settingsCache;
  }

  /**
   * Settings the valuation / scoring model sees: settings() with absolute-Robux thresholds scaled to
   * the current market when settings.market.scaleWithMarket is on (identical to settings() otherwise).
   */
  modelSettings(): Settings {
    const s = this.settings();
    if (!s.market?.scaleWithMarket) return s;
    const idx = this.repo.getKv<MarketIndex>('marketIndex');
    const auto = this.repo.getKv<MarketIndex>('marketIndexReference')?.median ?? null;
    return scaleModelSettings(s, marketScale(s, idx ?? null, auto));
  }

  /** Market index + the scale currently applied (for the UI / health). */
  marketStatus(): { index: MarketIndex | null; reference: number | null; scale: number; enabled: boolean } {
    const s = this.settings();
    const index = this.repo.getKv<MarketIndex>('marketIndex') ?? null;
    const auto = this.repo.getKv<MarketIndex>('marketIndexReference')?.median ?? null;
    const reference = s.market.referenceMedianValue > 0 ? s.market.referenceMedianValue : auto;
    return { index, reference, scale: marketScale(s, index, auto), enabled: s.market.scaleWithMarket };
  }

  saveSettings(s: Settings): void {
    this.repo.saveSettings(s);
    this.settingsCache = null;
    // Auto reference for market scaling: captured when switched on, forgotten when switched off.
    if (!s.market.scaleWithMarket) this.repo.setKv('marketIndexReference', null);
    else if (!this.repo.getKv<MarketIndex>('marketIndexReference')) {
      const idx = this.repo.getKv<MarketIndex>('marketIndex');
      if (idx) this.repo.setKv('marketIndexReference', idx);
    }
    void this.rescoreActive();
  }

  metadata(): TradeMetadata {
    return this.repo.getTradeMetadata() ?? { ...this.settings().tradeMetadataFallback, verified: false, fetchedAt: 0 };
  }

  /** Downloaded list (when enabled) plus the user's own settings.botList.extraUserIds. */
  private isBotListed(uid: number): boolean {
    const bl = this.settings().botList;
    return (bl.enabled && this.botIds.has(uid)) || bl.extraUserIds.includes(uid);
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    const bl = this.settings().botList;
    if (this.d.adapters && !this.demo && bl.enabled && bl.url) {
      try {
        this.botIds = await this.d.adapters.botList(bl.url).load();
      } catch (e) { this.d.log.warn('bot list unavailable', errMsg(e)); }
    }
    if (!this.demo) await this.checkCookie().catch((e) => this.d.log.warn('cookie check failed', e));
    await this.rescoreActive().catch((e) => this.d.log.warn('initial rescore failed', e));
    this.scheduler.start();
  }

  stop(): void { this.scheduler.stop(); }

  private registerJobs(): void {
    const s = () => this.settings();
    const live = (fn: () => Promise<void>) => async () => { if (!this.demo) await fn(); };
    const roliOn = (ms: () => number) => () => (this.rolimons && s().rolimonsEnabled ? ms() : -1);
    this.scheduler.add({ name: 'inboundCount', interval: () => s().poll.inboundCountMs, run: live(() => this.pollInbound()), initialDelayMs: 1_000 });
    this.scheduler.add({ name: 'completed', interval: () => s().poll.completedMs, run: live(async () => { await this.syncList('completed', 1); await this.syncList('inactive', 1); }), initialDelayMs: 40_000 });
    this.scheduler.add({ name: 'metadata', interval: () => s().poll.metadataMs, run: live(() => this.refreshMetadata()), initialDelayMs: 3_000 });
    // While trading is blocked (e.g. Roblox Plus just bought), re-check every 5 min so it clears quickly.
    this.scheduler.add({ name: 'canTrade', interval: () => (this.repo.getKv<{ canTrade: boolean }>('canTrade')?.canTrade === false ? Math.min(5 * 60_000, s().poll.metadataMs) : s().poll.metadataMs), run: live(() => this.refreshCanTrade()), initialDelayMs: 3_500 });
    // Faster while a trade hold is due within 2 h (or overdue) so the lift is caught and measured precisely.
    this.scheduler.add({ name: 'ownInventory', interval: () => this.inventoryIntervalMs(), run: live(() => this.refreshInventory()), initialDelayMs: 5_000 });
    this.scheduler.add({ name: 'itemSnapshots', interval: () => s().poll.itemSnapshotsMs, run: live(() => this.refreshMarket()), initialDelayMs: 60_000 });
    // Items in completed/past trades never get a market fetch on arrival (only inbound offers do); fill them in slowly.
    this.scheduler.add({ name: 'marketBackfill', interval: () => 10 * 60_000, run: live(async () => { await this.backfillMarket(); }), initialDelayMs: 90_000 });
    this.scheduler.add({ name: 'rolimonsItems', interval: roliOn(() => s().poll.rolimonsItemsMs), run: () => this.refreshRolimonsItems(), initialDelayMs: 2_000 });
    this.scheduler.add({ name: 'rolimonsSales', interval: roliOn(() => s().poll.rolimonsSalesMs), run: live(() => this.pollSales()), initialDelayMs: 4_000 });
    this.scheduler.add({ name: 'rolimonsAds', interval: roliOn(() => s().poll.rolimonsAdsMs), run: live(() => this.pollAds()), initialDelayMs: 10_000 });
    const dropsOn = (ms: () => number) => () => (s().drops.enabled ? ms() : 60_000); // paused: idle check each minute
    this.scheduler.add({ name: 'dropsRoblox', interval: dropsOn(() => feedIntervals(s().drops).roblox), run: live(async () => { await this.drops.pollFeed('roblox'); }), initialDelayMs: 2_500 });
    this.scheduler.add({ name: 'dropsAll', interval: dropsOn(() => feedIntervals(s().drops).all), run: live(async () => { await this.drops.pollFeed('all'); }), initialDelayMs: 7_500 });
    // Watchlist: tries every 10 s, searches only when the shared catalog budget has room (see DropsJob.canSearch).
    this.scheduler.add({ name: 'dropsCreators', interval: dropsOn(() => 10_000), run: live(async () => { await this.drops.pollCreators(); }), initialDelayMs: 12_500 });
    // Timed releases: a cheap in-memory check each second; requests only near a scheduled release (demo simulates it).
    this.scheduler.add({ name: 'dropsReleases', interval: dropsOn(() => 1_000), run: async () => { await this.drops.watchReleases(); }, initialDelayMs: 3_000 });
    this.scheduler.add({ name: 'dropsStock', interval: dropsOn(() => s().drops.stockRefreshMs), run: live(async () => { await this.drops.refreshStock(); }), initialDelayMs: 15_000 });
    this.scheduler.add({ name: 'snapshotSignals', interval: () => 6 * HOUR, run: () => this.scanSnapshotSignals(), initialDelayMs: 180_000 });
    this.scheduler.add({ name: 'outcomes', interval: () => DAY, run: () => this.computeOutcomes(), initialDelayMs: 120_000 });
    this.scheduler.add({ name: 'prune', interval: () => DAY, run: async () => {
      const r = this.repo.prune(Date.now());
      const drops = this.repo.pruneDrops(Date.now() - 7 * DAY);
      this.d.log.info('db retention prune', { ...r, drops });
    }, initialDelayMs: 300_000 });
    this.scheduler.add({ name: 'rescore', interval: () => 15 * 60_000, run: () => this.rescoreActive(), initialDelayMs: 8_000 });
  }

  // ------------------------------------------------------------------ cookie
  async checkCookie(): Promise<CookieStatus> {
    if (this.demo) return this.cookieStatus;
    const c = await this.d.secrets.getCookie();
    this.cookieCheckedAt = Date.now();
    if (!c) { this.account = null; return (this.cookieStatus = 'missing'); }
    if (!this.roblox) return (this.cookieStatus = 'unchecked');
    const u = await this.roblox.getAuthenticatedUser();
    this.account = u;
    this.repo.setKv('account', u);
    return (this.cookieStatus = u ? 'valid' : 'invalid');
  }

  /** Validate via users/v1/users/authenticated BEFORE storing. Never logs the value. */
  async setCookie(raw: string): Promise<CookieStatus> {
    if (this.demo) return this.cookieStatus;
    if (!this.d.adapters) throw new Error('Roblox adapter not available in this build');
    const { normalizeCookie } = await import('../secrets/store.js');
    const candidate = normalizeCookie(raw);
    if (!candidate) return (this.cookieStatus = 'invalid');
    const probe = this.d.adapters.roblox(async () => candidate);
    const u = await probe.getAuthenticatedUser();
    this.cookieCheckedAt = Date.now();
    if (!u) return 'invalid'; // do not store, keep previous status
    await this.d.secrets.setCookie(candidate);
    this.account = u;
    this.repo.setKv('account', u);
    this.cookieStatus = 'valid';
    this.lastInboundCount = null;
    void this.scheduler.runNow('metadata');
    void this.scheduler.runNow('canTrade');
    void this.scheduler.runNow('ownInventory');
    void this.scheduler.runNow('inboundCount');
    return this.cookieStatus;
  }

  async deleteCookie(): Promise<void> {
    if (this.demo) return;
    await this.d.secrets.deleteCookie();
    this.account = null;
    this.cookieStatus = 'missing';
  }

  // ------------------------------------------------------------------ trade polling
  async pollInbound(): Promise<void> {
    if (!this.roblox || !this.account) {
      if (this.cookieStatus === 'unchecked' || (this.cookieStatus === 'valid' && !this.account)) await this.checkCookie();
      return;
    }
    // canTrade=false (e.g. no Roblox Plus): trade reads may 403; show tradesV1 as 'restricted', not as an error.
    if (this.repo.getKv<{ canTrade: boolean }>('canTrade')?.canTrade === false) {
      this.roblox.markRestricted?.('tradesV1', 'restricted (no trading): Roblox says this account cannot trade');
    }
    if (this.isRestrictedOp('count:inbound')) { await this.syncList('inbound', 5); this.lastPollAt = Date.now(); return; }
    let n: number;
    try {
      n = await this.roblox.getTradeCount('inbound');
    } catch (e) {
      if (!this.restrictOn403(e, 'count:inbound')) throw e;
      await this.syncList('inbound', 5); // the list may still answer
      this.lastPollAt = Date.now();
      return;
    }
    this.lastPollAt = Date.now();
    const s = this.settings();
    const stale = Date.now() - this.lastInboundListAt > 2 * 60_000; // safety net: count can stay equal while ids change
    if (!s.poll.inboundListOnChangeOnly || n !== this.lastInboundCount || stale) {
      await this.syncList('inbound', 5);
      this.lastInboundListAt = Date.now();
    }
    this.lastInboundCount = n;
  }

  /** Manual "poll now". */
  async pollNow(): Promise<void> {
    this.lastInboundCount = null;
    void this.scheduler.runNow('canTrade');
    await this.scheduler.runNow('inboundCount');
  }

  /** True while Roblox is known to refuse this trade call (403) for this account. */
  private isRestrictedOp(op: string): boolean { return (this.restrictedUntil.get(op) ?? 0) > Date.now(); }

  /**
   * A 403 on a trade read means Roblox refuses it for this account (typically no Roblox Plus / cannot trade).
   * Back off that call for 30 min, show the source as 'restricted' (neutral), and log once per transition.
   */
  private restrictOn403(e: unknown, op: string): boolean {
    if ((e as { status?: number | null } | null)?.status !== 403) return false;
    const was = this.isRestrictedOp(op);
    this.restrictedUntil.set(op, Date.now() + RESTRICTED_BACKOFF_MS);
    this.roblox?.markRestricted?.('tradesV1', 'Roblox refuses trade lists for this account (403): restricted (no trading)');
    if (!was) this.d.log.info(`trade ${op} refused (403); account cannot trade - retrying in 30 min`);
    return true;
  }

  async syncList(direction: TradeDirection, maxPages: number): Promise<void> {
    if (!this.roblox || !this.account) return;
    if (this.isRestrictedOp(`list:${direction}`)) return;
    try {
      await this.syncListInner(direction, maxPages);
    } catch (e) {
      if (!this.restrictOn403(e, `list:${direction}`)) throw e;
    }
  }

  private async syncListInner(direction: TradeDirection, maxPages: number): Promise<void> {
    if (!this.roblox || !this.account) return;
    const me = this.account;
    const seen = new Set<TradeId>();
    const fresh: TradeId[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const deep = direction === 'inbound';
    do {
      const page = await this.roblox.listTrades(direction, cursor, deep ? 100 : 25);
      for (const e of page.data) {
        seen.add(e.id);
        const existing = this.repo.getTrade(e.id);
        // Re-fetch a snapshot whose v1/v2 join was partial (one half failed), a few times at most.
        // A v1-less snapshot is complete when v1 details are refused for this account (403 -> restricted).
        const v1Off = this.roblox.isRestricted?.('tradesV1:detail') ?? false;
        const partial = existing != null && ((!existing.hadV1 && !v1Off) || !existing.hadV2)
          && (this.rejoinAttempts.get(e.id) ?? 0) < 5;
        if (partial) this.rejoinAttempts.set(e.id, (this.rejoinAttempts.get(e.id) ?? 0) + 1);
        if (!existing || partial) {
          try {
            const detail = await this.roblox.getTradeDetail(e.id, me.id, direction);
            // v2-only details carry no date (only v1 does); the list row always has the real one.
            const snap = withListDate(detail, e);
            this.repo.upsertTrade(existing ? { ...snap, direction: existing.direction } : snap);
            if (!existing) fresh.push(e.id);
            else this.applyListStatus(this.repo.getTrade(e.id) ?? existing, e);
          } catch (err) { this.d.log.warn(`trade detail ${e.id} failed`, err); }
        } else {
          // Repair trades stored before list dates were used (they were stamped with the fetch time).
          const fixed = withListDate(existing, e);
          if (fixed !== existing) this.repo.upsertTrade(fixed);
          this.applyListStatus(fixed, e);
        }
      }
      cursor = page.nextPageCursor ?? undefined;
      pages++;
    } while (cursor && pages < maxPages);

    if (deep) {
      // Known active trades that left the list: re-check their status once.
      for (const id of this.repo.activeTradeIds(direction)) {
        if (seen.has(id)) continue;
        try {
          const snap = await this.roblox.getTradeDetail(id, me.id, direction);
          const prev = this.repo.getTrade(id);
          this.repo.upsertTrade({ ...snap, direction: prev?.direction ?? direction });
          this.goneMisses.delete(id);
        } catch (err) {
          // Only give up on a definite 404, or after repeated failures; a 429/5xx/timeout retries next cycle.
          const status = (err as { status?: number | null } | null)?.status ?? null;
          const misses = (this.goneMisses.get(id) ?? 0) + 1;
          this.goneMisses.set(id, misses);
          const prev = this.repo.getTrade(id);
          if (prev && (status === 404 || misses >= 6)) {
            this.repo.updateTradeStatus(id, 'Unknown', 'Gone', false, Date.now());
            this.goneMisses.delete(id);
          }
        }
      }
    }

    for (const id of fresh) {
      const t = this.repo.getTrade(id);
      if (!t) continue;
      if (deep) {
        // Show it right away on the data we already have; notify only once partner + market data are in.
        await this.scoreTrade(id, { notify: false, preliminary: true });
        await this.ensurePartner(t).catch((e) => this.d.log.warn(`partner ${t.partner.userId} failed`, e));
        await this.refreshMarket([...t.give.items, ...t.get.items].map((i) => i.assetId)).catch((e) => this.d.log.warn('market refresh failed', e));
      }
      await this.scoreTrade(id, { notify: direction === 'inbound' });
    }
  }

  private applyListStatus(existing: TradeSnapshot, e: TradeListEntry): void {
    if (existing.statusRaw === e.statusRaw && existing.isActive === e.isActive) return;
    this.repo.updateTradeStatus(existing.tradeId, parseStatus(e.statusRaw), e.statusRaw, e.isActive, Date.now());
  }

  // ------------------------------------------------------------------ metadata / inventory
  async refreshMetadata(): Promise<void> {
    if (!this.roblox || !this.account) return;
    try {
      const next = await this.roblox.getTradeMetadata();
      this.repo.setTradeMetadata(mergeTradeMetadata(this.repo.getTradeMetadata(), next));
    } catch (e) {
      // Keep the last good row (its fetchedAt shows its age); defaults apply only if nothing was ever stored.
      this.d.log.warn('trade metadata unavailable; keeping the last fetched values', errMsg(e));
    }
  }

  /** Poll /v2/users/me/can-trade; one desktop notification per eligibility change (persisted across restarts). */
  async refreshCanTrade(): Promise<void> {
    if (!this.roblox || !this.account) return;
    let c: CanTradeRaw;
    try { c = await this.roblox.getCanTrade(); } catch (e) { this.d.log.warn('can-trade unavailable', errMsg(e)); return; }
    await this.recordCanTrade(c);
  }

  /** Store the can-trade result and notify once if eligibility flipped. Public for demo/tests. */
  async recordCanTrade(c: CanTradeRaw, opts: { notify?: boolean } = {}): Promise<void> {
    const prev = this.repo.getKv<{ canTrade: boolean }>('canTrade');
    this.repo.setKv('canTrade', c);
    if (c.canTrade && prev?.canTrade === false) { this.restrictedUntil.clear(); this.roblox?.clearRestricted?.(); this.lastInboundCount = null; }
    const last = this.repo.getKv<{ canTrade: boolean }>('canTradeNotified');
    if (last?.canTrade === c.canTrade) return;
    // First observation: only worth a toast when you cannot trade.
    if (!last && c.canTrade) { this.repo.setKv('canTradeNotified', { canTrade: true, at: Date.now() }); return; }
    this.repo.setKv('canTradeNotified', { canTrade: c.canTrade, at: Date.now() });
    if (opts.notify === false) return;
    const st = tradeStatusFrom(c)!;
    const [title, msg] = c.canTrade
      ? ['You can trade now', 'Roblox reports your account is eligible to trade. Advice is unchanged; act on roblox.com yourself.']
      : ["You can't trade right now", `${st.reason ?? 'Not eligible'}. Trades are still analysed (advice only).`];
    await this.d.notifier.notify(title, msg, `${this.d.uiUrl}/`).catch(() => undefined);
  }

  /** Null (no banner) until a cookie is valid and the first can-trade poll has answered. */
  tradeStatus() {
    if (!this.demo && this.cookieStatus !== 'valid') return null;
    return tradeStatusFrom(this.repo.getKv<CanTradeRaw>('canTrade'));
  }

  async refreshInventory(): Promise<void> {
    if (!this.roblox || !this.account) return;
    const classic = await this.roblox.getCollectibles(this.account.id);
    if (classic === 'hidden') { this.repo.setKv('ownInventoryHidden', { at: Date.now() }); return; }
    this.repo.setKv('ownInventoryHidden', null);
    // Newer "Collectible" (Limited 2.0) items are missing from the classic list; add them from tradableItems.
    const tradable: TradableItem[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const p = await this.roblox.getTradableItems(this.account.id, cursor);
        tradable.push(...p.data);
        if (!p.nextPageCursor) break;
        cursor = p.nextPageCursor;
      }
    } catch (e) { this.d.log.warn('tradable items for own inventory failed (classic list only)', errMsg(e)); }
    const inv = mergeTradableIntoInventory(classic, tradable);
    const fetchedAt = Date.now();
    this.repo.setKv<InventoryCache>('ownInventory', { fetchedAt, items: inv });
    await this.refreshPurchasesIfNeeded(inv, fetchedAt);
    this.trackHolds(inv, fetchedAt);
    // Static catalog fields (copies -> rarity, collectibleItemId) right away, not at the next market cycle.
    await this.ensureCatalog([...new Set(inv.map((i) => i.assetId))]).catch((e) => this.d.log.warn('catalog after inventory failed', errMsg(e)));
  }

  inventoryHidden(): boolean { return !!this.repo.getKv<{ at: number } | null>('ownInventoryHidden'); }

  /** Manual refresh (UI button). Rate-limited; returns when the next one is allowed if refused. */
  requestInventoryRefresh(now = Date.now()): { queued: boolean; retryAt: number | null } {
    const st = this.scheduler.statuses().find((j) => j.name === 'ownInventory');
    const nextAt = this.inventoryRefreshAllowedAt();
    if (this.demo || st?.running || (nextAt != null && nextAt > now)) return { queued: false, retryAt: nextAt };
    void this.scheduler.runNow('ownInventory');
    return { queued: true, retryAt: now + INVENTORY_REFRESH_MIN_MS };
  }

  inventoryRefreshAllowedAt(): number | null {
    const st = this.scheduler.statuses().find((j) => j.name === 'ownInventory');
    return st?.lastRunAt != null ? st.lastRunAt + INVENTORY_REFRESH_MIN_MS : null;
  }

  inventory(): InventoryCache | null { return this.repo.getKv<InventoryCache>('ownInventory'); }

  // ------------------------------------------------------------------ trade holds (estimated countdown)
  /** Completed trades as hold-start candidates: watched completion time, else creation time. */
  holdTradeRefs(): CompletedTradeRef[] {
    const out: CompletedTradeRef[] = [];
    for (const t of this.repo.listTrades({ statuses: ['Completed'], limit: 5_000, offset: 0 })) {
      const h = this.repo.statusHistory(t.tradeId);
      const firstActive = h.findIndex((x) => x.isActive);
      let done = -1;
      for (let i = h.length - 1; i > firstActive; i--) if (firstActive >= 0 && !h[i]!.isActive && h[i]!.status === 'Completed') { done = i; break; }
      out.push({
        tradeId: t.tradeId, at: done >= 0 ? h[done]!.at : t.createdAt, observed: done >= 0,
        received: t.get.items.map((i) => ({ assetId: i.assetId, serial: i.serialNumber, userAssetId: i.userAssetId, collectibleItemInstanceId: i.collectibleItemInstanceId })),
      });
    }
    return out;
  }

  holdState(): HoldState { return this.repo.getKv<HoldState>('holdTracker') ?? emptyHoldState(); }

  /** Trade hold length (back-compat single length). */
  holdLength(): HoldLength { return holdLength(this.settings().hold?.assumedDays ?? 2, this.holdState().observations); }

  /** Per-kind hold lengths: trade, purchase, and unknown (= the larger of the two). */
  holdLengths(): HoldLengths {
    const h = this.settings().hold;
    return holdLengths(h?.assumedDays ?? 2, h?.assumedPurchaseDays ?? 3, this.holdState().observations);
  }

  /** Purchase times from the user's own transaction history (cached in kv 'purchaseTx'). */
  purchaseRefs(): PurchaseRef[] { return this.repo.getKv<PurchaseTxCache>('purchaseTx')?.rows ?? []; }

  purchaseLookupStatus(): { lastFetchAt: number | null; rows: number; failed: string | null } {
    const c = this.repo.getKv<PurchaseTxCache>('purchaseTx');
    return { lastFetchAt: c?.fetchedAt ?? null, rows: c?.rows.length ?? 0, failed: c?.failed ?? null };
  }

  /**
   * Fetch Purchase transactions (1-2 pages) only when a NEW on-hold copy appears with no trade match.
   * Each copy is looked up once and the answer kept for its hold; a failed lookup is retried at most
   * once (>= 30 min later). Failure degrades the copy to 'unknown'; warned once per failure streak.
   */
  async refreshPurchasesIfNeeded(inv: CollectibleInstance[], now: number): Promise<void> {
    const fetchTx = this.roblox?.getPurchaseTransactions?.bind(this.roblox);
    if (!fetchTx || !this.account) return;
    const st = this.holdState(), trades = this.holdTradeRefs();
    const looked = this.repo.getKv<Record<string, number>>('purchaseTxLooked') ?? {};
    // Forget copies no longer on hold so the record cannot grow forever.
    const heldKeys = new Set(inv.filter((i) => i.isOnHold).map(instanceKey));
    for (const k of Object.keys(looked)) if (!heldKeys.has(k)) delete looked[k];
    const needKeys = inv.filter((i) => {
      if (!i.isOnHold) return false;
      const k = instanceKey(i);
      if ((looked[k] ?? 0) >= PURCHASE_TX_MAX_TRIES_PER_COPY) return false;
      const e = st.entries[k];
      if (e && e.startBasis !== 'first_seen') return false;
      return !matchTradeStart(i, trades, now);
    }).map(instanceKey);
    this.repo.setKv('purchaseTxLooked', looked);
    if (!needKeys.length) return;
    const prev = this.repo.getKv<PurchaseTxCache>('purchaseTx');
    if (prev && now - prev.attemptAt < PURCHASE_TX_MIN_INTERVAL_MS) return;
    try {
      const rows: PurchaseRef[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PURCHASE_TX_MAX_PAGES; page++) {
        const p = await fetchTx(this.account.id, cursor);
        rows.push(...p.data.map((r) => ({ assetId: r.assetId, at: r.created })));
        if (!p.nextPageCursor) break;
        cursor = p.nextPageCursor;
      }
      this.repo.setKv<PurchaseTxCache>('purchaseTx', { fetchedAt: now, attemptAt: now, rows, failed: null });
      // Answered (matched or not): never ask again for these copies while they stay on hold.
      for (const k of needKeys) looked[k] = PURCHASE_TX_MAX_TRIES_PER_COPY;
      this.repo.setKv('purchaseTxLooked', looked);
    } catch (e) {
      if (!prev?.failed) this.d.log.warn('purchase transactions unavailable; bought items show "hold (source unknown)"', errMsg(e));
      this.repo.setKv<PurchaseTxCache>('purchaseTx', { fetchedAt: prev?.fetchedAt ?? null, attemptAt: now, rows: prev?.rows ?? [], failed: errMsg(e) });
      for (const k of needKeys) looked[k] = (looked[k] ?? 0) + 1;
      this.repo.setKv('purchaseTxLooked', looked);
    }
  }

  /** Fold an inventory fetch into the hold tracker (start times, lift observations). */
  trackHolds(inv: CollectibleInstance[], fetchedAt: number): void {
    const prev = this.holdState();
    const next = updateHoldState(prev, inv, fetchedAt, this.holdTradeRefs(), this.purchaseRefs());
    const added = next.observations.length - prev.observations.length;
    if (added > 0) this.d.log.info('hold lift observed', { added, kinds: next.observations.slice(-added).map((o) => o.kind) });
    this.repo.setKv<HoldState>('holdTracker', next);
  }

  inventoryIntervalMs(now = Date.now()): number {
    const base = this.settings().poll.ownInventoryMs;
    if (base <= 0) return base;
    return holdNeedsFastRefresh(this.holdState(), this.holdLengths(), now) ? Math.min(base, HOLD_FAST_REFRESH_MS) : base;
  }

  /** Estimated hold for an owned instance that is on hold now (null when not owned / not on hold / untracked). */
  holdForInstance(i: CollectibleInstance, now = Date.now(), st = this.holdState(), len: HoldLengths = this.holdLengths()): HoldEstimate | null {
    if (!i.isOnHold) return null;
    const e = st.entries[instanceKey(i)];
    return e ? estimateHold(e, len, now) : null;
  }

  /** Estimated hold for an item identified by asset + serial, when the user owns that copy and it is on hold. */
  holdFor(assetId: AssetId, serial: number | null, now = Date.now()): HoldEstimate | null { return this.holdLookup(now)(assetId, serial); }

  /** One inventory/tracker read, many lookups (serial must match; a null serial only when one copy is owned). */
  holdLookup(now = Date.now()): (assetId: AssetId, serial: number | null) => HoldEstimate | null {
    const inv = this.inventory()?.items ?? [];
    if (!inv.some((i) => i.isOnHold)) return () => null;
    const st = this.holdState(), len = this.holdLengths();
    return (assetId, serial) => {
      const owned = inv.filter((i) => i.assetId === assetId);
      const hit = serial != null ? owned.find((i) => i.serialNumber === serial) : owned.length === 1 ? owned[0] : undefined;
      return hit?.isOnHold ? this.holdForInstance(hit, now, st, len) : null;
    };
  }

  // ------------------------------------------------------------------ items in play / market
  /** Items from recent trades (any status) and inventory that have never had a Roblox market snapshot. */
  itemsMissingMarket(limit = MARKET_BACKFILL_BATCH): AssetId[] {
    const ids = new Set<AssetId>(this.itemsInPlay());
    for (const t of this.repo.listTrades({ limit: 300, offset: 0 })) for (const i of [...t.give.items, ...t.get.items]) ids.add(i.assetId);
    return [...ids].filter((id) => !(this.repo.latestItemSnapshot(id)?.sources.includes('marketplace_sales'))).slice(0, limit);
  }

  /** Background: fetch market data for a few never-snapshotted items per run, then rescore. */
  async backfillMarket(): Promise<number> {
    const ids = this.itemsMissingMarket();
    if (!ids.length) return 0;
    await this.refreshMarket(ids);
    await this.rescoreActive();
    return ids.length;
  }

  itemsInPlay(): AssetId[] {
    const s = this.settings();
    const ids = new Set<AssetId>([...s.watchlist, ...s.wishlist, ...s.holdList]);
    if (s.upgradeTargetAssetId) ids.add(s.upgradeTargetAssetId);
    for (const id of this.repo.activeTradeIds()) {
      const t = this.repo.getTrade(id);
      if (t) for (const i of [...t.give.items, ...t.get.items]) ids.add(i.assetId);
    }
    for (const i of this.inventory()?.items ?? []) ids.add(i.assetId);
    return [...ids];
  }

  /** Catalog (cid, cached forever) + marketplace-sales resale data + resellers for the given (or in-play) items. */
  async refreshMarket(only?: AssetId[]): Promise<void> {
    if (!this.roblox) return;
    const ids = [...new Set(only ?? this.itemsInPlay())];
    if (!ids.length) return;
    const now = Date.now();
    const s = this.settings();
    await this.ensureCatalog(ids);
    const items = this.repo.getItems(ids);
    const minAge = Math.min(s.poll.itemSnapshotsMs / 2, 5 * 60_000);
    const ordered = marketRefreshOrder(ids.filter((id) => {
      const p = this.repo.latestItemSnapshot(id);
      return !p || !p.sources.includes('marketplace_sales') || now - p.fetchedAt >= minAge;
    }), (id) => this.repo.latestItemSnapshot(id)?.fetchedAt ?? null, only ? ids.length : MARKET_REFRESH_MAX);
    for (const id of ordered) {
      const rec = items.get(id);
      const cid = rec?.collectibleItemId ?? null;
      const prev = this.repo.latestItemSnapshot(id) ?? emptySnapshot(id, rec?.name ?? this.roli.get(id)?.name ?? '', now);
      try {
        const resale = await this.roblox.getResaleData(id, cid);
        const resellers = cid ? await this.roblox.getResellers(cid, 100).catch(() => null) : null;
        let snap = marketSnapshot({ ...prev, collectibleItemId: cid ?? prev.collectibleItemId, itemType: rec?.itemType ?? prev.itemType, name: rec?.name || prev.name }, resale, resellers, now);
        snap = overlayRoli(snap, this.roli.get(id));
        snap = applyReconstructedSales(snap, this.repo.salesFor(id, now - 30 * DAY), now);
        this.repo.insertItemSnapshot(snap);
        if (resellers) this.repo.insertResellersSnapshot(id, now, snap.floorPrice, snap.resellerCount, resellers.capped, resellers.rows.slice(0, 20));
        if (prev.rap > 0 && snap.rap !== prev.rap) {
          const sales = this.engine.salesFromRapSnapshots(id, [{ t: prev.fetchedAt, rap: prev.rap }, { t: now, rap: snap.rap }]);
          this.repo.insertSales(sales);
          const move = (snap.rap - prev.rap) / prev.rap;
          if (Math.abs(move) >= 0.2) this.anomaly(id, snap.name, 'big_move', `RAP moved ${(move * 100).toFixed(0)}% (${Math.round(prev.rap).toLocaleString()} -> ${Math.round(snap.rap).toLocaleString()})`, move, now);
        }
        this.detectFlagAnomalies(id, now);
      } catch (e) { this.d.log.warn(`market snapshot ${id} failed`, e); }
    }
    if (!only) await this.rescoreActive();
  }

  /**
   * Catalog batch details (POST, CSRF handshake, 10 / 60 s) for items whose static fields are unknown:
   * collectibleItemId and totalQuantity are cached; misses are retried after poll.catalogCacheMs.
   */
  async ensureCatalog(ids: AssetId[]): Promise<number> {
    if (!this.roblox || !ids.length) return 0;
    const now = Date.now();
    const s = this.settings();
    const known = this.repo.getItems(ids);
    // Never-fetched rows always; due refreshes (TTL, see catalogDue) oldest first, capped to one batch per call.
    const fresh: AssetId[] = [];
    const stale: AssetId[] = [];
    for (const id of ids) {
      const r = known.get(id);
      if (!r || r.catalogFetchedAt == null) fresh.push(id);
      else if (catalogDue(r, now, s.poll)) stale.push(id);
    }
    stale.sort((a, b) => (known.get(a)?.catalogFetchedAt ?? 0) - (known.get(b)?.catalogFetchedAt ?? 0));
    const needCatalog = [...fresh, ...stale.slice(0, 120)];
    let n = 0;
    for (let i = 0; i < needCatalog.length; i += 120) {
      const chunk = needCatalog.slice(i, i + 120);
      try {
        const details = await this.roblox.getCatalogDetails(chunk);
        let thumbs = new Map<AssetId, string | null>();
        try { thumbs = await this.roblox.getThumbnails(chunk); } catch { /* optional */ }
        for (const id of chunk) {
          const c = details.get(id);
          this.repo.upsertItem({
            assetId: id, name: c?.name ?? this.roli.get(id)?.name ?? '', collectibleItemId: c?.collectibleItemId ?? null,
            itemType: c?.itemType ?? known.get(id)?.itemType ?? 'Asset',
            isLimitedU: c ? c.itemRestrictions.some((r) => r === 'LimitedUnique' || r === 'Collectible') : null,
            thumbnailUrl: thumbs.get(id) ?? null, catalogFetchedAt: now,
            totalQuantity: c?.totalQuantity ?? null, creatorName: c?.creatorName ?? null, createdAt: c?.createdAt ?? null,
          });
          n++;
        }
      } catch (e) { this.d.log.warn('catalog batch failed', errMsg(e)); }
    }
    return n;
  }

  private anomaly(assetId: AssetId, name: string, kind: MarketAnomaly['kind'], message: string, changePct: number | undefined, at: number): void {
    const a: MarketAnomaly = { id: `${kind}:${assetId}:${Math.floor(at / HOUR)}`, assetId, name, kind, message, evidence: [], at };
    if (changePct !== undefined) a.changePct = changePct;
    this.repo.insertAnomaly(a);
  }

  /** Emit anomalies when a valuation flag newly appears (projected / raise / drop / hoard). */
  private detectFlagAnomalies(assetId: AssetId, now: number): void {
    const v = this.valueFor(assetId);
    const key = `flags:${assetId}`;
    const prev = new Set(this.repo.getKv<string[]>(key) ?? []);
    const map: Array<[string, MarketAnomaly['kind'], string]> = [
      ['projected', 'newly_projected', 'now looks projected'],
      ['raise_pending', 'raise_pending', 'market is above its value (raise pending)'],
      ['drop_pending', 'drop_pending', 'market is below its value (drop pending)'],
      ['hoard_risk', 'hoard_alert', 'ownership is concentrated (hoard risk)'],
      ['hoard_releasing', 'hoard_alert', 'is being released by its top holder (hoard release)'],
    ];
    for (const [flag, kind, text] of map) {
      if (v.flags.includes(flag as never) && !prev.has(flag)) {
        const a: MarketAnomaly = { id: `${kind}${flag === 'hoard_releasing' ? ':release' : ''}:${assetId}:${Math.floor(now / HOUR)}`, assetId, name: v.name, kind, message: `${v.name} ${text}`, evidence: v.evidence, at: now };
        this.repo.insertAnomaly(a);
      }
    }
    this.repo.setKv(key, v.flags);
  }

  // ------------------------------------------------------------------ Rolimons
  async refreshRolimonsItems(): Promise<void> {
    if (!this.rolimons || !this.settings().rolimonsEnabled) return;
    const map = await this.rolimons.getItemDetails();
    if (!map.size) return;
    const now = Date.now();
    const inPlay = new Set(this.itemsInPlay());
    for (const id of inPlay) {
      const before = this.roli.get(id);
      const after = map.get(id);
      if (!before || !after) continue;
      if (before.value !== after.value && before.value != null && after.value != null && before.value > 0) {
        const pct = (after.value - before.value) / before.value;
        this.anomaly(id, after.name, 'value_change', `${after.name} value ${before.value.toLocaleString()} -> ${after.value.toLocaleString()}`, pct, now);
      }
      if (!before.projected && after.projected) this.anomaly(id, after.name, 'newly_projected', `${after.name} marked projected by Rolimons`, undefined, now);
    }
    const changed = [...inPlay].some((id) => JSON.stringify(this.roli.get(id)) !== JSON.stringify(map.get(id)));
    this.roli = map;
    this.repo.setKv('rolimonsItems', [...map.values()]);
    this.updateMarketIndex(map, now);
    if (changed) {
      // Append-only snapshot rows carrying the new Rolimons fields (market fetchedAt unchanged).
      for (const id of inPlay) {
        const prev = this.repo.latestItemSnapshot(id);
        if (prev) this.repo.insertItemSnapshot(overlayRoli(prev, map.get(id)));
      }
      await this.rescoreActive();
    }
  }

  /** Median Rolimons value of all valued items; the first index seen while scaling is on becomes the auto reference. */
  private updateMarketIndex(map: Map<AssetId, { value: number | null }>, now: number): void {
    const idx = computeMarketIndex([...map.values()].map((x) => x.value), now);
    if (!idx) return;
    const prev = this.repo.getKv<MarketIndex>('marketIndex');
    this.repo.setKv('marketIndex', idx);
    if (this.settings().market.scaleWithMarket && !this.repo.getKv<MarketIndex>('marketIndexReference')) {
      this.repo.setKv('marketIndexReference', idx);
    }
    if (prev && prev.median > 0 && Math.abs(idx.median / prev.median - 1) >= 0.1) {
      this.d.log.info('market index moved', { from: prev.median, to: idx.median });
    }
  }

  async pollSales(): Promise<void> {
    if (!this.rolimons) return;
    const sales = await this.rolimons.getSaleActivity();
    if (sales.length) this.repo.insertSales(sales);
  }

  async pollAds(): Promise<void> {
    if (!this.rolimons) return;
    const ads = await this.rolimons.getRecentTradeAds();
    for (const a of ads) this.ads.set(a.adId, a);
    const cutoff = Date.now() - 7 * DAY;
    for (const [k, a] of this.ads) if (a.t < cutoff) this.ads.delete(k);
    this.recountAds();
    this.repo.setKv('tradeAds', [...this.ads.values()]);
  }

  private recountAds(): void {
    const m = new Map<AssetId, { req: number; off: number }>();
    for (const a of this.ads.values()) {
      for (const id of a.requestAssetIds) { const c = m.get(id) ?? { req: 0, off: 0 }; c.req++; m.set(id, c); }
      for (const id of a.offerAssetIds) { const c = m.get(id) ?? { req: 0, off: 0 }; c.off++; m.set(id, c); }
    }
    this.adCounts = m;
  }

  // ------------------------------------------------------------------ valuation
  snapshotFor(assetId: AssetId, hint?: TradeItem): ItemSnapshot {
    const now = Date.now();
    const rec = this.repo.getItem(assetId);
    let s = this.repo.latestItemSnapshot(assetId) ?? emptySnapshot(assetId, rec?.name ?? hint?.name ?? this.roli.get(assetId)?.name ?? `Item ${assetId}`, 0); // never fetched: no market data yet, so it counts as stale
    s = overlayTradeItem(s, hint);
    if (this.settings().rolimonsEnabled) s = overlayRoli(s, this.roli.get(assetId));
    if (rec?.collectibleItemId && !s.collectibleItemId) s = { ...s, collectibleItemId: rec.collectibleItemId };
    if (rec?.totalQuantity != null && rec.totalQuantity > 0 && s.totalQuantity == null) s = { ...s, totalQuantity: rec.totalQuantity };
    const ads = this.adCounts.get(assetId);
    if (ads) s = { ...s, adRequestCount: ads.req, adOfferCount: ads.off };
    const owners = this.repo.getKv<OwnersCache>(`owners:${assetId}`);
    if (owners) s = { ...s, publicCopies: owners.publicCopies, topOwnerCopies: owners.topOwnerCopies, top3OwnerShare: owners.top3OwnerShare, recentOwnerChurn30d: owners.recentOwnerChurn30d };
    const ownersHist = this.repo.getKv<Array<{ t: number; copies: number }>>(`ownersHist:${assetId}`);
    if (ownersHist?.length) s = { ...s, topOwnerHistory: ownersHist };
    if (rec?.createdAt != null && s.createdAt == null) s = { ...s, createdAt: rec.createdAt };
    if (!s.lastSales.length || s.sales30d == null) s = applyReconstructedSales(s, this.repo.salesFor(assetId, now - 30 * DAY), now);
    const manual = this.manualValues[String(assetId)];
    if (manual != null) s = { ...s, manualValue: manual, sources: [...new Set([...s.sources, 'manual' as const])] };
    return s;
  }

  valueFor(assetId: AssetId, hint?: TradeItem, opts?: { serial?: number | null; isOnHold?: boolean; plain?: boolean }): ValuedItem {
    const snap = this.snapshotFor(assetId, hint);
    const o: { serial?: number | null; isOnHold?: boolean } = {};
    if (opts?.serial !== undefined) o.serial = opts.serial;
    if (opts?.isOnHold !== undefined) o.isOnHold = opts.isOnHold;
    const base = this.engine.valueItem(snap, this.modelSettings(), Date.now(), o);
    // plain: no transient snapshot-lag overlay (used for fixed outcome re-scores).
    const v = opts?.plain ? base : LearningJob.overlay(this.repo, base);
    const rec = this.repo.getItem(assetId);
    return { ...v, name: v.name || snap.name, thumbnailUrl: v.thumbnailUrl ?? rec?.thumbnailUrl ?? null };
  }

  private valueTradeItem(it: TradeItem, plain = false): ValuedItem {
    const o: { serial?: number | null; isOnHold?: boolean; plain?: boolean } = { serial: it.serialNumber, plain };
    if (it.isOnHold != null) o.isOnHold = it.isOnHold;
    const v = this.valueFor(it.assetId, it, o);
    // v2 detail missing: the hold state of this copy is unknown, not "not on hold".
    if (it.isOnHold == null && !v.isOnHold && !v.flags.includes('hold_unknown')) {
      return {
        ...v, flags: [...v.flags, 'hold_unknown'],
        evidence: [...v.evidence, { code: 'hold_unknown', severity: 'warn', message: 'Hold status unknown (trade detail incomplete); treated as possibly on hold' }],
      };
    }
    return v;
  }

  setManualValues(values: Record<string, number>): number {
    this.manualValues = { ...this.manualValues, ...values };
    this.repo.setKv('manualValues', this.manualValues);
    void this.rescoreActive();
    return Object.keys(values).length;
  }

  /** Copies currently owned per asset (empty when the inventory has not loaded). */
  ownedCounts(): Map<AssetId, number> {
    const owned = new Map<AssetId, number>();
    for (const i of this.inventory()?.items ?? []) owned.set(i.assetId, (owned.get(i.assetId) ?? 0) + 1);
    return owned;
  }

  /** Portfolio context for an arbitrary set of owned copies (My Trades re-scores with the pre-trade inventory). */
  portfolioFromCounts(counts: Map<AssetId, number>): PortfolioContext {
    const ownedValues = new Map<AssetId, number>();
    let ownedValue = 0;
    for (const [id, n] of counts) {
      const r = this.roli.get(id);
      const v = (r?.defaultValue ?? this.repo.latestItemSnapshot(id)?.rap ?? 0) * n;
      ownedValue += v;
      ownedValues.set(id, v);
    }
    const target = this.settings().upgradeTargetAssetId;
    return { owned: new Map(counts), ownedValue, ownedValues, upgradeTarget: target ? this.valueFor(target) : null };
  }

  portfolio(): PortfolioContext {
    const owned = new Map<AssetId, number>();
    const ownedValues = new Map<AssetId, number>();
    let ownedValue = 0;
    for (const i of this.inventory()?.items ?? []) {
      owned.set(i.assetId, (owned.get(i.assetId) ?? 0) + 1);
      const r = this.roli.get(i.assetId);
      const v = r?.defaultValue ?? i.recentAveragePrice;
      ownedValue += v;
      ownedValues.set(i.assetId, (ownedValues.get(i.assetId) ?? 0) + v);
    }
    const target = this.settings().upgradeTargetAssetId;
    return { owned, ownedValue, ownedValues, upgradeTarget: target ? this.valueFor(target) : null };
  }

  // ------------------------------------------------------------------ partners
  async ensurePartner(t: TradeSnapshot): Promise<void> {
    if (!this.roblox || !this.account) return;
    const uid = t.partner.userId;
    const s = this.settings();
    const cached = this.repo.getPartner(uid);
    const now = Date.now();
    if (!cached || now - cached.fetchedAt >= s.poll.partnerCacheMs) {
      const profile = await this.roblox.getUser(uid).catch(() => null);
      let visible: boolean | null = await this.roblox.canViewInventory(uid).catch(() => null);
      let invValue: number | null = null, invRap: number | null = null, invCount: number | null = null;
      if (visible) {
        const inv = await this.roblox.getCollectibles(uid).catch(() => null);
        if (inv === 'hidden') visible = false;
        else if (inv) {
          invCount = inv.length;
          invRap = inv.reduce((a, i) => a + i.recentAveragePrice, 0);
          invValue = inv.reduce((a, i) => a + (this.roli.get(i.assetId)?.defaultValue ?? i.recentAveragePrice), 0);
        }
      }
      const player = this.rolimons && s.rolimonsEnabled ? await this.rolimons.getPlayer(uid).catch(() => null) : null;
      const createdAt = profile?.created ?? null;
      const raw: Omit<PartnerInfo, 'flags' | 'evidence'> = {
        userId: uid, name: profile?.name ?? t.partner.name, displayName: profile?.displayName ?? t.partner.displayName,
        createdAt, accountAgeDays: createdAt ? Math.floor((now - createdAt) / DAY) : null,
        hasVerifiedBadge: profile?.hasVerifiedBadge ?? false, isBanned: profile?.isBanned ?? false,
        inventoryVisible: visible, inventoryValue: invValue, inventoryRap: invRap, inventoryItemCount: invCount,
        inBotList: this.isBotListed(uid), terminated: player ? player.terminated : null,
        repeatOfferCount: 0, repeatOfferAccounts: 0, priorTrades: this.repo.priorTradesWith(uid), fetchedAt: now,
      };
      this.repo.upsertPartner(this.engine.assessPartner(raw, s, this.account.id));
    }
    // Owners endpoint only for high-value incoming items (15 req/60s; cached 24h).
    for (const it of t.get.items) {
      const v = this.valueTradeItem(it);
      if (v.tradeValue >= this.modelSettings().scoring.poisonMinValue) await this.ensureOwners(it.assetId).catch(() => undefined);
    }
  }

  private async ensureOwners(assetId: AssetId): Promise<void> {
    if (!this.roblox) return;
    const c = this.repo.getKv<OwnersCache>(`owners:${assetId}`);
    if (c && Date.now() - c.fetchedAt < DAY) return;
    const rows = await this.roblox.getOwners(assetId, 3);
    const now = Date.now();
    const stats = ownerStats(rows, now);
    this.repo.setKv<OwnersCache>(`owners:${assetId}`, { fetchedAt: now, ...stats });
    // Keep 30 days of top-owner readings for the hoard-release detector.
    const hist = (this.repo.getKv<Array<{ t: number; copies: number }>>(`ownersHist:${assetId}`) ?? []).filter((h) => h.t >= now - 30 * DAY);
    hist.push({ t: now, copies: stats.topOwnerCopies });
    this.repo.setKv(`ownersHist:${assetId}`, hist);
  }

  /** Partner info re-assessed with live repeat-offer counts for THIS trade's signature. */
  partnerFor(t: TradeSnapshot): PartnerInfo {
    const s = this.settings();
    const now = Date.now();
    const cached = this.repo.getPartner(t.partner.userId);
    const sig = this.repo.countOfferSignature(t.offerSignature, now - s.scoring.repeatOfferWindowMs);
    const base: Omit<PartnerInfo, 'flags' | 'evidence'> = cached
      ? (({ flags: _f, evidence: _e, ...rest }) => rest)(cached)
      : {
        userId: t.partner.userId, name: t.partner.name, displayName: t.partner.displayName, createdAt: null, accountAgeDays: null,
        hasVerifiedBadge: false, isBanned: false, inventoryVisible: null, inventoryValue: null, inventoryRap: null, inventoryItemCount: null,
        inBotList: this.isBotListed(t.partner.userId), terminated: null, repeatOfferCount: 0, repeatOfferAccounts: 0,
        priorTrades: { completed: 0, declined: 0, countered: 0 }, fetchedAt: now,
      };
    const raw = { ...base, repeatOfferCount: sig.count, repeatOfferAccounts: sig.accounts, priorTrades: this.repo.priorTradesWith(t.partner.userId) };
    return this.engine.assessPartner(raw, s, this.account?.id ?? 0);
  }

  // ------------------------------------------------------------------ scoring
  /** Pure local recompute; never touches Roblox trade endpoints. */
  computeScore(t: TradeSnapshot, opts?: { plain?: boolean; portfolio?: PortfolioContext }): TradeScore {
    const plain = opts?.plain ?? false;
    const give = t.give.items.map((i) => this.valueTradeItem(i, plain));
    let get = t.get.items.map((i) => this.valueTradeItem(i, plain));
    // plain re-scores (learning outcomes) exclude the transient consolidation premium too.
    if (!plain && this.settings().goalMode === 'grow_value') get = this.applyConsolidation(give, get);
    return this.engine.scoreTrade({
      trade: t, give, get, partner: this.partnerFor(t), partnerTradable: this.partnerTradableFor(t), portfolio: opts?.portfolio ?? this.portfolio(),
      metadata: this.metadata(), settings: this.modelSettings(), now: Date.now(),
    });
  }

  /** Valued partner items from the cache (one copy per asset, unheld copy preferred). Empty when not loaded. */
  partnerTradableFor(t: TradeSnapshot): ValuedItem[] {
    const c = this.partnerInv.cached(t.partner.userId);
    if (!c || c.state !== 'loaded') return [];
    const best = new Map<AssetId, (typeof c.items)[number]>();
    for (const e of c.items) {
      const prev = best.get(e.assetId);
      if (!prev || (prev.isOnHold && !e.isOnHold)) best.set(e.assetId, e);
    }
    return [...best.values()].map((e) => this.valueFor(e.assetId, undefined, { serial: e.serial, isOnHold: e.isOnHold }));
  }

  /** grow_value: small premium on the dominant received item when an upgrade consolidates into a liquid item. */
  private applyConsolidation(give: ValuedItem[], get: ValuedItem[]): ValuedItem[] {
    const c = consolidationPremium(give, get, liquidityCfg(this.modelSettings()));
    if (c.multiplier === 1) return get;
    return get.map((g, i) => (i !== c.index ? g : {
      ...g,
      tradeValue: Math.round(g.tradeValue * c.multiplier),
      evidence: [...g.evidence, {
        code: 'consolidation_premium', severity: 'good' as const,
        message: `Consolidation premium x${c.multiplier.toFixed(2)}: ${give.length} items into one at least as liquid`,
        data: { multiplier: c.multiplier, giveCount: give.length },
      }],
    }));
  }

  async scoreTrade(id: TradeId, opts: { notify: boolean; force?: boolean; preliminary?: boolean }): Promise<TradeScore | null> {
    const t = this.repo.getTrade(id);
    if (!t) return null;
    let score: TradeScore;
    try { score = this.computeScore(t); } catch (e) { this.d.log.error(`scoring ${id} failed`, e); return null; }
    // Partner inventory only when this trade actually needs a counter (tradableItems is ~1 req/s; cached 24h).
    if (opts.preliminary) score = { ...score, preliminary: true };
    if (!opts.preliminary && score.counterSuggestion && t.isActive && !this.demo && this.roblox && !this.partnerInv.isFresh(t.partner.userId)) {
      await this.partnerInv.ensure(this.roblox, t.partner.userId).catch((e) => this.d.log.warn('partner inventory failed', errMsg(e)));
      try { score = this.computeScore(t); } catch (e) { this.d.log.error(`scoring ${id} failed`, e); return null; }
    }
    const prev = this.repo.latestScore(id);
    const changed = !prev || opts.force || (prev.preliminary && !opts.preliminary) || Math.abs(prev.score - score.score) >= 0.05 || prev.verdict !== score.verdict
      || prev.modelVersion !== score.modelVersion || score.scoredAt - prev.scoredAt > 6 * HOUR;
    if (changed) this.repo.insertScore(score);
    const s = this.settings();
    if (opts.notify && s.notifyEnabled && t.direction === 'inbound' && t.isActive && score.score >= s.notifyThreshold && !this.repo.wasNotified(id)) {
      this.repo.markNotified(id, Date.now());
      const giveN = score.give.map((g) => g.name).join(', ') || '(Robux)';
      const getN = score.get.map((g) => g.name).join(', ') || '(Robux)';
      await this.d.notifier.notify(
        `Trade ${Math.round(score.score)}/100 — ${score.verdict}`,
        `${t.partner.name}: you give ${giveN}; you get ${getN}. ${(score.rawGainPct * 100).toFixed(1)}% raw. Click to review.`,
        `${this.d.uiUrl}/?trade=${id}`,
      ).catch((e) => this.d.log.warn('notify failed', e));
    }
    return changed ? score : prev ?? score;
  }

  async rescoreActive(): Promise<void> {
    for (const id of this.repo.activeTradeIds()) {
      const t = this.repo.getTrade(id);
      await this.scoreTrade(id, { notify: t?.direction === 'inbound' });
    }
  }

  // ------------------------------------------------------------------ learning
  async computeOutcomes(): Promise<void> {
    this.learning.runOutcomes(Date.now());
  }

  /** Snapshot-based raise/drop-pending scan over items in play (feeds valuation + anomaly feed). */
  async scanSnapshotSignals(): Promise<void> {
    this.learning.scanSnapshots(this.itemsInPlay(), Date.now());
  }

  // ------------------------------------------------------------------ health
  sources(): SourceHealth[] {
    const out: SourceHealth[] = [];
    try { if (this.roblox) out.push(...this.roblox.health()); } catch { /* ignore */ }
    try { if (this.rolimons) out.push(...this.rolimons.health()); } catch { /* ignore */ }
    if (!this.engineReal) out.push({ id: 'core:engine(fallback)', ok: false, lastSuccessAt: null, lastErrorAt: null, lastError: 'real scoring engine not installed; using fallback', count429: 0, cacheHits: 0, cacheMisses: 0 });
    if (!this.d.adapters && !this.demo) out.push({ id: 'adapters', ok: false, lastSuccessAt: null, lastErrorAt: null, lastError: 'adapters not installed', count429: 0, cacheHits: 0, cacheMisses: 0 });
    return out;
  }

  errorOf(e: unknown): string { return errMsg(e); }
}
