/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { HttpRolimonsClient, reconstructSalePrice } from './client.js';
import { fakeFetch, fixtureResponse, testDeps, fx } from '../__tests__/fixtureFetch.js';
import { RolimonsValueSource, estimateFromResale } from '../valueSources.js';
import { parseBotList } from '../botlist.js';
import { HttpRobloxClient } from '../roblox/client.js';

const routes = [
  (u: URL) => (u.pathname === '/items/v2/itemdetails' ? fixtureResponse('rolimons_items_v2_itemdetails') : undefined),
  (u: URL) => (u.pathname === '/market/v1/saleactivity' ? fixtureResponse('rolimons_market_v1_saleactivity') : undefined),
  (u: URL) => (u.pathname === '/market/v1/dealactivity' ? fixtureResponse('rolimons_market_v1_dealactivity') : undefined),
  (u: URL) => (u.pathname === '/tradeads/v1/getrecentads' ? fixtureResponse('rolimons_tradeads_v1_getrecentads') : undefined),
];

describe('rolimons client', () => {
  it('parses itemdetails with the corrected index map and caches 60s', async () => {
    let t = 0;
    const ff = fakeFetch(routes);
    const c = new HttpRolimonsClient({ deps: testDeps(ff.fetch, () => t) });
    const m = await c.getItemDetails();
    expect(m.size).toBe(2573);
    expect(m.get(1365767)).toMatchObject({ rap: 260280, value: 280000, demand: 4, trend: 2, projected: false, rare: false });
    expect(m.get(1028606)).toMatchObject({ value: null, demand: -1, acronym: null });
    expect(m.get(1279018)?.projected).toBe(true);
    expect(m.get(21070012)?.rare).toBe(true);
    await c.getItemDetails();
    expect(ff.calls).toHaveLength(1);
    t = 61_000;
    await c.getItemDetails();
    expect(ff.calls).toHaveLength(2);
  });

  it('reconstructs sales from RAP deltas', async () => {
    expect(reconstructSalePrice(2995, 3015)).toBe(3195);
    expect(reconstructSalePrice(0, 500)).toBe(500);
    const c = new HttpRolimonsClient({ deps: testDeps(fakeFetch(routes).fetch) });
    const s = await c.getSaleActivity();
    expect(s).toHaveLength(3);
    const x = s.find((r) => r.assetId === 13241836994)!;
    expect(x).toMatchObject({ price: 3195, oldRap: 2995, newRap: 3015, source: 'rolimons_feed', saleId: '8707348', t: 1792493650000 });
  });

  it('parses deal activity kinds and trade ads', async () => {
    const c = new HttpRolimonsClient({ deps: testDeps(fakeFetch(routes).fetch) });
    const d = await c.getDealActivity();
    expect(d.filter((x) => x.kind === 'rap')).toHaveLength(3);
    const ads = await c.getRecentTradeAds();
    expect(ads.length).toBeGreaterThan(100);
    const a = ads.find((x) => x.adId === 500252)!;
    expect(a).toMatchObject({ offerRobux: 1692, requestAssetIds: [292970740] });
    expect(a.offerAssetIds).toHaveLength(4);
  });

  it('RolimonsValueSource maps -1 to null and survives failures', async () => {
    const ff = fakeFetch(routes);
    const src = new RolimonsValueSource(new HttpRolimonsClient({ deps: testDeps(ff.fetch) }));
    await src.refresh();
    expect(src.get(1365767)).toMatchObject({ value: 280000, demand: 4 });
    expect(src.get(1028606)).toMatchObject({ value: null, demand: null, trend: null });
    const broken = new RolimonsValueSource({ getItemDetails: async () => { throw new Error('down'); } } as never);
    await expect(broken.refresh()).resolves.toBeUndefined();
    expect(broken.health()).toMatchObject({ ok: false, lastError: 'down' });
  });
});

describe('first-party estimate', () => {
  it('produces a value close to RAP for Bunny Ears with demand + trend', async () => {
    const ff = fakeFetch([(u) => (u.pathname.includes('/resale-data') ? fixtureResponse('mps_resale_1080949') : undefined)]);
    const now = Date.parse('2026-10-20T12:00:00Z');
    const rc = new HttpRobloxClient({ cookie: async () => null, deps: testDeps(ff.fetch, () => now) });
    const r = (await rc.getResaleData(1080949, 'cid'))!;
    const v = estimateFromResale(1080949, r, now);
    expect(v.value!).toBeGreaterThan(15000);
    expect(v.value!).toBeLessThan(21000);
    expect(v.demand).not.toBeNull();
    expect(v.trend).not.toBeNull();
    expect(v.projected).toBe(false);
  });
});

describe('bot list', () => {
  it('parses the gist file, skipping placeholder id 0', () => {
    const s = parseBotList(fx('botdefender_RobloxTradeBotters.txt'));
    expect(s.has(0)).toBe(false);
    expect(s.has(9000000001)).toBe(true);
    expect(s.size).toBe(8);
  });
});
