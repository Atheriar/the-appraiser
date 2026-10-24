/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Overvaluation audit regressions for the data plumbing (snapshots, join, Rolimons sale reconstruction). */
import { describe, expect, it } from 'vitest';
import { emptySnapshot, marketSnapshot } from './snapshots.js';
import { buildTradeSnapshot } from '../adapters/roblox/join.js';
import { reconstructSalePrice } from '../adapters/rolimons/client.js';

const NOW = Date.UTC(2026, 9, 20);

describe('overvaluation audit: market snapshot freshness', () => {
  const prev = { ...emptySnapshot(1, 'x', NOW - 86_400_000), rap: 10_000, floorPrice: 10_000, resellerCount: 5 };

  it('a failed reseller + resale fetch keeps the old fetchedAt (goes stale) instead of stamping old data fresh', () => {
    const s = marketSnapshot(prev, null, null, NOW);
    expect(s.fetchedAt).toBe(prev.fetchedAt);
  });

  it('fresh resale data without a sell book drops the carried-over floor', () => {
    const s = marketSnapshot(prev, {
      source: 'marketplace_sales', recentAveragePrice: 9_000, originalPrice: null, assetStock: null, numberRemaining: null, sales: null,
      priceDataPoints: [], volumeDataPoints: [], newestPointAt: null, stale: false,
    }, null, NOW);
    expect(s.fetchedAt).toBe(NOW);
    expect(s.floorPrice).toBeNull();
    expect(s.resellerCount).toBeNull();
  });
});

describe('overvaluation audit: v2 side assignment', () => {
  it('when only one v2 offer carries a (partner) id, that offer is theirs even if it is participant B', () => {
    const item = (id: string) => ({ itemTarget: { itemType: 'Asset', targetId: id }, itemName: id, serialNumber: null, recentAveragePrice: null, originalPrice: null, assetStock: null });
    const t = buildTradeSnapshot({
      tradeId: 1, me: 1, direction: 'inbound', v1: null, now: 5,
      v2: { tradeId: 1, status: 'Open', participantAOffer: { robux: 0, items: [item('11')] }, participantBOffer: { userId: 2, robux: 0, items: [item('22')] } },
    });
    expect(t.give.items.map((i) => i.assetId)).toEqual([11]);
    expect(t.get.items.map((i) => i.assetId)).toEqual([22]);
  });
});

describe('overvaluation audit: Rolimons sale reconstruction', () => {
  it('a steep RAP drop reconstructs to a low sale at the new RAP, not 0 (which was then filtered out)', () => {
    expect(reconstructSalePrice(1_000, 880)).toBe(880);
  });
});
