/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useMemo, useState } from 'react';
import type { ValuedItem } from '@shared/types';
import { DEMAND_LABEL, TREND_LABEL } from '@shared/types';
import { useInventory, useRefreshInventory } from '../lib/api';
import { ago, fmtK, pct, tone } from '../lib/format';
import { Btn, Flags, HoldBadge, Loading, Panel, Stat, Thumb, useNow } from '../components/ui';
import { fmtHoldLeft } from '@shared/holds';
import { ItemDetail } from './MarketPage';

type Key = 'name' | 'serial' | 'tradeValue' | 'rap' | 'roliValue' | 'demand' | 'trend' | 'liquidity' | 'liquidationValue' | 'expectedDriftPct';
const COLS: Array<[Key, string]> = [
  ['name', 'Item'], ['serial', 'Serial'], ['tradeValue', 'Value'], ['rap', 'RAP'], ['roliValue', 'Rolimons'], ['demand', 'Demand'],
  ['trend', 'Trend'], ['liquidity', 'Liquidity'], ['liquidationValue', 'Liq. value'], ['expectedDriftPct', '14d exp.'],
];

function sortVal(it: ValuedItem, k: Key): number | string {
  if (k === 'name') return it.name.toLowerCase();
  const v = (it as unknown as Record<string, unknown>)[k];
  return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
}

export function InventoryPage() {
  const q = useInventory();
  const refresh = useRefreshInventory();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'tradeValue', desc: true });
  const [open, setOpen] = useState<number | null>(null);
  const d = q.data;

  const rows = useMemo(() => {
    const n = search.trim().toLowerCase();
    const xs = (d?.items ?? []).filter((it) => !n || it.name.toLowerCase().includes(n) || String(it.assetId) === n || (it.serial != null && `#${it.serial}`.includes(n)));
    return [...xs].sort((a, b) => {
      const x = sortVal(a, sort.k), y = sortVal(b, sort.k);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [d, search, sort]);

  const now = Date.now();
  const tick = useNow(30_000);
  const cooldown = d?.nextRefreshAllowedAt != null && d.nextRefreshAllowedAt > now;
  const refreshMsg = refresh.data && !refresh.data.queued && refresh.data.retryAt
    ? `Rate limited, try again in ${Math.max(1, Math.ceil((refresh.data.retryAt - now) / 1000))}s.`
    : refresh.error ? (refresh.error as Error).message : null;

  const right = (
    <span className="flex items-center gap-2 text-[11px] text-neutral-400">
      <span>{d?.refreshing ? 'refreshing…' : `last refreshed ${ago(d?.fetchedAt)}`}</span>
      <Btn onClick={() => refresh.mutate()} disabled={refresh.isPending || !!d?.refreshing || cooldown || d?.state === 'no_cookie'}
        title={cooldown ? 'Roblox inventory calls are rate limited; wait a minute between manual refreshes' : 'Re-fetch your collectibles from Roblox'}>
        Refresh
      </Btn>
    </span>
  );

  if (d?.state === 'no_cookie') {
    return (
      <Panel title="Inventory" right={right}>
        <div className="py-6 text-center text-sm text-neutral-400">
          No cookie yet. Add your <span className="font-mono">.ROBLOSECURITY</span> cookie in <a href="#settings" className="text-sky-400 underline">Settings</a> and your collectibles will load here automatically.
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {open !== null && <ItemDetail assetId={open} onClose={() => setOpen(null)} />}
      {d && d.state === 'ready' && (
        <div className="flex flex-wrap gap-6 rounded border border-neutral-800 bg-neutral-900 px-4 py-2">
          <Stat label="Value" value={fmtK(d.totalValue)} />
          <Stat label="RAP" value={fmtK(d.totalRap)} />
          <Stat label="Liquid value" value={fmtK(d.totalLiquidation)} />
          <Stat label="Items" value={d.count} />
          <Stat label="On hold" value={d.onHoldCount} />
          {d.holds?.nextReleaseAt != null && (
            <Stat label="Next tradable" value={d.holds.nextReleaseAt <= tick ? 'due any time' : `~${fmtHoldLeft(d.holds.nextReleaseAt - tick)}`}
              sub={<span title="Estimated: Roblox does not publish hold end times">{d.holds.lengths ? `trade ${d.holds.lengths.trade.source} · purchase ${d.holds.lengths.purchase.source}` : d.holds.length.source === 'measured' ? `measured from ${d.holds.length.samples}` : 'assumed hold length'}</span>} />
          )}
        </div>
      )}
      <Panel title="Inventory" right={right}>
        <Loading q={q} />
        {refreshMsg && <div className="mb-2 text-[11px] text-amber-400">{refreshMsg}</div>}
        {d?.lastError && <div className="mb-2 text-[11px] text-rose-400">Last refresh failed: {d.lastError}</div>}
        {d?.state === 'loading' && <div className="py-6 text-center text-sm text-neutral-400">Loading your collectibles from Roblox… this usually takes a few seconds after the cookie is saved.</div>}
        {d?.state === 'hidden' && <div className="py-6 text-center text-sm text-amber-300">Roblox reports your inventory as private. Make it visible (Privacy settings, "Who can see my inventory") so it can be valued.</div>}
        {d?.state === 'ready' && (
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, asset id or #serial"
              className="mb-2 w-full max-w-sm rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-500" />
            {d.items.length === 0 ? <div className="py-4 text-xs text-neutral-500">No collectibles in this inventory.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[11px] text-neutral-500"><tr>
                    {COLS.map(([k, label]) => (
                      <th key={k} className="cursor-pointer select-none px-2 text-left font-normal hover:text-neutral-300"
                        onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== 'name' }))}>
                        {label}{sort.k === k ? (sort.desc ? ' ↓' : ' ↑') : ''}
                      </th>
                    ))}
                    <th className="px-2 text-left font-normal">Flags</th>
                  </tr></thead>
                  <tbody>{rows.map((it, i) => (
                    <tr key={`${it.assetId}:${it.serial ?? ''}:${i}`} className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-800/40" onClick={() => setOpen(it.assetId)}>
                      <td className="px-2 py-1"><span className="flex items-center gap-2"><Thumb item={it} /><span className="truncate">{it.name}</span></span></td>
                      <td className="px-2 tabular-nums text-neutral-400">{it.serial != null ? `#${it.serial}` : '—'}</td>
                      <td className="px-2 tabular-nums">{fmtK(it.tradeValue)}</td>
                      <td className="px-2 tabular-nums text-neutral-400">{fmtK(it.rap)}</td>
                      <td className="px-2 tabular-nums text-neutral-400">{fmtK(it.roliValue)}</td>
                      <td className="px-2 text-neutral-400">{it.demand !== null ? DEMAND_LABEL[it.demand] : '—'}</td>
                      <td className="px-2 text-neutral-400">{it.trend !== null ? TREND_LABEL[it.trend] : '—'}</td>
                      <td className="px-2 tabular-nums text-neutral-400">{pct(it.liquidity, 0, false)}</td>
                      <td className="px-2 tabular-nums text-neutral-400">{fmtK(it.liquidationValue)}</td>
                      <td className={`px-2 tabular-nums ${tone(it.expectedDriftPct)}`}>{pct(it.expectedDriftPct)}</td>
                      <td className="px-2"><span className="flex items-center gap-1">{it.isOnHold && <HoldBadge hold={it.hold ?? null} />}<Flags flags={it.isOnHold ? it.flags.filter((f) => f !== 'on_hold') : it.flags} max={3} /></span></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
