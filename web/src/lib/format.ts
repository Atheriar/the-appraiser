/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import type { TradeShape, Verdict } from '@shared/types';

export const fmtR = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

export const fmtK = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString('en-US');
};

export const signed = (n: number | null | undefined, f: (x: number) => string = fmtK): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`;

/** Fractions in, percent string out (0.08 -> "+8.0%"). */
export const pct = (f: number | null | undefined, digits = 1, sign = true): string =>
  f === null || f === undefined || !Number.isFinite(f)
    ? '—'
    : `${sign && f > 0 ? '+' : f < 0 ? '−' : ''}${Math.abs(f * 100).toFixed(digits)}%`;

export const tone = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) || n === 0 ? 'text-neutral-400' : n > 0 ? 'text-emerald-400' : 'text-rose-400';

export function ago(t: number | null | undefined, now = Date.now()): string {
  if (!t) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function until(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'expired';
  // Floor every unit so a carry never renders as "3d 24h" / "1h 60m".
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const date = (t: number | null | undefined): string => (t ? new Date(t).toLocaleString() : '—');

export const VERDICT_CLASS: Record<Verdict, string> = {
  Accept: 'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40',
  'Lean accept': 'bg-lime-500/15 text-lime-300 ring-lime-500/30',
  Counter: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  Decline: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

export const SHAPE_LABEL: Record<TradeShape, string> = { UPGRADE: 'Upgrade', DOWNGRADE: 'Downgrade', EVEN: 'Even' };

export function scoreColor(s: number): string {
  if (s >= 70) return 'text-emerald-300';
  if (s >= 50) return 'text-lime-300';
  if (s >= 35) return 'text-amber-300';
  return 'text-rose-300';
}

export const BAD_FLAGS = new Set([
  'projected', 'roli_projected', 'hoard_risk', 'poison_churn', 'drop_pending', 'lowering', 'unstable',
  'low_liquidity', 'thin_book', 'stale_data', 'no_market_data', 'bot_list', 'repeat_offer', 'new_account',
  'hidden_inventory', 'terminated', 'banned', 'low_inventory', 'prior_bad_history', 'hold_list_violation', 'unvalued_give',
  'exceeds_max_robux', 'below_min_value_ratio', 'on_hold', 'duplicate_of_owned', 'unvalued',
]);
export const GOOD_FLAGS = new Set(['raise_pending', 'raising', 'rare', 'semi_rare', 'wishlist', 'prior_good_history']);

/** Finer "time since" for live feeds: "12s", "2m 05s", "3h 20m", "2d 4h". */
export function sinceFine(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Robux with an "R$" prefix; 0 reads as "free". */
export const robux = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n === 0 ? 'free' : `R$${Math.round(n).toLocaleString('en-US')}`;

/** Countdown with seconds: "4m 12s", "1h 05m", "2d 3h"; "now" at or past zero. */
export function countdown(t: number | null | undefined, now = Date.now()): string {
  if (t == null) return '—';
  const s = Math.floor((t - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Duration without seconds below a day: "1h 32m", "48m", "35s". */
export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
