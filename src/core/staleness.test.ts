/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Staleness hardening (core-1.5.0): market-dependent constants live in settings, schemas tolerate
 * drift row by row, failed fetches keep the last good data, and caches expire.
 */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';
import { DEFAULT_LIQUIDITY, DEFAULT_SETTINGS, type ItemSnapshot, type Settings, type TradeItem, type TradeMetadata, type TradeOutcome, type TradeSnapshot, type ValuedItem } from './types.js';
import { computeLiquidity, demandLiquidity, priceTierFactor, valueItem } from './valuation.js';
import { catalogDue, computeMarketIndex, marketScale, mergeTradeMetadata, scaleModelSettings } from './marketData.js';
import { suggestNorms } from './learning.js';
import { MAX_BAD_ROW_SHARE, parseItemDetails } from '../adapters/rolimons/client.js';
import { ResaleSchema, TradableItemsSchema, CatalogBatchSchema } from '../adapters/roblox/schemas.js';
import { estimateFromResale } from '../adapters/valueSources.js';
import { validateSettings } from '../server/app.js';
import { emptySnapshot } from '../jobs/snapshots.js';

const NOW = Date.UTC(2026, 9, 22);
const DAY = 86_400_000;
const S = (): Settings => structuredClone(DEFAULT_SETTINGS);
const snap = (o: Partial<ItemSnapshot>): ItemSnapshot => ({ ...emptySnapshot(1, 'X', NOW), isLimitedU: true, ...o });

describe('liquidity constants come from settings', () => {
  it('defaults reproduce the old constants', () => {
    expect(priceTierFactor(100_000)).toBeCloseTo(0.9);
    expect(priceTierFactor(1e9)).toBe(0.7);
    expect(demandLiquidity(3)).toEqual({ value: 0.8, known: true });
  });

  it('a moved price-tier anchor moves the haircut without code changes', () => {
    const cfg = { ...DEFAULT_LIQUIDITY, priceTierAnchor: 100_000 };
    expect(priceTierFactor(100_000, cfg)).toBe(1);
    expect(priceTierFactor(1_000_000, cfg)).toBeCloseTo(0.9);
  });

  it('an unknown demand index uses the fallback and says so in evidence', () => {
    expect(demandLiquidity(7)).toEqual({ value: 0.3, known: false });
    const s = S();
    const v = valueItem(snap({ roliValue: 20_000, rap: 20_000, roliDemand: 7 as never }), s, NOW);
    expect(v.evidence.some((e) => e.code === 'unknown_demand_index')).toBe(true);
    // Adding the index to the map makes it known: no warning, its own liquidity.
    s.valuation.liquidity.demandLiquidity['7'] = 0.99;
    const v2 = valueItem(snap({ roliValue: 20_000, rap: 20_000, roliDemand: 7 as never }), s, NOW);
    expect(v2.evidence.some((e) => e.code === 'unknown_demand_index')).toBe(false);
    expect(v2.liquidity).toBeGreaterThan(v.liquidity);
  });

  it('low-liquidity cut is a setting', () => {
    const s = S();
    const item = snap({ roliValue: 20_000, rap: 20_000, roliDemand: 1 });
    const base = valueItem(item, s, NOW);
    expect(base.flags.includes('low_liquidity')).toBe(true);
    s.valuation.liquidity.lowLiquidityCut = 0.1;
    expect(valueItem(item, s, NOW).flags.includes('low_liquidity')).toBe(false);
    expect(computeLiquidity(item, NOW, null, 20_000, s.valuation.liquidity).liquidity).toBeCloseTo(base.liquidity);
  });
});

describe('scoring shape constants come from settings', () => {
  const vi = (name: string, tradeValue: number, o: Partial<ValuedItem> = {}): ValuedItem => ({
    assetId: name.length * 1000 + tradeValue, name, tradeValue, liquidationValue: tradeValue * 0.7, liquidity: 0.8, confidence: 1,
    rap: tradeValue, roliValue: tradeValue, basis: 'roli_value', expectedDriftPct: 0, serialMultiplier: 1,
    rarity: 'common', demand: 2, trend: 2, flags: [], evidence: [], snapshotAt: NOW, ...o,
  });
  const tItem = (v: ValuedItem): TradeItem => ({
    assetId: v.assetId, itemType: 'Asset', targetId: String(v.assetId), name: v.name, userAssetId: 1, collectibleItemInstanceId: null,
    collectibleItemId: null, serialNumber: null, rap: v.rap, originalPrice: null, assetStock: null, isOnHold: null, joinKey: 'v1_only',
  });
  const input = (give: ValuedItem[], get: ValuedItem[], settings: Settings): ScoreInput => {
    const trade: TradeSnapshot = {
      tradeId: 1, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: NOW, expiresAt: null,
      partner: { userId: 2, name: 'p', displayName: 'p' },
      give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(tItem), robux: 0 },
      get: { userId: 2, userName: 'p', displayName: 'p', items: get.map(tItem), robux: 0 },
      fetchedAt: NOW, hadV1: true, hadV2: true, offerSignature: 'x',
    };
    return {
      trade, give, get, partner: null, partnerTradable: [], portfolio: { owned: new Map(), ownedValue: 1_000_000, upgradeTarget: null },
      metadata: { ...DEFAULT_SETTINGS.tradeMetadataFallback, verified: true, fetchedAt: NOW }, settings, now: NOW,
    };
  };

  it('momentum cap is tunable', () => {
    const give = [vi('Mine', 100_000)];
    const get = [vi('Theirs', 105_000, { expectedDriftPct: 0.5 })];
    const mom = (s: Settings) => engine.scoreTrade(input(give, get, s)).terms.find((t) => t.key === 'momentum')!.raw;
    const s = S();
    expect(mom(s)).toBeLessThanOrEqual(10);
    s.scoring.momentumCapPp = 4;
    expect(mom(s)).toBeLessThanOrEqual(4);
  });

  it('settings missing the new keys (older saves) still score with the defaults', () => {
    const s = S();
    const old = { ...s, scoring: { ...s.scoring } } as Settings;
    delete (old.scoring as Partial<Settings['scoring']>).momentumCapPp;
    delete (old.valuation as Partial<Settings['valuation']>).liquidity;
    const give = [vi('Mine', 100_000)];
    const get = [vi('Theirs', 110_000)];
    expect(engine.scoreTrade(input(give, get, old)).score).toBe(engine.scoreTrade(input(give, get, S())).score);
  });
});

describe('trade metadata keeps the last live values', () => {
  const live: TradeMetadata = {
    maxItemsPerSide: 5, minValueRatio: 0.4, tradeSystemMaxRobuxPercent: 0.6, tradeSystemRobuxFee: 0.25,
    verified: true, fetchedAt: NOW - DAY, liveFields: ['maxItemsPerSide', 'minValueRatio', 'tradeSystemMaxRobuxPercent', 'tradeSystemRobuxFee'],
  };
  it('a partial response keeps missing fields from the previous live fetch', () => {
    const partial: TradeMetadata = {
      ...DEFAULT_SETTINGS.tradeMetadataFallback, maxItemsPerSide: 6, minValueRatio: null, verified: false, fetchedAt: NOW, liveFields: ['maxItemsPerSide'],
    };
    const m = mergeTradeMetadata(live, partial);
    expect(m).toMatchObject({ maxItemsPerSide: 6, minValueRatio: 0.4, tradeSystemRobuxFee: 0.25, tradeSystemMaxRobuxPercent: 0.6, verified: true, fetchedAt: NOW });
  });
  it('a full response replaces everything; no previous row passes through', () => {
    const next = { ...live, tradeSystemRobuxFee: 0.2, fetchedAt: NOW };
    expect(mergeTradeMetadata(live, next).tradeSystemRobuxFee).toBe(0.2);
    expect(mergeTradeMetadata(null, next)).toEqual(next);
  });
});

describe('market index scaling (opt-in)', () => {
  const values = (median: number) => Array.from({ length: 401 }, (_, i) => median * (0.5 + i / 400));
  it('median over valued items; too few items -> null', () => {
    expect(computeMarketIndex(values(10_000), NOW)!.median).toBeCloseTo(10_000);
    expect(computeMarketIndex([1, 2, 3, null, 0], NOW)).toBeNull();
  });
  it('off by default; on, it scales absolute-Robux thresholds and nothing else', () => {
    const s = S();
    const idx = computeMarketIndex(values(20_000), NOW);
    expect(marketScale(s, idx, 10_000)).toBe(1);
    s.market.scaleWithMarket = true;
    expect(marketScale(s, idx, 10_000)).toBeCloseTo(2);
    s.market.referenceMedianValue = 40_000;
    expect(marketScale(s, idx, 10_000)).toBeCloseTo(0.5);
    s.market.referenceMedianValue = 1;
    expect(marketScale(s, idx, null)).toBe(4); // clamped to maxScale
    const scaled = scaleModelSettings(S(), 2);
    expect(scaled.overpayNorms.smallMax).toBe(100_000);
    expect(scaled.overpayNorms.midMax).toBe(1_000_000);
    expect(scaled.scoring.poisonMinValue).toBe(100_000);
    expect(scaled.valuation.liquidity.priceTierAnchor).toBe(20_000);
    expect(scaled.overpayNorms.rows).toEqual(DEFAULT_SETTINGS.overpayNorms.rows);
    expect(scaled.weights).toEqual(DEFAULT_SETTINGS.weights);
    const s1 = S();
    expect(scaleModelSettings(s1, 1)).toBe(s1);
  });
});

describe('catalog rows expire', () => {
  const poll = DEFAULT_SETTINGS.poll;
  const row = (age: number, o: Partial<{ collectibleItemId: string | null; totalQuantity: number | null; isLimitedU: boolean | null }> = {}) =>
    ({ catalogFetchedAt: NOW - age, collectibleItemId: 'c1', totalQuantity: 100, isLimitedU: true, ...o });
  it('complete rows refresh after catalogRefreshMs, non-limited sooner, never-fetched always', () => {
    expect(catalogDue(null, NOW, poll)).toBe(true);
    expect(catalogDue(row(DAY), NOW, poll)).toBe(false);
    expect(catalogDue(row(8 * DAY), NOW, poll)).toBe(true);
    expect(catalogDue(row(2 * DAY, { isLimitedU: false }), NOW, poll)).toBe(true);
    expect(catalogDue(row(8 * DAY, { totalQuantity: null }), NOW, poll)).toBe(true);
    expect(catalogDue(row(DAY, { totalQuantity: null }), NOW, poll)).toBe(false);
  });
});

describe('rolimons itemdetails tolerates drift row by row', () => {
  const good = (i: number) => [`Item ${i}`, '', 1000 + i, 2000, 2000, 2, 2, -1, -1, -1];
  it('odd rows are skipped, not fatal', () => {
    const items: Record<string, unknown> = {};
    for (let i = 1; i <= 20; i++) items[String(i)] = good(i);
    items['21'] = ['Weird', '', 500, 600, 600, 2, 2, -1, -1, -1, { extra: true }, [1, 2]]; // extra columns: fine
    items['22'] = 'not a row';
    const p = parseItemDetails(items);
    expect(p.map.size).toBe(21);
    expect(p.bad).toBe(1);
  });
  it('a reordered layout (most rows wrong) is rejected as API drift', () => {
    const items: Record<string, unknown> = {};
    for (let i = 1; i <= 10; i++) items[String(i)] = i <= 7 ? [1000 + i, `Item ${i}`, 'x', 2000, 2000, 9, 9] : good(i);
    expect(7 / 10).toBeGreaterThan(MAX_BAD_ROW_SHARE);
    expect(() => parseItemDetails(items)).toThrow(/API drift/);
  });
  it('an empty item list is rejected instead of wiping every value', () => {
    expect(() => parseItemDetails({})).toThrow(/empty item list/);
  });
});

describe('roblox schemas tolerate single bad entries', () => {
  it('tradable items: a null id drops that entry only; numeric ids become strings', () => {
    const p = TradableItemsSchema.parse({
      items: [
        { collectibleItemId: 'a', itemTarget: { itemType: 'Asset', targetId: 1 }, instances: [{ collectibleItemInstanceId: 'i1' }, { collectibleItemInstanceId: null }] },
        { collectibleItemId: null, itemTarget: { targetId: 2 } },
        { collectibleItemId: 12345, itemTarget: { targetId: null }, instances: [{ collectibleItemInstanceId: 777 }] },
      ],
    });
    expect(p.items!.map((i) => i.collectibleItemId)).toEqual(['a', '12345']);
    expect(p.items![0]!.instances!.length).toBe(1);
    expect(p.items![1]!.instances![0]!.collectibleItemInstanceId).toBe('777');
  });
  it('catalog batch: one malformed entry does not sink the batch', () => {
    const p = CatalogBatchSchema.parse({ data: [{ id: 1, name: 'ok' }, { id: null }, { id: '3', name: 'ok too' }] });
    expect(p.data.map((e) => e.id)).toEqual([1, 3]);
  });
  it('resale: bad points dropped, missing recentAveragePrice tolerated', () => {
    const p = ResaleSchema.parse({
      priceDataPoints: [{ value: 100, date: '2026-10-01T00:00:00Z' }, { value: null, date: '2026-10-02T00:00:00Z' }, { value: 90, date: null }, { value: 80, date: 'garbage' }],
      volumeDataPoints: [{ value: 3, date: Date.UTC(2026, 9, 1) }],
    });
    expect(p.recentAveragePrice).toBe(0);
    expect(p.priceDataPoints!.length).toBe(1);
    expect(p.volumeDataPoints!.length).toBe(1);
  });
});

describe('derived demand is a setting', () => {
  it('sales/day cut-offs move derived demand', () => {
    const r = {
      source: 'marketplace_sales' as const, recentAveragePrice: 100, originalPrice: null, assetStock: 500, numberRemaining: null, sales: null,
      priceDataPoints: [], volumeDataPoints: Array.from({ length: 30 }, (_, i) => ({ t: NOW - i * DAY, value: 1 })), newestPointAt: NOW, stale: false,
    };
    expect(estimateFromResale(1, r, NOW).demand).toBe(2); // 1 / day
    expect(estimateFromResale(1, r, NOW, 100, [100, 50, 20, 0.5]).demand).toBe(1);
  });
});

describe('norm calibration re-buckets by raw dominant value', () => {
  it('outcomes stored under old cut-offs follow the current ones', () => {
    const out = (i: number): TradeOutcome => ({
      tradeId: i, finalStatus: 'Completed', decidedAt: 0, valueGainAt7d: null, valueGainAt30d: null, verdictAtTime: 'Accept', scoreAtTime: 70,
      shape: 'UPGRADE', rawGainPct: -0.12, valueTier: 'mid', dominantValueAtTime: 80_000,
    });
    const norms = { ...DEFAULT_SETTINGS.overpayNorms, smallMax: 100_000, midMax: 1_000_000 };
    const s = suggestNorms(Array.from({ length: 20 }, (_, i) => out(i)), norms, { minSample: 10 });
    expect(s.rows.find((r) => r.tier === 'small')!.nUser).toBe(20);
    expect(s.rows.find((r) => r.tier === 'mid')!.nUser).toBe(0);
  });
});

describe('settings validation covers the new knobs', () => {
  it('defaults are valid; bad values are rejected', () => {
    expect(validateSettings(S())).toEqual([]);
    const s = S();
    s.valuation.derivedDemandPerDay = [1, 2, 3, 4];
    s.valuation.liquidity.priceTierFloor = 0;
    s.botList.url = 'https://example.com/list';
    s.overpayNorms.midMax = 10;
    const errs = validateSettings(s).join('\n');
    expect(errs).toMatch(/derivedDemandPerDay/);
    expect(errs).toMatch(/priceTierFloor/);
    expect(errs).toMatch(/botList.url/);
    expect(errs).toMatch(/smallMax < midMax/);
  });
});
