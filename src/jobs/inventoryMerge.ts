/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * The classic collectibles endpoint only lists Limited / Limited U assets. Newer "Collectible"
 * (Limited 2.0) items only show up in the trades API's tradableItems list, so own-inventory merges
 * both: every tradable asset instance the classic list lacks is added (bundles are skipped; the
 * valuation engine is keyed by asset id).
 */
import type { CollectibleInstance, TradableItem } from '../adapters/interfaces.js';

/** Stable negative pseudo userAssetId for instances that only have a collectibleItemInstanceId. */
function pseudoUserAssetId(instanceId: string): number {
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) h = (Math.imul(h, 31) + instanceId.charCodeAt(i)) | 0;
  return -(Math.abs(h) || 1);
}

export function mergeTradableIntoInventory(classic: CollectibleInstance[], tradable: TradableItem[]): CollectibleInstance[] {
  const have = new Set(classic.map((i) => i.assetId));
  const out = [...classic];
  for (const t of tradable) {
    if (t.itemType !== 'Asset') continue;
    const assetId = Number(t.targetId);
    if (!Number.isFinite(assetId) || assetId <= 0 || have.has(assetId)) continue;
    const instances = t.instances.length ? t.instances : [{ collectibleItemInstanceId: `${t.collectibleItemId}:0`, serialNumber: null, isOnHold: false }];
    for (const ins of instances) {
      out.push({
        userAssetId: pseudoUserAssetId(ins.collectibleItemInstanceId), assetId, name: t.itemName,
        serialNumber: ins.serialNumber, recentAveragePrice: t.recentAveragePrice ?? 0, originalPrice: t.originalPrice,
        assetStock: t.assetStock, isOnHold: ins.isOnHold,
      });
    }
  }
  return out;
}
