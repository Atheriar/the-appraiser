/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { computeLiquidity, consolidationPremium, priceTierFactor, valueItem } from './valuation.js';
import { DEFAULT_SETTINGS, type ItemSnapshot, type ValuedItem } from './types.js';
import { emptySnapshot, applyReconstructedSales, marketRefreshOrder } from '../jobs/snapshots.js';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;

function snap(o: Partial<ItemSnapshot>): ItemSnapshot {
  return { ...emptySnapshot(1, 'X', NOW), isLimitedU: true, ...o };
}
const vi = (tradeValue: number, liquidity: number, flags: ValuedItem['flags'] = []): ValuedItem =>
  ({ tradeValue, liquidity, flags } as unknown as ValuedItem);

describe('price-tier liquidity', () => {
  it('factor is 1 for small items and shrinks for big ones', () => {
    expect(priceTierFactor(5_000)).toBe(1);
    expect(priceTierFactor(100_000)).toBeCloseTo(0.9);
    expect(priceTierFactor(1e9)).toBe(0.7);
    expect(priceTierFactor(null)).toBe(1);
  });
  it('same market, bigger value => lower liquidity', () => {
    const s = snap({ roliDemand: 3, sales30d: 30, resellerCount: 5, totalQuantity: 1000 });
    const small = computeLiquidity(s, NOW, null, 5_000).liquidity;
    const big = computeLiquidity(s, NOW, null, 2_000_000).liquidity;
    expect(big).toBeLessThan(small);
  });
  it('real velocity outweighs Rolimons demand', () => {
    const base = { roliDemand: 4 as const, resellerCount: 40, totalQuantity: 5000 };
    const roliOnly = computeLiquidity(snap(base), NOW, null).liquidity;
    const slow = computeLiquidity(snap({ ...base, sales30d: 2 }), NOW, null).liquidity;
    expect(slow).toBeLessThan(roliOnly);
  });
  it('valueItem applies the tier to high-value items', () => {
    const m = { roliDemand: 2 as const, sales30d: 20, resellerCount: 4, totalQuantity: 2000, rap: 0 };
    const a = valueItem(snap({ ...m, roliValue: 5_000 }), DEFAULT_SETTINGS, NOW);
    const b = valueItem(snap({ ...m, roliValue: 5_000_000 }), DEFAULT_SETTINGS, NOW);
    expect(b.liquidity).toBeLessThan(a.liquidity);
  });
});

describe('reconstructed sales feed the snapshot', () => {
  const sales = [1, 2, 3, 10, 20].map((d, i) => ({ assetId: 1, t: NOW - d * DAY, price: 1000 + i, oldRap: 1000, newRap: 1000, source: 'rolimons_saleactivity' as never }));
  it('derives sales7d/30d and a daily series when first-party data is missing', () => {
    const s = applyReconstructedSales(snap({}), sales, NOW);
    expect(s.sales30d).toBe(5);
    expect(s.sales7d).toBe(3);
    expect(s.dailyPrice.length).toBe(5);
    expect(s.lastSales[0]!.t).toBe(NOW - DAY);
  });
  it('keeps first-party velocity when present', () => {
    const s = applyReconstructedSales(snap({ sources: ['marketplace_sales'], sales30d: 99 }), sales, NOW);
    expect(s.sales30d).toBe(99);
    expect(s.lastSales.length).toBe(5);
  });
  it('refresh order puts never-fetched first and caps', () => {
    const at: Record<number, number | null> = { 1: 50, 2: null, 3: 10 };
    expect(marketRefreshOrder([1, 2, 3, 3], (id) => at[id] ?? null, 2)).toEqual([2, 3]);
  });
});

describe('consolidation premium', () => {
  it('rewards many-for-one into an at-least-as-liquid item', () => {
    const c = consolidationPremium([vi(40_000, 0.4), vi(40_000, 0.4), vi(30_000, 0.4)], [vi(100_000, 0.6)]);
    expect(c.multiplier).toBeCloseTo(1.02);
    expect(c.index).toBe(0);
  });
  it('none when the big item is less liquid, projected, or not an upgrade', () => {
    expect(consolidationPremium([vi(50_000, 0.6), vi(50_000, 0.6)], [vi(100_000, 0.3)]).multiplier).toBe(1);
    expect(consolidationPremium([vi(50_000, 0.3), vi(50_000, 0.3)], [vi(100_000, 0.6, ['projected'])]).multiplier).toBe(1);
    expect(consolidationPremium([vi(50_000, 0.3)], [vi(100_000, 0.6)]).multiplier).toBe(1);
  });

  it('compares liquidity before the price-tier factor (equal base liquidity still consolidates)', () => {
    const tierLiq = 0.6 * priceTierFactor(30_000);
    expect(tierLiq).toBeLessThan(0.6);
    const c = consolidationPremium([vi(10_000, 0.6), vi(10_000, 0.6), vi(10_000, 0.6)], [vi(30_000, tierLiq)]);
    expect(c.multiplier).toBeCloseTo(1.02);
  });
});

describe('confidence reflects missing inputs', () => {
  // Rolimons value + agreeing reconstructed sales, but no copy count and no Roblox market data:
  // this used to score confidence 1.0 with rarity 'unknown'.
  const sales = Array.from({ length: 12 }, (_, i) => ({ assetId: 1, t: NOW - (i + 1) * DAY, price: 18_000, oldRap: 17_000, newRap: 17_100, source: 'rolimons_feed' as const }));
  const roliOnly = snap({ roliValue: 18_000, rap: 17_105, roliDemand: 2, roliTrend: 2, sales30d: 12, lastSales: sales, sources: ['rolimons'] });
  it('is below 1 without copies or Roblox market data, and says why', () => {
    const v = valueItem(roliOnly, DEFAULT_SETTINGS, NOW);
    expect(v.rarity).toBe('unknown');
    expect(v.confidence).toBeLessThan(0.7);
    expect(v.evidence.find((e) => e.code === 'missing_inputs')?.message).toMatch(/copy count or Roblox market data/);
  });
  it('recovers when copies and the Roblox floor are known', () => {
    const full = valueItem({ ...roliOnly, totalQuantity: 10_647, floorPrice: 18_200, resellerCount: 12, sources: ['rolimons', 'marketplace_sales'] }, DEFAULT_SETTINGS, NOW);
    expect(full.rarity).not.toBe('unknown');
    expect(full.confidence).toBeGreaterThan(valueItem(roliOnly, DEFAULT_SETTINGS, NOW).confidence);
    expect(full.evidence.some((e) => e.code === 'missing_inputs')).toBe(false);
  });
});
