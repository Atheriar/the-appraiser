/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Small pure numeric helpers shared by the core engine. */
import type { ItemSnapshot, PricePoint } from './types.js';

export const DAY_MS = 86_400_000;

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export function fmtR(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1_000_000) return `${s}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2)}M`;
  if (a >= 10_000) return `${s}${Math.round(a / 1000)}k`;
  return `${s}${Math.round(a).toLocaleString('en-US')}`;
}
export const fmtPct = (f: number, digits = 1): string => `${f >= 0 ? '+' : ''}${(f * 100).toFixed(digits)}%`;
export const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

const inWindow = (t: number, now: number, days: number, endDays = 0) =>
  t <= now - endDays * DAY_MS && t > now - (days + endDays) * DAY_MS;

/** Sale prices observed in (now - days, now]: reconstructed sales preferred, daily prices as fallback. */
export function salePricesInWindow(s: ItemSnapshot, now: number, days: number, endBefore?: number): number[] {
  const end = endBefore ?? now;
  const start = end - days * DAY_MS;
  const sales = s.lastSales.filter((x) => x.t < end && x.t >= start && x.price > 0).map((x) => x.price);
  if (sales.length >= 3) return sales;
  const daily = s.dailyPrice.filter((p) => p.t < end && p.t >= start && p.value > 0).map((p) => p.value);
  if (daily.length > 0) return [...daily, ...sales];
  return sales;
}

export function median30d(s: ItemSnapshot, now: number): number | null {
  return median(salePricesInWindow(s, now, 30));
}

export function volumeSum(points: PricePoint[], now: number, days: number): number | null {
  const pts = points.filter((p) => inWindow(p.t, now, days));
  if (pts.length === 0) return null;
  return sum(pts.map((p) => p.value));
}

/** Sales in last 30d: explicit field, then daily volume, then reconstructed count. */
export function sales30d(s: ItemSnapshot, now: number): number | null {
  if (s.sales30d != null) return s.sales30d;
  const v = volumeSum(s.dailyVolume, now, 30);
  if (v != null) return v;
  if (s.lastSales.length) return s.lastSales.filter((x) => inWindow(x.t, now, 30)).length;
  return null;
}

/** Least-squares slope of ln(price) per day over the last `days`. */
export function logSlopePerDay(points: PricePoint[], now: number, days: number): { slope: number; n: number } | null {
  const pts = points.filter((p) => p.value > 0 && inWindow(p.t, now, days));
  if (pts.length < 5) return null;
  const xs = pts.map((p) => (p.t - now) / DAY_MS);
  const ys = pts.map((p) => Math.log(p.value));
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  return { slope: num / den, n: pts.length };
}

/** Coefficient of variation of positive daily prices over a window. */
export function priceCv(points: PricePoint[], now: number, days: number): number | null {
  const v = points.filter((p) => p.value > 0 && inWindow(p.t, now, days)).map((p) => p.value);
  if (v.length < 5) return null;
  const m = sum(v) / v.length;
  const sd = Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / v.length);
  return m > 0 ? sd / m : null;
}
