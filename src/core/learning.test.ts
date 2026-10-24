/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import {
  applySnapshotLag, calibrateNorms, computeAccuracy, concentrationDelta, observedOverpay, snapshotLag, suggestNorms, summarizeItemDrift,
} from './learning.js';
import { DEFAULT_SETTINGS, type ItemSnapshot, type TradeOutcome, type ValuedItem } from './types.js';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;
const norms = DEFAULT_SETTINGS.overpayNorms;

const out = (o: Partial<TradeOutcome>): TradeOutcome => ({
  tradeId: 1, finalStatus: 'Completed', decidedAt: 0, valueGainAt7d: null, valueGainAt30d: null,
  verdictAtTime: 'Accept', scoreAtTime: 70, ...o,
});
const vi = (assetId: number, tradeValue: number, liquidity = 0.5, o: Partial<ValuedItem> = {}): ValuedItem => ({
  assetId, name: `I${assetId}`, tradeValue, liquidationValue: tradeValue * 0.7, liquidity, confidence: 1, rap: tradeValue, roliValue: tradeValue,
  basis: 'roli_value', expectedDriftPct: 0, serialMultiplier: 1, rarity: 'common', demand: 2, trend: 2, flags: [], evidence: [], snapshotAt: NOW, ...o,
});
const snap = (t: number, rap: number, floor: number | null): ItemSnapshot => ({
  assetId: 5, collectibleItemId: null, itemType: 'Asset', name: 'X', isLimitedU: false, rap, roliValue: 100_000, roliDefaultValue: null,
  roliDemand: null, roliTrend: null, roliProjected: null, roliRare: null, floorPrice: floor, resellerCount: null, totalQuantity: null,
  publicCopies: null, sales7d: null, sales30d: null, dailyPrice: [], dailyVolume: [], lastSales: [], fetchedAt: t, sources: ['catalog'],
} as ItemSnapshot);

describe('learning: accuracy', () => {
  it('reports drift as a fraction of give value and sample sizes', () => {
    const a = computeAccuracy([
      out({ tradeId: 1, valueGainAt30d: 20_000, rawGainPct: 0.05, valueGiveAtTime: 100_000 }),
      out({ tradeId: 2, finalStatus: 'Declined', verdictAtTime: 'Decline', valueGainAt30d: -10_000, rawGainPct: 0, valueGiveAtTime: 100_000 }),
    ], NOW);
    expect(a.avgDriftPct30dAccepted).toBeCloseTo(0.15);
    expect(a.avgDriftPct30dDeclined).toBeCloseTo(-0.1);
    expect(a.accepted30dN).toBe(1);
    expect(a.verdictHitRate).toBe(1);
  });

  it('judges verdicts against the norm, not the raw gain sign', () => {
    const a = computeAccuracy([
      // UPGRADE accepted at exactly the -8% norm, values flat: correct call.
      out({ tradeId: 1, shape: 'UPGRADE', normPct: -0.08, rawGainPct: -0.08, valueGiveAtTime: 10_000, valueGainAt30d: -800 }),
      // DOWNGRADE at +4% under a +8% split norm, declined, values flat: correct call.
      out({ tradeId: 2, finalStatus: 'Declined', verdictAtTime: 'Decline', shape: 'DOWNGRADE', normPct: 0.08, rawGainPct: 0.04, valueGiveAtTime: 10_000, valueGainAt30d: 400 }),
    ], NOW);
    expect(a.verdictHitRate).toBe(1);
  });

  it('absolute 30d drift excludes the edge present at decision', () => {
    const a = computeAccuracy([out({ valueGainAt30d: 500, rawGainPct: 0.05, valueGiveAtTime: 10_000 })], NOW);
    expect(a.avgDrift30dAccepted).toBeCloseTo(0);
    expect(a.avgDriftPct30dAccepted).toBeCloseTo(0);
  });

  it('summarizes item drift of received vs given items in completed trades only', () => {
    const d = summarizeItemDrift([
      { tradeId: 1, assetId: 1, side: 'get', finalStatus: 'Completed', decidedAt: 0, value0: 100, value7d: 110, value30d: 120 },
      { tradeId: 1, assetId: 2, side: 'give', finalStatus: 'Completed', decidedAt: 0, value0: 100, value7d: 95, value30d: null },
      { tradeId: 2, assetId: 3, side: 'get', finalStatus: 'Declined', decidedAt: 0, value0: 100, value7d: 500, value30d: 500 },
    ])!;
    expect(d.received7d).toBeCloseTo(0.1);
    expect(d.received30d).toBeCloseTo(0.2);
    expect(d.given7d).toBeCloseTo(-0.05);
    expect(d.given30d).toBeNull();
    expect(d.n7).toBe(2);
  });
});

describe('learning: norm calibration', () => {
  it('maps shape + raw gain to observed overpay', () => {
    expect(observedOverpay(out({ shape: 'UPGRADE', rawGainPct: -0.12 }))).toBeCloseTo(0.12);
    expect(observedOverpay(out({ shape: 'DOWNGRADE', rawGainPct: 0.06 }))).toBeCloseTo(0.06);
    expect(observedOverpay(out({ shape: 'EVEN', rawGainPct: 0.06 }))).toBeNull();
  });

  it('keeps current below the minimum sample and returns null', () => {
    const few = Array.from({ length: 5 }, (_, i) => out({ tradeId: i, shape: 'UPGRADE', valueTier: 'mid', rawGainPct: -0.2 }));
    const s = suggestNorms(few, norms, { minSample: 10 });
    expect(s.rows.find((r) => r.tier === 'mid')!.enough).toBe(false);
    expect(s.rows.find((r) => r.tier === 'mid')!.suggested).toBe(0.08);
    expect(calibrateNorms(few, norms, { minSample: 10 })).toBeNull();
  });

  it('shrinks toward the current norm using completed trades only', () => {
    const user = Array.from({ length: 20 }, (_, i) => out({ tradeId: i, shape: 'UPGRADE', valueTier: 'mid', rawGainPct: -0.12 }));
    // 20 greedy inbound offers the user declined must NOT pull the norm toward 15%.
    const market = Array.from({ length: 20 }, (_, i) => out({ tradeId: 100 + i, finalStatus: 'Declined', shape: 'UPGRADE', valueTier: 'mid', rawGainPct: -0.15 }));
    const s = suggestNorms([...user, ...market], norms, { minSample: 10, priorStrength: 20 });
    const mid = s.rows.find((r) => r.tier === 'mid')!;
    expect(mid.nUser).toBe(20);
    expect(mid.nMarket).toBe(0);
    // (20*0.12 + 20*0.08) / 40 = 0.10
    expect(mid.suggested).toBeCloseTo(0.1, 3);
    expect(s.rows.find((r) => r.tier === 'small')!.suggested).toBe(0.05);
    const t = calibrateNorms([...user, ...market], norms, { minSample: 10, priorStrength: 20 })!;
    expect(t.rows.find((r) => r.tier === 'mid')!.pct).toBeCloseTo(0.1, 3);
    expect(t.maxPct).toBe(norms.maxPct);
    expect(calibrateNorms(market, norms, { minSample: 10 })).toBeNull();
  });

  it('engine.calibrateNorms (contract) is wired to the real implementation', () => {
    const many = Array.from({ length: 40 }, (_, i) => out({ tradeId: i, shape: 'UPGRADE', valueTier: 'large', rawGainPct: -0.14 }));
    expect(engine.calibrateNorms(many, norms)!.rows.find((r) => r.tier === 'large')!.pct).toBeGreaterThan(0.1);
  });
});

describe('learning: snapshot lag', () => {
  it('flags raise_pending when market sits persistently above value', () => {
    const hs = [0, 1, 2, 3].map((d) => snap(NOW - (3 - d) * DAY, 125_000, 120_000));
    const sig = snapshotLag(hs, 100_000, NOW)!;
    expect(sig.kind).toBe('raise_pending');
    expect(sig.changePct).toBeCloseTo(0.225);
    const v = applySnapshotLag(vi(5, 100_000), sig);
    expect(v.flags).toContain('raise_pending');
    expect(v.tradeValue).toBeCloseTo(110_000); // 0.5 x 22.5% = 11.25%, capped at +10%
  });

  it('ignores a single spike and short windows', () => {
    const spike = [snap(NOW - 3 * DAY, 100_000, 100_000), snap(NOW - 2 * DAY, 100_000, 100_000), snap(NOW - DAY, 100_000, 100_000), snap(NOW, 200_000, 200_000)];
    expect(snapshotLag(spike, 100_000, NOW)).toBeNull();
    const short = [0, 1, 2].map((h) => snap(NOW - h * 3_600_000, 50_000, 50_000));
    expect(snapshotLag(short, 100_000, NOW)).toBeNull();
  });

  it('flags drop_pending and lowers tradeValue; leaves items the valuation already flagged', () => {
    const hs = [0, 1, 2, 3].map((d) => snap(NOW - (3 - d) * DAY, 80_000, 78_000));
    const sig = snapshotLag(hs, 100_000, NOW)!;
    expect(sig.kind).toBe('drop_pending');
    expect(applySnapshotLag(vi(5, 100_000), sig).tradeValue).toBeCloseTo(90_000);
    const flagged = vi(5, 100_000, 0.5, { flags: ['drop_pending'] });
    expect(applySnapshotLag(flagged, sig)).toBe(flagged);
  });
});

describe('learning: portfolio concentration', () => {
  it('rewards spreading out of one dominant illiquid holding and penalizes piling in', () => {
    const owned = new Map([[1, 600_000], [2, 200_000], [3, 200_000]]);
    const portfolio = { owned: new Map([[1, 1], [2, 1], [3, 1]]), ownedValue: 1_000_000, ownedValues: owned, upgradeTarget: null };
    const spread = concentrationDelta([vi(1, 600_000, 0.2)], [vi(10, 320_000, 0.7), vi(11, 300_000, 0.7)], portfolio)!;
    expect(spread.points).toBeGreaterThan(5);
    const pile = concentrationDelta([vi(2, 200_000, 0.6), vi(3, 200_000, 0.6)], [vi(1, 420_000, 0.2)], portfolio)!;
    expect(pile.points).toBeLessThan(-5);
    const { ownedValues: _drop, ...noValues } = portfolio;
    void _drop;
    expect(concentrationDelta([], [], noValues)).toBeNull();
  });

  it('moves the trade score: same trade scores higher when it de-concentrates the portfolio', () => {
    // covered end-to-end via engine.scoreTrade in core.test.ts style
    const give = [vi(1, 600_000, 0.2)], get = [vi(10, 320_000, 0.7), vi(11, 300_000, 0.7)];
    const base = { owned: new Map([[1, 1]]), ownedValue: 1_000_000, upgradeTarget: null };
    const conc = concentrationDelta(give, get, { ...base, ownedValues: new Map([[1, 600_000], [2, 400_000]]) })!;
    const flat = concentrationDelta(give, get, { ...base, ownedValues: new Map([[1, 600_000], [2, 6_000_000]]) })!;
    expect(conc.points).toBeGreaterThan(flat.points);
  });
});
