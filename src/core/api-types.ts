/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import type { HoldEstimate, HoldLength, HoldLengths } from './holds.js';
/**
 * REST contract between src/server and web/.
 * Dependency-free (imported by web/).
 * All routes are under http://127.0.0.1:<port>/api and return JSON.
 * Errors: non-2xx with body ApiError.
 */
import type {
  AssetId, MarketAnomaly, ModelAccuracy, PartnerInfo, PricePoint, ReconstructedSale,
  Settings, SourceHealth, TradeDirection, TradeId, TradeMetadata, TradeScore,
  TradeSnapshot, TradeStatus, ValuedItem, Verdict, TradeShape, ItemSnapshot, DropItem, FlipEstimate,
} from './types.js';

export interface ApiError { error: string; code?: string }

// GET /api/health
export interface HealthResponse {
  ok: boolean;
  version: string;
  startedAt: number;
  cookie: 'missing' | 'valid' | 'invalid' | 'unchecked';
  account: { userId: number; name: string; displayName: string } | null;
  lastPollAt: number | null;
  snapshotCount: number;
  sources: SourceHealth[];      // per adapter: roblox:<group>, rolimons:<feed>
  jobs: Array<{ name: string; lastRunAt: number | null; lastOkAt: number | null; lastError: string | null; nextRunAt: number | null }>;
}

// GET /api/header
export interface HeaderResponse {
  account: { userId: number; name: string; displayName: string } | null;
  inventoryValue: number | null;
  inventoryRap: number | null;
  inventoryLiquidationValue: number | null;
  freeTrades: { limit: number; remaining: number; window: string } | null;
  canTrade: boolean | null;
  /** Parsed /v2/users/me/can-trade (null until first fetched). Advice-only: scoring continues either way. */
  tradeStatus: TradeStatusInfo | null;
  tradeMetadata: TradeMetadata;
  lastPollAt: number | null;
  health: {
    roblox: boolean;
    rolimons: boolean;
    snapshotCount: number;
    /** Drops feed: 'ok' | 'paused' | 'error' | 'ratelimited' | 'starting' | 'off'. */
    drops?: DropsStatusInfo['state'];
    /** While drops are rate-limited (429): when catalog searches resume. */
    dropsResumeAt?: number | null;
    /** Roblox endpoint groups refused for this account (e.g. tradesV1 when it cannot trade). Neutral, not errors. */
    restricted?: string[];
  };
}

/** A trade row = latest snapshot + latest score. */
export interface TradeRow {
  trade: TradeSnapshot;
  score: TradeScore | null;
  /** Always https://www.roblox.com/trades (no per-trade deep link exists). */
  robloxUrl: string;
}

// GET /api/trades?direction=inbound|completed|inactive&minScore=&hideBots=&shape=&watchlistOnly=&limit=&cursor=
export interface TradesQuery {
  direction: TradeDirection;
  minScore?: number;
  hideBots?: boolean;
  shape?: TradeShape;
  watchlistOnly?: boolean;
  verdict?: Verdict;
  limit?: number;
  cursor?: string;
}
export interface TradesResponse { rows: TradeRow[]; nextCursor: string | null; total: number }

// GET /api/trades/:id
export interface TradeDetailResponse {
  row: TradeRow;
  /** Per-item market detail for the expand panel (sparklines etc.). */
  items: Array<{ valued: ValuedItem; snapshot: ItemSnapshot | null; recentSales: ReconstructedSale[]; /** Set when this copy is yours and on trade hold (estimated). */ hold?: HoldEstimate | null }>;
  scoreHistory: Array<{ score: number; verdict: Verdict; scoredAt: number }>;
  /** Partner inventory used for counter search (loaded lazily, only when a trade needs a counter; cached 24h). */
  partnerInventory?: PartnerInventoryStatus;
}

export interface PartnerInventoryStatus {
  /** 'loaded' | 'not_loaded' (not needed yet / no cookie) | 'hidden' (private inventory) | 'error'. */
  state: 'loaded' | 'not_loaded' | 'hidden' | 'error';
  fetchedAt: number | null;
  itemCount: number;
  /** Which endpoints contributed. */
  sources: Array<'tradableItems' | 'collectibles'>;
}

// POST /api/trades/:id/rescore   -> TradeRow   (local recompute only; never touches Roblox trades)
// POST /api/poll                  -> { queued: true }   (trigger an immediate inbound poll)

// GET /api/history?limit=&cursor=
export interface HistoryRow {
  trade: TradeSnapshot;
  scoreAtTime: TradeScore | null;
  finalStatus: TradeStatus;
  valueGainAtTime: number | null;
  valueGainNow: number | null;
  rapGainAtTime: number | null;
  rapGainNow: number | null;
}
export interface HistoryResponse { rows: HistoryRow[]; nextCursor: string | null; accuracy: ModelAccuracy | null }

// GET /api/market
export interface MarketResponse {
  watchlist: ValuedItem[];
  anomalies: MarketAnomaly[];
  /** Own inventory items whose value/floor moved > X% today. */
  inventoryMovers: Array<{ item: ValuedItem; changePct: number }>;
}

// GET /api/items/:assetId
export interface ItemDetailResponse {
  valued: ValuedItem;
  snapshot: ItemSnapshot | null;
  history: Array<{ t: number; rap: number; roliValue: number | null; floorPrice: number | null; tradeValue: number | null }>;
  dailyPrice: PricePoint[];
  dailyVolume: PricePoint[];
  recentSales: ReconstructedSale[];
}

// GET /api/items/search?q=   (name/acronym search via Rolimons catalogue, for hold/wish/watch lists)
export interface ItemSearchResponse { items: Array<{ assetId: AssetId; name: string; acronym: string | null; value: number | null; rap: number | null; thumbnailUrl: string | null }> }

export interface TradeStatusInfo {
  canTrade: boolean;
  /** Raw tradeEligibility enum from Roblox. */
  eligibility: string | null;
  /** Human text when canTrade is false (unknown enums shown raw). */
  reason: string | null;
  freeTradesRemaining: number | null;
  freeTradesLimit: number | null;
  freeTradesWindow: string | null;
}

// GET /api/inventory
export interface InventoryResponse {
  /** `hold`: estimated countdown for copies on trade hold (null when on hold but untracked, absent when tradable). */
  items: Array<ValuedItem & { hold?: HoldEstimate | null }>;
  /** Hold length in use (assumed until measured) and the soonest estimated release among held copies. */
  holds?: { length: HoldLength; lengths?: HoldLengths; nextReleaseAt: number | null };
  totalValue: number;
  totalRap: number;
  totalLiquidation: number;
  count: number;
  onHoldCount: number;
  fetchedAt: number | null;
  /** 'no_cookie' | 'loading' (cookie ok, first fetch pending/running) | 'ready' | 'hidden' (inventory private) */
  state: 'no_cookie' | 'loading' | 'ready' | 'hidden';
  refreshing: boolean;
  lastError: string | null;
  /** Earliest time a manual refresh is accepted (rate-limit guard). */
  nextRefreshAllowedAt: number | null;
}

// POST /api/inventory/refresh -> { queued: boolean; retryAt: number | null }

// GET /api/drops   (read-only feed of new limited releases; there is NO buy route)
export interface DropsStatusInfo {
  state: 'ok' | 'paused' | 'error' | 'ratelimited' | 'starting' | 'off';
  lastPollAt: number | null;
  lastError: string | null;
  tracked: number;
  /** 429: catalog searches resume at this time. */
  rateLimitedUntil: number | null;
  /** Our catalog searches in the last 60 s (Roblox allows 12 per IP). */
  searchesLastMin: number;
  /** Roblox's x-ratelimit-remaining (adjusted), null if unknown. */
  searchRemaining: number | null;
  creators: { count: number; next: string | null; lastPollAt: number | null; lastName: string | null; skipped: number };
  /** Drops waiting for a scheduled release. */
  upcoming: number;
}
export interface DropRow {
  drop: DropItem;
  flip: FlipEstimate;
  /** https://www.roblox.com/catalog/{assetId}: the user buys there themselves. */
  url: string;
  roliValue: number | null;
  rap: number | null;
}
export interface DropsResponse {
  rows: DropRow[];
  status: DropsStatusInfo;
  now: number;
  /** Marketplace fee used by the flip estimate. */
  feePct: number;
  /** Search interval (ms) of the fastest feed, so the UI can show "next check". */
  pollMs: number;
  /** Median detection lag (first seen by a live poll minus itemCreatedUtc) over `lagSamples` drops. */
  lagMedianMs: number | null;
  lagSamples: number;
}

// POST /api/drops/creators/lookup { query, type } -> { creator: WatchedCreator | null }

// GET /api/my-trades ?status=all|won|lost &page &pageSize(25|50|100) &q &from &to (YYYY-MM-DD, inclusive)
/** Which number "value at trade time" came from, best first. */
export type ThenBasis = 'score_at_trade' | 'snapshot' | 'current_estimate';
export interface MyTradeItem {
  assetId: number; name: string; thumbnailUrl: string | null; serial: number | null;
  valueThen: number; rapThen: number; valueNow: number; rapNow: number;
  basis: ThenBasis; confidence: 'high' | 'medium' | 'low';
  /** Plain-English source of valueThen (e.g. "snapshot 2d before the trade"). */
  basisNote: string;
  snapshotAt: number | null;
  /** Received copy you still own that is on trade hold (estimated countdown). */
  hold?: HoldEstimate | null;
}
export interface MyTradeSide {
  items: MyTradeItem[];
  /** Robux on this side (gross, as entered in the trade). */
  robux: number;
  /** Robux counted for the user: given side gross, received side after the trade fee. */
  robuxCounted: number;
  valueThen: number; valueNow: number; rapThen: number; rapNow: number;
}
export interface MyTradePnl {
  /** Value gained at trade time: received then - given then (Robux after fee). */
  gainThen: number; gainThenPct: number | null;
  /** "If you'd kept it": received side now - given side now. */
  gainNow: number; gainNowPct: number | null;
  /** gainNow - gainThen. */
  changeSince: number;
  rapGainThen: number; rapGainNow: number;
}
export interface MyTradeScoreRef { score: number; verdict: Verdict; modelVersion: string; scoredAt: number }
export interface MyTradeRow {
  tradeId: number;
  /** Completion time when the app watched it complete, else the trade's creation time. */
  date: number; dateBasis: 'completed_observed' | 'created';
  direction: string;
  partner: { userId: number; name: string; displayName: string; profileUrl: string };
  give: MyTradeSide; get: MyTradeSide;
  pnl: MyTradePnl;
  /** Weakest then-value basis on the trade (drives the row badge). */
  thenBasis: ThenBasis;
  /** Score the app stored at or before the trade date (null when it never saw the trade live). */
  scoreThen: MyTradeScoreRef | null;
  /** Current model re-score with the inventory held before the trade. */
  scoreNow: MyTradeScoreRef | null;
  portfolioBasis: 'reconstructed' | 'current_minus_trade';
  portfolioNote: string;
}
export interface MyTradesSummary {
  trades: number;
  gainThenTotal: number; gainNowTotal: number;
  /** Share of trades with gainThen > 0 / gainNow > 0. */
  winRateThen: number | null; winRateNow: number | null;
  best: { tradeId: number; gainNow: number } | null;
  worst: { tradeId: number; gainNow: number } | null;
  /** Trades where at least one item's then-value is estimated from current values. */
  estimatedTrades: number;
}
export interface MyTradesResponse {
  rows: MyTradeRow[];
  total: number; page: number; pages: number; pageSize: number;
  /** Over every completed trade matching the filters (not just this page). */
  summary: MyTradesSummary;
  /** Lifetime (unfiltered) completed trade count. */
  lifetimeTrades: number;
  robuxFee: number;
}

// GET /api/partners/:userId
export type PartnerResponse = PartnerInfo;

// GET /api/settings            -> SettingsResponse
// PUT /api/settings  body: SettingsPatch  -> SettingsResponse   (deep-merged, zod-validated; rescoring queued)
export interface SettingsResponse {
  settings: Settings; defaults: Settings;
  /** Market index (median Rolimons value of valued items) and the scale applied to absolute-Robux thresholds. */
  market?: { index: { median: number; n: number; at: number } | null; reference: number | null; scale: number; enabled: boolean };
  /** Trade-hold length in use: assumed (Settings) until a lift is measured. */
  hold?: HoldLength & { observations: number; lengths?: HoldLengths;
    /** Purchase-time lookup (Roblox transaction history): last fetch, or why it is off. */
    purchaseLookup?: { lastFetchAt: number | null; rows: number; failed: string | null } };
}
export type SettingsPatch = DeepPartial<Settings>;

// GET    /api/cookie   -> CookieStatusResponse   (never returns the cookie)
// PUT    /api/cookie   body: { cookie: string } -> CookieStatusResponse   (validated via users/v1/users/authenticated, then DPAPI-encrypted)
// DELETE /api/cookie   -> CookieStatusResponse
export interface CookieStatusResponse {
  status: 'missing' | 'valid' | 'invalid' | 'unchecked';
  account: { userId: number; name: string; displayName: string } | null;
  /** Masked e.g. "_|WARNING…ab12" — last 4 chars only. */
  masked: string | null;
  checkedAt: number | null;
}
export interface CookiePutBody { cookie: string }

// POST /api/values/csv  body: text/csv "assetId,value"  -> { imported: number }

export type DeepPartial<T> = T extends Array<infer _U> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Canonical route list (server must register exactly these; web must only call these). */
export const API_ROUTES = [
  'GET /api/health',
  'GET /api/header',
  'GET /api/trades',
  'GET /api/trades/:id',
  'POST /api/trades/:id/rescore',
  'POST /api/poll',
  'GET /api/history',
  'GET /api/my-trades',
  'GET /api/market',
  'GET /api/items/search',
  'GET /api/items/:assetId',
  'GET /api/inventory',
  'GET /api/drops',
  'POST /api/inventory/refresh',
  'GET /api/partners/:userId',
  'GET /api/settings',
  'PUT /api/settings',
  'GET /api/cookie',
  'PUT /api/cookie',
  'DELETE /api/cookie',
  'POST /api/values/csv',
] as const;
export type ApiRoute = (typeof API_ROUTES)[number];

export const ROBLOX_TRADES_URL = 'https://www.roblox.com/trades';
/** Opens the trade window with this user on roblox.com; the user adds items and presses Send themselves. */
export const tradeUrlForUser = (userId: number): string => `https://www.roblox.com/users/${Math.floor(userId)}/trade`;
