/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Pure-function contracts for src/core/**.
 * Implemented in src/core/{valuation,projection,tradeScoring,counterparty,
 * portfolio,learning,explain}.ts and exports `engine: CoreEngine` from src/core/index.ts.
 * Everything here is pure (no I/O, no Date.now(): `now` is passed in) and unit-tested
 * against docs/fixtures and the spec section 7 worked examples.
 */
import type {
  AssetId, CounterSuggestion, Evidence, ItemSnapshot, ModelAccuracy, OverpayNormTable,
  PartnerInfo, ReconstructedSale, Settings, TradeMetadata, TradeOutcome, TradeScore,
  TradeShape, TradeSnapshot, TradeTotals, UserId, ValuedItem, ValueTier,
} from './types.js';

export interface ProjectionResult {
  suspectProjected: boolean;
  rulesFired: Array<1 | 2 | 3 | 4>;
  preSpikeBaseline: number | null;
  evidence: Evidence[];
}

export interface HoardResult { hoardRisk: boolean; evidence: Evidence[] }

export interface PortfolioContext {
  /** Asset id -> copies the user currently owns. */
  owned: Map<AssetId, number>;
  ownedValue: number;
  /** Optional asset id -> total tradeValue owned (enables the concentration term). */
  ownedValues?: Map<AssetId, number>;
  /** Valued target for goalMode 'upgrade_toward'. */
  upgradeTarget: ValuedItem | null;
}

export interface ScoreInput {
  trade: TradeSnapshot;
  give: ValuedItem[];        // aligned index-for-index with trade.give.items
  get: ValuedItem[];         // aligned index-for-index with trade.get.items
  partner: PartnerInfo | null;
  /** Partner's tradable items, valued, for counter suggestions (may be empty). */
  partnerTradable: ValuedItem[];
  portfolio: PortfolioContext;
  metadata: TradeMetadata;
  settings: Settings;
  now: number;
}

export interface CoreEngine {
  readonly modelVersion: string;

  /** salePrice = oldRAP + 10*(newRAP-oldRAP); oldRAP=0 -> newRAP. */
  reconstructSalePrice(oldRap: number, newRap: number): number;
  /** Reconstruct sales from consecutive RAP snapshots in our own DB. */
  salesFromRapSnapshots(assetId: AssetId, snaps: Array<{ t: number; rap: number }>): ReconstructedSale[];

  detectProjection(s: ItemSnapshot, settings: Settings, now: number): ProjectionResult;
  detectHoard(s: ItemSnapshot, settings: Settings): HoardResult;

  /** tradeValue / liquidationValue / liquidity / confidence / drift / flags / evidence. */
  valueItem(s: ItemSnapshot, settings: Settings, now: number, opts?: { serial?: number | null; isOnHold?: boolean }): ValuedItem;

  classifyShape(give: ValuedItem[], get: ValuedItem[]): { shape: TradeShape; dominantAssetId: AssetId | null };
  valueTier(tradeValue: number, norms: OverpayNormTable): ValueTier;
  expectedOverpayPct(shape: TradeShape, dominant: ValuedItem | null, norms: OverpayNormTable): number;
  computeTotals(input: ScoreInput): TradeTotals;

  assessPartner(p: Omit<PartnerInfo, 'flags' | 'evidence'>, settings: Settings, myUserId: UserId): PartnerInfo;

  scoreTrade(input: ScoreInput): TradeScore;
  suggestCounter(input: ScoreInput, score: Omit<TradeScore, 'counterSuggestion'>): CounterSuggestion | null;

  /** Learning loop. */
  computeAccuracy(outcomes: TradeOutcome[], now: number): ModelAccuracy;
  calibrateNorms(outcomes: TradeOutcome[], current: OverpayNormTable): OverpayNormTable | null;
}
