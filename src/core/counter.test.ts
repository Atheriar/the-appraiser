/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';
import { searchCounterPackages } from './counter.js';
import { DEFAULT_SETTINGS, type CounterPackage, type TradeItem, type TradeSnapshot, type ValuedItem } from './types.js';

const NOW = Date.UTC(2026, 9, 20);
let nextId = 5000;
function vi(name: string, tradeValue: number, o: Partial<ValuedItem> = {}): ValuedItem {
  return {
    assetId: nextId++, name, tradeValue, liquidationValue: tradeValue * 0.7, liquidity: 0.6, confidence: 1,
    rap: tradeValue, roliValue: tradeValue, basis: 'roli_value', expectedDriftPct: 0, serialMultiplier: 1,
    rarity: 'common', demand: 2, trend: 2, flags: [], evidence: [], snapshotAt: NOW, ...o,
  };
}
const tItem = (v: ValuedItem): TradeItem => ({
  assetId: v.assetId, itemType: 'Asset', targetId: String(v.assetId), name: v.name, userAssetId: 1,
  collectibleItemInstanceId: null, collectibleItemId: null, serialNumber: null, rap: v.rap, originalPrice: null,
  assetStock: null, isOnHold: null, joinKey: 'v1_only',
});
function input(give: ValuedItem[], get: ValuedItem[], partnerTradable: ValuedItem[], maxItemsPerSide = 4): ScoreInput {
  const trade: TradeSnapshot = {
    tradeId: 1, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: NOW, expiresAt: null,
    partner: { userId: 2, name: 'p', displayName: 'p' },
    give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(tItem), robux: 0 },
    get: { userId: 2, userName: 'p', displayName: 'p', items: get.map(tItem), robux: 0 },
    fetchedAt: NOW, hadV1: true, hadV2: true, offerSignature: 'x',
  };
  return {
    trade, give, get, partner: null, partnerTradable,
    portfolio: { owned: new Map(), ownedValue: 1_000_000, upgradeTarget: null },
    metadata: { ...DEFAULT_SETTINGS.tradeMetadataFallback, maxItemsPerSide, verified: false, fetchedAt: NOW },
    settings: structuredClone(DEFAULT_SETTINGS), now: NOW,
  };
}
// EVEN 1-for-1: 100k for 80k -> needs ~20k.
const evenTrade = () => ({ give: [vi('Mine', 100_000)], get: [vi('Theirs', 80_000)] });

describe('counter package search', () => {
  it('finds a 2-item add when no single item suffices and every result reaches edge >= 0', () => {
    const { give, get } = evenTrade();
    const pkgs = searchCounterPackages(input(give, get, [vi('Half A', 18_000), vi('Half B', 18_000), vi('Tiny', 1_000)]));
    expect(pkgs.length).toBeGreaterThan(0);
    const pair = pkgs.find((p) => p.add.length === 2 && p.robux === 0);
    expect(pair?.add.map((a) => a.name).sort()).toEqual(['Half A', 'Half B']);
    for (const p of pkgs) expect(p.resultingEdgePct).toBeGreaterThanOrEqual(0);
  });

  it('never suggests projected or on-hold partner items', () => {
    const { give, get } = evenTrade();
    const pkgs = searchCounterPackages(input(give, get, [
      vi('Proj', 21_000, { flags: ['projected'] }), vi('Held', 21_000, { isOnHold: true }), vi('Ok', 25_000),
    ]));
    const names = pkgs.flatMap((p) => p.add.map((a) => a.name));
    expect(names).not.toContain('Proj');
    expect(names).not.toContain('Held');
    expect(names).toContain('Ok');
  });

  it('prefers the liquid / high-demand item when values are similar', () => {
    const { give, get } = evenTrade();
    const pkgs = searchCounterPackages(input(give, get, [
      vi('Dead', 22_000, { liquidity: 0.05, demand: 0 }), vi('Hot', 22_500, { liquidity: 0.95, demand: 4 }),
    ]));
    expect(pkgs[0]!.add[0]!.name).toBe('Hot');
  });

  it('respects maxItemsPerSide (no adds when their side is full; swaps still allowed)', () => {
    const give = [vi('Mine', 100_000)];
    const get = [vi('A', 40_000), vi('B', 40_000)];
    const pkgs = searchCounterPackages(input(give, get, [vi('X', 12_000), vi('Y', 12_000), vi('Big', 70_000)], 2));
    for (const p of pkgs) expect(get.length - p.swapOut.length + p.add.length).toBeLessThanOrEqual(2);
    expect(pkgs.some((p) => p.swapOut.length === 1 && p.add[0]!.name === 'Big')).toBe(true);
  });

  it('tops up with Robux only within the max-Robux rule', () => {
    const { give, get } = evenTrade();
    const pkgs = searchCounterPackages(input(give, get, [vi('Small', 15_000)]));
    const top = pkgs.find((p) => p.add[0]?.name === 'Small');
    expect(top).toBeDefined();
    expect(top!.robux).toBeGreaterThan(0);
    expect(top!.withinMaxRobuxRule).toBe(true);
    expect(top!.resultingEdgePct).toBeGreaterThanOrEqual(0);
  });

  it('returns nothing without partner inventory, and scoreTrade surfaces packages in options + text', () => {
    const { give, get } = evenTrade();
    expect(searchCounterPackages(input(give, get, []))).toEqual([]);
    const s = engine.scoreTrade(input(give, get, [vi('Half A', 11_000), vi('Half B', 11_000)]));
    const pkg = s.counterSuggestion!.options.find((o): o is CounterPackage => o.kind === 'package');
    expect(pkg).toBeDefined();
    expect(s.counterSuggestion!.text).toMatch(/Half A/);
    expect(s.counterSuggestion!.partnerItemsConsidered).toBe(2);
  });
});
