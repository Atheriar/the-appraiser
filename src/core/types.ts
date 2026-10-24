/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Shared domain types.
 *
 * Must stay dependency-free (no node:*, no zod) because web/ imports it too.
 * Conventions:
 *  - All money values are Robux (number, may be fractional after fee math).
 *  - All timestamps are epoch milliseconds (number) unless the name ends in `Iso`.
 *  - Percentages are fractions: 0.08 == 8%.
 *  - "give" / "get" are always from the logged-in user's perspective.
 */

// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------

export type AssetId = number;
export type UserId = number;
export type TradeId = number;
/** Roblox collectibles UUID. Cached forever once known (catalog details is 10 req/60s). */
export type CollectibleItemId = string;

export type ItemTargetType = 'Asset' | 'Bundle';

/** Rolimons demand index: -1 none .. 4 amazing. */
export type Demand = -1 | 0 | 1 | 2 | 3 | 4;
export const DEMAND_LABEL: Record<Demand, string> = {
  [-1]: 'none', 0: 'terrible', 1: 'low', 2: 'normal', 3: 'high', 4: 'amazing',
};

/** Rolimons trend index: -1 none, 0 lowering, 1 unstable, 2 stable, 3 raising, 4 fluctuating. */
export type Trend = -1 | 0 | 1 | 2 | 3 | 4;
export const TREND_LABEL: Record<Trend, string> = {
  [-1]: 'none', 0: 'lowering', 1: 'unstable', 2: 'stable', 3: 'raising', 4: 'fluctuating',
};

/**
 * Live trade statuses (11 per legacy reference). Parse LENIENTLY: anything unrecognised
 * maps to 'Unknown' and the raw string is kept in TradeSnapshot.statusRaw.
 */
export type TradeStatus =
  | 'Unknown' | 'Open' | 'Pending' | 'Completed' | 'Expired' | 'Declined'
  | 'RejectedDueToError' | 'Countered' | 'Processing' | 'InterventionRequired'
  | 'TwoStepVerificationRequired';

export type TradeDirection = 'inbound' | 'outbound' | 'completed' | 'inactive';

export type TradeShape = 'UPGRADE' | 'DOWNGRADE' | 'EVEN';

export type Verdict = 'Accept' | 'Lean accept' | 'Counter' | 'Decline';

export type GoalMode = 'grow_value' | 'grow_rap' | 'liquidity_first' | 'upgrade_toward';

/** Value tiers used by the overpay-norm table (by tradeValue of the dominant item). */
export type ValueTier = 'small' | 'mid' | 'large';

// ---------------------------------------------------------------------------
// Flags + evidence (shown in the UI; never silently guessed)
// ---------------------------------------------------------------------------

export type ItemFlag =
  | 'projected'          // our detector or Rolimons says RAP is inflated
  | 'roli_projected'     // Rolimons projected = 1 specifically
  | 'raise_pending'      // market evidence above value (value lag, upside)
  | 'drop_pending'       // market evidence below value (value lag, downside)
  | 'on_hold'            // isOnHold: cannot be re-traded until hold ends
  | 'hold_unknown'       // trade detail did not say whether this copy is on hold (v2 missing)
  | 'rare'               // <= rareMaxCopies
  | 'semi_rare'
  | 'hoard_risk'         // one owner >= hoardMinCopies, or top3 >= hoardTop3Share
  | 'hoard_releasing'    // the top owner's copy count fell sharply within the release window (supply hitting the market)
  | 'thin_history'       // new release (catalog createdAt < newReleaseDays) or < N sales in 30d with no Rolimons value
  | 'low_liquidity'
  | 'thin_book'          // few resellers / few sales
  | 'unvalued'           // no Rolimons value, valued off market data
  | 'unstable'           // trend unstable / high volatility
  | 'lowering'
  | 'raising'
  | 'stale_data'         // newest data older than freshness window
  | 'no_market_data'
  | 'poison_churn'       // high recent ownership churn on a high-value item
  | 'manual_override'    // CSV / user override applied
  | 'duplicate_of_owned' // user already holds a copy (get side)
  | 'wishlist'
  | 'hold_list';         // user never wants to give this

export interface Evidence {
  /** Machine id, e.g. 'rule2_single_spike', 'rap_vs_floor', 'value_lag_up'. */
  code: string;
  /** Human sentence for the UI, e.g. "Sale at 600,000 on 2026-10-10 vs RAP 110,000 before it". */
  message: string;
  /** Optional structured numbers for charts/tooltips. */
  data?: Record<string, number | string | null>;
  severity: 'info' | 'warn' | 'bad' | 'good';
}

// ---------------------------------------------------------------------------
// Item market data
// ---------------------------------------------------------------------------

export interface PricePoint { t: number; value: number }

export interface ReconstructedSale {
  assetId: AssetId;
  t: number;
  price: number;
  oldRap: number;
  newRap: number;
  /** 'rolimons_feed' (RAP-delta reconstruction) | 'rap_snapshot_delta' (our own snapshots) */
  source: 'rolimons_feed' | 'rap_snapshot_delta';
  saleId?: string;
}

/** Normalized, timestamped market state of one item. Pure input to core/valuation. */
export interface ItemSnapshot {
  assetId: AssetId;
  collectibleItemId: CollectibleItemId | null;
  itemType: ItemTargetType;
  name: string;
  acronym?: string;
  isLimitedU: boolean;
  /** Instance-level fields (only when the snapshot describes a specific copy). */
  serial?: number | null;
  isOnHold?: boolean;
  userAssetId?: number;
  collectibleItemInstanceId?: string;

  rap: number;                    // live RAP (marketplace-sales recentAveragePrice)
  roliValue: number | null;       // null when Rolimons value == -1
  roliDefaultValue: number | null;
  roliDemand: Demand | null;
  roliTrend: Trend | null;
  roliProjected: boolean | null;
  roliRare: boolean | null;

  floorPrice: number | null;      // lowest reseller price
  resellerCount: number | null;   // depth of the sell book (page-capped; see resellerCountCapped)
  resellerCountCapped?: boolean;
  totalQuantity: number | null;   // assetStock / totalQuantity
  numberRemaining?: number | null;
  publicCopies: number | null;    // from owners endpoint when fetched
  topOwnerCopies?: number | null; // max copies held by one owner (hoard)
  /** Every topOwnerCopies reading (owners endpoint, oldest first, newest = current) for the hoard-release detector. */
  topOwnerHistory?: Array<{ t: number; copies: number }> | null;
  /** Catalog creation time (itemCreatedUtc), when known. */
  createdAt?: number | null;
  top3OwnerShare?: number | null; // fraction of public copies held by top 3 owners
  recentOwnerChurn30d?: number | null; // owners whose `updated` is within 30d / publicCopies

  sales7d: number | null;
  sales30d: number | null;
  dailyPrice: PricePoint[];       // ~180d daily avg sale price (marketplace-sales priceDataPoints)
  dailyVolume: PricePoint[];      // ~180d daily volume
  lastSales: ReconstructedSale[]; // newest first

  /** Rolimons trade-ad demand: requests / offers in recent ads (optional). */
  adRequestCount?: number | null;
  adOfferCount?: number | null;

  manualValue?: number | null;    // CSV / settings override
  fetchedAt: number;
  sources: Array<'marketplace_sales' | 'economy_fallback' | 'catalog' | 'rolimons' | 'inventory' | 'owners' | 'manual'>;
}

/** Output of core/valuation for one item (optionally one specific copy). */
export interface ValuedItem {
  assetId: AssetId;
  name: string;
  thumbnailUrl?: string | null;
  serial?: number | null;
  isOnHold?: boolean;

  /** What the trading market will treat it as today (value-lag adjusted). */
  tradeValue: number;
  /** Realisable soon by listing: floor * (1 - marketplaceFee) * thin-book discount. */
  liquidationValue: number;
  /** 0..1 how easily it trades away. */
  liquidity: number;
  /** 0..1 source agreement × freshness. */
  confidence: number;

  rap: number;
  roliValue: number | null;
  /** Which anchor tradeValue started from. */
  basis: 'roli_value' | 'rap' | 'market_min' | 'pre_spike_baseline' | 'floor' | 'manual';
  /** Expected % move of tradeValue over the next ~14d (momentum + value lag). Fraction. */
  expectedDriftPct: number;
  /** Serial premium multiplier applied (1 when none). */
  serialMultiplier: number;
  /** Projection baseline when projected. */
  preSpikeBaseline?: number | null;
  rarity: 'rare' | 'semi_rare' | 'common' | 'unknown';
  demand: Demand | null;
  trend: Trend | null;

  flags: ItemFlag[];
  evidence: Evidence[];
  snapshotAt: number;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** One item in one side of a trade: v1 + v2 detail joined. */
export interface TradeItem {
  assetId: AssetId;
  itemType: ItemTargetType;
  /** v2 itemTarget.targetId (string); equals String(assetId) for assets. */
  targetId: string;
  name: string;
  userAssetId: number | null;              // v1 only
  collectibleItemInstanceId: string | null; // v2 only
  collectibleItemId: CollectibleItemId | null;
  serialNumber: number | null;
  rap: number;                              // recentAveragePrice from the trade payload
  originalPrice: number | null;
  assetStock: number | null;
  isOnHold: boolean | null;                 // v2 only; null when v2 missing
  /** How v1 and v2 rows were matched (debuggability of the join). */
  joinKey: 'serial+asset' | 'asset+order' | 'v1_only' | 'v2_only';
}

export interface TradeSide {
  userId: UserId;
  userName: string;
  displayName: string;
  items: TradeItem[];
  robux: number;
}

export interface TradeSnapshot {
  tradeId: TradeId;
  direction: TradeDirection;
  status: TradeStatus;
  statusRaw: string;
  isActive: boolean;
  createdAt: number;
  expiresAt: number | null;
  partner: { userId: UserId; name: string; displayName: string };
  /** Logged-in user's side. */
  give: TradeSide;
  /** Partner's side. */
  get: TradeSide;
  fetchedAt: number;
  hadV1: boolean;
  hadV2: boolean;
  /** Order-independent hash of (give asset ids + robux, get asset ids + robux). Bot-pattern key. */
  offerSignature: string;
}

export interface TradeMetadata {
  maxItemsPerSide: number;
  minValueRatio: number | null;
  tradeSystemMaxRobuxPercent: number;
  tradeSystemRobuxFee: number;
  /** false when we fell back to defaults (show "unverified" in UI). */
  verified: boolean;
  fetchedAt: number;
  /** Fields Roblox actually sent (the rest are carried over from the last good fetch, or defaults). */
  liveFields?: Array<'maxItemsPerSide' | 'minValueRatio' | 'tradeSystemMaxRobuxPercent' | 'tradeSystemRobuxFee'>;
}

// ---------------------------------------------------------------------------
// Counterparty
// ---------------------------------------------------------------------------

export type PartnerFlag =
  | 'bot_list'             // in historical bot-defender list (weak, 2023 data)
  | 'repeat_offer'         // same offerSignature from >= N accounts / same account
  | 'new_account'          // account age < newAccountDays
  | 'hidden_inventory'
  | 'terminated'           // Rolimons playerTerminated
  | 'banned'
  | 'low_inventory'        // inventory value far below what they're offering (possible scam/poison)
  | 'prior_good_history'
  | 'prior_bad_history';

export interface PartnerInfo {
  userId: UserId;
  name: string;
  displayName: string;
  createdAt: number | null;
  accountAgeDays: number | null;
  hasVerifiedBadge: boolean;
  isBanned: boolean;
  inventoryVisible: boolean | null;
  inventoryValue: number | null;
  inventoryRap: number | null;
  inventoryItemCount: number | null;
  inBotList: boolean;
  terminated: boolean | null;
  /** Times this partner's exact offerSignature was seen (any account) in the window. */
  repeatOfferCount: number;
  /** Distinct accounts that sent the same signature in the window. */
  repeatOfferAccounts: number;
  priorTrades: { completed: number; declined: number; countered: number };
  flags: PartnerFlag[];
  evidence: Evidence[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Each additive term inside the sigmoid. `raw` is in PERCENTAGE POINTS (edge +6% -> 6)
 * or penalty points; `value = weight * raw` (sign included); logit = scale * (Σ value) + bias.
 * liquid/liquidation terms are EXCESS over rawGainPct (pp) so raw gain is not double counted.
 */
export interface ScoreTerm {
  key:
    | 'edge' | 'liquid' | 'liquidation' | 'momentum' | 'demand_shift'
    | 'risk' | 'portfolio_fit' | 'confidence' | 'filler' | 'duplicate';
  label: string;
  raw: number;      // unweighted input (usually a fraction)
  weight: number;
  value: number;    // weight * raw (sign included); sum + bias = logit
  explanation: string;
}

export interface TradeTotals {
  valueGive: number;
  valueGet: number;
  rawGain: number;
  rawGainPct: number;
  rapGive: number;
  rapGet: number;
  rapGain: number;
  rapGainPct: number;
  liquidGive: number;
  liquidGet: number;
  liquidGain: number;
  liquidGainPct: number;
  liquidationGive: number;
  liquidationGet: number;
  liquidationGain: number;
  liquidationGainPct: number;
  /** Value-weighted expected 14d drift: get side minus give side, as fraction of valueGive. */
  momentumPct: number;
  /** Robux after fee on each side. */
  robuxGiveCounted: number;
  robuxGetCounted: number;
  /** Adjustments applied to valueGet (negative numbers). */
  fillerPenalty: number;
  duplicatePenalty: number;
  /** Haircut on received items with no market data at all (negative). */
  unpricedPenalty?: number;
}

/** One item in a counter package (partner item added, or received item swapped out). */
export interface CounterPackageItem { assetId: AssetId; name: string; tradeValue: number; liquidity: number; demand: Demand | null }

/**
 * A searched combination: add 1-2 partner items and/or swap one received item, optionally with a Robux
 * top-up inside the max-Robux rule. Text only — the user makes the counter manually on roblox.com.
 */
export interface CounterPackage {
  kind: 'package';
  /** Partner items to ask for. */
  add: CounterPackageItem[];
  /** Received items to swap out (taken off their side) in exchange for `add`. */
  swapOut: CounterPackageItem[];
  /** Extra Robux to ask for (gross, before fee); 0 when items alone suffice. */
  robux: number;
  withinMaxRobuxRule: boolean;
  /** Net value added to the get side after fee (items in - items out + Robux after fee). */
  addedValue: number;
  resultingEdgePct: number;
}

export interface CounterSuggestion {
  /** Robux value the partner must add (after-fee terms) to reach edge >= 0. */
  valueNeeded: number;
  /** Concrete options, cheapest first. Text only — the user acts manually on roblox.com. */
  options: Array<
    | { kind: 'add_partner_item'; assetId: AssetId; name: string; tradeValue: number; resultingEdgePct: number }
    | { kind: 'add_robux'; robux: number; withinMaxRobuxRule: boolean; resultingEdgePct: number }
    | { kind: 'remove_my_item'; assetId: AssetId; name: string; tradeValue: number; resultingEdgePct: number }
    | CounterPackage
  >;
  text: string;
  /** How many partner tradable items the search considered (0 = partner inventory not loaded/empty). */
  partnerItemsConsidered?: number;
}

export interface VerdictCap {
  code: string;
  reason: string;
  limitedTo: Verdict;
  maxScore: number;
  binding: boolean;
}

export interface TradeScore {
  /** Quick score shown on arrival, before partner + market data are fetched (replaced within seconds). */
  preliminary?: boolean;
  tradeId: TradeId;
  /** 0..100. */
  score: number;
  verdict: Verdict;
  terms: ScoreTerm[];
  /** Logit before sigmoid (debug). */
  logit: number;
  totals: TradeTotals;
  shape: TradeShape;
  dominantAssetId: AssetId | null;
  /** expected overpay fraction from the norm table for this trade. */
  normPct: number;
  rawGainPct: number;
  edgePct: number;
  /** Same edge measured on RAP instead of trade value (display only; never scored). */
  edgePctRap?: number;
  /** Display-only evidence on the trade as a whole (fee drag, Value-vs-RAP divergence). */
  evidence?: Evidence[];
  /** 0..1 aggregate confidence across items (value-weighted). */
  confidence: number;
  give: ValuedItem[];
  get: ValuedItem[];
  partner: PartnerInfo | null;
  flags: Array<ItemFlag | PartnerFlag | 'hold_list_violation' | 'exceeds_max_robux' | 'below_min_value_ratio' | 'unvalued_give' | 'unvalued_get' | 'robux_fee_drag' | 'value_rap_divergence'>;
  /** One-paragraph plain-English explanation. */
  explanation: string;
  counterSuggestion: CounterSuggestion | null;
  /** True when a hold-list item is given: verdict capped at Decline. */
  capped: boolean;
  /** Every verdict cap that applied (reason with numbers, verdict it limits to, whether it bound). */
  caps?: VerdictCap[];
  modelVersion: string;
  scoredAt: number;
}

// ---------------------------------------------------------------------------
// Settings (persisted in user_settings; DEFAULT_SETTINGS below is the source of truth)
// ---------------------------------------------------------------------------

export interface OverpayNormRow {
  tier: ValueTier;
  /** Base expected overpay fraction for this tier. */
  pct: number;
}

export interface OverpayNormTable {
  /** Tier boundaries by dominant item tradeValue. small < smallMax <= mid <= midMax < large (spec: 50k-500k is mid) */
  smallMax: number;
  midMax: number;
  rows: OverpayNormRow[];
  /** Additive bumps on top of the tier pct. */
  rareBonusPct: number;          // dominant item is rare
  highDemandBonusPct: number;    // dominant demand >= 3
  lowDemandDiscountPct: number;  // dominant demand <= 1 (subtracted)
  /** Cap on total expected overpay. */
  maxPct: number;
  /** 'default_unsourced' until calibrateNorms fits the table to the user's completed trades. */
  source?: 'default_unsourced' | 'calibrated';
}

export interface ScoreWeights {
  edge: number;          // w1
  liquid: number;        // w2
  liquidation: number;   // w3
  risk: number;          // w4 (applied to a positive penalty, subtracted)
  portfolioFit: number;  // w5
  momentum: number;      // w6: expected value drift of get vs give
  demandShift: number;   // w7: demand-weighted value moved toward higher demand
  confidence: number;    // w8: penalty for low aggregate confidence
  /** Logit scale: the sigmoid input is scale * Σ terms. Spec weights are fractions of %. */
  scale: number;
  bias: number;
}

export interface RiskPenalties {
  projected: number;
  unstable: number;
  hoard: number;
  /** Get-side item whose top owner is dumping copies (hoard_releasing). */
  hoardRelease: number;
  /** Get-side new release / thin sales history (thin_history). */
  thinHistory: number;
  onHold: number;
  poisonChurn: number;
  botList: number;
  repeatOffer: number;       // per extra account, capped
  repeatOfferCap: number;
  newAccount: number;
  hiddenInventory: number;
  terminated: number;
  lowConfidence: number;     // multiplied by (1 - confidence)
  staleData: number;
}

export interface VerdictBands {
  accept: number;      // score >= accept -> Accept
  leanAccept: number;  // >= leanAccept -> Lean accept
  counter: number;     // >= counter -> Counter, else Decline
}

export interface LiquiditySettings {
  /** Items above this value get the price-tier liquidity haircut (default 10,000 R$). */
  priceTierAnchor: number;
  /** Haircut per decade of value above the anchor (default 0.1). */
  priceTierSlopePerDecade: number;
  /** Lowest price-tier factor (default 0.7). */
  priceTierFloor: number;
  /** Below this an item is low_liquidity (default 0.3); also used by scoring's low-liquidity checks. */
  lowLiquidityCut: number;
  /** Explanation warns when this share of the received value is low-liquidity (default 0.3). */
  lowLiquidityShareWarn: number;
  /** Rolimons demand index (-1..4, as strings) -> liquidity component. */
  demandLiquidity: Record<string, number>;
  /** Used (with a warning) for a demand index missing from the map, and when there is no data at all. */
  unknownDemandLiquidity: number;
  /** Liquidity cap for an item with zero 30-day sales (default 0.15). */
  noSalesCap: number;
}

export interface SerialPremiumRow {
  /** Inclusive serial range; meme numbers via `exact`. */
  maxSerial?: number;
  exact?: number[];
  multiplier: number;
}

export interface Settings {
  goalMode: GoalMode;
  /** Target asset for goalMode === 'upgrade_toward'. */
  upgradeTargetAssetId: AssetId | null;
  holdList: AssetId[];
  wishlist: AssetId[];
  watchlist: AssetId[];

  notifyEnabled: boolean;
  notifyThreshold: number; // score >= N -> desktop notification (never an action)

  port: number;
  openUiOnStart: boolean;

  rolimonsEnabled: boolean;

  /**
   * Bot-list partner check (weak signal). `url` is a GitHub gist API URL whose first file is a JSON
   * array of [userId, username] or userIds; '' or enabled=false skips the download. `extraUserIds`
   * is your own list, always applied. `asOf` labels the list's age in the evidence.
   */
  botList: { enabled: boolean; url: string; asOf: string; extraUserIds: number[] };

  /** Live new-limited feed (read-only; the user buys on roblox.com themselves). */
  drops: DropSettings;
  /** Trade-hold countdown. Roblox never publishes the hold length; this is used until one is measured. */
  hold: {
    /** Assumed TRADE hold length in days (unconfirmed — learns from your items). */
    assumedDays: number;
    /** Assumed PURCHASE hold length in days (unconfirmed; bought items are believed to be held longer than traded ones). */
    assumedPurchaseDays: number;
  };
  poll: {
    inboundCountMs: number;
    inboundListOnChangeOnly: boolean;
    completedMs: number;
    itemSnapshotsMs: number;
    rolimonsItemsMs: number;
    rolimonsSalesMs: number;
    rolimonsAdsMs: number;
    ownInventoryMs: number;
    partnerCacheMs: number;
    catalogCacheMs: number;
    /** Complete catalog rows (supply, limited status, creator) are re-fetched after this long (default 7 d). */
    catalogRefreshMs: number;
    /** Items last seen as non-limited are re-checked sooner, in case they became limited (default 1 d). */
    catalogNonLimitedRefreshMs: number;
    metadataMs: number;
  };

  valuation: {
    rapFloorTolerancePct: number;   // 0.15
    valueLagThresholdPct: number;   // 0.10 market >= value*(1+x) -> raise pending
    valueLagMaxLiftPct: number;     // 0.10 cap
    /** Max downward correction toward the market (asymmetric: larger than the lift). Default 0.25. */
    valueLagMaxDropPct?: number;
    valueLagLiftFraction: number;   // 0.5 lift part-way
    /** Fraction of the gap to market taken on a drop_pending correction (default 1.0: go to market). */
    valueLagDropFraction?: number;
    marketplaceFeePct: number;      // 0.30 for liquidation
    thinBookResellers: number;      // < N resellers = thin
    thinBookSales30d: number;       // < N sales = thin
    thinBookDiscountPct: number;    // extra liquidation discount
    staleAfterMs: number;
    serialPremiumEnabled: boolean;
    serialPremiumForUnvalued: boolean;
    serialPremium: SerialPremiumRow[];
    rareMaxCopies: number;          // 100
    semiRareMaxCopies: number;      // 250
    /** First-party demand from sales/day (30d): perDay >= [d4, d3, d2, d1] -> demand 4..1, else 0. */
    derivedDemandPerDay: number[];
    /** Liquidity model shape. Defaults reproduce the pre-1.5 constants exactly. */
    liquidity: LiquiditySettings;
  };

  /**
   * Market-relative scaling for thresholds expressed in absolute Robux (overpay tier cut-offs, poison
   * check minimum, price-tier liquidity anchor). Off by default; when on, they scale with the median
   * Rolimons value of all valued items vs the reference median (0 = captured automatically when enabled).
   */
  market: {
    scaleWithMarket: boolean;
    referenceMedianValue: number;
    /** The scale factor is clamped to [1/maxScale, maxScale]. */
    maxScale: number;
  };

  projection: {
    rapVsMedianRatio: number;       // rule 1: 1.5
    rule1MaxSales: number;          // <= 3
    spikeRatio: number;             // rule 2: 2.0
    spikeWindowDays: number;        // 14
    meanRevertTolerancePct: number; // RAP considered reverted when within x of baseline
    floorVsRapRatio: number;        // rule 3: 0.6
    rule3MinResellers: number;      // >= 3
    baselineWindowDays: number;     // 30
  };

  hoard: {
    minCopies: number;              // 3
    top3Share: number;              // 0.30
    releaseWindowDays: number;      // 14: look back this far for the top owner's max copies
    releaseDropPct: number;         // 0.30: current <= max*(1-x) -> hoard_releasing
    /** Above rareMaxCopies of supply, the top owner must also hold this share of copies (default 0.02). */
    minShareOfSupply?: number;
  };

  scoring: {
    fillerThresholdPct: number;     // item < 2% of trade value = filler
    fillerPenaltyPct: number;       // each filler item counts at (1 - x)
    duplicateDiscountPct: number;   // 0.25
    poisonChurnThreshold: number;   // churn fraction on high-value item
    poisonMinValue: number;         // only check items above this value
    newAccountDays: number;
    repeatOfferWindowMs: number;    // 24h
    repeatOfferMinAccounts: number; // flag at >= N
    wishlistBonus: number;          // added to portfolioFit raw
    upgradeTowardBonus: number;
    newReleaseDays: number;         // 7: catalog item younger than this -> thin_history
    thinHistoryMinSales: number;    // 3: fewer 30d sales and no Rolimons value -> thin_history
    /** Momentum term shape: upside counts at this factor, capped at +capPp; downside floored at floorPp (pp). */
    momentumUpFactor: number;       // 0.5
    momentumCapPp: number;          // 10
    momentumFloorPp: number;        // -30
    /** Liquid / liquidation excess terms are clamped to +-this many pp. */
    liquidityClampPp: number;       // 10
    /** Demand-shift term multiplier per demand step. */
    demandShiftMultiplier: number;  // 2.5
    /** A low-liquidity given item counts as a trap risk when >= this share of owned value. */
    lowLiquidityOwnedShare: number; // 0.25
  };

  overpayNorms: OverpayNormTable;
  weights: ScoreWeights;
  /** Per-goal-mode multipliers on weights (merged over `weights`). */
  goalWeightOverrides: Record<GoalMode, Partial<ScoreWeights>>;
  risk: RiskPenalties;
  verdictBands: VerdictBands;

  /** Fallbacks when /v1/trades/metadata is unavailable. Shown as "unverified". */
  tradeMetadataFallback: Omit<TradeMetadata, 'verified' | 'fetchedAt'>;
}

export const DEFAULT_LIQUIDITY: LiquiditySettings = {
  priceTierAnchor: 10_000,
  priceTierSlopePerDecade: 0.1,
  priceTierFloor: 0.7,
  lowLiquidityCut: 0.3,
  lowLiquidityShareWarn: 0.3,
  demandLiquidity: { '-1': 0.3, '0': 0.05, '1': 0.25, '2': 0.55, '3': 0.8, '4': 0.95 },
  unknownDemandLiquidity: 0.3,
  noSalesCap: 0.15,
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Defaults: conservative, general-purpose starting values. Tune them in Settings.
 */
export const DEFAULT_SETTINGS: Settings = {
  goalMode: 'grow_value',
  upgradeTargetAssetId: null,
  holdList: [],
  wishlist: [],
  watchlist: [],

  notifyEnabled: true,
  notifyThreshold: 70,

  port: 47615,
  openUiOnStart: false,

  rolimonsEnabled: true,

  botList: { enabled: true, url: 'https://api.github.com/gists/03043d47689a6ee645366d327b11944c', asOf: '2023-01-16', extraUserIds: [] },

  drops: {
    enabled: true,
    robloxPollMs: 20_000,   // 12 catalog searches / 60 s per IP are allowed; the two feeds stay well under that,
    allPollMs: 20_000,      // the creator watchlist gets the spare budget
    creators: [{ id: 1, type: 'User', name: 'Roblox' }],
    includeUgc: true,
    stockRefreshMs: 30_000, // marketplace-items details: 60 / 60 s
    newWindowMs: DAY,
    notify: true,
    notifyTradableOnly: true,
    notifyMaxPrice: 0,      // 0 = any price
    notifyMinQuantity: 0,
  },
  hold: { assumedDays: 2, assumedPurchaseDays: 3 },
  poll: {
    inboundCountMs: 30_000, // count endpoint is cheap; 2 req/min
    inboundListOnChangeOnly: true,
    completedMs: 15 * MIN,
    itemSnapshotsMs: 10 * MIN,
    rolimonsItemsMs: 5 * MIN,
    rolimonsSalesMs: 30_000,  // saleactivity window is minutes
    rolimonsAdsMs: 5 * MIN,
    ownInventoryMs: 30 * MIN,
    partnerCacheMs: DAY,
    catalogCacheMs: 7 * DAY,  // retry interval for incomplete rows; a known collectibleItemId is never overwritten with null
    catalogRefreshMs: 7 * DAY,
    catalogNonLimitedRefreshMs: DAY,
    metadataMs: 6 * HOUR,
  },

  valuation: {
    rapFloorTolerancePct: 0.15,
    valueLagThresholdPct: 0.10,
    valueLagMaxLiftPct: 0.10,
    valueLagMaxDropPct: 0.25,
    valueLagLiftFraction: 0.5,
    valueLagDropFraction: 1.0,
    marketplaceFeePct: 0.30,
    thinBookResellers: 3,
    thinBookSales30d: 5,
    thinBookDiscountPct: 0.10,
    staleAfterMs: 2 * HOUR,
    serialPremiumEnabled: true,
    serialPremiumForUnvalued: false,
    serialPremium: [
      { exact: [1], multiplier: 1.5 },
      { maxSerial: 10, multiplier: 1.15 },
      { exact: [69, 420, 666, 777, 1337], multiplier: 1.05 },
      { maxSerial: 100, multiplier: 1.03 },
    ],
    rareMaxCopies: 100,
    semiRareMaxCopies: 250,
    derivedDemandPerDay: [10, 3, 0.7, 0.15],
    liquidity: structuredClone(DEFAULT_LIQUIDITY),
  },

  market: { scaleWithMarket: false, referenceMedianValue: 0, maxScale: 4 },

  projection: {
    rapVsMedianRatio: 1.5,
    rule1MaxSales: 3,
    spikeRatio: 2.0,
    spikeWindowDays: 14,
    meanRevertTolerancePct: 0.15,
    floorVsRapRatio: 0.6,
    rule3MinResellers: 3,
    baselineWindowDays: 30,
  },

  hoard: { minCopies: 3, top3Share: 0.30, releaseWindowDays: 14, releaseDropPct: 0.30, minShareOfSupply: 0.02 },

  scoring: {
    fillerThresholdPct: 0.02,
    fillerPenaltyPct: 0.5,
    duplicateDiscountPct: 0.25,
    poisonChurnThreshold: 0.25,
    poisonMinValue: 50_000,
    newAccountDays: 90,
    repeatOfferWindowMs: DAY,
    repeatOfferMinAccounts: 2,
    wishlistBonus: 0.05,
    upgradeTowardBonus: 0.05,
    newReleaseDays: 7,
    thinHistoryMinSales: 3,
    momentumUpFactor: 0.5,
    momentumCapPp: 10,
    momentumFloorPp: -30,
    liquidityClampPp: 10,
    demandShiftMultiplier: 2.5,
    lowLiquidityOwnedShare: 0.25,
  },

  overpayNorms: {
    smallMax: 50_000,
    midMax: 500_000,
    rows: [
      { tier: 'small', pct: 0.05 },
      { tier: 'mid', pct: 0.08 },
      { tier: 'large', pct: 0.10 },
    ],
    rareBonusPct: 0.03,
    highDemandBonusPct: 0.02,
    lowDemandDiscountPct: 0.03,
    maxPct: 0.15,
    source: 'default_unsourced',
  },

  // Spec starting point w1..w5 = 0.40, 0.20, 0.10, 0.25, 0.05; terms are % (×100) so
  // scale 0.25 maps edge +10% -> logit ≈ +1.0 (score ≈ 73) all else neutral.
  weights: {
    edge: 0.40,
    liquid: 0.20,
    liquidation: 0.10,
    risk: 0.25,
    portfolioFit: 0.05,
    momentum: 0.15,
    demandShift: 0.10,
    confidence: 0.10,
    scale: 0.25,
    bias: 0,
  },

  goalWeightOverrides: {
    // Grow value: maximise growth incl. smart upgrades -> reward momentum + demand shift.
    grow_value: {},
    grow_rap: { edge: 0.30, liquidation: 0.05 },
    liquidity_first: { liquid: 0.40, liquidation: 0.25, edge: 0.30, demandShift: 0.20 },
    upgrade_toward: { portfolioFit: 0.25 },
  },

  risk: {
    projected: 8,
    unstable: 2,
    hoard: 3,
    hoardRelease: 4,
    thinHistory: 3,
    onHold: 5,
    poisonChurn: 5,
    botList: 1.5,
    repeatOffer: 1,
    repeatOfferCap: 5,
    newAccount: 1,
    hiddenInventory: 0.5,
    terminated: 10,
    lowConfidence: 4,
    staleData: 1,
  },

  verdictBands: { accept: 70, leanAccept: 50, counter: 35 },

  tradeMetadataFallback: {
    maxItemsPerSide: 4,
    minValueRatio: null,
    tradeSystemMaxRobuxPercent: 0.5,
    tradeSystemRobuxFee: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Value sources
// ---------------------------------------------------------------------------

export interface SourceValue {
  assetId: AssetId;
  value: number | null;
  rap: number | null;
  demand: Demand | null;
  trend: Trend | null;
  projected: boolean | null;
  rare: boolean | null;
  fetchedAt: number;
}

/**
 * Pluggable item value source (Rolimons, Roblox first-party model, CSV override).
 * Implementations live in src/adapters/**. Must degrade gracefully: on failure,
 * return the last cached values and report health, never throw into the scorer.
 */
export interface ValueSource {
  readonly id: 'rolimons' | 'roblox_first_party' | 'csv_override';
  readonly label: string;
  /** Refresh from upstream (respecting the source's own rate limit). */
  refresh(): Promise<void>;
  get(assetId: AssetId): SourceValue | null;
  getMany(assetIds: AssetId[]): Map<AssetId, SourceValue>;
  /** All known asset ids (for bulk lookups / name search). */
  allAssetIds(): AssetId[];
  health(): SourceHealth;
}

export interface SourceHealth {
  id: string;
  ok: boolean;
  /** 'restricted' = Roblox refuses this endpoint for this account (e.g. no trading); neutral, not an error. */
  state?: 'restricted';
  note?: string | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  count429: number;
  cacheHits: number;
  cacheMisses: number;
}

// ---------------------------------------------------------------------------
// Learning loop
// ---------------------------------------------------------------------------

export interface TradeOutcome {
  tradeId: TradeId;
  finalStatus: TradeStatus;
  decidedAt: number | null;
  /** valueGet - valueGive re-computed with item values N days later. */
  valueGainAt7d: number | null;
  valueGainAt30d: number | null;
  verdictAtTime: Verdict;
  scoreAtTime: number;
  /** Optional context for per-tier norm calibration (contract change from core builder). */
  shape?: string;
  valueTier?: string;
  normPct?: number;
  rawGainPct?: number;
  valueGiveAtTime?: number;
  /** Raw tradeValue of the dominant item at decision time, so calibration can re-bucket under new tier cut-offs. */
  dominantValueAtTime?: number;
}

export interface ModelAccuracy {
  trades: number;
  verdictHitRate: number | null;
  avgDrift30dAccepted: number | null;
  avgDrift30dDeclined: number | null;
  calibratedNorms: OverpayNormTable | null;
  computedAt: number;
  /** Mean 30d drift as a fraction of the give value at decision time (comparable across sizes). */
  avgDriftPct30dAccepted?: number | null;
  avgDriftPct30dDeclined?: number | null;
  /** Sample sizes behind the averages above. */
  judged?: number;
  accepted30dN?: number;
  declined30dN?: number;
  /** Per-item tradeValue drift after trades (items received vs given). */
  itemDrift?: ItemDriftSummary | null;
  /** Calibration detail: suggested vs current norms per tier (user applies in Settings). */
  normSuggestion?: NormSuggestion | null;
}

export interface ItemDriftSummary {
  /** Mean drift fraction of items the user received / gave, at +7 and +30 days. */
  received7d: number | null; received30d: number | null;
  given7d: number | null; given30d: number | null;
  n7: number; n30: number;
}

export interface NormSuggestionRow {
  tier: ValueTier;
  current: number;
  /** Shrunk estimate; equals current when the sample is below minSample. */
  suggested: number;
  /** Raw mean observed overpay (null when no observations). */
  observed: number | null;
  nUser: number;
  nMarket: number;
  enough: boolean;
}

export interface NormSuggestion {
  rows: NormSuggestionRow[];
  minSample: number;
  priorStrength: number;
  /** Full table ready to apply (current with suggested tier pcts). */
  table: OverpayNormTable;
}

/** One item-side value mark for a decided trade: tradeValue then, +7d, +30d. */
export interface ItemValueMark {
  tradeId: TradeId;
  assetId: AssetId;
  side: 'give' | 'get';
  finalStatus: TradeStatus;
  decidedAt: number;
  value0: number;
  value7d: number | null;
  value30d: number | null;
}

export interface MarketAnomaly {
  id: string;
  assetId: AssetId;
  name: string;
  kind: 'newly_projected' | 'raise_pending' | 'drop_pending' | 'hoard_alert' | 'big_move' | 'value_change';
  message: string;
  changePct?: number;
  evidence: Evidence[];
  at: number;
}

// ---------------------------------------------------------------------------
// Drops (new limited releases) — read-only feed
// ---------------------------------------------------------------------------

export interface DropSettings {
  enabled: boolean;
  /** Roblox-made collectibles search interval. */
  robloxPollMs: number;
  /** All-creators (UGC) search interval. */
  allPollMs: number;
  includeUgc: boolean;
  /** Creator watchlist: one creator search per tick from the spare search budget, round-robin. */
  creators: WatchedCreator[];
  stockRefreshMs: number;
  /** A row counts as a drop when created within this window. */
  newWindowMs: number;
  notify: boolean;
  notifyTradableOnly: boolean;
  /** 0 = no limit. */
  notifyMaxPrice: number;
  notifyMinQuantity: number;
}

export interface WatchedCreator {
  id: number;
  type: 'User' | 'Group';
  name: string;
}

/** marketplace-items productSaleStatus (observed: 3 = on sale, 2 = off sale; 1 assumed pending). */
export type DropSaleStatus = 'onSale' | 'offSale' | 'pending' | null;

export interface DropItem {
  /** Dedupe key: collectibleItemId, else `${itemType}:${assetId}`. */
  key: string;
  assetId: AssetId;
  itemType: ItemTargetType;
  collectibleItemId: CollectibleItemId | null;
  name: string;
  creatorName: string;
  creatorId: number | null;
  creatorType: string | null;
  creatorVerified: boolean;
  /** Roblox-made Limited / LimitedUnique: tradable. UGC 'Collectible': resale only. */
  tradable: boolean;
  restrictions: string[];
  price: number | null;
  totalQuantity: number | null;
  remaining: number | null;
  sales: number | null;
  limitPerUser: number | null;
  saleLocation: string | null;
  /** saleLocationType ExperiencesDevApiOnly: cannot be bought on the website. */
  inGameOnly: boolean;
  offSaleDeadline: number | null;
  lowestResalePrice: number | null;
  hasResellers: boolean | null;
  favoriteCount: number | null;
  thumbnailUrl: string | null;
  createdAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
  stockUpdatedAt: number | null;
  soldOutAt: number | null;
  notifiedAt: number | null;
  /** Scheduled release time (marketplace-items scheduledRelease), when Roblox announced one. */
  releaseAt?: number | null;
  saleStatus?: DropSaleStatus;
  /** When the release watcher first saw it purchasable after being upcoming. */
  releasedAt?: number | null;
  /** First seen by a live poll (not the silent startup seed): firstSeenAt - createdAt is real detection lag. */
  seenLive?: boolean;
  /** Which search found it first. */
  source?: 'roblox' | 'all' | 'creator' | 'demo';
  /** Creator is on the watchlist. */
  watched?: boolean;
}

export interface FlipEstimate {
  basis: 'resale' | 'value' | 'rap' | null;
  refPrice: number | null;
  /** refPrice after the marketplace fee. */
  net: number | null;
  profit: number | null;
  profitPct: number | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  note: string;
}
