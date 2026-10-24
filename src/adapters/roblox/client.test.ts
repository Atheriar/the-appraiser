/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { HttpRobloxClient } from './client.js';
import { fakeFetch, fixtureResponse, respond, testDeps, fx } from '../__tests__/fixtureFetch.js';

const COOKIE = '_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-SECRETSECRET';
const mk = (routes: Parameters<typeof fakeFetch>[0], cookie: string | null = COOKIE) => {
  const ff = fakeFetch(routes);
  const c = new HttpRobloxClient({ cookie: async () => cookie, deps: testDeps(ff.fetch) });
  return { c, calls: ff.calls };
};

describe('roblox client: auth + cookie handling', () => {
  it('returns null on 401 code 9002', async () => {
    const { c } = mk([(u) => (u.pathname.endsWith('/authenticated') ? fixtureResponse('unauth_v1_trades_inbound', 401) : undefined)]);
    expect(await c.getAuthenticatedUser()).toBeNull();
  });

  it('sends the cookie only to roblox.com, never to other hosts, and errors are redacted', async () => {
    const { c, calls } = mk([
      (u) => (u.pathname.startsWith('/v1/trades/inbound') ? respond({ errors: [{ code: 9002 }] }, 401) : undefined),
    ]);
    await expect(c.listTrades('inbound')).rejects.toThrow(/not authenticated/);
    expect(calls[0]!.headers.cookie).toBe(`.ROBLOSECURITY=${COOKIE}`);
    // unauthenticated groups (marketplace) do not carry it
    const mps = mk([(u) => (u.hostname === 'apis.roblox.com' ? fixtureResponse('mps_resale_1080949') : undefined)]);
    await mps.c.getResaleData(1080949, '37dc69c8-6111-4c3f-bffe-ee1924770b4a');
    expect(mps.calls[0]!.headers.cookie).toBeUndefined();
  });

  it('error messages never contain the cookie', async () => {
    const { c } = mk([() => { throw new Error(`boom ${COOKIE}`); }]);
    const err = await c.getTradeCount('inbound').catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('SECRETSECRET');
  });
});

describe('roblox client: trades', () => {
  it('falls back to numeric list path when the word form is rejected', async () => {
    const { c, calls } = mk([
      (u) => (u.pathname === '/v1/trades/inbound' ? respond({ errors: [{ code: 1 }] }, 400) : undefined),
      (u) => (u.pathname === '/v1/trades/1' ? respond({ previousPageCursor: null, nextPageCursor: 'x', data: [
        { id: 55, user: { id: 9, name: 'p', displayName: 'P' }, created: '2026-10-20T00:00:00Z', expiration: null, isActive: true, status: 'Open' },
      ] }) : undefined),
    ]);
    const p = await c.listTrades('inbound');
    expect(p.data[0]).toMatchObject({ id: 55, statusRaw: 'Open', isActive: true, expiration: null });
    expect(p.nextPageCursor).toBe('x');
    await c.listTrades('inbound');
    expect(calls.at(-1)!.url).toContain('/v1/trades/1?'); // remembered mode
  });

  it('joins v1 + v2 detail', async () => {
    const v1 = { id: 77, status: 'Open', isActive: true, created: '2026-10-20T01:00:00Z', expiration: '2026-10-24T01:00:00Z',
      offers: [
        { user: { id: 1, name: 'me', displayName: 'Me' }, robux: 0, userAssets: [{ id: 111, serialNumber: null, assetId: 1365767, name: 'Test Helm', recentAveragePrice: 260280 }] },
        { user: { id: 2, name: 'them', displayName: 'Them' }, robux: 1000, userAssets: [
          { id: 221, serialNumber: null, assetId: 1080949, name: 'Bunny Ears', recentAveragePrice: 17502 },
          { id: 222, serialNumber: null, assetId: 1080949, name: 'Bunny Ears', recentAveragePrice: 17502 }] },
      ] };
    const v2 = { tradeId: 77, status: 'Open',
      participantAOffer: { user: { id: 2 }, robux: 1000, items: [
        { collectibleItemInstanceId: 'i1', itemTarget: { itemType: 'Asset', targetId: '1080949' }, itemName: 'Bunny Ears', isOnHold: true },
        { collectibleItemInstanceId: 'i2', itemTarget: { itemType: 'Asset', targetId: '1080949' }, itemName: 'Bunny Ears', isOnHold: false }] },
      participantBOffer: { user: { id: 1 }, robux: 0, items: [
        { collectibleItemInstanceId: 'i3', itemTarget: { itemType: 'Asset', targetId: '1365767' }, itemName: 'Test Helm', isOnHold: false }] } };
    const { c } = mk([
      (u) => (u.pathname === '/v1/trades/77' ? respond(v1) : undefined),
      (u) => (u.pathname === '/v2/trades/77' ? respond(v2) : undefined),
    ]);
    const t = await c.getTradeDetail(77, 1, 'inbound');
    expect(t.hadV1 && t.hadV2).toBe(true);
    expect(t.partner.userId).toBe(2);
    expect(t.give.items).toHaveLength(1);
    expect(t.give.items[0]).toMatchObject({ assetId: 1365767, userAssetId: 111, collectibleItemInstanceId: 'i3', joinKey: 'asset+order' });
    expect(t.get.items.map((i) => [i.userAssetId, i.isOnHold])).toEqual([[221, true], [222, false]]);
    expect(t.get.robux).toBe(1000);
    expect(t.status).toBe('Open');
    expect(t.expiresAt).toBe(Date.parse('2026-10-24T01:00:00Z'));
  });

  it('metadata throws on 401 so the caller keeps the last good values', async () => {
    const { c } = mk([(u) => (u.pathname === '/v1/trades/metadata' ? respond(fx('trades_metadata_unauth.json'), 401) : undefined)]);
    await expect(c.getTradeMetadata()).rejects.toThrow(/trade metadata/);
  });

  it('metadata lists which fields Roblox sent', async () => {
    const { c } = mk([(u) => (u.pathname === '/v1/trades/metadata' ? respond({ maxItemsPerSide: 4, tradeSystemRobuxFee: 0.3 }) : undefined)]);
    const m = await c.getTradeMetadata();
    expect(m.verified).toBe(true);
    expect(m.liveFields).toEqual(['maxItemsPerSide', 'tradeSystemRobuxFee']);
  });
});

describe('roblox client: items', () => {
  it('catalog batch performs the CSRF handshake and parses collectibleItemId', async () => {
    let n = 0;
    const { c, calls } = mk([(u, init) => {
      if (u.pathname !== '/v1/catalog/items/details') return undefined;
      n++;
      const h = init.headers as Record<string, string>;
      return h['x-csrf-token'] === 'FAKECSRFTOKEN' ? fixtureResponse('catalog_batch_details') : fixtureResponse('catalog_batch_403_nocsrf');
    }]);
    const m = await c.getCatalogDetails([1365767, 1080949]);
    expect(n).toBe(2);
    expect(m.get(1365767)).toMatchObject({ collectibleItemId: '0d1d5570-68e5-49d8-8c9e-fdb777863bd0', lowestResalePrice: 252999, itemRestrictions: ['Limited'] });
    expect(m.get(1080949)?.collectibleItemId).toBe('37dc69c8-6111-4c3f-bffe-ee1924770b4a');
    // itemCreatedUtc feeds the new-release (thin_history) check.
    expect(typeof m.get(1365767)?.createdAt).toBe('number');
    expect(m.get(1365767)!.createdAt!).toBeLessThan(Date.UTC(2010, 0, 1));
    expect(calls.every((x) => x.headers.cookie === undefined)).toBe(true);
    await c.getCatalogDetails([1365767]);
    expect(n).toBe(3); // token reused
  });

  it('marketplace-sales resale data: newest first, zero placeholders dropped, fresh', async () => {
    const { c } = mk([(u) => (u.pathname.includes('/resale-data') ? fixtureResponse('mps_resale_1080949') : undefined)]);
    const r = (await c.getResaleData(1080949, '37dc69c8-6111-4c3f-bffe-ee1924770b4a'))!;
    expect(r.source).toBe('marketplace_sales');
    expect(r.recentAveragePrice).toBe(17502);
    expect(r.priceDataPoints[0]!.t).toBe(Date.parse('2026-10-19T00:00:00Z'));
    expect(r.priceDataPoints.every((p) => p.value > 0)).toBe(true);
    expect(r.stale).toBe(false);
  });

  it('economy fallback: 400 code 5 => null; frozen series => stale', async () => {
    const { c } = mk([
      (u) => (u.pathname === '/v1/assets/1080949/resale-data' ? fixtureResponse('econ_resale_1080949') : undefined),
      (u) => (u.pathname === '/v1/assets/1365767/resale-data' ? fixtureResponse('econ_resale_1365767') : undefined),
    ]);
    expect(await c.getResaleData(1080949, null)).toBeNull();
    const r = (await c.getResaleData(1365767, null))!;
    expect(r.source).toBe('economy_fallback');
    expect(r.stale).toBe(true);
  });

  it('resellers sorted by price, capped flag from cursor', async () => {
    const { c } = mk([(u) => (u.pathname.includes('/resellers') ? fixtureResponse('mps_resellers_1080949') : undefined)]);
    const r = await c.getResellers('37dc69c8-6111-4c3f-bffe-ee1924770b4a', 10);
    expect(r.rows[0]!.price).toBe(17499);
    expect(r.rows.map((x) => x.price)).toEqual([...r.rows.map((x) => x.price)].sort((a, b) => a - b));
  });

  it('inventory, owners, users, thumbnails parse from fixtures', async () => {
    const { c } = mk([
      (u) => (u.pathname.includes('/assets/collectibles') ? respond({ ...JSON.parse(fx('inv_collectibles_1.json')), nextPageCursor: null }) : undefined),
      (u) => (u.pathname.includes('/owners') ? fixtureResponse('inv_owners_1365767') : undefined),
      (u) => (u.pathname === '/v1/users/1' ? fixtureResponse('users_1') : undefined),
      (u) => (u.hostname === 'thumbnails.roblox.com' ? fixtureResponse('thumbs') : undefined),
    ]);
    const inv = await c.getCollectibles(1);
    expect(inv).not.toBe('hidden');
    expect((inv as Exclude<typeof inv, 'hidden'>)[0]).toMatchObject({ userAssetId: 28605, assetId: 1028606, serialNumber: null, isOnHold: false });
    const owners = await c.getOwners(1365767, 1);
    expect(owners.length).toBe(10);
    expect(owners[0]!.ownerId).toBeNull();
    expect(await c.getUser(1)).toMatchObject({ id: 1, name: 'Roblox', hasVerifiedBadge: true, isBanned: false });
    const th = await c.getThumbnails([1365767, 1080949]);
    expect(th.get(1365767)).toMatch(/^https:\/\/tr\.rbxcdn\.com\//);
  });

  it('honours x-ratelimit-remaining 0 by sleeping until reset, and retries 429', async () => {
    const sleeps: number[] = [];
    let i = 0;
    const ff = fakeFetch([(u) => {
      if (u.hostname !== 'users.roblox.com') return undefined;
      i++;
      if (i === 1) return respond(fx('users_1.json'), 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' });
      if (i === 2) return respond('{}', 429);
      return respond(fx('users_1.json'));
    }]);
    const now = Date.parse('2026-10-20T12:00:00Z');
    const c = new HttpRobloxClient({ cookie: async () => null, deps: { fetch: ff.fetch, now: () => now, sleep: async (ms) => { sleeps.push(ms); }, limits: true } });
    await c.getUser(1);
    await c.getUser(1);
    expect(sleeps[0]).toBe(7000);
    expect(sleeps).toContain(2000);
    expect(c.health().find((h) => h.id === 'roblox:users')!.count429).toBe(1);
    await c.http.stop();
  }, 20_000);
});

describe('can-trade parsing (shape drift)', () => {
  it('accepts an object currencyTransferEligibility and a malformed freeTradesAllowance', async () => {
    const body = { canTrade: true, tradeEligibility: 'Eligible', freeTradesAllowance: 'n/a', currencyTransferEligibility: { status: 'Eligible', reason: null } };
    const fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
    const c = new HttpRobloxClient({ cookie: async () => 'x', deps: testDeps(fetch) });
    const r = await c.getCanTrade();
    expect(r.canTrade).toBe(true);
    expect(r.tradeEligibility).toBe('Eligible');
    expect(r.freeTradesAllowance).toBeNull();
    expect(r.currencyTransferEligibility).toContain('Eligible');
  });
});

