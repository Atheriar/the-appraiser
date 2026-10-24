/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyHoldState, estimateHold, holdBadge, holdLengths, holdNeedsFastRefresh, holdTooltip, instanceKey, matchPurchaseStart, updateHoldState,
  type CompletedTradeRef, type HoldInstance, type HoldObservation,
} from './holds.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 10);
const inst = (o: Partial<HoldInstance> = {}): HoldInstance => ({ userAssetId: 501, assetId: 50, serialNumber: 7, isOnHold: true, ...o });
const tref = (tradeId: number, at: number): CompletedTradeRef => ({ tradeId, at, observed: true, received: [{ assetId: 50, serial: 7, userAssetId: null }] });
const obs = (startBasis: HoldObservation['startBasis'], d: number): HoldObservation => ({
  assetId: 1, serial: null, holdStart: T0, startBasis, lastSeenOnHold: T0 + d - 5 * MIN, liftSeenAt: T0 + d, durationMs: d, uncertaintyMs: 5 * MIN,
});

describe('hold kinds: purchase matching', () => {
  it('takes the most recent purchase of the asset before first seen, within 30 days', () => {
    const ps = [{ assetId: 50, at: T0 - 3 * DAY }, { assetId: 50, at: T0 - HOUR }, { assetId: 50, at: T0 + HOUR }, { assetId: 51, at: T0 - MIN }];
    expect(matchPurchaseStart(50, ps, T0)).toEqual({ assetId: 50, at: T0 - HOUR });
    expect(matchPurchaseStart(50, [{ assetId: 50, at: T0 - 31 * DAY }], T0)).toBeNull();
    expect(matchPurchaseStart(52, ps, T0)).toBeNull();
  });

  it('a held copy with no trade match starts at its purchase (kind purchase); a trade match wins', () => {
    const st = updateHoldState(emptyHoldState(), [inst()], T0, [], [{ assetId: 50, at: T0 - 2 * HOUR }]);
    expect(st.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0 - 2 * HOUR, startBasis: 'purchase', kind: 'purchase', tradeId: null });
    const both = updateHoldState(emptyHoldState(), [inst()], T0, [tref(3, T0 - HOUR)], [{ assetId: 50, at: T0 - 2 * HOUR }]);
    expect(both.entries[instanceKey(inst())]).toMatchObject({ startBasis: 'trade', kind: 'trade', tradeId: 3 });
  });

  it('no trade or purchase -> unknown; purchases fetched later upgrade it; a later trade beats a purchase', () => {
    const a = updateHoldState(emptyHoldState(), [inst()], T0, []);
    expect(a.entries[instanceKey(inst())]).toMatchObject({ startBasis: 'first_seen', kind: 'unknown' });
    const b = updateHoldState(a, [inst()], T0 + 30 * MIN, [], [{ assetId: 50, at: T0 - 5 * HOUR }, { assetId: 50, at: T0 + 10 * MIN }]);
    expect(b.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0 - 5 * HOUR, kind: 'purchase' });
    const c = updateHoldState(b, [inst()], T0 + HOUR, [tref(8, T0 - 4 * HOUR)], [{ assetId: 50, at: T0 - 5 * HOUR }]);
    expect(c.entries[instanceKey(inst())]).toMatchObject({ holdStart: T0 - 4 * HOUR, kind: 'trade', tradeId: 8 });
  });

  it('lift observations are tagged with their kind; legacy entries without kind derive it', () => {
    const a = updateHoldState(emptyHoldState(), [inst()], T0, [], [{ assetId: 50, at: T0 - HOUR }]);
    const b = updateHoldState(a, [inst({ isOnHold: false })], T0 + 3 * DAY, []);
    expect(b.observations[0]).toMatchObject({ kind: 'purchase', startBasis: 'purchase', durationMs: 3 * DAY + HOUR });
    const legacy = { entries: { k: { key: 'k', assetId: 50, serial: 7, holdStart: T0, startBasis: 'trade' as const, tradeId: 1, firstSeenOnHold: T0, lastSeenOnHold: T0 } }, observations: [] };
    expect(estimateHold(legacy.entries.k, holdLengths(2, 3, []), T0).kind).toBe('trade');
  });
});

describe('hold kinds: per-kind lengths', () => {
  it('each kind calibrates from its own median; first-seen lifts never calibrate', () => {
    const o = [obs('trade', 48 * HOUR), obs('trade', 50 * HOUR), obs('trade', 49 * HOUR), obs('purchase', 4 * DAY), obs('first_seen', HOUR), obs('trade_created', HOUR)];
    const L = holdLengths(2, 3, o);
    expect(L.trade).toMatchObject({ ms: 49 * HOUR, source: 'measured', samples: 3, kind: 'trade' });
    expect(L.purchase).toMatchObject({ ms: 4 * DAY, source: 'measured', samples: 1, kind: 'purchase' });
    expect(L.purchase.label).toContain('purchase holds, measured from 1 item');
  });

  it('assumed defaults: trade 2 d, purchase 3 d, both unconfirmed', () => {
    const L = holdLengths(2, 3, []);
    expect(L.trade).toMatchObject({ ms: 2 * DAY, source: 'assumed' });
    expect(L.purchase).toMatchObject({ ms: 3 * DAY, source: 'assumed' });
    expect(L.purchase.label).toContain('unconfirmed');
    expect(holdLengths(2, NaN, []).purchase.ms).toBe(3 * DAY);
  });

  it('unknown uses the larger of the two and says so', () => {
    const L = holdLengths(2, 3, []);
    expect(L.unknown).toMatchObject({ ms: 3 * DAY, kind: 'unknown' });
    expect(L.unknown.label).toContain('larger of the trade and purchase');
    const big = holdLengths(5, 3, []);
    expect(big.unknown.ms).toBe(5 * DAY);
    const st = updateHoldState(emptyHoldState(), [inst()], T0, []);
    const est = estimateHold(st.entries[instanceKey(inst())]!, L, T0 + 49 * HOUR);
    expect(est).toMatchObject({ kind: 'unknown', lengthIsMax: true, overdue: false, releaseAt: T0 + 3 * DAY });
    expect(holdBadge(est, T0 + 49 * HOUR)).toBe('hold (source unknown) · ~23h left (est.)');
    expect(holdTooltip(est)).toContain('larger of the trade and purchase lengths');
  });

  it('badge / tooltip name the kind and the basis; fast refresh uses the per-entry length', () => {
    const L = holdLengths(2, 3, [obs('purchase', 4 * DAY)]);
    const st = updateHoldState(emptyHoldState(), [inst()], T0, [], [{ assetId: 50, at: T0 }]);
    const est = estimateHold(st.entries[instanceKey(inst())]!, L, T0 + DAY);
    expect(holdBadge(est, T0 + DAY)).toBe('purchase hold · ~3d left (est.)');
    expect(holdTooltip(est)).toMatch(/^Purchase hold\. .*transaction history.*measured from 1 item/);
    expect(holdNeedsFastRefresh(st, L, T0 + 2 * DAY)).toBe(false); // a trade-length check would say true
    expect(holdNeedsFastRefresh(st, L, T0 + 4 * DAY - HOUR)).toBe(true);
    const tr = estimateHold({ holdStart: T0, startBasis: 'trade', tradeId: 4 }, L, T0 + HOUR);
    expect(holdTooltip(tr)).toMatch(/^Trade hold\. .*trade 4.*assumed, unconfirmed/);
  });
});
