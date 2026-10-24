/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { Fragment, useEffect, useState } from 'react';
import type { MyTradeItem, MyTradeRow, MyTradeSide, ThenBasis } from '@shared/api-types';
import { useMyTrades, type MyTradesQuery } from '../lib/api';
import { fmtK, pct, signed, tone } from '../lib/format';
import { Btn, HoldBadge, Loading, Panel, Stat, Thumb, VerdictChip } from '../components/ui';

const BASIS: Record<ThenBasis, { label: string; cls: string; title: string }> = {
  score_at_trade: { label: 'scored', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30', title: 'Values come from the score the app stored when the trade happened' },
  snapshot: { label: 'snapshot', cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/30', title: 'Values come from the nearest item snapshot at or before the trade date' },
  current_estimate: { label: 'estimated', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30', title: 'No data from before the trade: then-values are estimated from current values (low confidence)' },
};
const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
const input = 'rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-500';

function BasisChip({ basis }: { basis: ThenBasis }) {
  const b = BASIS[basis];
  return <span title={b.title} className={`rounded px-1 py-px text-[10px] ring-1 ${b.cls}`}>{b.label}</span>;
}

function Thumbs({ side }: { side: MyTradeSide }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {side.items.map((i, k) => <Thumb key={k} size={24} item={{ name: i.name, thumbnailUrl: i.thumbnailUrl, flags: [], serial: i.serial, tradeValue: i.valueNow }} />)}
      {side.items.filter((i) => i.hold).slice(0, 1).map((i, k) => <HoldBadge key={`h${k}`} hold={i.hold} />)}
      {side.robux > 0 && <span className="text-[10px] text-neutral-400">+R${fmtK(side.robux)}</span>}
      {!side.items.length && !side.robux && <span className="text-neutral-600">—</span>}
    </span>
  );
}

function Gain({ v, p }: { v: number; p: number | null }) {
  return <span className={`tabular-nums ${tone(v)}`}>{signed(v)}{p != null && <span className="ml-1 text-[10px] opacity-75">{pct(p, 0)}</span>}</span>;
}

function ItemTable({ title, side, fee }: { title: string; side: MyTradeSide; fee: number }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium text-neutral-400">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-neutral-500"><tr>
            {['Item', 'Value then', 'Value now', 'RAP then', 'RAP now', 'Basis'].map((h) => <th key={h} className="px-1.5 text-left font-normal">{h}</th>)}
          </tr></thead>
          <tbody>
            {side.items.map((i: MyTradeItem, k) => (
              <tr key={k} className="border-t border-neutral-800/70">
                <td className="px-1.5 py-1"><span className="flex items-center gap-1.5">
                  <Thumb size={20} item={{ name: i.name, thumbnailUrl: i.thumbnailUrl, flags: [], serial: i.serial, tradeValue: i.valueNow }} />
                  <span className="truncate">{i.name}</span>{i.serial != null && <span className="text-neutral-500">#{i.serial}</span>}
                  {i.hold && <HoldBadge hold={i.hold} />}
                </span></td>
                <td className="px-1.5 tabular-nums">{fmtK(i.valueThen)}</td>
                <td className={`px-1.5 tabular-nums ${tone(i.valueNow - i.valueThen)}`}>{fmtK(i.valueNow)}</td>
                <td className="px-1.5 tabular-nums text-neutral-400">{fmtK(i.rapThen)}</td>
                <td className="px-1.5 tabular-nums text-neutral-400">{fmtK(i.rapNow)}</td>
                <td className="px-1.5"><span title={`${i.basisNote} · ${i.confidence} confidence`} className="flex items-center gap-1"><BasisChip basis={i.basis} /><span className="text-[10px] text-neutral-500">{i.confidence}</span></span></td>
              </tr>
            ))}
            {side.robux > 0 && (
              <tr className="border-t border-neutral-800/70 text-neutral-400">
                <td className="px-1.5 py-1">Robux R${side.robux.toLocaleString('en-US')}{side.robuxCounted !== side.robux && <span className="text-[10px] text-neutral-500"> (counts {fmtK(side.robuxCounted)} after {Math.round(fee * 100)}% fee)</span>}</td>
                <td className="px-1.5 tabular-nums">{fmtK(side.robuxCounted)}</td><td className="px-1.5 tabular-nums">{fmtK(side.robuxCounted)}</td><td colSpan={3} />
              </tr>
            )}
            <tr className="border-t border-neutral-700 font-medium">
              <td className="px-1.5 py-1 text-neutral-400">Total</td>
              <td className="px-1.5 tabular-nums">{fmtK(side.valueThen + side.robuxCounted)}</td>
              <td className="px-1.5 tabular-nums">{fmtK(side.valueNow + side.robuxCounted)}</td>
              <td className="px-1.5 tabular-nums text-neutral-400">{fmtK(side.rapThen + side.robuxCounted)}</td>
              <td className="px-1.5 tabular-nums text-neutral-400">{fmtK(side.rapNow + side.robuxCounted)}</td><td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Detail({ r, fee }: { r: MyTradeRow; fee: number }) {
  return (
    <div className="space-y-2 bg-neutral-900/60 p-2">
      <div className="grid gap-3 lg:grid-cols-2">
        <ItemTable title="You gave" side={r.give} fee={fee} />
        <ItemTable title="You received" side={r.get} fee={fee} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-neutral-400">
        <span>Gain at trade time <Gain v={r.pnl.gainThen} p={r.pnl.gainThenPct} /></span>
        <span>If you had kept your side <Gain v={r.pnl.gainNow} p={r.pnl.gainNowPct} /></span>
        <span>Change since <span className={tone(r.pnl.changeSince)}>{signed(r.pnl.changeSince)}</span></span>
        <span>RAP gain then / now <span className={tone(r.pnl.rapGainThen)}>{signed(r.pnl.rapGainThen)}</span> / <span className={tone(r.pnl.rapGainNow)}>{signed(r.pnl.rapGainNow)}</span></span>
      </div>
      <div className="text-[11px] text-neutral-500">
        {r.scoreThen ? <>App verdict then: <VerdictChip verdict={r.scoreThen.verdict} score={r.scoreThen.score} /> ({r.scoreThen.modelVersion}) · </> : 'The app did not see this trade live, so there is no verdict from the time. · '}
        {r.scoreNow ? <>Current model ({r.scoreNow.modelVersion}): <VerdictChip verdict={r.scoreNow.verdict} score={r.scoreNow.score} /> on today&apos;s values. </> : 'Current model could not score it. '}
        {r.portfolioNote} Date: {new Date(r.date).toLocaleString()} ({r.dateBasis === 'completed_observed' ? 'completion seen by the app' : 'trade created; completion time unknown'}).
      </div>
    </div>
  );
}

export function MyTradesPage() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<NonNullable<MyTradesQuery['status']>>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => { const h = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(h); }, [search]);
  useEffect(() => setPage(1), [debounced, status, from, to, pageSize]);
  const q = useMyTrades({ status, page, pageSize, q: debounced || undefined, from: from || undefined, to: to || undefined });
  const d = q.data;
  const s = d?.summary;
  const toggle = (id: number) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const filtered = !!(debounced || from || to || status !== 'all');

  return (
    <div className="space-y-3">
      {s && s.trades > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded border border-neutral-800 bg-neutral-900 px-4 py-2">
          <Stat label={filtered ? `Trades (of ${d!.lifetimeTrades})` : 'Trades completed'} value={s.trades} />
          <Stat label="Gained at trade time" value={<span className={tone(s.gainThenTotal)}>{signed(s.gainThenTotal)}</span>} />
          <Stat label="Since (vs keeping)" value={<span className={tone(s.gainNowTotal)}>{signed(s.gainNowTotal)}</span>} />
          <Stat label="Win rate then / now" value={`${pct(s.winRateThen, 0, false)} / ${pct(s.winRateNow, 0, false)}`} />
          <Stat label="Best" value={s.best ? <span className={tone(s.best.gainNow)}>{signed(s.best.gainNow)} <span className="text-[10px] text-neutral-500">#{s.best.tradeId}</span></span> : '—'} />
          <Stat label="Worst" value={s.worst ? <span className={tone(s.worst.gainNow)}>{signed(s.worst.gainNow)} <span className="text-[10px] text-neutral-500">#{s.worst.tradeId}</span></span> : '—'} />
          {s.estimatedTrades > 0 && <Stat label="Estimated" value={<span className="text-amber-300" title="Trades with no data from before the trade: then-values use current values">{s.estimatedTrades}</span>} />}
        </div>
      )}
      <Panel title="My trades" right={<span className="text-[11px] text-neutral-500">completed trades · values then vs now · read-only</span>}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search partner, item, trade id" className={`${input} w-full sm:w-56`} />
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={input} title="Won/lost by value now vs keeping your side">
            <option value="all">All</option><option value="won">Won (now)</option><option value="lost">Lost (now)</option>
          </select>
          <label className="flex items-center gap-1 text-[11px] text-neutral-500">from<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={input} /></label>
          <label className="flex items-center gap-1 text-[11px] text-neutral-500">to<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} /></label>
          {filtered && <Btn onClick={() => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); }}>Clear</Btn>}
        </div>
        <Loading q={q} />
        {d && d.lifetimeTrades === 0 && (
          <div className="py-6 text-center text-sm text-neutral-400">No completed trades yet. Once the app has loaded your trade history (needs your cookie in <a href="#settings" className="text-sky-400 underline">Settings</a>), every completed trade shows here.</div>
        )}
        {d && d.lifetimeTrades > 0 && d.total === 0 && <div className="py-4 text-center text-xs text-neutral-500">No trades match these filters.</div>}
        {d && d.rows.length > 0 && (
          <>
            {/* Desktop / tablet: dense table with expandable rows. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs">
                <thead className="text-[11px] text-neutral-500"><tr>
                  {['', 'Date', 'Partner', 'Gave', 'Received', 'Then: gave → got', 'Gain then', 'Now (vs keeping)', 'Verdict then', 'Model now'].map((h, i) => <th key={i} className="px-1.5 text-left font-normal">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <Fragment key={r.tradeId}>
                      <tr className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-800/40" onClick={() => toggle(r.tradeId)}>
                        <td className="w-4 px-1.5 text-neutral-500">{open.has(r.tradeId) ? '▾' : '▸'}</td>
                        <td className="whitespace-nowrap px-1.5 py-1 tabular-nums"><div>{shortDate(r.date)}</div><div className="text-[10px] text-neutral-500">#{r.tradeId}</div></td>
                        <td className="max-w-[8rem] px-1.5"><a href={r.partner.profileUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="block truncate text-sky-400 hover:underline" title={`@${r.partner.name}`}>{r.partner.displayName}</a></td>
                        <td className="px-1.5"><Thumbs side={r.give} /></td>
                        <td className="px-1.5"><Thumbs side={r.get} /></td>
                        <td className="whitespace-nowrap px-1.5 tabular-nums text-neutral-400">{fmtK(r.give.valueThen + r.give.robuxCounted)} → {fmtK(r.get.valueThen + r.get.robuxCounted)} <BasisChip basis={r.thenBasis} /></td>
                        <td className="whitespace-nowrap px-1.5"><Gain v={r.pnl.gainThen} p={r.pnl.gainThenPct} /></td>
                        <td className="whitespace-nowrap px-1.5"><Gain v={r.pnl.gainNow} p={r.pnl.gainNowPct} /></td>
                        <td className="px-1.5">{r.scoreThen ? <VerdictChip verdict={r.scoreThen.verdict} score={r.scoreThen.score} /> : <span className="text-neutral-600">—</span>}</td>
                        <td className="px-1.5">{r.scoreNow ? <VerdictChip verdict={r.scoreNow.verdict} score={r.scoreNow.score} /> : <span className="text-neutral-600">—</span>}</td>
                      </tr>
                      {open.has(r.tradeId) && <tr><td colSpan={10} className="p-0"><Detail r={r} fee={d.robuxFee} /></td></tr>}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Phones: stacked cards. */}
            <div className="space-y-2 md:hidden">
              {d.rows.map((r) => (
                <div key={r.tradeId} className="rounded border border-neutral-800">
                  <button type="button" className="w-full space-y-1.5 p-2 text-left text-xs" onClick={() => toggle(r.tradeId)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate"><span className="text-neutral-400">{shortDate(r.date)}</span> · {r.partner.displayName}</span>
                      <BasisChip basis={r.thenBasis} />
                    </div>
                    <div className="flex items-center gap-2"><span className="w-10 text-[10px] text-neutral-500">gave</span><Thumbs side={r.give} /></div>
                    <div className="flex items-center gap-2"><span className="w-10 text-[10px] text-neutral-500">got</span><Thumbs side={r.get} /></div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[10px] text-neutral-500">then <Gain v={r.pnl.gainThen} p={r.pnl.gainThenPct} /></span>
                      <span className="text-[10px] text-neutral-500">now <Gain v={r.pnl.gainNow} p={r.pnl.gainNowPct} /></span>
                      {r.scoreNow && <VerdictChip verdict={r.scoreNow.verdict} score={r.scoreNow.score} />}
                    </div>
                  </button>
                  {open.has(r.tradeId) && <Detail r={r} fee={d.robuxFee} />}
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400">
              <span>{d.total} trade{d.total === 1 ? '' : 's'} · page {d.page} of {d.pages}{q.isFetching ? ' · updating…' : ''}</span>
              <span className="flex items-center gap-2">
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value) as 25 | 50 | 100)} className={input}>
                  {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
                </select>
                <Btn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={d.page <= 1}>Prev</Btn>
                <Btn onClick={() => setPage((p) => Math.min(d.pages, p + 1))} disabled={d.page >= d.pages}>Next</Btn>
              </span>
            </div>
          </>
        )}
      </Panel>
      <div className="text-[11px] text-neutral-500">
        Gain then = what you received minus what you gave, valued when the trade happened (Robux you receive count after the trade fee). Now (vs keeping) = your received side today minus what your given side would be worth today.
        Badges show where each then-value came from: <BasisChip basis="score_at_trade" /> the app's score at the time, <BasisChip basis="snapshot" /> the nearest earlier item snapshot, <BasisChip basis="current_estimate" /> today's value (no older data).
        Model accuracy stays on the <a href="#history" className="text-sky-400 underline">History</a> tab.
      </div>
    </div>
  );
}
