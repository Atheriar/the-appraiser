/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RobloxClient } from '../adapters/interfaces.js';
import { PARTNER_INV_ERROR_TTL_MS, PARTNER_INV_TTL_MS, PartnerInventory } from './partnerInventory.js';

function kv() {
  const m = new Map<string, unknown>();
  return { getKv: <T>(k: string) => (m.get(k) as T) ?? null, setKv: <T>(k: string, v: T) => { m.set(k, v); } };
}
function client(o: Partial<RobloxClient> = {}): RobloxClient {
  return {
    getTradableItems: vi.fn(async () => ({
      nextPageCursor: null, previousPageCursor: null,
      data: [{
        collectibleItemId: 'c', itemType: 'Asset' as const, targetId: '11', itemName: 'Valk', originalPrice: null, recentAveragePrice: 1000, assetStock: null,
        instances: [{ collectibleItemInstanceId: 'i', serialNumber: 5, isOnHold: true }],
      }],
    })),
    getCollectibles: vi.fn(async () => [
      { userAssetId: 1, assetId: 11, name: 'Valk', serialNumber: 5, recentAveragePrice: 1000, originalPrice: null, assetStock: null, isOnHold: false },
      { userAssetId: 2, assetId: 22, name: 'Dom', serialNumber: null, recentAveragePrice: 500, originalPrice: null, assetStock: null, isOnHold: false },
    ]),
    ...o,
  } as unknown as RobloxClient;
}

describe('PartnerInventory', () => {
  it('merges tradableItems (authoritative) with collectibles and caches 24h', async () => {
    let now = 1_000;
    const pi = new PartnerInventory(kv(), () => now);
    const c = client();
    const r = await pi.ensure(c, 7);
    expect(r!.state).toBe('loaded');
    expect(r!.sources).toEqual(['tradableItems', 'collectibles']);
    expect(r!.items.find((i) => i.assetId === 11)!.isOnHold).toBe(true); // tradable hold flag wins
    expect(r!.items.map((i) => i.assetId).sort()).toEqual([11, 22]);
    await pi.ensure(c, 7);
    expect(c.getTradableItems).toHaveBeenCalledTimes(1);
    now += PARTNER_INV_TTL_MS + 1;
    await pi.ensure(c, 7);
    expect(c.getTradableItems).toHaveBeenCalledTimes(2);
  });

  it('falls back to collectibles when tradableItems fails, and reports hidden', async () => {
    const pi = new PartnerInventory(kv());
    const r = await pi.ensure(client({ getTradableItems: vi.fn(async () => { throw new Error('403'); }) }), 1);
    expect(r!.sources).toEqual(['collectibles']);
    const h = await pi.ensure(client({
      getTradableItems: vi.fn(async () => { throw new Error('x'); }),
      getCollectibles: vi.fn(async () => 'hidden' as const),
    }), 2);
    expect(h!.state).toBe('hidden');
    expect(pi.status(2).state).toBe('hidden');
    expect(pi.status(3).state).toBe('not_loaded');
  });

  it('retries a failed load after the short error TTL but keeps a loaded one 24h', async () => {
    let now = 1_000;
    const pi = new PartnerInventory(kv(), () => now);
    const bad = client({
      getTradableItems: vi.fn(async () => { throw new Error('429'); }),
      getCollectibles: vi.fn(async () => { throw new Error('429'); }),
    });
    expect((await pi.ensure(bad, 4))!.state).toBe('error');
    await pi.ensure(bad, 4);
    expect(bad.getTradableItems).toHaveBeenCalledTimes(1);
    now += PARTNER_INV_ERROR_TTL_MS + 1;
    const good = client();
    expect((await pi.ensure(good, 4))!.state).toBe('loaded');
    now += PARTNER_INV_ERROR_TTL_MS + 1;
    await pi.ensure(good, 4);
    expect(good.getTradableItems).toHaveBeenCalledTimes(1);
  });

  it('keeps tradableItems as a source when a later page fails', async () => {
    let call = 0;
    const base = client();
    const c = client({
      getTradableItems: vi.fn(async (u: number, cursor?: string) => {
        call++;
        if (cursor) throw new Error('429');
        const r = await (base.getTradableItems as (u: number) => Promise<{ data: unknown[] }>)(u);
        return { ...r, nextPageCursor: 'p2' };
      }) as unknown as RobloxClient['getTradableItems'],
    });
    const r = (await new PartnerInventory(kv()).ensure(c, 5))!;
    expect(call).toBe(2);
    expect(r.sources).toEqual(['tradableItems', 'collectibles']);
    expect(r.items.find((i) => i.assetId === 11)!.isOnHold).toBe(true);
  });

  it('dedupes concurrent loads and returns null without a client', async () => {
    const pi = new PartnerInventory(kv());
    const c = client();
    await Promise.all([pi.ensure(c, 9), pi.ensure(c, 9)]);
    expect(c.getTradableItems).toHaveBeenCalledTimes(1);
    expect(await pi.ensure(null, 10)).toBeNull();
  });
});
