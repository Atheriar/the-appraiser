/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Learning job (Phase 3). Read-only analysis over our own DB:
 *  - records trade outcomes (final status after leaving active) with scoring context at decision time,
 *  - marks each traded item's tradeValue at decision and again at +7 / +30 days,
 *  - computes model accuracy + a shrunk overpay-norm suggestion (the user applies it in Settings),
 *  - scans snapshot history for raise/drop-pending lag and feeds the Market anomaly feed.
 * Never touches Roblox trade endpoints.
 */
import type { CoreEngine } from '../core/contracts.js';
import { applySnapshotLag, computeAccuracy as coreAccuracy, snapshotLag, suggestNorms, type LagSignal } from '../core/learning.js';
import type { AssetId, MarketAnomaly, Settings, TradeScore, TradeSnapshot, ValuedItem } from '../core/types.js';
import type { SqliteRepository } from '../db/sqlite.js';

const DAY = 86_400_000;

export interface LearningDeps {
  repo: SqliteRepository;
  engine: CoreEngine;
  settings: () => Settings;
  /** Current valuation of an item (no network). */
  valueFor: (assetId: AssetId) => ValuedItem;
  /** Re-score a trade with current values (no network). `plain` = no lag overlay / consolidation premium. */
  computeScore: (t: TradeSnapshot, opts?: { plain?: boolean }) => TradeScore;
  log?: { warn: (msg: string, e?: unknown) => void };
}

export interface StoredLag { signal: LagSignal; at: number }
export const lagKey = (id: AssetId) => `snapLag:${id}`;
/** A stored lag signal is only applied while fresh. */
export const LAG_TTL_MS = DAY;

export class LearningJob {
  constructor(private readonly d: LearningDeps) {}

  /** Outcomes + value marks + accuracy + norm suggestion. Idempotent; run daily. */
  runOutcomes(now = Date.now()): void {
    const { repo } = this.d;
    for (const t of repo.listDecided(500, 0)) {
      try { this.recordTrade(t, now); } catch (e) { this.d.log?.warn(`outcome ${t.tradeId} failed`, e); }
    }
    this.updateMarks(now);
    const outcomes = repo.outcomes(0);
    const marks = repo.valueMarks();
    const acc = this.d.engine.computeAccuracy(outcomes, now);
    const current = this.d.settings().overpayNorms;
    const suggestion = suggestNorms(outcomes, current);
    const calibrated = this.d.engine.calibrateNorms(outcomes, current);
    const { itemDrift, avgDriftPct30dAccepted, avgDriftPct30dDeclined, judged, accepted30dN, declined30dN } =
      // extras always come from the core learning module (the fallback engine lacks them)
      coreAccuracy(outcomes, now, marks);
    repo.insertModelRun({
      ...acc, itemDrift, avgDriftPct30dAccepted, avgDriftPct30dDeclined, judged, accepted30dN, declined30dN,
      calibratedNorms: calibrated ?? acc.calibratedNorms, normSuggestion: suggestion,
    });
  }

  private recordTrade(t: TradeSnapshot, now: number): void {
    const { repo } = this.d;
    const decided = repo.decidedAt(t.tradeId) ?? t.fetchedAt;
    const at = repo.scoreAtOrBefore(t.tradeId, decided) ?? repo.latestScore(t.tradeId);
    if (!at) return;
    const prev = repo.getOutcome(t.tradeId);
    const age = now - decided;
    let gain7 = prev?.valueGainAt7d ?? null, gain30 = prev?.valueGainAt30d ?? null;
    if ((gain7 == null && age >= 7 * DAY) || (gain30 == null && age >= 30 * DAY)) {
      const s = this.d.computeScore(t, { plain: true });
      if (gain7 == null && age >= 7 * DAY) gain7 = s.totals.rawGain;
      if (gain30 == null && age >= 30 * DAY) gain30 = s.totals.rawGain;
    }
    const dom = [...at.give, ...at.get].find((i) => i.assetId === at.dominantAssetId) ?? null;
    repo.upsertOutcome({
      tradeId: t.tradeId, finalStatus: t.status, decidedAt: decided, valueGainAt7d: gain7, valueGainAt30d: gain30,
      verdictAtTime: at.verdict, scoreAtTime: at.score,
      shape: at.shape, normPct: at.normPct, rawGainPct: at.rawGainPct, valueGiveAtTime: at.totals.valueGive,
      ...(dom ? { valueTier: this.d.engine.valueTier(dom.tradeValue, this.d.settings().overpayNorms), dominantValueAtTime: dom.tradeValue } : {}),
    });
    if (!prev) {
      // First sighting: value0 = tradeValue at decision (from the score then).
      for (const [side, items] of [['give', at.give], ['get', at.get]] as const) {
        const seen = new Set<AssetId>();
        for (const it of items) {
          if (seen.has(it.assetId)) continue;
          seen.add(it.assetId);
          repo.upsertValueMark({ tradeId: t.tradeId, side, assetId: it.assetId, finalStatus: t.status, decidedAt: decided, value0: it.tradeValue, value7d: null, value30d: null });
        }
      }
    }
  }

  /** Fill +7d / +30d tradeValue for marks that have reached that age. */
  private updateMarks(now: number): void {
    const cache = new Map<AssetId, number>();
    const value = (id: AssetId) => {
      if (!cache.has(id)) cache.set(id, this.d.valueFor(id).tradeValue);
      return cache.get(id)!;
    };
    for (const m of this.d.repo.valueMarks({ pendingOnly: true })) {
      const age = now - m.decidedAt;
      const v7 = m.value7d == null && age >= 7 * DAY ? value(m.assetId) : m.value7d;
      const v30 = age >= 30 * DAY ? value(m.assetId) : null;
      if (v7 !== m.value7d || v30 != null) {
        try { this.d.repo.upsertValueMark({ ...m, value7d: v7, value30d: v30 }); } catch (e) { this.d.log?.warn('value mark failed', e); }
      }
    }
  }

  /**
   * Snapshot-based lag scan for the given items: stores the signal (applied in valuation while
   * fresh) and emits a raise/drop anomaly when the signal is new.
   */
  scanSnapshots(assetIds: AssetId[], now = Date.now()): number {
    let emitted = 0;
    for (const id of assetIds) {
      const hist = this.d.repo.itemSnapshotHistory(id, now - 7 * DAY);
      if (!hist.length) continue;
      const v = this.d.valueFor(id);
      const sig = snapshotLag(hist, v.roliValue ?? null, now);
      const prev = this.d.repo.getKv<StoredLag | null>(lagKey(id));
      this.d.repo.setKv<StoredLag | null>(lagKey(id), sig ? { signal: sig, at: now } : null);
      if (!sig || (prev && prev.signal.kind === sig.kind)) continue;
      const lifted = applySnapshotLag(v, sig);
      const a: MarketAnomaly = {
        id: `${sig.kind}:snap:${id}:${Math.floor(now / DAY)}`, assetId: id, name: v.name, kind: sig.kind,
        message: `${v.name}: snapshots show market ${Math.round(sig.mkt).toLocaleString()} vs value ${Math.round(sig.value).toLocaleString()} (${sig.kind === 'raise_pending' ? 'raise' : 'drop'} pending)`,
        changePct: sig.changePct, evidence: lifted.evidence.filter((e) => e.code.startsWith('snapshot_lag')), at: now,
      };
      this.d.repo.insertAnomaly(a);
      emitted++;
    }
    return emitted;
  }

  /** Apply a fresh stored lag signal to a valued item (used by Analyst.valueFor). */
  static overlay(repo: SqliteRepository, v: ValuedItem, now = Date.now()): ValuedItem {
    const s = repo.getKv<StoredLag | null>(lagKey(v.assetId));
    if (!s || now - s.at > LAG_TTL_MS) return v;
    return applySnapshotLag(v, s.signal);
  }
}

