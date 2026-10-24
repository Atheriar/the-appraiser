/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogSearchItem, CatalogSearchOpts, MarketplaceItemStock, RateInfo, RobloxClient } from '../adapters/interfaces.js';
import { AdapterError, RateLimitError } from '../adapters/limiter.js';
import { openRepository } from '../db/index.js';
import { DEFAULT_SETTINGS, type Settings } from '../core/types.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';
import { DropsJob } from './drops.js';

const MIN = 60_000;
let NOW = Date.parse('2026-10-20T12:00:00Z');

const row = (id: number, p: Partial<CatalogSearchItem> = {}): CatalogSearchItem => ({
  assetId: id, itemType: 'Asset', name: `Item ${id}`, collectibleItemId: `cid-${id}`, itemRestrictions: ['Limited'], creatorName: 'Roblox',
  creatorId: 1, creatorType: 'User', creatorVerified: true, price: 1000, lowestResalePrice: 0, remaining: 4000, totalQuantity: 5000,
  favoriteCount: 1, offSaleDeadline: null, saleLocation: 'ShopOnly', hasResellers: false, createdAt: NOW - MIN, ...p,
});

const stockRow = (cid: string, p: Partial<MarketplaceItemStock> = {}): MarketplaceItemStock => ({
  collectibleItemId: cid, price: 1000, remaining: 100, totalQuantity: 100, sales: 0, limitPerUser: 1, lowestResalePrice: 0,
  hasResellers: false, offSaleDeadline: null, saleLocation: 'ShopOnly', ...p,
});

function make(settings: Partial<Settings['drops']> = {}) {
  const search = { roblox: [] as CatalogSearchItem[], all: [] as CatalogSearchItem[], creator: new Map<string, CatalogSearchItem[]>() };
  const stock = new Map<string, MarketplaceItemStock>();
  const calls = { search: 0, stock: [] as string[][], thumbs: 0, limits: [] as number[], opts: [] as CatalogSearchOpts[] };
  const rate: { v: RateInfo | null } = { v: null };
  let fail: Error | null = null;
  const roblox = {
    searchCollectibles: async (o: CatalogSearchOpts) => {
      calls.search++; calls.limits.push(o.limit ?? 30); calls.opts.push(o);
      if (fail) throw fail;
      if (o.creator) return search.creator.get(`${o.creator.type}:${o.creator.id}`) ?? [];
      return o.robloxOnly ? search.roblox : search.all;
    },
    searchRate: () => rate.v,
    getMarketplaceItems: async (ids: string[]) => { calls.stock.push(ids); return new Map([...stock].filter(([k]) => ids.includes(k))); },
    getThumbnails: async (ids: number[]) => { calls.thumbs++; return new Map(ids.map((i) => [i, `https://tr.rbxcdn.com/${i}.png`])); },
  } as unknown as RobloxClient;
  const repo = openRepository(':memory:');
  const s = structuredClone(DEFAULT_SETTINGS);
  Object.assign(s.drops, settings);
  const notifier = new NullNotifier();
  const job = new DropsJob({ repo, settings: () => s, roblox: () => roblox, notifier, log: new Logger(null, false), uiUrl: 'http://127.0.0.1:47615', now: () => NOW });
  return { job, repo, search, stock, calls, notifier, s, rate, setFail: (e: Error | null) => { fail = e; } };
}

describe('DropsJob', () => {
  it('first poll records silently; a later new tradable drop notifies once with the catalog link', async () => {
    const t = make();
    t.search.roblox = [row(1), row(2, { createdAt: NOW - 3 * 86_400_000 })]; // #2 is an old item being updated
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.job.list().map((d) => d.assetId)).toEqual([1]);
    expect(t.notifier.sent).toHaveLength(0);
    expect(t.job.status().state).toBe('ok');

    NOW += 10_000;
    t.stock.set('cid-3', { collectibleItemId: 'cid-3', price: 500, remaining: 99, totalQuantity: 100, sales: 1, limitPerUser: 1, lowestResalePrice: 0, hasResellers: false, offSaleDeadline: null, saleLocation: 'ShopOnly' });
    t.search.roblox = [row(3, { createdAt: NOW - 5_000, price: 500 }), row(1)];
    const fresh = await t.job.pollFeed('roblox');
    expect(fresh.map((d) => d.assetId)).toEqual([3]);
    expect(fresh[0]).toMatchObject({ tradable: true, limitPerUser: 1, remaining: 99, thumbnailUrl: 'https://tr.rbxcdn.com/3.png' });
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.notifier.sent[0]!.url).toBe('https://www.roblox.com/catalog/3');
    expect(t.notifier.sent[0]!.title).toMatch(/tradable/);
    expect(t.notifier.sent[0]!.message).toMatch(/R\$500/);
    expect(t.notifier.sent[0]!.message).toMatch(/limit 1\/user/);

    // seen again -> no duplicate alert
    await t.job.pollFeed('roblox');
    await t.job.pollFeed('all');
    t.search.all = [row(3, { createdAt: NOW - 5_000 })];
    await t.job.pollFeed('all');
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('UGC drops are labelled resale-only and respect the tradable-only notify filter', async () => {
    const t = make();
    await t.job.pollFeed('all');
    t.search.all = [row(10, { creatorId: 815206396, creatorType: 'Group', creatorName: 'FUGAZY', itemRestrictions: ['Collectible'], saleLocation: 'ExperiencesDevApiOnly' })];
    const [d] = await t.job.pollFeed('all');
    expect(d).toMatchObject({ tradable: false, inGameOnly: true });
    expect(t.notifier.sent).toHaveLength(0);
    t.s.drops.notifyTradableOnly = false;
    t.search.all = [row(11, { creatorId: 9, creatorType: 'User', itemRestrictions: ['Collectible'] })];
    await t.job.pollFeed('all');
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.notifier.sent[0]!.title).toMatch(/UGC/);
  });

  it('caps toasts per poll and summarises the rest', async () => {
    const t = make({ notifyTradableOnly: false });
    await t.job.pollFeed('roblox');
    t.search.roblox = [1, 2, 3, 4, 5].map((i) => row(100 + i));
    await t.job.pollFeed('roblox');
    expect(t.notifier.sent).toHaveLength(4);
    expect(t.notifier.sent[3]!.title).toBe('2 more new drops');
    expect(t.notifier.sent[3]!.url).toBe('http://127.0.0.1:47615/#drops');
  });

  it('stock refresh marks sold out and keeps lowest resale; paused does nothing', async () => {
    const t = make();
    t.search.roblox = [row(1)];
    await t.job.pollFeed('roblox');
    NOW += 20_000;
    t.stock.set('cid-1', { collectibleItemId: 'cid-1', price: 1000, remaining: 0, totalQuantity: 5000, sales: 5000, limitPerUser: 1, lowestResalePrice: 3200, hasResellers: true, offSaleDeadline: null, saleLocation: 'ShopOnly' });
    expect(await t.job.refreshStock()).toBe(1);
    const d = t.job.list()[0]!;
    expect(d).toMatchObject({ remaining: 0, lowestResalePrice: 3200, soldOutAt: NOW });
    // sold-out rows are refreshed at most once a minute
    NOW += 10_000;
    expect(await t.job.refreshStock()).toBe(0);
    t.s.drops.enabled = false;
    const n = t.calls.search;
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.calls.search).toBe(n);
    expect(t.job.status().state).toBe('paused');
  });

  it('a failed search shows as error status and rethrows (scheduler records it)', async () => {
    const t = make();
    t.setFail(new AdapterError('catalog search: HTTP 500', 500));
    await expect(t.job.pollFeed('roblox')).rejects.toThrow(/500/);
    expect(t.job.status()).toMatchObject({ state: 'error', lastError: expect.stringMatching(/500/) });
    t.setFail(null);
    await t.job.pollFeed('roblox');
    expect(t.job.status().state).toBe('ok');
  });

  it('a 429 pauses every catalog search until the window resets (no retry inside it), shown as rate-limited', async () => {
    const t = make();
    t.s.drops.creators = [{ id: 7, type: 'User', name: 'Seven' }];
    t.setFail(new RateLimitError('catalogSearch rate limited (429)', NOW + 40_000));
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.calls.search).toBe(1);
    expect(t.job.status()).toMatchObject({ state: 'ratelimited', rateLimitedUntil: NOW + 40_000, lastError: null });
    t.setFail(null);
    NOW += 30_000;
    await t.job.pollFeed('roblox');
    await t.job.pollFeed('all');
    await t.job.pollCreators();
    expect(t.calls.search).toBe(1); // nothing sent while limited
    NOW += 11_000;
    await t.job.pollFeed('roblox');
    expect(t.calls.search).toBe(2);
    expect(t.job.status().state).toBe('ok');
    // A plain 429 without reset info backs off a full minute.
    t.setFail(new AdapterError('rate limited (429)', 429));
    await t.job.pollFeed('all');
    expect(t.job.status().rateLimitedUntil).toBe(NOW + 60_000);
  });

  it('search budget: feeds stop at 12 / 60 s; the watchlist only uses spare budget and honours Roblox header counts', async () => {
    const t = make({ notifyTradableOnly: false });
    t.s.drops.creators = [{ id: 7, type: 'User', name: 'Seven' }, { id: 8, type: 'Group', name: 'Eight' }];
    for (let i = 0; i < 8; i++) await t.job.pollFeed('roblox');
    expect(t.job.canSearch('creator')).toBe(true);
    await t.job.pollCreators(); // 9th search: 3 stay free for the feeds
    expect(t.job.canSearch('creator')).toBe(false);
    await t.job.pollCreators();
    expect(t.calls.search).toBe(9);
    expect(t.job.status().creators).toMatchObject({ count: 2, lastName: 'Seven', next: 'Eight', skipped: 1 });
    for (let i = 0; i < 5; i++) await t.job.pollFeed('all');
    expect(t.calls.search).toBe(12);
    expect(t.job.status().searchesLastMin).toBe(12);
    NOW += 61_000;
    expect(t.job.canSearch('feed')).toBe(true);
    // Roblox's own x-ratelimit-remaining wins when it is lower (another app on the same IP).
    t.rate.v = { limit: 12, remaining: 2, resetAt: NOW + 20_000, at: NOW - 1 };
    expect(t.job.canSearch('creator')).toBe(false);
    expect(t.job.canSearch('feed')).toBe(true);
    t.rate.v = { limit: 12, remaining: 0, resetAt: NOW + 20_000, at: NOW - 1 };
    expect(t.job.canSearch('feed')).toBe(false);
  });

  it('creator watchlist: round-robin, includes not-for-sale items, silent first pass per creator, merges with the feeds', async () => {
    const t = make({ notifyTradableOnly: false });
    t.s.drops.creators = [{ id: 7, type: 'User', name: 'Seven' }, { id: 8, type: 'Group', name: 'Eight' }];
    const ugc = { creatorType: 'Group', creatorName: 'Eight', creatorId: 8, itemRestrictions: ['Collectible'] };
    t.search.creator.set('User:7', [row(70, { creatorId: 7, creatorName: 'Seven', itemRestrictions: ['Collectible'] })]);
    t.search.creator.set('Group:8', [row(80, ugc)]);
    await t.job.pollCreators();
    await t.job.pollCreators();
    expect(t.calls.opts.map((o) => [o.creator?.id, o.includeNotForSale])).toEqual([[7, true], [8, true]]);
    expect(t.notifier.sent).toHaveLength(0);
    expect(t.repo.getDrop('cid-80')).toMatchObject({ source: 'creator', watched: true, seenLive: false });
    NOW += 10_000;
    t.search.creator.set('User:7', [row(71, { creatorId: 7, creatorName: 'Seven', itemRestrictions: ['Collectible'], createdAt: NOW - 2_000 })]);
    expect((await t.job.pollCreators()).map((d) => d.assetId)).toEqual([71]);
    expect(t.repo.getDrop('cid-71')).toMatchObject({ source: 'creator', watched: true, seenLive: true });
    expect(t.notifier.sent).toHaveLength(1);
    // The same item from the global feed later is deduped (no second alert) and keeps its source.
    await t.job.pollFeed('all');
    t.search.all = [row(71, { creatorId: 7, creatorName: 'Seven', itemRestrictions: ['Collectible'] })];
    await t.job.pollFeed('all');
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.job.list().filter((d) => d.assetId === 71)).toHaveLength(1);
    expect(t.repo.getDrop('cid-71')!.source).toBe('creator');
  });

  it('timed release: not alerted while upcoming, rechecked by id around the release, alerted once on sale', async () => {
    const t = make();
    await t.job.pollFeed('roblox'); // seed
    const R = NOW + 5 * MIN;
    t.stock.set('cid-50', stockRow('cid-50', { remaining: 0, totalQuantity: 1000, saleStatus: 'pending', releaseAt: R }));
    t.search.roblox = [row(50, { createdAt: NOW - 20_000, remaining: 0, totalQuantity: 1000, offSale: true })];
    await t.job.pollFeed('roblox');
    expect(t.repo.getDrop('cid-50')).toMatchObject({ releaseAt: R, saleStatus: 'pending', soldOutAt: null, notifiedAt: null });
    expect(t.notifier.sent).toHaveLength(0);
    t.search.roblox = [row(51, { createdAt: NOW - 1_000 }), row(50, { createdAt: NOW - 20_000, remaining: 0, totalQuantity: 1000, offSale: true })];
    await t.job.pollFeed('roblox');
    expect(t.job.list().map((d) => d.key)).toEqual(['cid-50', 'cid-51']); // upcoming sorts first
    expect(t.job.status().upcoming).toBe(1);

    const posts = () => t.calls.stock.length;
    let p = posts();
    expect(await t.job.watchReleases()).toBe(1); // 5 min out: 30 s cadence
    expect(await t.job.watchReleases()).toBe(0);
    NOW += 20_000;
    expect(await t.job.watchReleases()).toBe(0);
    expect(posts()).toBe(p + 1);
    NOW = R - 3_000; // final seconds: every 2.5 s
    p = posts();
    await t.job.watchReleases();
    NOW += 1_000; await t.job.watchReleases();
    NOW += 2_000; await t.job.watchReleases();
    expect(posts()).toBe(p + 2);
    expect(t.notifier.sent.filter((x) => /50$/.test(x.url))).toHaveLength(0);
    // Roblox flips it on sale
    NOW += 2_500;
    t.stock.set('cid-50', stockRow('cid-50', { remaining: 1000, totalQuantity: 1000, saleStatus: 'onSale', releaseAt: R }));
    const before = t.notifier.sent.length;
    expect(await t.job.watchReleases()).toBe(1);
    const toast = t.notifier.sent.slice(before);
    expect(toast).toHaveLength(1);
    expect(toast[0]!.title).toMatch(/^On sale now/);
    expect(toast[0]!.url).toBe('https://www.roblox.com/catalog/50');
    expect(t.repo.getDrop('cid-50')).toMatchObject({ releasedAt: NOW, notifiedAt: NOW });
    NOW += 3_000;
    expect(await t.job.watchReleases()).toBe(0); // no longer watched
    await t.job.refreshStock();
    expect(t.notifier.sent).toHaveLength(before + 1);
  });

  it('an old off-sale row with a future scheduledRelease is probed once and kept as upcoming', async () => {
    const t = make();
    await t.job.pollFeed('roblox');
    const R = NOW + 3_600_000;
    t.stock.set('cid-60', stockRow('cid-60', { remaining: 0, saleStatus: 'offSale', releaseAt: R }));
    t.stock.set('cid-61', stockRow('cid-61', { remaining: 0, saleStatus: 'offSale', releaseAt: null }));
    const old = NOW - 5 * 86_400_000;
    t.search.roblox = [row(60, { createdAt: old, offSale: true }), row(61, { createdAt: old, offSale: true }), row(62, { createdAt: old })];
    await t.job.pollFeed('roblox');
    await t.job.pollFeed('roblox');
    expect(t.calls.stock.filter((ids) => ids.includes('cid-60'))).toHaveLength(1); // probed once
    expect(t.calls.stock.some((ids) => ids.includes('cid-62'))).toBe(false); // on sale and old: not probed
    expect(t.repo.getDrop('cid-61')).toBeNull();
    expect(t.job.list().map((d) => d.key)).toContain('cid-60');
    expect(t.repo.getDrop('cid-60')).toMatchObject({ releaseAt: R, seenLive: false });
  });

  it('a new drop that is not on sale yet (no release time) alerts only once it goes on sale', async () => {
    const t = make();
    await t.job.pollFeed('roblox');
    t.stock.set('cid-40', stockRow('cid-40', { remaining: 0, saleStatus: 'offSale' }));
    t.search.roblox = [row(40, { createdAt: NOW - 1_000, offSale: true })];
    await t.job.pollFeed('roblox');
    expect(t.notifier.sent).toHaveLength(0);
    expect(t.repo.getDrop('cid-40')!.notifiedAt).toBeNull();
    NOW += 10_000;
    t.stock.set('cid-40', stockRow('cid-40', { remaining: 100, saleStatus: 'onSale' }));
    await t.job.refreshStock();
    expect(t.notifier.sent.map((x) => x.title)).toEqual([expect.stringMatching(/^On sale now/)]);
    NOW += 10_000;
    await t.job.refreshStock();
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('records detection lag only for drops found by a live poll', async () => {
    const t = make();
    t.search.roblox = [row(1, { createdAt: NOW - 90 * MIN })];
    await t.job.pollFeed('roblox');
    expect(t.repo.getDrop('cid-1')!.seenLive).toBe(false);
    NOW += 10_000;
    t.search.roblox = [row(2, { createdAt: NOW - 95 * MIN }), row(1)];
    await t.job.pollFeed('roblox');
    const d = t.repo.getDrop('cid-2')!;
    expect(d.seenLive).toBe(true);
    expect(d.firstSeenAt - d.createdAt!).toBe(95 * MIN);
  });

  it('UGC feed can be turned off', async () => {
    const t = make({ includeUgc: false });
    await t.job.pollFeed('all');
    expect(t.calls.search).toBe(0);
  });

  it('a failed notification is retried on the next poll and only marked notified once sent', async () => {
    const t = make();
    t.search.roblox = [row(1)];
    await t.job.pollFeed('roblox');
    let failing = true;
    const orig = t.notifier.notify.bind(t.notifier);
    t.notifier.notify = async (a, b, c) => { if (failing) throw new Error('toast broke'); return orig(a, b, c); };
    NOW += 10_000;
    t.search.roblox = [row(2, { createdAt: NOW - 1000 }), row(1)];
    await t.job.pollFeed('roblox');
    expect(t.repo.getDrop('cid-2')!.notifiedAt).toBeNull();
    failing = false;
    NOW += 10_000;
    await t.job.pollFeed('roblox');
    expect(t.notifier.sent.map((x) => x.url)).toEqual(['https://www.roblox.com/catalog/2']);
    expect(t.repo.getDrop('cid-2')!.notifiedAt).toBe(NOW);
    NOW += 10_000;
    await t.job.pollFeed('roblox');
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('pausing forgets the seed: resuming records the backlog silently', async () => {
    const t = make();
    t.search.roblox = [row(1)];
    await t.job.pollFeed('roblox');
    t.s.drops.enabled = false;
    await t.job.pollFeed('roblox');
    t.s.drops.enabled = true;
    t.search.roblox = [row(2), row(3), row(4), row(5), row(1)];
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.notifier.sent).toHaveLength(0);
    t.search.roblox = [row(6, { createdAt: NOW }), ...t.search.roblox];
    expect((await t.job.pollFeed('roblox')).map((d) => d.assetId)).toEqual([6]);
  });

  it('a page with no overlap with the last poll triggers one limit=120 search', async () => {
    const t = make();
    t.search.roblox = Array.from({ length: 30 }, (_, i) => row(100 + i));
    await t.job.pollFeed('roblox');
    t.search.roblox = Array.from({ length: 30 }, (_, i) => row(200 + i));
    await t.job.pollFeed('roblox');
    expect(t.calls.limits).toEqual([30, 30, 120]);
    t.search.roblox = [row(999, { createdAt: NOW }), ...t.search.roblox.slice(0, 29)];
    await t.job.pollFeed('roblox');
    expect(t.calls.limits).toEqual([30, 30, 120, 30]);
  });

  it('a drop without createdAt is recorded as first seen now, and alerted once', async () => {
    const t = make();
    t.search.roblox = [row(1)];
    await t.job.pollFeed('roblox');
    t.search.roblox = [row(7, { createdAt: null }), row(1)];
    expect((await t.job.pollFeed('roblox')).map((d) => d.assetId)).toEqual([7]);
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.notifier.sent).toHaveLength(1);
  });

  it('a drop first seen without collectibleItemId is moved, not duplicated, when the id appears', async () => {
    const t = make();
    t.search.roblox = [row(1)];
    await t.job.pollFeed('roblox');
    t.search.roblox = [row(8, { collectibleItemId: null, createdAt: NOW }), row(1)];
    expect(await t.job.pollFeed('roblox')).toHaveLength(1);
    t.search.roblox = [row(8, { createdAt: NOW }), row(1)];
    expect(await t.job.pollFeed('roblox')).toEqual([]);
    expect(t.repo.getDrop('Asset:8')).toBeNull();
    expect(t.repo.getDrop('cid-8')).not.toBeNull();
    expect(t.job.list().filter((d) => d.assetId === 8)).toHaveLength(1);
    expect(t.notifier.sent).toHaveLength(1);
    t.search.roblox = [row(8, { collectibleItemId: null, createdAt: NOW }), row(1)];
    await t.job.pollFeed('roblox');
    expect(t.job.list().filter((d) => d.assetId === 8)).toHaveLength(1);
  });
});
