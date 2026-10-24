/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Verdict caps: every cap explains itself with numbers and the band it limits to. */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';

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
const basePartner = (o: Partial<PartnerInfo> = {}): Omit<PartnerInfo, 'flags' | 'evidence'> => ({
  userId: 2, name: 'p', displayName: 'p', createdAt: null, accountAgeDays: 900, hasVerifiedBadge: false, isBanned: false,
  inventoryVisible: true, inventoryValue: 5_000_000, inventoryRap: 5_000_000, inventoryItemCount: 40, inBotList: false,
  terminated: false, repeatOfferCount: 1, repeatOfferAccounts: 1, priorTrades: { completed: 0, declined: 0, countered: 0 },
  fetchedAt: NOW, ...o,
});
const V = (n: string, v: number, o: Partial<ValuedItem> = {}) => vi(n, v, { liquidity: 0.8, ...o });
const give = () => [V('Mine', 100_000)];
const get = (o: Partial<ValuedItem> = {}) => [V('Theirs', 140_000, o)];

function expectCap(s: ReturnType<typeof engine.scoreTrade>, code: string) {
  const c = (s.caps ?? []).find((x) => x.code === code);
  expect(c, `cap ${code} in ${JSON.stringify(s.caps)}`).toBeTruthy();
  expect(s.explanation).toContain(`${c!.reason} -> limited to ${c!.limitedTo}`);
  expect(s.explanation).toMatch(/Limited by/);
  return c!;
}

describe('verdict caps explain themselves', () => {
  it('no cap: no Limited-by line', () => {
    const s = engine.scoreTrade(input(give(), get()));
    expect(s.caps).toEqual([]);
    expect(s.explanation).not.toMatch(/Limited by/);
  });
  it('hold list', () => {
    const g = give();
    const s = engine.scoreTrade(input(g, get(), { settings: S({ holdList: [g[0]!.assetId] }) }));
    expect(expectCap(s, 'hold_list').limitedTo).toBe('Decline');
  });
  it('terminated partner and bot partner', () => {
    const st = S();
    const t = engine.scoreTrade(input(give(), get(), { partner: engine.assessPartner(basePartner({ terminated: true }), st, 1) }));
    expect(expectCap(t, 'partner_terminated').limitedTo).toBe('Decline');
    const b = engine.scoreTrade(input(give(), get(), { partner: engine.assessPartner(basePartner({ inBotList: true }), st, 1) }));
    expect(expectCap(b, 'partner_bot').limitedTo).toBe('Lean accept');
  });
  it('low and very low confidence quote the number', () => {
    const lo = engine.scoreTrade(input([V('Mine', 100_000, { confidence: 0.4 })], get({ confidence: 0.4 })));
    expect(expectCap(lo, 'confidence_low').reason).toMatch(/\d+% < 50%/);
    const vlo = engine.scoreTrade(input([V('Mine', 100_000, { confidence: 0.1 })], get({ confidence: 0.1 })));
    expect(expectCap(vlo, 'confidence_very_low').reason).toMatch(/\d+% < 25%/);
  });
  it('held, thin-history and projected shares', () => {
    expect(expectCap(engine.scoreTrade(input(give(), get({ isOnHold: true, flags: ['on_hold'] }))), 'held_share').reason).toMatch(/100%/);
    expectCap(engine.scoreTrade(input(give(), get({ flags: ['thin_history'] }))), 'thin_history_share');
    expectCap(engine.scoreTrade(input(give(), get({ flags: ['projected'] }))), 'projected_share');
  });
  it('unvalued give and get', () => {
    expectCap(engine.scoreTrade(input([V('Mine', 100_000, { flags: ['no_market_data'] })], get())), 'unvalued_give');
    expectCap(engine.scoreTrade(input(give(), get({ flags: ['no_market_data'] }))), 'unvalued_get');
  });
  it('liquidity trap', () => {
    expectCap(engine.scoreTrade(input([vi('Mine', 10_000, { liquidity: 0.8 })], [vi('Dud', 11_000, { liquidity: 0.1 })])), 'liquidity_trap');
  });
  it('Roblox rule breaks', () => {
    expectCap(engine.scoreTrade(input(give(), get(), { robuxGet: 10_000_000 })), 'exceeds_max_robux');
    const i = input(give(), get());
    i.metadata = { ...i.metadata, minValueRatio: 2 };
    expectCap(engine.scoreTrade(i), 'below_min_value_ratio');
  });
  it('several caps: all listed, tightest one marked binding', () => {
    const st = S();
    const s = engine.scoreTrade(input(give(), get({ flags: ['thin_history'] }), { partner: engine.assessPartner(basePartner({ terminated: true }), st, 1) }));
    expect((s.caps ?? []).length).toBeGreaterThanOrEqual(2);
    expect(s.caps!.filter((c) => c.binding).map((c) => c.code)).toEqual(['partner_terminated']);
    expect(s.explanation).toMatch(/Limited by \d+ caps/);
    expect(s.explanation).toMatch(/\(binding\)/);
  });
  it('band names follow custom verdict bands', () => {
    const st = S({ verdictBands: { accept: 70, leanAccept: 50, counter: 50 } });
    const s = engine.scoreTrade(input(give(), get({ flags: ['thin_history'] }), { settings: st }));
    expect(expectCap(s, 'thin_history_share').limitedTo).toBe('Decline');
    expect(s.explanation).toContain('limited to Decline');
  });
  it('Roblox rule caps quote the numbers', () => {
    const r = engine.scoreTrade(input(give(), get(), { robuxGet: 10_000_000 }));
    expect(expectCap(r, 'exceeds_max_robux').reason).toMatch(/10\.0M Robux partner adds exceeds .*\d+% of that side's item RAP/);
    const i = input(give(), get());
    i.metadata = { ...i.metadata, minValueRatio: 2 };
    expect(expectCap(engine.scoreTrade(i), 'below_min_value_ratio').reason).toMatch(/140% of given item RAP, below .* 200%/);
  });
  it('bot-listed partner repeating the offer names both reasons', () => {
    const st = S();
    const p = engine.assessPartner(basePartner({ inBotList: true, repeatOfferCount: 5, repeatOfferAccounts: 5 }), st, 1);
    const s = engine.scoreTrade(input(give(), get(), { partner: p }));
    const c = expectCap(s, 'partner_bot');
    if (p.flags.includes('repeat_offer')) expect(c.reason).toMatch(/bot list and same offer/);
  });
  it('momentum guard on a value-losing trade is an explained cap', () => {
    const s = engine.scoreTrade(input([V('Mine', 100_000)], [V('Theirs', 80_000, { expectedDriftPct: 0.5 })]));
    const c = expectCap(s, 'momentum_no_lift');
    expect(c.reason).toMatch(/edge -\d/);
    expect(s.score).toBeLessThanOrEqual(c.maxScore + 1e-9);
  });
});

describe('low-confidence cap is margin-aware', () => {
  const codes = (r: ReturnType<typeof engine.scoreTrade>) => (r.caps ?? []).map((c) => c.code);
  it('a huge win cannot be flipped by an uncertain cheap give item: no confidence cap (cheap 603 item -> 18k item)', () => {
    const r = engine.scoreTrade(input([vi('Cheap Hat', 603, { confidence: 0.38 })], [vi('Big Hat', 18_000, { confidence: 0.5 })]));
    expect(codes(r)).not.toContain('confidence_low');
    expect(codes(r)).not.toContain('confidence_very_low');
  });
  it('a modest win on uncertain received items is still capped', () => {
    const r = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 12_000, { confidence: 0.3 })]));
    expect(codes(r)).toContain('confidence_low');
  });
  it('a big win whose received side is very uncertain is still capped (could be worth half)', () => {
    const r = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 15_000, { confidence: 0.1 })]));
    expect(codes(r).some((c) => c.startsWith('confidence'))).toBe(true);
  });
});
