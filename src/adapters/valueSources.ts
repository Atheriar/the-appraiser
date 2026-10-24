/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * ValueSource implementations. Both degrade gracefully: refresh() never throws; on failure the
 * last cached values are kept and health() reports the error.
 */
import { DEFAULT_SETTINGS, type AssetId, type CollectibleItemId, type Demand, type Settings, type SourceHealth, type SourceValue, type Trend, type ValueSource } from '../core/types.js';
import type { ResaleData, RobloxClient, RolimonsClient } from './interfaces.js';
import { redact } from './redact.js';

function emptyHealth(id: string): SourceHealth {
  return { id, ok: true, lastSuccessAt: null, lastErrorAt: null, lastError: null, count429: 0, cacheHits: 0, cacheMisses: 0 };
}

abstract class CachedSource {
  protected values = new Map<AssetId, SourceValue>();
  protected h: SourceHealth;
  constructor(id: string, protected readonly now: () => number) { this.h = emptyHealth(id); }
  get(assetId: AssetId): SourceValue | null {
    const v = this.values.get(assetId);
    if (v) this.h.cacheHits++; else this.h.cacheMisses++;
    return v ?? null;
  }
  getMany(assetIds: AssetId[]): Map<AssetId, SourceValue> {
    const out = new Map<AssetId, SourceValue>();
    for (const id of assetIds) { const v = this.values.get(id); if (v) out.set(id, v); }
    return out;
  }
  allAssetIds(): AssetId[] { return [...this.values.keys()]; }
  health(): SourceHealth { return { ...this.h }; }
  protected ok(): void { this.h.ok = true; this.h.lastSuccessAt = this.now(); }
  protected err(e: unknown): void {
    this.h.ok = false; this.h.lastErrorAt = this.now();
    this.h.lastError = redact(e instanceof Error ? e.message : String(e));
    if (/429/.test(this.h.lastError)) this.h.count429++;
  }
}

export class RolimonsValueSource extends CachedSource implements ValueSource {
  readonly id = 'rolimons' as const;
  readonly label = 'Rolimons';
  constructor(private readonly client: RolimonsClient, now: () => number = Date.now) { super('value:rolimons', now); }
  async refresh(): Promise<void> {
    try {
      const items = await this.client.getItemDetails();
      const at = this.now();
      const next = new Map<AssetId, SourceValue>();
      for (const it of items.values()) {
        next.set(it.assetId, {
          assetId: it.assetId, value: it.value, rap: it.rap,
          demand: it.demand === -1 ? null : it.demand, trend: it.trend === -1 ? null : it.trend,
          projected: it.projected, rare: it.rare, fetchedAt: at,
        });
      }
      this.values = next;
      this.ok();
    } catch (e) { this.err(e); }
  }
}

// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Pure first-party estimate from marketplace-sales resale data:
 *  value  = median of daily average sale prices over the last 14d (spike-robust), else RAP
 *  demand = from sales velocity (sales/day over 30d)
 *  trend  = median(last 30d) vs median(prior 30d), "unstable" when dispersion is high
 *  projected = RAP > 1.25 x 30d median sale price
 */
export function estimateFromResale(
  assetId: AssetId, r: ResaleData, now: number, rareMaxCopies = DEFAULT_SETTINGS.valuation.rareMaxCopies,
  demandPerDay: number[] = DEFAULT_SETTINGS.valuation.derivedDemandPerDay,
): SourceValue {
  const within = (from: number, to: number) => r.priceDataPoints.filter((p) => p.t >= now - to * DAY && p.t < now - from * DAY).map((p) => p.value);
  const last14 = within(0, 14);
  const last30 = within(0, 30);
  const prior30 = within(30, 60);
  const vol30 = r.volumeDataPoints.filter((p) => p.t >= now - 30 * DAY).reduce((s, p) => s + p.value, 0);
  const perDay = vol30 / 30;
  // Cut-offs (settings.valuation.derivedDemandPerDay) for demand 4, 3, 2, 1; anything slower is 0.
  const cuts = demandPerDay.length === 4 && demandPerDay.every(Number.isFinite) ? demandPerDay : DEFAULT_SETTINGS.valuation.derivedDemandPerDay;
  const demand: Demand = r.stale ? -1 : perDay >= cuts[0]! ? 4 : perDay >= cuts[1]! ? 3 : perDay >= cuts[2]! ? 2 : perDay >= cuts[3]! ? 1 : 0;

  const m30 = median(last30);
  const mPrior = median(prior30);
  let trend: Trend = -1;
  if (m30 != null && last30.length >= 3) {
    const mean = last30.reduce((s, x) => s + x, 0) / last30.length;
    const cv = Math.sqrt(last30.reduce((s, x) => s + (x - mean) ** 2, 0) / last30.length) / (mean || 1);
    if (cv > 0.35) trend = 1;
    else if (mPrior != null) {
      const ch = m30 / mPrior - 1;
      trend = ch > 0.08 ? 3 : ch < -0.08 ? 0 : 2;
    } else trend = 2;
  }
  const value = median(last14) ?? (r.stale ? null : r.recentAveragePrice);
  return {
    assetId,
    value: value == null ? null : Math.round(value),
    rap: r.recentAveragePrice,
    demand: demand === -1 ? null : demand,
    trend: trend === -1 ? null : trend,
    projected: m30 != null ? r.recentAveragePrice > 1.25 * m30 : null,
    rare: r.assetStock != null ? r.assetStock <= rareMaxCopies : null,
    fetchedAt: now,
  };
}

export interface FirstPartyDeps {
  roblox: RobloxClient;
  /** Asset ids worth tracking (trades, inventory, watchlist). */
  tracked: () => AssetId[];
  /** Cached collectibleItemId lookup (db). null => economy fallback. */
  collectibleItemId: (assetId: AssetId) => CollectibleItemId | null | Promise<CollectibleItemId | null>;
  /** Max resale-data calls per refresh (marketplace-sales is 50/60s). */
  maxPerRefresh?: number;
  /** Re-fetch an item only after this long. */
  ttlMs?: number;
  now?: () => number;
  /** Live settings (rare cut-off, derived-demand cut-offs); defaults when absent. */
  settings?: () => Settings;
}

export class RobloxFirstPartyValueSource extends CachedSource implements ValueSource {
  readonly id = 'roblox_first_party' as const;
  readonly label = 'Roblox market (first-party)';
  constructor(private readonly d: FirstPartyDeps) { super('value:roblox_first_party', d.now ?? Date.now); }

  async refresh(): Promise<void> {
    const ttl = this.d.ttlMs ?? 30 * 60_000;
    const now = this.now();
    const due = [...new Set(this.d.tracked())]
      .map((id) => ({ id, at: this.values.get(id)?.fetchedAt ?? 0 }))
      .filter((x) => now - x.at >= ttl)
      .sort((a, b) => a.at - b.at)
      .slice(0, this.d.maxPerRefresh ?? 20);
    let failures = 0;
    for (const { id } of due) {
      try {
        const cid = await this.d.collectibleItemId(id);
        const r = await this.d.roblox.getResaleData(id, cid);
        const v = this.d.settings?.().valuation;
        if (r) this.values.set(id, estimateFromResale(id, r, this.now(), v?.rareMaxCopies, v?.derivedDemandPerDay));
      } catch (e) { failures++; this.err(e); }
    }
    if (failures === 0) this.ok();
  }
}
