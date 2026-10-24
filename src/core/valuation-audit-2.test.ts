/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Valuation audit 2 (core-1.4.0): undervaluation / double-count / crash-risk regressions. */
import { describe, expect, it } from 'vitest';
import { engine } from './index.js';
import type { ScoreInput } from './contracts.js';
import { valueItem } from './valuation.js';
import {
  DEFAULT_SETTINGS, type ItemSnapshot, type Settings, type TradeItem, type TradeOutcome, type TradeSnapshot, type ValuedItem,
} from './types.js';
import { emptySnapshot } from '../jobs/snapshots.js';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;
let nextId = 9000;
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
  assetStock: null, isOnHold: false, joinKey: 'v1_only',
});
function input(give: ValuedItem[], get: ValuedItem[], o: { robuxGive?: number; robuxGet?: number; settings?: Settings; partnerTradable?: ValuedItem[] } = {}): ScoreInput {
  const trade: TradeSnapshot = {
    tradeId: 1, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: NOW, expiresAt: null,
    partner: { userId: 2, name: 'p', displayName: 'p' },
    give: { userId: 1, userName: 'me', displayName: 'me', items: give.map(tItem), robux: o.robuxGive ?? 0 },
    get: { userId: 2, userName: 'p', displayName: 'p', items: get.map(tItem), robux: o.robuxGet ?? 0 },
    fetchedAt: NOW, hadV1: true, hadV2: true, offerSignature: 'x',
  };
  return {
    trade, give, get, partner: null, partnerTradable: o.partnerTradable ?? [],
    portfolio: { owned: new Map(), ownedValue: 1_000_000, upgradeTarget: null },
    metadata: { ...DEFAULT_SETTINGS.tradeMetadataFallback, verified: false, fetchedAt: NOW },
    settings: o.settings ?? structuredClone(DEFAULT_SETTINGS), now: NOW,
  };
}
const snap = (o: Partial<ItemSnapshot>): ItemSnapshot => ({ ...emptySnapshot(1, 'X', NOW), isLimitedU: true, ...o });

import { detectHoard } from './projection.js';
void valueItem; void (null as unknown as TradeOutcome | undefined);
const B = DEFAULT_SETTINGS.verdictBands;

describe('A1. liquidity cap: no double-count of tier-driven / small liquidity gaps', () => {
  it('4x10k (liq 0.8) for 1x46k (liq 0.6), +15% value: not Counter', () => {
    const give = [0, 1, 2, 3].map((i) => vi(`G${i}`, 10_000, { liquidity: 0.8 }));
    const s = engine.scoreTrade(input(give, [vi('Big', 46_000, { liquidity: 0.6 })]));
    expect(s.score).toBeGreaterThanOrEqual(B.leanAccept);
    expect(s.verdict).not.toBe('Counter');
  });
  it('price tier alone (4x10k liq 0.8 for 1x42k liq 0.75) does not trip the cap', () => {
    const give = [0, 1, 2, 3].map((i) => vi(`G${i}`, 10_000, { liquidity: 0.8 }));
    const s = engine.scoreTrade(input(give, [vi('Big', 42_000, { liquidity: 0.75 })]));
    expect(s.score).toBeGreaterThanOrEqual(B.leanAccept);
  });
  it('10,000 (liq 0.80) for 10,500 (liq 0.75) stays Lean accept, no Robux ask for liquidity', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000, { liquidity: 0.8 })], [vi('Theirs', 10_500, { liquidity: 0.75 })]));
    expect(s.verdict).toBe('Lean accept');
    expect(s.counterSuggestion?.text ?? '').not.toMatch(/harder to sell/);
  });
  it('a material liquidity collapse is still capped below Lean accept', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000, { liquidity: 0.8 })], [vi('Dud', 11_000, { liquidity: 0.1 })]));
    expect(s.score).toBeLessThan(B.leanAccept);
  });
});

describe('A2. holds are not triple-counted', () => {
  it('10k for 12k flagged hold_unknown: Lean accept or better', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000, { liquidity: 0.8 })], [vi('Theirs', 12_000, { liquidity: 0.8, flags: ['hold_unknown'] })]));
    expect(s.score).toBeGreaterThanOrEqual(B.leanAccept);
    expect(s.counterSuggestion?.text ?? '').not.toMatch(/harder to sell/);
  });
  it('10k for 12k on hold: Lean accept (hold cap), not Counter and not Accept', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000, { liquidity: 0.8 })], [vi('Theirs', 12_000, { liquidity: 0.8, isOnHold: true, flags: ['on_hold'] })]));
    expect(s.verdict).toBe('Lean accept');
  });
});

describe('A3. hoard threshold relative to supply', () => {
  const st = DEFAULT_SETTINGS;
  it('5,000 copies, top owner 3: no hoard', () => {
    expect(detectHoard(snap({ publicCopies: 5_000, topOwnerCopies: 3 }), st).hoardRisk).toBe(false);
  });
  it('5,000 copies, top owner 150 (3%): hoard', () => {
    expect(detectHoard(snap({ publicCopies: 5_000, topOwnerCopies: 150 }), st).hoardRisk).toBe(true);
  });
  it('rare (80 copies), top owner 5: hoard (absolute rule kept)', () => {
    expect(detectHoard(snap({ publicCopies: 80, topOwnerCopies: 5 }), st).hoardRisk).toBe(true);
  });
});

describe('A4. drop_pending goes to market, momentum cannot cancel it', () => {
  // Example limited: Rolimons 6000, floor 4900, daily sales rising ~4500 -> 5500 then crashing to 4651.
  const series = [
    ...Array.from({ length: 25 }, (_, i) => ({ t: NOW - (30 - i) * DAY, value: Math.round(4500 + i * 40) })),
    { t: NOW - 5 * DAY, value: 5514 }, { t: NOW - 4 * DAY, value: 5483 }, { t: NOW - 3 * DAY, value: 5444 },
    { t: NOW - 2 * DAY, value: 4877 }, { t: NOW - 1 * DAY, value: 4651 },
  ];
  const gch = () => valueItem(snap({ rap: 4_780, roliValue: 6_000, floorPrice: 4_900, resellerCount: 20, sales30d: 60, dailyPrice: series }), DEFAULT_SETTINGS, NOW);
  it('valued at market (not the half-step 5513)', () => {
    const v = gch();
    expect(v.flags).toContain('drop_pending');
    expect(v.tradeValue).toBeLessThanOrEqual(5_100);
  });
  it('no positive momentum drift on a drop_pending item after a fresh -15% break', () => {
    const v = gch();
    expect(v.expectedDriftPct).toBeLessThanOrEqual(0);
    expect(v.evidence.some((e) => e.code === 'momentum' && e.severity === 'good')).toBe(false);
  });
  it('fresh breakdown alone (no drop_pending) blocks positive momentum', () => {
    const v = valueItem(snap({ rap: 4_700, floorPrice: 4_650, resellerCount: 20, sales30d: 60, dailyPrice: series }), DEFAULT_SETTINGS, NOW);
    expect(v.evidence.some((e) => e.code === 'momentum' && e.severity === 'good')).toBe(false);
  });
});

describe('A5. completed step-down is not extrapolated', () => {
  it('Step-down item: 290 for 20d then flat 188 for 10d with volume: momentum no worse than -5%', () => {
    const dailyPrice = Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * DAY, value: i < 20 ? 290 : 188 }));
    const v = valueItem(snap({ rap: 191, floorPrice: 200, resellerCount: 30, sales30d: 2_000, dailyPrice }), DEFAULT_SETTINGS, NOW);
    const m = (v.evidence.find((e) => e.code === 'momentum')?.data as { momentum?: number } | undefined)?.momentum ?? 0;
    expect(m).toBeGreaterThanOrEqual(-0.05);
  });
  it('real-world step series (noisy 10d fit -5%/14d after a 285 -> 188 step) is floored at -5%, not -15%', () => {
    const real = [280, 296, 277, 279, 284, 289, 277, 281, 284, 291, 283, 277, 298, 313, 294, 302, 263, 217, 193, 193, 188, 188, 186, 191, 179, 186, 193, 184];
    const dailyPrice = real.map((value, i) => ({ t: NOW - (real.length - i) * DAY, value }));
    const v = valueItem(snap({ rap: 191, floorPrice: 190, resellerCount: 30, sales30d: 2_080, dailyPrice }), DEFAULT_SETTINGS, NOW);
    const m = (v.evidence.find((e) => e.code === 'momentum')?.data as { momentum?: number } | undefined)?.momentum ?? 0;
    expect(m).toBeGreaterThanOrEqual(-0.05);
  });
  it('a still-falling item keeps its negative momentum', () => {
    const dailyPrice = Array.from({ length: 30 }, (_, i) => ({ t: NOW - (30 - i) * DAY, value: Math.round(300 * Math.exp(-0.02 * i)) }));
    const v = valueItem(snap({ rap: 170, floorPrice: 170, resellerCount: 30, sales30d: 2_000, dailyPrice }), DEFAULT_SETTINGS, NOW);
    const m = (v.evidence.find((e) => e.code === 'momentum')?.data as { momentum?: number }).momentum!;
    expect(m).toBeLessThan(-0.1);
  });
});
