/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useState } from 'react';
import type { ValuedItem } from '@shared/types';
import { DEMAND_LABEL } from '@shared/types';
import { useMarket, useQueryItem } from '../lib/api';
import { ago, fmtK, pct, tone } from '../lib/format';
import { EvidenceList, Flags, ItemCard, Loading, Panel, Sparkline, Thumb } from '../components/ui';

function ItemRow({ it, onOpen, extra }: { it: ValuedItem; onOpen: (id: number) => void; extra?: React.ReactNode }) {
  return (
    <tr className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-800/40" onClick={() => onOpen(it.assetId)}>
      <td className="px-2 py-1"><span className="flex items-center gap-2"><Thumb item={it} /><span className="truncate">{it.name}</span></span></td>
      <td className="px-2 tabular-nums">{fmtK(it.tradeValue)}</td>
      <td className="px-2 tabular-nums text-neutral-400">{fmtK(it.rap)}</td>
      <td className="px-2 tabular-nums text-neutral-400">{fmtK(it.liquidationValue)}</td>
      <td className="px-2 text-neutral-400">{it.demand !== null ? DEMAND_LABEL[it.demand] : '—'}</td>
      <td className={`px-2 tabular-nums ${tone(it.expectedDriftPct)}`}>{pct(it.expectedDriftPct)}</td>
      <td className="px-2"><Flags flags={it.flags} max={3} /></td>
      {extra}
    </tr>
  );
}

export function ItemDetail({ assetId, onClose }: { assetId: number; onClose: () => void }) {
  const q = useQueryItem(assetId);
  return (
    <Panel title="Item detail" right={<button onClick={onClose} className="text-xs text-neutral-400 hover:text-neutral-100">close ✕</button>}>
      <Loading q={q} />
      {q.data && (
        <div className="space-y-2">
          <ItemCard item={q.data.valued} />
          <div className="grid gap-2 text-[11px] text-neutral-400 sm:grid-cols-3">
            <div>RAP history<br /><Sparkline points={q.data.history.map((h) => ({ t: h.t, value: h.rap }))} width={200} height={40} /></div>
            <div>Daily price (180d)<br /><Sparkline points={q.data.dailyPrice} width={200} height={40} className="stroke-emerald-400" /></div>
            <div>Daily volume<br /><Sparkline points={q.data.dailyVolume} width={200} height={40} className="stroke-amber-400" /></div>
          </div>
          {q.data.snapshot && (
            <div className="text-[11px] text-neutral-400">
              floor {fmtK(q.data.snapshot.floorPrice)} · resellers {q.data.snapshot.resellerCount ?? '—'}{q.data.snapshot.resellerCountCapped && '+'} · copies {q.data.snapshot.publicCopies ?? q.data.snapshot.totalQuantity ?? '—'} · top owner {q.data.snapshot.topOwnerCopies ?? '—'} · sales 7d/30d {q.data.snapshot.sales7d ?? '—'}/{q.data.snapshot.sales30d ?? '—'} · ads req/off {q.data.snapshot.adRequestCount ?? '—'}/{q.data.snapshot.adOfferCount ?? '—'}
            </div>
          )}
          <table className="w-full text-[11px]">
            <thead className="text-neutral-500"><tr><th className="text-left font-normal">recent sale</th><th className="text-right font-normal">price</th><th className="text-right font-normal">RAP before→after</th><th className="text-right font-normal">source</th></tr></thead>
            <tbody>{q.data.recentSales.slice(0, 15).map((s, i) => (
              <tr key={i} className="border-t border-neutral-800/60"><td>{ago(s.t)}</td><td className="text-right tabular-nums">{fmtK(s.price)}</td><td className="text-right tabular-nums text-neutral-500">{fmtK(s.oldRap)}→{fmtK(s.newRap)}</td><td className="text-right text-neutral-500">{s.source}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const HEAD = ['Item', 'Value', 'RAP', 'Liq. value', 'Demand', '14d exp.', 'Flags'];

export function MarketPage() {
  const q = useMarket();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
      <div className="space-y-3">
        {open !== null && <ItemDetail assetId={open} onClose={() => setOpen(null)} />}
        <Panel title="Watchlist">
          <Loading q={q} />
          {q.data && (q.data.watchlist.length === 0
            ? <div className="text-xs text-neutral-500">Add items to the watchlist in Settings.</div>
            : <table className="w-full text-xs"><thead className="text-[11px] text-neutral-500"><tr>{HEAD.map((h) => <th key={h} className="px-2 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>{q.data.watchlist.map((it) => <ItemRow key={it.assetId} it={it} onOpen={setOpen} />)}</tbody></table>)}
        </Panel>
        <Panel title="Inventory movers (today)">
          {q.data && (q.data.inventoryMovers.length === 0
            ? <div className="text-xs text-neutral-500">No big moves in your inventory.</div>
            : <table className="w-full text-xs"><thead className="text-[11px] text-neutral-500"><tr>{[...HEAD, 'Change'].map((h) => <th key={h} className="px-2 text-left font-normal">{h}</th>)}</tr></thead>
                <tbody>{q.data.inventoryMovers.map((m) => <ItemRow key={m.item.assetId} it={m.item} onOpen={setOpen} extra={<td className={`px-2 tabular-nums ${tone(m.changePct)}`}>{pct(m.changePct)}</td>} />)}</tbody></table>)}
        </Panel>
      </div>
      <Panel title="Anomaly feed">
        {q.data && (q.data.anomalies.length === 0
          ? <div className="text-xs text-neutral-500">Nothing unusual detected.</div>
          : <ul className="space-y-2">{q.data.anomalies.map((a) => (
              <li key={a.id} className="cursor-pointer rounded border border-neutral-800 p-2 hover:bg-neutral-800/40" onClick={() => setOpen(a.assetId)}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded bg-neutral-800 px-1 text-[10px] uppercase text-neutral-400">{a.kind.replace(/_/g, ' ')}</span>
                  <span className="font-medium text-neutral-200">{a.name}</span>
                  {a.changePct !== undefined && <span className={tone(a.changePct)}>{pct(a.changePct)}</span>}
                  <span className="ml-auto text-[10px] text-neutral-500">{ago(a.at)}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-neutral-400">{a.message}</div>
                <EvidenceList evidence={a.evidence} />
              </li>
            ))}</ul>)}
      </Panel>
    </div>
  );
}
