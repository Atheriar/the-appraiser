/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { joinItems, parseTradeStatus, offerSignature, buildTradeSnapshot } from './join.js';

describe('parseTradeStatus (lenient)', () => {
  it('maps names, odd casing and ints; unknown -> Unknown', () => {
    expect(parseTradeStatus('Open')).toBe('Open');
    expect(parseTradeStatus('two_step_verification_required')).toBe('TwoStepVerificationRequired');
    expect(parseTradeStatus(8)).toBe('Countered');
    expect(parseTradeStatus('SomethingNew')).toBe('Unknown');
    expect(parseTradeStatus(null)).toBe('Unknown');
  });
});

describe('joinItems', () => {
  const v1 = (assetId: number, id: number, serialNumber: number | null) => ({ id, assetId, serialNumber, name: 'x', recentAveragePrice: 10, originalPrice: null, assetStock: null, membershipType: null });
  const v2 = (targetId: string, serialNumber: number | null, inst: string, isOnHold = false) => ({ collectibleItemInstanceId: inst, itemTarget: { itemType: 'Asset', targetId }, itemName: 'x', serialNumber, isOnHold, originalPrice: null, recentAveragePrice: 10, assetStock: null });

  it('matches serialised duplicates by serial regardless of order', () => {
    const out = joinItems([v1(5, 1, 20), v1(5, 2, 10)], [v2('5', 10, 'b', true), v2('5', 20, 'a')]);
    expect(out.map((o) => [o.userAssetId, o.collectibleItemInstanceId, o.isOnHold, o.joinKey])).toEqual([
      [1, 'a', false, 'serial+asset'], [2, 'b', true, 'serial+asset'],
    ]);
  });

  it('keeps unmatched rows as v1_only / v2_only', () => {
    const out = joinItems([v1(5, 1, null)], [v2('6', null, 'z')]);
    expect(out.map((o) => o.joinKey)).toEqual(['v1_only', 'v2_only']);
    expect(out[1]!.assetId).toBe(6);
  });

  it('serial 0 is treated as no serial', () => {
    expect(joinItems([v1(5, 1, 0)], null)[0]!.serialNumber).toBeNull();
  });
});

describe('offerSignature', () => {
  it('is order independent', () => {
    const side = (ids: number[], robux = 0) => ({ userId: 1, userName: '', displayName: '', robux, items: ids.map((assetId) => ({ assetId } as never)) });
    expect(offerSignature(side([1, 2]), side([3]))).toBe(offerSignature(side([2, 1]), side([3])));
    expect(offerSignature(side([1, 2]), side([3]))).not.toBe(offerSignature(side([3]), side([1, 2])));
  });
});

describe('buildTradeSnapshot', () => {
  it('works with v2 only and no user ids (inbound => A is partner)', () => {
    const t = buildTradeSnapshot({
      tradeId: 1, me: 1, direction: 'inbound', v1: null, now: 5,
      v2: { tradeId: 1, status: 'Open', participantAOffer: { robux: 0, items: [{ itemTarget: { itemType: 'Asset', targetId: '9' }, itemName: 'P', serialNumber: null, recentAveragePrice: null, originalPrice: null, assetStock: null }] }, participantBOffer: { robux: 0, items: [] } },
    });
    expect(t.get.items[0]!.assetId).toBe(9);
    expect(t.give.items).toHaveLength(0);
    expect(t.isActive).toBe(true);
    expect(t.hadV1).toBe(false);
  });
});
