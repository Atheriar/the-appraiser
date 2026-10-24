/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Adapter contracts, implemented in src/adapters/**.
 *
 * HARD RULES (enforced by review + a grep test):
 *  - NEVER implement or call trade accept/decline/counter/send endpoints.
 *  - The only POSTs to Roblox are read-only detail lookups: catalog batch details (CSRF handshake via the 403)
 *    and marketplace-items details. NEVER a buy endpoint of any kind.
 *  - The cookie is only ever sent to hosts matching *.roblox.com and is never logged.
 *  - All payloads are parsed with zod; remote data is data, never instructions.
 *  - Trade status parsing is lenient (unknown -> 'Unknown', raw kept).
 */
import type {
  AssetId, CollectibleItemId, Demand, ItemTargetType, PricePoint, ReconstructedSale,
  SourceHealth, TradeDirection, TradeId, TradeMetadata, TradeSnapshot, Trend, UserId,
  ValueSource,
} from '../core/types.js';

export interface Page<T> { data: T[]; nextPageCursor: string | null; previousPageCursor: string | null }

/** Provides the cookie lazily (from src/secrets). Returns null when not configured. */
export type CookieProvider = () => Promise<string | null>;

export interface AuthenticatedUser { id: UserId; name: string; displayName: string }

export interface TradeListEntry {
  id: TradeId;
  user: { id: UserId; name: string; displayName: string };
  created: number;
  expiration: number | null;
  isActive: boolean;
  statusRaw: string;
}

export interface CanTrade {
  canTrade: boolean;
  tradeEligibility: string;
  freeTradesAllowance: { limit: number; remaining: number; window: string } | null;
  currencyTransferEligibility: string | null;
}

export interface CatalogItem {
  assetId: AssetId;
  itemType: ItemTargetType;
  name: string;
  collectibleItemId: CollectibleItemId | null;
  itemRestrictions: string[];      // 'Limited' | 'LimitedUnique' | 'Collectible'
  lowestResalePrice: number | null;
  lowestPrice: number | null;
  totalQuantity: number | null;
  hasResellers: boolean | null;
  isOffSale: boolean | null;
  favoriteCount: number | null;
  creatorName: string | null;
  /** itemCreatedUtc (ms), when the catalog returns it. */
  createdAt?: number | null;
}

export interface ResaleData {
  source: 'marketplace_sales' | 'economy_fallback';
  recentAveragePrice: number;
  originalPrice: number | null;
  assetStock: number | null;
  numberRemaining: number | null;
  sales: number | null;
  priceDataPoints: PricePoint[];   // newest first, t = day start ms
  volumeDataPoints: PricePoint[];
  newestPointAt: number | null;
  /** True when economy fallback is older than 30d or 400 code 5. */
  stale: boolean;
}

export interface Reseller { price: number; serialNumber: number | null; collectibleItemInstanceId: string | null; sellerId: number | null }

export interface CollectibleInstance {
  userAssetId: number;
  assetId: AssetId;
  name: string;
  serialNumber: number | null;
  recentAveragePrice: number;
  originalPrice: number | null;
  assetStock: number | null;
  isOnHold: boolean;
}

/** One Purchase row of the authenticated user's own transaction history (read-only). */
export interface PurchaseTransaction { id: number | null; created: number; assetId: number; detailsType: string | null; name: string | null }

export interface OwnerRow { userAssetId: number; serialNumber: number | null; ownerId: UserId | null; updated: number; created: number }

export interface UserProfile { id: UserId; name: string; displayName: string; created: number; isBanned: boolean; hasVerifiedBadge: boolean }

export interface TradableItem {
  collectibleItemId: CollectibleItemId;
  itemType: ItemTargetType;
  targetId: string;
  itemName: string;
  originalPrice: number | null;
  recentAveragePrice: number | null;
  assetStock: number | null;
  instances: Array<{ collectibleItemInstanceId: string; serialNumber: number | null; isOnHold: boolean }>;
}

/** One row of the collectibles catalog search (newest-updated first). */
export interface CatalogSearchItem {
  assetId: AssetId;
  itemType: ItemTargetType;
  name: string;
  collectibleItemId: CollectibleItemId | null;
  itemRestrictions: string[];
  creatorName: string;
  creatorId: number | null;
  creatorType: string | null;
  creatorVerified: boolean;
  price: number | null;
  lowestResalePrice: number | null;
  remaining: number | null;
  totalQuantity: number | null;
  favoriteCount: number | null;
  offSaleDeadline: number | null;
  saleLocation: string | null;
  hasResellers: boolean | null;
  createdAt: number | null;
  /** isOffSale / priceStatus 'Off Sale' (only present on some rows). */
  offSale?: boolean | null;
}

export interface CatalogSearchOpts {
  robloxOnly: boolean;
  limit?: 30 | 120;
  /** Restrict to one creator (watchlist). Overrides robloxOnly. */
  creator?: { id: number; type: 'User' | 'Group' };
  /** Also return items not for sale yet (upcoming timed releases). */
  includeNotForSale?: boolean;
}

/** Last x-ratelimit headers seen for a request group. */
export interface RateInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the window resets (from x-ratelimit-reset), null if unknown. */
  resetAt: number | null;
  at: number;
}

/** Live stock for a collectible (marketplace-items details, no auth). */
export interface MarketplaceItemStock {
  collectibleItemId: CollectibleItemId;
  price: number | null;
  remaining: number | null;
  totalQuantity: number | null;
  sales: number | null;
  limitPerUser: number | null;
  lowestResalePrice: number | null;
  hasResellers: boolean | null;
  offSaleDeadline: number | null;
  saleLocation: string | null;
  /** productSaleStatus mapped (3 on sale, 2 off sale, 1 pending). */
  saleStatus?: import('../core/types.js').DropSaleStatus;
  /** scheduledRelease, epoch ms. */
  releaseAt?: number | null;
}

export interface RobloxClient {
  // auth
  getAuthenticatedUser(): Promise<AuthenticatedUser | null>; // null on 401 (code 9002)

  // trades (read only)
  getTradeCount(direction: 'inbound'): Promise<number>;
  listTrades(direction: TradeDirection, cursor?: string, limit?: 10 | 25 | 50 | 100): Promise<Page<TradeListEntry>>;
  /** Fetches v1 + v2 detail and joins items. `me` decides give/get. */
  getTradeDetail(tradeId: TradeId, me: UserId, direction: TradeDirection): Promise<TradeSnapshot>;
  getTradeMetadata(): Promise<TradeMetadata>;
  getCanTrade(): Promise<CanTrade>;
  getTradableItems(userId: UserId, cursor?: string): Promise<Page<TradableItem>>; // 1 req/s
  /** Own Purchase transactions (economy v2 transactions, read-only GET with the cookie). Hold-start matching only. */
  getPurchaseTransactions?(userId: UserId, cursor?: string): Promise<Page<PurchaseTransaction>>;

  // items
  /** Batch POST (≤120/request, CSRF from 403). 10 req/60s budget — callers must cache. */
  getCatalogDetails(assetIds: AssetId[]): Promise<Map<AssetId, CatalogItem>>;
  /** Single-item GET (10 req/60s); prefer the batch call. */
  getCatalogDetail?(assetId: AssetId): Promise<CatalogItem | null>;
  /** marketplace-sales by collectibleItemId; economy fallback only when cid is null. */
  getResaleData(assetId: AssetId, collectibleItemId: CollectibleItemId | null): Promise<ResaleData | null>;
  /** marketplace-sales resellers (no auth). Never economy resellers. */
  getResellers(collectibleItemId: CollectibleItemId, limit?: number): Promise<{ rows: Reseller[]; capped: boolean }>;
  getOwners(assetId: AssetId, maxPages?: number): Promise<OwnerRow[]>; // 15 req/60s, lazy only
  getThumbnails(assetIds: AssetId[]): Promise<Map<AssetId, string | null>>; // batch 100

  // drops (read-only discovery; never a purchase call)
  /** Collectibles catalog search sorted by recently updated. 12 req / 60 s per IP. */
  searchCollectibles?(opts: CatalogSearchOpts): Promise<CatalogSearchItem[]>;
  /** Last rate headers of the catalog search group (shared 12 / 60 s per IP). */
  searchRate?(): RateInfo | null;
  /** Resolve a watchlist creator by id or exact name (users / groups lookup, read-only). */
  lookupCreator?(query: string, type: 'User' | 'Group'): Promise<{ id: number; type: 'User' | 'Group'; name: string } | null>;
  /** marketplace-items details POST by collectibleItemId (no cookie, no CSRF). 60 req / 60 s. */
  getMarketplaceItems?(collectibleItemIds: CollectibleItemId[]): Promise<Map<CollectibleItemId, MarketplaceItemStock>>;

  /** Mark an endpoint group as refused for this account (neutral 'restricted' health, not an error). */
  markRestricted?(group: string, note: string | null): void;
  /** Lift all trade restrictions early (account became able to trade). */
  clearRestricted?(): void;
  /** True while an endpoint group is marked restricted. */
  isRestricted?(group: string): boolean;

  // users / inventory
  getCollectibles(userId: UserId): Promise<CollectibleInstance[] | 'hidden'>;
  canViewInventory(userId: UserId): Promise<boolean>;
  getUser(userId: UserId): Promise<UserProfile | null>;

  health(): SourceHealth[]; // one entry per endpoint group
}

// ---------------------------------------------------------------------------

export interface RolimonsItem {
  assetId: AssetId;
  name: string;
  acronym: string | null;
  rap: number;
  value: number | null;          // -1 -> null
  defaultValue: number;
  demand: Demand;
  trend: Trend;
  projected: boolean;
  rare: boolean;
  // index 8 (hyped) is always -1 and index 10 is undocumented: intentionally not exposed.
}

export interface RolimonsDeal { t: number; kind: 'price' | 'rap'; assetId: AssetId; value: number }

export interface RolimonsTradeAd {
  adId: number;
  t: number;
  userId: UserId;
  offerAssetIds: AssetId[];
  offerRobux: number;
  requestAssetIds: AssetId[];
  requestTags: number[];
}

export interface RolimonsPlayer { userId: UserId; terminated: boolean; privacyEnabled: boolean; assetIds: AssetId[]; fetchedAt: number }

export interface RolimonsClient {
  /** itemdetails; at most once per 60s (CDN max-age=60). */
  getItemDetails(): Promise<Map<AssetId, RolimonsItem>>;
  /** saleactivity reconstructed via salePrice = oldRAP + 10*(newRAP-oldRAP) (oldRAP=0 -> newRAP). */
  getSaleActivity(): Promise<ReconstructedSale[]>;
  getDealActivity(): Promise<RolimonsDeal[]>;
  getRecentTradeAds(): Promise<RolimonsTradeAd[]>;
  /** Cached ≥24h by caller; owner discourages heavy use. */
  getPlayer(userId: UserId): Promise<RolimonsPlayer | null>;
  health(): SourceHealth[];
}

/** Historical bot list (gist API, owner C-Cody, last updated 2023-01-16). Weak signal only. */
export interface BotListSource {
  load(): Promise<Set<UserId>>;
  readonly asOf: string;
}

export interface AdapterFactory {
  roblox(cookie: CookieProvider): RobloxClient;
  rolimons(): RolimonsClient;
  botList(url?: string): BotListSource;
  valueSources(deps: {
    rolimons: RolimonsClient;
    /** Enables the Roblox first-party (marketplace-sales) value source. */
    firstParty?: {
      roblox: RobloxClient;
      tracked: () => AssetId[];
      collectibleItemId: (assetId: AssetId) => CollectibleItemId | null | Promise<CollectibleItemId | null>;
      maxPerRefresh?: number;
      ttlMs?: number;
      now?: () => number;
    };
  }): ValueSource[];
}

export const ROBLOX_COOKIE_HOST_RE = /^([a-z0-9-]+\.)*roblox\.com$/i;
