/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openRepository } from '../db/index.js';
import { Analyst } from './analyst.js';
import { fallbackEngine } from './__fakes__/engine.js';
import { MemorySecretStore } from '../secrets/index.js';
import { DEMO_ACCOUNT, primeDemo, seedDemo } from '../server/demo.js';
import { loadEngine } from '../server/loader.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';
import { buildMyTrades, queryMyTrades } from './myTrades.js';

let analyst: Analyst;
beforeAll(async () => {
  const repo = openRepository(':memory:');
  const seed = seedDemo(repo);
  const { engine, real } = await loadEngine().catch(() => ({ engine: fallbackEngine, real: false }));
  analyst = new Analyst({ repo, secrets: new MemorySecretStore(), engine, engineReal: real, adapters: null, notifier: new NullNotifier(), log: new Logger(null, false),
    uiUrl: 'http://127.0.0.1:47615', demo: { account: DEMO_ACCOUNT, rolimons: null } });
  await primeDemo(analyst, seed);
});

describe('My Trades ledger (demo data)', () => {
  it('lists every completed trade once, newest first, with all three then-value bases', () => {
    const rows = buildMyTrades(analyst);
    expect(rows.length).toBe(7);
    expect(new Set(rows.map((r) => r.tradeId)).size).toBe(rows.length);
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort((a, b) => b - a));
    const byPartner = new Map(rows.map((r) => [r.partner.name, r]));
    expect(byPartner.get('RobuxTopper')!.thenBasis).toBe('score_at_trade');
    expect(byPartner.get('RobuxTopper')!.scoreThen).not.toBeNull();
    expect(byPartner.get('RobuxTopper')!.dateBasis).toBe('completed_observed');
    expect(byPartner.get('OldFriend')!.thenBasis).toBe('snapshot');
    expect(byPartner.get('OldFriend')!.scoreThen).toBeNull();
    expect(byPartner.get('LongAgo')!.thenBasis).toBe('current_estimate');
    expect(byPartner.get('LongAgo')!.get.items[0]!.confidence).toBe('low');
    for (const r of rows) expect(r.scoreNow).not.toBeNull();
    // HoldDemo (completed 20 h ago, watched) brought in a copy that is still on hold: countdown on its received item only.
    const held = byPartner.get('HoldDemo')!.get.items[0]!.hold!;
    expect(held).toMatchObject({ startBasis: 'trade', lengthSource: 'assumed', overdue: false });
    expect(held.remainingMs).toBeGreaterThan(27 * 3_600_000);
    expect(byPartner.get('RobuxTopper')!.get.items.every((i) => !i.hold)).toBe(true);
  });

  it('P&L uses Robux after the fee on the received side and the full amount on the given side', () => {
    const rows = buildMyTrades(analyst);
    const topper = rows.find((r) => r.partner.name === 'RobuxTopper')!;
    expect(topper.get.robuxCounted).toBe(3_500);
    expect(topper.pnl.gainThen).toBeCloseTo(topper.get.valueThen + 3_500 - topper.give.valueThen);
    expect(topper.pnl.gainNow).toBeCloseTo(topper.get.valueNow + 3_500 - topper.give.valueNow);
    const longAgo = rows.find((r) => r.partner.name === 'LongAgo')!;
    expect(longAgo.pnl.gainThen).toBeCloseTo(longAgo.get.valueThen - (longAgo.give.valueThen + 3_000));
  });

  it('the re-score never discounts a copy the user owns only because of that trade', () => {
    // LongAgo brought in s3; the demo inventory holds one s3 copy. Walked back, there was none before the trade.
    const longAgo = buildMyTrades(analyst).find((r) => r.partner.name === 'LongAgo')!;
    expect(longAgo.portfolioBasis).toBe('reconstructed');
    const t = analyst.repo.getTrade(longAgo.tradeId)!;
    const withCurrent = analyst.computeScore(t, { plain: true });
    expect(withCurrent.totals.duplicatePenalty).toBeLessThan(0);
    expect(longAgo.scoreNow!.score).toBeGreaterThanOrEqual(withCurrent.score);
  });

  it('filters, search and pagination; summary covers the filtered set', () => {
    const all = queryMyTrades(analyst, { status: 'all', page: 1, pageSize: 25 });
    expect(all.total).toBe(7);
    expect(all.lifetimeTrades).toBe(7);
    expect(all.summary.trades).toBe(7);
    expect(all.summary.estimatedTrades).toBe(1);
    const won = queryMyTrades(analyst, { status: 'won', page: 1, pageSize: 25 });
    expect(won.rows.every((r) => r.pnl.gainNow > 0)).toBe(true);
    expect(queryMyTrades(analyst, { status: 'all', page: 1, pageSize: 25, q: 'longago' }).total).toBe(1);
    const recent = queryMyTrades(analyst, { status: 'all', page: 1, pageSize: 25, from: Date.now() - 30 * 86_400_000 });
    expect(recent.rows.every((r) => r.date >= Date.now() - 30 * 86_400_000)).toBe(true);
    expect(recent.total).toBeLessThan(7);
    const p2 = queryMyTrades(analyst, { status: 'all', page: 9, pageSize: 25 });
    expect(p2.page).toBe(1);
  });
});
