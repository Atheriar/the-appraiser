/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { Fragment, useMemo, useState } from 'react';
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState,
} from '@tanstack/react-table';
import type { TradeRow } from '@shared/api-types';
import type { TradeDirection, TradeShape, ValuedItem, Verdict } from '@shared/types';
import { useTrades } from '../lib/api';
import { SHAPE_LABEL, fmtK, pct, signed, tone, until } from '../lib/format';
import { TradeDetail } from '../components/TradeDetail';
import { Flags, Loading, Thumb, VerdictChip } from '../components/ui';

const col = createColumnHelper<TradeRow>();
const BOT_FLAGS = new Set(['bot_list', 'repeat_offer']);

function sideThumbs(items: ValuedItem[] | undefined, fallback: TradeRow['trade']['give'], robux: number) {
  const list: Array<Pick<ValuedItem, 'name' | 'thumbnailUrl' | 'flags' | 'serial' | 'tradeValue'>> =
    items ?? fallback.items.map((i) => ({ name: i.name, thumbnailUrl: null, flags: [], serial: i.serialNumber, tradeValue: i.rap }));
  return (
    <span className="flex items-start gap-1.5">
      {list.map((it, i) => (
        <span key={i} className="flex w-9 flex-col items-center gap-0.5">
          <Thumb item={it} size={30} />
          <span className="text-[9px] leading-none text-neutral-400 tabular-nums">{fmtK(it.tradeValue)}</span>
        </span>
      ))}
      {robux > 0 && <span className="self-center text-[10px] text-amber-300">+R${fmtK(robux)}</span>}
    </span>
  );
}

function partnerFlags(r: TradeRow): string[] { return r.score?.partner?.flags ?? []; }
function riskFlags(r: TradeRow): string[] {
  const p = new Set(partnerFlags(r));
  return (r.score?.flags ?? []).filter((f) => !p.has(f as never));
}

export function TradesPage({ direction }: { direction: TradeDirection }) {
  const [minScore, setMinScore] = useState<number | ''>('');
  const [hideBots, setHideBots] = useState(false);
  const [shape, setShape] = useState<TradeShape | ''>('');
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'score', desc: true }]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const q = useTrades({
    direction, limit: 200,
    ...(minScore !== '' && { minScore }), ...(hideBots && { hideBots }), ...(shape && { shape }),
    ...(verdict && { verdict }), ...(watchlistOnly && { watchlistOnly }),
  });

  // Filters are also applied client-side so the UI stays correct if the server ignores a param.
  const rows = useMemo(() => (q.data?.rows ?? []).filter((r) => {
    if (minScore !== '' && (r.score?.score ?? -1) < minScore) return false;
    if (hideBots && partnerFlags(r).some((f) => BOT_FLAGS.has(f))) return false;
    if (shape && r.score?.shape !== shape) return false;
    if (verdict && r.score?.verdict !== verdict) return false;
    return true;
  }), [q.data, minScore, hideBots, shape, verdict]);

  const columns = useMemo(() => [
    col.accessor((r) => r.score?.score ?? -1, {
      id: 'score', header: 'Score',
      cell: (c) => c.row.original.score ? (
        <span className="flex items-center gap-1">
          <VerdictChip verdict={c.row.original.score.verdict} score={c.row.original.score.score} />
          {c.row.original.score.preliminary && <span className="text-[9px] text-neutral-500" title="Quick first score; refines in a few seconds once market and partner data load">prelim</span>}
        </span>
      ) : <span className="text-neutral-600">unscored</span>,
    }),
    col.accessor((r) => r.trade.partner.name.toLowerCase(), {
      id: 'partner', header: 'Partner',
      cell: (c) => (
        <div className="leading-tight">
          <div className="text-neutral-200">{c.row.original.trade.partner.displayName}</div>
          <div className="text-[10px] text-neutral-500">@{c.row.original.trade.partner.name}</div>
          {partnerFlags(c.row.original).length > 0 && <Flags flags={partnerFlags(c.row.original)} max={2} />}
        </div>
      ),
    }),
    col.display({ id: 'give', header: 'Give', cell: (c) => sideThumbs(c.row.original.score?.give, c.row.original.trade.give, c.row.original.trade.give.robux) }),
    col.display({ id: 'get', header: 'Get', cell: (c) => sideThumbs(c.row.original.score?.get, c.row.original.trade.get, c.row.original.trade.get.robux) }),
    col.accessor((r) => r.score?.totals.rawGain ?? 0, {
      id: 'raw', header: 'Raw gain',
      cell: (c) => { const s = c.row.original.score; return s ? <span className={tone(s.totals.rawGain)}>{signed(s.totals.rawGain)} <span className="text-[10px] opacity-70">{pct(s.rawGainPct)}</span></span> : '—'; },
    }),
    col.accessor((r) => r.score?.edgePct ?? -9, {
      id: 'edge', header: 'Edge vs norm',
      cell: (c) => { const s = c.row.original.score; return s ? <span><span className={tone(s.edgePct)}>{pct(s.edgePct)}</span> <span className="text-[10px] text-neutral-500">{SHAPE_LABEL[s.shape]} · norm {pct(s.normPct, 0, false)}</span></span> : '—'; },
    }),
    col.accessor((r) => r.score?.totals.rapGain ?? 0, {
      id: 'rap', header: 'RAP gain',
      cell: (c) => { const t = c.row.original.score?.totals; return t ? <span className={tone(t.rapGain)}>{signed(t.rapGain)}</span> : '—'; },
    }),
    col.accessor((r) => r.score?.totals.liquidGain ?? 0, {
      id: 'liquid', header: 'Liquid gain',
      cell: (c) => { const t = c.row.original.score?.totals; return t ? <span className={tone(t.liquidGain)}>{signed(t.liquidGain)}</span> : '—'; },
    }),
    col.accessor((r) => riskFlags(r).length, { id: 'risk', header: 'Risk flags', cell: (c) => <Flags flags={riskFlags(c.row.original)} max={3} /> }),
    col.accessor((r) => r.trade.expiresAt ?? Number.MAX_SAFE_INTEGER, {
      id: 'expires', header: direction === 'inbound' ? 'Expires in' : 'Status',
      cell: (c) => direction === 'inbound'
        ? <span className="tabular-nums text-neutral-400">{until(c.row.original.trade.expiresAt)}</span>
        : <span className="text-neutral-400">{c.row.original.trade.status}</span>,
    }),
  ], [direction]);

  const table = useReactTable({
    data: rows, columns, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getRowId: (r) => String(r.trade.tradeId),
  });

  const sel = 'rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
        <label className="flex items-center gap-1">min score
          <input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value === '' ? '' : Number(e.target.value))} className={`${sel} w-14`} />
        </label>
        <label className="flex items-center gap-1">shape
          <select value={shape} onChange={(e) => setShape(e.target.value as TradeShape | '')} className={sel}>
            <option value="">any</option><option value="UPGRADE">Upgrade</option><option value="DOWNGRADE">Downgrade</option><option value="EVEN">Even</option>
          </select>
        </label>
        <label className="flex items-center gap-1">verdict
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict | '')} className={sel}>
            <option value="">any</option><option>Accept</option><option>Lean accept</option><option>Counter</option><option>Decline</option>
          </select>
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={hideBots} onChange={(e) => setHideBots(e.target.checked)} />hide bots / repeat offers</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={watchlistOnly} onChange={(e) => setWatchlistOnly(e.target.checked)} />watchlist items only</label>
        <span className="ml-auto">{rows.length} of {q.data?.total ?? 0} trades</span>
      </div>
      <Loading q={q} />
      {q.data && (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-xs">
            <thead className="bg-neutral-900 text-[11px] text-neutral-400">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  <th className="w-6" />
                  {hg.headers.map((h) => (
                    <th key={h.id} onClick={h.column.getToggleSortingHandler()} className={`whitespace-nowrap px-2 py-1.5 text-left font-medium ${h.column.getCanSort() ? 'cursor-pointer select-none hover:text-neutral-200' : ''}`}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((r) => {
                const id = r.original.trade.tradeId;
                const open = expanded === id;
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setExpanded(open ? null : id)} className={`cursor-pointer border-t border-neutral-800 hover:bg-neutral-800/40 ${open ? 'bg-neutral-800/50' : ''}`}>
                      <td className="px-1 text-center text-neutral-500">{open ? '▾' : '▸'}</td>
                      {r.getVisibleCells().map((c) => <td key={c.id} className="px-2 py-1 align-middle tabular-nums">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
                    </tr>
                    {open && <tr><td colSpan={columns.length + 1} className="border-t border-neutral-800 p-0"><div className="sticky left-0 max-w-[calc(100vw-2rem)]"><TradeDetail tradeId={id} /></div></td></tr>}
                  </Fragment>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={columns.length + 1} className="p-6 text-center text-neutral-500">No trades match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
