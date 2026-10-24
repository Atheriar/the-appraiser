/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Per-item valuation: tradeValue / liquidationValue / liquidity / confidence / 14d drift,
 * with flags and evidence. Rolimons value is a first-class anchor, corrected by market
 * microstructure (floor, 30d median, velocity, book depth, ad demand, momentum).
 */
import { DEFAULT_LIQUIDITY, type Demand, type Evidence, type ItemFlag, type ItemSnapshot, type LiquiditySettings, type Settings, type ValuedItem } from './types.js';
import { detectHoard, detectHoardRelease, detectProjection } from './projection.js';
import {
  DAY_MS, clamp, fmtPct, fmtR, logSlopePerDay, median30d, priceCv, sales30d, volumeSum,
} from './util.js';


export function serialMultiplier(serial: number | null | undefined, s: ItemSnapshot, settings: Settings): number {
  const v = settings.valuation;
  if (!v.serialPremiumEnabled || serial == null || serial <= 0 || !s.isLimitedU) return 1;
  if (s.roliValue == null && !v.serialPremiumForUnvalued) return 1;
  for (const row of v.serialPremium) {
    if (row.exact?.includes(serial)) return row.multiplier;
    if (row.maxSerial != null && !row.exact && serial <= row.maxSerial) return row.multiplier;
  }
  return 1;
}

export interface LiquidityBreakdown { liquidity: number; parts: Record<string, number> }

/**
 * Price-tier factor: big items trade slower (fewer buyers can afford them, offers take longer).
 * Defaults (settings.valuation.liquidity): 1.0 up to 10k, then -0.1 per decade of value, floored at 0.7 (>= ~10M).
 */
export function priceTierFactor(value: number | null | undefined, cfg: LiquiditySettings = DEFAULT_LIQUIDITY): number {
  const anchor = cfg.priceTierAnchor > 0 ? cfg.priceTierAnchor : DEFAULT_LIQUIDITY.priceTierAnchor;
  if (value == null || !(value > anchor)) return 1;
  return clamp(1 - cfg.priceTierSlopePerDecade * Math.log10(value / anchor), Math.min(1, cfg.priceTierFloor), 1);
}

/** Liquidity component for a Rolimons demand index; `known` is false when the index is not in the map. */
export function demandLiquidity(demand: number, cfg: LiquiditySettings = DEFAULT_LIQUIDITY): { value: number; known: boolean } {
  const v = cfg.demandLiquidity[String(demand)];
  return typeof v === 'number' && Number.isFinite(v) ? { value: v, known: true } : { value: cfg.unknownDemandLiquidity, known: false };
}

/** True when the snapshot carries first-party (marketplace-sales) or reconstructed sales velocity. */
function hasRealVelocity(s: ItemSnapshot): boolean {
  return s.sales30d != null || s.dailyVolume.length > 0;
}

export function computeLiquidity(s: ItemSnapshot, now: number, med: number | null, value?: number | null, cfg: LiquiditySettings = DEFAULT_LIQUIDITY): LiquidityBreakdown {
  const parts: Record<string, number> = {};
  const w: Record<string, number> = {};
  // Rolimons demand is a tier-blind opinion: weight it down when real velocity is known.
  const real = hasRealVelocity(s);
  if (s.roliDemand != null) { parts.demand = demandLiquidity(s.roliDemand, cfg).value; w.demand = real ? 0.15 : 0.35; }
  const s30 = sales30d(s, now);
  const copies = s.publicCopies ?? s.totalQuantity;
  if (s30 != null && copies) {
    const turnover = s30 / copies;
    parts.turnover = clamp(Math.log1p(turnover * 100) / Math.log1p(20), 0, 1);
    w.turnover = real ? 0.3 : 0.25;
  }
  if (s30 != null && s.resellerCount != null) {
    const perDay = s30 / 30;
    const daysToClear = s.resellerCount === 0 ? 0 : perDay > 0 ? s.resellerCount / perDay : 999;
    parts.velocity = 1 / (1 + daysToClear / 7);
    w.velocity = real ? 0.3 : 0.2;
  }
  if (s.floorPrice != null && med != null && med > 0) {
    parts.spread = clamp(1 - Math.abs((s.floorPrice - med) / med) * 2, 0, 1);
    w.spread = 0.1;
  }
  const req = s.adRequestCount ?? null;
  const off = s.adOfferCount ?? null;
  if (req != null && off != null && req + off >= 3) {
    parts.ads = req / (req + off);
    w.ads = 0.1;
  }
  const keys = Object.keys(parts);
  let liq = cfg.unknownDemandLiquidity;
  if (keys.length) {
    const tw = keys.reduce((a, k) => a + (w[k] ?? 0), 0);
    liq = keys.reduce((a, k) => a + (parts[k]! * (w[k] ?? 0)), 0) / tw;
  }
  const tier = priceTierFactor(value, cfg);
  if (tier < 1) { parts.priceTier = tier; liq *= tier; }
  if (s30 === 0) liq = Math.min(liq, cfg.noSalesCap);
  return { liquidity: clamp(liq, 0, 1), parts };
}

/** Mean positive daily price for days in [now-toDays, now-fromDays). */
function windowMean(points: ItemSnapshot['dailyPrice'], now: number, fromDays: number, toDays: number): number | null {
  const DAY = 86_400_000;
  const v = points.filter((p) => p.value > 0 && p.t <= now - fromDays * DAY && p.t > now - toDays * DAY).map((p) => p.value);
  return v.length >= 2 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function valueItem(
  s: ItemSnapshot, settings: Settings, now: number,
  opts?: { serial?: number | null; isOnHold?: boolean },
): ValuedItem {
  const V = settings.valuation;
  const flags = new Set<ItemFlag>();
  const evidence: Evidence[] = [];
  const serial = opts?.serial ?? s.serial ?? null;
  const isOnHold = opts?.isOnHold ?? s.isOnHold ?? false;
  const med = median30d(s, now);
  const s30 = sales30d(s, now);
  const proj = detectProjection(s, settings, now);
  const hoard = detectHoard(s, settings);

  // ---- 1. anchor --------------------------------------------------------
  let basis: ValuedItem['basis'];
  let value: number;
  let confidenceCap = 1;
  if (s.manualValue != null && s.manualValue > 0) {
    basis = 'manual'; value = s.manualValue; flags.add('manual_override');
    evidence.push({ code: 'manual_override', severity: 'info', message: `Manual value ${fmtR(value)} applied` });
  } else if (proj.suspectProjected && proj.preSpikeBaseline != null) {
    basis = 'pre_spike_baseline'; value = proj.preSpikeBaseline;
  } else if (s.roliValue != null && s.roliValue > 0) {
    basis = 'roli_value'; value = s.roliValue;
  } else if (s.rap > 0 && (s.floorPrice != null || med != null)) {
    if (s.floorPrice != null && s.rap > s.floorPrice * (1 + V.rapFloorTolerancePct)) {
      basis = 'market_min';
      // The buy-now floor is what the item actually clears at: a 30d median above it (possibly pumped
      // by wash sales just under the spike ratio) may lift the value at most to the tolerance band.
      value = Math.min(s.rap, Math.max(s.floorPrice, Math.min(med ?? 0, s.floorPrice * (1 + V.rapFloorTolerancePct))));
      evidence.push({
        code: 'rap_vs_floor', severity: 'warn',
        message: `RAP ${fmtR(s.rap)} is above floor ${fmtR(s.floorPrice)} by >${Math.round(V.rapFloorTolerancePct * 100)}%; valued at ${fmtR(value)}`,
        data: { rap: s.rap, floor: s.floorPrice, median30d: med },
      });
    } else if (s.floorPrice == null && med != null && s.rap > med * (1 + V.rapFloorTolerancePct)) {
      // No sell book: the 30d median sale is the only market check on RAP.
      basis = 'market_min';
      value = Math.min(s.rap, med * (1 + V.rapFloorTolerancePct));
      confidenceCap = 0.5;
      evidence.push({
        code: 'rap_vs_median', severity: 'warn',
        message: `RAP ${fmtR(s.rap)} is above the 30d median sale ${fmtR(med)} by >${Math.round(V.rapFloorTolerancePct * 100)}% and there is no floor; valued at ${fmtR(value)}`,
        data: { rap: s.rap, median30d: med },
      });
    } else { basis = 'rap'; value = s.rap; }
  } else if (s.floorPrice != null && s.floorPrice > 0) {
    basis = 'floor'; value = s.floorPrice; confidenceCap = 0.35;
  } else {
    basis = 'rap'; value = Math.max(0, s.rap); confidenceCap = 0.3;
  }
  if (s.roliValue == null && basis !== 'manual') flags.add('unvalued');
  if (proj.suspectProjected) {
    flags.add('projected');
    evidence.push(...proj.evidence);
  }
  if (s.roliProjected) flags.add('roli_projected');

  // ---- 2. value lag (raise / drop pending), valued items only ----------
  let lagGap = 0;
  let lagDelta = 0;
  if (basis === 'roli_value') {
    const refs = [med, s.floorPrice].filter((x): x is number => x != null && x > 0);
    const mkt = refs.length ? refs.reduce((a, b) => a + b, 0) / refs.length : null;
    const v30 = s30;
    const v90 = volumeSum(s.dailyVolume, now, 90);
    const volOk = v30 != null && v30 > 0 && (v90 == null || v30 >= v90 / 3 * 0.999);
    const thr = V.valueLagThresholdPct;
    if (mkt != null && volOk && refs.length === 2 && refs.every((r) => r >= value * (1 + thr))) {
      {
        const lift = Math.min(V.valueLagLiftFraction * (mkt - value), V.valueLagMaxLiftPct * value);
        flags.add('raise_pending');
        evidence.push({
          code: 'value_lag_up', severity: 'good',
          message: `30d median ${fmtR(med!)} and floor ${fmtR(s.floorPrice!)} are both >=${Math.round(thr * 100)}% above value ${fmtR(value)}; raise likely`,
          data: { value, median30d: med, floor: s.floorPrice, lift },
        });
        lagDelta = lift;
        lagGap = (mkt - (value + lift)) / (value + lift);
      }
    } else if (mkt != null && refs.every((r) => r <= value * (1 - thr))) {
      // Downside is asymmetric: one market reference is enough, and no recent sales is a reason to
      // distrust the value (not to skip the correction). The drop may reach valueLagMaxDropPct.
      {
        const drop = Math.min((V.valueLagDropFraction ?? 1) * (value - mkt), (V.valueLagMaxDropPct ?? 0.25) * value);
        flags.add('drop_pending');
        evidence.push({
          code: 'value_lag_down', severity: 'bad',
          message: `${[med != null ? `30d median ${fmtR(med)}` : null, s.floorPrice != null ? `floor ${fmtR(s.floorPrice)}` : null].filter(Boolean).join(' and ')} ${refs.length > 1 ? 'are both' : 'is'} >=${Math.round(thr * 100)}% below value ${fmtR(value)}; drop likely`,
          data: { value, median30d: med, floor: s.floorPrice, drop },
        });
        lagDelta = -drop;
        lagGap = (mkt - (value - drop)) / (value - drop);
      }
    }
  }

  // ---- 3. serial premium ------------------------------------------------
  // Applied to the base value only: the value-lag lift/drop is a generic-copy market signal and must
  // not be multiplied by a serial premium.
  const mult = serialMultiplier(serial, s, settings);
  value = value * mult + lagDelta;
  if (mult !== 1) {
    evidence.push({ code: 'serial_premium', severity: 'good', message: `Serial #${serial} premium x${mult}`, data: { serial, mult } });
  }

  // ---- 4. liquidity -----------------------------------------------------
  const LQ = V.liquidity ?? DEFAULT_LIQUIDITY;
  if (s.roliDemand != null && !demandLiquidity(s.roliDemand, LQ).known) {
    evidence.push({
      code: 'unknown_demand_index', severity: 'warn',
      message: `Demand index ${s.roliDemand} is not in the demand-to-liquidity map; using ${LQ.unknownDemandLiquidity} (add it under Settings > valuation.liquidity.demandLiquidity)`,
      data: { demand: s.roliDemand },
    });
  }
  const { liquidity, parts } = computeLiquidity(s, now, med, value, LQ);
  if (liquidity < LQ.lowLiquidityCut) {
    flags.add('low_liquidity');
    evidence.push({
      code: 'low_liquidity', severity: 'warn',
      message: `Low liquidity ${liquidity.toFixed(2)} (${Object.entries(parts).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') || 'no data'})`,
      data: { liquidity, sales30d: s30 },
    });
  }
  const thin = (s.resellerCount != null && s.resellerCount < V.thinBookResellers) || (s30 != null && s30 < V.thinBookSales30d);
  if (thin) {
    flags.add('thin_book');
    evidence.push({
      code: 'thin_book', severity: 'warn',
      message: `Thin market: ${s.resellerCount ?? '?'} resellers, ${s30 ?? '?'} sales in 30d`,
      data: { resellers: s.resellerCount ?? null, sales30d: s30 },
    });
  }

  // ---- 5. liquidation value --------------------------------------------
  const liqBase = s.floorPrice ?? (med != null ? med : value * 0.8);
  const liquidationValue = Math.max(0, Math.min(liqBase, s.floorPrice != null ? Infinity : value)
    * (1 - V.marketplaceFeePct) * (thin ? 1 - V.thinBookDiscountPct : 1) * (0.7 + 0.3 * liquidity));

  // ---- 6. expected 14d drift -------------------------------------------
  let drift = 0;
  // The raise_pending lift is already in tradeValue: only the downside lag also counts as drift.
  if (lagGap < 0) drift += clamp(lagGap * 0.5, -0.1, 0);
  const slope = logSlopePerDay(s.dailyPrice, now, 30);
  if (slope) {
    let m = clamp((Math.exp(slope.slope * 14) - 1) * Math.min(1, slope.n / 10), -0.15, 0.15);
    // A projected item's recent rise is the pump itself: it is expected to revert, not continue.
    if (proj.suspectProjected) m = Math.min(m, 0);
    // Market already below value: an upward 30d slope must not cancel the expected drop.
    if (flags.has('drop_pending')) m = Math.min(m, 0);
    const rec3 = windowMean(s.dailyPrice, now, 0, 3);
    const prior14 = windowMean(s.dailyPrice, now, 3, 17);
    const rec7 = windowMean(s.dailyPrice, now, 0, 7);
    const prior21 = windowMean(s.dailyPrice, now, 7, 28);
    // Fresh breakdown: the last 3 days sit >8% under the prior 14 -> no upside from the 30d fit.
    if (rec3 != null && prior14 != null && rec3 < prior14 * 0.92) m = Math.min(m, 0);
    if (m < 0 && !proj.suspectProjected && rec7 != null && prior21 != null && rec7 < prior21 * 0.8) {
      // Completed step-down: the new level has held (flat in-regime slope, healthy sales) and the
      // value already sits on it, so do not extrapolate the finished step as a future fall.
      const reg = logSlopePerDay(s.dailyPrice, now, 10);
      const regM = reg ? (Math.exp(reg.slope * 14) - 1) : null;
      if (reg && reg.n >= 7 && regM != null && Math.abs(regM) < 0.06 && (s30 ?? 0) >= 10) m = Math.max(m, Math.min(regM, 0), -0.05);
    }
    drift += m;
    if (Math.abs(m) >= 0.03) {
      evidence.push({
        code: 'momentum', severity: m > 0 ? 'good' : 'warn',
        message: `30d price momentum projects ${fmtPct(m)} over 14 days`, data: { momentum: m },
      });
    }
  }
  const trend = s.roliTrend;
  if (trend === 3) { drift += 0.02; flags.add('raising'); }
  if (trend === 0) { drift -= 0.03; flags.add('lowering'); }
  const cv = priceCv(s.dailyPrice, now, 30);
  if (trend === 1 || trend === 4 || (cv != null && cv > 0.5)) {
    flags.add('unstable');
    if (trend === 1) drift -= 0.02;
    if (cv != null && cv > 0.5) {
      evidence.push({ code: 'volatile', severity: 'warn', message: `Daily price volatility ${Math.round(cv * 100)}% (30d)`, data: { cv } });
    }
  }
  if (proj.suspectProjected && basis !== 'pre_spike_baseline') drift -= 0.05;
  else if (proj.suspectProjected) drift -= 0.02;
  if (hoard.hoardRisk) {
    drift -= 0.03; flags.add('hoard_risk'); evidence.push(...hoard.evidence);
  }
  // topOwnerHistory holds every owners reading (newest = current topOwnerCopies).
  const release = detectHoardRelease((s.topOwnerHistory ?? []).map((h) => ({ fetchedAt: h.t, topOwnerCopies: h.copies })), settings, now);
  if (release.hoardRisk) {
    drift -= 0.03; flags.add('hoard_releasing'); evidence.push(...release.evidence);
  }
  // New release / thin history: the value rests on too few trades to be trusted yet.
  const P0 = settings.scoring;
  const ageDays = s.createdAt != null && s.createdAt > 0 ? (now - s.createdAt) / DAY_MS : null;
  const newRelease = ageDays != null && ageDays < P0.newReleaseDays;
  const fewSales = s.roliValue == null && (s30 ?? 0) < P0.thinHistoryMinSales;
  if ((newRelease || fewSales) && s.manualValue == null) {
    flags.add('thin_history');
    evidence.push({
      code: 'thin_history', severity: 'warn',
      message: newRelease
        ? `New release: created ${ageDays!.toFixed(1)} days ago; its value has not settled`
        : `Thin history: ${s30 ?? 0} sale(s) in 30d and no Rolimons value`,
      data: { ageDays: ageDays == null ? null : Math.round(ageDays * 10) / 10, sales30d: s30 },
    });
  }
  drift = clamp(drift, -0.25, 0.25);

  // ---- 7. confidence ----------------------------------------------------
  const refs = [s.roliValue, med, s.floorPrice].filter((x): x is number => x != null && x > 0);
  let agreement = 0.6;
  if (refs.length >= 2) {
    const spread = Math.max(...refs) / Math.min(...refs) - 1;
    agreement = spread <= 0.25 ? 1 : clamp(1 - (spread - 0.25) / 1.5, 0.3, 1);
  }
  if (proj.suspectProjected) agreement = Math.max(agreement, 0.6); // disagreement already explained
  const age = now - s.fetchedAt;
  const fresh = age <= V.staleAfterMs ? 1 : clamp(1 - (age - V.staleAfterMs) / (6 * V.staleAfterMs), 0.5, 1);
  if (age > V.staleAfterMs) {
    flags.add('stale_data');
    evidence.push({ code: 'stale_data', severity: 'warn', message: s.fetchedAt <= 0 ? 'No Roblox market snapshot fetched yet' : `Market data is ${Math.round(age / 60_000)} min old` });
  }
  const depth = 0.5 + 0.5 * Math.min(1, ((s30 ?? 0) + (s.resellerCount ?? 0)) / 10);
  let confidence = agreement * fresh * depth * (s.roliValue == null && basis !== 'manual' ? 0.75 : 1);
  // Missing key inputs lower confidence: copy count (rarity unknown) and Roblox's own market data
  // (floor / marketplace resale). Without them the value rests on community numbers alone.
  const copiesKnown = (s.publicCopies ?? s.totalQuantity) != null || !!s.roliRare;
  const robloxMarket = s.floorPrice != null || s.sources.includes('marketplace_sales') || s.sources.includes('economy_fallback');
  const missing: string[] = [];
  if (!copiesKnown) { confidence *= 0.85; missing.push('copy count'); }
  if (!robloxMarket) { confidence *= 0.75; missing.push('Roblox market data'); }
  if (missing.length && basis !== 'manual') {
    evidence.push({ code: 'missing_inputs', severity: 'info', message: `Lower confidence: no ${missing.join(' or ')} yet`, data: { copiesKnown: copiesKnown ? 1 : 0, robloxMarket: robloxMarket ? 1 : 0 } });
  }
  if (basis === 'manual') confidence = Math.max(confidence, 0.8);
  confidence = clamp(Math.min(confidence, confidenceCap), 0, 1);
  if (refs.length === 0 && s.lastSales.length === 0) {
    flags.add('no_market_data');
    evidence.push({ code: 'no_market_data', severity: 'warn', message: 'No Rolimons value, floor or sales data' });
  }

  // ---- 8. rarity, hold, poison ------------------------------------------
  const copies = s.publicCopies ?? s.totalQuantity;
  let rarity: ValuedItem['rarity'] = 'unknown';
  if (copies != null && copies > 0) {
    rarity = copies <= V.rareMaxCopies ? 'rare' : copies <= V.semiRareMaxCopies ? 'semi_rare' : 'common';
  }
  if (s.roliRare) rarity = 'rare';
  if (rarity === 'rare') flags.add('rare');
  if (rarity === 'semi_rare') flags.add('semi_rare');
  if (isOnHold) {
    flags.add('on_hold');
    evidence.push({ code: 'on_hold', severity: 'warn', message: 'On hold: cannot be re-traded until the hold ends' });
  }
  const P = settings.scoring;
  if (s.recentOwnerChurn30d != null && s.recentOwnerChurn30d >= P.poisonChurnThreshold && value >= P.poisonMinValue) {
    flags.add('poison_churn');
    evidence.push({
      code: 'poison_churn', severity: 'bad',
      message: `${Math.round(s.recentOwnerChurn30d * 100)}% of copies changed owner in 30d; inspect the UAID history on Rolimons`,
      data: { churn: s.recentOwnerChurn30d },
    });
  }

  return {
    assetId: s.assetId,
    name: s.name,
    serial,
    isOnHold,
    tradeValue: Math.round(value),
    liquidationValue: Math.round(liquidationValue),
    liquidity,
    confidence,
    rap: s.rap,
    roliValue: s.roliValue,
    basis,
    expectedDriftPct: drift,
    serialMultiplier: mult,
    preSpikeBaseline: proj.preSpikeBaseline,
    rarity,
    demand: (s.roliDemand ?? null) as Demand | null,
    trend: s.roliTrend ?? null,
    flags: [...flags],
    evidence,
    snapshotAt: s.fetchedAt,
  };
}


/**
 * Consolidation premium (grow_value upgrades): receiving one bigger item for several smaller ones
 * is worth a little extra when the consolidated item is at least as liquid as what is given
 * (one listing instead of many, cleaner path to further upgrades). +1% per extra item, max 3%.
 * Returns the multiplier for the dominant received item (1 = no premium).
 */
export function consolidationPremium(give: ValuedItem[], get: ValuedItem[], cfg: LiquiditySettings = DEFAULT_LIQUIDITY): { multiplier: number; index: number } {
  const none = { multiplier: 1, index: -1 };
  if (get.length === 0 || give.length <= get.length) return none;
  let index = 0;
  for (let i = 1; i < get.length; i++) if (get[i]!.tradeValue > get[index]!.tradeValue) index = i;
  const dom = get[index]!;
  const maxGive = Math.max(0, ...give.map((g) => g.tradeValue));
  if (dom.tradeValue <= maxGive) return none;
  const giveTot = give.reduce((a, g) => a + g.tradeValue, 0);
  if (giveTot <= 0) return none;
  // Compare liquidity before the price-tier factor: the received item is bigger by construction,
  // so its tier penalty would otherwise block almost every real consolidation.
  const baseLiq = (v: ValuedItem) => v.liquidity / priceTierFactor(v.tradeValue, cfg);
  const giveLiq = give.reduce((a, g) => a + g.tradeValue * baseLiq(g), 0) / giveTot;
  if (baseLiq(dom) < giveLiq - 1e-9) return none;
  if (dom.flags.includes('projected') || dom.flags.includes('roli_projected')) return none;
  return { multiplier: 1 + Math.min(0.03, 0.01 * (give.length - get.length)), index };
}
