/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useEffect, useState } from 'react';
import { useHeader, useHealth, usePoll } from '../lib/api';
import { ago, fmtK } from '../lib/format';
import { Btn, Stat } from './ui';
import type { HeaderResponse } from '@shared/api-types';

/** Persistent banner under the header when Roblox says this account cannot trade (advice-only mode). */
export function TradeStatusBanner({ status }: { status: HeaderResponse['tradeStatus'] | undefined }) {
  if (!status) return null;
  const free = status.freeTradesRemaining;
  if (free != null && free > 0) {
    return (
      <div className="border-b border-sky-800/60 bg-sky-950/60 px-4 py-1.5 text-xs text-sky-200" role="status">
        Free-trade promo: {free}{status.freeTradesLimit ? ` of ${status.freeTradesLimit}` : ''} free trade{free === 1 ? '' : 's'} left{status.freeTradesWindow ? ` (${status.freeTradesWindow})` : ''}.
      </div>
    );
  }
  if (status.canTrade) return null;
  return (
    <div className="border-b border-amber-700/60 bg-amber-950/70 px-4 py-1.5 text-xs text-amber-200" role="alert" title={status.eligibility ? `tradeEligibility: ${status.eligibility}` : undefined}>
      <span className="font-semibold">You can't trade right now</span> — {status.reason ?? 'Roblox did not say why'}. Trades are still analysed (advice only).
    </div>
  );
}

function Dot({ ok, label, title, warn }: { ok: boolean | null; label: string; title?: string; warn?: boolean }) {
  const c = ok === null ? 'bg-neutral-500' : warn ? 'bg-amber-500' : ok ? 'bg-emerald-500' : 'bg-rose-500';
  return <span className="flex items-center gap-1 text-[11px] text-neutral-400" title={title}><span className={`h-2 w-2 rounded-full ${c}`} />{label}</span>;
}

/** "drops: rate-limited, resumes in 41s" while Roblox's catalog search window is exhausted (ticks every second). */
function DropsRateLimited({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <span className="flex items-center gap-1 whitespace-nowrap text-[11px] text-amber-300" role="status"
      title="Roblox answered 429 to a catalog search (12 per minute per IP, shared with anything else on this network). All drop searches wait for the window to reset; timed-release checks keep running.">
      <span className="h-2 w-2 rounded-full bg-amber-500" />drops: rate-limited, resumes in <span className="tabular-nums">{s}s</span>
    </span>
  );
}

export function Header() {
  const h = useHeader();
  const health = useHealth();
  const poll = usePoll();
  const d = h.data;
  const hd = health.data;
  const cookie = hd?.cookie ?? 'unchecked';
  // roblox:economy is a known-dead fallback (frozen since 2025-01; 400 for migrated items): never a reason to warn.
  const sourcesBad = hd?.sources.filter((s) => !s.ok && s.state !== 'restricted' && s.id !== 'roblox:economy') ?? [];
  const restricted = hd?.sources.filter((s) => s.state === 'restricted') ?? [];
  const drops = d?.health.drops;

  return (
    <>
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-neutral-800 bg-neutral-900 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-sky-400">Appraiser<sup className="ml-0.5 text-[9px] font-semibold text-emerald-400">Public</sup></span>
        <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-500" title="Decision support only. Never accepts, declines, counters or sends trades.">read-only</span>
      </div>
      <Stat label="Account" value={d?.account ? d.account.displayName : <span className="text-neutral-500">not signed in</span>} sub={d?.account ? `@${d.account.name}` : `cookie ${cookie}`} />
      <Stat label="Inventory value" value={fmtK(d?.inventoryValue)} sub={`liq ${fmtK(d?.inventoryLiquidationValue)}`} />
      <Stat label="Inventory RAP" value={fmtK(d?.inventoryRap)} />
      <Stat
        label="Free trades"
        // Roblox reports remaining = -1 when trades are not counted against the promo (e.g. with Roblox Plus).
        value={d?.freeTrades ? (d.freeTrades.remaining < 0 ? (d.canTrade ? 'unlimited' : '—') : `${d.freeTrades.remaining}/${d.freeTrades.limit}`) : '—'}
        sub={d?.freeTrades && d.freeTrades.remaining < 0 ? (d.canTrade ? 'Roblox Plus' : undefined) : d?.freeTrades?.window ?? (d?.canTrade === false ? <span className="text-amber-400">cannot trade</span> : undefined)}
      />
      <Stat
        label="Trade rules"
        value={d ? `${d.tradeMetadata.maxItemsPerSide}/side · ${(d.tradeMetadata.tradeSystemRobuxFee * 100).toFixed(0)}% fee` : '—'}
        sub={d && !d.tradeMetadata.verified ? <span className="text-amber-400">unverified defaults</span> : undefined}
      />
      <Stat label="Last poll" value={ago(d?.lastPollAt ?? hd?.lastPollAt)} sub={`${hd?.snapshotCount ?? d?.health.snapshotCount ?? 0} snapshots`} />
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Dot ok={hd ? hd.ok : null} label="server" title={h.error ? String(h.error) : undefined} />
        <Dot ok={d ? d.health.roblox : null} label="roblox" />
        <Dot ok={d ? d.health.rolimons : null} label="rolimons" />
        {drops === 'ratelimited' && d?.health.dropsResumeAt
          ? <DropsRateLimited until={d.health.dropsResumeAt} />
          : <Dot ok={!drops || drops === 'off' || drops === 'starting' ? null : drops !== 'error'} warn={drops === 'paused' || drops === 'ratelimited'} label={drops === 'paused' ? 'drops paused' : 'drops'}
            title={drops ? `Drops feed: ${drops}` : undefined} />}
        <Dot ok={cookie === 'valid' ? true : cookie === 'unchecked' ? null : false} label="cookie" />
        {restricted.length > 0 && (
          <span className="rounded bg-neutral-800 px-1.5 text-[10px] text-neutral-400" title={restricted.map((s) => `${s.id}: ${s.note ?? 'restricted'}`).join('\n')}>
            {d?.canTrade ? 'old trade API off (fine)' : 'trades restricted (no trading)'}
          </span>
        )}
        {sourcesBad.length > 0 && (
          <span className="text-[11px] text-amber-400" title={sourcesBad.map((s) => `${s.id}: ${s.lastError ?? 'down'}`).join('\n')}>
            {sourcesBad.length} source{sourcesBad.length > 1 ? 's' : ''} degraded
          </span>
        )}
        <Btn onClick={() => poll.mutate()} disabled={poll.isPending} title="Poll inbound trades now">{poll.isPending ? 'Polling…' : 'Poll now'}</Btn>
      </div>
    </header>
    <TradeStatusBanner status={d?.tradeStatus} />
    </>
  );
}
