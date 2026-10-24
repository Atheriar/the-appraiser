/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { holdBadge, holdTooltip, type HoldEstimate } from '@shared/holds';
import type { Evidence, ValuedItem, Verdict } from '@shared/types';
import { DEMAND_LABEL, TREND_LABEL } from '@shared/types';
import { BAD_FLAGS, GOOD_FLAGS, VERDICT_CLASS, fmtK, pct, scoreColor } from '../lib/format';

export function VerdictChip({ verdict, score }: { verdict: Verdict; score?: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${VERDICT_CLASS[verdict]}`}>
      {score !== undefined && <span className="tabular-nums font-bold">{Math.round(score)}</span>}
      {verdict}
    </span>
  );
}

export function ScoreBig({ score }: { score: number }) {
  return <span className={`tabular-nums text-lg font-bold ${scoreColor(score)}`}>{Math.round(score)}</span>;
}

export function Flag({ flag }: { flag: string }) {
  const cls = BAD_FLAGS.has(flag)
    ? 'bg-rose-500/10 text-rose-300 ring-rose-500/30'
    : GOOD_FLAGS.has(flag)
      ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
      : 'bg-neutral-700/40 text-neutral-300 ring-neutral-600/40';
  return <span className={`rounded px-1 py-px text-[10px] ring-1 ${cls}`}>{flag.replace(/_/g, ' ')}</span>;
}

export function Flags({ flags, max }: { flags: readonly string[]; max?: number }) {
  if (!flags.length) return <span className="text-neutral-600">—</span>;
  const shown = max ? flags.slice(0, max) : flags;
  return (
    <span className="flex flex-wrap gap-0.5">
      {shown.map((f) => <Flag key={f} flag={f} />)}
      {max && flags.length > max && <span className="text-[10px] text-neutral-500" title={flags.slice(max).join(', ')}>+{flags.length - max}</span>}
    </span>
  );
}

export function Thumb({ item, size = 28 }: { item: Pick<ValuedItem, 'name' | 'thumbnailUrl' | 'flags' | 'serial' | 'tradeValue'>; size?: number }) {
  const bad = item.flags.some((f) => f === 'projected' || f === 'roli_projected' || f === 'hoard_risk' || f === 'poison_churn');
  const good = item.flags.some((f) => f === 'raise_pending' || f === 'rare');
  const ring = bad ? 'ring-rose-500/70' : good ? 'ring-emerald-500/60' : 'ring-neutral-700';
  return (
    <span className="relative inline-block" title={`${item.name} · ${fmtK(item.tradeValue)}${item.flags.length ? ' · ' + item.flags.join(', ') : ''}`}>
      {item.thumbnailUrl
        ? <img src={item.thumbnailUrl} alt={item.name} width={size} height={size} className={`rounded bg-neutral-800 ring-1 ${ring}`} loading="lazy" />
        : <span style={{ width: size, height: size }} className={`flex items-center justify-center rounded bg-neutral-800 text-[9px] text-neutral-400 ring-1 ${ring}`}>{initials(item.name)}</span>}
      {bad && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-rose-500" />}
      {!bad && good && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-500" />}
      {item.serial != null && item.serial <= 100 && (
        <span className="absolute -bottom-1 -left-1 rounded bg-amber-500 px-0.5 text-[8px] font-bold leading-tight text-black">#{item.serial}</span>
      )}
    </span>
  );
}

/** "Helm of the Secret Fire" -> "HSF"; skips filler words so placeholders stay distinguishable. */
function initials(name: string): string {
  const words = name.split(/[\s\-_:']+/).filter((w) => w && !/^(the|of|a|an|and)$/i.test(w));
  const s = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? name).slice(0, 3);
  return s.slice(0, 3).toUpperCase();
}

export function Sparkline({ points, width = 120, height = 28, className = 'stroke-sky-400' }: { points: Array<{ t: number; value: number }>; width?: number; height?: number; className?: string }) {
  const pts = smooth(points.filter((p) => Number.isFinite(p.value)), width);
  if (pts.length < 2) return <span className="text-[10px] text-neutral-600">no history</span>;
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (t: number) => (x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * (width - 2) + 1);
  const sy = (v: number) => (y1 === y0 ? height / 2 : height - 1 - ((v - y0) / (y1 - y0)) * (height - 2));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.value).toFixed(1)}`).join('');
  const area = `${d}L${sx(pts[pts.length - 1]!.t).toFixed(1)},${height}L${sx(pts[0]!.t).toFixed(1)},${height}Z`;
  const last = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} className="overflow-visible" aria-label="price history">
      <title>{`${fmtK(y0)} – ${fmtK(y1)} · last ${fmtK(last.value)}`}</title>
      <path d={area} className={`${className.replace(/stroke-/g, 'fill-')} opacity-10`} stroke="none" />
      <path d={d} fill="none" strokeWidth={1.25} strokeLinejoin="round" className={className} />
      <circle cx={sx(last.t)} cy={sy(last.value)} r={1.75} className={`${className} fill-neutral-950`} strokeWidth={1.25} />
    </svg>
  );
}

// Tailwind safelist for the area fills derived above: fill-sky-400 fill-emerald-400 fill-amber-400

/** Sort by time and, when there are more points than ~1 per 3px, bucket into medians so dense daily data reads as a trend. */
function smooth(points: Array<{ t: number; value: number }>, width: number): Array<{ t: number; value: number }> {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const maxPts = Math.max(8, Math.floor(width / 3));
  if (pts.length <= maxPts) return pts;
  const size = Math.ceil(pts.length / maxPts), out: Array<{ t: number; value: number }> = [];
  for (let i = 0; i < pts.length; i += size) {
    const b = pts.slice(i, i + size), vs = b.map((p) => p.value).sort((x, y) => x - y);
    out.push({ t: b[Math.floor(b.length / 2)]!.t, value: vs[Math.floor(vs.length / 2)]! });
  }
  return out;
}

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return null;
  const c = { info: 'text-neutral-400', warn: 'text-amber-300', bad: 'text-rose-300', good: 'text-emerald-300' } as const;
  return (
    <ul className="space-y-0.5 text-[11px]">
      {evidence.map((e, i) => <li key={i} className={c[e.severity]} title={e.code}>• {e.message}</li>)}
    </ul>
  );
}

export function Stat({ label, value, sub, className = '' }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col leading-tight ${className}`}>
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="tabular-nums text-sm text-neutral-100">{value}</span>
      {sub && <span className="text-[10px] text-neutral-500">{sub}</span>}
    </div>
  );
}

export function Panel({ title, children, right, className = '' }: { title: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded border border-neutral-800 bg-neutral-900/60 ${className}`}>
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Btn({ children, onClick, disabled, kind = 'default', title, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'default' | 'primary' | 'danger'; title?: string; type?: 'button' | 'submit' }) {
  const k = { default: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200', primary: 'bg-sky-600 hover:bg-sky-500 text-white', danger: 'bg-rose-700 hover:bg-rose-600 text-white' }[kind];
  return <button type={type} title={title} onClick={onClick} disabled={disabled} className={`whitespace-nowrap rounded px-2 py-1 text-xs disabled:opacity-40 ${k}`}>{children}</button>;
}

export function Loading({ q }: { q: { isLoading: boolean; error: unknown } }) {
  if (q.isLoading) return <div className="p-4 text-xs text-neutral-500">Loading…</div>;
  if (q.error) return <div className="p-4 text-xs text-rose-400">Error: {(q.error as Error).message}</div>;
  return null;
}

/** Re-render every `ms` (live countdowns). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Amber trade-hold chip: "trade hold · ~1d 4h left (est.)" / "purchase hold · due any time" / "hold (source unknown) · ..."; details in the tooltip. */
export function HoldBadge({ hold }: { hold: HoldEstimate | null | undefined }) {
  const now = useNow(30_000);
  const overdue = !!hold && hold.releaseAt <= now;
  return (
    <span title={holdTooltip(hold)} className={`whitespace-nowrap rounded px-1 text-[10px] ${overdue ? 'bg-amber-500/30 text-amber-200' : 'bg-amber-500/20 text-amber-300'}`}>
      {holdBadge(hold, now)}
    </span>
  );
}

export function ItemCard({ item, prices, children, hold }: { item: ValuedItem; prices?: Array<{ t: number; value: number }>; children?: ReactNode; hold?: HoldEstimate | null }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950/60 p-2">
      <div className="flex items-start gap-2">
        <Thumb item={item} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-neutral-100" title={item.name}>
            {item.name}{item.serial != null && <span className="ml-1 text-amber-400">#{item.serial}</span>}
          </div>
          {hold && <div className="mt-0.5"><HoldBadge hold={hold} /></div>}
          <div className="mt-0.5 grid grid-cols-3 gap-x-2 text-[10px] text-neutral-400 tabular-nums">
            <span>val <b className="text-neutral-200">{fmtK(item.tradeValue)}</b></span>
            <span>rap {fmtK(item.rap)}</span>
            <span>roli {fmtK(item.roliValue)}</span>
            <span>liq-val {fmtK(item.liquidationValue)}</span>
            <span>liq {(item.liquidity * 100).toFixed(0)}%</span>
            <span>conf {(item.confidence * 100).toFixed(0)}%</span>
            <span>dem {item.demand !== null ? DEMAND_LABEL[item.demand] : '—'}</span>
            <span>trend {item.trend !== null ? TREND_LABEL[item.trend] : '—'}</span>
            <span className={item.expectedDriftPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>14d {pct(item.expectedDriftPct)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-neutral-500">
            basis {item.basis.replace(/_/g, ' ')} · {item.rarity}{item.serialMultiplier !== 1 && ` · serial ×${item.serialMultiplier}`}
            {item.preSpikeBaseline != null && ` · pre-spike ${fmtK(item.preSpikeBaseline)}`}
          </div>
        </div>
        {prices && <Sparkline points={prices} width={90} height={32} />}
      </div>
      <div className="mt-1"><Flags flags={item.flags} /></div>
      <div className="mt-1"><EvidenceList evidence={item.evidence} /></div>
      {children}
    </div>
  );
}
