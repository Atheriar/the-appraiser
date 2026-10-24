/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_URL_RE, catalogUrl, detectionLagMs, dropKey, flipEstimate, isPurchasable, isRecent, isTradable, isUpcoming, matchesNotify, median, parseDeadline, parseScheduledRelease, RELEASE_GRACE_MS, saleStatusFrom } from './drops.js';
import { feedIntervals, releaseCheckGapMs } from '../jobs/drops.js';
import { DEFAULT_SETTINGS, type DropItem } from './types.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const drop = (p: Partial<DropItem> = {}): DropItem => ({
  key: 'k', assetId: 123, itemType: 'Asset', collectibleItemId: 'k', name: 'X', creatorName: 'Roblox', creatorId: 1, creatorType: 'User',
  creatorVerified: true, tradable: true, restrictions: ['Limited'], price: 1000, totalQuantity: 5000, remaining: 3000, sales: 2000,
  limitPerUser: 1, saleLocation: 'ShopOnly', inGameOnly: false, offSaleDeadline: null, lowestResalePrice: null, hasResellers: false,
  favoriteCount: 0, thumbnailUrl: null, createdAt: NOW - 60_000, firstSeenAt: NOW - 55_000, updatedAt: NOW, stockUpdatedAt: NOW,
  soldOutAt: null, notifiedAt: null, ...p,
});

describe('drops: classification', () => {
  it('tradable only for Roblox-made Limited / LimitedUnique', () => {
    expect(isTradable(1, 'User', ['Limited'])).toBe(true);
    expect(isTradable(1, 'User', ['LimitedUnique'])).toBe(true);
    expect(isTradable(1, 'User', ['Collectible'])).toBe(false);
    expect(isTradable(815206396, 'Group', ['Collectible'])).toBe(false);
    expect(isTradable(1, 'Group', ['Limited'])).toBe(false); // group 1 is not Roblox
    expect(isTradable(4242, 'User', ['Limited'])).toBe(false);
  });
  it('0001-01-01 means no deadline; catalog links are exact', () => {
    expect(parseDeadline('0001-01-01T00:00:00')).toBeNull();
    expect(parseDeadline(null)).toBeNull();
    expect(parseDeadline('2026-10-22T00:00:00Z')).toBe(Date.parse('2026-10-22T00:00:00Z'));
    expect(catalogUrl(1029025)).toBe('https://www.roblox.com/catalog/1029025');
    expect(CATALOG_URL_RE.test(catalogUrl(5, 'Bundle'))).toBe(true);
    expect(CATALOG_URL_RE.test('https://www.roblox.com/catalog/5/../../evil')).toBe(false);
    expect(CATALOG_URL_RE.test('https://www.roblox.com.evil.com/catalog/5')).toBe(false);
    expect(dropKey(null, 'Bundle', 9)).toBe('Bundle:9');
  });
});

describe('drops: flip estimate', () => {
  it('uses lowest resale after the 30% fee and stays low-confidence while in stock', () => {
    const f = flipEstimate(drop({ lowestResalePrice: 4000 }), { roliValue: null, rap: null }, 0.3, NOW);
    expect(f).toMatchObject({ basis: 'resale', refPrice: 4000, net: 2800, profit: 1800, confidence: 'low' });
    expect(f.profitPct).toBeCloseTo(1.8);
  });
  it('sold out for a while -> medium; a loss is negative', () => {
    const f = flipEstimate(drop({ remaining: 0, lowestResalePrice: 1200, createdAt: NOW - 3_600_000 }), { roliValue: null, rap: null }, 0.3, NOW);
    expect(f.confidence).toBe('medium');
    expect(f.profit).toBe(840 - 1000);
  });
  it('falls back to Rolimons value then RAP; none when nothing is known', () => {
    const old = { remaining: 0, createdAt: NOW - 3_600_000 };
    expect(flipEstimate(drop(old), { roliValue: 5000, rap: 9000 }, 0.3, NOW)).toMatchObject({ basis: 'value', profit: 2500, confidence: 'high' });
    expect(flipEstimate(drop(), { roliValue: null, rap: 2000 }, 0.3, NOW)).toMatchObject({ basis: 'rap', profit: 400 });
    expect(flipEstimate(drop(), { roliValue: null, rap: null }, 0.3, NOW)).toMatchObject({ basis: null, profit: null, confidence: 'none' });
  });
  it('free (price 0) drops have a profit but no percentage; in-game only is noted', () => {
    const f = flipEstimate(drop({ price: 0, lowestResalePrice: 100, inGameOnly: true }), { roliValue: null, rap: null }, 0.3, NOW);
    expect(f.profit).toBe(70);
    expect(f.profitPct).toBeNull();
    expect(f.note).toMatch(/in-game only/);
  });
});

describe('drops: flip confidence never high while in stock or just sold out', () => {
  it('Rolimons value and RAP are low while in stock / sold out < 15 min', () => {
    expect(flipEstimate(drop(), { roliValue: 5000, rap: null }, 0.3, NOW)).toMatchObject({ basis: 'value', confidence: 'low' });
    expect(flipEstimate(drop({ remaining: 0 }), { roliValue: 5000, rap: null }, 0.3, NOW)).toMatchObject({ basis: 'value', confidence: 'low' });
    expect(flipEstimate(drop(), { roliValue: null, rap: 2000 }, 0.3, NOW).confidence).toBe('low');
    expect(flipEstimate(drop({ remaining: 0, createdAt: NOW - 3_600_000 }), { roliValue: null, rap: 2000 }, 0.3, NOW).confidence).toBe('medium');
  });
});

describe('drops: notification filters', () => {
  const s = DEFAULT_SETTINGS.drops;
  it('defaults: on, tradable only, any price, never for sold out', () => {
    expect(matchesNotify(drop(), s)).toBe(true);
    expect(matchesNotify(drop({ tradable: false }), s)).toBe(false);
    expect(matchesNotify(drop({ remaining: 0 }), s)).toBe(false);
    expect(matchesNotify(drop(), { ...s, notify: false })).toBe(false);
  });
  it('max price and min quantity', () => {
    expect(matchesNotify(drop({ price: 1500 }), { ...s, notifyMaxPrice: 1000 })).toBe(false);
    expect(matchesNotify(drop({ price: 900 }), { ...s, notifyMaxPrice: 1000 })).toBe(true);
    expect(matchesNotify(drop({ remaining: 50 }), { ...s, notifyMinQuantity: 100 })).toBe(false);
    expect(matchesNotify(drop({ tradable: false }), { ...s, notifyTradableOnly: false })).toBe(true);
  });
});

describe('drops: timed releases and detection lag', () => {
  it('maps productSaleStatus and parses scheduledRelease in any reasonable shape', () => {
    expect([3, 2, 1, '3', 'OnSale', 0, null].map(saleStatusFrom)).toEqual(['onSale', 'offSale', 'pending', 'onSale', 'onSale', null, null]);
    const t = Date.parse('2026-10-21T18:00:00Z');
    expect(parseScheduledRelease('2026-10-21T18:00:00Z')).toBe(t);
    expect(parseScheduledRelease(t / 1000)).toBe(t);
    expect(parseScheduledRelease({ endTime: '2026-12-01T00:00:00Z', startTime: '2026-10-21T18:00:00Z' })).toBe(t);
    expect(parseScheduledRelease('0001-01-01T00:00:00')).toBeNull();
    expect(parseScheduledRelease({})).toBeNull();
  });

  it('upcoming until on sale (or 10 min past release); purchasable only when on sale and in stock', () => {
    const R = NOW + 60_000;
    expect(isUpcoming(drop({ releaseAt: R, saleStatus: 'pending' }), NOW)).toBe(true);
    expect(isUpcoming(drop({ releaseAt: R, saleStatus: 'onSale' }), NOW)).toBe(false);
    expect(isUpcoming(drop({ releaseAt: R, releasedAt: NOW }), NOW)).toBe(false);
    expect(isUpcoming(drop({ releaseAt: NOW - 60_000, saleStatus: 'offSale' }), NOW)).toBe(true);
    expect(isUpcoming(drop({ releaseAt: NOW - RELEASE_GRACE_MS - 1, saleStatus: 'offSale' }), NOW)).toBe(false);
    expect(isUpcoming(drop(), NOW)).toBe(false);
    expect(isPurchasable(drop({ saleStatus: 'onSale' }), NOW)).toBe(true);
    expect(isPurchasable(drop({ saleStatus: 'offSale' }), NOW)).toBe(false);
    expect(isPurchasable(drop({ saleStatus: 'onSale', remaining: 0 }), NOW)).toBe(false);
    expect(isPurchasable(drop({ saleStatus: 'onSale', inGameOnly: true }), NOW)).toBe(false);
    expect(isPurchasable(drop({ saleStatus: null, releaseAt: R }), NOW)).toBe(false);
    // An old item released today counts as recent.
    expect(isRecent(drop({ createdAt: NOW - 5 * 86_400_000, releaseAt: NOW - 3_600_000 }), 86_400_000, NOW)).toBe(true);
  });

  it('detection lag only for live-seen rows; median', () => {
    expect(detectionLagMs(drop({ seenLive: true, createdAt: NOW - 100, firstSeenAt: NOW }))).toBe(100);
    expect(detectionLagMs(drop({ seenLive: false }))).toBeNull();
    expect(detectionLagMs(drop({ seenLive: true, createdAt: null }))).toBeNull();
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
  });

  it('release recheck cadence tightens around the release time', () => {
    const R = NOW;
    expect(releaseCheckGapMs(R - 30 * 60_000, R)).toBeNull();
    expect(releaseCheckGapMs(R - 5 * 60_000, R)).toBe(30_000);
    expect(releaseCheckGapMs(R - 30_000, R)).toBe(10_000);
    expect(releaseCheckGapMs(R - 2_000, R)).toBe(2_500);
    expect(releaseCheckGapMs(R + 60_000, R)).toBe(2_500);
    expect(releaseCheckGapMs(R + 5 * 60_000, R)).toBe(15_000);
    expect(releaseCheckGapMs(R + 11 * 60_000, R)).toBeNull();
  });

  it('feed intervals are scaled so both feeds together stay <= 6 searches / min', () => {
    const d = DEFAULT_SETTINGS.drops;
    expect(feedIntervals(d)).toEqual({ roblox: 20_000, all: 20_000 });
    const old = feedIntervals({ ...d, robloxPollMs: 10_000, allPollMs: 20_000 }); // 9 / min before
    expect(60_000 / old.roblox + 60_000 / old.all).toBeLessThanOrEqual(6.001);
    expect(feedIntervals({ ...d, robloxPollMs: 10_000, includeUgc: false })).toEqual({ roblox: 10_000, all: 20_000 });
  });
});

describe('drops: Include UGC off', () => {
  it('never notifies for UGC drops even when tradable-only notifications are off', () => {
    const s = { ...DEFAULT_SETTINGS.drops, notifyTradableOnly: false, includeUgc: false };
    expect(matchesNotify(drop({ tradable: false }), s)).toBe(false);
    expect(matchesNotify(drop({ tradable: true }), s)).toBe(true);
  });
});
