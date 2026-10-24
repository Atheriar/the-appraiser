/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Learning loop: verdict accuracy, item value drift, overpay-norm calibration (shrinkage toward
 * the current table), snapshot-based raise/drop-pending signals and the portfolio concentration term.
 * Pure functions only — persistence and scheduling live in src/jobs/learning.ts.
 */
import type { PortfolioContext } from './contracts.js';
import type {
  AssetId, ItemDriftSummary, ItemSnapshot, ItemValueMark, ModelAccuracy, NormSuggestion, NormSuggestionRow,
  OverpayNormTable, TradeOutcome, ValuedItem, ValueTier,
} from './types.js';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const isPositive = (v: TradeOutcome['verdictAtTime']) => v === 'Accept' || v === 'Lean accept';

/** Drift of the trade's value gain since decision, as a fraction of the give value then. */
export function driftPct(o: TradeOutcome, gain: number | null): number | null {
  if (gain == null || o.valueGiveAtTime == null || o.valueGiveAtTime <= 0 || o.rawGainPct == null) return null;
  return gain / o.valueGiveAtTime - o.rawGainPct;
}

/** Absolute value change since decision: gain at 30d minus the edge already present at decision. */
function absDrift(o: TradeOutcome): number | null {
  if (o.valueGainAt30d == null) return null;
  // Legacy outcomes without decision context: no edge to subtract.
  if (o.valueGiveAtTime == null || o.rawGainPct == null) return o.valueGainAt30d;
  return o.valueGainAt30d - o.rawGainPct * o.valueGiveAtTime;
}

export function computeAccuracy(outcomes: TradeOutcome[], now: number, marks: ItemValueMark[] = []): ModelAccuracy {
  const judged = outcomes.filter((o) => o.valueGainAt30d != null || o.valueGainAt7d != null);
  let hits = 0;
  for (const o of judged) {
    const gain = (o.valueGainAt30d ?? o.valueGainAt7d)!;
    // Judge against the norm (gain/give - norm), not the raw sign: an upgrade accepted at the norm
    // overpay is a correct call when values stay flat.
    const good = o.valueGiveAtTime != null && o.valueGiveAtTime > 0
      ? gain / o.valueGiveAtTime - (o.normPct ?? 0) >= 0
      : gain >= 0;
    if (isPositive(o.verdictAtTime) === good) hits++;
  }
  const with30 = (status: TradeOutcome['finalStatus']) => outcomes.filter((o) => o.finalStatus === status && o.valueGainAt30d != null);
  const acc = with30('Completed'), dec = with30('Declined');
  const pctOf = (xs: TradeOutcome[]) => mean(xs.map((o) => driftPct(o, o.valueGainAt30d)).filter((x): x is number => x != null));
  return {
    trades: outcomes.length,
    verdictHitRate: judged.length ? hits / judged.length : null,
    avgDrift30dAccepted: mean(acc.map(absDrift).filter((x): x is number => x != null)),
    avgDrift30dDeclined: mean(dec.map(absDrift).filter((x): x is number => x != null)),
    avgDriftPct30dAccepted: pctOf(acc),
    avgDriftPct30dDeclined: pctOf(dec),
    judged: judged.length,
    accepted30dN: acc.length,
    declined30dN: dec.length,
    itemDrift: summarizeItemDrift(marks),
    calibratedNorms: null,
    computedAt: now,
  };
}

/** Mean item tradeValue drift for received vs given items in completed trades. */
export function summarizeItemDrift(marks: ItemValueMark[]): ItemDriftSummary | null {
  const done = marks.filter((m) => m.finalStatus === 'Completed' && m.value0 > 0);
  if (!done.length) return null;
  const d = (side: 'give' | 'get', k: 'value7d' | 'value30d') =>
    mean(done.filter((m) => m.side === side && m[k] != null).map((m) => m[k]! / m.value0 - 1));
  return {
    received7d: d('get', 'value7d'), received30d: d('get', 'value30d'),
    given7d: d('give', 'value7d'), given30d: d('give', 'value30d'),
    n7: done.filter((m) => m.value7d != null).length, n30: done.filter((m) => m.value30d != null).length,
  };
}

/**
 * Observed overpay of one trade under the spec's convention (normPct = -overpay for UPGRADE,
 * +overpay for DOWNGRADE): an upgrade where the user gave 8% more value observed 0.08 overpay; a
 * downgrade where the user received 8% more observed 0.08 split premium. EVEN shapes carry no signal.
 */
export function observedOverpay(o: TradeOutcome): number | null {
  if (o.rawGainPct == null || !Number.isFinite(o.rawGainPct)) return null;
  if (o.shape === 'UPGRADE') return clamp(-o.rawGainPct, -0.1, 0.4);
  if (o.shape === 'DOWNGRADE') return clamp(o.rawGainPct, -0.1, 0.4);
  return null;
}

export interface CalibrationOptions {
  /** Effective sample (user + marketWeight × market) needed before a tier moves. */
  minSample?: number;
  /** Pseudo-observations of the current value (shrinkage strength). */
  priorStrength?: number;
  /** Deprecated, ignored: non-completed offers are no longer used (they biased the norm). */
  marketWeight?: number;
}

/** small < smallMax <= mid <= midMax < large (same rule as tradeScoring.valueTier). */
function valueTierOf(v: number, t: OverpayNormTable): string {
  return v < t.smallMax ? 'small' : v <= t.midMax ? 'mid' : 'large';
}

/**
 * Suggest per-tier norms from the user's completed trades (weight 1) and the observed market
 * (non-completed offers are excluded: user-declined greed would pull the norm the wrong way). Each tier's estimate is
 * shrunk toward the current value: (Σw·x + k·current) / (Σw + k). Tiers below `minSample` keep current.
 */
export function suggestNorms(outcomes: TradeOutcome[], current: OverpayNormTable, opts: CalibrationOptions = {}): NormSuggestion {
  const minSample = opts.minSample ?? 10;
  const k = opts.priorStrength ?? 20;
  const rows: NormSuggestionRow[] = current.rows.map((r) => {
    let nUser = 0; const nMarket = 0; let wsum = 0, wx = 0, xs: number[] = [];
    for (const o of outcomes) {
      // Re-bucket by the raw dominant value under the current cut-offs when known (cut-offs may have moved).
      const tier = o.dominantValueAtTime != null ? valueTierOf(o.dominantValueAtTime, current) : o.valueTier;
      if (tier !== r.tier) continue;
      const x = observedOverpay(o);
      if (x == null) continue;
      // Only completed trades carry an unambiguous signal. Offers the user declined (or that expired,
      // or partners declined) point in opposite/unknown directions and would bias the norm.
      if (o.finalStatus !== 'Completed') continue;
      const w = 1;
      nUser++;
      wsum += w; wx += w * x; xs.push(x);
    }
    const enough = wsum >= minSample;
    const shrunk = enough ? (wx + k * r.pct) / (wsum + k) : r.pct;
    return {
      tier: r.tier as ValueTier, current: r.pct, suggested: Math.round(clamp(shrunk, 0, current.maxPct) * 1000) / 1000,
      observed: xs.length ? mean(xs) : null, nUser, nMarket, enough,
    };
  });
  const table: OverpayNormTable = { ...current, rows: current.rows.map((r, i) => ({ ...r, pct: rows[i]!.suggested })) };
  return { rows, minSample, priorStrength: k, table };
}

/** Contract entry point: a calibrated table, or null when no tier has enough data to move. */
export function calibrateNorms(outcomes: TradeOutcome[], current: OverpayNormTable, opts?: CalibrationOptions): OverpayNormTable | null {
  const s = suggestNorms(outcomes, current, opts);
  return s.rows.some((r) => r.enough && Math.abs(r.suggested - r.current) >= 0.001) ? { ...s.table, source: 'calibrated' } : null;
}

// ---------------------------------------------------------------------------
// Snapshot-based value lag (raise / drop pending)
// ---------------------------------------------------------------------------

export interface LagSignal {
  kind: 'raise_pending' | 'drop_pending';
  /** mkt / value - 1. */
  changePct: number;
  mkt: number;
  value: number;
  samples: number;
}

/**
 * Value lag from our own snapshot history: mkt = median of (median floor, median RAP) across
 * the window. Flags when mkt sits ≥ `threshold` above/below the item's value AND the last
 * `persist` snapshots all sit on the same side (so a single spike does not fire). Needs the
 * window to span at least `minSpanMs`.
 */
export function snapshotLag(history: ItemSnapshot[], value: number | null, now: number, o: {
  windowMs?: number; threshold?: number; persist?: number; minSpanMs?: number;
} = {}): LagSignal | null {
  const windowMs = o.windowMs ?? 7 * 86_400_000, th = o.threshold ?? 0.1, persist = o.persist ?? 3, minSpan = o.minSpanMs ?? 86_400_000;
  if (value == null || value <= 0) return null;
  // One point per market observation: Rolimons-overlay rows reuse the market fetchedAt, so they are
  // copies of the same observation and must not count toward `persist`.
  const byAt = new Map<number, ItemSnapshot>();
  for (const h of history) if (h.fetchedAt >= now - windowMs && h.fetchedAt <= now) byAt.set(h.fetchedAt, h);
  const hs = [...byAt.values()].sort((a, b) => a.fetchedAt - b.fetchedAt);
  if (hs.length < persist || hs[hs.length - 1]!.fetchedAt - hs[0]!.fetchedAt < minSpan) return null;
  const point = (h: ItemSnapshot) => median([h.floorPrice ?? NaN, h.rap > 0 ? h.rap : NaN]);
  const pts = hs.map(point).filter((x): x is number => x != null);
  if (pts.length < persist) return null;
  const mkt = median([median(hs.map((h) => h.floorPrice ?? NaN)) ?? NaN, median(hs.map((h) => (h.rap > 0 ? h.rap : NaN))) ?? NaN]);
  if (mkt == null) return null;
  const last = pts.slice(-persist);
  // A raise needs first-party sell-book evidence: RAP alone is too easy to push up.
  const hasFloor = hs.some((h) => h.floorPrice != null && h.floorPrice > 0);
  if (hasFloor && mkt >= value * (1 + th) && last.every((p) => p >= value * (1 + th / 2))) return { kind: 'raise_pending', changePct: mkt / value - 1, mkt, value, samples: hs.length };
  if (mkt <= value * (1 - th) && last.every((p) => p <= value * (1 - th / 2))) return { kind: 'drop_pending', changePct: mkt / value - 1, mkt, value, samples: hs.length };
  return null;
}

// ---------------------------------------------------------------------------
// Portfolio concentration
// ---------------------------------------------------------------------------

/**
 * Liquidity-weighted Herfindahl index: Σ share² × (1.5 − liquidity). A portfolio held in one
 * illiquid item scores highest. Unknown liquidity counts as 0.5 (factor 1).
 */
export function concentrationIndex(values: Map<AssetId, number>, liq: Map<AssetId, number>): number {
  let total = 0;
  for (const v of values.values()) if (v > 0) total += v;
  if (total <= 0) return 0;
  let h = 0;
  for (const [id, v] of values) if (v > 0) h += (v / total) ** 2 * (1.5 - (liq.get(id) ?? 0.5));
  return h;
}

/**
 * Portfolio-fit points (pp) for how the trade changes concentration: +150 × ΔHHI, clamped to ±15.
 * Spreading out of one big illiquid holding earns a clear bonus; piling more into it costs.
 * Returns null when there is no per-item ownership data.
 */
export function concentrationDelta(give: ValuedItem[], get: ValuedItem[], portfolio: PortfolioContext): { points: number; before: number; after: number } | null {
  const owned = portfolio.ownedValues;
  if (!owned || owned.size === 0) return null;
  const liq = new Map<AssetId, number>();
  for (const it of [...give, ...get]) liq.set(it.assetId, it.liquidity);
  const after = new Map(owned);
  for (const g of give) after.set(g.assetId, Math.max(0, (after.get(g.assetId) ?? 0) - g.tradeValue));
  for (const g of get) after.set(g.assetId, (after.get(g.assetId) ?? 0) + g.tradeValue);
  const before = concentrationIndex(owned, liq), aft = concentrationIndex(after, liq);
  const points = clamp((before - aft) * 150, -15, 15);
  return { points: Math.abs(points) < 0.05 ? 0 : points, before, after: aft };
}

/**
 * Overlay a snapshot-based lag signal on a valued item when the valuation itself did not flag one
 * (it only sees median30dSale). Lift = 0.5 × (mkt − value), capped at ±10% of tradeValue, valued
 * (roli_value basis) items only.
 */
export function applySnapshotLag(v: ValuedItem, sig: LagSignal | null): ValuedItem {
  if (!sig || v.basis !== 'roli_value' || v.flags.includes('raise_pending') || v.flags.includes('drop_pending')) return v;
  if (sig.kind === 'raise_pending' && (v.flags.includes('projected') || v.flags.includes('roli_projected'))) return v;
  const liftFrac = clamp((0.5 * (sig.mkt - sig.value)) / sig.value, -0.1, 0.1);
  if (sig.kind === 'raise_pending' ? liftFrac <= 0 : liftFrac >= 0) return v;
  return {
    ...v,
    tradeValue: v.tradeValue * (1 + liftFrac),
    flags: [...v.flags, sig.kind],
    evidence: [...v.evidence, {
      code: sig.kind === 'raise_pending' ? 'snapshot_lag_up' : 'snapshot_lag_down',
      message: `Our snapshots (${sig.samples}) put the market at ${Math.round(sig.mkt).toLocaleString()} vs value ${Math.round(sig.value).toLocaleString()} (${(sig.changePct * 100).toFixed(0)}%); trade value ${liftFrac > 0 ? 'lifted' : 'lowered'} ${(Math.abs(liftFrac) * 100).toFixed(1)}%`,
      data: { mkt: sig.mkt, value: sig.value, samples: sig.samples },
      severity: sig.kind === 'raise_pending' ? 'good' : 'warn',
    }],
  };
}
