/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Core engine: pure valuation + trade scoring. Implements CoreEngine from contracts.ts. */
import type { CoreEngine } from './contracts.js';
import { assessPartner } from './counterparty.js';
import { calibrateNorms, computeAccuracy } from './learning.js';
import { detectHoard, detectProjection, reconstructSalePrice, salesFromRapSnapshots } from './projection.js';
import {
  MODEL_VERSION, classifyShape, computeTotals, expectedOverpayPct, scoreTrade, suggestCounter, valueTier,
} from './tradeScoring.js';
import { valueItem } from './valuation.js';

export const engine: CoreEngine = {
  modelVersion: MODEL_VERSION,
  reconstructSalePrice,
  salesFromRapSnapshots,
  detectProjection,
  detectHoard,
  valueItem,
  classifyShape,
  valueTier,
  expectedOverpayPct,
  computeTotals,
  assessPartner,
  scoreTrade,
  suggestCounter,
  computeAccuracy,
  calibrateNorms,
};

export { offerSignature } from './counterparty.js';
export { MODEL_VERSION } from './tradeScoring.js';
