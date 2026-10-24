/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * DEMO mode (env DEMO=1): seeds a throwaway DB with fixture-based items and trades that
 * reproduce typical trade situations, so the UI works without a cookie or network.
 */
import { emptyHoldState, updateHoldState, type CompletedTradeRef, type HoldState } from '../core/holds.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RolimonsItem } from '../adapters/interfaces.js';
import type { AssetId, Demand, DropItem, ItemSnapshot, MarketAnomaly, PricePoint, ReconstructedSale, SourceHealth, TradeDirection, TradeId, TradeItem, TradeSide, TradeSnapshot, TradeStatus, Trend } from '../core/types.js';
import type { SqliteRepository } from '../db/sqlite.js';
import type { Analyst, InventoryCache } from '../jobs/analyst.js';
import { fixturesDir } from './paths.js';
import { parseItemRow } from '../adapters/rolimons/client.js';

const DAY = 86_400_000;
export const DEMO_ACCOUNT = { id: 1, name: 'DemoTrader', displayName: 'Demo Trader' };

interface DemoItem { key: string; value: number | null; rap: number; demand: Demand; trend: Trend; floor: number; projected?: boolean; spike?: number; sales30d?: number; copies?: number }

const ITEMS: DemoItem[] = [
  { key: 'big', value: 500_000, rap: 480_000, demand: 2, trend: 2, floor: 505_000, sales30d: 6 },
  { key: 's1', value: 200_000, rap: 195_000, demand: 2, trend: 2, floor: 205_000, sales30d: 12 },
  { key: 's2', value: 180_000, rap: 176_000, demand: 2, trend: 2, floor: 182_000, sales30d: 10 },
  { key: 's3', value: 150_000, rap: 151_000, demand: 2, trend: 2, floor: 152_000, sales30d: 14 },
  { key: 'proj', value: 60_000, rap: 170_000, demand: 1, trend: 1, floor: 65_000, projected: true, spike: 600_000, sales30d: 2 },
  { key: 'mid55', value: 55_000, rap: 54_000, demand: 3, trend: 2, floor: 56_000, sales30d: 25 },
  { key: 'amz1', value: 140_000, rap: 138_000, demand: 4, trend: 3, floor: 142_000, sales30d: 40 },
  { key: 'amz2', value: 140_000, rap: 141_000, demand: 4, trend: 2, floor: 143_000, sales30d: 35 },
  { key: 'ter1', value: 100_000, rap: 99_000, demand: 0, trend: 0, floor: 80_000, sales30d: 1 },
  { key: 'ter2', value: 100_000, rap: 98_000, demand: 0, trend: 0, floor: 82_000, sales30d: 0 },
  { key: 'ter3', value: 100_000, rap: 101_000, demand: 0, trend: 1, floor: 79_000, sales30d: 1 },
  { key: 'hold', value: 30_000, rap: 29_500, demand: 3, trend: 2, floor: 31_000, sales30d: 30 },
  { key: 'give27', value: 27_000, rap: 26_800, demand: 2, trend: 2, floor: 27_500, sales30d: 20 },
  { key: 'bot', value: 12_000, rap: 15_000, demand: 1, trend: 2, floor: 11_000, sales30d: 4 },
  { key: 'bait', value: 9_000, rap: 9_100, demand: 2, trend: 2, floor: 9_200, sales30d: 18 },
  { key: 'up', value: 100_000, rap: 104_000, demand: 3, trend: 3, floor: 112_000, sales30d: 28 },
  { key: 'u1', value: 60_000, rap: 61_000, demand: 1, trend: 2, floor: 58_000, sales30d: 6 },
  { key: 'u2', value: 50_000, rap: 49_000, demand: 1, trend: 0, floor: 46_000, sales30d: 5 },
  { key: 'acc', value: 62_000, rap: 61_500, demand: 3, trend: 3, floor: 64_000, sales30d: 30 },
  { key: 'g50', value: 50_000, rap: 50_500, demand: 2, trend: 2, floor: 50_800, sales30d: 15 },
  { key: 'rbx', value: 40_000, rap: 39_000, demand: 2, trend: 2, floor: 40_500, sales30d: 15 },
  { key: 'g45', value: 45_000, rap: 45_500, demand: 2, trend: 2, floor: 46_000, sales30d: 15 },
];

function series(base: number, days: number, now: number, drift = 0): PricePoint[] {
  const out: PricePoint[] = [];
  for (let d = 0; d < days; d++) {
    // Slow swings plus small deterministic day-to-day jitter: reads like a real market series.
    const wobble = 1 + 0.04 * Math.sin(d / 9) + 0.015 * Math.sin(d * 2.3) * Math.cos(d * 0.7) - drift * (d / days);
    out.push({ t: Math.floor((now - d * DAY) / DAY) * DAY, value: Math.round(base * wobble) });
  }
  return out;
}

/** Fraction the item's value was HIGHER ~30 days ago (negative = it has risen since). Drives value-then vs value-now. */
const DRIFT30: Record<string, number> = {
  big: 0.08, s1: -0.05, s2: 0.03, proj: 0.9, mid55: -0.06, amz1: -0.1, amz2: -0.07, ter1: 0.2, ter2: 0.18, ter3: 0.15,
  up: -0.18, acc: -0.12, g50: 0.04, g45: 0.02, bot: 0.35, bait: -0.03, give27: 0.05, hold: -0.04, u1: 0.1, u2: 0.14,
};
/** Inventory movers: value two days ago relative to now (|x-1| >= 3% shows in the Market tab). */
const MOVE2D: Record<string, number> = { big: 0.95, g50: 1.06, give27: 0.93, u2: 1.09, amz1: 0.96, mid55: 1.05, g45: 0.97 };
/** Raise/drop-pending lag: market (floor/RAP) sat this far from value over the last week. */
const LAG7D: Record<string, number> = { up: 1.25, ter1: 0.75 };
export const DEMO_WATCHLIST_KEYS = ['up', 'ter1', 'proj'];

export interface DemoHistory { tradeId: TradeId; status: TradeStatus; decidedAt: number }
export interface DemoSeed { roli: RolimonsItem[]; history: DemoHistory[] }

export function seedDemo(repo: SqliteRepository, now = Date.now()): DemoSeed {
  const raw = JSON.parse(readFileSync(join(fixturesDir(), 'rolimons_items_v2_itemdetails.json'), 'utf8')) as { items: Record<string, [string, string, number, number]> };
  // Real fixture asset ids/names (valued items), overridden with scenario numbers.
  const pool = Object.entries(raw.items).filter(([, v]) => v[3] > 0).slice(0, ITEMS.length);
  const ids = new Map<string, { assetId: AssetId; name: string; acronym: string }>();
  ITEMS.forEach((it, i) => {
    const p = pool[i];
    ids.set(it.key, p ? { assetId: Number(p[0]), name: p[1][0], acronym: p[1][1] } : { assetId: 900_000 + i, name: `Demo Item ${i}`, acronym: '' });
  });

  const roli: RolimonsItem[] = [];
  for (const it of ITEMS) {
    const meta = ids.get(it.key)!;
    roli.push({ assetId: meta.assetId, name: meta.name, acronym: meta.acronym || null, rap: it.rap, value: it.value, defaultValue: it.value ?? it.rap,
      demand: it.demand, trend: it.trend, projected: !!it.projected, rare: false });
    repo.upsertItem({ assetId: meta.assetId, name: meta.name, collectibleItemId: null, itemType: 'Asset', isLimitedU: true, thumbnailUrl: null, catalogFetchedAt: now });
    const sales: ReconstructedSale[] = [];
    if (it.spike) sales.push({ assetId: meta.assetId, t: now - 10 * DAY, price: it.spike, oldRap: 110_000, newRap: 159_000, source: 'rolimons_feed', saleId: `demo-${meta.assetId}-spike` });
    for (let k = 0; k < Math.min(5, it.sales30d ?? 0); k++) {
      sales.push({ assetId: meta.assetId, t: now - (k * 5 + 1) * DAY, price: Math.round(it.floor * (0.97 + 0.01 * k)), oldRap: it.rap, newRap: it.rap, source: 'rolimons_feed', saleId: `demo-${meta.assetId}-${k}` });
    }
    repo.insertSales(sales);
    const trendDrift = it.trend === 3 ? -0.08 : it.trend === 0 ? 0.08 : 0;
    const snap: ItemSnapshot = {
      assetId: meta.assetId, collectibleItemId: null, itemType: 'Asset', name: meta.name, isLimitedU: true,
      rap: it.rap, roliValue: it.value, roliDefaultValue: it.value ?? it.rap, roliDemand: it.demand, roliTrend: it.trend,
      roliProjected: !!it.projected, roliRare: false, floorPrice: it.floor, resellerCount: it.projected ? 6 : 8, totalQuantity: it.copies ?? 2000,
      publicCopies: null, sales7d: Math.round((it.sales30d ?? 0) / 4), sales30d: it.sales30d ?? 0,
      dailyPrice: series(it.projected ? 110_000 : it.floor, 180, now, trendDrift),
      dailyVolume: series(Math.max(1, (it.sales30d ?? 0) / 30), 180, now).map((p) => ({ ...p, value: Math.max(0, Math.round(p.value)) })),
      lastSales: sales.sort((a, b) => b.t - a.t), fetchedAt: now, sources: ['marketplace_sales', 'rolimons', 'catalog'],
    };
    if (meta.acronym) snap.acronym = meta.acronym;
    // Older snapshots first (append order mirrors a real poller), then the current one.
    const past = (daysAgo: number, mult: number, mktMult = mult) => repo.insertItemSnapshot({
      ...snap, rap: Math.round(it.rap * mktMult), roliValue: it.value == null ? null : Math.round(it.value * mult),
      roliDefaultValue: Math.round((it.value ?? it.rap) * mult), floorPrice: Math.round(it.floor * mktMult), fetchedAt: now - daysAgo * DAY - 3_600_000,
      dailyPrice: snap.dailyPrice.filter((p) => p.t <= now - daysAgo * DAY), lastSales: [],
    });
    const drift = DRIFT30[it.key] ?? 0;
    for (const d of [45, 38, 32, 26, 20, 15, 11, 8]) past(d, 1 + drift * Math.min(d, 30) / 30);
    const lag = LAG7D[it.key];
    if (lag) for (const d of [6, 4, 3, 2]) past(d, 1, lag);
    else if (MOVE2D[it.key]) past(2, MOVE2D[it.key]!);
    repo.insertItemSnapshot(snap);
  }

  const item = (key: string, opts: Partial<TradeItem> = {}): TradeItem => {
    const meta = ids.get(key)!;
    const d = ITEMS.find((x) => x.key === key)!;
    return { assetId: meta.assetId, itemType: 'Asset', targetId: String(meta.assetId), name: meta.name, userAssetId: meta.assetId * 10 + 1,
      collectibleItemInstanceId: null, collectibleItemId: null, serialNumber: null, rap: d.rap, originalPrice: null, assetStock: 2000,
      isOnHold: false, joinKey: 'serial+asset', ...opts };
  };
  const me = (items: TradeItem[], robux = 0): TradeSide => ({ userId: DEMO_ACCOUNT.id, userName: DEMO_ACCOUNT.name, displayName: DEMO_ACCOUNT.displayName, items, robux });
  let nextId = 7_000_000_001;
  const trade = (partner: { id: number; name: string }, give: TradeSide, get: Omit<TradeSide, 'userId' | 'userName' | 'displayName'>, ageMin: number,
    direction: TradeDirection = 'inbound'): TradeSnapshot => {
    const sig = [give.items.map((i) => i.assetId).sort().join('+'), give.robux, '|', get.items.map((i) => i.assetId).sort().join('+'), get.robux].join(':');
    const createdAt = now - ageMin * 60_000;
    return {
      tradeId: nextId++, direction, status: 'Open', statusRaw: 'Open', isActive: true,
      createdAt, expiresAt: Math.max(createdAt + 5 * DAY, now + 4 * DAY), partner: { userId: partner.id, name: partner.name, displayName: partner.name },
      give, get: { userId: partner.id, userName: partner.name, displayName: partner.name, ...get }, fetchedAt: ageMin > 24 * 60 * 5 ? createdAt : now,
      hadV1: true, hadV2: true, offerSignature: sig,
    };
  };

  const trades: TradeSnapshot[] = [
    // 1. Split norm (DOWNGRADE): give 500k, get 200k+180k+150k (+6% raw).
    trade({ id: 101, name: 'SplitSeller' }, me([item('big')]), { items: [item('s1'), item('s2'), item('s3')], robux: 0 }, 30),
    // 2. Projected trap.
    trade({ id: 102, name: 'RapPumper' }, me([item('mid55')]), { items: [item('proj')], robux: 0 }, 50),
    // 3. Robux math: receive 10,000 R$ (counts as 7,000) + 40k item for a 45k item.
    trade({ id: 103, name: 'RobuxAdder' }, me([item('g45')]), { items: [item('rbx')], robux: 10_000 }, 70),
    // 4. Value trap: 300k terrible demand for 280k amazing demand.
    trade({ id: 104, name: 'DeadWeight' }, me([item('amz1'), item('amz2')]), { items: [item('ter1'), item('ter2'), item('ter3')], robux: 0 }, 90),
    // 5. Hold: incoming item is on hold.
    trade({ id: 105, name: 'FreshUnbox' }, me([item('give27')]), { items: [item('hold', { isOnHold: true })], robux: 0 }, 110),
    // 7. Smart upgrade: 2 low-demand items for 1 high-demand raising item.
    trade({ id: 107, name: 'UpgradeGuy' }, me([item('u1'), item('u2')]), { items: [item('up')], robux: 0 }, 15),
    // 8. Clean overpay.
    trade({ id: 108, name: 'GenerousOne' }, me([item('g50')]), { items: [item('acc')], robux: 0 }, 5),
  ];
  // 6. Bot pattern: the same give/get sets from 4 accounts within 24h.
  for (let k = 0; k < 4; k++) trades.push(trade({ id: 200 + k, name: `trader_bot_${k}` }, me([item('bait')]), { items: [item('bot')], robux: 0 }, 200 + k * 30));

  // History: finished trades 10-40 days old (created Open, then moved to their final status; primeDemo scores them).
  const hist: Array<{ t: TradeSnapshot; status: TradeStatus; ageDays: number }> = [];
  const h = (partner: { id: number; name: string }, give: TradeItem[], get: TradeItem[], robux: number, status: TradeStatus, ageDays: number, dir: TradeDirection) =>
    hist.push({ t: trade(partner, me(give), { items: get, robux }, ageDays * 24 * 60, dir), status, ageDays });
  h({ id: 401, name: 'EarlyBird' }, [item('s2')], [item('amz1')], 0, 'Completed', 38, 'inbound');
  h({ id: 402, name: 'RapPumper2' }, [item('mid55')], [item('proj')], 0, 'Completed', 34, 'inbound');
  h({ id: 403, name: 'SplitKing' }, [item('big')], [item('s1'), item('s2'), item('ter1')], 0, 'Declined', 31, 'inbound');
  h({ id: 404, name: 'FairDeal' }, [item('g45')], [item('acc')], 0, 'Declined', 36, 'inbound');
  h({ id: 405, name: 'trader_bot_9' }, [item('bait')], [item('bot')], 0, 'Expired', 22, 'inbound');
  h({ id: 406, name: 'Haggler' }, [item('u1')], [item('g50')], 0, 'Countered', 18, 'inbound');
  h({ id: 407, name: 'UpChaser' }, [item('ter2'), item('bait')], [item('up')], 0, 'Completed', 14, 'inbound');
  h({ id: 408, name: 'TerribleTim' }, [item('amz2')], [item('ter3'), item('give27')], 2_000, 'Declined', 11, 'inbound');
  // My Trades: a completed trade with Robux added by the partner (scored at the time).
  h({ id: 409, name: 'RobuxTopper' }, [item('g45')], [item('mid55')], 5_000, 'Completed', 20, 'inbound');

  // My Trades: completed before the app existed (fetched already Completed, never scored live).
  // 42 days old -> a snapshot 3 days earlier is the then-value basis; 75 days old -> no data, estimated from current.
  const preApp = (partner: { id: number; name: string }, give: TradeItem[], get: TradeItem[], ageDays: number, giveRobux = 0): TradeSnapshot => {
    const t = trade(partner, me(give, giveRobux), { items: get, robux: 0 }, ageDays * 24 * 60, 'completed');
    return { ...t, status: 'Completed', statusRaw: 'Completed', isActive: false, expiresAt: null };
  };
  const preAppTrades = [
    preApp({ id: 410, name: 'OldFriend' }, [item('u2')], [item('g50')], 42),
    preApp({ id: 411, name: 'LongAgo' }, [item('bait'), item('give27')], [item('s3')], 75, 3_000),
  ];

  // Trade hold demo: a trade the app watched complete 20 h ago brings in a copy that is still on hold.
  const g45Id = ids.get('g45')!.assetId;
  const holdTrade = trade({ id: 412, name: 'HoldDemo' }, me([item('ter1')]), { items: [item('g45', { userAssetId: g45Id * 10 + 1 })], robux: 0 }, 26 * 60);
  const all = [...trades, ...hist.map((x) => x.t), ...preAppTrades, holdTrade];
  for (const t of all) repo.upsertTrade(t);
  const history = hist.map(({ t, status, ageDays }) => ({ tradeId: t.tradeId, status, decidedAt: now - (ageDays - 1) * DAY + 3 * 3_600_000 }));
  for (const x of history) repo.updateTradeStatus(x.tradeId, x.status, x.status, false, x.decidedAt);
  repo.updateTradeStatus(holdTrade.tradeId, 'Completed', 'Completed', false, now - 20 * 3_600_000);

  const now2 = now;
  for (const t of all) {
    const p = t.partner;
    const isBot = (p.userId >= 200 && p.userId < 300) || p.userId === 405;
    repo.upsertPartner({
      userId: p.userId, name: p.name, displayName: p.displayName, createdAt: now2 - (isBot ? 20 : 900) * DAY, accountAgeDays: isBot ? 20 : 900,
      hasVerifiedBadge: false, isBanned: false, inventoryVisible: !isBot, inventoryValue: isBot ? null : 1_500_000, inventoryRap: isBot ? null : 1_400_000,
      inventoryItemCount: isBot ? null : 40, inBotList: false, terminated: false, repeatOfferCount: 0, repeatOfferAccounts: 0,
      priorTrades: { completed: 0, declined: 0, countered: 0 }, flags: [], evidence: [], fetchedAt: now2,
    });
  }

  // Own inventory = every give-side item (+ one duplicate to exercise duplicate penalty).
  const owned = new Set<AssetId>();
  for (const t of trades) for (const i of t.give.items) owned.add(i.assetId);
  owned.add(ids.get('s3')!.assetId);
  const inv: InventoryCache = {
    fetchedAt: now,
    items: [...owned].map((id, idx) => {
      const r = roli.find((x) => x.assetId === id)!;
      // A little variety for the Inventory tab: a couple of serials and one item on trade hold.
      const serialNumber = idx % 4 === 1 ? 37 + idx * 113 : null;
      return { userAssetId: id * 10 + 1, assetId: id, name: r.name, serialNumber, recentAveragePrice: r.rap, originalPrice: null, assetStock: 2000, isOnHold: idx === 2 || idx === 3 };
    }),
  };
  repo.setKv('ownInventory', inv);
  // Hold tracker: g45 (idx 2) starts at the watched completion of HoldDemo; the other held copy was first seen on hold 49 h ago (due any time).
  const holdRefs: CompletedTradeRef[] = [{ tradeId: holdTrade.tradeId, at: now - 20 * 3_600_000, observed: true,
    received: holdTrade.get.items.map((i) => ({ assetId: i.assetId, serial: i.serialNumber, userAssetId: i.userAssetId })) }];
  const firstSeen = updateHoldState(emptyHoldState(), inv.items.filter((i) => i.assetId !== g45Id), now - 49 * 3_600_000, []);
  for (const e of Object.values(firstSeen.entries)) e.lastSeenOnHold = now;
  const tracked = updateHoldState(firstSeen, inv.items, now, holdRefs);
  repo.setKv<HoldState>('holdTracker', tracked);
  repo.setKv('canTrade', { canTrade: true, tradeEligibility: 'Eligible', freeTradesAllowance: null, currencyTransferEligibility: null });
  repo.setKv('rolimonsItems', roli);

  // Market: watchlist + a few Rolimons-feed anomalies (raise/drop-pending ones come from the snapshot scan in primeDemo).
  repo.saveSettings({ ...repo.getSettings(), watchlist: DEMO_WATCHLIST_KEYS.map((k) => ids.get(k)!.assetId) });
  const anomaly = (key: string, kind: MarketAnomaly['kind'], message: string, hoursAgo: number, changePct?: number) => {
    const m = ids.get(key)!;
    repo.insertAnomaly({ id: `${kind}:demo:${m.assetId}`, assetId: m.assetId, name: m.name, kind, message: `${m.name} ${message}`, evidence: [],
      at: now - hoursAgo * 3_600_000, ...(changePct != null ? { changePct } : {}) });
  };
  anomaly('proj', 'newly_projected', 'marked projected by Rolimons', 30);
  anomaly('amz1', 'value_change', 'value 126,000 -> 140,000', 52, 0.111);
  anomaly('bot', 'big_move', 'RAP moved 25% (12,000 -> 15,000)', 8, 0.25);

  return {
    roli,
    history,
  };
}

/** Fake drops for the Drops tab (made-up items; two are under 5 minutes old). */
export function seedDemoDrops(repo: SqliteRepository, now = Date.now()): DropItem[] {
  const MIN = 60_000;
  // Observed catalog-index lag is 80-130 min; young rows can't be seen later than they are old.
  const LAGS = [92, 81, 118, 87, 131, 96, 84, 104, 90, 99].map((m) => m * MIN);
  const mk = (i: number, p: Partial<DropItem> & Pick<DropItem, 'name' | 'price' | 'totalQuantity' | 'remaining'>, ageMs: number): DropItem => {
    const tradable = p.tradable ?? false;
    const createdAt = now - ageMs;
    const lag = Math.min(LAGS[i % LAGS.length]!, Math.max(4_000, ageMs * 0.6));
    const d: DropItem = {
      key: `demo-drop-${i}`, assetId: 990_000_000 + i, itemType: 'Asset', collectibleItemId: `demo-drop-${i}`,
      creatorName: tradable ? 'Roblox' : 'Demo UGC Studio', creatorId: tradable ? 1 : 4_242, creatorType: tradable ? 'User' : 'Group',
      creatorVerified: tradable, tradable, restrictions: tradable ? ['Limited'] : ['Collectible'],
      sales: p.totalQuantity != null && p.remaining != null ? p.totalQuantity - p.remaining : null, limitPerUser: 0,
      saleLocation: 'ShopAndAllExperiences', inGameOnly: false, offSaleDeadline: null, lowestResalePrice: null, hasResellers: false,
      favoriteCount: 100 + i * 37, thumbnailUrl: null, createdAt, firstSeenAt: createdAt + lag, updatedAt: now, stockUpdatedAt: now - 3_000,
      soldOutAt: null, notifiedAt: null, seenLive: true, source: tradable ? 'roblox' : 'all', saleStatus: 'onSale', ...p,
    };
    if (d.remaining === 0 && d.saleStatus === 'onSale') d.soldOutAt = d.soldOutAt ?? createdAt + Math.min(ageMs / 2, 10 * MIN);
    return d;
  };
  const studio = { creatorName: 'Pixel Forge Studio', creatorId: 5_150_515, creatorType: 'Group', creatorVerified: true, watched: true, source: 'creator' as const };
  const drops = [
    mk(1, { name: 'Crimson Frost Valkyrie', tradable: true, price: 25_000, totalQuantity: 500, remaining: 471, limitPerUser: 1, offSaleDeadline: now + 2 * DAY }, 40_000),
    mk(2, { name: 'Golden Clockwork Shades', tradable: true, price: 1_000, totalQuantity: 5_000, remaining: 3_214, limitPerUser: 1, offSaleDeadline: now + 6 * 3_600_000 }, 2 * MIN + 10_000),
    mk(3, { name: 'Toxic Void Crown (demo)', price: 95, totalQuantity: 3_000, remaining: 2_985 }, 4 * MIN),
    mk(4, { name: 'Code-drop Hamster (demo)', price: 0, totalQuantity: 100, remaining: 12, saleLocation: 'ExperiencesDevApiOnly', inGameOnly: true, limitPerUser: 1 }, 12 * MIN),
    mk(5, { name: 'Midnight Sparkle Time Fedora', tradable: true, price: 1_200, totalQuantity: 2_000, remaining: 0, limitPerUser: 1, lowestResalePrice: 4_800, hasResellers: true }, 3 * 3_600_000),
    mk(6, { name: 'Neon Bunny Ears (demo)', price: 300, totalQuantity: 250, remaining: 0, lowestResalePrice: 1_250, hasResellers: true }, 30 * MIN),
    mk(7, { name: 'Overpriced Winter Scarf', tradable: true, price: 2_500, totalQuantity: 10_000, remaining: 0, limitPerUser: 2, lowestResalePrice: 2_100, hasResellers: true }, 20 * 3_600_000),
    mk(8, { name: 'Starlight Backpack (demo)', price: 450, totalQuantity: 1_000, remaining: 640, limitPerUser: 3 }, 55 * MIN),
    // Announced timed release (scheduledRelease): watched directly by id, alerted the moment it goes on sale.
    mk(9, { name: 'Aurora Timekeeper Crown', tradable: true, price: 15_000, totalQuantity: 1_000, remaining: 0, limitPerUser: 1,
      releaseAt: now + 2 * MIN + 5_000, saleStatus: 'pending', source: 'creator', seenLive: false, offSaleDeadline: now + 3 * DAY }, 3 * 3_600_000),
    mk(10, { name: 'Eclipse Wings of the Archive', tradable: true, price: 40_000, totalQuantity: 300, remaining: 0, limitPerUser: 1,
      releaseAt: now + 47 * MIN, saleStatus: 'pending', source: 'creator', seenLive: false }, 26 * 3_600_000),
    // Found by the creator watchlist (a UGC group the user follows).
    mk(11, { name: 'Prismatic Halo (watched creator)', price: 750, totalQuantity: 800, remaining: 512, limitPerUser: 1, ...studio }, 9 * MIN),
  ];
  for (const d of drops) repo.upsertDrop(d);
  const s = repo.getSettings();
  if (!s.drops.creators.some((c) => c.id === studio.creatorId)) {
    repo.saveSettings({ ...s, drops: { ...s.drops, creators: [...s.drops.creators, { id: studio.creatorId, type: 'Group', name: studio.creatorName }] } });
  }
  return drops;
}

/** Plausible per-source health rows for demo mode (no network = no adapter health otherwise). */
export function demoSources(now = Date.now()): SourceHealth[] {
  const row = (id: string, agoS: number, hits: number, misses: number, extra: Partial<SourceHealth> = {}): SourceHealth =>
    ({ id, ok: true, lastSuccessAt: now - agoS * 1000, lastErrorAt: null, lastError: null, count429: 0, cacheHits: hits, cacheMisses: misses, ...extra });
  return [
    row('roblox:trades', 12, 41, 318),
    row('roblox:inventory', 240, 9, 22),
    row('roblox:users', 95, 133, 47),
    row('roblox:marketplace', 60, 212, 640, { count429: 2, lastErrorAt: now - 3 * 3_600_000, lastError: 'HTTP 429 (backed off 30s)' }),
    row('roblox:catalogSearch', 6, 0, 914),
    row('roblox:marketplaceItems', 3, 0, 1_620),
    row('rolimons:items', 300, 0, 96),
    row('rolimons:sales', 4, 0, 5_120),
    row('rolimons:ads', 600, 0, 48),
  ];
}

/**
 * Second demo phase (needs the Analyst): score history trades with the values they had at the time,
 * then run the learning job and the snapshot-lag scan once.
 */
export async function primeDemo(analyst: Analyst, seed: DemoSeed): Promise<void> {
  const { repo, engine } = analyst;
  const settings = analyst.settings();
  for (const h of seed.history) {
    const t = repo.getTrade(h.tradeId);
    if (!t) continue;
    const at = t.createdAt + 20 * 60_000;
    const valued = (it: TradeItem) => {
      const snap = repo.itemSnapshotAtOrBefore(it.assetId, at) ?? analyst.snapshotFor(it.assetId, it);
      return engine.valueItem(snap, settings, at, { serial: it.serialNumber, isOnHold: it.isOnHold ?? false });
    };
    const score = engine.scoreTrade({
      trade: t, give: t.give.items.map(valued), get: t.get.items.map(valued), partner: analyst.partnerFor(t), partnerTradable: [],
      portfolio: analyst.portfolio(), metadata: analyst.metadata(), settings, now: at,
    });
    repo.insertScore({ ...score, scoredAt: at });
  }
  await analyst.computeOutcomes();
  await analyst.scanSnapshotSignals();
}
