/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import type { CollectibleInstance, TradableItem } from '../adapters/interfaces.js';
import { mergeTradableIntoInventory } from './inventoryMerge.js';

const classic: CollectibleInstance[] = [{ userAssetId: 11, assetId: 2000001, name: 'Example Classic', serialNumber: null, recentAveragePrice: 17_000, originalPrice: null, assetStock: null, isOnHold: false }];
const tradable = (o: Partial<TradableItem>): TradableItem => ({
  collectibleItemId: 'c-1', itemType: 'Asset', targetId: '12803855954', itemName: 'Glossy Red Baseball Cap', originalPrice: 105,
  recentAveragePrice: 120, assetStock: 10_000_000, instances: [{ collectibleItemInstanceId: 'i-1', serialNumber: 4242, isOnHold: true }], ...o,
});

describe('mergeTradableIntoInventory', () => {
  it('adds a Limited 2.0 collectible missing from the classic list, keeping serial and hold', () => {
    const out = mergeTradableIntoInventory(classic, [tradable({})]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ assetId: 12803855954, name: 'Glossy Red Baseball Cap', serialNumber: 4242, isOnHold: true, recentAveragePrice: 120 });
    expect(out[1]!.userAssetId).toBeLessThan(0);
  });
  it('does not duplicate assets already in the classic list, and skips bundles', () => {
    const out = mergeTradableIntoInventory(classic, [tradable({ targetId: '2000001' }), tradable({ itemType: 'Bundle', targetId: '999' })]);
    expect(out).toHaveLength(1);
  });
  it('one row per owned copy, stable ids across refreshes', () => {
    const t = tradable({ instances: [{ collectibleItemInstanceId: 'a', serialNumber: 1, isOnHold: false }, { collectibleItemInstanceId: 'b', serialNumber: 2, isOnHold: false }] });
    const a = mergeTradableIntoInventory([], [t]), b = mergeTradableIntoInventory([], [t]);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.userAssetId)).toEqual(b.map((x) => x.userAssetId));
    expect(a[0]!.userAssetId).not.toBe(a[1]!.userAssetId);
  });
});

import { withListDate } from './analyst.js';
describe('withListDate', () => {
  it('replaces a fetch-time stamp with the trade list date', () => {
    const t = { createdAt: Date.parse('2026-10-20T13:26:00Z') };
    expect(withListDate(t, { created: Date.parse('2018-05-01T00:00:00Z') }).createdAt).toBe(Date.parse('2018-05-01T00:00:00Z'));
  });
  it('keeps the same object when dates already agree or the list date is missing', () => {
    const t = { createdAt: 1_700_000_000_000 };
    expect(withListDate(t, { created: 1_700_000_010_000 })).toBe(t);
    expect(withListDate(t, { created: 0 })).toBe(t);
  });
});
