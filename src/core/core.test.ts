/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';
import {
  DEFAULT_SETTINGS, type ItemSnapshot, type PartnerInfo, type Settings, type TradeItem, type TradeSnapshot, type ValuedItem,
} from './types.js';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;
const S = (patch: Partial<Settings> = {}): Settings => structuredClone({ ...DEFAULT_SETTINGS, ...patch });

let nextId = 1000;
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
  assetStock: null, isOnHold: v.isOnHold ?? null, joinKey: 'v1_only',
});
function input(give: ValuedItem[], get: ValuedItem[], o: { robuxGive?: number; robuxGet?: number; settings?: Settings; partner?: PartnerInfo | null; partnerTradable?: ValuedItem[] } = {}): ScoreInput {
  const trade: TradeSnapshot = {
    tradeId: 1, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: NOW, expiresAt: null,
    partner: { userId: 2, name: 'p', displayName: 'p' },
    give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(tItem), robux: o.robuxGive ?? 0 },
    get: { userId: 2, userName: 'p', displayName: 'p', items: get.map(tItem), robux: o.robuxGet ?? 0 },
    fetchedAt: NOW, hadV1: true, hadV2: true, offerSignature: 'x',
  };
  return {
    trade, give, get, partner: o.partner ?? null, partnerTradable: o.partnerTradable ?? [],
    portfolio: { owned: new Map(), ownedValue: 1_000_000, upgradeTarget: null },
    metadata: { ...DEFAULT_SETTINGS.tradeMetadataFallback, verified: false, fetchedAt: NOW },
    settings: o.settings ?? S(), now: NOW,
  };
}
function snap(o: Partial<ItemSnapshot>): ItemSnapshot {
  return {
    assetId: nextId++, collectibleItemId: null, itemType: 'Asset', name: 'Item', isLimitedU: false,
    rap: 0, roliValue: null, roliDefaultValue: null, roliDemand: null, roliTrend: null, roliProjected: null, roliRare: null,
    floorPrice: null, resellerCount: null, totalQuantity: null, publicCopies: null,
    sales7d: null, sales30d: null, dailyPrice: [], dailyVolume: [], lastSales: [],
    fetchedAt: NOW, sources: ['rolimons'], ...o,
  };
}
const basePartner = (o: Partial<PartnerInfo> = {}): Omit<PartnerInfo, 'flags' | 'evidence'> => ({
  userId: 2, name: 'p', displayName: 'p', createdAt: null, accountAgeDays: 900, hasVerifiedBadge: false, isBanned: false,
  inventoryVisible: true, inventoryValue: 5_000_000, inventoryRap: 5_000_000, inventoryItemCount: 40, inBotList: false,
  terminated: false, repeatOfferCount: 1, repeatOfferAccounts: 1, priorTrades: { completed: 0, declined: 0, countered: 0 },
  fetchedAt: NOW, ...o,
});

describe('spec section 7 worked examples', () => {
  it('1. split norm: +6% raw, DOWNGRADE norm 8% -> edge -2% -> Counter (add >=10k); norm 5% -> Lean accept', () => {
    const inp = input([vi('Big', 500_000)], [vi('A', 200_000), vi('B', 180_000), vi('C', 150_000)]);
    const s = engine.scoreTrade(inp);
    expect(s.shape).toBe('DOWNGRADE');
    expect(s.rawGainPct).toBeCloseTo(0.06, 6);
    expect(s.normPct).toBeCloseTo(0.08, 6);
    expect(s.edgePct).toBeCloseTo(-0.02, 6);
    expect(s.score).toBeCloseTo(45.0, 0);
    expect(s.verdict).toBe('Counter');
    expect(s.counterSuggestion).not.toBeNull();
    expect(s.counterSuggestion!.valueNeeded).toBeGreaterThanOrEqual(10_000);
    expect(s.counterSuggestion!.valueNeeded).toBeLessThan(10_100);
    expect(s.explanation).toMatch(/\+6\.0% raw/);

    const st = S();
    st.overpayNorms.rows = st.overpayNorms.rows.map((r) => (r.tier === 'mid' ? { ...r, pct: 0.05 } : r));
    const s2 = engine.scoreTrade({ ...inp, settings: st });
    expect(s2.edgePct).toBeCloseTo(0.01, 6);
    expect(s2.score).toBeCloseTo(52.5, 0);
    expect(s2.verdict).toBe('Lean accept');
  });

  it('2. projected trap: RAP 170k, value 60k, floor 65k, 600k sale 10d ago -> rules 2+3, tradeValue ~60k', () => {
    const st = S();
    const s = snap({
      name: 'Red RAWR', rap: 170_000, roliValue: 60_000, roliDemand: 2, roliTrend: 2, floorPrice: 65_000, resellerCount: 5,
      lastSales: [{ assetId: 1, t: NOW - 10 * DAY, price: 600_000, oldRap: 110_000, newRap: 159_000, source: 'rolimons_feed' }],
    });
    const proj = engine.detectProjection(s, st, NOW);
    expect(proj.suspectProjected).toBe(true);
    expect(proj.rulesFired).toEqual(expect.arrayContaining([2, 3]));
    const red = engine.valueItem(s, st, NOW);
    expect(red.tradeValue).toBeGreaterThan(55_000);
    expect(red.tradeValue).toBeLessThanOrEqual(66_000);
    expect(red.flags).toContain('projected');
    expect(red.evidence.some((e) => e.code === 'rule2_single_spike' && /600k/.test(e.message))).toBe(true);

    const mine = vi('Mine', 100_000);
    const score = engine.scoreTrade(input([mine], [red], { settings: st }));
    expect(score.totals.rapGain).toBeGreaterThan(0);
    expect(score.totals.rawGain).toBeLessThan(0);
    expect(score.flags).toContain('projected');
    expect(score.verdict).not.toBe('Accept');
    expect(score.explanation).toMatch(/projected/);
  });

  it('3. Robux math: receive 10k -> 7k, give 10k -> 10k', () => {
    const a = engine.computeTotals(input([], [], { robuxGet: 10_000 }));
    expect(a.robuxGetCounted).toBe(7_000);
    expect(a.valueGet).toBe(7_000);
    const b = engine.computeTotals(input([], [], { robuxGive: 10_000 }));
    expect(b.robuxGiveCounted).toBe(10_000);
    expect(b.valueGive).toBe(10_000);
  });

  it('4. value trap: 300k terrible-demand for 280k amazing-demand -> raw +7%, liquid negative, <= Counter', () => {
    const st = S();
    const mk = (name: string, value: number, demand: 0 | 4, sales: number) => engine.valueItem(snap({
      name, rap: value, roliValue: value, roliDemand: demand, roliTrend: 2, floorPrice: value, resellerCount: demand === 4 ? 4 : 12,
      sales30d: sales, publicCopies: 2000,
    }), st, NOW);
    const give = [mk('Amazing A', 140_000, 4, 60), mk('Amazing B', 140_000, 4, 60)];
    const get = [mk('Dud A', 100_000, 0, 0), mk('Dud B', 100_000, 0, 0), mk('Dud C', 100_000, 0, 0)];
    const s = engine.scoreTrade(input(give, get, { settings: st }));
    expect(s.rawGainPct).toBeCloseTo(20 / 280, 3);
    expect(s.totals.liquidGain).toBeLessThan(0);
    expect(['Counter', 'Decline']).toContain(s.verdict);
    expect(s.explanation).toMatch(/low-liquidity/);
  });

  it('5. hold: incoming item on hold carries a badge and the explanation says so', () => {
    const st = S();
    const held = engine.valueItem(snap({ name: 'Held Hat', rap: 50_000, roliValue: 50_000, floorPrice: 50_000, resellerCount: 5, sales30d: 20, isOnHold: true }), st, NOW);
    expect(held.flags).toContain('on_hold');
    const s = engine.scoreTrade(input([vi('Mine', 45_000)], [held], { settings: st }));
    expect(s.flags).toContain('on_hold');
    expect(s.explanation).toMatch(/Held Hat is on hold and cannot be re-traded until the hold ends/);
  });

  it('6. bot pattern: same offer from 4 accounts in 24h -> repeat-offer x4, penalised, not auto-declined', () => {
    const st = S();
    const bot = engine.assessPartner(basePartner({ repeatOfferAccounts: 4, repeatOfferCount: 4 }), st, 1);
    expect(bot.flags).toContain('repeat_offer');
    expect(bot.evidence.find((e) => e.code === 'repeat_offer')!.message).toMatch(/repeat-offer x4/);
    const clean = engine.assessPartner(basePartner(), st, 1);
    const give = [vi('Mine', 100_000)];
    const get = [vi('Theirs', 115_000)];
    const sBot = engine.scoreTrade(input(give, get, { partner: bot }));
    const sClean = engine.scoreTrade(input(give, get, { partner: clean }));
    expect(sBot.flags).toContain('repeat_offer');
    expect(sBot.score).toBeLessThan(sClean.score);
    expect(sBot.terms.find((t) => t.key === 'risk')!.raw).toBeCloseTo(3, 6);
    expect(sBot.verdict).not.toBe('Decline'); // flag, never an auto-decline
    expect(sBot.explanation).toMatch(/repeat-offer x4/);
  });
});

describe('RAP reconstruction', () => {
  it('inverts the RAP update formula', () => {
    expect(engine.reconstructSalePrice(1000, 1100)).toBe(2000);
    expect(engine.reconstructSalePrice(0, 500)).toBe(500);
    expect(engine.reconstructSalePrice(1000, 950)).toBe(500);
  });
  it('builds sales from snapshots, newest first', () => {
    const sales = engine.salesFromRapSnapshots(5, [{ t: 1, rap: 1000 }, { t: 2, rap: 1000 }, { t: 3, rap: 1100 }, { t: 4, rap: 1090 }]);
    expect(sales.map((s) => s.price)).toEqual([1000, 2000]);
    expect(sales[0]!.source).toBe('rap_snapshot_delta');
  });
});

describe('valuation', () => {
  const st = S();
  it('unvalued: RAP above floor by >15% uses min(rap, max(floor, median))', () => {
    const v = engine.valueItem(snap({ rap: 10_000, floorPrice: 7_000, resellerCount: 10, sales30d: 20,
      dailyPrice: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (i + 1) * DAY, value: 8_000 })) }), st, NOW);
    expect(v.basis).toBe('market_min');
    expect(v.tradeValue).toBe(8_000);
    expect(v.flags).toContain('unvalued');
  });
  it('raise pending lifts part-way, capped at +10%', () => {
    const v = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, roliDemand: 3, floorPrice: 140_000, resellerCount: 4, sales30d: 30,
      dailyPrice: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (i + 1) * DAY, value: 140_000 })) }), st, NOW);
    expect(v.flags).toContain('raise_pending');
    expect(v.tradeValue).toBe(110_000);
    // The lift is already in tradeValue; it is not counted again as drift (overvaluation audit).
    expect(v.expectedDriftPct).toBe(0);
  });
  it('drop pending mirrors it', () => {
    const v = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, floorPrice: 70_000, resellerCount: 8, sales30d: 30,
      dailyPrice: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (i + 1) * DAY, value: 75_000 })) }), st, NOW);
    expect(v.flags).toContain('drop_pending');
    // Downside goes all the way to the market (72.5k) since audit 2, capped at 25% -> 75k.
    expect(v.tradeValue).toBe(75_000);
  });
  it('serial premium only for Limited U and valued items by default', () => {
    const base = { rap: 10_000, roliValue: 10_000, isLimitedU: true, floorPrice: 10_000, resellerCount: 5, sales30d: 10 };
    expect(engine.valueItem(snap({ ...base, serial: 1 }), st, NOW).tradeValue).toBe(15_000);
    expect(engine.valueItem(snap({ ...base, serial: 69 }), st, NOW).serialMultiplier).toBe(1.05);
    expect(engine.valueItem(snap({ ...base, roliValue: null, serial: 1 }), st, NOW).serialMultiplier).toBe(1);
  });
  it('no sales in 30d caps liquidity, terrible demand is illiquid', () => {
    const v = engine.valueItem(snap({ rap: 5000, roliValue: 5000, roliDemand: 0, sales30d: 0, floorPrice: 5000, resellerCount: 3 }), st, NOW);
    expect(v.liquidity).toBeLessThanOrEqual(0.15);
    expect(v.flags).toContain('low_liquidity');
  });
  it('rarity, hoard, stale and poison flags with evidence', () => {
    const v = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, publicCopies: 80, topOwnerCopies: 5, recentOwnerChurn30d: 0.4,
      fetchedAt: NOW - 5 * 3_600_000 }), st, NOW);
    expect(v.flags).toEqual(expect.arrayContaining(['rare', 'hoard_risk', 'stale_data', 'poison_churn']));
    expect(v.evidence.find((e) => e.code === 'hoard_single_owner')!.message).toMatch(/5 copies/);
    expect(v.confidence).toBeLessThan(1);
  });
  it('rule 1 projection: RAP >= 1.5x median with <= 3 sales', () => {
    const r = engine.detectProjection(snap({ rap: 30_000, lastSales: [
      { assetId: 1, t: NOW - 3 * DAY, price: 18_000, oldRap: 18_000, newRap: 18_000, source: 'rolimons_feed' },
      { assetId: 1, t: NOW - 6 * DAY, price: 19_000, oldRap: 19_000, newRap: 19_000, source: 'rolimons_feed' },
    ] }), st, NOW);
    expect(r.rulesFired).toContain(1);
    expect(r.preSpikeBaseline).toBe(18_500);
  });
});

describe('shape, norms, totals', () => {
  const n = DEFAULT_SETTINGS.overpayNorms;
  it('classifies upgrade/downgrade/even by dominant item', () => {
    const big = vi('big', 100_000);
    expect(engine.classifyShape([vi('a', 40_000), vi('b', 70_000)], [big]).shape).toBe('UPGRADE');
    expect(engine.classifyShape([big], [vi('a', 40_000), vi('b', 70_000)]).shape).toBe('DOWNGRADE');
    expect(engine.classifyShape([big], [vi('c', 90_000)]).shape).toBe('EVEN');
  });
  it('tiers and adjustments', () => {
    expect(engine.valueTier(49_999, n)).toBe('small');
    expect(engine.valueTier(500_000, n)).toBe('mid');
    expect(engine.valueTier(500_001, n)).toBe('large');
    expect(engine.expectedOverpayPct('UPGRADE', vi('x', 1_000_000, { rarity: 'rare', demand: 4 }), n)).toBeCloseTo(0.15);
    expect(engine.expectedOverpayPct('UPGRADE', vi('x', 10_000, { demand: 1 }), n)).toBeCloseTo(0.02);
    expect(engine.expectedOverpayPct('EVEN', vi('x', 10_000), n)).toBe(0);
  });
  it('filler and duplicate adjustments reduce valueGet', () => {
    const owned = vi('Owned', 50_000);
    const inp = input([vi('Mine', 100_000)], [owned, vi('Tiny', 1_000), vi('Other', 49_000)]);
    inp.portfolio.owned.set(owned.assetId, 1);
    const t = engine.computeTotals(inp);
    expect(t.fillerPenalty).toBe(-500);
    expect(t.duplicatePenalty).toBe(-12_500);
    expect(t.valueGet).toBe(100_000 - 500 - 12_500);
  });
});

describe('overrides and goal modes', () => {
  it('hold-list give caps at Decline', () => {
    const mine = vi('Treasure', 100_000);
    const st = S(); st.holdList = [mine.assetId];
    const s = engine.scoreTrade(input([mine], [vi('Theirs', 200_000)], { settings: st }));
    expect(s.verdict).toBe('Decline');
    expect(s.capped).toBe(true);
    expect(s.flags).toContain('hold_list_violation');
  });
  it('smart upgrade into higher demand + momentum scores better in grow_value', () => {
    const give = [vi('Slow A', 60_000, { demand: 1, liquidity: 0.25, expectedDriftPct: -0.03 }), vi('Slow B', 60_000, { demand: 1, liquidity: 0.25, expectedDriftPct: -0.03 })];
    const get = [vi('Hot', 112_000, { demand: 4, liquidity: 0.9, expectedDriftPct: 0.05 })];
    const s = engine.scoreTrade(input(give, get));
    expect(s.shape).toBe('UPGRADE');
    expect(s.rawGainPct).toBeLessThan(0);
    expect(s.score).toBeGreaterThanOrEqual(70);
  });
  it('counter suggestion prefers the cheapest sufficient partner item', () => {
    const extra = [vi('Cheap', 12_000), vi('Pricey', 40_000), vi('Too small', 2_000)];
    const s = engine.scoreTrade(input([vi('Big', 500_000)], [vi('A', 200_000), vi('B', 180_000), vi('C', 150_000)], { partnerTradable: extra }));
    const items = s.counterSuggestion!.options.filter((o) => o.kind === 'add_partner_item');
    expect(items.map((o) => (o.kind === 'add_partner_item' ? o.name : ''))).toEqual(['Cheap', 'Pricey']);
    // 10k after fee costs the partner ~14.3k gross Robux: the 12k item is the cheaper ask (meta-2026 fee drag).
    expect(s.counterSuggestion!.options[0]!.kind).toBe('add_partner_item');
    expect(s.counterSuggestion!.text).toMatch(/roblox\.com\/trades/);
  });
});

describe('learning', () => {
  it('accuracy hit rate and drift', () => {
    const a = engine.computeAccuracy([
      { tradeId: 1, finalStatus: 'Completed', decidedAt: 0, valueGainAt7d: 10, valueGainAt30d: 100, verdictAtTime: 'Accept', scoreAtTime: 80 },
      { tradeId: 2, finalStatus: 'Declined', decidedAt: 0, valueGainAt7d: -5, valueGainAt30d: -50, verdictAtTime: 'Decline', scoreAtTime: 20 },
      { tradeId: 3, finalStatus: 'Declined', decidedAt: 0, valueGainAt7d: 5, valueGainAt30d: 50, verdictAtTime: 'Decline', scoreAtTime: 20 },
    ], NOW);
    expect(a.verdictHitRate).toBeCloseTo(2 / 3);
    expect(a.avgDrift30dAccepted).toBe(100);
    expect(a.avgDrift30dDeclined).toBe(0);
  });
});

describe('review fixes: scoring', () => {
  it('liquidity term cannot rescue a value-losing upgrade (UpgradeGuy)', () => {
    const s = engine.scoreTrade(input(
      [vi('Low A', 60_000, { liquidity: 0.26 }), vi('Low B', 50_000, { liquidity: 0.25 })],
      [vi('Liquid', 100_000, { liquidity: 0.6 })]));
    const liq = s.terms.find((x) => x.key === 'liquid')!;
    expect(Math.abs(liq.raw)).toBeLessThanOrEqual(10);
    expect(s.verdict).not.toBe('Accept');
  });

  it('equal liquidity on both sides adds no liquidity term', () => {
    const s = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 110_000)]));
    expect(s.terms.find((x) => x.key === 'liquid')!.raw).toBeCloseTo(0, 6);
  });

  it('giving an unvalued item is capped at Counter and flagged', () => {
    const s = engine.scoreTrade(input(
      [vi('Mystery', 0, { rap: 0, roliValue: null, confidence: 0.3, flags: ['no_market_data', 'unvalued'] })],
      [vi('Real', 50_000)]));
    expect(s.flags).toContain('unvalued_give');
    expect(s.score).toBeLessThan(50);
    expect(s.confidence).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(s.counterSuggestion?.text).toMatch(/value the item/);
  });

  it('a capped Counter with a positive edge still gets a counter suggestion (example 4)', () => {
    const st = S();
    const mk = (name: string, value: number, demand: 0 | 4, sales: number) => engine.valueItem(snap({
      name, rap: value, roliValue: value, roliDemand: demand, roliTrend: 2, floorPrice: value, resellerCount: demand === 4 ? 4 : 12,
      sales30d: sales, publicCopies: 2000,
    }), st, NOW);
    const s = engine.scoreTrade(input([mk('Amazing A', 140_000, 4, 60), mk('Amazing B', 140_000, 4, 60)],
      [mk('Dud A', 100_000, 0, 0), mk('Dud B', 100_000, 0, 0), mk('Dud C', 100_000, 0, 0)], { settings: st }));
    expect(s.counterSuggestion).not.toBeNull();
    expect(s.counterSuggestion!.text).toMatch(/harder to sell|higher-demand/);
  });

  it('receiving an on-hold item costs materially more than one point', () => {
    const a = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 106_000)]));
    const b = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 106_000, { isOnHold: true, flags: ['on_hold'] })]));
    expect(a.score - b.score).toBeGreaterThan(5);
  });

  it('unknown demand does not create a demand-shift term', () => {
    const s = engine.scoreTrade(input([vi('A', 100_000, { demand: null })], [vi('B', 100_000)]));
    expect(s.terms.find((x) => x.key === 'demand_shift')!.raw).toBe(0);
  });
});
