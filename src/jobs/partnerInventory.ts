/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Partner inventory for counter suggestions. READ-ONLY: only lists what the partner could trade.
 * Loaded lazily (only when a trade needs a counter), cached 24h per partner in the KV store.
 * tradableItems is rate limited ~1 req/s by the client; we also cap pages.
 */
import type { CollectibleInstance, RobloxClient, TradableItem } from '../adapters/interfaces.js';
import type { PartnerInventoryStatus } from '../core/api-types.js';
import type { AssetId, UserId } from '../core/types.js';

export const PARTNER_INV_TTL_MS = 86_400_000;
/** 50 items/page; 5 pages = 250 tradable entries, ~5s at 1 req/s. */
export const PARTNER_INV_MAX_PAGES = 5;

export interface PartnerInvEntry { assetId: AssetId; name: string; serial: number | null; isOnHold: boolean; rap: number | null }
export interface PartnerInventoryCache {
  fetchedAt: number;
  state: 'loaded' | 'hidden' | 'error';
  sources: Array<'tradableItems' | 'collectibles'>;
  items: PartnerInvEntry[];
}

export interface KvStore {
  getKv<T>(key: string): T | null;
  setKv<T>(key: string, value: T): void;
}

/** Failed loads are retried after this (a transient 429 / blip should not cost a day). */
export const PARTNER_INV_ERROR_TTL_MS = 15 * 60_000;

export interface PartnerInvLoadOpts {
  /** Treat a cache older than this as stale (never longer than the default TTL). */
  maxAgeMs?: number;
  /** Skip the public collectibles call when tradableItems answered (one request less per partner). */
  collectiblesOnlyAsFallback?: boolean;
}

const key = (uid: UserId) => `partnerInv:${uid}`;

export class PartnerInventory {
  private inflight = new Map<UserId, Promise<PartnerInventoryCache | null>>();
  constructor(private readonly kv: KvStore, private readonly now: () => number = Date.now) {}

  cached(uid: UserId): PartnerInventoryCache | null {
    return this.kv.getKv<PartnerInventoryCache>(key(uid));
  }

  /** `maxAgeMs` tightens the TTL. */
  isFresh(uid: UserId, maxAgeMs?: number): boolean {
    const c = this.cached(uid);
    if (!c) return false;
    const base = c.state === 'error' ? PARTNER_INV_ERROR_TTL_MS : PARTNER_INV_TTL_MS;
    const ttl = maxAgeMs != null ? Math.min(base, maxAgeMs) : base;
    return this.now() - c.fetchedAt < ttl;
  }

  status(uid: UserId): PartnerInventoryStatus {
    const c = this.cached(uid);
    if (!c) return { state: 'not_loaded', fetchedAt: null, itemCount: 0, sources: [] };
    return { state: c.state, fetchedAt: c.fetchedAt, itemCount: c.items.length, sources: c.sources };
  }

  /** Fetch (deduped, cached 24h). Never throws; returns null when no client. */
  async ensure(client: RobloxClient | null, uid: UserId, opts: PartnerInvLoadOpts = {}): Promise<PartnerInventoryCache | null> {
    if (this.isFresh(uid, opts.maxAgeMs)) return this.cached(uid);
    if (!client) return null;
    const running = this.inflight.get(uid);
    if (running) return running;
    const p = this.load(client, uid, opts).finally(() => this.inflight.delete(uid));
    this.inflight.set(uid, p);
    return p;
  }

  private async load(client: RobloxClient, uid: UserId, opts: PartnerInvLoadOpts): Promise<PartnerInventoryCache> {
    const items = new Map<string, PartnerInvEntry>();
    const sources: PartnerInventoryCache['sources'] = [];
    let tradableOk = false;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < PARTNER_INV_MAX_PAGES; page++) {
        const res = await client.getTradableItems(uid, cursor);
        for (const t of res.data) addTradable(items, t);
        tradableOk = true;
        if (!res.nextPageCursor) break;
        cursor = res.nextPageCursor;
      }
    } catch { /* fall back to public collectibles; keep pages already read */ }
    if (tradableOk) sources.push('tradableItems');

    let hidden = false;
    if (!(opts.collectiblesOnlyAsFallback && tradableOk)) try {
      const inv = await client.getCollectibles(uid);
      if (inv === 'hidden') hidden = true;
      else {
        sources.push('collectibles');
        // Collectibles fill gaps (e.g. tradableItems unavailable); tradableItems hold flags win when present.
        for (const c of inv) addCollectible(items, c, tradableOk);
      }
    } catch { /* keep whatever we have */ }

    const state: PartnerInventoryCache['state'] = sources.length ? 'loaded' : hidden ? 'hidden' : 'error';
    const out: PartnerInventoryCache = { fetchedAt: this.now(), state, sources, items: [...items.values()] };
    this.kv.setKv(key(uid), out);
    return out;
  }
}

function addTradable(items: Map<string, PartnerInvEntry>, t: TradableItem): void {
  const assetId = Number(t.targetId);
  if (t.itemType !== 'Asset' || !Number.isFinite(assetId) || assetId <= 0) return;
  const inst = t.instances.length ? t.instances : [{ collectibleItemInstanceId: '', serialNumber: null, isOnHold: false }];
  inst.forEach((i, n) => {
    items.set(`${assetId}:${i.serialNumber ?? `n${n}`}`, { assetId, name: t.itemName, serial: i.serialNumber, isOnHold: i.isOnHold, rap: t.recentAveragePrice });
  });
}

function addCollectible(items: Map<string, PartnerInvEntry>, c: CollectibleInstance, tradableOk: boolean): void {
  // When tradableItems succeeded it is authoritative for what can be traded: only add serials it missed
  // if the asset itself is absent (e.g. page cap reached).
  if (tradableOk && [...items.keys()].some((k) => k.startsWith(`${c.assetId}:`))) return;
  items.set(`${c.assetId}:${c.serialNumber ?? `u${c.userAssetId}`}`, {
    assetId: c.assetId, name: c.name, serial: c.serialNumber, isOnHold: c.isOnHold, rap: c.recentAveragePrice,
  });
}
