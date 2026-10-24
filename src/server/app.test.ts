/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../core/types.js';
import type { FastifyInstance } from 'fastify';
import { API_ROUTES, type TradesResponse, type TradeDetailResponse, type HealthResponse } from '../core/api-types.js';
import { openRepository } from '../db/index.js';
import { Analyst } from '../jobs/analyst.js';
import { fallbackEngine } from '../jobs/__fakes__/engine.js';
import { MemorySecretStore, redact } from '../secrets/index.js';
import { buildApp } from './app.js';
import { DEMO_ACCOUNT, seedDemo, seedDemoDrops } from './demo.js';
import type { DropsResponse, HeaderResponse, MyTradesResponse } from '../core/api-types.js';
import { loadEngine } from './loader.js';
import { Logger } from './log.js';
import { NullNotifier, isOpenableUrl } from './notify.js';

let app: FastifyInstance;
let analyst: Analyst;
const notifier = new NullNotifier();

beforeAll(async () => {
  const repo = openRepository(':memory:');
  seedDemo(repo);
  const { engine, real } = await loadEngine().catch(() => ({ engine: fallbackEngine, real: false }));
  analyst = new Analyst({ repo, secrets: new MemorySecretStore(), engine, engineReal: real, adapters: null, notifier, log: new Logger(null, false),
    uiUrl: 'http://127.0.0.1:47615', demo: { account: DEMO_ACCOUNT, rolimons: null } });
  await analyst.rescoreActive();
  app = await buildApp({ analyst, secrets: new MemorySecretStore(), log: new Logger(null, false), version: 'test', serveStatic: false });
});
afterAll(async () => { await app.close(); });

const H = { host: '127.0.0.1:47615' };

describe('REST API (demo data)', () => {
  it('registers exactly the contract routes and no trade-action routes', () => {
    const printed = app.printRoutes({ commonPrefix: false });
    for (const r of API_ROUTES) {
      const path = r.split(' ')[1]!.replace('/api/', '');
      expect(printed).toContain(path.split('/')[0]);
    }
    expect(printed).not.toMatch(/accept|counter|send|decline/i);
  });

  it('my-trades: completed ledger with summary, validated query', async () => {
    const r = (await app.inject({ url: '/api/my-trades?pageSize=25&status=all', headers: H })).json() as MyTradesResponse;
    expect(r.total).toBe(7);
    expect(r.summary.trades).toBe(7);
    expect(r.rows[0]!.partner.profileUrl).toMatch(/^https:\/\/www\.roblox\.com\/users\/\d+\/profile$/);
    expect((await app.inject({ url: '/api/my-trades?pageSize=7', headers: H })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/my-trades?from=2026-13', headers: H })).statusCode).toBe(400);
  });

  it('health + header', async () => {
    const h = (await app.inject({ url: '/api/health', headers: H })).json() as HealthResponse;
    expect(h.ok).toBe(true);
    expect(h.jobs.length).toBeGreaterThan(5);
    const hd = (await app.inject({ url: '/api/header', headers: H })).json();
    expect(hd.account.name).toBe('DemoTrader');
    expect(hd.inventoryValue).toBeGreaterThan(0);
  });

  it('lists scored inbound trades sorted by score and links to roblox.com/trades', async () => {
    const res = (await app.inject({ url: '/api/trades?direction=inbound', headers: H })).json() as TradesResponse;
    expect(res.total).toBe(11);
    const scores = res.rows.map((r) => r.score!.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(res.rows.every((r) => r.robloxUrl === 'https://www.roblox.com/trades')).toBe(true);
    const bots = res.rows.filter((r) => r.trade.partner.name.startsWith('trader_bot'));
    expect(bots.every((r) => r.score!.partner!.repeatOfferAccounts === 4)).toBe(true);
    const hidden = (await app.inject({ url: '/api/trades?direction=inbound&hideBots=true', headers: H })).json() as TradesResponse;
    expect(hidden.total).toBe(7);
  });

  it('robux math: 10,000 received counts as 7,000', async () => {
    const res = (await app.inject({ url: '/api/trades?direction=inbound', headers: H })).json() as TradesResponse;
    const r = res.rows.find((x) => x.trade.get.robux === 10_000)!;
    expect(r.score!.totals.robuxGetCounted).toBe(7_000);
  });

  it('trade detail, rescore, 404', async () => {
    const list = (await app.inject({ url: '/api/trades?direction=inbound&limit=1', headers: H })).json() as TradesResponse;
    const id = list.rows[0]!.trade.tradeId;
    const d = (await app.inject({ url: `/api/trades/${id}`, headers: H })).json() as TradeDetailResponse;
    expect(d.items.length).toBeGreaterThan(0);
    const rs = await app.inject({ method: 'POST', url: `/api/trades/${id}/rescore`, headers: H });
    expect(rs.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/trades/1', headers: H })).statusCode).toBe(404);
  });

  it('settings: deep-merge patch, reject invalid', async () => {
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { notifyThreshold: 75, poll: { completedMs: 700_000 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.notifyThreshold).toBe(75);
    expect(ok.json().settings.poll.inboundCountMs).toBe(DEFAULT_SETTINGS.poll.inboundCountMs);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { notifyThreshold: 'x' } });
    expect(bad.statusCode).toBe(400);
    const bad2 = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { poll: { inboundCountMs: 100 } } });
    expect(bad2.statusCode).toBe(400);
  });

  it('cookie status never returns the cookie; other endpoints respond', async () => {
    const c = (await app.inject({ url: '/api/cookie', headers: H })).json();
    expect(JSON.stringify(c)).not.toMatch(/WARNING:-DO-NOT-SHARE/);
    for (const u of ['/api/history', '/api/market', '/api/inventory', '/api/items/search?q=a']) {
      expect((await app.inject({ url: u, headers: H })).statusCode).toBe(200);
    }
    const inv = (await app.inject({ url: '/api/inventory', headers: H })).json();
    const item = (await app.inject({ url: `/api/items/${inv.items[0].assetId}`, headers: H }));
    expect(item.statusCode).toBe(200);
  });

  it('CSV import', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/values/csv', headers: { ...H, 'content-type': 'text/csv' }, payload: 'assetId,value\n123,4567\nbad\n' });
    expect(r.json()).toEqual({ imported: 1 });
  });

  it('rejects foreign Host headers (DNS rebinding guard)', async () => {
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example:47615' } })).statusCode).toBe(403);
  });
});

describe('redaction', () => {
  it('redacts cookie values', () => {
    const s = redact('x _|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow|_ABCDEF y .ROBLOSECURITY=abc;');
    expect(s).not.toContain('ABCDEF');
    expect(s).not.toContain('=abc');
  });
});

describe('trade eligibility + inventory', () => {
  it('notifies once per eligibility change and exposes tradeStatus in the header', async () => {
    const before = notifier.sent.length;
    const no = { canTrade: false, tradeEligibility: 'UserNeedsPremium', freeTradesAllowance: null, currencyTransferEligibility: null };
    // demo seed stored canTrade=true without a notified marker -> first false is a change
    await analyst.recordCanTrade(no);
    await analyst.recordCanTrade(no);
    await analyst.recordCanTrade(no);
    expect(notifier.sent.length).toBe(before + 1);
    expect(notifier.sent.at(-1)!.title).toMatch(/can't trade/);
    expect(notifier.sent.at(-1)!.message).toMatch(/Roblox Plus/);
    const hd = (await app.inject({ url: '/api/header', headers: H })).json();
    expect(hd.tradeStatus).toMatchObject({ canTrade: false, eligibility: 'UserNeedsPremium' });
    expect(hd.tradeStatus.reason).toMatch(/Roblox Plus/);
    // scoring still works while ineligible
    const tr = (await app.inject({ url: '/api/trades?direction=inbound', headers: H })).json() as TradesResponse;
    expect(tr.rows.every((r) => r.score !== null)).toBe(true);
    await analyst.recordCanTrade({ ...no, canTrade: true, tradeEligibility: 'Eligible' });
    await analyst.recordCanTrade({ ...no, canTrade: true, tradeEligibility: 'Eligible' });
    expect(notifier.sent.length).toBe(before + 2);
    expect(notifier.sent.at(-1)!.title).toMatch(/can trade now/);
  });

  it('inventory endpoint returns valued items with totals and state', async () => {
    const inv = (await app.inject({ url: '/api/inventory', headers: H })).json();
    expect(inv.state).toBe('ready');
    expect(inv.count).toBe(inv.items.length);
    expect(inv.count).toBeGreaterThan(0);
    expect(inv.onHoldCount).toBe(2);
    // Hold countdown: one copy from a watched trade (time left), one first seen 49 h ago (source unknown: the longer 3 d purchase length, not overdue).
    const held = inv.items.filter((i: { isOnHold: boolean }) => i.isOnHold).map((i: { hold: { startBasis: string; overdue: boolean } }) => i.hold);
    expect(held.map((h: { startBasis: string }) => h.startBasis).sort()).toEqual(['first_seen', 'trade']);
    const unknown = held.find((h: { startBasis: string }) => h.startBasis === 'first_seen');
    expect(unknown).toMatchObject({ kind: 'unknown', overdue: false, lengthIsMax: true, lengthMs: 3 * 86_400_000 });
    expect(held.find((h: { startBasis: string }) => h.startBasis === 'trade')).toMatchObject({ kind: 'trade', lengthMs: 2 * 86_400_000 });
    expect(inv.holds.length.source).toBe('assumed');
    expect(inv.holds.lengths.purchase).toMatchObject({ source: 'assumed', kind: 'purchase' });
    expect(inv.holds.nextReleaseAt).toBeGreaterThan(Date.now());
    const st = (await app.inject({ url: '/api/settings', headers: H })).json();
    expect(st.settings.hold.assumedDays).toBe(2);
    expect(st.settings.hold.assumedPurchaseDays).toBe(3);
    expect(st.hold.lengths.unknown.label).toContain('larger of the trade and purchase');
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { hold: { assumedPurchaseDays: 31 } } })).statusCode).toBe(400);
    expect(st.hold).toMatchObject({ source: 'assumed', observations: 0 });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { hold: { assumedDays: 0 } } })).statusCode).toBe(400);
    expect(inv.totalValue).toBeGreaterThan(0);
    expect(inv.items[0]).toHaveProperty('liquidationValue');
    const r = await app.inject({ method: 'POST', url: '/api/inventory/refresh', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(false); // demo never hits the network
  });
});

describe('drops API (demo data, read-only)', () => {
  it('lists seeded drops newest first with flip estimates and roblox.com catalog links only', async () => {
    seedDemoDrops(analyst.repo);
    const r = (await app.inject({ url: '/api/drops', headers: H })).json() as DropsResponse;
    expect(r.rows.length).toBe(11);
    // Upcoming (scheduled) releases first, soonest first; then newest first.
    const up = r.rows.filter((x) => x.drop.releaseAt != null && x.drop.releaseAt > r.now);
    expect(up.map((x) => x.drop.name)).toEqual(['Aurora Timekeeper Crown', 'Eclipse Wings of the Archive']);
    expect(r.rows.slice(0, 2)).toEqual(up);
    const created = r.rows.slice(2).map((x) => x.drop.createdAt!);
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    expect(r.rows.find((x) => x.drop.watched && x.drop.creatorId !== 1)?.drop.source).toBe('creator');
    expect(r.lagSamples).toBe(9);
    expect(r.lagMedianMs).toBeGreaterThan(0);
    expect(r.status).toMatchObject({ upcoming: 2, rateLimitedUntil: null });
    expect(r.rows.every((x) => /^https:\/\/www\.roblox\.com\/catalog\/\d+$/.test(x.url))).toBe(true);
    expect(r.rows.filter((x) => r.now - x.drop.createdAt! < 5 * 60_000).length).toBeGreaterThanOrEqual(2);
    const fedora = r.rows.find((x) => x.drop.name === 'Midnight Sparkle Time Fedora')!;
    expect(fedora.flip).toMatchObject({ basis: 'resale', net: 3360, profit: 2160 });
    expect(r.feePct).toBeCloseTo(0.3);
    expect(r.pollMs).toBe(20_000);
    const hd = (await app.inject({ url: '/api/header', headers: H })).json() as HeaderResponse;
    expect(hd.health.drops).toBeDefined();
  });
  it('resolves a watchlist creator (demo: offline)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/drops/creators/lookup', headers: H, payload: { query: '5150515', type: 'Group' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().creator).toMatchObject({ id: 5150515, type: 'Group' });
    const bad = await app.inject({ method: 'POST', url: '/api/drops/creators/lookup', headers: H, payload: { query: '', type: 'Team' } });
    expect(bad.statusCode).toBe(400);
  });
  it('has no buy/purchase route', () => {
    expect(app.printRoutes({ commonPrefix: false })).not.toMatch(/purchase|buy/i);
  });
  it('rejects drop poll intervals that would exceed the catalog search limit', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { robloxPollMs: 3_000 } } });
    expect(bad.statusCode).toBe(400);
    const tooFast = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { robloxPollMs: 6_000, allPollMs: 6_000 } } });
    expect(tooFast.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { enabled: false, notifyMaxPrice: 500 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.drops).toMatchObject({ enabled: false, notifyMaxPrice: 500, robloxPollMs: 20_000 });
    // Feeds together are capped at 6 / min so the creator watchlist keeps spare budget.
    const sevenPerMin = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { robloxPollMs: 12_000, allPollMs: 30_000 } } });
    expect(sevenPerMin.statusCode).toBe(400);
    const badCreator = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { creators: [{ id: -1, type: 'User', name: 'x' }] } } });
    expect(badCreator.statusCode).toBe(400);
    const creators = [{ id: 1, type: 'User', name: 'Roblox' }, { id: 4242, type: 'Group', name: 'Some Group' }];
    const okCreators = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { creators } } });
    expect(okCreators.json().settings.drops.creators).toEqual(creators);
    await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { drops: { enabled: true } } });
  });
  it('notifications may open only the local UI or an exact roblox.com catalog page', () => {
    expect(isOpenableUrl('http://127.0.0.1:47615/?trade=1')).toBe(true);
    expect(isOpenableUrl('https://www.roblox.com/catalog/1029025')).toBe(true);
    expect(isOpenableUrl('https://www.roblox.com/catalog/1029025/purchase')).toBe(false);
    expect(isOpenableUrl('https://evil.example/catalog/1')).toBe(false);
    expect(isOpenableUrl('file:///C:/x.exe')).toBe(false);
  });
});

