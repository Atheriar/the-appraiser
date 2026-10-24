/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { HttpRobloxClient } from './client.js';
import { RateLimitError } from '../limiter.js';
import { fakeFetch, fixtureResponse, respond, testDeps } from '../__tests__/fixtureFetch.js';

const mk = (routes: Parameters<typeof fakeFetch>[0]) => {
  const ff = fakeFetch(routes);
  const c = new HttpRobloxClient({ cookie: async () => 'COOKIE-VALUE-THAT-IS-LONG-ENOUGH-XXXX', deps: testDeps(ff.fetch) });
  return { c, calls: ff.calls };
};

describe('roblox client: drops feed (read-only, no cookie)', () => {
  it('parses the v2 collectibles search and never sends the cookie', async () => {
    const { c, calls } = mk([(u) => (u.pathname === '/v2/search/items/details' ? fixtureResponse('catalog_v2_search_collectibles') : undefined)]);
    const rows = await c.searchCollectibles({ robloxOnly: true });
    expect(calls[0]!.url).toContain('salesTypeFilter=2');
    expect(calls[0]!.url).toContain('sortType=3');
    expect(calls[0]!.url).toContain('creatorTargetId=1&creatorType=User');
    expect(calls[0]!.headers.cookie).toBeUndefined();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      assetId: 112536137093171, name: 'Toxic Void Crown', collectibleItemId: 'bfc74e15-3e10-4868-8aad-1d84d719b2ee',
      itemRestrictions: ['Collectible'], creatorName: 'FUGAZY', creatorType: 'Group', price: 95, remaining: 2985, totalQuantity: 3000,
      saleLocation: 'ShopAndAllExperiences', offSaleDeadline: null, createdAt: Date.parse('2026-10-19T19:05:51.449Z'),
    });
    expect(rows.filter((r) => r.saleLocation === 'ExperiencesDevApiOnly')).toHaveLength(3);
    const all = mk([(u) => (u.pathname === '/v2/search/items/details' ? fixtureResponse('catalog_v2_search_collectibles') : undefined)]);
    await all.c.searchCollectibles({ robloxOnly: false });
    expect(all.calls[0]!.url).not.toContain('creatorTargetId');
  });

  it('marketplace-items details: POST without cookie or CSRF, maps stock and per-user limit', async () => {
    const { c, calls } = mk([(u, init) => (u.pathname === '/marketplace-items/v1/items/details' && init.method === 'POST' ? fixtureResponse('marketplace_items_details') : undefined)]);
    const m = await c.getMarketplaceItems(['bfc74e15-3e10-4868-8aad-1d84d719b2ee', '43897fc0-d8b5-41e2-936a-7908211c6a29']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.cookie).toBeUndefined();
    expect(JSON.parse(calls[0]!.body!)).toEqual({ itemIds: ['bfc74e15-3e10-4868-8aad-1d84d719b2ee', '43897fc0-d8b5-41e2-936a-7908211c6a29'] });
    expect(m.get('bfc74e15-3e10-4868-8aad-1d84d719b2ee')).toMatchObject({ remaining: 2985, totalQuantity: 3000, sales: 15, limitPerUser: 0, offSaleDeadline: null, price: 95 });
    expect(m.get('43897fc0-d8b5-41e2-936a-7908211c6a29')).toMatchObject({ remaining: 0, totalQuantity: 10647, lowestResalePrice: 409886 });
  });

  it('maps productSaleStatus and scheduledRelease (3 = on sale, 2 = off sale; release in any shape)', async () => {
    const { c } = mk([(u, init) => (u.pathname === '/marketplace-items/v1/items/details' && init.method === 'POST' ? fixtureResponse('marketplace_items_details') : undefined)]);
    const m = await c.getMarketplaceItems(['bfc74e15-3e10-4868-8aad-1d84d719b2ee', '43897fc0-d8b5-41e2-936a-7908211c6a29']);
    expect(m.get('bfc74e15-3e10-4868-8aad-1d84d719b2ee')).toMatchObject({ saleStatus: 'onSale', releaseAt: null });
    expect(m.get('43897fc0-d8b5-41e2-936a-7908211c6a29')).toMatchObject({ saleStatus: 'offSale', releaseAt: null });
    const t = '2026-10-21T18:00:00Z';
    const s2 = mk([() => respond([{ collectibleItemId: 'a', productSaleStatus: 1, scheduledRelease: { releaseTime: t } }, { collectibleItemId: 'b', scheduledRelease: t }])]);
    const m2 = await s2.c.getMarketplaceItems(['a', 'b']);
    expect(m2.get('a')).toMatchObject({ saleStatus: 'pending', releaseAt: Date.parse(t) });
    expect(m2.get('b')).toMatchObject({ saleStatus: null, releaseAt: Date.parse(t) });
  });

  it('creator search adds the creator filter and includeNotForSale; records x-ratelimit headers', async () => {
    const { c, calls } = mk([() => respond({ data: [] }, 200, { 'x-ratelimit-limit': '12, 12;w=60', 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '33' })]);
    await c.searchCollectibles({ robloxOnly: false, creator: { id: 4242, type: 'Group' }, includeNotForSale: true });
    expect(calls[0]!.url).toContain('creatorTargetId=4242&creatorType=Group');
    expect(calls[0]!.url).toContain('includeNotForSale=true');
    expect(c.searchRate()).toMatchObject({ limit: 12, remaining: 7, resetAt: Date.parse('2026-10-20T12:00:00Z') + 33_000 });
  });

  it('a catalog search 429 throws RateLimitError at once with the reset time (never retried in the window)', async () => {
    const { c, calls } = mk([() => respond({ errors: [{ code: 0, message: 'Too many requests' }] }, 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '41' })]);
    const e = await c.searchCollectibles({ robloxOnly: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).resetAt).toBe(Date.parse('2026-10-20T12:00:00Z') + 41_000);
    expect(calls).toHaveLength(1);
  });

  it('looks up watchlist creators by name or id without the cookie', async () => {
    const { c, calls } = mk([
      (u, init) => (u.pathname === '/v1/usernames/users' && init.method === 'POST' ? respond({ data: [{ id: 156, name: 'builderman', requestedUsername: 'Builderman' }] }) : undefined),
      (u) => (u.pathname === '/v1/groups/search/lookup' ? respond({ data: [{ id: 99, name: 'Other' }, { id: 7, name: 'Pixel Forge' }] }) : undefined),
      (u) => (u.pathname === '/v1/groups/7' ? respond({ id: 7, name: 'Pixel Forge' }) : undefined),
      (u) => (u.pathname === '/v1/groups/8' ? respond({ errors: [] }, 400) : undefined),
    ]);
    expect(await c.lookupCreator('Builderman', 'User')).toEqual({ id: 156, type: 'User', name: 'builderman' });
    expect(await c.lookupCreator('pixel forge', 'Group')).toEqual({ id: 7, type: 'Group', name: 'Pixel Forge' });
    expect(await c.lookupCreator('7', 'Group')).toEqual({ id: 7, type: 'Group', name: 'Pixel Forge' });
    expect(await c.lookupCreator('8', 'Group')).toBeNull();
    expect(calls.every((x) => x.headers.cookie === undefined)).toBe(true);
  });

  it('chunks marketplace-items requests by 30 ids', async () => {
    const { c, calls } = mk([() => respond([])]);
    await c.getMarketplaceItems(Array.from({ length: 65 }, (_, i) => `id-${i}`));
    expect(calls.map((x) => JSON.parse(x.body!).itemIds.length)).toEqual([30, 30, 5]);
  });
});

describe('roblox client: v1 trade details refused (cannot trade)', () => {
  const v2 = { tradeId: 55, status: 'Open', participantAOffer: { user: { id: 1, name: 'me' }, items: [], robux: 0 }, participantBOffer: { user: { id: 9, name: 'p' }, items: [], robux: 0 } };
  it('uses v2, marks tradesV1 restricted (neutral) and skips v1 afterwards', async () => {
    const { c, calls } = mk([
      (u) => (u.pathname === '/v1/trades/55' ? respond({ errors: [{ code: 0, message: 'Forbidden' }] }, 403) : undefined),
      (u) => (u.pathname === '/v2/trades/55' ? respond(v2) : undefined),
    ]);
    const snap = await c.getTradeDetail(55, 1, 'inbound');
    expect(snap.hadV2).toBe(true);
    expect(c.isRestricted('tradesV1:detail')).toBe(true);
    const h = c.health().find((x) => x.id === 'roblox:tradesV1')!;
    expect(h).toMatchObject({ ok: true, state: 'restricted' });
    expect(h.note).toMatch(/cannot trade/);
    const before = calls.length;
    await c.getTradeDetail(55, 1, 'inbound');
    expect(calls.slice(before).map((x) => new URL(x.url).pathname)).toEqual(['/v2/trades/55']);
  });
});
