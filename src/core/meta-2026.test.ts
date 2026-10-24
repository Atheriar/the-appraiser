/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** 2026 trading-meta changes: fee drag, hoard release, thin history, Value-vs-RAP edge, norm labelling. */
import { describe, expect, it } from 'vitest';
import { engine, MODEL_VERSION } from './index.js';
import type { ScoreInput } from './contracts.js';
import { calibrateNorms } from './learning.js';
import { detectHoardRelease } from './projection.js';
import { searchCounterPackages } from './counter.js';
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

it('model version bumped for the meta-2026 and audit-2 changes', () => {
  expect(MODEL_VERSION).toBe('core-1.5.0');
});

describe('1. Robux fee drag', () => {
  it('giving 1 item + 1,000 R$ flags robux_fee_drag and names the 300 R$ lost', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 11_500)], { robuxGive: 1_000 }));
    expect(s.flags).toContain('robux_fee_drag');
    const ev = s.evidence!.find((e) => e.code === 'robux_fee_drag')!;
    expect(ev.message).toMatch(/300 R\$/);
    expect(ev.message).toMatch(/700 R\$/);
    expect(s.explanation).toMatch(/300 R\$ is lost/);
  });
  it('no Robux given: no flag', () => {
    const s = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 11_500)]));
    expect(s.flags).not.toContain('robux_fee_drag');
    expect(s.evidence!.some((e) => e.code === 'robux_fee_drag')).toBe(false);
  });
  it('the flag does not move the score', () => {
    const a = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 11_500)], { robuxGive: 1_000 }));
    const settings = structuredClone(DEFAULT_SETTINGS);
    const b = engine.scoreTrade(input([vi('Mine', 10_000)], [vi('Theirs', 11_500)], { robuxGive: 1_000, settings }));
    expect(a.score).toBe(b.score);
    expect(a.terms.map((t) => t.key)).not.toContain('robux_fee_drag' as never);
  });
  it('a closing item is suggested before a Robux ask worth less after fee', () => {
    // Needs ~10k; Robux ask is ~14.3k gross, a 12k item closes the gap for less.
    const s = engine.scoreTrade(input([vi('Big', 500_000)], [vi('A', 200_000), vi('B', 180_000), vi('C', 150_000)],
      { partnerTradable: [vi('Cheap', 12_000)] }));
    const kinds = s.counterSuggestion!.options.map((o) => o.kind);
    expect(kinds.indexOf('add_partner_item')).toBeLessThan(kinds.indexOf('add_robux'));
  });
  it('counter packages: item-only beats item + Robux adding the same value', () => {
    const inp = input([vi('Mine', 100_000)], [vi('Theirs', 80_000)], { partnerTradable: [vi('Exact', 29_000), vi('Short', 25_000)] });
    const pkgs = searchCounterPackages(inp);
    expect(pkgs[0]!.robux).toBe(0);
    expect(pkgs[0]!.add[0]!.name).toBe('Exact');
  });
});

describe('2. Hoard release', () => {
  const S = DEFAULT_SETTINGS;
  const h = (daysAgo: number, copies: number) => ({ fetchedAt: NOW - daysAgo * DAY, topOwnerCopies: copies });
  it('37 -> 21 copies within 14 days fires', () => {
    const r = detectHoardRelease([h(10, 37), h(0, 21)], S, NOW);
    expect(r.hoardRisk).toBe(true);
    expect(r.evidence[0]!.code).toBe('hoard_releasing');
    expect(r.evidence[0]!.data).toMatchObject({ prevMax: 37, now: 21 });
  });
  it('37 -> 30 does not fire', () => {
    expect(detectHoardRelease([h(10, 37), h(0, 30)], S, NOW).hoardRisk).toBe(false);
  });
  it('a drop older than the window does not fire', () => {
    expect(detectHoardRelease([h(20, 37), h(0, 21)], S, NOW).hoardRisk).toBe(false);
  });
  it('a null history does not fire', () => {
    expect(detectHoardRelease(null, S, NOW).hoardRisk).toBe(false);
  });
  it('valueItem flags hoard_releasing from topOwnerHistory and scoring penalizes it on the get side only', () => {
    const v = valueItem(snap({ roliValue: 50_000, rap: 50_000, topOwnerCopies: 21, topOwnerHistory: [{ t: NOW - 10 * DAY, copies: 37 }, { t: NOW, copies: 21 }] }), S, NOW);
    expect(v.flags).toContain('hoard_releasing');
    const risk = (give: ValuedItem[], get: ValuedItem[]) => engine.scoreTrade(input(give, get)).terms.find((t) => t.key === 'risk')!.raw;
    const base = risk([vi('Mine', 50_000)], [vi('Theirs', 50_000)]);
    expect(risk([vi('Mine', 50_000)], [vi('Theirs', 50_000, { flags: ['hoard_releasing'] })])).toBeCloseTo(base + S.risk.hoardRelease);
    expect(risk([vi('Mine', 50_000, { flags: ['hoard_releasing'] })], [vi('Theirs', 50_000)])).toBeCloseTo(base);
    const s = engine.scoreTrade(input([vi('Mine', 50_000)], [vi('Theirs', 50_000, { flags: ['hoard_releasing'] })]));
    expect(s.flags).toContain('hoard_releasing');
  });
});

describe('3. Thin history / new release', () => {
  const S = DEFAULT_SETTINGS;
  it('a 2-day-old item is flagged thin_history', () => {
    const v = valueItem(snap({ roliValue: 50_000, rap: 50_000, sales30d: 40, createdAt: NOW - 2 * DAY }), S, NOW);
    expect(v.flags).toContain('thin_history');
  });
  it('an old valued item is not', () => {
    const v = valueItem(snap({ roliValue: 50_000, rap: 50_000, sales30d: 0, createdAt: NOW - 400 * DAY }), S, NOW);
    expect(v.flags).not.toContain('thin_history');
  });
  it('an unvalued item with < 3 sales in 30d is', () => {
    const v = valueItem(snap({ roliValue: null, rap: 50_000, floorPrice: 50_000, sales30d: 1 }), S, NOW);
    expect(v.flags).toContain('thin_history');
  });
  it('a mostly-new-release get side caps the verdict below Lean accept', () => {
    const get = [vi('Fresh', 140_000, { flags: ['thin_history'] })];
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], get));
    expect(s.score).toBeLessThan(S.verdictBands.leanAccept);
    const plain = engine.scoreTrade(input([vi('Mine', 100_000)], [vi('Fresh', 140_000)]));
    expect(plain.score).toBeGreaterThanOrEqual(S.verdictBands.leanAccept);
  });
  it('a 0.4 thin share is penalized but not capped', () => {
    const give = [vi('Mine', 70_000)];
    const thin = engine.scoreTrade(input(give, [vi('Fresh', 40_000, { flags: ['thin_history'] }), vi('Old', 60_000)]));
    const plain = engine.scoreTrade(input(give, [vi('Fresh', 40_000), vi('Old', 60_000)]));
    const r = (x: typeof thin) => x.terms.find((t) => t.key === 'risk')!.raw;
    expect(r(thin)).toBeCloseTo(r(plain) + 0.4 * S.risk.thinHistory);
    expect(thin.score).toBeGreaterThanOrEqual(S.verdictBands.leanAccept);
  });
});

describe('4. Edge on Value and RAP', () => {
  it('a projected get item: positive RAP edge, negative Value edge, divergence evidence', () => {
    const proj = vi('Pumped', 50_000, { rap: 200_000, roliValue: null, basis: 'pre_spike_baseline', flags: ['projected'] });
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], [proj]));
    expect(s.edgePct).toBeLessThan(0);
    expect(s.edgePctRap!).toBeGreaterThan(0);
    expect(s.edgePctRap!).toBeCloseTo(1.0);
    const ev = s.evidence!.find((e) => e.code === 'value_rap_divergence')!;
    expect(ev.message).toMatch(/Wins on RAP but loses on Value/);
    expect(s.flags).toContain('value_rap_divergence');
  });
  it('no divergence when both agree', () => {
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], [vi('Theirs', 130_000)]));
    expect(s.evidence!.some((e) => e.code === 'value_rap_divergence')).toBe(false);
  });
  it('RAP edge counts get-side Robux after fee', () => {
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], [vi('Theirs', 90_000)], { robuxGet: 10_000 }));
    expect(s.edgePctRap!).toBeCloseTo((90_000 + 7_000 - 100_000) / 100_000);
  });
});

describe('5. Honest norm label', () => {
  it('default norms carry the unsourced note', () => {
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], [vi('Theirs', 110_000)]));
    expect(s.explanation).toContain('(default norm, no public data; calibrates from your completed trades)');
  });
  it('calibrated norms do not', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.overpayNorms.source = 'calibrated';
    const s = engine.scoreTrade(input([vi('Mine', 100_000)], [vi('Theirs', 110_000)], { settings }));
    expect(s.explanation).not.toContain('default norm');
  });
  it('calibrateNorms marks its table calibrated', () => {
    const outcomes: TradeOutcome[] = Array.from({ length: 40 }, (_, i) => ({
      tradeId: i, finalStatus: 'Completed', decidedAt: NOW, valueGainAt7d: 0, valueGainAt30d: 0,
      verdictAtTime: 'Accept', scoreAtTime: 80, shape: 'UPGRADE', valueTier: 'large', rawGainPct: -0.14,
    }));
    const t = calibrateNorms(outcomes, DEFAULT_SETTINGS.overpayNorms);
    expect(t).not.toBeNull();
    expect(t!.source).toBe('calibrated');
    expect(DEFAULT_SETTINGS.overpayNorms.source).toBe('default_unsourced');
  });
});
