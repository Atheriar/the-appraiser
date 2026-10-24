/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it, vi } from 'vitest';
import { openRepository } from '../db/index.js';
import { Analyst, PURCHASE_TX_MIN_INTERVAL_MS } from './analyst.js';
import { fallbackEngine } from './__fakes__/engine.js';
import { MemorySecretStore } from '../secrets/index.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';
import { HttpRobloxClient } from '../adapters/roblox/client.js';
import { fakeFetch, fixtureResponse, respond, testDeps } from '../adapters/__tests__/fixtureFetch.js';
import type { CollectibleInstance, Page, PurchaseTransaction, RobloxClient } from '../adapters/interfaces.js';

const HOUR = 3_600_000;
const COOKIE = 'test-cookie-value';

describe('roblox client: purchase transactions', () => {
  it('parses the fixture leniently (asset rows only, odd rows dropped) via a read-only GET', async () => {
    const ff = fakeFetch([(u) => (u.hostname === 'economy.roblox.com' && u.pathname === '/v2/users/1/transactions' ? fixtureResponse('economy_transactions_purchase') : undefined)]);
    const c = new HttpRobloxClient({ cookie: async () => COOKIE, deps: testDeps(ff.fetch) });
    const p = await c.getPurchaseTransactions(1);
    expect(p.nextPageCursor).toBe('page2cursor');
    expect(p.data).toEqual([
      { id: 9001, created: Date.parse('2026-10-21T08:30:00.000Z'), assetId: 1365767, detailsType: 'Asset', name: 'Test Egg' },
      { id: 9005, created: Date.parse('2026-10-18T12:00:00Z'), assetId: 1080949, detailsType: 'Asset', name: 'Bunny Ears' },
    ]);
    const call = ff.calls[0]!;
    expect(call.url).toContain('transactionType=Purchase&limit=100');
    expect(call.method ?? 'GET').toBe('GET');
  });

  it('throws on 403 (the analyst degrades)', async () => {
    const ff = fakeFetch([() => respond({ errors: [{ code: 0, message: 'Forbidden' }] }, 403)]);
    const c = new HttpRobloxClient({ cookie: async () => COOKIE, deps: testDeps(ff.fetch) });
    await expect(c.getPurchaseTransactions(1)).rejects.toThrow(/403/);
  });
});

function make(getPurchaseTransactions: RobloxClient['getPurchaseTransactions']) {
  const log = new Logger(null, false);
  const warn = vi.spyOn(log, 'warn');
  const a = new Analyst({ repo: openRepository(':memory:'), secrets: new MemorySecretStore(null), engine: fallbackEngine, engineReal: false,
    adapters: null, notifier: new NullNotifier(), log, uiUrl: 'http://127.0.0.1:47615' });
  a.roblox = { getPurchaseTransactions } as unknown as RobloxClient;
  a.account = { id: 1, name: 'me', displayName: 'me' };
  return { a, warn };
}
const egg = (onHold = true): CollectibleInstance => ({ userAssetId: 700, assetId: 1365767, name: 'Test Egg', serialNumber: null, recentAveragePrice: 300, originalPrice: null, assetStock: null, isOnHold: onHold });
const page = (rows: PurchaseTransaction[], next: string | null = null): Page<PurchaseTransaction> => ({ data: rows, nextPageCursor: next, previousPageCursor: null });

describe('analyst: purchase-started holds', () => {
  it('an unmatched held copy fetches purchases (<= 2 pages) and becomes a purchase hold on the 3 d length', async () => {
    const now = Date.now();
    const fetch = vi.fn(async (_u: number, cursor?: string) => cursor
      ? page([{ id: 2, created: now - 40 * HOUR, assetId: 1, detailsType: 'Asset', name: 'x' }], 'more')
      : page([{ id: 1, created: now - 20 * HOUR, assetId: 1365767, detailsType: 'Asset', name: 'Test Egg' }], 'c2'));
    const { a } = make(fetch);
    await a.refreshPurchasesIfNeeded([egg()], now);
    expect(fetch).toHaveBeenCalledTimes(2);
    a.repo.setKv('ownInventory', { fetchedAt: now, items: [egg()] });
    a.trackHolds([egg()], now);
    const est = a.holdFor(1365767, null, now)!;
    expect(est).toMatchObject({ kind: 'purchase', startBasis: 'purchase', holdStart: now - 20 * HOUR, releaseAt: now - 20 * HOUR + 3 * 24 * HOUR });
    // Throttled: at most once per 30 min; and not at all once nothing is unmatched.
    await a.refreshPurchasesIfNeeded([egg()], now + 10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await a.refreshPurchasesIfNeeded([egg()], now + PURCHASE_TX_MIN_INTERVAL_MS + 1);
    expect(fetch).toHaveBeenCalledTimes(2); // the tracked copy already has a purchase start
    a.stop();
  });

  it('does not fetch when nothing is on hold', async () => {
    const fetch = vi.fn(async () => page([]));
    const { a } = make(fetch);
    await a.refreshPurchasesIfNeeded([egg(false)], Date.now());
    expect(fetch).not.toHaveBeenCalled();
    a.stop();
  });

  it('endpoint failure degrades to unknown silently, warning once', async () => {
    const now = Date.now();
    const fetch = vi.fn(async () => { throw new Error('transactions: HTTP 403'); });
    const { a, warn } = make(fetch);
    await a.refreshPurchasesIfNeeded([egg()], now);
    await a.refreshPurchasesIfNeeded([egg()], now + PURCHASE_TX_MIN_INTERVAL_MS + 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('purchase transactions'))).toHaveLength(1);
    expect(a.purchaseLookupStatus().failed).toContain('403');
    a.repo.setKv('ownInventory', { fetchedAt: now, items: [egg()] });
    a.trackHolds([egg()], now);
    expect(a.holdFor(1365767, null, now)).toMatchObject({ kind: 'unknown', lengthIsMax: true, lengthMs: 3 * 24 * HOUR });
    a.stop();
  });
});

describe('analyst: purchase lookups are once per held copy', () => {
  it('a copy with no purchase found is not looked up again, even after the 30 min window', async () => {
    const now = Date.now();
    const fetch = vi.fn(async () => page([]));
    const { a } = make(fetch);
    await a.refreshPurchasesIfNeeded([egg()], now);
    expect(fetch).toHaveBeenCalledTimes(1);
    await a.refreshPurchasesIfNeeded([egg()], now + 5 * PURCHASE_TX_MIN_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    a.stop();
  });
  it('a failed lookup is retried once, then given up', async () => {
    const now = Date.now();
    const fetch = vi.fn(async () => { throw new Error('transactions: HTTP 500'); });
    const { a } = make(fetch);
    for (let k = 0; k < 4; k++) await a.refreshPurchasesIfNeeded([egg()], now + k * (PURCHASE_TX_MIN_INTERVAL_MS + 1));
    expect(fetch).toHaveBeenCalledTimes(2);
    a.stop();
  });
  it('a newly arrived held copy is looked up even after others were answered', async () => {
    const now = Date.now();
    const fetch = vi.fn(async () => page([]));
    const { a } = make(fetch);
    await a.refreshPurchasesIfNeeded([egg()], now);
    const other = { ...egg(), userAssetId: 701, assetId: 42 };
    await a.refreshPurchasesIfNeeded([egg(), other], now + PURCHASE_TX_MIN_INTERVAL_MS + 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    a.stop();
  });
});
