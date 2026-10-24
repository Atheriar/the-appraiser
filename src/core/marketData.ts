/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Keeping market-dependent inputs fresh without code changes:
 *  - trade metadata merge (a failed or partial fetch never reverts live values to hard-coded defaults),
 *  - market index (median Rolimons value) and the opt-in scaling of absolute-Robux thresholds,
 *  - catalog refresh scheduling (complete rows are re-fetched on a TTL, not cached forever).
 * Pure functions; the analyst job wires them up.
 */
import { DEFAULT_LIQUIDITY, type Settings, type TradeMetadata } from './types.js';

type MetaField = NonNullable<TradeMetadata['liveFields']>[number];
const META_FIELDS: MetaField[] = ['maxItemsPerSide', 'minValueRatio', 'tradeSystemMaxRobuxPercent', 'tradeSystemRobuxFee'];

/** Which fields of a stored row were live from Roblox (rows saved before liveFields existed: verified => the two checked fields). */
function liveOf(m: TradeMetadata): Set<MetaField> {
  if (m.liveFields) return new Set(m.liveFields);
  return new Set<MetaField>(m.verified ? ['maxItemsPerSide', 'tradeSystemRobuxFee', 'tradeSystemMaxRobuxPercent'] : []);
}

/**
 * Field-by-field merge: a field Roblox sent now wins; a field it left out keeps the last live value;
 * only a field that was never live falls back to the default carried in `next`.
 */
export function mergeTradeMetadata(prev: TradeMetadata | null, next: TradeMetadata): TradeMetadata {
  if (!prev) return next;
  const nextLive = liveOf(next);
  const prevLive = liveOf(prev);
  const out: TradeMetadata = { ...next };
  const live = new Set(nextLive);
  for (const f of META_FIELDS) {
    if (nextLive.has(f) || !prevLive.has(f)) continue;
    (out as unknown as Record<string, unknown>)[f] = prev[f];
    live.add(f);
  }
  out.liveFields = META_FIELDS.filter((f) => live.has(f));
  out.verified = live.has('maxItemsPerSide') && live.has('tradeSystemRobuxFee');
  return out;
}

export interface MarketIndex { median: number; n: number; at: number }

/** Median Rolimons value over valued items (value > 0). null with too few items to be meaningful. */
export function computeMarketIndex(values: Iterable<number | null | undefined>, now: number, minItems = 200): MarketIndex | null {
  const xs: number[] = [];
  for (const v of values) if (v != null && Number.isFinite(v) && v > 0) xs.push(v);
  if (xs.length < minItems) return null;
  xs.sort((a, b) => a - b);
  const m = xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
  return { median: m, n: xs.length, at: now };
}

/** Current / reference median, clamped to [1/maxScale, maxScale]. 1 when scaling is off or data is missing. */
export function marketScale(settings: Settings, index: MarketIndex | null, autoReference: number | null): number {
  const m = settings.market;
  if (!m?.scaleWithMarket || !index || !(index.median > 0)) return 1;
  const ref = m.referenceMedianValue > 0 ? m.referenceMedianValue : autoReference;
  if (!ref || !(ref > 0)) return 1;
  const cap = m.maxScale > 1 ? m.maxScale : 4;
  return Math.min(cap, Math.max(1 / cap, index.median / ref));
}

/**
 * Settings the model sees: absolute-Robux thresholds (overpay tier cut-offs, poison-check minimum,
 * price-tier liquidity anchor) multiplied by the market scale. Ratios, weights and copy counts are
 * price-level independent and left alone. Returns the same object when the scale is 1.
 */
export function scaleModelSettings(s: Settings, scale: number): Settings {
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-9) return s;
  const liq = { ...DEFAULT_LIQUIDITY, ...(s.valuation.liquidity ?? {}) };
  return {
    ...s,
    overpayNorms: { ...s.overpayNorms, smallMax: Math.round(s.overpayNorms.smallMax * scale), midMax: Math.round(s.overpayNorms.midMax * scale) },
    scoring: { ...s.scoring, poisonMinValue: Math.round(s.scoring.poisonMinValue * scale) },
    valuation: { ...s.valuation, liquidity: { ...liq, priceTierAnchor: Math.round(liq.priceTierAnchor * scale) } },
  };
}

export interface CatalogRowLike {
  catalogFetchedAt: number | null;
  collectibleItemId: string | null;
  totalQuantity?: number | null;
  isLimitedU: boolean | null;
}

/**
 * Whether a cached catalog row should be fetched again:
 *  - never fetched -> yes;
 *  - incomplete (no collectibleItemId / supply) -> after poll.catalogCacheMs;
 *  - seen as non-limited -> after poll.catalogNonLimitedRefreshMs (it may have become limited);
 *  - complete -> after poll.catalogRefreshMs (supply burns / mints, creator renames).
 */
export function catalogDue(r: CatalogRowLike | null | undefined, now: number, poll: Settings['poll']): boolean {
  if (!r || r.catalogFetchedAt == null) return true;
  const age = now - r.catalogFetchedAt;
  const incomplete = !r.collectibleItemId || r.totalQuantity == null;
  if (incomplete && age > poll.catalogCacheMs) return true;
  if (r.isLimitedU === false && age > (poll.catalogNonLimitedRefreshMs ?? 86_400_000)) return true;
  return age > (poll.catalogRefreshMs ?? 7 * 86_400_000);
}
