/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** RAP-delta sale reconstruction, projection (manipulation) detector and hoard detector. */
import type { ProjectionResult, HoardResult } from './contracts.js';
import { DEFAULT_SETTINGS, type AssetId, type Evidence, type ItemSnapshot, type ReconstructedSale, type Settings } from './types.js';
import { DAY_MS, fmtR, isoDay, median, median30d, salePricesInWindow } from './util.js';

/** salePrice = oldRAP + 10*(newRAP-oldRAP); oldRAP=0 -> newRAP. */
export function reconstructSalePrice(oldRap: number, newRap: number): number {
  if (!oldRap) return newRap;
  return oldRap + 10 * (newRap - oldRap);
}

/** Each RAP change between consecutive snapshots implies (at least) one sale. */
export function salesFromRapSnapshots(assetId: AssetId, snaps: Array<{ t: number; rap: number }>): ReconstructedSale[] {
  const s = [...snaps].filter((x) => Number.isFinite(x.rap)).sort((a, b) => a.t - b.t);
  const out: ReconstructedSale[] = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1]!;
    const cur = s[i]!;
    if (cur.rap === prev.rap || cur.rap <= 0) continue;
    let price = reconstructSalePrice(prev.rap, cur.rap);
    // A drop too steep for one sale (several sales collapsed into one delta) still means sales below
    // the new RAP: keep it at the new RAP (an upper bound) instead of dropping the low evidence.
    if (price <= 0) price = cur.rap;
    out.push({ assetId, t: cur.t, price, oldRap: prev.rap, newRap: cur.rap, source: 'rap_snapshot_delta' });
  }
  return out.reverse(); // newest first, matching ItemSnapshot.lastSales
}

export function detectProjection(s: ItemSnapshot, settings: Settings, now: number): ProjectionResult {
  const p = settings.projection;
  const evidence: Evidence[] = [];
  const rules: Array<1 | 2 | 3 | 4> = [];
  const med = median30d(s, now);
  const nSales = s.lastSales.filter((x) => x.t > now - 30 * DAY_MS).length
    || (s.sales30d ?? 0);

  // Rule 1: RAP far above the 30-day median with almost no sales backing it.
  if (med != null && med > 0 && s.rap >= p.rapVsMedianRatio * med && nSales <= p.rule1MaxSales) {
    rules.push(1);
    evidence.push({
      code: 'rule1_rap_vs_median', severity: 'bad',
      message: `RAP ${fmtR(s.rap)} is ${(s.rap / med).toFixed(1)}x the 30-day median sale ${fmtR(med)} with only ${nSales} sale(s)`,
      data: { rap: s.rap, median30d: med, sales: nSales },
    });
  }

  // Rule 2: a single sale >= 2x the RAP before it, RAP not mean-reverted since.
  let firstSpikeT: number | null = null;
  const spikes = s.lastSales
    .filter((x) => x.t > now - p.spikeWindowDays * DAY_MS && x.oldRap > 0 && x.price >= p.spikeRatio * x.oldRap)
    .sort((a, b) => a.t - b.t);
  let baseline: number | null = null;
  if (spikes.length) {
    const first = spikes[0]!;
    const pre = median(salePricesInWindow(s, now, p.baselineWindowDays, first.t));
    const base = pre ?? s.roliValue ?? s.floorPrice ?? first.oldRap;
    if (s.rap > base * (1 + p.meanRevertTolerancePct)) {
      rules.push(2);
      firstSpikeT = first.t;
      baseline = base;
      evidence.push({
        code: 'rule2_single_spike', severity: 'bad',
        message: `Sale at ${fmtR(first.price)} on ${isoDay(first.t)} vs RAP ${fmtR(first.oldRap)} before it; RAP still ${fmtR(s.rap)} vs baseline ${fmtR(base)}`,
        data: { salePrice: first.price, rapBefore: first.oldRap, saleAt: isoDay(first.t), rap: s.rap, baseline: base },
      });
    }
  }

  // Rule 3: the sell book clears far below RAP.
  if (s.floorPrice != null && s.floorPrice > 0 && (s.resellerCount ?? 0) >= p.rule3MinResellers
    && s.floorPrice <= p.floorVsRapRatio * s.rap) {
    rules.push(3);
    evidence.push({
      code: 'rule3_floor_vs_rap', severity: 'bad',
      message: `Floor ${fmtR(s.floorPrice)} is ${Math.round((s.floorPrice / s.rap) * 100)}% of RAP ${fmtR(s.rap)} with ${s.resellerCount} resellers`,
      data: { floor: s.floorPrice, rap: s.rap, resellers: s.resellerCount ?? null },
    });
  }

  // Rule 4: Rolimons says projected.
  if (s.roliProjected) {
    rules.push(4);
    evidence.push({ code: 'rule4_rolimons_projected', severity: 'bad', message: 'Rolimons marks this item as projected' });
  }

  let preSpikeBaseline: number | null = null;
  if (rules.length) {
    if (baseline != null) preSpikeBaseline = baseline;
    else {
      const candidates = [s.roliValue, med != null && s.floorPrice != null ? Math.min(med, s.floorPrice) : med, s.floorPrice];
      preSpikeBaseline = candidates.find((x): x is number => x != null && x > 0) ?? null;
    }
    if (s.roliValue != null && preSpikeBaseline != null) preSpikeBaseline = Math.min(preSpikeBaseline, s.roliValue);
    // Rule 3 means the book clears far below RAP: whatever the baseline source (even a Rolimons
    // value), anyone can buy at the floor, so the item is not worth more than that.
    if (rules.includes(3) && preSpikeBaseline != null) preSpikeBaseline = Math.min(preSpikeBaseline, s.floorPrice!);
    if (preSpikeBaseline != null) {
      evidence.push({
        code: 'pre_spike_baseline', severity: 'info',
        message: `Pre-spike baseline ${fmtR(preSpikeBaseline)}${firstSpikeT ? ` (sales before ${isoDay(firstSpikeT)})` : ''}`,
        data: { baseline: preSpikeBaseline },
      });
    }
  }
  return { suspectProjected: rules.length > 0, rulesFired: rules, preSpikeBaseline, evidence };
}

export function detectHoard(s: ItemSnapshot, settings: Settings): HoardResult {
  const evidence: Evidence[] = [];
  const supply = s.publicCopies ?? s.totalQuantity ?? null;
  const rareMax = settings.valuation.rareMaxCopies ?? DEFAULT_SETTINGS.valuation.rareMaxCopies;
  // On big supplies, a few copies in one hand is normal ownership: also require a share of supply.
  const minTop = supply != null && supply > rareMax
    ? Math.max(settings.hoard.minCopies, Math.ceil((settings.hoard.minShareOfSupply ?? DEFAULT_SETTINGS.hoard.minShareOfSupply ?? 0.02) * supply))
    : settings.hoard.minCopies;
  if (s.topOwnerCopies != null && s.topOwnerCopies >= minTop) {
    evidence.push({
      code: 'hoard_single_owner', severity: 'warn',
      message: `One owner holds ${s.topOwnerCopies} copies`, data: { copies: s.topOwnerCopies },
    });
  }
  if (s.top3OwnerShare != null && s.top3OwnerShare >= settings.hoard.top3Share) {
    evidence.push({
      code: 'hoard_top3_share', severity: 'warn',
      message: `Top 3 owners hold ${Math.round(s.top3OwnerShare * 100)}% of public copies`, data: { share: s.top3OwnerShare },
    });
  }
  return { hoardRisk: evidence.length > 0, evidence };
}

/**
 * Hoard release: the top owner's copy count fell sharply inside the window, i.e. a hoard (often a
 * compromised one) is being dumped onto the market. `history` is any series of readings with
 * fetchedAt + topOwnerCopies; the newest reading at or before `now` is "now".
 */
export function detectHoardRelease(
  history: Array<Pick<ItemSnapshot, 'fetchedAt' | 'topOwnerCopies'>> | null | undefined,
  settings: Settings, now: number,
): HoardResult {
  const H = settings.hoard;
  const pts = (history ?? [])
    .filter((h) => h.topOwnerCopies != null && Number.isFinite(h.topOwnerCopies) && h.fetchedAt <= now
      && h.fetchedAt >= now - H.releaseWindowDays * DAY_MS)
    .sort((a, b) => a.fetchedAt - b.fetchedAt);
  if (pts.length < 2) return { hoardRisk: false, evidence: [] };
  const cur = pts[pts.length - 1]!.topOwnerCopies!;
  const prevMax = Math.max(...pts.slice(0, -1).map((h) => h.topOwnerCopies!));
  if (prevMax < H.minCopies || cur > prevMax * (1 - H.releaseDropPct)) return { hoardRisk: false, evidence: [] };
  return {
    hoardRisk: true,
    evidence: [{
      code: 'hoard_releasing', severity: 'warn',
      message: `Top owner went from ${prevMax} to ${cur} copies within ${H.releaseWindowDays} days (hoard being released)`,
      data: { prevMax, now: cur },
    }],
  };
}
