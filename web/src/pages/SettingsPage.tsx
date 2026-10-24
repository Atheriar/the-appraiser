/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { AssetId, GoalMode, ScoreWeights, SerialPremiumRow, Settings, NormSuggestionRow } from '@shared/types';
import type { SettingsResponse } from '@shared/api-types';
import { useCookie, useCookieMutations, useHealth, useItemSearch, useSaveSettings, useSettings, useLearning, api } from '../lib/api';
import { ago, date, fmtK } from '../lib/format';
import { playChime, setSoundEnabled, soundEnabled } from '../lib/inboundAlerts';
import { Btn, Loading, Panel } from '../components/ui';

const inp = 'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none';

function Num({ label, value, onChange, step = 1, hint, suffix }: { label: string; value: number; onChange: (n: number) => void; step?: number; hint?: string; suffix?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-neutral-400" title={hint}>
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input type="number" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(Number(e.target.value))} className={`${inp} w-24 text-right tabular-nums`} />
        <span className="w-6 text-[10px] text-neutral-500">{suffix}</span>
      </span>
    </label>
  );
}

/** Edits a fraction (0.08) as a percent (8). */
function Pct(p: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return <Num label={p.label} hint={p.hint} value={+(p.value * 100).toFixed(4)} step={0.5} suffix="%" onChange={(n) => p.onChange(n / 100)} />;
}

/** Edits milliseconds as seconds. */
function Ms(p: { label: string; value: number; onChange: (n: number) => void }) {
  return <Num label={p.label} value={p.value / 1000} step={1} suffix="s" onChange={(n) => p.onChange(Math.max(1, n) * 1000)} />;
}

function Grid({ children }: { children: ReactNode }) { return <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">{children}</div>; }

function CookiePanel() {
  const q = useCookie();
  const { put, del } = useCookieMutations();
  const [val, setVal] = useState('');
  const c = q.data;
  const statusCls = c?.status === 'valid' ? 'text-emerald-400' : c?.status === 'invalid' ? 'text-rose-400' : 'text-neutral-400';
  return (
    <Panel title=".ROBLOSECURITY cookie">
      <div className="space-y-2 text-xs">
        <div className="text-neutral-400">
          Status: <span className={statusCls}>{c?.status ?? '…'}</span>
          {c?.account && <> · {c.account.displayName} (@{c.account.name})</>}
          {c?.masked && <> · stored <code className="text-neutral-500">{c.masked}</code></>}
          {c?.checkedAt && <> · checked {ago(c.checkedAt)}</>}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (val.trim()) put.mutate(val.trim(), { onSuccess: () => setVal('') }); }}>
          <input type="password" autoComplete="off" spellCheck={false} placeholder="Paste cookie to validate & store (encrypted locally)" value={val} onChange={(e) => setVal(e.target.value)} className={`${inp} flex-1 font-mono`} />
          <Btn type="submit" kind="primary" disabled={!val.trim() || put.isPending}>{put.isPending ? 'Validating…' : 'Validate & save'}</Btn>
          <Btn kind="danger" disabled={!c || c.status === 'missing' || del.isPending} onClick={() => { if (confirm('Remove the stored cookie?')) del.mutate(); }}>Remove</Btn>
        </form>
        {(put.error || del.error) && <div className="text-rose-400">{((put.error ?? del.error) as Error).message}</div>}
        <p className="text-[10px] text-neutral-500">Stored with Windows Credential Manager / DPAPI, only ever sent to *.roblox.com, never shown again. This app never accepts, declines, counters or sends trades.</p>
      </div>
    </Panel>
  );
}

type Creator = Settings['drops']['creators'][number];

/** Drops watchlist: users or groups searched one per turn with the spare catalog budget (includes upcoming items). */
function CreatorWatchlist({ creators, onChange }: { creators: Creator[]; onChange: (c: Creator[]) => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<'User' | 'Group'>('Group');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true); setErr(null);
    try {
      const { creator } = await api.lookupCreator(query, type);
      if (!creator) setErr(`No ${type === 'User' ? 'user' : 'group'} found for "${query}"`);
      else if (creators.some((c) => c.id === creator.id && c.type === creator.type)) setErr(`${creator.name} is already on the list`);
      else { onChange([...creators, creator]); setQ(''); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 border-t border-neutral-800 pt-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-neutral-300">Creator watchlist <span className="font-normal text-neutral-500">({creators.length}/25)</span></span>
        <span className="text-[10px] text-neutral-500">One creator per turn from the spare search budget; also finds items announced but not on sale yet.</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {creators.length === 0 && <span className="text-[11px] text-neutral-500">No creators. Add Roblox (user 1) for Roblox-made timed releases.</span>}
        {creators.map((c) => (
          <span key={`${c.type}:${c.id}`} className="flex max-w-full items-center gap-1 rounded bg-neutral-800 py-0.5 pl-1.5 pr-0.5 text-[11px] text-neutral-200">
            <span className="text-[9px] uppercase text-neutral-500">{c.type === 'User' ? 'user' : 'group'}</span>
            <span className="truncate" title={`${c.name} (${c.type} ${c.id})`}>{c.name}</span>
            <span className="text-[10px] tabular-nums text-neutral-500">{c.id}</span>
            <button type="button" aria-label={`Remove ${c.name}`} title="Remove" className="rounded px-1 text-neutral-500 hover:bg-neutral-700 hover:text-rose-300"
              onClick={() => onChange(creators.filter((x) => !(x.id === c.id && x.type === c.type)))}>×</button>
          </span>
        ))}
      </div>
      <form className="mt-2 flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <select value={type} onChange={(e) => setType(e.target.value as 'User' | 'Group')} className={inp} aria-label="Creator type">
          <option value="Group">Group</option>
          <option value="User">User</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={type === 'Group' ? 'Group name or id' : 'Username or id'} className={`${inp} w-48 min-w-0 flex-1 sm:flex-none`} maxLength={60} />
        <Btn type="submit" disabled={busy || !q.trim() || creators.length >= 25}>{busy ? 'Looking up…' : 'Add'}</Btn>
        {err && <span className="text-[11px] text-rose-400">{err}</span>}
      </form>
    </div>
  );
}

/** Market-drift knobs: everything that depends on price / volume levels, so nothing needs recoding when the market moves. */
function MarketDriftPanel({ s, set, market }: { s: Settings; set: (f: (d: Settings) => void) => void; market: SettingsResponse['market'] }) {
  const lq = s.valuation.liquidity;
  const dd = s.valuation.derivedDemandPerDay;
  const [ids, setIds] = useState(s.botList.extraUserIds.join(', '));
  return (
    <Panel title="Market drift (no recoding needed when prices or demand shift)">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-neutral-300">
            <input type="checkbox" checked={s.market.scaleWithMarket} onChange={(e) => set((d) => { d.market.scaleWithMarket = e.target.checked; })} /> Scale Robux thresholds with the market
          </label>
          <p className="text-[11px] leading-snug text-neutral-500">
            Tier cut-offs, the poison-check minimum and the price-tier liquidity anchor follow the median Rolimons value of all valued items
            {market?.index ? <> (now {market.index.median.toLocaleString('en-US')} R$ over {market.index.n.toLocaleString('en-US')} items{market.reference ? <>, reference {Math.round(market.reference).toLocaleString('en-US')}</> : null}; scale x{market.scale.toFixed(2)})</> : ' (index appears after the first Rolimons refresh)'}.
          </p>
          <Num label="Reference median (0 = automatic)" value={s.market.referenceMedianValue} step={100} suffix="R$" onChange={(n) => set((d) => { d.market.referenceMedianValue = Math.max(0, n); })} />
          <Num label="Max scale" value={s.market.maxScale} step={0.5} suffix="x" onChange={(n) => set((d) => { d.market.maxScale = n; })} />
          <Num label="Price-tier anchor" value={lq.priceTierAnchor} step={1000} suffix="R$" hint="Items above this get the big-item liquidity haircut" onChange={(n) => set((d) => { d.valuation.liquidity.priceTierAnchor = n; })} />
          <Pct label="Haircut per decade above anchor" value={lq.priceTierSlopePerDecade} onChange={(n) => set((d) => { d.valuation.liquidity.priceTierSlopePerDecade = n; })} />
          <Num label="Lowest price-tier factor" value={lq.priceTierFloor} step={0.05} onChange={(n) => set((d) => { d.valuation.liquidity.priceTierFloor = n; })} />
          <Num label="Low-liquidity cut" value={lq.lowLiquidityCut} step={0.05} onChange={(n) => set((d) => { d.valuation.liquidity.lowLiquidityCut = n; })} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-neutral-400">Rolimons demand index to liquidity (add new indexes here if Rolimons adds tiers)</div>
          <Grid>
            {Object.keys(lq.demandLiquidity).sort((a, b) => Number(a) - Number(b)).map((k) => (
              <Num key={k} label={`demand ${k}`} value={lq.demandLiquidity[k]!} step={0.05} onChange={(n) => set((d) => { d.valuation.liquidity.demandLiquidity[k] = n; })} />
            ))}
          </Grid>
          <div className="pt-1 text-[11px] text-neutral-400">Derived demand (no Rolimons data): sales per day for demand 4 / 3 / 2 / 1</div>
          <Grid>
            {dd.map((x, i) => <Num key={i} label={`demand ${4 - i}`} value={x} step={0.05} suffix="/d" onChange={(n) => set((d) => { d.valuation.derivedDemandPerDay[i] = n; })} />)}
          </Grid>
          <Num label="Momentum upside cap" value={s.scoring.momentumCapPp} step={1} suffix="pp" onChange={(n) => set((d) => { d.scoring.momentumCapPp = n; })} />
          <Num label="Momentum downside floor" value={s.scoring.momentumFloorPp} step={1} suffix="pp" onChange={(n) => set((d) => { d.scoring.momentumFloorPp = n; })} />
          <label className="flex items-center gap-2 pt-1 text-xs text-neutral-300">
            <input type="checkbox" checked={s.botList.enabled} onChange={(e) => set((d) => { d.botList.enabled = e.target.checked; })} /> Use the downloaded bot list (data as of {s.botList.asOf || 'unknown'}; applies after restart)
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-neutral-400">
            <span>Your own bot ids</span>
            <input value={ids} placeholder="123, 456" onChange={(e) => { setIds(e.target.value); const xs = e.target.value.split(/[\s,;]+/).map(Number).filter((x) => Number.isInteger(x) && x > 0); set((d) => { d.botList.extraUserIds = xs; }); }} className={`${inp} w-48`} />
          </label>
        </div>
      </div>
    </Panel>
  );
}

function SourcesPanel({ s, set }: { s: Settings; set: (f: (d: Settings) => void) => void }) {
  const h = useHealth();
  return (
    <Panel title="Sources">
      <label className="mb-2 flex items-center gap-2 text-xs text-neutral-300">
        <input type="checkbox" checked={s.rolimonsEnabled} onChange={(e) => set((d) => { d.rolimonsEnabled = e.target.checked; })} /> Use Rolimons (values, demand, trend, sales feed, trade ads)
      </label>
      <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-[11px]">
        <thead className="text-neutral-500"><tr><th className="pr-2 text-left font-normal">source</th><th className="pr-2 text-left font-normal">ok</th><th className="pr-2 text-left font-normal">last success</th><th className="text-right font-normal">429s</th><th className="pl-2 text-right font-normal">cache hit</th><th className="text-left font-normal pl-2">last error</th></tr></thead>
        <tbody>{(h.data?.sources ?? []).map((src) => (
          <tr key={src.id} className="border-t border-neutral-800/60">
            <td className="py-0.5 pr-2 text-neutral-300">{src.id}</td>
            <td className={src.state === 'restricted' ? 'text-neutral-400' : src.ok ? 'text-emerald-400' : 'text-rose-400'} title={src.note ?? undefined}>{src.state === 'restricted' ? 'restricted' : src.ok ? 'ok' : 'down'}</td>
            <td className="pr-2 text-neutral-400">{ago(src.lastSuccessAt)}</td>
            <td className="text-right tabular-nums">{src.count429}</td>
            <td className="text-right tabular-nums">{src.cacheHits + src.cacheMisses ? `${Math.round((src.cacheHits / (src.cacheHits + src.cacheMisses)) * 100)}%` : '—'}</td>
            <td className="max-w-xs truncate pl-2 text-neutral-500" title={src.note ?? src.lastError ?? ''}>{src.state === 'restricted' ? src.note ?? 'restricted (no trading)' : src.lastError ?? ''}</td>
          </tr>
        ))}</tbody>
      </table>
      </div>
      {h.data && (
        <div className="mt-2 text-[10px] text-neutral-500">Jobs: {h.data.jobs.map((j) => `${j.name} ${ago(j.lastOkAt)}${j.lastError ? ' (err)' : ''}`).join(' · ')}</div>
      )}
      <CsvImport />
    </Panel>
  );
}

/** Per-browser: quiet chime when a new inbound trade arrives while this page is not focused. */
function InboundSoundToggle() {
  const [on, setOn] = useState(soundEnabled);
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-300">
      <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setSoundEnabled(e.target.checked); if (e.target.checked) playChime(); }} />
      Quiet chime for new inbound trades when this page is in the background
    </label>
  );
}

function CsvImport() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <label className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-400">
      Manual value overrides (CSV "assetId,value"):
      <input type="file" accept=".csv,text/csv" className="text-[11px]" onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        try { const r = await api.importCsv(await f.text()); setMsg(`imported ${r.imported}`); } catch (err) { setMsg((err as Error).message); }
        e.target.value = '';
      }} />
      {msg && <span className="text-neutral-300">{msg}</span>}
    </label>
  );
}

function ItemListEditor({ title, ids, onChange, hint }: { title: string; ids: AssetId[]; onChange: (ids: AssetId[]) => void; hint: string }) {
  const [q, setQ] = useState('');
  const search = useItemSearch(q);
  const [names, setNames] = useState<Record<number, string>>({});
  // Saved ids have no name until looked up (only fresh search picks set one).
  useEffect(() => {
    for (const id of ids) {
      if (names[id]) continue;
      api.item(id).then((r) => { const n = r.valued?.name ?? r.snapshot?.name; if (n) setNames((m) => ({ ...m, [id]: n })); }).catch(() => { /* keep #id */ });
    }
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-neutral-300">{title} <span className="font-normal text-neutral-500">— {hint}</span></div>
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <span key={id} className="flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px]">
            {names[id] ?? `#${id}`}<button className="text-neutral-500 hover:text-rose-400" onClick={() => onChange(ids.filter((x) => x !== id))}>✕</button>
          </span>
        ))}
        {ids.length === 0 && <span className="text-[11px] text-neutral-600">empty</span>}
      </div>
      <div className="relative">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / acronym or type an asset id + Enter" className={`${inp} w-full`}
          onKeyDown={(e) => { if (e.key === 'Enter' && /^\d+$/.test(q.trim())) { const id = Number(q.trim()); if (!ids.includes(id)) onChange([...ids, id]); setQ(''); } }} />
        {search.data && q.trim().length >= 2 && (
          <ul className="absolute z-10 mt-0.5 max-h-56 w-full overflow-auto rounded border border-neutral-700 bg-neutral-900 text-[11px] shadow-lg">
            {search.data.items.slice(0, 20).map((it) => (
              <li key={it.assetId} className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-neutral-800"
                onClick={() => { setNames((n) => ({ ...n, [it.assetId]: it.name })); if (!ids.includes(it.assetId)) onChange([...ids, it.assetId]); setQ(''); }}>
                {it.thumbnailUrl && <img src={it.thumbnailUrl} width={20} height={20} alt="" />}
                <span className="flex-1">{it.name}{it.acronym && <span className="ml-1 text-neutral-500">({it.acronym})</span>}</span>
                <span className="tabular-nums text-neutral-400">{fmtK(it.value ?? it.rap)}</span>
              </li>
            ))}
            {search.data.items.length === 0 && <li className="px-2 py-1 text-neutral-500">no matches</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

const GOALS: Array<{ v: GoalMode; label: string; hint: string }> = [
  { v: 'grow_value', label: 'Grow value', hint: 'Maximise portfolio value incl. smart upgrades; rewards momentum and demand shift (recommended)' },
  { v: 'grow_rap', label: 'Grow RAP', hint: 'Favour RAP gains' },
  { v: 'liquidity_first', label: 'Liquidity first', hint: 'Favour items that sell / trade away easily' },
  { v: 'upgrade_toward', label: 'Upgrade toward target', hint: 'Favour trades that move you toward one target item' },
];

const WEIGHT_KEYS: Array<[keyof ScoreWeights, string]> = [
  ['edge', 'Edge vs norm'], ['liquid', 'Liquid gain'], ['liquidation', 'Liquidation gain'], ['risk', 'Risk penalty'],
  ['portfolioFit', 'Portfolio fit'], ['momentum', '14d momentum / value lag'], ['demandShift', 'Demand shift'],
  ['confidence', 'Low-confidence penalty'], ['scale', 'Logit scale'], ['bias', 'Bias'],
];

function NormSuggestionView({ current, onApply }: { current: Array<{ tier: string; pct: number }>; onApply: (rows: NormSuggestionRow[]) => void }) {
  const q = useLearning();
  const sug = q.data?.accuracy?.normSuggestion ?? null;
  if (!sug) return <div className="mt-2 border-t border-neutral-800 pt-2 text-[11px] text-neutral-500">Calibration suggestions appear after the daily learning run.</div>;
  const movable = sug.rows.filter((r) => r.enough && Math.abs(r.suggested - (current.find((c) => c.tier === r.tier)?.pct ?? r.current)) >= 0.001);
  return (
    <div className="mt-2 border-t border-neutral-800 pt-2 text-[11px]">
      <div className="mb-1 text-neutral-300">Learned from your trades <span className="text-neutral-500">— completed trades count 1, observed offers 0.5; shrunk toward current (k={sug.priorStrength}); needs ≥{sug.minSample} per tier</span></div>
      <table className="w-full">
        <thead className="text-neutral-500"><tr><th className="text-left font-normal">tier</th><th className="text-right font-normal">current</th><th className="text-right font-normal">observed</th><th className="text-right font-normal">suggested</th><th className="text-right font-normal">n (yours / market)</th></tr></thead>
        <tbody>{sug.rows.map((r) => {
          const cur = current.find((c) => c.tier === r.tier)?.pct ?? r.current;
          return (
            <tr key={r.tier} className="border-t border-neutral-800/60">
              <td>{r.tier}</td>
              <td className="text-right tabular-nums">{(cur * 100).toFixed(1)}%</td>
              <td className="text-right tabular-nums text-neutral-400">{r.observed == null ? '—' : `${(r.observed * 100).toFixed(1)}%`}</td>
              <td className={`text-right tabular-nums ${r.enough ? 'text-neutral-100' : 'text-neutral-500'}`}>{r.enough ? `${(r.suggested * 100).toFixed(1)}%` : 'need more data'}</td>
              <td className="text-right tabular-nums text-neutral-400">{r.nUser} / {r.nMarket}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <button disabled={!movable.length} onClick={() => onApply(movable)}
        className="mt-1 rounded border border-neutral-700 px-2 py-0.5 text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">
        Apply suggested ({movable.length}) to draft
      </button> <span className="text-neutral-500">then Save</span>
    </div>
  );
}

export function SettingsPage() {
  const q = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => { if (q.data && !draft) setDraft(structuredClone(q.data.settings)); }, [q.data, draft]);

  if (!q.data || !draft) return <><CookiePanel /><Loading q={q} /></>;
  const s = draft;
  const defaults = q.data.defaults;
  const set = (f: (d: Settings) => void) => setDraft((d) => { const c = structuredClone(d!); f(c); return c; });
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data.settings);
  const goalOv = s.goalWeightOverrides[s.goalMode] ?? {};

  return (
    <div className="space-y-3 pb-16">
      <CookiePanel />

      <Panel title="Goal & notifications">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            {GOALS.map((g) => (
              <label key={g.v} className="flex items-start gap-2 text-xs" title={g.hint}>
                <input type="radio" name="goal" checked={s.goalMode === g.v} onChange={() => set((d) => { d.goalMode = g.v; })} className="mt-0.5" />
                <span><span className="text-neutral-200">{g.label}</span> <span className="text-neutral-500">— {g.hint}</span></span>
              </label>
            ))}
            {s.goalMode === 'upgrade_toward' && (
              <Num label="Target asset id" value={s.upgradeTargetAssetId ?? 0} onChange={(n) => set((d) => { d.upgradeTargetAssetId = n || null; })} />
            )}
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.notifyEnabled} onChange={(e) => set((d) => { d.notifyEnabled = e.target.checked; })} /> Desktop notification for good inbound trades (notification only)
            </label>
            <Num label="Notify when score ≥" value={s.notifyThreshold} onChange={(n) => set((d) => { d.notifyThreshold = n; })} />
            <InboundSoundToggle />
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.openUiOnStart} onChange={(e) => set((d) => { d.openUiOnStart = e.target.checked; })} /> Open this UI when the background service starts
            </label>
            <div className="pt-1 text-[11px] text-neutral-500">Verdict bands</div>
            <Num label="Accept ≥" value={s.verdictBands.accept} onChange={(n) => set((d) => { d.verdictBands.accept = n; })} />
            <Num label="Lean accept ≥" value={s.verdictBands.leanAccept} onChange={(n) => set((d) => { d.verdictBands.leanAccept = n; })} />
            <Num label="Counter ≥" value={s.verdictBands.counter} onChange={(n) => set((d) => { d.verdictBands.counter = n; })} />
          </div>
        </div>
      </Panel>

      <Panel title="Item lists">
        <div className="grid gap-4 lg:grid-cols-3">
          <ItemListEditor title="Hold list" hint="never give these (caps verdict at Decline)" ids={s.holdList} onChange={(ids) => set((d) => { d.holdList = ids; })} />
          <ItemListEditor title="Wishlist" hint="small bonus when received" ids={s.wishlist} onChange={(ids) => set((d) => { d.wishlist = ids; })} />
          <ItemListEditor title="Watchlist" hint="shown on the Market tab" ids={s.watchlist} onChange={(ids) => set((d) => { d.watchlist = ids; })} />
        </div>
      </Panel>

      <Panel title="Drops (new limiteds)">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.drops.enabled} onChange={(e) => set((d) => { d.drops.enabled = e.target.checked; })} /> Watch for new limited releases (read-only; you buy on roblox.com)
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.drops.includeUgc} onChange={(e) => set((d) => { d.drops.includeUgc = e.target.checked; })} /> Include UGC limiteds (resale only, not tradable)
            </label>
            <Ms label="Check Roblox-made every" value={s.drops.robloxPollMs} onChange={(n) => set((d) => { d.drops.robloxPollMs = n; })} />
            <Ms label="Check all creators every" value={s.drops.allPollMs} onChange={(n) => set((d) => { d.drops.allPollMs = n; })} />
            <Ms label="Refresh stock every" value={s.drops.stockRefreshMs} onChange={(n) => set((d) => { d.drops.stockRefreshMs = n; })} />
            <div className="text-[10px] text-neutral-500">
              Roblox allows 12 catalog searches a minute per IP; the two checks together must stay at or under 6 a minute
              (now {(60_000 / s.drops.robloxPollMs + (s.drops.includeUgc ? 60_000 / s.drops.allPollMs : 0)).toFixed(1)}) so the creator watchlist has room. Defaults: {defaults.drops.robloxPollMs / 1000}s and {defaults.drops.allPollMs / 1000}s.
            </div>
          </div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.drops.notify} onChange={(e) => set((d) => { d.drops.notify = e.target.checked; })} /> Desktop notification for new drops (click opens the roblox.com page)
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input type="checkbox" checked={s.drops.notifyTradableOnly} onChange={(e) => set((d) => { d.drops.notifyTradableOnly = e.target.checked; })} /> Only tradable (Roblox-made) drops
            </label>
            <Num label="Only when price ≤ (0 = any)" value={s.drops.notifyMaxPrice} step={100} suffix="R$" onChange={(n) => set((d) => { d.drops.notifyMaxPrice = Math.max(0, n); })} />
            <Num label="Only when stock ≥ (0 = any)" value={s.drops.notifyMinQuantity} step={10} onChange={(n) => set((d) => { d.drops.notifyMinQuantity = Math.max(0, n); })} />
          </div>
        </div>
        <CreatorWatchlist creators={s.drops.creators} onChange={(c) => set((d) => { d.drops.creators = c; })} />
      </Panel>

      <Panel title="Trade hold countdown">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1">
            <Num label="Assumed trade hold" value={s.hold.assumedDays} step={0.5} suffix="days" hint="unconfirmed — learns from your traded items"
              onChange={(n) => set((d) => { d.hold.assumedDays = Math.min(30, Math.max(0.5, n)); })} />
            <div className="text-[11px] text-neutral-500">unconfirmed — learns from your traded items</div>
            <Num label="Assumed purchase hold" value={s.hold.assumedPurchaseDays ?? 3} step={0.5} suffix="days" hint="unconfirmed — learns from items you bought"
              onChange={(n) => set((d) => { d.hold.assumedPurchaseDays = Math.min(30, Math.max(0.5, n)); })} />
            <div className="text-[11px] text-neutral-500">unconfirmed — bought items are believed to be held longer; learns from items you bought</div>
          </div>
          <p className="text-[11px] leading-snug text-neutral-500">
            In use:{' '}
            {(['trade', 'purchase', 'unknown'] as const).map((k) => {
              const L = q.data.hold?.lengths?.[k];
              return L ? <span key={k} className="block"><span className={L.source === 'measured' ? 'text-emerald-400' : 'text-amber-300'}>{L.label}</span></span> : null;
            })}
            {q.data.hold ? <>{q.data.hold.observations} lift{q.data.hold.observations === 1 ? '' : 's'} recorded</> : null}
            {q.data.hold?.purchaseLookup ? <> · purchase history: {q.data.hold.purchaseLookup.failed ? <span className="text-amber-300">unavailable ({q.data.hold.purchaseLookup.failed})</span>
              : q.data.hold.purchaseLookup.lastFetchAt ? `${q.data.hold.purchaseLookup.rows} purchases, checked ${new Date(q.data.hold.purchaseLookup.lastFetchAt).toLocaleString()}` : 'not needed yet'}</> : null}.
            Roblox only says whether a copy is on hold, never for how long. The start is the completion of the trade that brought the copy in, else its
            purchase time from your Roblox transaction history (read-only), else the first time the app saw it on hold (source unknown: the longer of the two lengths is used).
            Trade and purchase holds each switch to their own median measured length once the app watches one lift.
            Near an estimated release the inventory is refreshed every 5 minutes to catch the lift.
          </p>
        </div>
      </Panel>

      <SourcesPanel s={s} set={set} />

      <MarketDriftPanel s={s} set={set} market={q.data.market} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Upgrade / downgrade norms">
          <Grid>
            <Num label="Small tier max value" value={s.overpayNorms.smallMax} step={1000} onChange={(n) => set((d) => { d.overpayNorms.smallMax = n; })} />
            <Num label="Mid tier max value" value={s.overpayNorms.midMax} step={10000} onChange={(n) => set((d) => { d.overpayNorms.midMax = n; })} />
            {s.overpayNorms.rows.map((r, i) => (
              <Pct key={r.tier} label={`${r.tier} tier norm`} value={r.pct} onChange={(n) => set((d) => { d.overpayNorms.rows[i]!.pct = n; })} />
            ))}
            <Pct label="Rare bonus" value={s.overpayNorms.rareBonusPct} onChange={(n) => set((d) => { d.overpayNorms.rareBonusPct = n; })} />
            <Pct label="High-demand bonus" value={s.overpayNorms.highDemandBonusPct} onChange={(n) => set((d) => { d.overpayNorms.highDemandBonusPct = n; })} />
            <Pct label="Low-demand discount" value={s.overpayNorms.lowDemandDiscountPct} onChange={(n) => set((d) => { d.overpayNorms.lowDemandDiscountPct = n; })} />
            <Pct label="Max norm" value={s.overpayNorms.maxPct} onChange={(n) => set((d) => { d.overpayNorms.maxPct = n; })} />
          </Grid>
          <NormSuggestionView current={s.overpayNorms.rows} onApply={(rows) => set((d) => { for (const r of rows) { const row = d.overpayNorms.rows.find((x) => x.tier === r.tier); if (row) row.pct = r.suggested; } if (rows.length) d.overpayNorms.source = 'calibrated'; })} />
        </Panel>

        <Panel title={`Score weights (base; ${s.goalMode} overrides shown)`}>
          <Grid>
            {WEIGHT_KEYS.map(([k, label]) => (
              <Num key={k} label={label + (goalOv[k] !== undefined ? ` (goal: ${goalOv[k]})` : '')} step={0.01} value={s.weights[k]}
                hint={`default ${defaults.weights[k]}`} onChange={(n) => set((d) => { d.weights[k] = n; })} />
            ))}
          </Grid>
          {Object.keys(goalOv).length > 0 && (
            <div className="mt-2 border-t border-neutral-800 pt-2">
              <div className="mb-1 text-[11px] text-neutral-500">Overrides for {s.goalMode}</div>
              <Grid>
                {(Object.keys(goalOv) as Array<keyof ScoreWeights>).map((k) => (
                  <Num key={k} label={k} step={0.01} value={goalOv[k] ?? 0} onChange={(n) => set((d) => { d.goalWeightOverrides[d.goalMode] = { ...d.goalWeightOverrides[d.goalMode], [k]: n }; })} />
                ))}
              </Grid>
            </div>
          )}
        </Panel>

        <Panel title="Risk penalties (points)">
          <Grid>
            {(Object.keys(s.risk) as Array<keyof Settings['risk']>).map((k) => (
              <Num key={k} label={k} step={0.5} value={s.risk[k]} hint={`default ${defaults.risk[k]}`} onChange={(n) => set((d) => { d.risk[k] = n; })} />
            ))}
          </Grid>
        </Panel>

        <Panel title="Serial premium">
          <label className="mb-2 flex items-center gap-2 text-xs text-neutral-300">
            <input type="checkbox" checked={s.valuation.serialPremiumEnabled} onChange={(e) => set((d) => { d.valuation.serialPremiumEnabled = e.target.checked; })} /> Enabled
          </label>
          <label className="mb-2 flex items-center gap-2 text-xs text-neutral-300">
            <input type="checkbox" checked={s.valuation.serialPremiumForUnvalued} onChange={(e) => set((d) => { d.valuation.serialPremiumForUnvalued = e.target.checked; })} /> Also for unvalued items
          </label>
          <table className="w-full text-xs">
            <thead className="text-[11px] text-neutral-500"><tr><th className="text-left font-normal">exact serials</th><th className="text-left font-normal">or max serial</th><th className="text-left font-normal">multiplier</th><th /></tr></thead>
            <tbody>
              {s.valuation.serialPremium.map((r, i) => (
                <tr key={i}>
                  <td><input className={`${inp} w-36`} value={r.exact?.join(',') ?? ''} placeholder="e.g. 1,69,420"
                    onChange={(e) => set((d) => { const row = d.valuation.serialPremium[i]!; const v = e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0); if (v.length) row.exact = v; else delete row.exact; })} /></td>
                  <td><input type="number" className={`${inp} w-20`} value={r.maxSerial ?? ''}
                    onChange={(e) => set((d) => { const row = d.valuation.serialPremium[i]!; if (e.target.value) row.maxSerial = Number(e.target.value); else delete row.maxSerial; })} /></td>
                  <td><input type="number" step={0.01} className={`${inp} w-20`} value={r.multiplier}
                    onChange={(e) => set((d) => { d.valuation.serialPremium[i]!.multiplier = Number(e.target.value); })} /></td>
                  <td><button className="text-neutral-500 hover:text-rose-400" onClick={() => set((d) => { d.valuation.serialPremium.splice(i, 1); })}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-1"><Btn onClick={() => set((d) => { d.valuation.serialPremium.push({ maxSerial: 10, multiplier: 1.05 } satisfies SerialPremiumRow); })}>+ row</Btn></div>
          <div className="mt-1 text-[10px] text-neutral-500">First matching row wins (top to bottom).</div>
        </Panel>

        <Panel title="Valuation & scoring">
          <Grid>
            <Pct label="RAP vs floor tolerance" value={s.valuation.rapFloorTolerancePct} onChange={(n) => set((d) => { d.valuation.rapFloorTolerancePct = n; })} />
            <Pct label="Value-lag threshold" value={s.valuation.valueLagThresholdPct} onChange={(n) => set((d) => { d.valuation.valueLagThresholdPct = n; })} />
            <Pct label="Value-lag max lift" value={s.valuation.valueLagMaxLiftPct} onChange={(n) => set((d) => { d.valuation.valueLagMaxLiftPct = n; })} />
            <Pct label="Marketplace fee" value={s.valuation.marketplaceFeePct} onChange={(n) => set((d) => { d.valuation.marketplaceFeePct = n; })} />
            <Pct label="Thin-book discount" value={s.valuation.thinBookDiscountPct} onChange={(n) => set((d) => { d.valuation.thinBookDiscountPct = n; })} />
            <Num label="Rare ≤ copies" value={s.valuation.rareMaxCopies} onChange={(n) => set((d) => { d.valuation.rareMaxCopies = n; })} />
            <Num label="Hoard min copies" value={s.hoard.minCopies} onChange={(n) => set((d) => { d.hoard.minCopies = n; })} />
            <Pct label="Hoard top-3 share" value={s.hoard.top3Share} onChange={(n) => set((d) => { d.hoard.top3Share = n; })} />
            <Pct label="Filler threshold" value={s.scoring.fillerThresholdPct} onChange={(n) => set((d) => { d.scoring.fillerThresholdPct = n; })} />
            <Pct label="Duplicate discount" value={s.scoring.duplicateDiscountPct} onChange={(n) => set((d) => { d.scoring.duplicateDiscountPct = n; })} />
            <Num label="New account < days" value={s.scoring.newAccountDays} onChange={(n) => set((d) => { d.scoring.newAccountDays = n; })} />
            <Num label="Projection spike ratio" step={0.1} value={s.projection.spikeRatio} onChange={(n) => set((d) => { d.projection.spikeRatio = n; })} />
          </Grid>
        </Panel>

        <Panel title="Poll intervals">
          <label className="mb-2 flex items-center gap-2 text-xs text-neutral-300">
            <input type="checkbox" checked={s.poll.inboundListOnChangeOnly} onChange={(e) => set((d) => { d.poll.inboundListOnChangeOnly = e.target.checked; })} /> Only fetch inbound list when the count changes
          </label>
          <Grid>
            {(Object.keys(s.poll) as Array<keyof Settings['poll']>).filter((k) => k !== 'inboundListOnChangeOnly').map((k) => (
              <Ms key={k} label={k.replace(/Ms$/, '')} value={s.poll[k] as number} onChange={(n) => set((d) => { (d.poll[k] as number) = n; })} />
            ))}
          </Grid>
          <div className="mt-1 text-[10px] text-neutral-500">Catalog details is limited to 10 req/min; Rolimons sales window is minutes (keep ~4s).</div>
        </Panel>
      </div>

      <div className="fixed inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-800 bg-neutral-900/95 px-3 py-2 text-xs sm:px-4">
        {dirty ? <span className="text-amber-300">Unsaved changes</span> : <span className="text-neutral-500">{savedAt ? `Saved ${date(savedAt)}` : 'No changes'}</span>}
        {save.error && <span className="min-w-0 break-words text-rose-400">{(save.error as Error).message}</span>}
        <span className="ml-auto flex gap-2">
          <Btn onClick={() => setDraft(structuredClone(q.data.settings))} disabled={!dirty}>Discard</Btn>
          <Btn onClick={() => { if (confirm('Reset all settings to defaults (not saved until you press Save)?')) setDraft(structuredClone({ ...defaults, holdList: s.holdList, wishlist: s.wishlist, watchlist: s.watchlist })); }}>Defaults</Btn>
          <Btn kind="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(s, { onSuccess: (r) => { setDraft(structuredClone(r.settings)); setSavedAt(Date.now()); } })}>
            {save.isPending ? 'Saving…' : 'Save & rescore'}
          </Btn>
        </span>
      </div>
    </div>
  );
}
