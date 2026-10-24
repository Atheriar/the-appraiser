/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import type { RolimonsItem, ResaleData, Reseller } from '../adapters/interfaces.js';
import type { AssetId, ItemSnapshot, PricePoint, ReconstructedSale, TradeItem, TradeStatus } from '../core/types.js';


const DAY = 86_400_000;

export function emptySnapshot(assetId: AssetId, name: string, now: number): ItemSnapshot {
  return {
    assetId, collectibleItemId: null, itemType: 'Asset', name, isLimitedU: false,
    rap: 0, roliValue: null, roliDefaultValue: null, roliDemand: null, roliTrend: null, roliProjected: null, roliRare: null,
    floorPrice: null, resellerCount: null, totalQuantity: null, publicCopies: null,
    sales7d: null, sales30d: null, dailyPrice: [], dailyVolume: [], lastSales: [], fetchedAt: now, sources: [],
  };
}

/** Overlay current Rolimons fields (does not touch fetchedAt: that tracks market data freshness). */
export function overlayRoli(s: ItemSnapshot, r: RolimonsItem | undefined): ItemSnapshot {
  if (!r) return s;
  const out: ItemSnapshot = {
    ...s,
    name: s.name || r.name,
    roliValue: r.value, roliDefaultValue: r.defaultValue, roliDemand: r.demand, roliTrend: r.trend,
    roliProjected: r.projected, roliRare: r.rare,
    rap: s.rap > 0 ? s.rap : r.rap,
    sources: s.sources.includes('rolimons') ? s.sources : [...s.sources, 'rolimons'],
  };
  if (r.acronym) out.acronym = r.acronym;
  return out;
}

export function overlayTradeItem(s: ItemSnapshot, it: TradeItem | undefined): ItemSnapshot {
  if (!it) return s;
  return {
    ...s,
    name: s.name || it.name,
    collectibleItemId: s.collectibleItemId ?? it.collectibleItemId,
    itemType: it.itemType ?? s.itemType,
    rap: s.rap > 0 ? s.rap : it.rap,
    totalQuantity: s.totalQuantity ?? it.assetStock,
    isLimitedU: s.isLimitedU || (it.assetStock != null && it.assetStock > 0),
  };
}

const sumSince = (pts: PricePoint[], since: number) => pts.filter((p) => p.t >= since).reduce((a, p) => a + p.value, 0);

/** Build a fresh market snapshot from marketplace-sales data (+ resellers) on top of the previous one. */
export function marketSnapshot(
  prev: ItemSnapshot, resale: ResaleData | null, resellers: { rows: Reseller[]; capped: boolean } | null, now: number,
): ItemSnapshot {
  // fetchedAt tracks market-data freshness: only advance it when something actually came back, so a
  // failed fetch keeps the old timestamp (and goes stale) instead of passing old data off as fresh.
  const freshResale = !!resale && !resale.stale;
  const s: ItemSnapshot = {
    ...prev, fetchedAt: freshResale || resellers ? now : prev.fetchedAt,
    sources: prev.sources.filter((x) => x === 'rolimons' || x === 'manual' || x === 'owners'),
  };
  if (!resellers && freshResale) {
    // Fresh sales data but no sell book this time: do not carry the old floor under a fresh timestamp.
    s.floorPrice = null; s.resellerCount = null; delete s.resellerCountCapped;
  }
  if (resale && !resale.stale) {
    s.rap = resale.recentAveragePrice;
    s.dailyPrice = resale.priceDataPoints;
    s.dailyVolume = resale.volumeDataPoints;
    s.sales7d = sumSince(resale.volumeDataPoints, now - 7 * DAY);
    s.sales30d = sumSince(resale.volumeDataPoints, now - 30 * DAY);
    if (resale.assetStock != null) s.totalQuantity = resale.assetStock;
    s.numberRemaining = resale.numberRemaining;
    s.isLimitedU = s.isLimitedU || (resale.assetStock != null && resale.assetStock > 0);
    s.sources.push(resale.source);
  }
  if (resellers) {
    const prices = resellers.rows.map((r) => r.price).filter((p) => p > 0);
    s.floorPrice = prices.length ? Math.min(...prices) : null;
    s.resellerCount = resellers.rows.length;
    s.resellerCountCapped = resellers.capped;
    s.sources.push('marketplace_sales');
  }
  s.sources.push('catalog');
  s.sources = [...new Set(s.sources)];
  return s;
}

/**
 * Merge Rolimons reconstructed sales (saleactivity ring buffer + RAP-delta) into a snapshot.
 * Always sets lastSales (newest first). When first-party velocity is missing (no marketplace-sales
 * data, or the economy fallback was stale), derives sales7d/30d and a daily price/volume series
 * from the reconstructed sales so liquidity/momentum use observed velocity, not only Rolimons demand.
 */
export function applyReconstructedSales(s: ItemSnapshot, sales: ReconstructedSale[], now: number): ItemSnapshot {
  const recent = sales.filter((x) => x.t >= now - 30 * DAY && x.price > 0).sort((a, b) => b.t - a.t);
  const out: ItemSnapshot = { ...s, lastSales: recent.slice(0, 50) };
  const firstParty = s.sources.includes('marketplace_sales') || s.sources.includes('economy_fallback');
  if (firstParty && s.sales30d != null) return out;
  if (!recent.length) return out;
  out.sales30d = recent.length;
  out.sales7d = recent.filter((x) => x.t >= now - 7 * DAY).length;
  if (!s.dailyPrice.length) {
    const byDay = new Map<number, number[]>();
    for (const x of recent) {
      const d = Math.floor(x.t / DAY) * DAY;
      const arr = byDay.get(d) ?? [];
      arr.push(x.price);
      byDay.set(d, arr);
    }
    const days = [...byDay.entries()].sort((a, b) => b[0] - a[0]);
    out.dailyPrice = days.map(([t, ps]) => ({ t, value: ps.reduce((a, b) => a + b, 0) / ps.length }));
    out.dailyVolume = days.map(([t, ps]) => ({ t, value: ps.length }));
  }
  return out;
}

/** Order items for a market refresh: never-fetched first, then oldest snapshot; cap to `max`. */
export function marketRefreshOrder(ids: AssetId[], lastFetched: (id: AssetId) => number | null, max: number): AssetId[] {
  return [...new Set(ids)]
    .map((id) => ({ id, at: lastFetched(id) ?? -1 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(0, max))
    .map((x) => x.id);
}

/** Lenient status parse: unknown strings -> 'Unknown' (raw kept by caller). */
const STATUSES: TradeStatus[] = ['Open', 'Pending', 'Completed', 'Expired', 'Declined', 'RejectedDueToError', 'Countered', 'Processing', 'InterventionRequired', 'TwoStepVerificationRequired'];
export function parseStatus(raw: string): TradeStatus {
  const norm = raw.replace(/[\s_-]/g, '').toLowerCase();
  return STATUSES.find((s) => s.toLowerCase() === norm) ?? 'Unknown';
}

export function ownerStats(rows: Array<{ ownerId: number | null; updated: number }>, now: number) {
  const by = new Map<number, number>();
  for (const r of rows) if (r.ownerId != null) by.set(r.ownerId, (by.get(r.ownerId) ?? 0) + 1);
  const counts = [...by.values()].sort((a, b) => b - a);
  const n = rows.length;
  return {
    publicCopies: n,
    topOwnerCopies: counts[0] ?? 0,
    top3OwnerShare: n ? (counts.slice(0, 3).reduce((a, b) => a + b, 0) / n) : 0,
    recentOwnerChurn30d: n ? rows.filter((r) => r.updated >= now - 30 * DAY).length / n : 0,
  };
}
