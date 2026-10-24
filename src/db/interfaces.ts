/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Repository contract, implemented in src/db/** with
 * better-sqlite3 + plain SQL migrations. DB file: %APPDATA%\the-appraiser\analyst.db (override RTA_DATA_DIR).
 * Tables (append-only where cheap — it is the learning dataset):
 *   items, item_snapshots, sales, resellers_snapshots, trades, trade_items, trade_scores,
 *   partners, offer_signatures, user_settings, watchlist, model_runs, kv
 */
import type {
  AssetId, CollectibleItemId, ItemValueMark, ItemSnapshot, MarketAnomaly, ModelAccuracy, PartnerInfo,
  ReconstructedSale, Settings, TradeDirection, TradeId, TradeMetadata, TradeOutcome,
  TradeScore, TradeSnapshot, TradeStatus, UserId,
} from '../core/types.js';

export interface ItemRecord {
  assetId: AssetId;
  name: string;
  collectibleItemId: CollectibleItemId | null; // cached forever once known
  itemType: 'Asset' | 'Bundle';
  isLimitedU: boolean | null;
  thumbnailUrl: string | null;
  catalogFetchedAt: number | null;
  /** Static catalog fields (cached with the record). */
  totalQuantity?: number | null;
  creatorName?: string | null;
  /** Catalog creation time (itemCreatedUtc ms). */
  createdAt?: number | null;
}

export interface Repository {
  // lifecycle
  migrate(): void;
  close(): void;

  // items
  upsertItem(item: ItemRecord): void;
  getItem(assetId: AssetId): ItemRecord | null;
  getItems(assetIds: AssetId[]): Map<AssetId, ItemRecord>;
  insertItemSnapshot(s: ItemSnapshot): void;
  latestItemSnapshot(assetId: AssetId): ItemSnapshot | null;
  latestItemSnapshots(assetIds: AssetId[]): Map<AssetId, ItemSnapshot>;
  itemSnapshotHistory(assetId: AssetId, sinceMs: number): ItemSnapshot[];
  countItemSnapshots(): number;
  /** Retention: thin old snapshots to one per item per day, drop old sales/resellers rows. */
  prune(now: number): { snapshots: number; sales: number; resellers: number };

  // sales (dedupe by saleId or (assetId,t,price))
  insertSales(sales: ReconstructedSale[]): number;
  salesFor(assetId: AssetId, sinceMs: number): ReconstructedSale[];

  // trades
  upsertTrade(t: TradeSnapshot): void;           // also writes trade_items + offer_signatures
  getTrade(id: TradeId): TradeSnapshot | null;
  listTrades(q: { direction?: TradeDirection; statuses?: TradeStatus[]; limit: number; offset: number }): TradeSnapshot[];
  knownTradeIds(direction: TradeDirection): Set<TradeId>;
  updateTradeStatus(id: TradeId, status: TradeStatus, statusRaw: string, isActive: boolean, at: number): void;

  // scores (append-only; latest wins)
  insertScore(s: TradeScore): void;
  latestScore(id: TradeId): TradeScore | null;
  scoreHistory(id: TradeId): Array<Pick<TradeScore, 'score' | 'verdict' | 'scoredAt'>>;
  markNotified(id: TradeId, at: number): void;
  wasNotified(id: TradeId): boolean;

  // bot pattern
  countOfferSignature(signature: string, sinceMs: number): { count: number; accounts: number };

  // partners
  upsertPartner(p: PartnerInfo): void;
  getPartner(userId: UserId): PartnerInfo | null;
  priorTradesWith(userId: UserId): PartnerInfo['priorTrades'];

  // settings / kv
  getSettings(): Settings;                // DEFAULT_SETTINGS deep-merged with stored overrides
  saveSettings(s: Settings): void;
  getKv<T>(key: string): T | null;        // e.g. 'tradeMetadata', 'account', 'ownInventory'
  setKv<T>(key: string, value: T): void;
  getTradeMetadata(): TradeMetadata | null;
  setTradeMetadata(m: TradeMetadata): void;

  // learning
  upsertOutcome(o: TradeOutcome): void;
  outcomes(sinceMs: number): TradeOutcome[];
  insertModelRun(a: ModelAccuracy): void;
  latestModelRun(): ModelAccuracy | null;
  upsertValueMark(m: ItemValueMark): void;
  valueMarks(q?: { tradeId?: TradeId; pendingOnly?: boolean }): ItemValueMark[];

  // market feed
  insertAnomaly(a: MarketAnomaly): void;
  recentAnomalies(limit: number): MarketAnomaly[];
}
