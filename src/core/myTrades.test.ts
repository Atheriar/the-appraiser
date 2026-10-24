/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { ownedBefore, ownedExcludingTrade, pickThenValue, summarize, tradePnl, weakestBasis } from './myTrades.js';
import type { TradeItem, TradeSnapshot } from './types.js';

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;

describe('pickThenValue (value-at-trade-time basis)', () => {
  const current = { tradeValue: 900, rap: 950 };
  it('prefers the score stored at trade time', () => {
    const r = pickThenValue({ scored: { tradeValue: 1000, rap: 1100 }, snapshot: { tradeValue: 500, rap: 500, at: T0 - DAY }, current, tradeRap: 1200, tradeAt: T0 });
    expect(r).toMatchObject({ basis: 'score_at_trade', valueThen: 1000, rapThen: 1100, confidence: 'high' });
  });
  it('falls back to the nearest snapshot at or before the trade, confidence by age', () => {
    expect(pickThenValue({ scored: null, snapshot: { tradeValue: 800, rap: 810, at: T0 - 2 * DAY }, current, tradeRap: null, tradeAt: T0 }))
      .toMatchObject({ basis: 'snapshot', valueThen: 800, rapThen: 810, confidence: 'high', snapshotAt: T0 - 2 * DAY });
    expect(pickThenValue({ scored: null, snapshot: { tradeValue: 800, rap: 810, at: T0 - 10 * DAY }, current, tradeRap: null, tradeAt: T0 }).confidence).toBe('medium');
    expect(pickThenValue({ scored: null, snapshot: { tradeValue: 800, rap: 810, at: T0 - 40 * DAY }, current, tradeRap: null, tradeAt: T0 }).confidence).toBe('low');
  });
  it('never uses a snapshot from after the trade; estimates from current at low confidence', () => {
    const r = pickThenValue({ scored: null, snapshot: { tradeValue: 800, rap: 810, at: T0 + DAY }, current, tradeRap: 1200, tradeAt: T0 });
    expect(r).toMatchObject({ basis: 'current_estimate', valueThen: 900, rapThen: 1200, confidence: 'low' });
    expect(r.basisNote).toMatch(/estimated from current/);
    expect(pickThenValue({ scored: null, snapshot: null, current, tradeRap: 0, tradeAt: T0 }).rapThen).toBe(950);
  });
  it('weakest basis drives the row badge', () => {
    expect(weakestBasis(['score_at_trade', 'snapshot'])).toBe('snapshot');
    expect(weakestBasis(['snapshot', 'current_estimate', 'score_at_trade'])).toBe('current_estimate');
    expect(weakestBasis([])).toBe('score_at_trade');
  });
});

describe('tradePnl', () => {
  const side = (valueThen: number, valueNow: number, robux = 0) => ({ valueThen, valueNow, rapThen: valueThen, rapNow: valueNow, robux });
  it('items only: gain then, "if you had kept it" now, change since', () => {
    const p = tradePnl(side(100_000, 80_000), side(110_000, 130_000), 0.3);
    expect(p.gainThen).toBe(10_000);
    expect(p.gainThenPct).toBeCloseTo(0.1);
    expect(p.gainNow).toBe(50_000);
    expect(p.gainNowPct).toBeCloseTo(50_000 / 80_000);
    expect(p.changeSince).toBe(40_000);
  });
  it('received Robux counts after the 30% fee; paid Robux count in full', () => {
    const got = tradePnl(side(50_000, 50_000), side(40_000, 40_000, 10_000), 0.3);
    expect(got.gainThen).toBe(40_000 + 7_000 - 50_000);
    const paid = tradePnl(side(40_000, 40_000, 10_000), side(52_000, 52_000), 0.3);
    expect(paid.gainThen).toBe(52_000 - 50_000);
    expect(paid.gainThenPct).toBeCloseTo(2_000 / 50_000);
    expect(paid.rapGainNow).toBe(2_000);
  });
  it('a pure-Robux give with zero value has a null percentage only when nothing was given', () => {
    expect(tradePnl(side(0, 0), side(10, 10), 0.3).gainThenPct).toBeNull();
  });
});

const item = (assetId: number): TradeItem => ({ assetId, itemType: 'Asset', targetId: String(assetId), name: `i${assetId}`, userAssetId: null, collectibleItemInstanceId: null,
  collectibleItemId: null, serialNumber: null, rap: 1, originalPrice: null, assetStock: null, isOnHold: false, joinKey: 'serial+asset' });
const trade = (tradeId: number, at: number, give: number[], get: number[]): TradeSnapshot => ({
  tradeId, direction: 'completed', status: 'Completed', statusRaw: 'Completed', isActive: false, createdAt: at, expiresAt: null,
  partner: { userId: 9, name: 'p', displayName: 'p' }, give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(item), robux: 0 },
  get: { userId: 9, userName: 'p', displayName: 'p', items: get.map(item), robux: 0 }, fetchedAt: at, hadV1: true, hadV2: true, offerSignature: '',
});

describe('duplicate-discount rule: pre-trade inventory', () => {
  const dateOf = (t: TradeSnapshot) => t.createdAt;
  it('an item owned only because of the trade is not a prior copy', () => {
    // Trade A (old): gave 1, got 2. Now own one copy of 2 -> before A the user had no 2.
    const A = trade(1, T0, [1], [2]);
    const before = ownedBefore(new Map([[2, 1]]), [A], A, dateOf);
    expect(before.get(2)).toBeUndefined();
    expect(before.get(1)).toBe(1);
  });
  it('undoes every newer trade too, and keeps genuine prior copies', () => {
    const A = trade(1, T0, [1], [2]);
    const B = trade(2, T0 + DAY, [3], [2]); // a second copy of 2, later
    const C = trade(3, T0 + 2 * DAY, [2], [4]); // traded one copy of 2 away
    const cur = new Map([[2, 1], [4, 1]]);
    // Before B: after A only -> 1 copy of 2 (a real prior copy, so B's copy is a duplicate).
    expect(ownedBefore(cur, [A, B, C], B, dateOf).get(2)).toBe(1);
    // Before A: no copy of 2 at all.
    expect(ownedBefore(cur, [A, B, C], A, dateOf).get(2)).toBeUndefined();
  });
  it('fallback without inventory removes the copies this trade brought in and never goes negative', () => {
    const A = trade(1, T0, [1], [2, 2]);
    expect(ownedExcludingTrade(new Map([[2, 3]]), A).get(2)).toBe(1);
    expect(ownedExcludingTrade(new Map(), A).size).toBe(0);
  });
});

describe('summarize', () => {
  it('totals, win rates, best and worst', () => {
    const r = (tradeId: number, gainThen: number, gainNow: number, est = false) => ({ tradeId, thenBasis: est ? 'current_estimate' as const : 'snapshot' as const,
      pnl: { gainThen, gainNow, gainThenPct: null, gainNowPct: null, changeSince: gainNow - gainThen, rapGainThen: 0, rapGainNow: 0 } });
    const s = summarize([r(1, 100, -50), r(2, -20, 300, true), r(3, 10, 10)]);
    expect(s).toMatchObject({ trades: 3, gainThenTotal: 90, gainNowTotal: 260, best: { tradeId: 2, gainNow: 300 }, worst: { tradeId: 1, gainNow: -50 }, estimatedTrades: 1 });
    expect(s.winRateThen).toBeCloseTo(2 / 3);
    expect(s.winRateNow).toBeCloseTo(2 / 3);
    expect(summarize([]).winRateNow).toBeNull();
  });
});
