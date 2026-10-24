/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Counter search over the partner's tradable inventory.
 *
 * Text-only advice: nothing here (or anywhere) sends, counters, accepts or declines a trade.
 * Searches small changes — add 1-2 partner items, swap one received item for a partner item, each
 * optionally topped up with Robux inside the max-Robux rule — and keeps the smallest ones that bring
 * edge to >= 0, preferring liquid / high-demand items and never suggesting projected or on-hold items.
 */
import type { ScoreInput } from './contracts.js';
import type { CounterPackage, CounterPackageItem, ValuedItem } from './types.js';
import { edgeFor } from './tradeScoring.js';
import { fmtR, sum } from './util.js';

/** Max partner items considered per search (keeps pairs at <= ~435 evaluations). */
export const COUNTER_POOL_MAX = 30;

const isHeld = (i: ValuedItem): boolean => !!i.isOnHold || i.flags.includes('on_hold');
const isProjected = (i: ValuedItem): boolean => i.flags.includes('projected') || i.flags.includes('roli_projected');

/** 0..1 preference: liquid, high-demand items first. Unknown demand counts as neutral. */
export function itemPreference(i: ValuedItem): number {
  const d = i.demand == null || i.demand < 0 ? 0.5 : i.demand / 4;
  return 0.6 * Math.max(0, Math.min(1, i.liquidity)) + 0.4 * d;
}

/** Partner items eligible for a counter ask. */
export function eligiblePartnerItems(input: ScoreInput): ValuedItem[] {
  const inTrade = new Set(input.get.map((g) => g.assetId));
  return input.partnerTradable.filter((p) =>
    p.tradeValue > 0 && !isHeld(p) && !isProjected(p) && !inTrade.has(p.assetId)
    && !p.flags.includes('poison_churn') && !p.flags.includes('unvalued'));
}

const pkgItem = (i: ValuedItem): CounterPackageItem => ({ assetId: i.assetId, name: i.name, tradeValue: i.tradeValue, liquidity: i.liquidity, demand: i.demand });

interface Candidate { pkg: CounterPackage; cost: number }

export function searchCounterPackages(input: ScoreInput, limit = 3): CounterPackage[] {
  const baseEdge = edgeFor(input);
  if (baseEdge >= 0) return [];
  const eligible = eligiblePartnerItems(input);
  if (!eligible.length) return [];

  const fee = input.metadata.tradeSystemRobuxFee;
  const maxItems = input.metadata.maxItemsPerSide;
  const valueGive = sum(input.give.map((g) => g.tradeValue)) + input.trade.give.robux;
  const neededApprox = Math.max(1, -baseEdge * Math.max(1, valueGive));

  // Pool: items whose value is closest to what is needed (singles, and halves for pairs), best preference on ties.
  const pool = [...eligible]
    .sort((a, b) => {
      const da = Math.min(Math.abs(a.tradeValue - neededApprox), Math.abs(a.tradeValue - neededApprox / 2));
      const db = Math.min(Math.abs(b.tradeValue - neededApprox), Math.abs(b.tradeValue - neededApprox / 2));
      return da - db || itemPreference(b) - itemPreference(a);
    })
    .slice(0, COUNTER_POOL_MAX);

  const with_ = (get: ValuedItem[], robux: number): ScoreInput => ({
    ...input, get,
    trade: { ...input.trade, get: { ...input.trade.get, robux: input.trade.get.robux + robux } },
  });

  const results: Candidate[] = [];
  const evaluate = (add: ValuedItem[], swapOut: ValuedItem[]) => {
    const get = [...input.get.filter((g) => !swapOut.includes(g)), ...add];
    if (get.length > maxItems) return;
    let robux = 0;
    let edge = edgeFor(with_(get, 0));
    if (edge < 0) {
      // Robux top-up: missing gain ~= -edge * valueGive (after fee); verify, nudge up if filler/norm shifts bite.
      robux = Math.ceil((-edge * Math.max(1, valueGive)) / (1 - fee));
      for (let i = 0; i < 4; i++) {
        edge = edgeFor(with_(get, robux));
        if (edge >= 0) break;
        robux = Math.ceil(robux * 1.05) + 1;
      }
      if (edge < 0) return;
    }
    const rapGet = sum(get.map((g) => g.rap));
    const within = input.trade.get.robux + robux <= input.metadata.tradeSystemMaxRobuxPercent * rapGet;
    if (robux > 0 && !within) return; // never suggest breaking the max-Robux rule in a package
    const addedValue = sum(add.map((a) => a.tradeValue)) - sum(swapOut.map((s) => s.tradeValue)) + robux * (1 - fee);
    if (addedValue <= 0) return;
    // A token item riding on a big Robux ask is noise: the plain Robux option already covers it.
    if (add.some((a) => a.tradeValue < 0.15 * addedValue)) return;
    const pref = add.length ? sum(add.map(itemPreference)) / add.length : 1;
    const changes = add.length + swapOut.length + (robux > 0 ? 1 : 0);
    // Cost is what the partner gives up: Robux counts gross (the fee is lost on the way), so an item-only
    // package beats an item + Robux top-up that adds the same value.
    const partnerCost = addedValue + robux * fee;
    const cost = partnerCost * (1 + 0.3 * (1 - pref)) + changes * 0.02 * neededApprox;
    results.push({
      cost,
      pkg: { kind: 'package', add: add.map(pkgItem), swapOut: swapOut.map(pkgItem), robux, withinMaxRobuxRule: within, addedValue, resultingEdgePct: edge },
    });
  };

  for (let i = 0; i < pool.length; i++) {
    evaluate([pool[i]!], []);
    for (let j = i + 1; j < pool.length; j++) evaluate([pool[i]!, pool[j]!], []);
  }
  // Swap one received item (worst first: projected / held / illiquid) for a more valuable partner item.
  for (const out of input.get) {
    for (const p of pool) if (p.tradeValue > out.tradeValue) evaluate([p], [out]);
  }

  results.sort((a, b) => a.cost - b.cost);
  const seen = new Set<string>();
  const out: CounterPackage[] = [];
  for (const r of results) {
    const key = `${r.pkg.add.map((a) => a.assetId).sort().join(',')}|${r.pkg.swapOut.map((s) => s.assetId).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.pkg);
    if (out.length >= limit) break;
  }
  return out;
}

export function describePackage(p: CounterPackage): string {
  const names = p.add.map((a) => `${a.name} (${fmtR(a.tradeValue)})`).join(' + ');
  const robux = p.robux > 0 ? `${p.add.length ? ' plus ' : ''}${p.robux.toLocaleString('en-US')} Robux` : '';
  if (p.swapOut.length) return `swap their ${p.swapOut.map((s) => s.name).join(', ')} for ${names}${robux}`;
  return `ask them to add ${names}${robux}`;
}
