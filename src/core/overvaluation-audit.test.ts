/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Regression tests for the overvaluation audit: each reproduces a way an incoming trade looked better than it was. */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';
import { applySnapshotLag, snapshotLag } from './learning.js';
import {
  DEFAULT_SETTINGS, type ItemSnapshot, type PartnerInfo, type ReconstructedSale, type Settings, type TradeItem, type TradeSnapshot, type ValuedItem,
} from './types.js';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;
const S = (patch: Partial<Settings> = {}): Settings => structuredClone({ ...DEFAULT_SETTINGS, ...patch });

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
  assetStock: null, isOnHold: v.isOnHold ?? null, joinKey: 'v1_only',
});
function input(give: ValuedItem[], get: ValuedItem[], o: { robuxGive?: number; robuxGet?: number; settings?: Settings; partner?: PartnerInfo | null } = {}): ScoreInput {
  const trade: TradeSnapshot = {
    tradeId: 1, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: NOW, expiresAt: null,
    partner: { userId: 2, name: 'p', displayName: 'p' },
    give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(tItem), robux: o.robuxGive ?? 0 },
    get: { userId: 2, userName: 'p', displayName: 'p', items: get.map(tItem), robux: o.robuxGet ?? 0 },
    fetchedAt: NOW, hadV1: true, hadV2: true, offerSignature: 'x',
  };
  return {
    trade, give, get, partner: o.partner ?? null, partnerTradable: [],
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
const sale = (daysAgo: number, price: number, oldRap = price, newRap = price): ReconstructedSale =>
  ({ assetId: 1, t: NOW - daysAgo * DAY, price, oldRap, newRap, source: 'rolimons_feed' });
const basePartner = (o: Partial<PartnerInfo> = {}): Omit<PartnerInfo, 'flags' | 'evidence'> => ({
  userId: 2, name: 'p', displayName: 'p', createdAt: null, accountAgeDays: 900, hasVerifiedBadge: false, isBanned: false,
  inventoryVisible: true, inventoryValue: 5_000_000, inventoryRap: 5_000_000, inventoryItemCount: 40, inBotList: false,
  terminated: false, repeatOfferCount: 1, repeatOfferAccounts: 1, priorTrades: { completed: 0, declined: 0, countered: 0 },
  fetchedAt: NOW, ...o,
});

describe('overvaluation audit: valuation', () => {
  const st = S();

  it('unvalued item with no floor is capped near its 30d median, not raw RAP (10 sales escape rule 1)', () => {
    const v = engine.valueItem(snap({ rap: 50_000, lastSales: Array.from({ length: 10 }, (_, i) => sale(i + 1, 20_000)) }), st, NOW);
    expect(v.basis).toBe('market_min');
    expect(v.tradeValue).toBe(23_000); // median 20k x (1 + 15% tolerance)
    expect(v.evidence.some((e) => e.code === 'rap_vs_median')).toBe(true);
  });

  it('a 4th sale plus a spike 15d ago (outside rule 2 window) no longer values at the pumped RAP', () => {
    const v = engine.valueItem(snap({ rap: 1_900, lastSales: [sale(15, 10_000, 1_000, 1_900), sale(18, 1_000), sale(20, 1_000), sale(22, 1_000), sale(25, 1_000)] }), st, NOW);
    expect(v.tradeValue).toBeLessThanOrEqual(1_150);
  });

  it('wash-sale chain just under the spike ratio cannot lift a market_min value far above the floor', () => {
    const v = engine.valueItem(snap({
      rap: 1_603, floorPrice: 1_000, resellerCount: 2,
      lastSales: [sale(1, 2_902, 1_458, 1_603), sale(2, 2_641, 1_327, 1_458), sale(3, 2_403, 1_208, 1_327), sale(4, 2_187, 1_099, 1_208), sale(5, 1_990, 1_000, 1_099)],
    }), st, NOW);
    expect(v.basis).toBe('market_min');
    expect(v.tradeValue).toBeLessThanOrEqual(1_150);
  });

  it('Rolimons value is corrected down with one market ref and with zero 30d sales, by more than 10%', () => {
    const noSales = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, floorPrice: 60_000, resellerCount: 2, sales30d: 0 }), st, NOW);
    expect(noSales.flags).toContain('drop_pending');
    expect(noSales.tradeValue).toBe(75_000); // 100k - min(1.0 x 40k, 25%) (audit 2: full step to market)
    const both = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, floorPrice: 50_000, resellerCount: 2, sales30d: 10,
      dailyPrice: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (i + 1) * DAY, value: 50_000 })) }), st, NOW);
    expect(both.tradeValue).toBe(75_000);
  });

  it('a crashed valued item (rule 3: floor far below RAP, deep book) is not worth more than its floor', () => {
    const v = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, floorPrice: 50_000, resellerCount: 5, sales30d: 4 }), st, NOW);
    expect(v.flags).toContain('projected');
    expect(v.tradeValue).toBeLessThanOrEqual(50_000);
  });

  it('serial premium applies to the base value, not on top of the raise_pending lift', () => {
    const v = engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, isLimitedU: true, serial: 1, floorPrice: 140_000, resellerCount: 4, sales30d: 30,
      dailyPrice: Array.from({ length: 10 }, (_, i) => ({ t: NOW - (i + 1) * DAY, value: 140_000 })) }), st, NOW);
    expect(v.flags).toContain('raise_pending');
    expect(v.tradeValue).toBe(160_000); // 100k x 1.5 + 10k lift, not (100k + 10k) x 1.5 = 165k
  });

  it('a projected item gets no positive momentum drift from its own spike', () => {
    const v = engine.valueItem(snap({ rap: 1_400, roliValue: 1_000, roliProjected: true,
      dailyPrice: [{ t: NOW - DAY, value: 5_000 }, ...Array.from({ length: 6 }, (_, i) => ({ t: NOW - (i + 2) * DAY, value: 1_000 }))] }), st, NOW);
    expect(v.flags).toContain('projected');
    expect(v.expectedDriftPct).toBeLessThanOrEqual(0);
  });

  it('a never-fetched snapshot (fetchedAt 0) is flagged stale', () => {
    const v = engine.valueItem(snap({ rap: 10_000, roliValue: 10_000, fetchedAt: 0 }), st, NOW);
    expect(v.flags).toContain('stale_data');
    expect(v.evidence.find((e) => e.code === 'stale_data')!.message).toMatch(/No Roblox market snapshot/);
  });
});

describe('overvaluation audit: sale reconstruction', () => {
  it('a RAP drop too steep for one sale is kept as a low sale, not dropped', () => {
    const sales = engine.salesFromRapSnapshots(1, [{ t: NOW - 2 * DAY, rap: 1_000 }, { t: NOW - DAY, rap: 880 }]);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.price).toBe(880);
  });
});

describe('overvaluation audit: shape and norm', () => {
  it('a filler on the get side does not turn a 1-for-1 into an UPGRADE allowance', () => {
    const give = [vi('A', 92_000)];
    const s = engine.scoreTrade(input(give, [vi('B', 100_000), vi('C', 1_000)]));
    expect(s.shape).toBe('EVEN');
    expect(s.normPct).toBe(0);
  });

  it('a downgrade padded with received Robux still demands the split premium', () => {
    const s = engine.scoreTrade(input([vi('A', 200_000)], [vi('B', 110_000)], { robuxGet: 130_000 }));
    expect(s.shape).toBe('DOWNGRADE');
    expect(s.normPct).toBeGreaterThan(0);
    const s2 = engine.scoreTrade(input([vi('A', 100_000), vi('a', 1_000)], [vi('B', 52_000), vi('C', 50_000)]));
    expect(s2.shape).toBe('DOWNGRADE');
    expect(s2.normPct).toBeGreaterThan(0);
  });
});

describe('overvaluation audit: scoring caps', () => {
  it('edge term is clamped so a tiny give side cannot drown the risk terms', () => {
    const s = engine.scoreTrade(input([vi('A', 2_000)], [vi('B', 6_000)]));
    expect(s.terms.find((t) => t.key === 'edge')!.raw).toBe(50);
  });

  it('a bare-RAP received item with no market data is haircut and capped below Lean accept', () => {
    const st = S();
    const give = [engine.valueItem(snap({ rap: 100_000, roliValue: 100_000, roliDemand: 1, sales30d: 2, floorPrice: 100_000, resellerCount: 1 }), st, NOW)];
    const get = [engine.valueItem(snap({ rap: 130_000, sources: [] }), st, NOW)];
    expect(get[0]!.flags).toContain('no_market_data');
    const s = engine.scoreTrade(input(give, get));
    expect(s.flags).toContain('unvalued_get');
    expect(s.totals.valueGet).toBe(65_000);
    expect(s.score).toBeLessThan(st.verdictBands.leanAccept);
  });

  it('a terminated partner caps at Decline; a bot-list partner never gets Accept', () => {
    const st = S();
    const give = [vi('Mine', 100_000)];
    const get = [vi('Theirs', 116_000)];
    const term = engine.assessPartner(basePartner({ terminated: true }), st, 1);
    expect(engine.scoreTrade(input(give, get, { partner: term })).verdict).toBe('Decline');
    const bot = engine.assessPartner(basePartner({ inBotList: true }), st, 1);
    expect(engine.scoreTrade(input(give, get, { partner: bot })).verdict).not.toBe('Accept');
  });

  it('positive momentum cannot make a zero-edge trade Accept or lift a losing trade', () => {
    const z = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 100_000, { expectedDriftPct: 0.25 })]));
    expect(z.verdict).not.toBe('Accept');
    const lose = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 95_000, { expectedDriftPct: 0.25 })]));
    const loseFlat = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 95_000)]));
    expect(lose.score).toBeLessThanOrEqual(loseFlat.score + 1e-9);
  });

  it('low aggregate confidence caps the verdict', () => {
    const s = engine.scoreTrade(input([vi('A', 100_000, { confidence: 0.2 })], [vi('B', 114_000, { confidence: 0.2 })]));
    expect(s.score).toBeLessThan(S().verdictBands.leanAccept);
    const m = engine.scoreTrade(input([vi('A', 100_000, { confidence: 0.4 })], [vi('B', 130_000, { confidence: 0.4 })]));
    expect(m.verdict).not.toBe('Accept');
  });

  it('a small known-demand add-on cannot set the demand of a large unknown-demand get side', () => {
    const s = engine.scoreTrade(input([vi('A', 108_000, { demand: 2 })], [vi('Big', 105_000, { demand: null }), vi('Tiny', 3_000, { demand: 4 })]));
    expect(Math.abs(s.terms.find((t) => t.key === 'demand_shift')!.raw)).toBeLessThan(0.2);
  });

  it('a get side mostly on hold, or a trade breaking the max-Robux rule, cannot be Accept', () => {
    const held = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 130_000, { isOnHold: true, flags: ['on_hold'] })]));
    expect(held.verdict).not.toBe('Accept');
    const robux = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 50_000)], { robuxGet: 100_000 }));
    expect(robux.flags).toContain('exceeds_max_robux');
    expect(robux.score).toBeLessThan(S().verdictBands.leanAccept);
  });

  it('unknown hold status on a received item costs liquidity and risk', () => {
    const known = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 105_000)]));
    const unknown = engine.scoreTrade(input([vi('A', 100_000)], [vi('B', 105_000, { flags: ['hold_unknown'] })]));
    expect(unknown.totals.liquidGet).toBeLessThan(known.totals.liquidGet);
    expect(unknown.score).toBeLessThan(known.score);
    expect(unknown.flags).toContain('hold_unknown');
  });
});

describe('overvaluation audit: snapshot lag', () => {
  it('Rolimons-overlay copies of one observation do not satisfy persist, and RAP alone cannot raise', () => {
    const row = (at: number, rap: number, floorPrice: number | null = null) => snap({ assetId: 7, rap, floorPrice, fetchedAt: at });
    const hist = [row(NOW - DAY, 12_500), row(NOW, 12_500), row(NOW, 12_500), row(NOW, 12_500)];
    expect(snapshotLag(hist, 10_000, NOW)).toBeNull();
    const distinct = [row(NOW - DAY, 12_500), row(NOW - DAY / 2, 12_500), row(NOW, 12_500)];
    expect(snapshotLag(distinct, 10_000, NOW)).toBeNull();
  });

  it('a raise signal is not applied to a projected item', () => {
    const v = vi('P', 10_000, { flags: ['roli_projected'] });
    const out = applySnapshotLag(v, { kind: 'raise_pending', changePct: 0.25, mkt: 12_500, value: 10_000, samples: 3 });
    expect(out.tradeValue).toBe(10_000);
  });
});
