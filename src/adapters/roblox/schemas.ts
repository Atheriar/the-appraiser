/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Lenient zod schemas for Roblox payloads. Unknown fields are stripped. */
import { z } from 'zod';

export const numish = z.union([z.number(), z.string()]).transform((v) => (typeof v === 'number' ? v : Number(v)));
const optNum = numish.nullish().transform((v) => (v == null || !Number.isFinite(v) ? null : v));
const dateish = z.union([z.string(), z.number()]).nullish();
/** Id that Roblox may send as a string or a number; normalised to a string. */
const idish = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * Array whose entries are parsed one by one: an entry that does not match (a null id on a moderated
 * item, an extra shape) is dropped instead of failing the whole page. Dropped entries are counted in
 * `lenientDrops` so a broad shape change still shows up.
 */
export const lenientDrops = { count: 0 };
export function lenientArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(z.unknown()).transform((arr) => {
    const out: Array<z.output<T>> = [];
    for (const x of arr) {
      const r = item.safeParse(x);
      if (r.success) out.push(r.data); else lenientDrops.count++;
    }
    return out;
  });
}

export const UserLite = z.object({
  id: numish,
  name: z.string().nullish(),
  displayName: z.string().nullish(),
});

export const AuthenticatedUserSchema = z.object({ id: numish, name: z.string(), displayName: z.string().nullish() });

export const TradeListSchema = z.object({
  previousPageCursor: z.string().nullish(),
  nextPageCursor: z.string().nullish(),
  data: z.array(z.object({
    id: numish,
    user: UserLite.nullish(),
    created: dateish,
    expiration: dateish,
    isActive: z.boolean().nullish(),
    status: z.union([z.string(), z.number()]).nullish(),
  })),
});

export const CountSchema = z.object({ count: numish });

export const V1UserAsset = z.object({
  id: optNum,                 // userAssetId
  serialNumber: optNum,
  assetId: numish,
  name: z.string().nullish(),
  recentAveragePrice: optNum,
  originalPrice: optNum,
  assetStock: optNum,
  membershipType: z.union([z.string(), z.number()]).nullish(),
});

export const V1Offer = z.object({
  user: UserLite.nullish(),
  userAssets: lenientArray(V1UserAsset).nullish(),
  robux: optNum,
});

export const V1DetailSchema = z.object({
  id: numish.nullish(),
  user: UserLite.nullish(),
  offers: lenientArray(V1Offer).nullish(),
  created: dateish,
  expiration: dateish,
  isActive: z.boolean().nullish(),
  status: z.union([z.string(), z.number()]).nullish(),
});

export const V2Item = z.object({
  collectibleItemInstanceId: z.string().nullish(),
  collectibleItemId: z.string().nullish(),
  itemTarget: z.object({
    itemType: z.union([z.string(), z.number()]).nullish(),
    targetId: z.union([z.string(), z.number()]).nullish(),
  }).nullish(),
  itemName: z.string().nullish(),
  serialNumber: optNum,
  originalPrice: optNum,
  recentAveragePrice: optNum,
  assetStock: optNum,
  isOnHold: z.boolean().nullish(),
});

export const V2Offer = z.object({
  user: UserLite.nullish(),
  userId: numish.nullish(),
  items: lenientArray(V2Item).nullish(),
  robux: optNum,
});

export const V2DetailSchema = z.object({
  tradeId: numish.nullish(),
  status: z.union([z.string(), z.number()]).nullish(),
  participantAOffer: V2Offer.nullish(),
  participantBOffer: V2Offer.nullish(),
});

export const MetadataSchema = z.object({
  maxItemsPerSide: optNum,
  minValueRatio: optNum,
  tradeSystemMaxRobuxPercent: optNum,
  tradeSystemRobuxFee: optNum,
});

export const CanTradeSchema = z.object({
  canTrade: z.boolean().nullish(),
  tradeEligibility: z.union([z.string(), z.number()]).nullish(),
  // Roblox reshapes these occasionally (2026-10: currencyTransferEligibility became non-string after
  // Roblox Plus); a shape change must never break the whole can-trade check.
  freeTradesAllowance: z.object({ limit: optNum, remaining: optNum, window: z.union([z.string(), z.number()]).nullish() }).nullish().catch(null),
  currencyTransferEligibility: z.unknown(),
});

/** economy v2 transactions page (lenient: odd rows dropped, unknown fields kept). */
export const TransactionsSchema = z.object({
  previousPageCursor: z.string().nullish(),
  nextPageCursor: z.string().nullish(),
  data: lenientArray(z.object({
    id: z.union([z.number(), z.string()]).nullish(),
    created: z.union([z.string(), z.number()]).nullish(),
    isPending: z.boolean().nullish(),
    details: z.object({ id: z.union([z.number(), z.string()]).nullish(), name: z.string().nullish(), type: z.union([z.string(), z.number()]).nullish() }).passthrough().nullish(),
  }).passthrough()),
}).passthrough();

export const TradableItemsSchema = z.object({
  previousPageCursor: z.string().nullish(),
  nextPageCursor: z.string().nullish(),
  items: lenientArray(z.object({
    collectibleItemId: idish,
    itemTarget: z.object({ itemType: z.union([z.string(), z.number()]).nullish(), targetId: z.union([z.string(), z.number()]).nullish() }).nullish(),
    itemName: z.string().nullish(),
    originalPrice: optNum,
    recentAveragePrice: optNum,
    assetStock: optNum,
    instances: lenientArray(z.object({
      collectibleItemInstanceId: idish,
      serialNumber: optNum,
      isOnHold: z.boolean().nullish(),
    })).nullish(),
  })).nullish(),
  data: z.array(z.unknown()).nullish(),
});

export const CatalogEntry = z.object({
  id: numish,
  itemType: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  collectibleItemId: z.string().nullish(),
  itemRestrictions: z.array(z.string()).nullish(),
  lowestResalePrice: optNum,
  lowestPrice: optNum,
  totalQuantity: optNum,
  hasResellers: z.boolean().nullish(),
  isOffSale: z.boolean().nullish(),
  favoriteCount: optNum,
  creatorName: z.string().nullish(),
  itemCreatedUtc: z.string().nullish(),
});
export const CatalogSearchRow = z.object({
  id: numish,
  itemType: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  itemRestrictions: z.array(z.string()).nullish(),
  creatorHasVerifiedBadge: z.boolean().nullish(),
  creatorType: z.string().nullish(),
  creatorTargetId: numish.nullish(),
  creatorName: z.string().nullish(),
  price: optNum,
  lowestPrice: optNum,
  lowestResalePrice: optNum,
  unitsAvailableForConsumption: optNum,
  favoriteCount: optNum,
  offSaleDeadline: z.string().nullish(),
  collectibleItemId: z.string().nullish(),
  totalQuantity: optNum,
  saleLocationType: z.union([z.string(), z.number()]).nullish(),
  hasResellers: z.boolean().nullish(),
  itemCreatedUtc: z.string().nullish(),
  isOffSale: z.boolean().nullish(),
  priceStatus: z.string().nullish(),
});
export const CatalogSearchSchema = z.object({ nextPageCursor: z.string().nullish(), data: lenientArray(CatalogSearchRow) });

export const MarketplaceItemSchema = z.object({
  collectibleItemId: z.string(),
  itemTargetId: numish.nullish(),
  price: optNum,
  lowestPrice: optNum,
  lowestResalePrice: optNum,
  hasResellers: z.boolean().nullish(),
  unitsAvailableForConsumption: optNum,
  assetStock: optNum,
  sales: optNum,
  quantityLimitPerUser: optNum,
  offSaleDeadline: z.string().nullish(),
  saleLocationType: z.union([z.string(), z.number()]).nullish(),
  creatorHasVerifiedBadge: z.boolean().nullish(),
  productSaleStatus: z.union([z.string(), z.number()]).nullish(),
  scheduledRelease: z.unknown().nullish(),
});
export const MarketplaceItemsSchema = z.union([
  z.array(MarketplaceItemSchema),
  z.object({ data: z.array(MarketplaceItemSchema) }).transform((o) => o.data),
]);

export const CatalogBatchSchema = z.object({ data: lenientArray(CatalogEntry) });

// One malformed point (null date or value) is dropped, not allowed to discard the item's whole history.
const Point = z.object({ value: numish, date: z.union([z.string(), z.number()]) })
  .transform((p) => ({ value: p.value, date: typeof p.date === 'number' ? (Number.isNaN(new Date(p.date).getTime()) ? '' : new Date(p.date).toISOString()) : p.date }))
  .refine((p) => Number.isFinite(p.value) && Number.isFinite(Date.parse(p.date)));
export const ResaleSchema = z.object({
  assetStock: optNum,
  sales: optNum,
  numberRemaining: optNum,
  // Missing on new / no-sales items: treated as 0 (no RAP yet) rather than failing the parse.
  recentAveragePrice: optNum.transform((v) => v ?? 0),
  originalPrice: optNum,
  priceDataPoints: lenientArray(Point).nullish(),
  volumeDataPoints: lenientArray(Point).nullish(),
});

export const ResellersSchema = z.object({
  nextPageCursor: z.string().nullish(),
  data: z.array(z.object({
    collectibleItemInstanceId: z.string().nullish(),
    seller: z.object({ sellerId: optNum }).nullish(),
    price: numish,
    serialNumber: optNum,
  })),
});

export const CollectiblesSchema = z.object({
  nextPageCursor: z.string().nullish(),
  data: z.array(z.object({
    userAssetId: numish,
    serialNumber: optNum,
    assetId: numish,
    name: z.string().nullish(),
    recentAveragePrice: optNum,
    originalPrice: optNum,
    assetStock: optNum,
    isOnHold: z.boolean().nullish(),
  })),
});

export const OwnersSchema = z.object({
  nextPageCursor: z.string().nullish(),
  data: z.array(z.object({
    id: numish,
    serialNumber: optNum,
    owner: z.object({ id: numish.nullish() }).nullish(),
    created: dateish,
    updated: dateish,
  })),
});

export const UserSchema = z.object({
  id: numish,
  name: z.string(),
  displayName: z.string().nullish(),
  created: dateish,
  isBanned: z.boolean().nullish(),
  hasVerifiedBadge: z.boolean().nullish(),
});

export const ThumbsSchema = z.object({
  data: z.array(z.object({ targetId: numish, state: z.string().nullish(), imageUrl: z.string().nullish() })),
});

export const CanViewSchema = z.union([z.boolean(), z.object({ canView: z.boolean() }).transform((o) => o.canView)]);

export function toMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** POST users.roblox.com/v1/usernames/users (read-only lookup, no auth). */
export const UsernamesSchema = z.object({ data: z.array(z.object({ id: numish, name: z.string() })) });
/** GET groups.roblox.com/v1/groups/search/lookup?groupName= */
export const GroupLookupSchema = z.object({ data: z.array(z.object({ id: numish, name: z.string() })).nullish() });
/** GET groups.roblox.com/v1/groups/{id} */
export const GroupSchema = z.object({ id: numish, name: z.string() });
