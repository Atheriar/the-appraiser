/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useHistory, useRunLearning } from '../lib/api';
import { date, fmtK, pct, signed, tone } from '../lib/format';
import { Loading, Panel, Stat, Thumb, VerdictChip } from '../components/ui';

export function HistoryPage() {
  const q = useHistory();
  const acc = q.data?.accuracy ?? null;
  const run = useRunLearning();
  const d = acc?.itemDrift ?? null;
  return (
    <div className="space-y-3">
      <Panel title="Model accuracy" right={<button onClick={() => run.mutate()} disabled={run.isPending} className="text-xs text-neutral-400 hover:text-neutral-100">{run.isPending ? 'recomputing…' : 'recompute'}</button>}>
        {acc ? (
          <div className="flex flex-wrap gap-8">
            <Stat label="Trades evaluated" value={acc.trades} />
            <Stat label="Verdict hit rate" value={acc.verdictHitRate == null ? '—' : pct(acc.verdictHitRate, 0, false)} />
            <Stat label="Avg 30d drift (accepted)" value={<span className={tone(acc.avgDrift30dAccepted)}>{signed(acc.avgDrift30dAccepted)}</span>} />
            <Stat label="Avg 30d drift (declined)" value={<span className={tone(acc.avgDrift30dDeclined)}>{signed(acc.avgDrift30dDeclined)}</span>} />
            <Stat label="30d drift % (accepted)" value={<span className={tone(acc.avgDriftPct30dAccepted)}>{pct(acc.avgDriftPct30dAccepted)}{acc.accepted30dN != null && <span className="text-neutral-500"> n={acc.accepted30dN}</span>}</span>} />
            <Stat label="30d drift % (declined)" value={<span className={tone(acc.avgDriftPct30dDeclined)}>{pct(acc.avgDriftPct30dDeclined)}{acc.declined30dN != null && <span className="text-neutral-500"> n={acc.declined30dN}</span>}</span>} />
            {d && <Stat label="Item value drift, received vs given (7d / 30d)" value={<span>
              <span className={tone(d.received7d)}>{pct(d.received7d)}</span> vs <span className={tone(d.given7d)}>{pct(d.given7d)}</span>{' / '}
              <span className={tone(d.received30d)}>{pct(d.received30d)}</span> vs <span className={tone(d.given30d)}>{pct(d.given30d)}</span>
              <span className="text-neutral-500"> n={d.n7}/{d.n30}</span></span>} />}
            <Stat label="Calibrated norms" value={acc.calibratedNorms ? acc.calibratedNorms.rows.map((r) => `${r.tier} ${pct(r.pct, 0, false)}`).join(' · ') : 'not enough data (see Settings)'} />
            <Stat label="Computed" value={date(acc.computedAt)} />
          </div>
        ) : <div className="text-xs text-neutral-500">Accuracy appears once completed/declined trades have 7–30 days of follow-up data.</div>}
      </Panel>
      <Loading q={q} />
      {q.data && (
        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-xs">
            <thead className="bg-neutral-900 text-[11px] text-neutral-400">
              <tr>{['Trade', 'Partner', 'Give', 'Get', 'Outcome', 'Score then', 'Value gain then', 'Value gain now', 'RAP then', 'RAP now'].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.trade.tradeId} className="border-t border-neutral-800">
                  <td className="px-2 py-1 text-neutral-500">#{r.trade.tradeId}<div className="text-[10px]">{date(r.trade.createdAt)}</div></td>
                  <td className="px-2">{r.trade.partner.displayName}</td>
                  <td className="px-2"><span className="flex gap-1">{(r.scoreAtTime?.give ?? []).map((i, k) => <Thumb key={k} item={i} />)}{!r.scoreAtTime && r.trade.give.items.map((i) => i.name).join(', ')}</span></td>
                  <td className="px-2"><span className="flex gap-1">{(r.scoreAtTime?.get ?? []).map((i, k) => <Thumb key={k} item={i} />)}{!r.scoreAtTime && r.trade.get.items.map((i) => i.name).join(', ')}</span></td>
                  <td className="px-2 text-neutral-300">{r.finalStatus}</td>
                  <td className="px-2">{r.scoreAtTime ? <VerdictChip verdict={r.scoreAtTime.verdict} score={r.scoreAtTime.score} /> : '—'}</td>
                  <td className={`px-2 tabular-nums ${tone(r.valueGainAtTime)}`}>{signed(r.valueGainAtTime)}</td>
                  <td className={`px-2 tabular-nums ${tone(r.valueGainNow)}`}>{signed(r.valueGainNow)}</td>
                  <td className={`px-2 tabular-nums ${tone(r.rapGainAtTime)}`}>{signed(r.rapGainAtTime)}</td>
                  <td className={`px-2 tabular-nums ${tone(r.rapGainNow)}`}>{signed(r.rapGainNow, fmtK)}</td>
                </tr>
              ))}
              {q.data.rows.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-neutral-500">No finished trades yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
