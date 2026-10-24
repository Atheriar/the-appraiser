/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * My Trades: pure helpers for the completed-trade ledger (GET /api/my-trades).
 * Value-at-trade-time basis selection, P&L math, pre-trade inventory reconstruction
 * (so the duplicate discount never applies to copies the user owns only because of that trade)
 * and the summary. No I/O here; src/jobs/myTrades.ts wires it to the repository and engine.
 */
import type { MyTradePnl, MyTradeRow, MyTradesSummary, ThenBasis } from './api-types.js';
import type { AssetId, TradeSnapshot } from './types.js';

const DAY = 86_400_000;

export interface ThenInput {
  /** The item as valued by the score stored at trade time (index-matched), if any. */
  scored: { tradeValue: number; rap: number } | null;
  /** The nearest item snapshot at or before the trade date, already valued as of that date. */
  snapshot: { tradeValue: number; rap: number; at: number } | null;
  /** Current valuation (fallback). */
  current: { tradeValue: number; rap: number };
  /** RAP Roblox reported in the trade payload (used as RAP-then for the fallback when > 0). */
  tradeRap: number | null;
  tradeAt: number;
}
export interface ThenValue {
  valueThen: number; rapThen: number; basis: ThenBasis; confidence: 'high' | 'medium' | 'low'; basisNote: string; snapshotAt: number | null;
}

const ageText = (ms: number): string => {
  const d = ms / DAY;
  if (d < 1) return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
  return `${Math.round(d)}d`;
};

/** Pick the best available "value at trade time": stored score > snapshot at/before the date > current (estimated). */
export function pickThenValue(i: ThenInput): ThenValue {
  if (i.scored) {
    return { valueThen: i.scored.tradeValue, rapThen: i.scored.rap, basis: 'score_at_trade', confidence: 'high', basisNote: 'scored by the app at trade time', snapshotAt: null };
  }
  if (i.snapshot && i.snapshot.at <= i.tradeAt) {
    const age = i.tradeAt - i.snapshot.at;
    const confidence = age <= 3 * DAY ? 'high' : age <= 14 * DAY ? 'medium' : 'low';
    return {
      valueThen: i.snapshot.tradeValue, rapThen: i.snapshot.rap, basis: 'snapshot', confidence,
      basisNote: `item snapshot ${ageText(age)} before the trade`, snapshotAt: i.snapshot.at,
    };
  }
  return {
    valueThen: i.current.tradeValue, rapThen: i.tradeRap != null && i.tradeRap > 0 ? i.tradeRap : i.current.rap,
    basis: 'current_estimate', confidence: 'low',
    basisNote: 'estimated from current value (no data from before the trade)', snapshotAt: null,
  };
}

const BASIS_RANK: Record<ThenBasis, number> = { score_at_trade: 0, snapshot: 1, current_estimate: 2 };
/** Weakest basis among items (the row badge). A trade with no items counts as scored. */
export function weakestBasis(bs: ThenBasis[]): ThenBasis {
  return bs.reduce<ThenBasis>((w, b) => (BASIS_RANK[b] > BASIS_RANK[w] ? b : w), 'score_at_trade');
}

export interface SideValues { valueThen: number; valueNow: number; rapThen: number; rapNow: number; robux: number }

/**
 * P&L from the user's side. Robux the user gives cost the full amount; Robux received count after the
 * trade fee (the same basis the scorer uses). Percentages are against the given side (null when it is 0).
 */
export function tradePnl(give: SideValues, get: SideValues, fee: number): MyTradePnl {
  const giveR = give.robux;
  const getR = get.robux * (1 - fee);
  const giveThen = give.valueThen + giveR, getThen = get.valueThen + getR;
  const giveNow = give.valueNow + giveR, getNow = get.valueNow + getR;
  const gainThen = getThen - giveThen;
  const gainNow = getNow - giveNow;
  return {
    gainThen, gainThenPct: giveThen > 0 ? gainThen / giveThen : null,
    gainNow, gainNowPct: giveNow > 0 ? gainNow / giveNow : null,
    changeSince: gainNow - gainThen,
    rapGainThen: get.rapThen + getR - (give.rapThen + giveR),
    rapGainNow: get.rapNow + getR - (give.rapNow + giveR),
  };
}

const bump = (m: Map<AssetId, number>, id: AssetId, d: number) => {
  const n = (m.get(id) ?? 0) + d;
  if (n > 0) m.set(id, n); else m.delete(id);
};

/**
 * Copies owned just BEFORE `target`: start from the current inventory and undo every completed trade
 * from the newest back to and including `target` (remove what was received, add back what was given).
 * Approximate: purchases/sales outside trades are not known. Counts never go below 0.
 */
export function ownedBefore(current: Map<AssetId, number>, completed: TradeSnapshot[], target: TradeSnapshot, dateOf: (t: TradeSnapshot) => number): Map<AssetId, number> {
  const m = new Map(current);
  const tAt = dateOf(target);
  const newer = completed
    .filter((t) => t.tradeId !== target.tradeId && (dateOf(t) > tAt || (dateOf(t) === tAt && t.tradeId > target.tradeId)))
    .sort((a, b) => dateOf(b) - dateOf(a) || b.tradeId - a.tradeId);
  for (const t of [...newer, target]) {
    for (const i of t.get.items) bump(m, i.assetId, -1);
    for (const i of t.give.items) bump(m, i.assetId, 1);
  }
  return m;
}

/** Fallback when there is no inventory to walk back from: current copies minus the ones this trade brought in. */
export function ownedExcludingTrade(current: Map<AssetId, number>, t: TradeSnapshot): Map<AssetId, number> {
  const m = new Map(current);
  for (const i of t.get.items) bump(m, i.assetId, -1);
  return m;
}

export function summarize(rows: Pick<MyTradeRow, 'tradeId' | 'pnl' | 'thenBasis'>[]): MyTradesSummary {
  const n = rows.length;
  let best: MyTradesSummary['best'] = null, worst: MyTradesSummary['worst'] = null;
  for (const r of rows) {
    if (!best || r.pnl.gainNow > best.gainNow) best = { tradeId: r.tradeId, gainNow: r.pnl.gainNow };
    if (!worst || r.pnl.gainNow < worst.gainNow) worst = { tradeId: r.tradeId, gainNow: r.pnl.gainNow };
  }
  return {
    trades: n,
    gainThenTotal: rows.reduce((s, r) => s + r.pnl.gainThen, 0),
    gainNowTotal: rows.reduce((s, r) => s + r.pnl.gainNow, 0),
    winRateThen: n ? rows.filter((r) => r.pnl.gainThen > 0).length / n : null,
    winRateNow: n ? rows.filter((r) => r.pnl.gainNow > 0).length / n : null,
    best, worst,
    estimatedTrades: rows.filter((r) => r.thenBasis === 'current_estimate').length,
  };
}
