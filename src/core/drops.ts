/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Pure helpers for the Drops feed (new limited releases). Read-only: nothing here buys anything.
 * The UI links each drop to https://www.roblox.com/catalog/{assetId}; the user buys it themselves.
 */
import type { AssetId, DropItem, DropSaleStatus, DropSettings, FlipEstimate, ItemTargetType } from './types.js';

export const ROBLOX_CREATOR_ID = 1;
export const IN_GAME_ONLY = 'ExperiencesDevApiOnly';

/** Strict catalog link for a drop (the only external URL notifications may open). */
export function catalogUrl(assetId: AssetId, itemType: ItemTargetType = 'Asset'): string {
  return itemType === 'Bundle' ? `https://www.roblox.com/bundles/${assetId}` : `https://www.roblox.com/catalog/${assetId}`;
}

export const CATALOG_URL_RE = /^https:\/\/www\.roblox\.com\/(catalog|bundles)\/\d+$/;

/** Tradable iff Roblox-made (creator User 1) and Limited / LimitedUnique. UGC 'Collectible' is resale-only. */
export function isTradable(creatorId: number | null, creatorType: string | null, restrictions: readonly string[]): boolean {
  const robloxMade = creatorId === ROBLOX_CREATOR_ID && (creatorType == null || creatorType === 'User');
  return robloxMade && restrictions.some((r) => r === 'Limited' || r === 'LimitedUnique');
}

export function dropKey(collectibleItemId: string | null, itemType: ItemTargetType, assetId: AssetId): string {
  return collectibleItemId || `${itemType}:${assetId}`;
}

/** Roblox uses 0001-01-01 for "no deadline". */
export function parseDeadline(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t : null;
}

export function isSoldOut(d: Pick<DropItem, 'remaining' | 'totalQuantity'>): boolean {
  return d.remaining != null && d.remaining <= 0 && (d.totalQuantity ?? 1) > 0;
}

/** True when the drop was created within the window (falls back to first-seen when Roblox gave no date). */
export function isRecent(d: Pick<DropItem, 'createdAt' | 'firstSeenAt'> & Partial<Pick<DropItem, 'releaseAt'>>, windowMs: number, now: number): boolean {
  return now - Math.max(d.createdAt ?? d.firstSeenAt, d.releaseAt ?? 0) <= windowMs;
}

/**
 * Quick flip estimate: (reference price after the marketplace fee) - original price.
 * Reference: lowest resale listing, else Rolimons value, else RAP. Early resale listings are noisy, so
 * confidence stays low until the drop has sold out and has a few minutes of resale history.
 */
export function flipEstimate(
  d: Pick<DropItem, 'price' | 'lowestResalePrice' | 'remaining' | 'totalQuantity' | 'createdAt' | 'firstSeenAt' | 'inGameOnly' | 'hasResellers'>,
  ref: { roliValue: number | null; rap: number | null },
  feePct: number,
  now: number,
): FlipEstimate {
  const price = d.price ?? null;
  let basis: FlipEstimate['basis'] = null;
  let refPrice: number | null = null;
  if (d.lowestResalePrice != null && d.lowestResalePrice > 0) { basis = 'resale'; refPrice = d.lowestResalePrice; }
  else if (ref.roliValue != null && ref.roliValue > 0) { basis = 'value'; refPrice = ref.roliValue; }
  else if (ref.rap != null && ref.rap > 0) { basis = 'rap'; refPrice = ref.rap; }
  if (refPrice == null) {
    return { basis: null, refPrice: null, net: null, profit: null, profitPct: null, confidence: 'none', note: 'No resale listing or value yet' };
  }
  const net = Math.floor(refPrice * (1 - feePct));
  const profit = price != null ? net - price : null;
  const profitPct = profit != null && price != null && price > 0 ? profit / price : null;
  const ageMin = (now - (d.createdAt ?? d.firstSeenAt)) / 60_000;
  const soldOut = isSoldOut(d);
  let confidence: FlipEstimate['confidence'];
  let note: string;
  if (!soldOut) { confidence = 'low'; note = basis === 'resale' ? 'Still in stock: resellers must undercut the original price' : `Still in stock (${basis === 'value' ? 'Rolimons value' : 'RAP'})`; }
  else if (ageMin < 15) { confidence = 'low'; note = `Sold out < 15 min ago; ${basis === 'resale' ? 'first listings are volatile' : basis === 'value' ? 'Rolimons value' : 'RAP'}`; }
  else if (basis === 'value') { confidence = 'high'; note = 'Rolimons value'; }
  else if (basis === 'rap') { confidence = 'medium'; note = 'RAP (no live listing)'; }
  else { confidence = 'medium'; note = 'Lowest resale listing (one listing, not a sale)'; }
  if (d.inGameOnly) note += '; in-game only (not buyable on the site)';
  return { basis, refPrice, net, profit, profitPct, confidence, note: `${note}; ${Math.round(feePct * 100)}% fee applied` };
}

/** Whether a newly seen drop should raise a desktop notification under the user's filters. */
export function matchesNotify(d: DropItem, s: DropSettings): boolean {
  if (!s.notify) return false;
  if ((s.notifyTradableOnly || !s.includeUgc) && !d.tradable) return false;
  if (s.notifyMaxPrice > 0 && (d.price == null || d.price > s.notifyMaxPrice)) return false;
  if (s.notifyMinQuantity > 0 && (d.remaining ?? d.totalQuantity ?? 0) < s.notifyMinQuantity) return false;
  if (isSoldOut(d)) return false;
  return true;
}

/** productSaleStatus from marketplace-items: 3 on sale and 2 off sale were observed live (2026-10-21); 1 is assumed pending. */
export function saleStatusFrom(v: unknown): DropSaleStatus {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (n === 3 || n === 'OnSale') return 'onSale';
  if (n === 2 || n === 'OffSale') return 'offSale';
  if (n === 1 || n === 'Pending') return 'pending';
  return null;
}

/**
 * scheduledRelease from marketplace-items. Only null was observed so far, so accept an ISO string, epoch
 * number, or an object holding one (preferring keys that look like a release/start time).
 */
export function parseScheduledRelease(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null;
  if (typeof v === 'string') return parseDeadline(v);
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    const pref = entries.filter(([k]) => /release|start|begin|time|date/i.test(k) && !/end|deadline/i.test(k));
    for (const [, x] of [...pref, ...entries]) {
      if (typeof x === 'string' || typeof x === 'number') {
        const t = parseScheduledRelease(x);
        if (t != null) return t;
      }
    }
  }
  return null;
}

/** How long after a scheduled release a drop that still is not on sale keeps the "upcoming" badge. */
export const RELEASE_GRACE_MS = 10 * 60_000;

/** Announced but not on sale yet (a scheduled release in the future, or just past and not flipped on sale yet). */
export function isUpcoming(d: Pick<DropItem, 'releaseAt' | 'saleStatus' | 'releasedAt'>, now: number): boolean {
  if (d.releaseAt == null || d.releasedAt != null || d.saleStatus === 'onSale') return false;
  return now < d.releaseAt + RELEASE_GRACE_MS;
}

/** Can be bought on the website right now (as far as we know). */
export function isPurchasable(d: Pick<DropItem, 'saleStatus' | 'remaining' | 'totalQuantity' | 'releaseAt' | 'inGameOnly'>, now: number): boolean {
  if (d.inGameOnly) return false;
  if (isSoldOut(d)) return false;
  if (d.saleStatus === 'onSale') return true;
  if (d.saleStatus != null) return false;
  return d.releaseAt == null || d.releaseAt <= now;
}

/** Detection lag (first seen by a live poll minus Roblox's itemCreatedUtc). Null for seeded rows or no date. */
export function detectionLagMs(d: Pick<DropItem, 'createdAt' | 'firstSeenAt' | 'seenLive'>): number | null {
  if (!d.seenLive || d.createdAt == null) return null;
  return Math.max(0, d.firstSeenAt - d.createdAt);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
