/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Drops: live feed of new limited releases. READ-ONLY — there is no buy button and no purchase call.
// Each row links to its roblox.com catalog page; the user decides and buys there themselves.
import { useEffect, useMemo, useState } from 'react';
import type { DropRow } from '@shared/api-types';
import { useDrops, useSaveSettings, useSettings } from '../lib/api';
import { countdown, dur, fmtK, pct, robux, sinceFine, until } from '../lib/format';
import { Btn, Loading, Panel, Stat } from '../components/ui';

const NEW_MS = 5 * 60_000;

interface Filters { tradableOnly: boolean; hideSoldOut: boolean; hideInGame: boolean; maxPrice: string; minRemaining: string; q: string }
const DEFAULT_FILTERS: Filters = { tradableOnly: false, hideSoldOut: false, hideInGame: true, maxPrice: '', minRemaining: '', q: '' };
const LS_KEY = 'rta.drops.filters';

function loadFilters(): Filters {
  try { return { ...DEFAULT_FILTERS, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<Filters>) }; } catch { return DEFAULT_FILTERS; }
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Mirrors core isUpcoming: announced release not on sale yet (badge kept up to 10 min past the time). */
const RELEASE_GRACE_MS = 10 * 60_000;
const upcoming = (r: DropRow, now: number) => r.drop.releaseAt != null && r.drop.releasedAt == null && r.drop.saleStatus !== 'onSale' && now < r.drop.releaseAt + RELEASE_GRACE_MS;
const notReleased = (r: DropRow) => r.drop.saleStatus === 'pending' || (r.drop.saleStatus === 'offSale' && !r.drop.sales);
const soldOut = (r: DropRow, now = Date.now()) => r.drop.remaining != null && r.drop.remaining <= 0 && !upcoming(r, now) && !notReleased(r);
const created = (r: DropRow) => r.drop.createdAt ?? r.drop.firstSeenAt;
/** When it became buyable: the release time for timed drops, else creation. */
const released = (r: DropRow) => Math.max(created(r), r.drop.releasedAt ?? r.drop.releaseAt ?? 0);
const lagOf = (r: DropRow) => (r.drop.seenLive && r.drop.createdAt != null ? Math.max(0, r.drop.firstSeenAt - r.drop.createdAt) : null);

function UpcomingBadge({ r, now }: { r: DropRow; now: number }) {
  const t = r.drop.releaseAt!;
  const left = t - now;
  const soon = left < 60_000;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-[9px] font-bold ${soon ? 'animate-pulse bg-amber-400 text-black' : 'bg-violet-500/25 text-violet-200'}`}
      title={`Scheduled release ${new Date(t).toLocaleString()}. Checked directly every few seconds around the release; you get a desktop alert the moment it is on sale.`}>
      UPCOMING · {left > 0 ? <>releases in <span className="tabular-nums">{countdown(t, now)}</span></> : 'due now, checking…'}
    </span>
  );
}

function initials(name: string): string {
  const w = name.split(/[\s\-_:'()[\]]+/).filter((x) => x && !/^(the|of|a|an|and|demo)$/i.test(x));
  return (w.length > 1 ? w.map((x) => x[0]).join('') : (w[0] ?? name).slice(0, 3)).slice(0, 3).toUpperCase();
}

function DropThumb({ r }: { r: DropRow }) {
  const ring = r.drop.tradable ? 'ring-emerald-600/60' : 'ring-neutral-700';
  return r.drop.thumbnailUrl
    ? <img src={r.drop.thumbnailUrl} alt="" width={32} height={32} loading="lazy" className={`shrink-0 rounded bg-neutral-800 ring-1 ${ring}`} />
    : <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded bg-neutral-800 text-[9px] text-neutral-400 ring-1 ${ring}`}>{initials(r.drop.name)}</span>;
}

function StockCell({ r, now }: { r: DropRow; now: number }) {
  const { remaining, totalQuantity } = r.drop;
  if (upcoming(r, now)) return <span className="whitespace-nowrap text-neutral-400" title="Not on sale yet">{totalQuantity != null ? `${totalQuantity.toLocaleString('en-US')} at release` : 'not on sale yet'}</span>;
  if (notReleased(r) && !remaining) return <span className="whitespace-nowrap text-neutral-500" title="Roblox lists it as not on sale yet; you get an alert if it goes on sale">not on sale</span>;
  if (soldOut(r, now)) return <span className="rounded bg-rose-500/20 px-1 text-[10px] font-semibold text-rose-300">SOLD OUT</span>;
  if (remaining == null && totalQuantity == null) return <span className="text-neutral-500">—</span>;
  const frac = remaining != null && totalQuantity ? Math.max(0, Math.min(1, remaining / totalQuantity)) : null;
  const bar = frac == null ? 'bg-neutral-600' : frac < 0.1 ? 'bg-rose-500' : frac < 0.4 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span className="flex flex-col gap-0.5" title={frac != null ? `${Math.round(frac * 100)}% left` : undefined}>
      <span className="whitespace-nowrap tabular-nums">{remaining != null ? remaining.toLocaleString('en-US') : '?'}<span className="text-neutral-500"> / {totalQuantity != null ? totalQuantity.toLocaleString('en-US') : '?'}</span></span>
      {frac != null && <span className="h-0.5 w-16 rounded bg-neutral-800"><span className={`block h-0.5 rounded ${bar}`} style={{ width: `${Math.max(2, frac * 100)}%` }} /></span>}
    </span>
  );
}

function FlipCell({ r }: { r: DropRow }) {
  const f = r.flip;
  if (f.profit == null) return <span className="text-neutral-500" title={f.note}>—</span>;
  const tone = f.profit > 0 ? 'text-emerald-400' : f.profit < 0 ? 'text-rose-400' : 'text-neutral-400';
  const dot = { none: 'bg-neutral-600', low: 'bg-amber-500', medium: 'bg-sky-500', high: 'bg-emerald-500' }[f.confidence];
  const basis = f.basis === 'resale' ? 'lowest resale' : f.basis === 'value' ? 'Rolimons value' : 'RAP';
  return (
    <span className="flex items-center gap-1.5" title={`${basis} ${robux(f.refPrice)} → ${robux(f.net)} after fee, minus price ${robux(r.drop.price)}.\n${f.confidence} confidence: ${f.note}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className={`tabular-nums ${tone}`}>{f.profit > 0 ? '+' : f.profit < 0 ? '−' : ''}{fmtK(Math.abs(f.profit))}</span>
      {f.profitPct != null && <span className={`text-[10px] tabular-nums ${tone}`}>{pct(f.profitPct, 0)}</span>}
    </span>
  );
}

export function DropsPage() {
  const q = useDrops();
  const settings = useSettings();
  const save = useSaveSettings();
  const now = useNow(1_000);
  const [f, setF] = useState<Filters>(loadFilters);
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(f)); } catch { /* per-viewer convenience only */ } }, [f]);
  const d = q.data;
  const enabled = settings.data?.settings.drops.enabled ?? true;
  const skew = d ? Date.now() - d.now : 0; // keep "ago" honest if the server clock differs

  const rows = useMemo(() => {
    const maxP = f.maxPrice.trim() ? Number(f.maxPrice) : null;
    const minR = f.minRemaining.trim() ? Number(f.minRemaining) : null;
    const n = f.q.trim().toLowerCase();
    return (d?.rows ?? []).filter((r) => {
      if (f.tradableOnly && !r.drop.tradable) return false;
      if (f.hideSoldOut && soldOut(r, now)) return false;
      if (f.hideInGame && r.drop.inGameOnly) return false;
      if (maxP != null && Number.isFinite(maxP) && (r.drop.price ?? Infinity) > maxP) return false;
      if (minR != null && Number.isFinite(minR) && (r.drop.remaining ?? 0) < minR) return false;
      if (n && !r.drop.name.toLowerCase().includes(n) && !r.drop.creatorName.toLowerCase().includes(n) && String(r.drop.assetId) !== n) return false;
      return true;
    }).sort((a, b) => {
      const ua = upcoming(a, now), ub = upcoming(b, now);
      if (ua !== ub) return ua ? -1 : 1;
      return ua ? a.drop.releaseAt! - b.drop.releaseAt! : released(b) - released(a);
    });
  // Re-sorted on each refetch (2 s) and every 10 s, not on every 1 s countdown tick.
  }, [d, f, Math.floor(now / 10_000)]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = d?.rows ?? [];
  const fresh = all.filter((r) => !upcoming(r, now - skew) && now - skew - released(r) < NEW_MS).length;
  const live = all.filter((r) => !soldOut(r, now - skew) && !upcoming(r, now - skew)).length;
  const nUpcoming = all.filter((r) => upcoming(r, now - skew)).length;
  const nextRelease = all.filter((r) => upcoming(r, now - skew)).map((r) => r.drop.releaseAt!).sort((a, b) => a - b)[0];
  const st = d?.status;
  const stateDot = !st ? 'bg-neutral-500' : st.state === 'ok' ? 'bg-emerald-500 animate-pulse' : st.state === 'error' ? 'bg-rose-500' : st.state === 'paused' || st.state === 'ratelimited' ? 'bg-amber-500' : 'bg-neutral-500';
  const stateText = !st ? 'loading' : st.state === 'ok' ? `live · checked ${sinceFine(st.lastPollAt, now - skew)} ago` : st.state === 'paused' ? 'paused'
    : st.state === 'ratelimited' ? `rate-limited · resumes in ${Math.max(0, Math.ceil(((st.rateLimitedUntil ?? 0) - (now - skew)) / 1000))}s`
      : st.state === 'error' ? 'error' : st.state === 'off' ? 'off (no Roblox client)' : 'starting…';
  const budgetTitle = st ? [
    `Catalog searches by this app in the last minute: ${st.searchesLastMin} of 12 (Roblox's per-IP limit).`,
    st.searchRemaining != null ? `Roblox reports ${st.searchRemaining} left in the current window.` : null,
    `The two feeds use at most 6 a minute; the creator watchlist (${st.creators.count}) gets the spare searches, one creator per turn.`,
    st.creators.lastName ? `Last watchlist check: ${st.creators.lastName} ${sinceFine(st.creators.lastPollAt, now - skew)} ago; next: ${st.creators.next ?? '—'}.` : null,
    st.creators.skipped ? `Watchlist turns skipped for budget: ${st.creators.skipped}.` : null,
  ].filter(Boolean).join('\n') : undefined;
  const inp = 'rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none';

  const right = (
    <span className="flex items-center gap-3 text-[11px] text-neutral-400">
      <span className="flex items-center gap-1.5" title={st?.lastError ?? undefined}><span className={`h-2 w-2 rounded-full ${stateDot}`} />{stateText}</span>
      <Btn onClick={() => save.mutate({ drops: { enabled: !enabled } })} disabled={save.isPending || !settings.data}
        title={enabled ? 'Stop checking Roblox for new drops' : 'Resume checking Roblox for new drops'}>{enabled ? 'Pause' : 'Resume'}</Btn>
    </span>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-6 rounded border border-neutral-800 bg-neutral-900 px-4 py-2">
        <Stat label="Drops (24h)" value={all.length} />
        <Stat label="New < 5 min" value={<span className={fresh ? 'text-emerald-400' : undefined}>{fresh}</span>} />
        <Stat label="In stock" value={live} />
        <Stat label="Tradable" value={all.filter((r) => r.drop.tradable).length} sub="Roblox-made limiteds" />
        <Stat label="Upcoming" value={<span className={nUpcoming ? 'text-violet-300' : undefined}>{nUpcoming}</span>}
          sub={nextRelease ? <span className="tabular-nums">next in {countdown(nextRelease, now - skew)}</span> : 'timed releases'} />
        <span title={d?.lagSamples ? `Median of ${d.lagSamples} drops first seen by a live check: time from Roblox's itemCreatedUtc to when this app saw it. Most of it is the catalog search index lag, not the poll interval.` : 'Shows once drops are seen by a live check (not the startup backlog).'}>
          <Stat label="Detection lag" value={d?.lagMedianMs != null ? dur(d.lagMedianMs) : '—'} sub={d?.lagSamples ? `median of ${d.lagSamples}` : 'no live samples yet'} />
        </span>
        <span title={budgetTitle}>
          <Stat label="Check every" value={d ? `${Math.round(d.pollMs / 1000)}s` : '—'}
            sub={st ? <span className="tabular-nums">{st.searchesLastMin}/12 searches · {st.creators.count} watched</span> : 'catalog search, 12/min limit'} />
        </span>
        <div className="ml-auto max-w-md text-[10px] leading-snug text-neutral-500">
          Read-only. Open a drop on roblox.com and buy it yourself; this app never buys. Flip = (lowest resale, else value/RAP) after the {d ? Math.round(d.feePct * 100) : 30}% fee, minus the price.
        </div>
      </div>
      <Panel title="Drops — new limiteds" right={right}>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-neutral-300">
          <label className="flex items-center gap-1"><input type="checkbox" checked={f.tradableOnly} onChange={(e) => setF({ ...f, tradableOnly: e.target.checked })} /> Tradable only</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={f.hideSoldOut} onChange={(e) => setF({ ...f, hideSoldOut: e.target.checked })} /> Hide sold out</label>
          <label className="flex items-center gap-1" title="Sold only inside a game; the catalog link can't buy these"><input type="checkbox" checked={f.hideInGame} onChange={(e) => setF({ ...f, hideInGame: e.target.checked })} /> Hide in-game only</label>
          <label className="flex items-center gap-1 text-neutral-400">Max price <input inputMode="numeric" value={f.maxPrice} onChange={(e) => setF({ ...f, maxPrice: e.target.value.replace(/[^\d]/g, '') })} placeholder="any" className={`${inp} w-20 text-right`} /></label>
          <label className="flex items-center gap-1 text-neutral-400">Min left <input inputMode="numeric" value={f.minRemaining} onChange={(e) => setF({ ...f, minRemaining: e.target.value.replace(/[^\d]/g, '') })} placeholder="any" className={`${inp} w-20 text-right`} /></label>
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search name, creator or asset id" className={`${inp} w-56`} />
          {(f.tradableOnly || f.hideSoldOut || !f.hideInGame || f.maxPrice || f.minRemaining || f.q) && <button className="text-[11px] text-neutral-500 underline hover:text-neutral-300" onClick={() => setF(DEFAULT_FILTERS)}>clear</button>}
          <span className="ml-auto text-[11px] text-neutral-500">{rows.length} of {all.length}</span>
        </div>
        <Loading q={q} />
        {st?.state === 'error' && st.lastError && <div className="mb-2 text-[11px] text-rose-400">Last check failed: {st.lastError}</div>}
        {d && all.length === 0 && (
          <div className="py-6 text-center text-sm text-neutral-400">
            {st?.state === 'paused' ? 'Paused. Press Resume to start watching for new limiteds.' : 'No limiteds released in the last 24 hours yet. New ones appear here within seconds of showing up in the Roblox catalog search, which itself usually trails the real release by 1 to 2 hours. Timed releases announced in advance are alerted the moment they go on sale.'}
          </div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[11px] text-neutral-500"><tr>
                <th className="whitespace-nowrap px-2 text-left font-normal">Item</th>
                <th className="whitespace-nowrap px-2 text-left font-normal">Type</th>
                <th className="whitespace-nowrap px-2 text-left font-normal">Creator</th>
                <th className="whitespace-nowrap px-2 text-right font-normal">Price</th>
                <th className="whitespace-nowrap px-2 text-left font-normal">Left / total</th>
                <th className="hidden whitespace-nowrap px-2 text-left font-normal xl:table-cell">Limit</th>
                <th className="whitespace-nowrap px-2 text-left font-normal">Released</th>
                <th className="hidden whitespace-nowrap px-2 text-left font-normal xl:table-cell">Off sale in</th>
                <th className="whitespace-nowrap px-2 text-right font-normal">Lowest resale</th>
                <th className="whitespace-nowrap px-2 text-left font-normal">Flip est.</th>
                <th className="px-2" />
              </tr></thead>
              <tbody>{rows.map((r) => {
                const age = now - skew - released(r);
                const isUp = upcoming(r, now - skew);
                const isNew = !isUp && age < NEW_MS;
                const out = soldOut(r, now - skew);
                const lag = lagOf(r);
                return (
                  <tr key={r.drop.key} className={`border-t border-neutral-800 ${isUp ? 'bg-violet-500/10' : isNew ? 'bg-emerald-500/10' : ''} ${out ? 'opacity-60' : ''} hover:bg-neutral-800/40`}>
                    <td className="max-w-[12rem] px-2 py-1 xl:max-w-[18rem]">
                      <span className="flex items-center gap-2">
                        <DropThumb r={r} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            {isNew && <span className="shrink-0 animate-pulse rounded bg-emerald-500 px-1 text-[9px] font-bold text-black">NEW</span>}
                            <a href={r.url} target="_blank" rel="noopener noreferrer" className="truncate text-neutral-100 hover:text-sky-300" title={r.drop.name}>{r.drop.name}</a>
                          </span>
                          {(isUp || r.drop.inGameOnly || (r.drop.watched && r.drop.creatorId !== 1)) && (
                            <span className="flex flex-wrap items-center gap-x-1.5">
                              {isUp && <UpcomingBadge r={r} now={now - skew} />}
                              {r.drop.watched && r.drop.creatorId !== 1 && <span className="whitespace-nowrap text-[10px] text-sky-300" title="Creator is on your watchlist (Settings → Drops)">★ watched</span>}
                              {r.drop.inGameOnly && <span className="text-[10px] text-amber-400" title="saleLocationType ExperiencesDevApiOnly: sold only inside a game (often a code drop), not on the website">in-game only</span>}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="px-2">
                      {r.drop.tradable
                        ? <span className="rounded bg-emerald-500/20 px-1 text-[10px] font-semibold text-emerald-300" title={`Roblox-made ${r.drop.restrictions.join('/')}: tradable`}>TRADABLE</span>
                        : <span className="whitespace-nowrap rounded bg-neutral-700/60 px-1 text-[10px] text-neutral-300" title="UGC limited: can be resold on the marketplace but NOT traded">UGC · resale only</span>}
                    </td>
                    <td className="max-w-[9rem] truncate px-2 text-neutral-300" title={r.drop.creatorName}>
                      {r.drop.creatorName || '—'}{r.drop.creatorVerified && <span className="ml-1 text-sky-400" title="Verified creator">✓</span>}
                    </td>
                    <td className="px-2 text-right tabular-nums">{robux(r.drop.price)}</td>
                    <td className="px-2"><StockCell r={r} now={now - skew} /></td>
                    <td className="hidden px-2 tabular-nums text-neutral-400 xl:table-cell">{r.drop.limitPerUser ? `${r.drop.limitPerUser}/user` : r.drop.limitPerUser === 0 ? 'none' : '—'}</td>
                    <td className="whitespace-nowrap px-2 tabular-nums text-neutral-400"
                      title={[
                        isUp ? `Releases ${new Date(r.drop.releaseAt!).toLocaleString()}` : r.drop.releasedAt ? `Went on sale ${new Date(r.drop.releasedAt).toLocaleString()} (scheduled release)` : null,
                        `Created ${new Date(created(r)).toLocaleString()} (itemCreatedUtc)`,
                        `First seen by this app ${new Date(r.drop.firstSeenAt).toLocaleString()}`,
                        lag != null ? `Detection lag ${dur(lag)}: mostly Roblox's catalog search index, not the poll interval` : 'Already in the catalog when this app started, so no lag was measured',
                      ].filter(Boolean).join('\n')}>
                      <span className="block">{isUp ? <>at {new Date(r.drop.releaseAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</> : <>{sinceFine(released(r), now - skew)} ago</>}</span>
                      {lag != null && <span className="block text-[10px] text-neutral-500">seen +{dur(lag)}</span>}
                    </td>
                    <td className="hidden whitespace-nowrap px-2 tabular-nums text-neutral-400 xl:table-cell" title={r.drop.offSaleDeadline ? new Date(r.drop.offSaleDeadline).toLocaleString() : 'No deadline'}>{r.drop.offSaleDeadline ? until(r.drop.offSaleDeadline, now - skew) : '—'}</td>
                    <td className="px-2 text-right tabular-nums text-neutral-300">{r.drop.lowestResalePrice ? robux(r.drop.lowestResalePrice) : '—'}</td>
                    <td className="px-2"><FlipCell r={r} /></td>
                    <td className="whitespace-nowrap px-2 text-right">
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="rounded bg-sky-700/40 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-600/60" title="Opens the catalog page on roblox.com. You decide and buy there yourself."><span className="hidden xl:inline">Open on Roblox </span><span className="xl:hidden">Open </span>↗</a>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {d && all.length > 0 && rows.length === 0 && <div className="py-4 text-center text-xs text-neutral-500">No drops match these filters.</div>}
      </Panel>
    </div>
  );
}
