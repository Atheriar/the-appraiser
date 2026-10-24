/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { openRepository } from '../db/index.js';
import { Analyst, INVENTORY_REFRESH_MIN_MS } from './analyst.js';
import { fallbackEngine } from './__fakes__/engine.js';
import { MemorySecretStore } from '../secrets/index.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';

function make() {
  const notifier = new NullNotifier();
  const a = new Analyst({ repo: openRepository(':memory:'), secrets: new MemorySecretStore(null), engine: fallbackEngine, engineReal: false,
    adapters: null, notifier, log: new Logger(null, false), uiUrl: 'http://127.0.0.1:47615' });
  return { a, notifier };
}

describe('can-trade notifications (real mode, no adapters)', () => {
  it('first observation eligible is silent; persisted marker suppresses repeats', async () => {
    const { a, notifier } = make();
    await a.recordCanTrade({ canTrade: true, tradeEligibility: 'Eligible', freeTradesAllowance: null });
    expect(notifier.sent).toHaveLength(0);
    await a.recordCanTrade({ canTrade: false, tradeEligibility: 'Weird', freeTradesAllowance: null });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.message).toContain('Weird');
    expect(notifier.sent[0]!.url).toBe('http://127.0.0.1:47615/');
  });
  it('first observation ineligible notifies once', async () => {
    const { a, notifier } = make();
    for (let i = 0; i < 3; i++) await a.recordCanTrade({ canTrade: false, tradeEligibility: 'UserNeedsPremium', freeTradesAllowance: null });
    expect(notifier.sent).toHaveLength(1);
    expect(a.tradeStatus()).toBeNull(); // no valid cookie -> no banner
    a.cookieStatus = 'valid';
    expect(a.tradeStatus()!.reason).toMatch(/Roblox Plus/);
  });
  it('unknown before first poll: no status, so no false warning', () => {
    const { a } = make();
    a.cookieStatus = 'valid';
    expect(a.tradeStatus()).toBeNull();
  });
  it('manual inventory refresh is rate limited', async () => {
    const { a } = make();
    const t0 = Date.now();
    expect(a.requestInventoryRefresh(t0).queued).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const second = a.requestInventoryRefresh(Date.now());
    expect(second.queued).toBe(false);
    expect(second.retryAt).toBeGreaterThanOrEqual(t0 + INVENTORY_REFRESH_MIN_MS - 1000);
    a.stop();
  });
});
