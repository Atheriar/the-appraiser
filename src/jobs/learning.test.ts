/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { engine } from '../core/index.js';
import { DEFAULT_SETTINGS, type ItemSnapshot, type TradeScore, type TradeSnapshot, type ValuedItem } from '../core/types.js';
import { openRepository } from '../db/index.js';
import { LAG_TTL_MS, LearningJob } from './learning.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function trade(id: number): TradeSnapshot {
  const side = (u: number, assetId: number) => ({ userId: u, userName: `u${u}`, displayName: `u${u}`, robux: 0, items: [{
    assetId, itemType: 'Asset' as const, targetId: String(assetId), name: `I${assetId}`, userAssetId: 1, collectibleItemInstanceId: null, collectibleItemId: null,
    serialNumber: null, rap: 100, originalPrice: null, assetStock: null, isOnHold: false, joinKey: 'serial+asset' as const }] });
  return { tradeId: id, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: T0 - DAY, expiresAt: null,
    partner: { userId: 9, name: 'p', displayName: 'p' }, give: side(1, 10), get: side(9, 20), fetchedAt: T0 - DAY,
    hadV1: true, hadV2: true, offerSignature: 'sig' };
}
const vi = (assetId: number, tradeValue: number, o: Partial<ValuedItem> = {}): ValuedItem => ({
  assetId, name: `I${assetId}`, tradeValue, liquidationValue: tradeValue, liquidity: 0.5, confidence: 1, rap: tradeValue, roliValue: tradeValue,
  basis: 'roli_value', expectedDriftPct: 0, serialMultiplier: 1, rarity: 'common', demand: 2, trend: 2, flags: [], evidence: [], snapshotAt: T0, ...o,
});
function score(id: number, at: number): TradeScore {
  return {
    tradeId: id, score: 75, verdict: 'Accept', terms: [], logit: 1, shape: 'EVEN', dominantAssetId: 20, normPct: 0, rawGainPct: 0.1, edgePct: 0.1,
    totals: { valueGive: 100_000, valueGet: 110_000, rawGain: 10_000 } as TradeScore['totals'], confidence: 1,
    give: [vi(10, 100_000)], get: [vi(20, 110_000)], partner: null, flags: [], explanation: '', counterSuggestion: null, capped: false,
    modelVersion: 'test', scoredAt: at,
  };
}

function setup() {
  const repo = openRepository(':memory:');
  repo.migrate();
  const values = new Map<number, number>([[10, 100_000], [20, 110_000]]);
  const plainCalls: boolean[] = [];
  const job = new LearningJob({
    repo, engine, settings: () => DEFAULT_SETTINGS,
    valueFor: (id) => vi(id, values.get(id) ?? 100_000),
    computeScore: (_t: TradeSnapshot, o?: { plain?: boolean }) => { plainCalls.push(o?.plain ?? false); return ({ totals: { rawGain: (values.get(20) ?? 0) - (values.get(10) ?? 0) } }) as TradeScore; },
  });
  return { repo, job, values, plainCalls };
}

describe('LearningJob', () => {
  it('records outcome context and fills +7d / +30d gains and item marks once', () => {
    const { repo, job, values, plainCalls } = setup();
    repo.upsertTrade(trade(1));
    repo.insertScore(score(1, T0 - 1000));
    repo.updateTradeStatus(1, 'Completed', 'Completed', false, T0);

    job.runOutcomes(T0 + DAY);
    let o = repo.getOutcome(1)!;
    expect(o).toMatchObject({ finalStatus: 'Completed', decidedAt: T0, valueGainAt7d: null, shape: 'EVEN', rawGainPct: 0.1, valueGiveAtTime: 100_000, valueTier: 'mid' });
    expect(repo.valueMarks({ tradeId: 1 }).map((m) => [m.side, m.value0, m.value7d]).sort()).toEqual(expect.arrayContaining([['give', 100_000, null], ['get', 110_000, null]]));

    values.set(20, 130_000);
    job.runOutcomes(T0 + 8 * DAY);
    o = repo.getOutcome(1)!;
    expect(o.valueGainAt7d).toBe(30_000);
    expect(plainCalls.length).toBeGreaterThan(0); expect(plainCalls.every(Boolean)).toBe(true); // outcome re-score excludes lag overlay / consolidation premium
    expect(repo.valueMarks({ tradeId: 1 }).find((m) => m.side === 'get')!.value7d).toBe(130_000);

    values.set(20, 150_000);
    job.runOutcomes(T0 + 31 * DAY);
    o = repo.getOutcome(1)!;
    expect(o.valueGainAt7d).toBe(30_000);
    expect(plainCalls.length).toBeGreaterThan(0); expect(plainCalls.every(Boolean)).toBe(true); // outcome re-score excludes lag overlay / consolidation premium // 7d value is frozen once recorded
    expect(o.valueGainAt30d).toBe(50_000);
    const get = repo.valueMarks({ tradeId: 1 }).find((m) => m.side === 'get')!;
    expect(get.value7d).toBe(130_000);
    expect(get.value30d).toBe(150_000);
    expect(repo.valueMarks({ pendingOnly: true })).toHaveLength(0);

    const run = repo.latestModelRun()!;
    expect(run.trades).toBe(1);
    expect(run.verdictHitRate).toBe(1);
    expect(run.avgDriftPct30dAccepted).toBeCloseTo(0.4); // 50k/100k - 0.1
    expect(run.itemDrift!.received30d).toBeCloseTo(150 / 110 - 1);
    expect(run.normSuggestion!.rows).toHaveLength(3);
    expect(run.normSuggestion!.rows.every((r) => !r.enough)).toBe(true);
  });

  it('scans snapshots into the anomaly feed once and overlays the lag on valuation while fresh', () => {
    const { repo, job } = setup();
    const now = T0 + 10 * DAY;
    for (let d = 0; d < 4; d++) {
      repo.insertItemSnapshot({
        assetId: 20, collectibleItemId: null, itemType: 'Asset', name: 'I20', isLimitedU: false, rap: 140_000, roliValue: 110_000, roliDefaultValue: null,
        roliDemand: null, roliTrend: null, roliProjected: null, roliRare: null, floorPrice: 135_000, resellerCount: null, totalQuantity: null,
        publicCopies: null, sales7d: null, sales30d: null, dailyPrice: [], dailyVolume: [], lastSales: [], fetchedAt: now - (3 - d) * DAY, sources: ['catalog'],
      } as ItemSnapshot);
    }
    expect(job.scanSnapshots([20, 10], now)).toBe(1);
    expect(job.scanSnapshots([20], now + 1000)).toBe(0); // unchanged signal: no duplicate
    const feed = repo.recentAnomalies(10);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'raise_pending', assetId: 20 });
    expect(feed[0]!.evidence[0]!.code).toBe('snapshot_lag_up');

    const lifted = LearningJob.overlay(repo, vi(20, 110_000), now);
    expect(lifted.flags).toContain('raise_pending');
    expect(lifted.tradeValue).toBeGreaterThan(110_000);
    expect(LearningJob.overlay(repo, vi(20, 110_000), now + 1000 + LAG_TTL_MS + 1).tradeValue).toBe(110_000);
  });
});

describe('scoring: concentration term', () => {
  it('portfolio fit rewards a trade that spreads out of a dominant illiquid holding', () => {
    const t: TradeSnapshot = trade(5);
    const give = [vi(10, 600_000, { liquidity: 0.2 })], get = [vi(20, 640_000, { liquidity: 0.7 })];
    const base = { trade: t, give, get, partner: null, partnerTradable: [], metadata: { ...DEFAULT_SETTINGS.tradeMetadataFallback, verified: false, fetchedAt: T0 }, settings: DEFAULT_SETTINGS, now: T0 };
    const concentrated = engine.scoreTrade({ ...base, portfolio: { owned: new Map([[10, 1]]), ownedValue: 800_000, ownedValues: new Map([[10, 600_000], [30, 200_000]]), upgradeTarget: null } });
    const diversified = engine.scoreTrade({ ...base, portfolio: { owned: new Map([[10, 1]]), ownedValue: 800_000, upgradeTarget: null } });
    const fit = (s: TradeScore) => s.terms.find((x) => x.key === 'portfolio_fit')!.raw;
    expect(fit(concentrated)).toBeGreaterThan(fit(diversified));
    expect(concentrated.terms.find((x) => x.key === 'portfolio_fit')!.explanation).toMatch(/concentration/);
  });
});
