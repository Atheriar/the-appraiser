/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * My Trades ledger: every completed trade the user was in, valued then and now (read-only; local recompute only).
 */
import type { MyTradeItem, MyTradeRow, MyTradeScoreRef, MyTradeSide, MyTradesResponse } from '../core/api-types.js';
import { ownedBefore, ownedExcludingTrade, pickThenValue, summarize, tradePnl, weakestBasis } from '../core/myTrades.js';
import type { HoldEstimate } from '../core/holds.js';
import type { TradeItem, TradeScore, TradeSnapshot, ValuedItem } from '../core/types.js';
import type { Analyst } from './analyst.js';

export interface MyTradesQuery { status: 'all' | 'won' | 'lost'; page: number; pageSize: number; q?: string | undefined; from?: number | undefined; to?: number | undefined }

/** Completed trades, de-duplicated by tradeId (any direction). */
export function completedTrades(a: Analyst): TradeSnapshot[] {
  const by = new Map<number, TradeSnapshot>();
  for (const t of a.repo.listTrades({ direction: 'completed', limit: 100_000, offset: 0 })) if (t.status === 'Completed' || t.direction === 'completed') by.set(t.tradeId, t);
  return [...by.values()];
}

/** When the app watched the trade go from active to Completed, that time; otherwise its creation time. */
export function tradeDate(a: Analyst, t: TradeSnapshot): { at: number; basis: MyTradeRow['dateBasis'] } {
  const h = a.repo.statusHistory(t.tradeId);
  const firstActive = h.findIndex((x) => x.isActive);
  const done = h.findIndex((x, i) => i > firstActive && !x.isActive && x.status === 'Completed');
  if (firstActive >= 0 && done > firstActive) return { at: h[done]!.at, basis: 'completed_observed' };
  return { at: t.createdAt, basis: 'created' };
}

const ref = (s: TradeScore): MyTradeScoreRef => ({ score: s.score, verdict: s.verdict, modelVersion: s.modelVersion, scoredAt: s.scoredAt });

function sideOf(a: Analyst, items: TradeItem[], robux: number, robuxCounted: number, scored: ValuedItem[] | null, at: number, hold?: (assetId: number, serial: number | null) => HoldEstimate | null): MyTradeSide {
  const s = a.modelSettings();
  const out: MyTradeItem[] = items.map((it, idx) => {
    const now = a.valueFor(it.assetId, it, { serial: it.serialNumber, plain: true });
    const sv = scored?.[idx];
    const snap = sv && sv.assetId === it.assetId ? null : a.repo.itemSnapshotAtOrBefore(it.assetId, at);
    let snapVal: { tradeValue: number; rap: number; at: number } | null = null;
    if (snap) {
      try { snapVal = { tradeValue: a.engine.valueItem(snap, s, at, { serial: it.serialNumber }).tradeValue, rap: snap.rap, at: snap.fetchedAt }; } catch { snapVal = null; }
    }
    const then = pickThenValue({
      scored: sv && sv.assetId === it.assetId ? { tradeValue: sv.tradeValue, rap: sv.rap } : null,
      snapshot: snapVal, current: { tradeValue: now.tradeValue, rap: now.rap }, tradeRap: it.rap, tradeAt: at,
    });
    return {
      assetId: it.assetId, name: now.name || it.name, thumbnailUrl: now.thumbnailUrl ?? null, serial: it.serialNumber,
      valueThen: then.valueThen, rapThen: then.rapThen, valueNow: now.tradeValue, rapNow: now.rap,
      basis: then.basis, confidence: then.confidence, basisNote: then.basisNote, snapshotAt: then.snapshotAt,
      ...(hold ? { hold: hold(it.assetId, it.serialNumber) } : {}),
    };
  });
  const sum = (f: (x: MyTradeItem) => number) => out.reduce((n, x) => n + f(x), 0);
  return { items: out, robux, robuxCounted, valueThen: sum((x) => x.valueThen), valueNow: sum((x) => x.valueNow), rapThen: sum((x) => x.rapThen), rapNow: sum((x) => x.rapNow) };
}

/** All completed trades as ledger rows, newest first. */
export function buildMyTrades(a: Analyst): MyTradeRow[] {
  const trades = completedTrades(a);
  const fee = a.metadata().tradeSystemRobuxFee;
  const dates = new Map(trades.map((t) => [t.tradeId, tradeDate(a, t)]));
  const dateOf = (t: TradeSnapshot) => dates.get(t.tradeId)!.at;
  const hasInventory = a.inventory() != null;
  const current = a.ownedCounts();
  const lookup = a.holdLookup();
  const rows = trades.map((t): MyTradeRow => {
    const d = dates.get(t.tradeId)!;
    // Only on the trade that started the hold (or, when no trade was matched, a trade from the last 30 days).
    const holdOf = (assetId: number, serial: number | null): HoldEstimate | null => {
      const h = lookup(assetId, serial);
      return h && (h.tradeId === t.tradeId || (h.tradeId == null && d.at >= Date.now() - 30 * 86_400_000)) ? h : null;
    };
    const then = a.repo.scoreAtOrBefore(t.tradeId, d.at);
    const give = sideOf(a, t.give.items, t.give.robux, t.give.robux, then?.give ?? null, d.at);
    const get = sideOf(a, t.get.items, t.get.robux, Math.round(t.get.robux * (1 - fee)), then?.get ?? null, d.at, holdOf);
    const pnl = tradePnl(
      { valueThen: give.valueThen, valueNow: give.valueNow, rapThen: give.rapThen, rapNow: give.rapNow, robux: t.give.robux },
      { valueThen: get.valueThen, valueNow: get.valueNow, rapThen: get.rapThen, rapNow: get.rapNow, robux: t.get.robux }, fee);
    // Re-score with the inventory held BEFORE this trade: copies this trade brought in are never "duplicates".
    const owned = hasInventory ? ownedBefore(current, trades, t, dateOf) : ownedExcludingTrade(current, t);
    let scoreNow: MyTradeScoreRef | null = null;
    // Holds Roblox puts on items AFTER a trade completes say nothing about the offer itself: score as offered.
    const asOffered = { ...t, give: { ...t.give, items: t.give.items.map((i) => ({ ...i, isOnHold: false })) }, get: { ...t.get, items: t.get.items.map((i) => ({ ...i, isOnHold: false })) } };
    try { scoreNow = ref(a.computeScore(asOffered, { plain: true, portfolio: a.portfolioFromCounts(owned) })); } catch { scoreNow = null; }
    return {
      tradeId: t.tradeId, date: d.at, dateBasis: d.basis, direction: t.direction,
      partner: { userId: t.partner.userId, name: t.partner.name, displayName: t.partner.displayName, profileUrl: `https://www.roblox.com/users/${t.partner.userId}/profile` },
      give, get, pnl, thenBasis: weakestBasis([...give.items, ...get.items].map((i) => i.basis)),
      scoreThen: then ? ref(then) : null, scoreNow,
      portfolioBasis: hasInventory ? 'reconstructed' : 'current_minus_trade',
      portfolioNote: hasInventory
        ? 'Duplicates judged against your inventory rebuilt to just before this trade (later trades undone; purchases/sales outside trades not known).'
        : 'Inventory not loaded: duplicates judged against no prior copies, so the duplicate discount may be under-applied. Copies from this trade are never counted.',
    };
  });
  return rows.sort((x, y) => y.date - x.date || y.tradeId - x.tradeId);
}

export function queryMyTrades(a: Analyst, q: MyTradesQuery): MyTradesResponse {
  const all = buildMyTrades(a);
  const needle = (q.q ?? '').trim().toLowerCase();
  let rows = all;
  if (needle) {
    rows = rows.filter((r) => String(r.tradeId) === needle || r.partner.name.toLowerCase().includes(needle) || r.partner.displayName.toLowerCase().includes(needle)
      || [...r.give.items, ...r.get.items].some((i) => i.name.toLowerCase().includes(needle) || String(i.assetId) === needle));
  }
  if (q.from != null) rows = rows.filter((r) => r.date >= q.from!);
  if (q.to != null) rows = rows.filter((r) => r.date <= q.to!);
  if (q.status === 'won') rows = rows.filter((r) => r.pnl.gainNow > 0);
  if (q.status === 'lost') rows = rows.filter((r) => r.pnl.gainNow < 0);
  const pages = Math.max(1, Math.ceil(rows.length / q.pageSize));
  const page = Math.min(q.page, pages);
  return {
    rows: rows.slice((page - 1) * q.pageSize, page * q.pageSize), total: rows.length, page, pages, pageSize: q.pageSize,
    summary: summarize(rows), lifetimeTrades: all.length, robuxFee: a.metadata().tradeSystemRobuxFee,
  };
}
