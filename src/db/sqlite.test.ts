/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type TradeSnapshot } from '../core/types.js';
import { openRepository } from './index.js';

function trade(id: number, partner: number, sig = 'sig-a'): TradeSnapshot {
  const side = (u: number) => ({ userId: u, userName: `u${u}`, displayName: `u${u}`, robux: 0, items: [{
    assetId: 10, itemType: 'Asset' as const, targetId: '10', name: 'X', userAssetId: 1, collectibleItemInstanceId: null, collectibleItemId: null,
    serialNumber: 5, rap: 100, originalPrice: null, assetStock: null, isOnHold: false, joinKey: 'serial+asset' as const }] });
  return { tradeId: id, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt: 1_000 + id, expiresAt: null,
    partner: { userId: partner, name: `p${partner}`, displayName: `p${partner}` }, give: side(1), get: side(partner), fetchedAt: 2_000,
    hadV1: true, hadV2: true, offerSignature: sig };
}

describe('SqliteRepository', () => {
  it('migrates idempotently and round-trips settings with defaults merged', () => {
    const r = openRepository(':memory:');
    r.migrate();
    expect(r.getSettings()).toEqual(DEFAULT_SETTINGS);
    r.saveSettings({ ...DEFAULT_SETTINGS, notifyThreshold: 80, holdList: [5] });
    expect(r.getSettings().notifyThreshold).toBe(80);
    expect(r.getSettings().poll.inboundCountMs).toBe(DEFAULT_SETTINGS.poll.inboundCountMs);
  });

  it('never overwrites a cached collectibleItemId with null', () => {
    const r = openRepository(':memory:');
    r.upsertItem({ assetId: 1, name: 'A', collectibleItemId: 'cid-1', itemType: 'Asset', isLimitedU: true, thumbnailUrl: null, catalogFetchedAt: 1 });
    r.upsertItem({ assetId: 1, name: 'A2', collectibleItemId: null, itemType: 'Asset', isLimitedU: null, thumbnailUrl: 'u', catalogFetchedAt: 2 });
    const it = r.getItem(1)!;
    expect(it.collectibleItemId).toBe('cid-1');
    expect(it.name).toBe('A2');
    expect(it.isLimitedU).toBe(true);
  });

  it('stores the catalog createdAt and never clears it with null', () => {
    const r = openRepository(':memory:');
    r.upsertItem({ assetId: 2, name: 'B', collectibleItemId: null, itemType: 'Asset', isLimitedU: true, thumbnailUrl: null, catalogFetchedAt: 1, createdAt: 1_700_000_000_000 });
    r.upsertItem({ assetId: 2, name: 'B', collectibleItemId: null, itemType: 'Asset', isLimitedU: true, thumbnailUrl: null, catalogFetchedAt: 2, createdAt: null });
    expect(r.getItem(2)!.createdAt).toBe(1_700_000_000_000);
  });

  it('stores trades, status transitions, scores and offer signatures', () => {
    const r = openRepository(':memory:');
    for (let i = 0; i < 4; i++) r.upsertTrade(trade(100 + i, 50 + i));
    expect(r.countOfferSignature('sig-a', 0)).toEqual({ count: 4, accounts: 4 });
    expect(r.listTrades({ direction: 'inbound', limit: 10, offset: 0 })).toHaveLength(4);
    r.updateTradeStatus(100, 'Declined', 'Declined', false, 5_000);
    expect(r.listTrades({ direction: 'inbound', limit: 10, offset: 0 })).toHaveLength(3);
    expect(r.listTrades({ direction: 'inactive', limit: 10, offset: 0 }).map((t) => t.tradeId)).toEqual([100]);
    expect(r.decidedAt(100)).toBe(5_000);
    expect(r.statusHistory(100).map((h) => h.status)).toEqual(['Open', 'Declined']);
    expect(r.priorTradesWith(50)).toEqual({ completed: 0, declined: 1, countered: 0 });
    expect(r.wasNotified(101)).toBe(false);
    r.markNotified(101, 1);
    expect(r.wasNotified(101)).toBe(true);
  });

  it('dedupes sales by saleId', () => {
    const r = openRepository(':memory:');
    const s = { assetId: 1, t: 10, price: 100, oldRap: 90, newRap: 91, source: 'rolimons_feed' as const, saleId: 'x' };
    expect(r.insertSales([s, s])).toBe(1);
    expect(r.insertSales([{ ...s, saleId: undefined }])).toBe(1);
    expect(r.salesFor(1, 0)).toHaveLength(2);
  });

  it('kv and snapshots', () => {
    const r = openRepository(':memory:');
    r.setKv('a', { x: 1 });
    expect(r.getKv('a')).toEqual({ x: 1 });
    expect(r.getTradeMetadata()).toBeNull();
    expect(r.countItemSnapshots()).toBe(0);
  });
});

describe('retention', () => {
  it('thins old snapshots to one per day, keeps recent ones, drops old sales and stores no lastSales', () => {
    const r = openRepository(':memory:');
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const base = {
      assetId: 7, collectibleItemId: null, itemType: 'Asset', name: 'X', isLimitedU: false, rap: 1, roliValue: null, roliDefaultValue: null,
      roliDemand: null, roliTrend: null, roliProjected: null, roliRare: null, floorPrice: null, resellerCount: null, totalQuantity: null,
      publicCopies: null, sales7d: null, sales30d: null, dailyPrice: [], dailyVolume: [],
      lastSales: [{ assetId: 7, t: 1, price: 1, oldRap: 1, newRap: 1, source: 'rolimons_feed' }], sources: [],
    } as never as Parameters<typeof r.insertItemSnapshot>[0];
    for (const t of [now - 20 * DAY, now - 20 * DAY + 1000, now - 20 * DAY + 2000, now - DAY, now - DAY + 1000]) r.insertItemSnapshot({ ...base, fetchedAt: t });
    r.insertSales([{ assetId: 7, t: 0, price: 5, oldRap: 1, newRap: 2, source: 'rolimons_feed' as const }, { assetId: 7, t: now - DAY, price: 6, oldRap: 1, newRap: 2, source: 'rolimons_feed' as const }]);
    expect(r.latestItemSnapshot(7)!.lastSales).toEqual([]);
    const res = r.prune(now);
    expect(res.snapshots).toBe(2);
    expect(r.countItemSnapshots()).toBe(3);
    expect(r.salesFor(7, 0).length).toBe(1);
  });
});

describe('sales cross-source dedupe (audit 2)', () => {
  it('Sale 4620 (4680 -> 4674) from the feed and the RAP delta is stored once, feed row kept', () => {
    const r = openRepository(':memory:');
    r.migrate();
    const feed = { assetId: 1000001, t: 1_790_000_005_000, price: 4620, oldRap: 4680, newRap: 4674, source: 'rolimons_feed' as const, saleId: '1000' };
    const delta = { assetId: 1000001, t: 1_790_000_000_272, price: 4620, oldRap: 4680, newRap: 4674, source: 'rap_snapshot_delta' as const };
    r.insertSales([feed]);
    expect(r.insertSales([delta])).toBe(0);
    const r2 = openRepository(':memory:');
    r2.migrate();
    r2.insertSales([delta]);
    r2.insertSales([feed]);
    const rows = r2.salesFor(1000001, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('rolimons_feed');
    // A genuinely separate sale at the same price an hour later is kept.
    expect(r2.insertSales([{ ...delta, t: delta.t + 3_600_000 }])).toBe(1);
  });
});
