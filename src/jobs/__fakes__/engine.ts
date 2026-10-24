/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Minimal stand-in CoreEngine used ONLY when src/core/index.ts is not available
 * (so the server, demo mode and tests run). Deliberately simple; the real engine replaces it
 * automatically at runtime via src/server/loader.ts.
 */
import type { CoreEngine, HoardResult, ProjectionResult, ScoreInput } from '../../core/contracts.js';
import type {
  ItemFlag, ItemSnapshot, ModelAccuracy, OverpayNormTable, PartnerInfo, ReconstructedSale, ScoreTerm,
  Settings, TradeOutcome, TradeScore, TradeShape, TradeTotals, ValuedItem, ValueTier, Verdict,
} from '../../core/types.js';

const LIQ: Record<string, number> = { '-1': 0.3, '0': 0.05, '1': 0.25, '2': 0.55, '3': 0.8, '4': 0.95 };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : null; };

function weightsFor(s: Settings) { return { ...s.weights, ...s.goalWeightOverrides[s.goalMode] }; }

export const fallbackEngine: CoreEngine = {
  modelVersion: 'fallback-0',

  reconstructSalePrice(oldRap, newRap) { return oldRap === 0 ? newRap : oldRap + 10 * (newRap - oldRap); },

  salesFromRapSnapshots(assetId, snaps) {
    const out: ReconstructedSale[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1]!, b = snaps[i]!;
      if (a.rap !== b.rap) out.push({ assetId, t: b.t, price: this.reconstructSalePrice(a.rap, b.rap), oldRap: a.rap, newRap: b.rap, source: 'rap_snapshot_delta' });
    }
    return out.reverse();
  },

  detectProjection(s: ItemSnapshot, settings: Settings, now: number): ProjectionResult {
    const rules: Array<1 | 2 | 3 | 4> = [];
    const prices = s.lastSales.filter((x) => x.t >= now - 30 * 86_400_000).map((x) => x.price);
    const med = median(prices);
    if (med && s.rap >= settings.projection.rapVsMedianRatio * med && prices.length <= settings.projection.rule1MaxSales) rules.push(1);
    if (s.lastSales.some((x) => x.t >= now - settings.projection.spikeWindowDays * 86_400_000 && x.oldRap > 0 && x.price >= settings.projection.spikeRatio * x.oldRap)) rules.push(2);
    if (s.floorPrice != null && (s.resellerCount ?? 0) >= settings.projection.rule3MinResellers && s.floorPrice <= settings.projection.floorVsRapRatio * s.rap) rules.push(3);
    if (s.roliProjected) rules.push(4);
    const baseline = s.roliValue ?? s.floorPrice ?? null;
    return { suspectProjected: rules.length > 0, rulesFired: rules, preSpikeBaseline: rules.length ? baseline : null,
      evidence: rules.map((r) => ({ code: `rule${r}`, message: `Projection rule ${r} fired`, severity: 'bad' as const })) };
  },

  detectHoard(s: ItemSnapshot, settings: Settings): HoardResult {
    const h = (s.topOwnerCopies ?? 0) >= settings.hoard.minCopies || (s.top3OwnerShare ?? 0) >= settings.hoard.top3Share;
    return { hoardRisk: h, evidence: h ? [{ code: 'hoard', message: 'Concentrated ownership', severity: 'warn' }] : [] };
  },

  valueItem(s, settings, now, opts): ValuedItem {
    const proj = this.detectProjection(s, settings, now);
    const flags: ItemFlag[] = [];
    let basis: ValuedItem['basis'] = 'rap';
    let v = s.rap;
    if (s.manualValue != null) { v = s.manualValue; basis = 'manual'; flags.push('manual_override'); }
    else if (proj.suspectProjected && proj.preSpikeBaseline != null) { v = proj.preSpikeBaseline; basis = 'pre_spike_baseline'; }
    else if (s.roliValue != null) { v = s.roliValue; basis = 'roli_value'; }
    else if (s.floorPrice != null && s.rap > s.floorPrice * 1.15) { v = s.floorPrice; basis = 'floor'; }
    if (proj.suspectProjected) flags.push('projected');
    if (s.roliProjected) flags.push('roli_projected');
    if (s.roliValue == null) flags.push('unvalued');
    const onHold = opts?.isOnHold ?? s.isOnHold ?? false;
    if (onHold) flags.push('on_hold');
    if (s.roliTrend === 1) flags.push('unstable');
    if (s.roliTrend === 0) flags.push('lowering');
    if (s.roliTrend === 3) flags.push('raising');
    const liquidity = LIQ[String(s.roliDemand ?? -1)] ?? 0.3;
    const floor = s.floorPrice ?? v;
    return {
      assetId: s.assetId, name: s.name, serial: opts?.serial ?? s.serial ?? null, isOnHold: onHold,
      tradeValue: v, liquidationValue: floor * (1 - settings.valuation.marketplaceFeePct) * (0.7 + 0.3 * liquidity),
      liquidity, confidence: s.roliValue != null ? 0.8 : 0.45, rap: s.rap, roliValue: s.roliValue, basis,
      expectedDriftPct: s.roliTrend === 3 ? 0.02 : s.roliTrend === 0 ? -0.03 : 0, serialMultiplier: 1,
      preSpikeBaseline: proj.preSpikeBaseline, rarity: 'unknown', demand: s.roliDemand, trend: s.roliTrend,
      flags, evidence: proj.evidence, snapshotAt: s.fetchedAt,
    };
  },

  classifyShape(give, get) {
    const all = [...give.map((v) => ({ v, side: 'give' })), ...get.map((v) => ({ v, side: 'get' }))];
    if (!all.length) return { shape: 'EVEN' as TradeShape, dominantAssetId: null };
    const dom = all.reduce((a, b) => (b.v.tradeValue > a.v.tradeValue ? b : a));
    let shape: TradeShape = 'EVEN';
    if (give.length > get.length && dom.side === 'get') shape = 'UPGRADE';
    else if (get.length > give.length && dom.side === 'give') shape = 'DOWNGRADE';
    return { shape, dominantAssetId: dom.v.assetId };
  },

  valueTier(tv, n): ValueTier { return tv < n.smallMax ? 'small' : tv < n.midMax ? 'mid' : 'large'; },

  expectedOverpayPct(shape, dom, n) {
    if (shape === 'EVEN' || !dom) return 0;
    const tier = this.valueTier(dom.tradeValue, n);
    let pct = n.rows.find((r) => r.tier === tier)?.pct ?? 0;
    if ((dom.demand ?? 0) >= 3) pct += n.highDemandBonusPct;
    if (dom.demand != null && dom.demand <= 1 && dom.demand >= 0) pct -= n.lowDemandDiscountPct;
    return Math.min(n.maxPct, Math.max(0, pct));
  },

  computeTotals(input: ScoreInput): TradeTotals {
    const fee = input.metadata.tradeSystemRobuxFee;
    const rg = input.trade.give.robux, rr = input.trade.get.robux * (1 - fee);
    const vGive = sum(input.give.map((v) => v.tradeValue)) + rg;
    const vGetRaw = sum(input.get.map((v) => v.tradeValue)) + rr;
    const filler = -sum(input.get.filter((v) => v.tradeValue < input.settings.scoring.fillerThresholdPct * vGetRaw).map((v) => v.tradeValue * input.settings.scoring.fillerPenaltyPct));
    const dup = -sum(input.get.filter((v) => input.portfolio.owned.has(v.assetId)).map((v) => v.tradeValue * input.settings.scoring.duplicateDiscountPct));
    const vGet = vGetRaw + filler + dup;
    const rapGive = sum(input.give.map((v) => v.rap)) + rg, rapGet = sum(input.get.map((v) => v.rap)) + rr;
    const lGive = sum(input.give.map((v) => v.tradeValue * v.liquidity)) + rg, lGet = sum(input.get.map((v) => v.tradeValue * v.liquidity)) + rr;
    const qGive = sum(input.give.map((v) => v.liquidationValue)) + rg, qGet = sum(input.get.map((v) => v.liquidationValue)) + rr;
    const pct = (a: number, b: number) => (b > 0 ? (a - b) / b : 0);
    const mom = vGive > 0 ? (sum(input.get.map((v) => v.tradeValue * v.expectedDriftPct)) - sum(input.give.map((v) => v.tradeValue * v.expectedDriftPct))) / vGive : 0;
    return {
      valueGive: vGive, valueGet: vGet, rawGain: vGet - vGive, rawGainPct: pct(vGet, vGive),
      rapGive, rapGet, rapGain: rapGet - rapGive, rapGainPct: pct(rapGet, rapGive),
      liquidGive: lGive, liquidGet: lGet, liquidGain: lGet - lGive, liquidGainPct: pct(lGet, lGive),
      liquidationGive: qGive, liquidationGet: qGet, liquidationGain: qGet - qGive, liquidationGainPct: pct(qGet, qGive),
      momentumPct: mom, robuxGiveCounted: rg, robuxGetCounted: rr, fillerPenalty: filler, duplicatePenalty: dup,
    };
  },

  assessPartner(p, settings): PartnerInfo {
    const flags: PartnerInfo['flags'] = [];
    if (p.inBotList) flags.push('bot_list');
    if (p.repeatOfferAccounts >= settings.scoring.repeatOfferMinAccounts) flags.push('repeat_offer');
    if (p.accountAgeDays != null && p.accountAgeDays < settings.scoring.newAccountDays) flags.push('new_account');
    if (p.inventoryVisible === false) flags.push('hidden_inventory');
    if (p.terminated) flags.push('terminated');
    if (p.isBanned) flags.push('banned');
    return { ...p, flags, evidence: flags.map((f) => ({ code: f, message: f === 'repeat_offer' ? `repeat-offer ×${p.repeatOfferAccounts}` : f, severity: 'warn' as const })) };
  },

  scoreTrade(input: ScoreInput): TradeScore {
    const s = input.settings, w = weightsFor(s);
    const totals = this.computeTotals(input);
    const { shape, dominantAssetId } = this.classifyShape(input.give, input.get);
    const dom = [...input.give, ...input.get].find((v) => v.assetId === dominantAssetId) ?? null;
    const x = this.expectedOverpayPct(shape, dom, s.overpayNorms);
    const normPct = shape === 'UPGRADE' ? -x : shape === 'DOWNGRADE' ? x : 0;
    const edgePct = totals.rawGainPct - normPct;
    const share = (v: ValuedItem) => (totals.valueGet > 0 ? v.tradeValue / totals.valueGet : 0);
    let risk = 0;
    for (const v of input.get) {
      if (v.flags.includes('projected')) risk += s.risk.projected * share(v);
      if (v.flags.includes('on_hold')) risk += s.risk.onHold * share(v);
      if (v.flags.includes('unstable')) risk += s.risk.unstable * share(v);
    }
    const p = input.partner;
    if (p?.flags.includes('repeat_offer')) risk += Math.min(s.risk.repeatOfferCap, s.risk.repeatOffer * (p.repeatOfferAccounts - 1));
    if (p?.flags.includes('terminated')) risk += s.risk.terminated;
    const conf = [...input.give, ...input.get].reduce((a, v) => a + v.confidence, 0) / Math.max(1, input.give.length + input.get.length);
    const term = (key: ScoreTerm['key'], label: string, raw: number, weight: number): ScoreTerm => ({ key, label, raw, weight, value: weight * raw, explanation: label });
    const terms = [
      term('edge', 'Edge vs norm (pp)', edgePct * 100, w.edge),
      term('liquid', 'Liquid excess (pp)', (totals.liquidGainPct - totals.rawGainPct) * 100, w.liquid),
      term('momentum', 'Momentum (pp)', totals.momentumPct * 100, w.momentum),
      term('risk', 'Risk points', risk, -w.risk),
      term('confidence', 'Low confidence', (1 - conf) * 10, -w.confidence),
    ];
    const logit = w.scale * sum(terms.map((t) => t.value)) + w.bias;
    let score = 100 / (1 + Math.exp(-logit));
    const capped = input.give.some((v) => s.holdList.includes(v.assetId));
    if (capped) score = Math.min(score, s.verdictBands.counter - 1);
    let verdict: Verdict = score >= s.verdictBands.accept ? 'Accept' : score >= s.verdictBands.leanAccept ? 'Lean accept' : score >= s.verdictBands.counter ? 'Counter' : 'Decline';
    if (!capped && totals.rawGainPct > 0 && totals.liquidGain < 0 && (verdict === 'Accept' || verdict === 'Lean accept')) verdict = 'Counter';
    const flags: TradeScore['flags'] = [...new Set([...input.get.flatMap((v) => v.flags), ...(p?.flags ?? [])])];
    if (capped) flags.push('hold_list_violation');
    const base = {
      tradeId: input.trade.tradeId, score, verdict, terms, logit, totals, shape, dominantAssetId, normPct,
      rawGainPct: totals.rawGainPct, edgePct, confidence: conf, give: input.give, get: input.get, partner: p, flags,
      explanation: `[fallback engine] ${(totals.rawGainPct * 100).toFixed(1)}% raw, ${(edgePct * 100).toFixed(1)}% vs ${shape.toLowerCase()} norm.` +
        (input.get.some((v) => v.isOnHold) ? ' An item you would receive is on hold and cannot be re-traded until the hold ends.' : ''),
      capped, modelVersion: this.modelVersion, scoredAt: input.now,
    };
    return { ...base, counterSuggestion: this.suggestCounter(input, base) };
  },

  suggestCounter(_input, score) {
    if (score.edgePct >= 0) return null;
    const need = -score.edgePct * score.totals.valueGive;
    return { valueNeeded: need, options: [], text: `Ask for about ${Math.ceil(need).toLocaleString()} more value.` };
  },

  computeAccuracy(outcomes: TradeOutcome[], now: number): ModelAccuracy {
    return { trades: outcomes.length, verdictHitRate: null, avgDrift30dAccepted: null, avgDrift30dDeclined: null, calibratedNorms: null, computedAt: now };
  },

  calibrateNorms(_o: TradeOutcome[], _c: OverpayNormTable) { return null; },
};
