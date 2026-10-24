/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterFactory, CatalogItem, RobloxClient, RolimonsClient } from '../adapters/interfaces.js';
import { AdapterError } from '../adapters/limiter.js';
import { openRepository } from '../db/index.js';
import { MemorySecretStore } from '../secrets/index.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';
import { Analyst } from './analyst.js';
import { fallbackEngine } from './__fakes__/engine.js';
import { loadEngine } from '../server/loader.js';

const forbidden = () => new AdapterError('trades: HTTP 403', 403);

async function make() {
  const calls: Record<string, number> = {};
  const restricted: string[] = [];
  let cleared = 0;
  const hit = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  const roblox = {
    getAuthenticatedUser: async () => ({ id: 7, name: 'me', displayName: 'Me' }),
    getTradeCount: async () => { hit('count'); throw forbidden(); },
    listTrades: async () => { hit('list'); throw forbidden(); },
    getCollectibles: async () => [{ userAssetId: 1, assetId: 1029025, name: 'Fedora', serialNumber: null, recentAveragePrice: 400_000, originalPrice: 900, assetStock: null, isOnHold: false }],
    getCatalogDetails: async (ids: number[]) => {
      hit('catalog');
      return new Map<number, CatalogItem>(ids.map((id) => [id, { assetId: id, itemType: 'Asset', name: 'Fedora', collectibleItemId: 'cid-f', itemRestrictions: ['Limited'],
        lowestResalePrice: 409_886, lowestPrice: 409_886, totalQuantity: 10_647, hasResellers: true, isOffSale: true, favoriteCount: 1, creatorName: 'Roblox' }]));
    },
    getThumbnails: async () => new Map(),
    markRestricted: (g: string) => { restricted.push(g); },
    isRestricted: () => false,
    clearRestricted: () => { cleared++; },
    health: () => [],
  } as unknown as RobloxClient;
  const rolimons = { health: () => [] } as unknown as RolimonsClient;
  const adapters = { roblox: () => roblox, rolimons: () => rolimons, botList: () => ({ load: async () => new Set<number>(), asOf: '' }), valueSources: () => [] } as unknown as AdapterFactory;
  const { engine, real } = await loadEngine().catch(() => ({ engine: fallbackEngine, real: false }));
  const a = new Analyst({ repo: openRepository(':memory:'), secrets: new MemorySecretStore('x'.repeat(40)), engine, engineReal: real, adapters,
    notifier: new NullNotifier(), log: new Logger(null, false), uiUrl: 'http://127.0.0.1:47615' });
  a.account = { id: 7, name: 'me', displayName: 'Me' };
  a.cookieStatus = 'valid';
  return { a, calls, restricted, cleared: () => cleared };
}

describe('trade reads refused with 403 (account cannot trade)', () => {
  it('lists back off quietly for 30 min and mark tradesV1 restricted', async () => {
    const { a, calls, restricted } = await make();
    await expect(a.syncList('completed', 1)).resolves.toBeUndefined();
    await a.syncList('completed', 1);
    expect(calls.list).toBe(1);
    expect(restricted).toContain('tradesV1');
  });
  it('inbound count 403 does not fail the job and does not hammer the endpoint', async () => {
    const { a, calls } = await make();
    await expect(a.pollInbound()).resolves.toBeUndefined();
    await a.pollInbound();
    expect(calls.count).toBe(1);
    expect(calls.list).toBe(1); // tried the list once, then that backs off too
  });
  it('canTrade=false marks tradesV1 restricted before polling', async () => {
    const { a, restricted } = await make();
    a.repo.setKv('canTrade', { canTrade: false, tradeEligibility: 'IneligibleMissingPremiumMembership', freeTradesAllowance: null });
    await a.pollInbound();
    expect(restricted[0]).toBe('tradesV1');
  });
});

describe('becoming able to trade (e.g. bought Roblox Plus)', () => {
  it('clears the 30-min backoffs right away instead of waiting them out', async () => {
    const { a, calls, cleared } = await make();
    await a.recordCanTrade({ canTrade: false, tradeEligibility: 'IneligibleMissingPremiumMembership', freeTradesAllowance: null } as never);
    await a.pollInbound();
    await a.pollInbound();
    expect(calls.count).toBe(1);
    await a.recordCanTrade({ canTrade: true, tradeEligibility: 'Eligible', freeTradesAllowance: null } as never);
    expect(cleared()).toBe(1);
    await a.pollInbound();
    expect(calls.count).toBe(2);
  });
});

describe('limiter restriction state', () => {
  it('a 403 that triggers a restriction leaves no stale lastError; clearRestricted lifts it early', async () => {
    const { RateLimitedHttp } = await import('../adapters/limiter.js');
    let t = 1_000_000;
    const http = new RateLimitedHttp({ name: 'rb', globalMinTimeMs: 0, groups: { tradesV1: { limit: 60, windowMs: 60_000 } },
      deps: { fetch: (async () => new Response('{}', { status: 403 })) as typeof fetch, now: () => t, sleep: async () => undefined, limits: false } });
    await http.request('tradesV1', 'https://trades.roblox.com/v1/trades/inbound');
    http.markRestricted('tradesV1', 'no trading', 60_000);
    let h = http.health().find((x) => x.id === 'rb:tradesV1')!;
    expect(h).toMatchObject({ state: 'restricted', lastError: null });
    t += 120_000;
    h = http.health().find((x) => x.id === 'rb:tradesV1')!;
    expect(h.state).toBeUndefined();
    expect(h.lastError).toBeNull();
    http.markRestricted('tradesV1', 'no trading', 60_000);
    http.clearRestricted('tradesV1');
    expect(http.isRestricted('tradesV1')).toBe(false);
    await http.stop();
  });
});

describe('catalog static fields after an inventory load', () => {
  it('fills totalQuantity (rarity) right away and caches it', async () => {
    const { a, calls } = await make();
    await a.refreshInventory();
    expect(calls.catalog).toBe(1);
    expect(a.repo.getItem(1029025)).toMatchObject({ totalQuantity: 10_647, collectibleItemId: 'cid-f', creatorName: 'Roblox' });
    expect(a.valueFor(1029025).rarity).not.toBe('unknown');
    await a.refreshInventory();
    expect(calls.catalog).toBe(1); // cached
  });
});
