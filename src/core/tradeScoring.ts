/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Shape/norm classification, trade totals, score, verdict, explanation and counter suggestion. */
import { concentrationDelta } from './learning.js';
import type { ScoreInput } from './contracts.js';
import { DEFAULT_LIQUIDITY, DEFAULT_SETTINGS } from './types.js';
import type {
  AssetId, LiquiditySettings, Settings, CounterSuggestion, OverpayNormTable, ScoreTerm, ScoreWeights, TradeScore, TradeShape,
  Evidence, TradeTotals, ValuedItem, ValueTier, Verdict, VerdictCap,
} from './types.js';
import { clamp, fmtPct, fmtR, sigmoid, sum } from './util.js';
import { describePackage, searchCounterPackages } from './counter.js';
import { priceTierFactor } from './valuation.js';

export const MODEL_VERSION = 'core-1.5.0';

/** Liquidity model settings with defaults for older/partial settings objects. */
export function liquidityCfg(settings: Pick<Settings, 'valuation'>): LiquiditySettings {
  return { ...DEFAULT_LIQUIDITY, ...(settings.valuation.liquidity ?? {}) };
}
/** Scoring settings with defaults for keys added after a settings object was built. */
export function scoringCfg(settings: Pick<Settings, 'scoring'>): Settings['scoring'] {
  return { ...DEFAULT_SETTINGS.scoring, ...settings.scoring };
}

/** Edge term raw value is clamped to +/- this many percentage points. */
export const EDGE_CLAMP_PP = 50;

// ---------------------------------------------------------------------------
// Shape + norms
// ---------------------------------------------------------------------------

export interface ShapeOpts {
  /** Robux on each side, after fee for the get side. */
  giveRobux?: number;
  getRobux?: number;
  /** Items (and Robux) below this share of the gross are fillers and do not count toward the shape. */
  fillerPct: number;
}

export function classifyShape(give: ValuedItem[], get: ValuedItem[], opts?: ShapeOpts): { shape: TradeShape; dominantAssetId: AssetId | null } {
  let dom: { item: ValuedItem; side: 'give' | 'get' } | null = null;
  for (const item of give) if (!dom || item.tradeValue > dom.item.tradeValue) dom = { item, side: 'give' };
  for (const item of get) if (!dom || item.tradeValue > dom.item.tradeValue) dom = { item, side: 'get' };
  if (!dom) return { shape: 'EVEN', dominantAssetId: null };
  const id = dom.item.assetId;
  if (opts) {
    // Significant-piece view: fillers do not count, received Robux counts as a piece of the split.
    // UPGRADE (an overpay allowance) only when the user really gives more pieces than they receive.
    const gr = opts.giveRobux ?? 0, rr = opts.getRobux ?? 0;
    const gross = Math.max(sum(give.map((g) => g.tradeValue)) + gr, sum(get.map((g) => g.tradeValue)) + rr);
    const min = opts.fillerPct * gross;
    const nGive = give.filter((g) => g.tradeValue >= min).length;
    const nGet = get.filter((g) => g.tradeValue >= min).length + (rr > 0 && rr >= min ? 1 : 0);
    if (dom.side === 'give') return { shape: nGive === nGet ? 'EVEN' : 'DOWNGRADE', dominantAssetId: id };
    return { shape: nGive > nGet ? 'UPGRADE' : 'EVEN', dominantAssetId: id };
  }
  if (give.length === get.length) return { shape: 'EVEN', dominantAssetId: id };
  // Unequal counts: classify by the dominant item (covers the mixed cases too).
  return { shape: dom.side === 'get' ? 'UPGRADE' : 'DOWNGRADE', dominantAssetId: id };
}

/** small < smallMax <= mid <= midMax < large (spec: 50k–500k is mid). */
export function valueTier(tradeValue: number, norms: OverpayNormTable): ValueTier {
  if (tradeValue < norms.smallMax) return 'small';
  if (tradeValue <= norms.midMax) return 'mid';
  return 'large';
}

export function expectedOverpayPct(shape: TradeShape, dominant: ValuedItem | null, norms: OverpayNormTable): number {
  if (shape === 'EVEN' || !dominant) return 0;
  const tier = valueTier(dominant.tradeValue, norms);
  let pct = norms.rows.find((r) => r.tier === tier)?.pct ?? 0;
  if (dominant.rarity === 'rare') pct += norms.rareBonusPct;
  if (dominant.demand != null && dominant.demand >= 3) pct += norms.highDemandBonusPct;
  if (dominant.demand != null && dominant.demand >= 0 && dominant.demand <= 1) pct -= norms.lowDemandDiscountPct;
  return clamp(pct, 0, norms.maxPct);
}

export function normPctFor(shape: TradeShape, overpay: number): number {
  return shape === 'UPGRADE' ? -overpay : shape === 'DOWNGRADE' ? overpay : 0;
}

/**
 * Shape + norm for scoring. Classifies by raw item counts and by significant pieces (fillers left
 * out, received Robux counted) and keeps the stricter norm, so a filler or a Robux pad can never
 * buy an overpay allowance or dodge a split premium.
 */
export function shapeNorm(
  give: ValuedItem[], get: ValuedItem[], getRobuxCounted: number, settings: ScoreInput['settings'], giveRobux = 0,
): { shape: TradeShape; dominantAssetId: AssetId | null; normPct: number } {
  const norms = settings.overpayNorms;
  const all = [...give, ...get];
  const evalShape = (sh: { shape: TradeShape; dominantAssetId: AssetId | null }) => {
    const dom = all.find((i) => i.assetId === sh.dominantAssetId) ?? null;
    return { ...sh, normPct: normPctFor(sh.shape, expectedOverpayPct(sh.shape, dom, norms)) };
  };
  const a = evalShape(classifyShape(give, get));
  const b = evalShape(classifyShape(give, get, { giveRobux, getRobux: getRobuxCounted, fillerPct: settings.scoring.fillerThresholdPct }));
  return b.normPct > a.normPct ? b : a;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** Per-get-item multipliers for filler and duplicate adjustments. */
function getAdjustments(input: ScoreInput): { mult: number[]; filler: number; duplicate: number; unpriced: number } {
  const { give, get, trade, settings, portfolio } = input;
  const S = settings.scoring;
  const fee = input.metadata.tradeSystemRobuxFee;
  // Same after-fee Robux basis as valueGet.
  const gross = Math.max(sum(give.map((g) => g.tradeValue)) + trade.give.robux, sum(get.map((g) => g.tradeValue)) + trade.get.robux * (1 - fee));
  const seen = new Map<AssetId, number>();
  let filler = 0;
  let duplicate = 0;
  let unpriced = 0;
  const mult = get.map((it) => {
    let m = 1;
    // No Rolimons value, floor or sales at all: the number is a bare (possibly stale or pushed) RAP.
    if (it.flags.includes('no_market_data')) {
      unpriced -= it.tradeValue * UNPRICED_GET_HAIRCUT;
      m *= 1 - UNPRICED_GET_HAIRCUT;
    }
    if (get.length > 1 && gross > 0 && it.tradeValue < S.fillerThresholdPct * gross) {
      filler -= it.tradeValue * m * S.fillerPenaltyPct;
      m *= 1 - S.fillerPenaltyPct;
    }
    const prior = (portfolio.owned.get(it.assetId) ?? 0) + (seen.get(it.assetId) ?? 0);
    // A copy the user gives away in this same trade does not count as a duplicate.
    const givenAway = give.filter((g) => g.assetId === it.assetId).length;
    if (prior - givenAway > 0) {
      duplicate -= it.tradeValue * m * S.duplicateDiscountPct;
      m *= 1 - S.duplicateDiscountPct;
    }
    seen.set(it.assetId, (seen.get(it.assetId) ?? 0) + 1);
    return m;
  });
  return { mult, filler, duplicate, unpriced };
}

/** Share of a received item with no market data at all that is not counted. */
export const UNPRICED_GET_HAIRCUT = 0.5;

const isHeld = (g: ValuedItem): boolean => !!g.isOnHold || g.flags.includes('on_hold');
const holdUnknown = (g: ValuedItem): boolean => !isHeld(g) && g.flags.includes('hold_unknown');
/** Liquidity factor for a received item while it may be on hold. */
const holdLiqFactor = (g: ValuedItem): number => (isHeld(g) ? 0.5 : holdUnknown(g) ? 0.75 : 1);

/**
 * Liquidity-trap test for the verdict cap (audit 2). Uses tier-normalised liquidity (big items trade
 * slower by construction, as in upgrade detection) and leaves out the temporary hold factor (holds
 * have their own cap and risk points), and only fires when the liquidity loss is material: worse
 * than -max(5%, raw gain %) of the value given. Small or tier-driven dips are priced by the
 * 'liquid' term alone instead of being counted a second time by a cliff-edge cap.
 */
export function liquidityTrap(input: ScoreInput, t: TradeTotals): { fires: boolean; gain: number } {
  const { mult } = getAdjustments(input);
  const fee = input.metadata.tradeSystemRobuxFee;
  const lq = liquidityCfg(input.settings);
  const norm = (g: ValuedItem) => g.liquidity / priceTierFactor(g.tradeValue, lq);
  const lg = sum(input.give.map((g) => g.tradeValue * Math.min(1, norm(g)))) + input.trade.give.robux;
  const lget = sum(input.get.map((g, i) => g.tradeValue * (mult[i] ?? 1) * Math.min(1, norm(g)))) + input.trade.get.robux * (1 - fee);
  const gain = lget - lg;
  const base = Math.max(1, t.valueGive);
  return { fires: t.rawGainPct > 0 && gain / base < -Math.max(0.05, t.rawGainPct), gain };
}

export function computeTotals(input: ScoreInput): TradeTotals {
  const { give, get, trade, metadata } = input;
  const fee = metadata.tradeSystemRobuxFee;
  const rg = trade.give.robux;
  const rgetC = trade.get.robux * (1 - fee);
  const { mult, filler, duplicate, unpriced } = getAdjustments(input);

  const valueGive = sum(give.map((g) => g.tradeValue)) + rg;
  const valueGet = sum(get.map((g) => g.tradeValue)) + rgetC + filler + duplicate + unpriced;
  const rapGive = sum(give.map((g) => g.rap)) + rg;
  // Filler/duplicate multipliers apply to every get-side measure, not just trade value.
  const rapGet = sum(get.map((g, i) => g.rap * (mult[i] ?? 1))) + rgetC;
  const liquidGive = sum(give.map((g) => g.tradeValue * g.liquidity)) + rg;
  // An item received on hold cannot be re-traded/upgraded for days: count it at half its liquidity meanwhile.
  const liquidGet = sum(get.map((g, i) => g.tradeValue * (mult[i] ?? 1) * g.liquidity * holdLiqFactor(g))) + rgetC;
  const liquidationGive = sum(give.map((g) => g.liquidationValue)) + rg;
  const liquidationGet = sum(get.map((g, i) => g.liquidationValue * (mult[i] ?? 1))) + rgetC;
  const driftGet = sum(get.map((g, i) => g.tradeValue * (mult[i] ?? 1) * g.expectedDriftPct));
  const driftGive = sum(give.map((g) => g.tradeValue * g.expectedDriftPct));
  const pct = (gain: number, base: number) => (base > 0 ? gain / base : gain > 0 ? 1 : 0);

  return {
    valueGive, valueGet, rawGain: valueGet - valueGive, rawGainPct: pct(valueGet - valueGive, valueGive),
    rapGive, rapGet, rapGain: rapGet - rapGive, rapGainPct: pct(rapGet - rapGive, rapGive),
    liquidGive, liquidGet, liquidGain: liquidGet - liquidGive, liquidGainPct: pct(liquidGet - liquidGive, liquidGive),
    liquidationGive, liquidationGet, liquidationGain: liquidationGet - liquidationGive,
    liquidationGainPct: pct(liquidationGet - liquidationGive, liquidationGive),
    momentumPct: pct(driftGet - driftGive, valueGive),
    robuxGiveCounted: rg, robuxGetCounted: rgetC,
    fillerPenalty: filler, duplicatePenalty: duplicate, unpricedPenalty: unpriced,
  };
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

const knownDemand = (i: ValuedItem): boolean => i.demand != null && i.demand >= 0;

/** Value-weighted demand of a side; unknown-demand items are left out (no evidence either way). Null if nothing known. */
function weightedDemand(items: ValuedItem[], robux: number): number | null {
  const known = items.filter(knownDemand);
  const tot = sum(known.map((i) => i.tradeValue)) + robux;
  if (tot <= 0) return robux > 0 ? 4 : null;
  return (sum(known.map((i) => i.tradeValue * (i.demand as number))) + robux * 4) / tot;
}

/** Share of a side's value (items + Robux) whose demand is known. */
function knownDemandShare(items: ValuedItem[], robux: number): number {
  const tot = sum(items.map((i) => Math.max(0, i.tradeValue))) + robux;
  if (tot <= 0) return 0;
  return (sum(items.filter(knownDemand).map((i) => Math.max(0, i.tradeValue))) + robux) / tot;
}

/** Confidence of one side, weighted so zero-value (unvalued) items still count. */
function sideConfidence(items: ValuedItem[]): number {
  if (!items.length) return 1;
  const wt = (i: ValuedItem) => Math.max(i.tradeValue, i.rap, 1);
  return sum(items.map((i) => wt(i) * i.confidence)) / sum(items.map(wt));
}

/**
 * Pessimistic re-check for low-confidence trades: mark what you receive DOWN by up to 50% and what you
 * give UP by up to 100%, each scaled by that side's uncertainty (1 - confidence). If the trade still
 * beats its overpay norm, uncertainty cannot flip the verdict and the low-confidence caps do not apply.
 */
export function marginSurvivesUncertainty(t: TradeTotals, give: ValuedItem[], get: ValuedItem[], normPct: number): boolean {
  const itemsGet = Math.max(0, t.valueGet - t.robuxGetCounted), itemsGive = Math.max(0, t.valueGive - t.robuxGiveCounted);
  if (itemsGive <= 0 && t.robuxGiveCounted <= 0) return false;
  const pessGet = itemsGet * (1 - 0.5 * (1 - sideConfidence(get))) + t.robuxGetCounted;
  const pessGive = itemsGive * (1 + 1.0 * (1 - sideConfidence(give))) + t.robuxGiveCounted;
  return (pessGet - pessGive) / pessGive >= Math.max(0, normPct);
}

/** Gate on the weaker side: a confident get side must not hide an unknown give side. */
function aggregateConfidence(give: ValuedItem[], get: ValuedItem[]): number {
  return Math.min(sideConfidence(give), sideConfidence(get));
}

export function effectiveWeights(input: ScoreInput): ScoreWeights {
  return { ...input.settings.weights, ...input.settings.goalWeightOverrides[input.settings.goalMode] };
}

interface Core {
  totals: TradeTotals; shape: TradeShape; dominantAssetId: AssetId | null; normPct: number;
  edgePct: number; confidence: number;
}

function core(input: ScoreInput): Core {
  const totals = computeTotals(input);
  const { shape, dominantAssetId, normPct } = shapeNorm(input.give, input.get, totals.robuxGetCounted, input.settings, totals.robuxGiveCounted);
  const base = input.settings.goalMode === 'grow_rap' ? totals.rapGainPct : totals.rawGainPct;
  return {
    totals, shape, dominantAssetId, normPct, edgePct: base - normPct,
    confidence: aggregateConfidence(input.give, input.get),
  };
}

/** Edge of an arbitrary (hypothetical) trade input; used by the counter search. */
export function edgeFor(input: ScoreInput): number {
  return core(input).edgePct;
}

type ScoreFlag = TradeScore['flags'][number];

export function scoreTrade(input: ScoreInput): TradeScore {
  const partial = scoreWithoutCounter(input);
  const counterSuggestion = partial.verdict === 'Accept' ? null : suggestCounter(input, partial);
  return { ...partial, counterSuggestion };
}

export function scoreWithoutCounter(input: ScoreInput): Omit<TradeScore, 'counterSuggestion'> {
  const { give, get, trade, settings, partner, portfolio, metadata } = input;
  const w = effectiveWeights(input);
  const R = settings.risk;
  const c = core(input);
  const t = c.totals;
  const flags = new Set<ScoreFlag>();
  const terms: ScoreTerm[] = [];
  const add = (key: ScoreTerm['key'], label: string, raw: number, weight: number, explanation: string) =>
    terms.push({ key, label, raw, weight, value: weight * raw, explanation });

  // edge
  // Clamped so a huge paper % (tiny give side, or an inflated receive) cannot drown every risk term.
  add('edge', 'Edge vs norm', clamp(c.edgePct * 100, -EDGE_CLAMP_PP, EDGE_CLAMP_PP), w.edge,
    `${fmtPct(settings.goalMode === 'grow_rap' ? t.rapGainPct : t.rawGainPct)} ${settings.goalMode === 'grow_rap' ? 'RAP' : 'raw'} vs ${c.shape} norm ${fmtPct(c.normPct)}`);
  // Liquidity shift as a share of the value given: (what you get, at the give side's liquidity ratio) vs
  // what it is actually worth liquid. Equals (valueGet/valueGive) x (avg liquidity get - avg liquidity give).
  // Dividing by the value given (not the liquid value given) keeps it bounded when the give side is illiquid,
  // and the clamp keeps it from ever outweighing the value edge.
  const base = t.valueGive > 0 ? t.valueGive : Math.max(1, t.valueGet);
  const lRatioGive = t.valueGive > 0 ? t.liquidGive / t.valueGive : 1;
  const SC = scoringCfg(settings);
  const liqClamp = SC.liquidityClampPp;
  const liqEx = clamp(((t.liquidGet - t.valueGet * lRatioGive) / base) * 100, -liqClamp, liqClamp);
  add('liquid', 'Liquidity shift', liqEx, w.liquid, `liquid ${fmtR(t.liquidGive)} -> ${fmtR(t.liquidGet)} (gain ${fmtPct(t.liquidGain / base)} of value given) vs raw ${fmtPct(t.rawGainPct)}`);
  const qRatioGive = t.valueGive > 0 ? t.liquidationGive / t.valueGive : 1;
  const liqnEx = clamp(((t.liquidationGet - t.valueGet * qRatioGive) / base) * 100, -liqClamp, liqClamp);
  add('liquidation', 'Liquidation shift', liqnEx, w.liquidation, `worst-case ${fmtR(t.liquidationGive)} -> ${fmtR(t.liquidationGet)} vs raw ${fmtPct(t.rawGainPct)}`);
  // momentum
  // Asymmetric: expected downside counts fully, projected upside (an extrapolated price ramp, which a
  // pump also produces) at half and at most +10 pp (settings.scoring.momentum*).
  const momRaw = t.momentumPct >= 0 ? Math.min(t.momentumPct * 100 * SC.momentumUpFactor, SC.momentumCapPp) : Math.max(t.momentumPct * 100, SC.momentumFloorPp);
  add('momentum', 'Expected 14d drift', momRaw, w.momentum,
    `value-weighted 14d drift of what you get minus what you give: ${fmtPct(t.momentumPct)}`);
  // demand shift
  const dGet = weightedDemand(get, t.robuxGetCounted);
  const dGive = weightedDemand(give, t.robuxGiveCounted);
  // Scaled by how much of each side's value has known demand: a small known add-on cannot speak for
  // a large unknown item.
  const dShare = Math.min(knownDemandShare(get, t.robuxGetCounted), knownDemandShare(give, t.robuxGiveCounted));
  add('demand_shift', 'Demand shift', dGet != null && dGive != null ? (dGet - dGive) * SC.demandShiftMultiplier * dShare : 0, w.demandShift,
    dGet != null && dGive != null ? `value-weighted demand ${dGive.toFixed(1)} -> ${dGet.toFixed(1)}${dShare < 0.999 ? ` (known for ${Math.round(dShare * 100)}% of value)` : ''}` : 'demand unknown on one side; no shift counted');

  // risk points
  const getTot = sum(get.map((g) => g.tradeValue));
  let riskItems = 0;
  for (const g of get) {
    const share = getTot > 0 ? g.tradeValue / getTot : 1 / Math.max(1, get.length);
    let p = 0;
    if (g.flags.includes('projected')) p += R.projected;
    if (g.flags.includes('unstable')) p += R.unstable;
    if (g.flags.includes('hoard_risk')) p += R.hoard;
    if (g.flags.includes('hoard_releasing')) p += R.hoardRelease ?? 0;
    if (g.flags.includes('thin_history')) p += R.thinHistory ?? 0;
    if (g.flags.includes('on_hold') || g.isOnHold) p += R.onHold;
    else if (g.flags.includes('hold_unknown')) p += R.onHold * 0.5;
    if (g.flags.includes('poison_churn')) p += R.poisonChurn;
    if (g.flags.includes('stale_data')) p += R.staleData;
    riskItems += share * p;
  }
  let riskPartner = 0;
  if (partner) {
    const pf = partner.flags;
    if (pf.includes('bot_list')) riskPartner += R.botList;
    if (pf.includes('repeat_offer')) {
      riskPartner += Math.min(R.repeatOfferCap, R.repeatOffer * Math.max(1, partner.repeatOfferAccounts - 1));
    }
    if (pf.includes('new_account')) riskPartner += R.newAccount;
    if (pf.includes('hidden_inventory')) riskPartner += R.hiddenInventory;
    if (pf.includes('terminated') || pf.includes('banned')) riskPartner += R.terminated;
    for (const f of pf) if (f !== 'prior_good_history') flags.add(f);
  }
  const riskConf = R.lowConfidence * (1 - c.confidence);
  const riskPts = riskItems + riskPartner + riskConf;
  add('risk', 'Risk', riskPts, -w.risk,
    `items ${riskItems.toFixed(1)} + partner ${riskPartner.toFixed(1)} + low-confidence ${riskConf.toFixed(1)} pts`);

  // portfolio fit
  let fit = 0;
  const fitWhy: string[] = [];
  const S = settings.scoring;
  const wl = get.filter((g) => settings.wishlist.includes(g.assetId));
  if (wl.length) { fit += S.wishlistBonus * 100 * wl.length; fitWhy.push(`wishlist: ${wl.map((x) => x.name).join(', ')}`); wl.forEach(() => flags.add('wishlist')); }
  if (settings.goalMode === 'upgrade_toward' && portfolio.upgradeTarget) {
    const target = portfolio.upgradeTarget;
    if (get.some((g) => g.assetId === target.assetId)) { fit += 20; fitWhy.push(`receives target ${target.name}`); }
    else if (target.tradeValue > 0) {
      // Progress toward the target = value gained + liquidity (easier to consolidate later).
      const reduction = clamp(((t.rawGain + 0.5 * t.liquidGain) / target.tradeValue) * 100, -20, 20);
      fit += reduction + (reduction > 0 ? S.upgradeTowardBonus * 100 : 0);
      fitWhy.push(`distance to ${target.name} ${reduction >= 0 ? 'reduced' : 'increased'} ${Math.abs(reduction).toFixed(1)} pp`);
    }
  }
  const lowCut = liquidityCfg(settings).lowLiquidityCut;
  const ownedShare = scoringCfg(settings).lowLiquidityOwnedShare;
  const lowLiqGiven = give.filter((g) => g.liquidity < lowCut && portfolio.ownedValue > 0 && g.tradeValue >= ownedShare * portfolio.ownedValue);
  const avgLiqGet = getTot > 0 ? sum(get.map((g) => g.tradeValue * g.liquidity)) / getTot : 1;
  const conc = concentrationDelta(give, get, portfolio);
  if (conc) {
    if (conc.points !== 0) { fit += conc.points; fitWhy.push(`${conc.points > 0 ? 'reduces' : 'increases'} portfolio concentration (${conc.points > 0 ? '+' : ''}${conc.points.toFixed(1)} pp)`); }
  } else if (lowLiqGiven.length && avgLiqGet > 0.4) { fit += 2; fitWhy.push('reduces concentration in an illiquid item'); }
  add('portfolio_fit', 'Portfolio fit', fit, w.portfolioFit, fitWhy.join('; ') || 'neutral');

  // confidence
  add('confidence', 'Low confidence', (1 - c.confidence) * 10, -w.confidence, `aggregate confidence ${c.confidence.toFixed(2)}`);
  if (t.fillerPenalty) add('filler', 'Filler items', (t.fillerPenalty / Math.max(1, t.valueGive)) * 100, 0, `filler counted at reduced value (${fmtR(t.fillerPenalty)}), already in raw gain`);
  if (t.duplicatePenalty) add('duplicate', 'Duplicates', (t.duplicatePenalty / Math.max(1, t.valueGive)) * 100, 0, `duplicates of owned items discounted (${fmtR(t.duplicatePenalty)}), already in raw gain`);

  const logit = w.scale * sum(terms.map((x) => x.value)) + w.bias;
  let score = 100 * sigmoid(logit);
  // Expected drift is a tie-breaker, not value: it cannot lift a trade that loses value vs the norm.
  const momTerm = terms.find((x) => x.key === 'momentum');
  // Applied below as the 'momentum_no_lift' cap so it is explained like every other cap.
  const momCap = c.edgePct < 0 && momTerm && momTerm.value > 0 ? 100 * sigmoid(logit - w.scale * momTerm.value) : null;

  // item flags surfaced at trade level
  for (const it of [...give, ...get]) for (const f of it.flags) {
    if (['projected', 'roli_projected', 'hoard_risk', 'poison_churn', 'on_hold', 'low_liquidity', 'drop_pending', 'raise_pending', 'stale_data', 'unvalued', 'hold_unknown', 'hoard_releasing', 'thin_history'].includes(f)) flags.add(f);
  }
  const holdGive = give.filter((g) => settings.holdList.includes(g.assetId));
  if (holdGive.length) { flags.add('hold_list_violation'); flags.add('hold_list'); }

  // Roblox trade rules (flags only)
  const pctMax = metadata.tradeSystemMaxRobuxPercent;
  const rapGiveItems = sum(give.map((g) => g.rap));
  const rapGetItems = sum(get.map((g) => g.rap));
  if (trade.give.robux > pctMax * rapGiveItems || trade.get.robux > pctMax * rapGetItems) flags.add('exceeds_max_robux');
  if (metadata.minValueRatio != null && rapGiveItems > 0 && rapGetItems / rapGiveItems < metadata.minValueRatio) flags.add('below_min_value_ratio');

  // Display-only trade evidence (never moves the score).
  const tradeEvidence: Evidence[] = [];
  const fee = metadata.tradeSystemRobuxFee;
  if (trade.give.robux > 0) {
    // Robux you pay loses the fee before it reaches the partner; an item overpay does not.
    flags.add('robux_fee_drag');
    const lost = Math.round(trade.give.robux * fee);
    const recv = trade.give.robux - lost;
    tradeEvidence.push({
      code: 'robux_fee_drag', severity: 'warn',
      message: `Partner receives ${recv.toLocaleString('en-US')} R$ of your ${trade.give.robux.toLocaleString('en-US')} R$; ${lost.toLocaleString('en-US')} R$ is lost to Roblox's ${Math.round(fee * 100)}% fee. Paying the overpay in items avoids this.`,
      data: { robux: trade.give.robux, received: recv, lost, fee },
    });
  }
  // Same trade measured on RAP: shows when the Value edge and the RAP edge disagree.
  const edgePctRap = (rapGetItems + trade.get.robux * (1 - fee) - rapGiveItems - trade.give.robux) / Math.max(1, rapGiveItems + trade.give.robux);
  if (Math.sign(c.edgePct) !== Math.sign(edgePctRap) && Math.abs(c.edgePct - edgePctRap) > 0.05) {
    flags.add('value_rap_divergence');
    tradeEvidence.push({
      code: 'value_rap_divergence', severity: 'info',
      message: c.edgePct > edgePctRap
        ? `Wins on Value but loses on RAP (Value edge ${fmtPct(c.edgePct)}, RAP edge ${fmtPct(edgePctRap)})`
        : `Wins on RAP but loses on Value (Value edge ${fmtPct(c.edgePct)}, RAP edge ${fmtPct(edgePctRap)}); trade on Value, RAP can be projected`,
      data: { edgePct: c.edgePct, edgePctRap },
    });
  }

  // verdict + overrides
  const B = settings.verdictBands;
  let capped = false;
  const verdictAt = (v: number): Verdict => (v >= B.accept ? 'Accept' : v >= B.leanAccept ? 'Lean accept' : v >= B.counter ? 'Counter' : 'Decline');
  const uncappedScore = score;
  const caps: VerdictCap[] = [];
  const capTo = (max: number, code: string, reason: string) => {
    caps.push({ code, reason, limitedTo: verdictAt(max), maxScore: max, binding: false });
    score = Math.min(score, max);
  };
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (momCap != null && momCap < score) {
    capTo(momCap, 'momentum_no_lift', `trade loses value vs the norm (edge ${fmtPct(c.edgePct)}), so expected upward drift (${fmtPct(t.momentumPct)}) is not allowed to lift the score`);
  }
  if (holdGive.length) { capTo(B.counter - 1, 'hold_list', `you would give hold-list item(s) ${holdGive.map((x) => x.name).join(', ')}`); capped = true; }
  const projectedGet = get.filter((g) => g.flags.includes('projected'));
  const projShare = t.valueGet > 0 ? sum(projectedGet.map((g) => g.tradeValue)) / t.valueGet : 0;
  if (liquidityTrap(input, t).fires) capTo(B.leanAccept - 1, 'liquidity_trap', `liquidity trap: what you receive is much harder to sell than what you give (liquid gain ${fmtPct(t.liquidGainPct)})`);
  if (projShare > 0.25) capTo(B.leanAccept - 1, 'projected_share', `projected share ${pct(projShare)} of received value > 25%`);
  // Giving items we cannot value: the % gain is meaningless (divides by ~0), so never better than Counter.
  if (t.valueGive - t.robuxGiveCounted <= 0 || give.some((g) => g.flags.includes('no_market_data') || g.tradeValue <= 0)) {
    flags.add('unvalued_give');
    capTo(B.leanAccept - 1, 'unvalued_give', 'something you give has no usable value data, so the % gain cannot be trusted');
  }
  // Mirror on the get side: received value resting on a bare RAP (no Rolimons value, floor or sales),
  // or on unvalued items with very low confidence, cannot carry an accept.
  const unpricedGet = get.filter((g) => g.flags.includes('no_market_data') || (g.flags.includes('unvalued') && g.basis !== 'manual' && g.confidence < 0.35));
  const getItemsTot = sum(get.map((g) => Math.max(0, g.tradeValue)));
  if (unpricedGet.length && getItemsTot > 0 && sum(unpricedGet.map((g) => Math.max(0, g.tradeValue))) / getItemsTot > 0.15) {
    flags.add('unvalued_get');
    capTo(B.leanAccept - 1, 'unvalued_get', `unpriced share ${pct(sum(unpricedGet.map((g) => Math.max(0, g.tradeValue))) / getItemsTot)} of received value > 15% (no usable market data)`);
  }
  // Low data confidence caps the verdict: the score cannot be more certain than its inputs.
  // Unless the margin is so large that the uncertainty cannot flip it (marginSurvivesUncertainty).
  const robust = marginSurvivesUncertainty(t, give, get, c.normPct);
  if (!robust && c.confidence < 0.25) capTo(B.leanAccept - 1, 'confidence_very_low', `data confidence ${pct(c.confidence)} < 25%`);
  else if (!robust && c.confidence < 0.5) capTo(B.accept - 1, 'confidence_low', `data confidence ${pct(c.confidence)} < 50%`);
  // Partner risk: a terminated/banned account is a hard no; bot-pattern partners never get Accept.
  if (partner) {
    if (partner.flags.includes('terminated') || partner.flags.includes('banned')) capTo(B.counter - 1, 'partner_terminated', 'partner account is terminated/banned');
    if (partner.flags.includes('bot_list') || partner.flags.includes('repeat_offer')) capTo(B.accept - 1, 'partner_bot', [
      partner.flags.includes('bot_list') ? 'partner is on the historical bot list' : '',
      partner.flags.includes('repeat_offer') ? `same offer came from ${partner.repeatOfferAccounts} accounts (bot pattern)` : '',
    ].filter(Boolean).join(' and '));
  }
  // Mostly-on-hold receipts cannot be re-traded while values move: no outright Accept.
  const heldShare = getItemsTot > 0 ? sum(get.filter(isHeld).map((g) => Math.max(0, g.tradeValue))) / getItemsTot : 0;
  if (heldShare > 0.5) capTo(B.accept - 1, 'held_share', `on-hold share ${pct(heldShare)} of received value > 50%`);
  // Mostly new-release / thin-history receipts: the value has not been tested by trades yet.
  const thinShare = getItemsTot > 0 ? sum(get.filter((g) => g.flags.includes('thin_history')).map((g) => Math.max(0, g.tradeValue))) / getItemsTot : 0;
  if (thinShare > 0.5) capTo(B.leanAccept - 1, 'thin_history_share', `thin-history share ${pct(thinShare)} of received value > 50% (value untested by trades)`);
  // Trades breaking Roblox's own rules are not actionable as-is.
  if (flags.has('exceeds_max_robux')) {
    const side = trade.give.robux > pctMax * rapGiveItems ? { r: trade.give.robux, rap: rapGiveItems, who: 'you add' } : { r: trade.get.robux, rap: rapGetItems, who: 'partner adds' };
    capTo(B.leanAccept - 1, 'exceeds_max_robux', `the ${fmtR(side.r)} Robux ${side.who} exceeds Roblox's limit of ${pct(pctMax)} of that side's item RAP (${fmtR(Math.floor(pctMax * side.rap))})`);
  }
  if (flags.has('below_min_value_ratio')) capTo(B.leanAccept - 1, 'below_min_value_ratio', `received item RAP is ${pct(rapGiveItems > 0 ? rapGetItems / rapGiveItems : 0)} of given item RAP, below Roblox's minimum ratio of ${pct(metadata.minValueRatio ?? 0)}`);
  const verdict: Verdict = verdictAt(score);
  // The binding cap is the tightest one, and only if it actually lowered the score.
  if (caps.length && score < uncappedScore) {
    const min = Math.min(...caps.map((x) => x.maxScore));
    caps.find((x) => x.maxScore === min)!.binding = true;
  }

  const result: Omit<TradeScore, 'counterSuggestion'> = {
    tradeId: trade.tradeId, score, verdict, terms, logit, totals: t, shape: c.shape, dominantAssetId: c.dominantAssetId,
    normPct: c.normPct, rawGainPct: t.rawGainPct, edgePct: c.edgePct, edgePctRap, evidence: tradeEvidence, confidence: c.confidence,
    give, get, partner, flags: [...flags], explanation: '', capped, caps, modelVersion: MODEL_VERSION, scoredAt: input.now,
  };
  result.explanation = explain(input, result, holdGive);
  return result;
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

function explain(input: ScoreInput, s: Omit<TradeScore, 'counterSuggestion'>, holdGive: ValuedItem[]): string {
  const t = s.totals;
  const parts: string[] = [];
  const shapeWord = s.shape === 'DOWNGRADE' ? 'split premium' : s.shape === 'UPGRADE' ? 'upgrade overpay' : 'even-trade norm';
  let head = `${fmtPct(t.rawGainPct)} raw (${fmtR(t.valueGive)} -> ${fmtR(t.valueGet)})`;
  const unsourced = (input.settings.overpayNorms.source ?? 'default_unsourced') === 'default_unsourced'
    ? ' (default norm, no public data; calibrates from your completed trades)' : '';
  if (s.shape !== 'EVEN') head += `, ${fmtPct(s.edgePct)} ${s.edgePct >= 0 ? 'over' : 'vs'} the usual ${shapeWord} (${s.shape}, norm ${fmtPct(s.normPct)}${unsourced})`;
  else head += `, edge ${fmtPct(s.edgePct)}${unsourced}`;
  parts.push(head);
  if (Math.abs(t.rapGainPct - t.rawGainPct) > 0.1) parts.push(`RAP gain ${fmtPct(t.rapGainPct)} (${fmtR(t.rapGain)})`);
  const getTot = sum(s.get.map((g) => g.tradeValue));
  const LQ = liquidityCfg(input.settings);
  const lowLiq = sum(s.get.filter((g) => g.liquidity < LQ.lowLiquidityCut).map((g) => g.tradeValue));
  if (getTot > 0 && lowLiq / getTot >= LQ.lowLiquidityShareWarn) parts.push(`${Math.round((lowLiq / getTot) * 100)}% of what you'd receive is low-liquidity (liquid gain ${fmtPct(t.liquidGainPct)})`);
  else if (t.liquidGainPct - t.rawGainPct < -0.05) parts.push(`liquid gain only ${fmtPct(t.liquidGainPct)}`);
  for (const g of s.get.filter((x) => x.flags.includes('projected'))) {
    const ev = g.evidence.find((e) => e.code.startsWith('rule')) ?? null;
    parts.push(`the ${g.name} looks projected — RAP ${fmtR(g.rap)} vs baseline ${fmtR(g.preSpikeBaseline ?? g.tradeValue)}${ev ? ` (${ev.message})` : ''}`);
  }
  for (const g of s.get.filter((x) => x.isOnHold || x.flags.includes('on_hold'))) {
    parts.push(`the ${g.name} is on hold and cannot be re-traded until the hold ends`);
  }
  for (const g of s.get.filter((x) => x.flags.includes('hoard_risk'))) parts.push(`${g.name} has hoard risk`);
  for (const g of s.get.filter((x) => x.flags.includes('hoard_releasing'))) parts.push(`${g.name}'s top holder is releasing copies (supply rising)`);
  for (const g of s.get.filter((x) => x.flags.includes('thin_history'))) parts.push(`${g.name} has a thin trade history (new release or few sales); its value is untested`);
  for (const g of s.get.filter((x) => x.flags.includes('poison_churn'))) parts.push(`${g.name} changed hands a lot recently — check its UAID history`);
  if (Math.abs(t.momentumPct) >= 0.02) parts.push(`expected 14-day drift ${fmtPct(t.momentumPct)} in your favour`.replace('in your favour', t.momentumPct >= 0 ? 'in your favour' : 'against you'));
  const ds = s.terms.find((x) => x.key === 'demand_shift');
  if (ds && Math.abs(ds.raw) >= 1.5) parts.push(ds.raw > 0 ? `moves you into higher-demand items (${ds.explanation})` : `moves you into lower-demand items (${ds.explanation})`);
  for (const g of s.give.filter((x) => x.flags.includes('drop_pending'))) parts.push(`you offload ${g.name} before a likely value drop`);
  for (const g of s.get.filter((x) => x.flags.includes('raise_pending'))) parts.push(`${g.name} looks due for a value raise`);
  const p = s.partner;
  if (p) {
    if (p.flags.includes('repeat_offer')) parts.push(`repeat-offer x${p.repeatOfferAccounts}: the same offer came from ${p.repeatOfferAccounts} accounts recently (bot pattern)`);
    if (p.flags.includes('bot_list')) parts.push('partner is on the historical bot list');
    if (p.flags.includes('new_account')) parts.push(`partner account is ${p.accountAgeDays ?? '?'} days old`);
    if (p.flags.includes('terminated') || p.flags.includes('banned')) parts.push('partner account is terminated/banned');
  }
  if (s.flags.includes('unvalued_get')) parts.push('something you receive has no usable market data (bare RAP), so it is counted at a discount');
  if (s.flags.includes('hold_unknown')) parts.push('hold status of a received item is unknown (trade detail incomplete)');
  if (s.flags.includes('unvalued_give')) parts.push('something you give has no usable value data, so the gain cannot be trusted');
  if (holdGive.length) parts.push(`you would give hold-list item(s) ${holdGive.map((x) => x.name).join(', ')}`);
  if (s.confidence < 0.5) parts.push(`low data confidence (${s.confidence.toFixed(2)})`);
  for (const e of s.evidence ?? []) parts.push(e.message.replace(/\.$/, ''));
  const sentence = parts[0]! + (parts.length > 1 ? '; ' + parts.slice(1).join('; ') : '');
  return `${sentence}. Verdict: ${s.verdict} (score ${Math.round(s.score)}).${capLines(s.caps ?? [])}`;
}

/** Plain-English list of the verdict caps that applied, naming the one that bound. */
export function capLines(caps: VerdictCap[]): string {
  if (!caps.length) return '';
  const line = (c: VerdictCap) => `${c.reason} -> limited to ${c.limitedTo}${c.binding ? ' (binding)' : ''}`;
  if (caps.length === 1) return ` Limited by: ${line(caps[0]!)}.`;
  const b = caps.find((c) => c.binding);
  return ` Limited by ${caps.length} caps: ${caps.map(line).join('; ')}.${b ? ` The tightest (${b.code}) set the verdict.` : ' None lowered the score.'}`;
}

// ---------------------------------------------------------------------------
// Counter suggestion
// ---------------------------------------------------------------------------

export function suggestCounter(input: ScoreInput, score: Omit<TradeScore, 'counterSuggestion'>): CounterSuggestion | null {
  const t = score.totals;
  const fee = input.metadata.tradeSystemRobuxFee;
  const B = input.settings.verdictBands;
  const needed = Math.ceil(t.valueGive * (1 + score.normPct) - t.valueGet);
  if (score.edgePct >= 0 || needed <= 0 || score.flags.includes('unvalued_give')) {
    // Value is at par (or unmeasurable) but something else holds the verdict down: name the binding constraint.
    if (score.score >= B.leanAccept) return null;
    return bindingConstraintCounter(input, score);
  }
  const options: CounterSuggestion['options'] = [];
  const edgeWith = (vGet: number, vGive: number, norm: number) => (vGive > 0 ? (vGet - vGive) / vGive : 0) - norm;

  // 1. partner tradable items, cheapest that suffices
  const inTrade = new Set(input.get.map((g) => g.assetId));
  const candidates = input.partnerTradable
    .filter((p) => !p.isOnHold && !p.flags.includes('projected') && !inTrade.has(p.assetId) && p.tradeValue >= needed)
    .sort((a, b) => a.tradeValue - b.tradeValue);
  for (const p of candidates.slice(0, 3)) {
    const norm = shapeNorm(input.give, [...input.get, p], t.robuxGetCounted, input.settings, t.robuxGiveCounted).normPct;
    options.push({ kind: 'add_partner_item', assetId: p.assetId, name: p.name, tradeValue: p.tradeValue, resultingEdgePct: edgeWith(t.valueGet + p.tradeValue, t.valueGive, norm) });
  }
  // 2. Robux (after fee), checked against the max-Robux rule
  const robux = Math.ceil(needed / (1 - fee));
  const rapGetItems = sum(input.get.map((g) => g.rap));
  const within = input.trade.get.robux + robux <= input.metadata.tradeSystemMaxRobuxPercent * rapGetItems;
  options.push({ kind: 'add_robux', robux, withinMaxRobuxRule: within, resultingEdgePct: edgeWith(t.valueGet + robux * (1 - fee), t.valueGive, score.normPct) });
  // 3. remove my smallest give item
  if (input.give.length > 1) {
    const smallest = [...input.give].sort((a, b) => a.tradeValue - b.tradeValue)[0]!;
    const newGive = input.give.filter((g) => g !== smallest);
    const norm = shapeNorm(newGive, input.get, t.robuxGetCounted, input.settings, t.robuxGiveCounted).normPct;
    const e = edgeWith(t.valueGet, t.valueGive - smallest.tradeValue, norm);
    if (e >= 0) options.push({ kind: 'remove_my_item', assetId: smallest.assetId, name: smallest.name, tradeValue: smallest.tradeValue, resultingEdgePct: e });
  }
  // Ranked by what the partner gives up: Robux at its gross amount, since the fee is lost on the way.
  // An item that closes the gap therefore goes before a Robux ask unless the item is worth more than
  // the gross Robux (i.e. > needed / (1 - fee)).
  const cost = (o: CounterSuggestion['options'][number]) =>
    o.kind === 'add_robux' ? o.robux + (o.withinMaxRobuxRule ? 0 : 1e12)
      : o.kind === 'package' ? o.addedValue : o.tradeValue;
  options.sort((a, b) => cost(a) - cost(b));
  // 4. searched combinations from the partner's inventory (2 items, swaps, item + Robux top-up)
  const packages = searchCounterPackages(input, 3);
  const singles = new Set(options.flatMap((o) => (o.kind === 'add_partner_item' ? [o.assetId] : [])));
  for (const p of packages) {
    // A plain single add is already listed above.
    if (p.add.length === 1 && !p.swapOut.length && p.robux === 0 && singles.has(p.add[0]!.assetId)) continue;
    options.push(p);
  }

  const bits = options.map((o) =>
    o.kind === 'add_partner_item' ? `ask them to add ${o.name} (${fmtR(o.tradeValue)})`
      : o.kind === 'add_robux' ? `ask for ${o.robux.toLocaleString('en-US')} Robux${o.withinMaxRobuxRule ? '' : ' (exceeds the max-Robux rule)'}`
        : o.kind === 'package' ? describePackage(o)
          : `remove your ${o.name} (${fmtR(o.tradeValue)})`);
  // Value alone may not lift a liquidity-capped trade: say so alongside the value ask.
  const liqNote = liquidityTrap(input, t).fires
    ? ` Value is not the only problem: ${bindingConstraintCounter(input, score).text.replace(/ Make the counter yourself on roblox\.com\/trades\.$/, '')}` : '';
  const text = `Needs about ${fmtR(needed)} more value (after fee) to reach par: ${bits.join(', or ')}.${liqNote} Make the counter yourself on roblox.com/trades.`;
  return { valueNeeded: needed, options, text, partnerItemsConsidered: input.partnerTradable.length };
}

/** Counter advice when value is already at par: explain the binding constraint instead of asking for more value. */
function bindingConstraintCounter(input: ScoreInput, score: Omit<TradeScore, 'counterSuggestion'>): CounterSuggestion {
  const t = score.totals;
  const fee = input.metadata.tradeSystemRobuxFee;
  const options: CounterSuggestion['options'] = [];
  const bits: string[] = [];
  let needed = 0;
  if (score.flags.includes('unvalued_give')) {
    bits.push('value the item(s) you give first (set a manual value in Settings); no counter can be sized without it');
  }
  const trap = liquidityTrap(input, t);
  if (trap.fires) {
    needed = Math.ceil(Math.max(-t.liquidGain, -trap.gain));
    const robux = Math.ceil(needed / (1 - fee));
    const rapGetItems = sum(input.get.map((g) => g.rap));
    const within = input.trade.get.robux + robux <= input.metadata.tradeSystemMaxRobuxPercent * rapGetItems;
    options.push({ kind: 'add_robux', robux, withinMaxRobuxRule: within, resultingEdgePct: score.edgePct + (robux * (1 - fee)) / Math.max(1, t.valueGive) });
    const lowLiq = input.get.filter((g) => g.liquidity < liquidityCfg(input.settings).lowLiquidityCut).map((g) => g.name);
    bits.push(`what you receive is harder to sell than what you give (liquid gain ${fmtR(t.liquidGain)}): ask for ${robux.toLocaleString('en-US')} Robux${within ? '' : ' (exceeds the max-Robux rule)'}`
      + (lowLiq.length ? `, or swap ${lowLiq.join(', ')} for higher-demand items` : ', or receive higher-demand items instead'));
  }
  if (score.get.some((g) => g.flags.includes('projected'))) bits.push('replace the projected item(s); adding value does not fix a projection');
  if (score.get.some((g) => g.isOnHold || g.flags.includes('on_hold'))) bits.push('a received item is on hold; ask for an unheld copy or wait for the hold to end');
  if (score.flags.includes('hold_list_violation')) bits.push('remove your hold-list item from the offer');
  if (!bits.length) bits.push('value is at par but risk/demand terms hold it down; no value top-up fixes that, receive higher-demand, better-documented items instead');
  return { valueNeeded: needed, options, text: `${bits.join('; ')}. Make the counter yourself on roblox.com/trades.` };
}
