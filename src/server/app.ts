/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Fastify app: REST API per src/core/api-types.ts + static web build.
 * There are deliberately NO routes that accept, decline, counter or send a trade.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  ROBLOX_TRADES_URL,
  type CookieStatusResponse, type HeaderResponse, type HealthResponse, type HistoryResponse, type HistoryRow,
  type DropsResponse, type InventoryResponse, type ItemDetailResponse, type ItemSearchResponse, type MarketResponse, type MyTradesResponse, type SettingsResponse,
  type TradeDetailResponse, type TradeRow, type TradesResponse,
} from '../core/api-types.js';
import { DEFAULT_SETTINGS, type Settings, type TradeDirection, type TradeShape, type TradeSnapshot, type ValuedItem, type Verdict } from '../core/types.js';
import { checkShape, deepMerge } from '../db/merge.js';
import { catalogUrl, detectionLagMs, flipEstimate, median } from '../core/drops.js';
import { FEED_MAX_PER_MIN, feedIntervals } from '../jobs/drops.js';
import type { Analyst } from '../jobs/analyst.js';
import { queryMyTrades } from '../jobs/myTrades.js';
import { errMsg, type Logger } from './log.js';
import { webDist } from './paths.js';
import type { SecretStore } from '../secrets/interfaces.js';

const DAY = 86_400_000;

export interface AppDeps { analyst: Analyst; secrets: SecretStore; log: Logger; version: string; serveStatic?: boolean }

const TradesQ = z.object({
  direction: z.enum(['inbound', 'completed', 'inactive']).default('inbound'),
  minScore: z.coerce.number().min(0).max(100).optional(),
  hideBots: z.enum(['true', 'false', '1', '0']).optional(),
  shape: z.enum(['UPGRADE', 'DOWNGRADE', 'EVEN']).optional(),
  watchlistOnly: z.enum(['true', 'false', '1', '0']).optional(),
  verdict: z.enum(['Accept', 'Lean accept', 'Counter', 'Decline']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().regex(/^\d+$/).optional(),
});
const PageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().regex(/^\d+$/).optional() });
const IdParam = z.object({ id: z.coerce.number().int().positive() });
const AssetParam = z.object({ assetId: z.coerce.number().int().positive() });
const UserParam = z.object({ userId: z.coerce.number().int().positive() });
const CookieBody = z.object({ cookie: z.string().min(20).max(8192) });
const truthy = (v: string | undefined) => v === 'true' || v === '1';

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const { analyst: a, log } = d;
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });

  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : err instanceof z.ZodError ? 400 : 500;
    if (status >= 500) log.error('request failed', err);
    void reply.status(status).send({ error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : errMsg(err) });
  });

  // Defence in depth: only accept requests addressed to the loopback host (DNS-rebinding guard).
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) return reply.status(403).send({ error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return reply.status(403).send({ error: 'forbidden origin' });
  });

  const account = () => (a.account ? { userId: a.account.id, name: a.account.name, displayName: a.account.displayName } : null);

  const valuedInventory = (): ValuedItem[] =>
    (a.inventory()?.items ?? []).map((i) => a.valueFor(i.assetId, undefined, { serial: i.serialNumber, isOnHold: i.isOnHold }));

  const row = (t: TradeSnapshot): TradeRow => ({ trade: t, score: a.repo.latestScore(t.tradeId), robloxUrl: ROBLOX_TRADES_URL });

  const cookieStatus = async (): Promise<CookieStatusResponse> => ({
    status: a.cookieStatus, account: account(), masked: a.demo ? 'demo (no cookie)' : await d.secrets.masked(), checkedAt: a.cookieCheckedAt,
  });

  // ---------------------------------------------------------------- health/header
  const health = async (): Promise<HealthResponse> => ({
    ok: true, version: d.version, startedAt: a.startedAt, cookie: a.cookieStatus, account: account(), lastPollAt: a.lastPollAt,
    snapshotCount: a.repo.countItemSnapshots(), sources: a.sources(),
    jobs: a.scheduler.statuses().map(({ running: _r, ...j }) => j),
  });
  app.get('/api/health', health);
  app.get('/health', health);

  app.get('/api/header', async (): Promise<HeaderResponse> => {
    const inv = valuedInventory();
    const canTrade = a.repo.getKv<{ canTrade: boolean; freeTradesAllowance: HeaderResponse['freeTrades'] }>('canTrade');
    const src = a.sources();
    const dst = a.drops.status();
    return {
      account: account(),
      inventoryValue: inv.length ? inv.reduce((s, v) => s + v.tradeValue, 0) : null,
      inventoryRap: inv.length ? inv.reduce((s, v) => s + v.rap, 0) : null,
      inventoryLiquidationValue: inv.length ? inv.reduce((s, v) => s + v.liquidationValue, 0) : null,
      freeTrades: canTrade?.freeTradesAllowance ?? null, canTrade: canTrade?.canTrade ?? null, tradeStatus: a.tradeStatus(),
      tradeMetadata: a.metadata(), lastPollAt: a.lastPollAt ?? (a.demo ? a.startedAt : null),
      health: {
        roblox: a.demo || (a.cookieStatus === 'valid' && src.filter((s) => s.id.startsWith('roblox')).every((s) => s.ok || s.lastSuccessAt == null)),
        rolimons: a.demo || (a.roli.size > 0 && src.filter((s) => s.id.startsWith('rolimons')).every((s) => s.ok || s.lastSuccessAt == null)),
        snapshotCount: a.repo.countItemSnapshots(),
        drops: dst.state,
        dropsResumeAt: dst.rateLimitedUntil,
        restricted: src.filter((x) => x.state === 'restricted').map((x) => x.id),
      },
    };
  });

  // ---------------------------------------------------------------- drops (read-only; no buy route exists)
  app.get('/api/drops', async (req): Promise<DropsResponse> => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(300) }).parse(req.query);
    const now = Date.now();
    const s = a.settings();
    const fee = s.valuation.marketplaceFeePct;
    const st = a.drops.status();
    // "Include UGC" off hides UGC drops already stored too, not just future ones.
    const drops = a.drops.list(limit).filter((d) => s.drops.includeUgc || d.tradable);
    const lags = drops.map(detectionLagMs).filter((x): x is number => x != null);
    const iv = feedIntervals(s.drops);
    return {
      rows: drops.map((drop) => {
        const r = a.roli.get(drop.assetId);
        const ref = { roliValue: r?.value ?? null, rap: r && r.rap > 0 ? r.rap : null };
        return { drop, flip: flipEstimate(drop, ref, fee, now), url: catalogUrl(drop.assetId, drop.itemType), roliValue: ref.roliValue, rap: ref.rap };
      }),
      status: {
        state: st.state, lastPollAt: st.lastPollAt, lastError: st.lastError, tracked: st.tracked, rateLimitedUntil: st.rateLimitedUntil,
        searchesLastMin: st.searchesLastMin, searchRemaining: st.searchRemaining, creators: st.creators, upcoming: st.upcoming,
      },
      now, feePct: fee, pollMs: Math.min(iv.roblox, s.drops.includeUgc ? iv.all : Infinity),
      lagMedianMs: median(lags), lagSamples: lags.length,
    };
  });

  /** Resolve a creator for the drops watchlist (read-only users / groups lookup). */
  app.post('/api/drops/creators/lookup', async (req, reply) => {
    const b = z.object({ query: z.string().trim().min(1).max(60), type: z.enum(['User', 'Group']) }).parse(req.body ?? {});
    if (a.demo) {
      const id = /^\d+$/.test(b.query) ? Number(b.query) : 7_000_000 + [...b.query].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 0);
      return { creator: { id, type: b.type, name: /^\d+$/.test(b.query) ? `${b.type} ${id}` : b.query } };
    }
    const r = a.roblox;
    if (!r?.lookupCreator) return reply.status(503).send({ error: 'Roblox client unavailable', code: 'no_client' });
    try {
      return { creator: await r.lookupCreator(b.query, b.type) };
    } catch (e) {
      return reply.status(502).send({ error: `Lookup failed: ${errMsg(e)}`, code: 'lookup_failed' });
    }
  });

  // ---------------------------------------------------------------- trades
  app.get('/api/trades', async (req): Promise<TradesResponse> => {
    const q = TradesQ.parse(req.query);
    const s = a.settings();
    const watch = new Set([...s.watchlist, ...s.wishlist]);
    const trades = a.repo.listTrades({ direction: q.direction as TradeDirection, limit: 1000, offset: 0 });
    for (const t of trades) if (!a.repo.latestScore(t.tradeId)) await a.scoreTrade(t.tradeId, { notify: false });
    let rows = trades.map(row);
    if (q.minScore != null) rows = rows.filter((r) => (r.score?.score ?? -1) >= q.minScore!);
    if (truthy(q.hideBots)) rows = rows.filter((r) => !r.score?.partner?.flags.some((f) => f === 'bot_list' || f === 'repeat_offer'));
    if (q.shape) rows = rows.filter((r) => r.score?.shape === (q.shape as TradeShape));
    if (q.verdict) rows = rows.filter((r) => r.score?.verdict === (q.verdict as Verdict));
    if (truthy(q.watchlistOnly)) rows = rows.filter((r) => [...r.trade.give.items, ...r.trade.get.items].some((i) => watch.has(i.assetId)));
    if (q.direction === 'inbound') rows.sort((x, y) => (y.score?.score ?? -1) - (x.score?.score ?? -1));
    else rows.sort((x, y) => y.trade.createdAt - x.trade.createdAt);
    const off = Number(q.cursor ?? 0);
    const page = rows.slice(off, off + q.limit);
    return { rows: page, nextCursor: off + q.limit < rows.length ? String(off + q.limit) : null, total: rows.length };
  });

  app.get('/api/trades/:id', async (req, reply): Promise<TradeDetailResponse | void> => {
    const { id } = IdParam.parse(req.params);
    const t = a.repo.getTrade(id);
    if (!t) return notFound(reply, 'trade not found');
    let r = row(t);
    if (!r.score) { await a.scoreTrade(id, { notify: false }); r = row(t); }
    const since = Date.now() - 30 * DAY;
    const holdOf = a.holdLookup();
    const items = [...t.give.items, ...t.get.items].map((it) => {
      const fromScore = [...(r.score?.give ?? []), ...(r.score?.get ?? [])].find((v) => v.assetId === it.assetId && (v.serial ?? null) === (it.serialNumber ?? null));
      return {
        valued: fromScore ?? a.valueFor(it.assetId, it, { serial: it.serialNumber }),
        snapshot: a.snapshotFor(it.assetId, it),
        recentSales: a.repo.salesFor(it.assetId, since).slice(0, 50),
        hold: holdOf(it.assetId, it.serialNumber),
      };
    });
    return { row: r, items, scoreHistory: a.repo.scoreHistory(id).map((h) => ({ score: h.score, verdict: h.verdict, scoredAt: h.scoredAt })),
      partnerInventory: a.partnerInv.status(t.partner.userId) };
  });

  app.post('/api/trades/:id/rescore', async (req, reply): Promise<TradeRow | void> => {
    const { id } = IdParam.parse(req.params);
    const t = a.repo.getTrade(id);
    if (!t) return notFound(reply, 'trade not found');
    await a.scoreTrade(id, { notify: false, force: true }); // LOCAL recompute only
    return row(a.repo.getTrade(id)!);
  });

  app.post('/api/poll', async () => {
    void a.pollNow().catch((e) => log.warn('manual poll failed', e));
    return { queued: true as const };
  });

  // ---------------------------------------------------------------- history
  app.get('/api/history', async (req): Promise<HistoryResponse> => {
    const q = PageQ.parse(req.query);
    const off = Number(q.cursor ?? 0);
    const decided = a.repo.listDecided(q.limit + 1, off);
    const rows: HistoryRow[] = decided.slice(0, q.limit).map((t) => {
      const at = a.repo.decidedAt(t.tradeId) ?? t.fetchedAt;
      const scoreAtTime = a.repo.scoreAtOrBefore(t.tradeId, at) ?? a.repo.latestScore(t.tradeId);
      let nowTotals: { rawGain: number; rapGain: number } | null = null;
      try { nowTotals = a.computeScore(t).totals; } catch { nowTotals = null; }
      return {
        trade: t, scoreAtTime, finalStatus: t.status,
        valueGainAtTime: scoreAtTime?.totals.rawGain ?? null, valueGainNow: nowTotals?.rawGain ?? null,
        rapGainAtTime: scoreAtTime?.totals.rapGain ?? null, rapGainNow: nowTotals?.rapGain ?? null,
      };
    });
    return { rows, nextCursor: decided.length > q.limit ? String(off + q.limit) : null, accuracy: a.repo.latestModelRun() };
  });

  // ---------------------------------------------------------------- my trades (completed ledger; local recompute only)
  app.get('/api/my-trades', async (req): Promise<MyTradesResponse> => {
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const q = z.object({
      status: z.enum(['all', 'won', 'lost']).default('all'),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
      pageSize: z.coerce.number().int().refine((n) => [25, 50, 100].includes(n), 'pageSize: 25, 50 or 100').default(25),
      q: z.string().max(100).optional(), from: day, to: day,
    }).parse(req.query);
    // Dates are local calendar days, inclusive.
    const from = q.from ? new Date(`${q.from}T00:00:00`).getTime() : undefined;
    const to = q.to ? new Date(`${q.to}T23:59:59.999`).getTime() : undefined;
    return queryMyTrades(a, { status: q.status, page: q.page, pageSize: q.pageSize, q: q.q, from, to });
  });

  // ---------------------------------------------------------------- learning (local recompute only)
  app.get('/api/learning', async () => ({ accuracy: a.repo.latestModelRun() }));
  app.post('/api/learning/run', async () => {
    await a.computeOutcomes();
    return { accuracy: a.repo.latestModelRun() };
  });

  // ---------------------------------------------------------------- market / items
  app.get('/api/market', async (): Promise<MarketResponse> => {
    const s = a.settings();
    const now = Date.now();
    const watch = [...new Set([...s.watchlist, ...s.wishlist])].map((id) => a.valueFor(id));
    const movers: MarketResponse['inventoryMovers'] = [];
    const seen = new Set<number>();
    for (const i of a.inventory()?.items ?? []) {
      if (seen.has(i.assetId)) continue;
      seen.add(i.assetId);
      const cur = a.valueFor(i.assetId);
      const old = a.repo.itemSnapshotAtOrBefore(i.assetId, now - DAY);
      if (!old) continue;
      const before = a.engine.valueItem(old, s, now - DAY).tradeValue;
      if (before > 0) {
        const pct = (cur.tradeValue - before) / before;
        if (Math.abs(pct) >= 0.03) movers.push({ item: cur, changePct: pct });
      }
    }
    movers.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
    return { watchlist: watch, anomalies: a.repo.recentAnomalies(100), inventoryMovers: movers.slice(0, 50) };
  });

  app.get('/api/items/search', async (req): Promise<ItemSearchResponse> => {
    const { q } = z.object({ q: z.string().max(100).default('') }).parse(req.query);
    const needle = q.trim().toLowerCase();
    if (!needle) return { items: [] };
    const asNum = Number(needle);
    const hits = [...a.roli.values()]
      .filter((r) => r.assetId === asNum || r.name.toLowerCase().includes(needle) || (r.acronym ?? '').toLowerCase() === needle)
      .sort((x, y) => (y.value ?? y.rap) - (x.value ?? x.rap))
      .slice(0, 25);
    const recs = a.repo.getItems(hits.map((h) => h.assetId));
    return { items: hits.map((h) => ({ assetId: h.assetId, name: h.name, acronym: h.acronym, value: h.value, rap: h.rap, thumbnailUrl: recs.get(h.assetId)?.thumbnailUrl ?? null })) };
  });

  app.get('/api/items/:assetId', async (req): Promise<ItemDetailResponse> => {
    const { assetId } = AssetParam.parse(req.params);
    const now = Date.now();
    const s = a.settings();
    const snapshot = a.snapshotFor(assetId);
    const hist = a.repo.itemSnapshotHistory(assetId, now - 30 * DAY);
    const step = Math.max(1, Math.ceil(hist.length / 200));
    const history = hist.filter((_, i) => i % step === 0).map((h) => {
      let tv: number | null = null;
      try { tv = a.engine.valueItem(h, s, h.fetchedAt).tradeValue; } catch { tv = null; }
      return { t: h.fetchedAt, rap: h.rap, roliValue: h.roliValue, floorPrice: h.floorPrice, tradeValue: tv };
    });
    return {
      valued: a.valueFor(assetId), snapshot: hist.length || snapshot.sources.length ? snapshot : null, history,
      dailyPrice: snapshot.dailyPrice, dailyVolume: snapshot.dailyVolume, recentSales: a.repo.salesFor(assetId, now - 30 * DAY).slice(0, 100),
    };
  });

  app.get('/api/inventory', async (): Promise<InventoryResponse> => {
    const cache = a.inventory();
    const now = Date.now(), hst = a.holdState(), hlen = a.holdLengths();
    const items: InventoryResponse['items'] = (cache?.items ?? []).map((i) => {
      const v = a.valueFor(i.assetId, undefined, { serial: i.serialNumber, isOnHold: i.isOnHold });
      return i.isOnHold ? { ...v, hold: a.holdForInstance(i, now, hst, hlen) } : v;
    });
    const releases = items.map((v) => v.hold?.releaseAt).filter((x): x is number => x != null);
    const job = a.scheduler.statuses().find((j) => j.name === 'ownInventory');
    const state: InventoryResponse['state'] = a.cookieStatus !== 'valid' && !a.demo ? 'no_cookie'
      : a.inventoryHidden() ? 'hidden' : cache ? 'ready' : 'loading';
    return {
      holds: { length: hlen.trade, lengths: hlen, nextReleaseAt: releases.length ? Math.min(...releases) : null },
      items, totalValue: items.reduce((s, v) => s + v.tradeValue, 0), totalRap: items.reduce((s, v) => s + v.rap, 0),
      totalLiquidation: items.reduce((s, v) => s + v.liquidationValue, 0), count: items.length,
      onHoldCount: items.filter((v) => v.isOnHold).length, fetchedAt: cache?.fetchedAt ?? null, state,
      refreshing: !!job?.running, lastError: job?.lastError ?? null, nextRefreshAllowedAt: a.demo ? null : a.inventoryRefreshAllowedAt(),
    };
  });

  app.post('/api/inventory/refresh', async (_req, reply) => {
    if (a.cookieStatus !== 'valid' && !a.demo) return reply.status(400).send({ error: 'Add your cookie in Settings first.', code: 'no_cookie' });
    return a.requestInventoryRefresh();
  });

  app.get('/api/partners/:userId', async (req, reply) => {
    const { userId } = UserParam.parse(req.params);
    const p = a.repo.getPartner(userId);
    if (!p) return notFound(reply, 'partner not known');
    return p;
  });

  // ---------------------------------------------------------------- settings
  const holdInfo = () => ({ ...a.holdLength(), lengths: a.holdLengths(), observations: a.holdState().observations.length, purchaseLookup: a.purchaseLookupStatus() });
  app.get('/api/settings', async (): Promise<SettingsResponse> => ({ settings: a.settings(), defaults: DEFAULT_SETTINGS, market: a.marketStatus(), hold: holdInfo() }));
  app.put('/api/settings', async (req, reply): Promise<SettingsResponse | void> => {
    const patch = z.record(z.unknown()).parse(req.body ?? {});
    const merged = deepMerge<Settings>(structuredClone(a.settings()), patch);
    const problems = validateSettings(merged);
    if (problems.length) return void reply.status(400).send({ error: problems.join('; '), code: 'invalid_settings' });
    a.saveSettings(merged);
    return { settings: a.settings(), defaults: DEFAULT_SETTINGS, market: a.marketStatus(), hold: holdInfo() };
  });

  // ---------------------------------------------------------------- cookie
  app.get('/api/cookie', cookieStatus);
  app.put('/api/cookie', async (req, reply) => {
    const { cookie } = CookieBody.parse(req.body);
    const st = await a.setCookie(cookie);
    if (st !== 'valid' && !a.demo) {
      return reply.status(400).send({ error: 'Roblox rejected this cookie (users/authenticated returned 401). Nothing was stored.', code: 'invalid_cookie' });
    }
    return cookieStatus();
  });
  app.delete('/api/cookie', async () => { await a.deleteCookie(); return cookieStatus(); });

  // ---------------------------------------------------------------- CSV values
  app.post('/api/values/csv', async (req) => {
    const text = typeof req.body === 'string' ? req.body : '';
    const values: Record<string, number> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s*[,;\t]\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
      if (m) values[m[1]!] = Number(m[2]);
    }
    return { imported: a.setManualValues(values) };
  });

  // ---------------------------------------------------------------- static UI
  const dist = webDist();
  if (d.serveStatic !== false && existsSync(dist)) {
    // wildcard: serve whatever is on disk now, so a rebuild while running (new hashed assets) just works.
    // index.html is never cached, so a refresh always picks up the current build.
    await app.register(fastifyStatic, {
      root: dist, prefix: '/', wildcard: true,
      setHeaders: (res, path) => { if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return void reply.status(404).send({ error: 'not found' });
      // A missing script/style must 404, not return the page (the browser would then render nothing).
      if (req.url.startsWith('/assets/') || /\.[a-z0-9]{1,5}(\?|$)/i.test(req.url)) return void reply.status(404).type('text/plain').send('not found');
      reply.header('Cache-Control', 'no-cache');
      return void reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Appraiser</title><body style="background:#111;color:#ddd;font-family:sans-serif">' +
      '<p>API is running. Build the UI with <code>npm run build</code> (web/dist not found).</p></body>'));
  }

  return app;
}

function notFound(reply: FastifyReply, msg: string) {
  return void reply.status(404).send({ error: msg });
}

export function validateSettings(s: Settings): string[] {
  const errs = checkShape(DEFAULT_SETTINGS, s);
  const ids = (xs: unknown) => Array.isArray(xs) && xs.every((x) => Number.isInteger(x) && (x as number) > 0);
  if (!['grow_value', 'grow_rap', 'liquidity_first', 'upgrade_toward'].includes(s.goalMode)) errs.push('goalMode: invalid');
  if (!ids(s.holdList) || !ids(s.wishlist) || !ids(s.watchlist)) errs.push('lists: must be arrays of asset ids');
  if (s.upgradeTargetAssetId !== null && !(Number.isInteger(s.upgradeTargetAssetId) && s.upgradeTargetAssetId > 0)) errs.push('upgradeTargetAssetId: invalid');
  if (s.notifyThreshold < 0 || s.notifyThreshold > 100) errs.push('notifyThreshold: 0..100');
  if (!(s.port >= 1024 && s.port <= 65535)) errs.push('port: 1024..65535');
  const vb = s.verdictBands;
  if (!(vb.accept >= vb.leanAccept && vb.leanAccept >= vb.counter)) errs.push('verdictBands: must be accept >= leanAccept >= counter');
  if (s.poll.inboundCountMs < 10_000) errs.push('poll.inboundCountMs: >= 10000');
  if (s.poll.rolimonsSalesMs < 2_000) errs.push('poll.rolimonsSalesMs: >= 2000');
  if (s.poll.rolimonsItemsMs < 60_000 || s.poll.rolimonsAdsMs < 60_000) errs.push('poll.rolimonsItems/Ads: >= 60000');
  if (s.poll.itemSnapshotsMs < 60_000) errs.push('poll.itemSnapshotsMs: >= 60000');
  const dr = s.drops;
  if (dr.robloxPollMs < 6_000) errs.push('drops.robloxPollMs: >= 6000 (catalog search allows 12 / min)');
  if (dr.allPollMs < 6_000) errs.push('drops.allPollMs: >= 6000');
  if (60_000 / dr.robloxPollMs + (dr.includeUgc ? 60_000 / dr.allPollMs : 0) > FEED_MAX_PER_MIN + 0.01) errs.push(`drops: the two feeds together must stay <= ${FEED_MAX_PER_MIN} searches / min (Roblox allows 12; the creator watchlist uses the rest)`);
  if (!Array.isArray(dr.creators) || dr.creators.length > 25 || !dr.creators.every((c) => Number.isInteger(c?.id) && c.id > 0 && (c.type === 'User' || c.type === 'Group') && typeof c.name === 'string' && c.name.length <= 60)) errs.push('drops.creators: up to 25 entries of { id, type: User|Group, name }');
  if (dr.stockRefreshMs < 5_000) errs.push('drops.stockRefreshMs: >= 5000');
  if (dr.newWindowMs < 3_600_000 || dr.newWindowMs > 7 * DAY) errs.push('drops.newWindowMs: 1 h .. 7 d');
  if (dr.notifyMaxPrice < 0 || dr.notifyMinQuantity < 0) errs.push('drops notify filters: >= 0');
  if (!(s.hold.assumedDays > 0 && s.hold.assumedDays <= 30)) errs.push('hold.assumedDays: (0, 30]');
  if (!(s.hold.assumedPurchaseDays > 0 && s.hold.assumedPurchaseDays <= 30)) errs.push('hold.assumedPurchaseDays: (0, 30]');
  if (!Array.isArray(s.overpayNorms.rows) || !s.overpayNorms.rows.every((r) => ['small', 'mid', 'large'].includes(r.tier) && typeof r.pct === 'number')) errs.push('overpayNorms.rows: invalid');
  if (!s.valuation.serialPremium.every((r) => typeof r.multiplier === 'number' && r.multiplier > 0)) errs.push('valuation.serialPremium: invalid');
  if (!ids(s.botList.extraUserIds) || s.botList.extraUserIds.length > 10_000) errs.push('botList.extraUserIds: up to 10000 user ids');
  if (s.botList.url && !/^https:\/\/api\.github\.com\/gists\/[0-9a-f]+$/i.test(s.botList.url)) errs.push('botList.url: a https://api.github.com/gists/<id> URL, or empty');
  if (!(s.poll.catalogRefreshMs >= 3_600_000)) errs.push('poll.catalogRefreshMs: >= 3600000 (1 h)');
  if (!(s.poll.catalogNonLimitedRefreshMs >= 3_600_000)) errs.push('poll.catalogNonLimitedRefreshMs: >= 3600000 (1 h)');
  const dd = s.valuation.derivedDemandPerDay;
  if (!(Array.isArray(dd) && dd.length === 4 && dd.every((x, i) => typeof x === 'number' && x > 0 && (i === 0 || x < dd[i - 1]!)))) errs.push('valuation.derivedDemandPerDay: 4 positive numbers, strictly decreasing (demand 4..1)');
  const lq = s.valuation.liquidity;
  if (lq) {
    if (!(lq.priceTierAnchor > 0)) errs.push('valuation.liquidity.priceTierAnchor: > 0');
    if (!(lq.priceTierSlopePerDecade >= 0 && lq.priceTierSlopePerDecade <= 1)) errs.push('valuation.liquidity.priceTierSlopePerDecade: 0..1');
    if (!(lq.priceTierFloor > 0 && lq.priceTierFloor <= 1)) errs.push('valuation.liquidity.priceTierFloor: (0, 1]');
    for (const k of ['lowLiquidityCut', 'lowLiquidityShareWarn', 'unknownDemandLiquidity', 'noSalesCap'] as const) {
      if (!(lq[k] >= 0 && lq[k] <= 1)) errs.push(`valuation.liquidity.${k}: 0..1`);
    }
    if (!Object.entries(lq.demandLiquidity ?? {}).every(([k, v]) => /^-?\d+$/.test(k) && typeof v === 'number' && v >= 0 && v <= 1)) errs.push('valuation.liquidity.demandLiquidity: { "<demand index>": 0..1 }');
  }
  const sc = s.scoring;
  if (!(sc.momentumUpFactor >= 0 && sc.momentumCapPp >= 0 && sc.momentumFloorPp <= 0)) errs.push('scoring.momentum*: upFactor >= 0, capPp >= 0, floorPp <= 0');
  if (!(sc.liquidityClampPp > 0 && sc.demandShiftMultiplier >= 0)) errs.push('scoring.liquidityClampPp > 0, demandShiftMultiplier >= 0');
  if (!(sc.lowLiquidityOwnedShare > 0 && sc.lowLiquidityOwnedShare <= 1)) errs.push('scoring.lowLiquidityOwnedShare: (0, 1]');
  if (!(s.market.referenceMedianValue >= 0)) errs.push('market.referenceMedianValue: >= 0 (0 = automatic)');
  if (!(s.market.maxScale > 1 && s.market.maxScale <= 20)) errs.push('market.maxScale: (1, 20]');
  if (!(s.overpayNorms.smallMax > 0 && s.overpayNorms.midMax > s.overpayNorms.smallMax)) errs.push('overpayNorms: 0 < smallMax < midMax');
  return errs;
}
