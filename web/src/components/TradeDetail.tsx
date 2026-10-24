/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { ROBLOX_TRADES_URL } from '@shared/api-types';
import type { TradeScore } from '@shared/types';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRescore, useTrade } from '../lib/api';
import { SHAPE_LABEL, date, fmtK, fmtR, pct, signed, tone } from '../lib/format';
import { Btn, EvidenceList, Flags, ItemCard, Loading, Sparkline, VerdictChip } from './ui';

function Breakdown({ s }: { s: TradeScore }) {
  const maxAbs = Math.max(0.01, ...s.terms.map((t) => Math.abs(t.value)));
  return (
    <div>
      <table className="w-full text-[11px]">
        <thead className="text-neutral-500">
          <tr><th className="text-left font-normal">term</th><th className="text-right font-normal">raw</th><th className="text-right font-normal">w</th><th className="text-right font-normal">value</th><th className="w-28" /></tr>
        </thead>
        <tbody>
          {s.terms.map((t) => (
            <tr key={t.key} title={t.explanation} className="border-t border-neutral-800/60">
              <td className="py-0.5 text-neutral-300">{t.label}</td>
              <td className="text-right tabular-nums text-neutral-400">{t.raw.toFixed(2)}</td>
              <td className="text-right tabular-nums text-neutral-500">{t.weight.toFixed(2)}</td>
              <td className={`text-right tabular-nums ${tone(t.value)}`}>{t.value >= 0 ? '+' : ''}{t.value.toFixed(2)}</td>
              <td className="pl-2">
                <div className="relative h-2 bg-neutral-800">
                  <div className="absolute top-0 h-2 w-px bg-neutral-500" style={{ left: '50%' }} />
                  <div
                    className={`absolute top-0 h-2 ${t.value >= 0 ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
                    style={t.value >= 0 ? { left: '50%', width: `${(t.value / maxAbs) * 50}%` } : { right: '50%', width: `${(-t.value / maxAbs) * 50}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
          <tr className="border-t border-neutral-700 text-neutral-300">
            <td>logit → score</td><td /><td /><td className="text-right tabular-nums">{s.logit.toFixed(2)}</td>
            <td className="pl-2 tabular-nums">{s.score.toFixed(1)}</td>
          </tr>
        </tbody>
      </table>
      {s.caps && s.caps.length > 0 && (
        <div className="mt-2 text-[11px]">
          <div className="font-medium text-amber-300">Limited by</div>
          <ul className="mt-0.5 space-y-0.5">
            {s.caps.map((c) => (
              <li key={c.code} className={c.binding ? 'text-rose-300' : 'text-neutral-400'}>
                {c.reason} → max {c.limitedTo}{c.binding ? ' (binding)' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Totals({ s }: { s: TradeScore }) {
  const t = s.totals;
  const row = (label: string, give: number, get: number, gain: number, gp: number) => (
    <tr className="border-t border-neutral-800/60">
      <td className="py-0.5 text-neutral-400">{label}</td>
      <td className="text-right tabular-nums">{fmtR(give)}</td>
      <td className="text-right tabular-nums">{fmtR(get)}</td>
      <td className={`text-right tabular-nums ${tone(gain)}`}>{signed(gain, fmtR)}</td>
      <td className={`text-right tabular-nums ${tone(gp)}`}>{pct(gp)}</td>
    </tr>
  );
  return (
    <table className="w-full text-[11px]">
      <thead className="text-neutral-500"><tr><th className="text-left font-normal" /><th className="text-right font-normal">give</th><th className="text-right font-normal">get</th><th className="text-right font-normal">gain</th><th className="text-right font-normal">%</th></tr></thead>
      <tbody>
        {row('Value', t.valueGive, t.valueGet, t.rawGain, t.rawGainPct)}
        {row('RAP', t.rapGive, t.rapGet, t.rapGain, t.rapGainPct)}
        {row('Liquid', t.liquidGive, t.liquidGet, t.liquidGain, t.liquidGainPct)}
        {row('Liquidation', t.liquidationGive, t.liquidationGet, t.liquidationGain, t.liquidationGainPct)}
      </tbody>
      <tfoot className="text-[10px] text-neutral-500">
        <tr><td colSpan={5} className="pt-1">
          Robux counted (after fee): give {fmtR(t.robuxGiveCounted)} · get {fmtR(t.robuxGetCounted)} · momentum {pct(t.momentumPct)}
          {t.fillerPenalty !== 0 && ` · filler ${fmtR(t.fillerPenalty)}`}{t.duplicatePenalty !== 0 && ` · duplicate ${fmtR(t.duplicatePenalty)}`}
        </td></tr>
      </tfoot>
    </table>
  );
}

export function TradeDetail({ tradeId }: { tradeId: number }) {
  const q = useTrade(tradeId);
  // The detail fetch can carry a newer score than the list row (e.g. preliminary -> refined): refresh the list.
  const qc = useQueryClient();
  const detailScoredAt = q.data?.row.score?.scoredAt;
  useEffect(() => { if (detailScoredAt) void qc.invalidateQueries({ queryKey: ['trades'] }); }, [detailScoredAt, qc]);
  const rescore = useRescore();
  if (!q.data) return <Loading q={q} />;
  const { row, items, scoreHistory, partnerInventory: pinv } = q.data;
  const s = row.score;
  const tr = row.trade;
  const byAsset = new Map(items.map((i) => [i.valued.assetId, i]));
  const giveIds = new Set(tr.give.items.map((i) => i.assetId));
  const giveItems = items.filter((i) => giveIds.has(i.valued.assetId));
  const getItems = items.filter((i) => !giveIds.has(i.valued.assetId));
  const prices = (assetId: number) => byAsset.get(assetId)?.snapshot?.dailyPrice;
  const side = (title: string, list: typeof items, robux: number) => (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase text-neutral-500">{title}{robux > 0 && <span className="ml-2 normal-case text-amber-300">+ R$ {fmtR(robux)}</span>}</div>
      {list.length === 0 && <div className="text-[11px] text-neutral-600">no items</div>}
      {list.map((i, k) => <ItemCard key={`${i.valued.assetId}-${k}`} item={i.valued} prices={prices(i.valued.assetId)} hold={i.hold ?? null} />)}
    </div>
  );

  return (
    <div className="grid gap-3 bg-neutral-950/70 p-3 lg:grid-cols-[1fr_1fr_minmax(320px,0.9fr)]">
      {side('You give', giveItems, tr.give.robux)}
      {side('You get', getItems, tr.get.robux)}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {s && <VerdictChip verdict={s.verdict} score={s.score} />}
          {s && <span className="text-[11px] text-neutral-400">{SHAPE_LABEL[s.shape]} · norm {pct(s.normPct, 1, false)} · edge <span className={tone(s.edgePct)}>{pct(s.edgePct)}</span>{s.edgePctRap != null && <> · RAP edge <span className={tone(s.edgePctRap)}>{pct(s.edgePctRap)}</span></>} · conf {(s.confidence * 100).toFixed(0)}%</span>}
          <span className="ml-auto flex gap-1">
            <Btn onClick={() => rescore.mutate(tradeId)} disabled={rescore.isPending} title="Recompute locally (does not touch the trade)">Rescore</Btn>
            <a href={row.robloxUrl || ROBLOX_TRADES_URL} target="_blank" rel="noreferrer noopener" className="rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600" title={`Find trade #${tr.tradeId} on roblox.com and act on it yourself`}>
              Open on roblox.com ↗
            </a>
          </span>
        </div>
        <div className="text-[10px] text-neutral-500">
          Trade #{tr.tradeId} (no per-trade link exists — find it in the list) · {tr.status}{tr.status === 'Unknown' && ` (${tr.statusRaw})`} · created {date(tr.createdAt)}
          {(!tr.hadV1 || !tr.hadV2) && <span className="text-amber-400"> · partial data ({tr.hadV1 ? 'v1' : ''}{tr.hadV2 ? 'v2' : ''} only)</span>}
        </div>
        {s ? (
          <>
            <p className="text-xs leading-relaxed text-neutral-300">{s.explanation}</p>
            {!!s.evidence?.length && <EvidenceList evidence={s.evidence} />}
            {s.counterSuggestion && (
              <div className="rounded border border-amber-600/30 bg-amber-500/5 p-2 text-[11px]">
                <div className="mb-1 font-semibold text-amber-300">Counter idea (do it yourself on roblox.com) — needs {fmtK(s.counterSuggestion.valueNeeded)}</div>
                <p className="text-neutral-300">{s.counterSuggestion.text}</p>
                <ul className="mt-1 space-y-0.5 text-neutral-400">
                  {s.counterSuggestion.options.map((o, i) => (
                    <li key={i}>
                      {o.kind === 'add_robux'
                        ? <>Ask for R$ {fmtR(o.robux)}{!o.withinMaxRobuxRule && <span className="text-rose-400"> (exceeds max-Robux rule)</span>}</>
                        : o.kind === 'add_partner_item'
                          ? <>Ask them to add {o.name} ({fmtK(o.tradeValue)})</>
                          : o.kind === 'package'
                            ? <>
                              {o.swapOut.length ? <>Swap their {o.swapOut.map((x) => x.name).join(', ')} for </> : <>Ask them to add </>}
                              {o.add.map((x) => `${x.name} (${fmtK(x.tradeValue)}${x.demand != null && x.demand >= 3 ? ', high demand' : ''})`).join(' + ')}
                              {o.robux > 0 && <> + R$ {fmtR(o.robux)}</>}
                              <span className="text-neutral-500"> · adds {fmtK(o.addedValue)}</span>
                            </>
                            : <>Remove your {o.name} ({fmtK(o.tradeValue)})</>}
                      <span className={`ml-1 ${tone(o.resultingEdgePct)}`}>→ edge {pct(o.resultingEdgePct)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-[10px] text-neutral-500">
                  {pinv?.state === 'loaded'
                    ? <>Searched {pinv.itemCount} partner item(s) ({pinv.sources.join(' + ')}), fetched {pinv.fetchedAt ? date(pinv.fetchedAt) : '?'}; projected and on-hold items are never suggested.</>
                    : pinv?.state === 'hidden' ? <>Partner inventory is private: only Robux / removal counters are possible.</>
                      : pinv?.state === 'error' ? <>Partner inventory could not be loaded; showing Robux / removal counters only.</>
                        : <>Partner inventory not loaded yet (loads on the next poll for trades that need a counter).</>}
                </div>
              </div>
            )}
            <Totals s={s} />
            <Breakdown s={s} />
            {s.partner && (
              <div className="text-[11px]">
                <div className="mb-0.5 font-semibold text-neutral-400">
                  Partner {s.partner.displayName} <span className="font-normal text-neutral-500">@{s.partner.name} · {s.partner.accountAgeDays ?? '?'}d old · inv {fmtK(s.partner.inventoryValue)} · prior {s.partner.priorTrades.completed}✓ {s.partner.priorTrades.declined}✗</span>
                </div>
                <Flags flags={s.partner.flags} />
                <div className="mt-1"><EvidenceList evidence={s.partner.evidence} /></div>
              </div>
            )}
            {scoreHistory.length > 1 && (
              <div className="flex items-center gap-2 text-[10px] text-neutral-500">score history <Sparkline points={scoreHistory.map((h) => ({ t: h.scoredAt, value: h.score }))} width={120} height={20} className="stroke-amber-400" /></div>
            )}
            <div className="text-[10px] text-neutral-600">model {s.modelVersion} · scored {date(s.scoredAt)}</div>
          </>
        ) : <div className="text-xs text-neutral-500">Not scored yet.</div>}
      </div>
    </div>
  );
}
