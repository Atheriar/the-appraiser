/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { openRepository } from '../db/index.js';
import { Analyst } from './analyst.js';
import { fallbackEngine } from './__fakes__/engine.js';
import { MemorySecretStore } from '../secrets/index.js';
import { Logger } from '../server/log.js';
import { NullNotifier } from '../server/notify.js';
import { HOLD_FAST_REFRESH_MS } from '../core/holds.js';
import type { TradeItem, TradeSnapshot } from '../core/types.js';
import type { CollectibleInstance } from '../adapters/interfaces.js';

const HOUR = 3_600_000;

function make() {
  return new Analyst({ repo: openRepository(':memory:'), secrets: new MemorySecretStore(null), engine: fallbackEngine, engineReal: false,
    adapters: null, notifier: new NullNotifier(), log: new Logger(null, false), uiUrl: 'http://127.0.0.1:47615' });
}
const item = (assetId: number, serial: number | null): TradeItem => ({ assetId, itemType: 'Asset', targetId: String(assetId), name: `i${assetId}`, userAssetId: null,
  collectibleItemInstanceId: null, collectibleItemId: null, serialNumber: serial, rap: 100, originalPrice: null, assetStock: null, isOnHold: null, joinKey: 'serial+asset' });
const trade = (id: number, createdAt: number, get: TradeItem[]): TradeSnapshot => ({
  tradeId: id, direction: 'inbound', status: 'Open', statusRaw: 'Open', isActive: true, createdAt, expiresAt: null,
  partner: { userId: 9, name: 'p', displayName: 'p' }, give: { userId: 1, userName: 'me', displayName: 'me', items: [item(77, 1)], robux: 0 },
  get: { userId: 9, userName: 'p', displayName: 'p', items: get, robux: 0 }, fetchedAt: createdAt, hadV1: true, hadV2: true, offerSignature: `s${id}`,
});
const inv = (onHold: boolean): CollectibleInstance => ({ userAssetId: 900, assetId: 50, name: 'i50', serialNumber: 7, recentAveragePrice: 100, originalPrice: null, assetStock: null, isOnHold: onHold });

describe('analyst hold tracking', () => {
  it('uses the watched completion time, refreshes faster near release, and learns the length from a lift', () => {
    const a = make();
    const now = Date.now();
    a.repo.upsertTrade(trade(1, now - 50 * HOUR, [item(50, 7)]));
    a.repo.updateTradeStatus(1, 'Completed', 'Completed', false, now - 47 * HOUR);
    const refs = a.holdTradeRefs();
    expect(refs).toEqual([expect.objectContaining({ tradeId: 1, at: now - 47 * HOUR, observed: true })]);

    a.repo.setKv('ownInventory', { fetchedAt: now, items: [inv(true)] });
    a.trackHolds([inv(true)], now);
    const est = a.holdFor(50, 7, now)!;
    expect(est).toMatchObject({ startBasis: 'trade', tradeId: 1, releaseAt: now + HOUR, lengthSource: 'assumed' });
    expect(a.holdFor(50, 8, now)).toBeNull();
    expect(a.inventoryIntervalMs(now)).toBe(HOLD_FAST_REFRESH_MS);
    expect(a.inventoryIntervalMs(now - 10 * HOUR)).toBe(a.settings().poll.ownInventoryMs);

    a.trackHolds([inv(false)], now + 2 * HOUR);
    expect(a.holdState().observations).toHaveLength(1);
    expect(a.holdLength()).toMatchObject({ source: 'measured', samples: 1, ms: 49 * HOUR });
    expect(a.inventoryIntervalMs(now + 2 * HOUR)).toBe(a.settings().poll.ownInventoryMs);
    a.stop();
  });

  it('a trade first seen already completed starts at its creation time (not used for measurement)', () => {
    const a = make();
    const now = Date.now();
    const t = trade(2, now - 10 * HOUR, [item(50, 7)]);
    a.repo.upsertTrade({ ...t, status: 'Completed', statusRaw: 'Completed', isActive: false });
    expect(a.holdTradeRefs()[0]).toMatchObject({ at: now - 10 * HOUR, observed: false });
    a.trackHolds([inv(true)], now);
    a.trackHolds([inv(false)], now + HOUR);
    expect(a.holdLength().source).toBe('assumed');
    a.stop();
  });
});
