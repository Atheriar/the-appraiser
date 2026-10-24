/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import {
  HOLD_FAST_WINDOW_MS, emptyHoldState, estimateHold, fmtHoldLeft, holdBadge, holdLength, holdNeedsFastRefresh, instanceKey,
  matchTradeStart, updateHoldState, type CompletedTradeRef, type HoldInstance,
} from './holds.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1);
const inst = (o: Partial<HoldInstance> = {}): HoldInstance => ({ userAssetId: 501, assetId: 50, serialNumber: 7, isOnHold: true, ...o });
const ref = (tradeId: number, at: number, received: CompletedTradeRef['received'], observed = true): CompletedTradeRef => ({ tradeId, at, observed, received });

describe('hold start matching', () => {
  it('matches by userAssetId, else asset+serial, and takes the latest trade', () => {
    const trades = [
      ref(1, T0 - 5 * DAY, [{ assetId: 50, serial: 7, userAssetId: null }]),
      ref(2, T0 - 1 * DAY, [{ assetId: 50, serial: 7, userAssetId: null }]),
      ref(3, T0 - 2 * HOUR, [{ assetId: 50, serial: 8, userAssetId: null }]),
    ];
    expect(matchTradeStart(inst(), trades, T0)?.tradeId).toBe(2);
    expect(matchTradeStart(inst({ serialNumber: 9 }), trades, T0)).toBeNull();
    const byUa = [ref(4, T0 - HOUR, [{ assetId: 50, serial: 99, userAssetId: 501 }])];
    expect(matchTradeStart(inst(), byUa, T0)?.tradeId).toBe(4);
  });

  it('ignores future trades, trades over 30 days old and ambiguous serial-less copies', () => {
    expect(matchTradeStart(inst(), [ref(1, T0 + HOUR, [{ assetId: 50, serial: 7, userAssetId: null }])], T0)).toBeNull();
    expect(matchTradeStart(inst(), [ref(1, T0 - 31 * DAY, [{ assetId: 50, serial: 7, userAssetId: null }])], T0)).toBeNull();
    const two = [ref(1, T0 - HOUR, [{ assetId: 50, serial: null, userAssetId: null }, { assetId: 50, serial: null, userAssetId: null }])];
    expect(matchTradeStart(inst({ serialNumber: null, userAssetId: -5 }), two, T0)).toBeNull();
    const one = [ref(1, T0 - HOUR, [{ assetId: 50, serial: null, userAssetId: null }])];
    expect(matchTradeStart(inst({ serialNumber: null, userAssetId: -5 }), one, T0)?.tradeId).toBe(1);
  });

  it('starts at the watched completion, else first seen; a later-synced trade upgrades a first-seen start', () => {
    const tr = [ref(9, T0 - 3 * HOUR, [{ assetId: 50, serial: 7, userAssetId: null }])];
    const a = updateHoldState(emptyHoldState(), [inst()], T0, tr);
    const e = a.entries[instanceKey(inst())]!;
    expect(e).toMatchObject({ holdStart: T0 - 3 * HOUR, startBasis: 'trade', tradeId: 9 });

    const b = updateHoldState(emptyHoldState(), [inst()], T0, []);
    expect(b.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0, startBasis: 'first_seen', tradeId: null });
    const c = updateHoldState(b, [inst()], T0 + 30 * MIN, tr);
    expect(c.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0 - 3 * HOUR, startBasis: 'trade', lastSeenOnHold: T0 + 30 * MIN });

    const created = updateHoldState(emptyHoldState(), [inst()], T0, [ref(9, T0 - 3 * HOUR, tr[0]!.received, false)]);
    expect(created.entries[instanceKey(inst())]!.startBasis).toBe('trade_created');
  });

  it('drops copies that left the inventory without recording an observation', () => {
    const a = updateHoldState(emptyHoldState(), [inst()], T0, []);
    const b = updateHoldState(updateHoldState(a, [], T0 + HOUR, []), [], T0 + 2 * DAY, []);
    expect(b.entries).toEqual({});
    expect(b.observations).toEqual([]);
  });
});

describe('hold length and estimate', () => {
  it('uses the assumed length until a trade-started lift is measured', () => {
    const len = holdLength(2, []);
    expect(len).toMatchObject({ ms: 2 * DAY, source: 'assumed', samples: 0 });
    expect(len.label).toContain('unconfirmed');
    const est = estimateHold({ holdStart: T0, startBasis: 'trade', tradeId: 1 }, len, T0 + 20 * HOUR);
    expect(est.releaseAt).toBe(T0 + 2 * DAY);
    expect(est.remainingMs).toBe(28 * HOUR);
    expect(est.overdue).toBe(false);
    expect(holdBadge(est, T0 + 20 * HOUR)).toBe('trade hold · ~1d 4h left (est.)');
  });

  it('switches to the median measured length, rounded up to the poll granularity', () => {
    const obs = [50 * HOUR + 2 * MIN, 48 * HOUR + 1 * MIN, 49 * HOUR].map((d) => ({
      assetId: 1, serial: null, holdStart: T0, startBasis: 'trade' as const, lastSeenOnHold: T0 + d - 5 * MIN, liftSeenAt: T0 + d, durationMs: d, uncertaintyMs: 5 * MIN,
    }));
    const firstSeenOnly = [{ ...obs[0]!, startBasis: 'first_seen' as const, durationMs: HOUR }];
    expect(holdLength(2, firstSeenOnly).source).toBe('assumed');
    const len = holdLength(2, [...obs, ...firstSeenOnly]);
    expect(len).toMatchObject({ ms: 49 * HOUR, source: 'measured', samples: 3 });
    expect(len.label).toBe('2d 1h for trade holds, measured from 3 items');
    const even = holdLength(2, obs.slice(0, 2));
    expect(even.ms).toBe(49 * HOUR + 5 * MIN); // median 49h 1.5m -> next 5 min
  });

  it('records a lift observation with the refresh interval as uncertainty', () => {
    const tr = [ref(9, T0, [{ assetId: 50, serial: 7, userAssetId: null }])];
    let st = updateHoldState(emptyHoldState(), [inst()], T0 + 10 * MIN, tr);
    st = updateHoldState(st, [inst()], T0 + 47 * HOUR + 55 * MIN, tr);
    st = updateHoldState(st, [inst({ isOnHold: false })], T0 + 48 * HOUR, tr);
    expect(st.entries).toEqual({});
    expect(st.observations).toHaveLength(1);
    expect(st.observations[0]).toMatchObject({ durationMs: 48 * HOUR, uncertaintyMs: 5 * MIN, startBasis: 'trade', liftSeenAt: T0 + 48 * HOUR });
    expect(holdLength(2, st.observations)).toMatchObject({ ms: 48 * HOUR, source: 'measured' });
  });

  it('flags the overdue state and asks for fast refresh within 2 h of release', () => {
    const len = holdLength(2, []);
    const est = estimateHold({ holdStart: T0, startBasis: 'first_seen', tradeId: null }, len, T0 + 49 * HOUR);
    expect(est.overdue).toBe(true);
    expect(holdBadge(est, T0 + 49 * HOUR)).toBe('hold (source unknown) · due any time');
    const st = updateHoldState(emptyHoldState(), [inst()], T0, []);
    expect(holdNeedsFastRefresh(st, len, T0 + 2 * DAY - HOLD_FAST_WINDOW_MS - MIN)).toBe(false);
    expect(holdNeedsFastRefresh(st, len, T0 + 2 * DAY - HOLD_FAST_WINDOW_MS)).toBe(true);
    expect(holdNeedsFastRefresh(st, len, T0 + 2 * DAY + 12 * HOUR)).toBe(true);
    expect(holdNeedsFastRefresh(emptyHoldState(), len, T0)).toBe(false);
  });

  it('formats remaining time', () => {
    expect(fmtHoldLeft(30_000)).toBe('<1m');
    expect(fmtHoldLeft(12 * MIN)).toBe('12m');
    expect(fmtHoldLeft(3 * HOUR + 12 * MIN)).toBe('3h 12m');
    expect(fmtHoldLeft(2 * DAY)).toBe('2d');
    expect(holdBadge(null)).toBe('on hold');
  });
});

describe('hold tracker robustness (review fixes)', () => {
  it('a copy missing from one fetch keeps its start, records no lift, and expires after the grace period', () => {
    const a = updateHoldState(emptyHoldState(), [inst()], T0, []);
    const gap = updateHoldState(a, [], T0 + 30 * MIN, []);
    expect(gap.observations).toHaveLength(0);
    expect(gap.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0, missingSince: T0 + 30 * MIN });
    const back = updateHoldState(gap, [inst()], T0 + HOUR, []);
    expect(back.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0, startBasis: 'first_seen' });
    expect(back.entries[instanceKey(inst())]!.missingSince).toBeUndefined();
    const still = updateHoldState(gap, [], T0 + 2 * HOUR, []);
    expect(still.entries[instanceKey(inst())]!.missingSince).toBe(T0 + 30 * MIN);
    expect(updateHoldState(still, [], T0 + 30 * MIN + DAY, []).entries).toEqual({});
  });

  it('a lift is recorded exactly once', () => {
    const a = updateHoldState(emptyHoldState(), [inst()], T0, []);
    const b = updateHoldState(a, [inst({ isOnHold: false })], T0 + HOUR, []);
    const c = updateHoldState(b, [inst({ isOnHold: false })], T0 + 2 * HOUR, []);
    expect(c.observations).toHaveLength(1);
  });

  it('fast refresh ignores missing copies and stops a day past due', () => {
    const len = holdLength(2, []);
    const st = updateHoldState(emptyHoldState(), [inst()], T0, []);
    expect(holdNeedsFastRefresh(st, len, T0 + len.ms - HOUR)).toBe(true);
    expect(holdNeedsFastRefresh(st, len, T0 + len.ms + 23 * HOUR)).toBe(true);
    expect(holdNeedsFastRefresh(st, len, T0 + len.ms + 25 * HOUR)).toBe(false);
    const gone = updateHoldState(st, [], T0 + len.ms - HOUR, []);
    expect(holdNeedsFastRefresh(gone, len, T0 + len.ms - HOUR)).toBe(false);
  });
});
