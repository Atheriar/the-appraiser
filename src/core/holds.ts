/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Trade-hold countdown. Roblox only exposes isOnHold (bool) per owned instance, never the hold length
 * or end time, so the start is inferred (completion time of the trade that brought the copy in, else the
 * first time the app saw it on hold) and the length is assumed per hold kind (Settings hold.assumedDays for trades,
 * hold.assumedPurchaseDays for purchases; both unconfirmed)
 * until the app has watched at least one hold lift, after which the median observed length is used.
 * Pure functions only; the analyst persists HoldState in kv 'holdTracker'.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Granularity the measured length is rounded up to (fast inventory refresh near a release). */
export const HOLD_POLL_GRANULARITY_MS = 5 * MIN;
/** Refresh own inventory faster while some hold is due within this window (or past due). */
export const HOLD_FAST_WINDOW_MS = 2 * HOUR;
/** Fast own-inventory refresh interval near an estimated release. */
export const HOLD_FAST_REFRESH_MS = 5 * MIN;
/** A trade older than this is not taken as the start of a hold seen now. */
export const HOLD_TRADE_MATCH_MAX_AGE_MS = 30 * DAY;
/** Keep at most this many observations. */
export const HOLD_MAX_OBSERVATIONS = 200;
/** A tracked copy missing from a fetch (partial fetch, e.g. the tradable list failed) is kept this long. */
export const HOLD_MISSING_GRACE_MS = 24 * HOUR;
/** Stop the fast refresh once an estimate is this far past due (the length is likely longer than assumed). */
export const HOLD_FAST_MAX_OVERDUE_MS = 24 * HOUR;

/**
 * 'trade': the app watched the trade complete (precise to one completed-list poll).
 * 'trade_created': the trade was first seen already completed; its creation time is the earliest possible start.
 * 'first_seen': no trade found (purchase, or older than the app); first fetch that showed it on hold (a lower bound).
 */
export type HoldStartBasis = 'trade' | 'trade_created' | 'purchase' | 'first_seen';

/**
 * Where the hold came from. 'trade': matched to a completed trade. 'purchase': matched to a Roblox
 * Purchase transaction (economy transaction history). 'unknown': only the first-seen time is known.
 * Roblox holds bought items for a different (believed longer) time than traded ones, so each kind has its own length.
 */
export type HoldKind = 'trade' | 'purchase' | 'unknown';

export const kindOfBasis = (b: HoldStartBasis): HoldKind => (b === 'trade' || b === 'trade_created' ? 'trade' : b === 'purchase' ? 'purchase' : 'unknown');

/** A Roblox Purchase transaction reduced to what matching needs. */
export interface PurchaseRef { assetId: number; at: number }

/** A purchase older than this is not taken as the start of a hold seen now. */
export const HOLD_PURCHASE_MATCH_MAX_AGE_MS = 30 * DAY;

/** Most recent purchase of this asset at or before `before` (within 30 days). */
export function matchPurchaseStart(assetId: number, purchases: PurchaseRef[], before: number): PurchaseRef | null {
  let best: PurchaseRef | null = null;
  for (const p of purchases) {
    if (p.assetId !== assetId || p.at > before || before - p.at > HOLD_PURCHASE_MATCH_MAX_AGE_MS) continue;
    if (!best || p.at > best.at) best = p;
  }
  return best;
}

export interface HoldEntry {
  key: string;
  assetId: number;
  serial: number | null;
  holdStart: number;
  startBasis: HoldStartBasis;
  /** Hold source (absent on states saved before kinds existed: derive with kindOfBasis). */
  kind?: HoldKind;
  tradeId: number | null;
  firstSeenOnHold: number;
  lastSeenOnHold: number;
  /** Set while the copy is absent from inventory fetches (kept for HOLD_MISSING_GRACE_MS, no lift recorded). */
  missingSince?: number;
}

export interface HoldObservation {
  assetId: number;
  serial: number | null;
  holdStart: number;
  startBasis: HoldStartBasis;
  kind?: HoldKind;
  /** Last inventory fetch that still showed it on hold. */
  lastSeenOnHold: number;
  /** First inventory fetch that showed it tradable. */
  liftSeenAt: number;
  /** liftSeenAt - holdStart (upper bound of the true length). */
  durationMs: number;
  /** liftSeenAt - lastSeenOnHold: the lift happened somewhere in this window. */
  uncertaintyMs: number;
}

export interface HoldState { entries: Record<string, HoldEntry>; observations: HoldObservation[] }

export const emptyHoldState = (): HoldState => ({ entries: {}, observations: [] });

export interface HoldInstance { userAssetId: number | null; collectibleItemInstanceId?: string | null; assetId: number; serialNumber: number | null; isOnHold: boolean }

/** Completed trade, reduced to what start matching needs: completion time and the items received. */
export interface CompletedTradeRef { tradeId: number; at: number; /** true when `at` is the watched completion time, false when it is the creation time. */ observed: boolean; received: Array<{ assetId: number; serial: number | null; userAssetId: number | null; collectibleItemInstanceId?: string | null }> }

export function instanceKey(i: { userAssetId?: number | null; collectibleItemInstanceId?: string | null; assetId: number; serialNumber?: number | null; serial?: number | null }): string {
  if (i.collectibleItemInstanceId) return `ci:${i.collectibleItemInstanceId}`;
  if (i.userAssetId != null && i.userAssetId !== 0) return `ua:${i.userAssetId}`;
  return `as:${i.assetId}:${i.serialNumber ?? i.serial ?? 'n'}`;
}

/**
 * Latest completed trade (at or before `now`, within 30 days) that brought this copy in.
 * Match: same userAssetId / instance id, else assetId + serial (both null serials only when the asset
 * appears once among received copies of that trade).
 */
export function matchTradeStart(inst: HoldInstance, trades: CompletedTradeRef[], now: number): CompletedTradeRef | null {
  let best: CompletedTradeRef | null = null;
  for (const t of trades) {
    if (t.at > now || now - t.at > HOLD_TRADE_MATCH_MAX_AGE_MS) continue;
    const hit = t.received.some((r) => {
      if (r.assetId !== inst.assetId) return false;
      if (inst.collectibleItemInstanceId && r.collectibleItemInstanceId) return r.collectibleItemInstanceId === inst.collectibleItemInstanceId;
      if (inst.userAssetId != null && inst.userAssetId > 0 && r.userAssetId != null && r.userAssetId > 0) return r.userAssetId === inst.userAssetId;
      if (inst.serialNumber != null && r.serial != null) return r.serial === inst.serialNumber;
      if (inst.serialNumber == null && r.serial == null) return t.received.filter((x) => x.assetId === inst.assetId).length === 1;
      return false;
    });
    if (hit && (!best || t.at > best.at)) best = t;
  }
  return best;
}

const tradeBasis = (m: CompletedTradeRef): HoldStartBasis => (m.observed ? 'trade' : 'trade_created');

/**
 * Fold one inventory fetch into the tracker. New on-hold copies get a start; copies seen tradable
 * after being on hold produce an observation; copies no longer owned are dropped.
 */
export function updateHoldState(prev: HoldState, inv: HoldInstance[], fetchedAt: number, trades: CompletedTradeRef[], purchases: PurchaseRef[] = []): HoldState {
  const entries: Record<string, HoldEntry> = {};
  const observations = [...prev.observations];
  for (const i of inv) {
    const key = instanceKey(i);
    const e = prev.entries[key];
    if (i.isOnHold) {
      const m = matchTradeStart(i, trades, fetchedAt);
      if (e) {
        // A trade found later (completed list synced after the inventory) beats a first-seen or purchase start;
        // a purchase found later (transactions fetched after the inventory) beats a first-seen start.
        const firstSeen = e.startBasis === 'first_seen';
        const upgrade = m && m.at <= e.firstSeenOnHold && (firstSeen || e.startBasis === 'purchase' || (e.startBasis === 'trade_created' && m.observed));
        const p = !upgrade && firstSeen ? matchPurchaseStart(i.assetId, purchases, e.firstSeenOnHold) : null;
        const { missingSince: _gone, ...rest } = e;
        entries[key] = {
          ...rest, kind: kindOfBasis(e.startBasis), lastSeenOnHold: fetchedAt,
          ...(upgrade ? { holdStart: m.at, startBasis: tradeBasis(m), kind: 'trade' as const, tradeId: m.tradeId } : {}),
          ...(p ? { holdStart: p.at, startBasis: 'purchase' as const, kind: 'purchase' as const } : {}),
        };
      } else {
        const p = m ? null : matchPurchaseStart(i.assetId, purchases, fetchedAt);
        const startBasis: HoldStartBasis = m ? tradeBasis(m) : p ? 'purchase' : 'first_seen';
        entries[key] = {
          key, assetId: i.assetId, serial: i.serialNumber, holdStart: m ? m.at : p ? p.at : fetchedAt, startBasis, kind: kindOfBasis(startBasis),
          tradeId: m ? m.tradeId : null, firstSeenOnHold: fetchedAt, lastSeenOnHold: fetchedAt,
        };
      }
    } else if (e) {
      observations.push({
        assetId: e.assetId, serial: e.serial, holdStart: e.holdStart, startBasis: e.startBasis, kind: kindOfBasis(e.startBasis), lastSeenOnHold: e.lastSeenOnHold,
        liftSeenAt: fetchedAt, durationMs: fetchedAt - e.holdStart, uncertaintyMs: fetchedAt - e.lastSeenOnHold,
      });
    }
  }
  // Absent copies: traded away, or a partial fetch. Keep for a grace period so a transient gap does not
  // reset the start; never record a lift for an absent copy.
  const seen = new Set(inv.map((i) => instanceKey(i)));
  for (const [key, e] of Object.entries(prev.entries)) {
    if (seen.has(key)) continue;
    const since = e.missingSince ?? fetchedAt;
    if (fetchedAt - since < HOLD_MISSING_GRACE_MS) entries[key] = { ...e, missingSince: since };
  }
  return { entries, observations: observations.slice(-HOLD_MAX_OBSERVATIONS) };
}

export interface HoldLength {
  ms: number;
  source: 'assumed' | 'measured';
  /** Observations used: only holds with an exact start (watched trade completion, or purchase time). */
  samples: number;
  label: string;
  kind?: HoldKind;
}

export const DEFAULT_TRADE_HOLD_DAYS = 2;
export const DEFAULT_PURCHASE_HOLD_DAYS = 3;

const KIND_WORD: Record<HoldKind, string> = { trade: 'trade hold', purchase: 'purchase hold', unknown: 'hold (source unknown)' };
export const holdKindLabel = (k: HoldKind | undefined): string => KIND_WORD[k ?? 'unknown'];

/** Observations with an exact start for this kind ('trade': watched completion; 'purchase': purchase time). */
function calibrationSamples(observations: HoldObservation[], kind: 'trade' | 'purchase'): number[] {
  const want: HoldStartBasis = kind === 'trade' ? 'trade' : 'purchase';
  return observations.filter((o) => o.startBasis === want && o.durationMs > 0).map((o) => o.durationMs).sort((a, b) => a - b);
}

/** Length for one kind: its own median once measured, else its assumption. Default kind 'trade' (back-compat). */
export function holdLength(assumedDays: number, observations: HoldObservation[], granularityMs = HOLD_POLL_GRANULARITY_MS, kind: 'trade' | 'purchase' = 'trade'): HoldLength {
  const xs = calibrationSamples(observations, kind);
  const word = kind === 'trade' ? 'trade' : 'purchase';
  if (!xs.length) {
    const fallback = kind === 'trade' ? DEFAULT_TRADE_HOLD_DAYS : DEFAULT_PURCHASE_HOLD_DAYS;
    const days = Number.isFinite(assumedDays) && assumedDays > 0 ? assumedDays : fallback;
    return { ms: Math.round(days * DAY), source: 'assumed', samples: 0, kind, label: `${days} d assumed for ${word} holds (unconfirmed — learns from your items)` };
  }
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  const ms = Math.ceil(median / granularityMs) * granularityMs;
  return { ms, source: 'measured', samples: xs.length, kind, label: `${fmtHoldLeft(ms)} for ${word} holds, measured from ${xs.length} item${xs.length === 1 ? '' : 's'}` };
}

export interface HoldLengths { trade: HoldLength; purchase: HoldLength; unknown: HoldLength }

/** Per-kind lengths. 'unknown' uses the larger of trade/purchase (an item of unknown source may be either). */
export function holdLengths(tradeDays: number, purchaseDays: number, observations: HoldObservation[], granularityMs = HOLD_POLL_GRANULARITY_MS): HoldLengths {
  const trade = holdLength(tradeDays, observations, granularityMs, 'trade');
  const purchase = holdLength(purchaseDays, observations, granularityMs, 'purchase');
  const big = purchase.ms >= trade.ms ? purchase : trade;
  const unknown: HoldLength = { ms: big.ms, source: big.source, samples: big.samples, kind: 'unknown',
    label: `${fmtHoldLeft(big.ms)} for holds of unknown source (larger of the trade and purchase lengths: the ${big.kind} one)` };
  return { trade, purchase, unknown };
}

export const lengthFor = (lens: HoldLengths, e: Pick<HoldEntry, 'startBasis' | 'kind'>): HoldLength => lens[e.kind ?? kindOfBasis(e.startBasis)];

export interface HoldEstimate {
  holdStart: number;
  startBasis: HoldStartBasis;
  kind: HoldKind;
  tradeId: number | null;
  releaseAt: number;
  /** releaseAt - now; <= 0 once overdue. */
  remainingMs: number;
  overdue: boolean;
  lengthMs: number;
  lengthSource: HoldLength['source'];
  lengthSamples: number;
  /** True for 'unknown' kind: the length is the larger of the trade and purchase lengths. */
  lengthIsMax?: boolean;
}

export function estimateHold(e: Pick<HoldEntry, 'holdStart' | 'startBasis' | 'tradeId'> & { kind?: HoldKind }, len: HoldLength | HoldLengths, now: number): HoldEstimate {
  const kind = e.kind ?? kindOfBasis(e.startBasis);
  const L = 'trade' in len ? len[kind] : len;
  const releaseAt = e.holdStart + L.ms;
  return {
    holdStart: e.holdStart, startBasis: e.startBasis, kind, lengthIsMax: kind === 'unknown', tradeId: e.tradeId, releaseAt, remainingMs: releaseAt - now, overdue: releaseAt <= now,
    lengthMs: L.ms, lengthSource: L.source, lengthSamples: L.samples,
  };
}

/** True when some held copy is due within the fast window (or past due by less than a day). */
export function holdNeedsFastRefresh(state: HoldState, len: HoldLength | HoldLengths, now: number): boolean {
  return Object.values(state.entries).some((e) => {
    if (e.missingSince != null) return false;
    const left = e.holdStart + ('trade' in len ? lengthFor(len, e) : len).ms - now;
    return left <= HOLD_FAST_WINDOW_MS && left > -HOLD_FAST_MAX_OVERDUE_MS;
  });
}

/** "1d 4h", "3h 12m", "12m", "<1m". Floors each unit. */
export function fmtHoldLeft(ms: number): string {
  if (ms < MIN) return '<1m';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Badge text: "on hold · ~1d 4h left (est.)" or "on hold · due any time". */
export function holdBadge(e: HoldEstimate | null | undefined, now = Date.now()): string {
  if (!e) return 'on hold';
  const left = e.releaseAt - now;
  const word = holdKindLabel(e.kind ?? kindOfBasis(e.startBasis));
  return left <= 0 ? `${word} · due any time` : `${word} · ~${fmtHoldLeft(left)} left (est.)`;
}

export function holdTooltip(e: HoldEstimate | null | undefined): string {
  if (!e) return 'On hold: cannot be traded until the hold ends (start unknown).';
  const start = new Date(e.holdStart).toLocaleString();
  const basis = e.startBasis === 'trade' ? `completion of trade ${e.tradeId ?? ''} (watched)`
    : e.startBasis === 'trade_created' ? `trade ${e.tradeId ?? ''} creation time (completion not watched; release may be later)`
      : e.startBasis === 'purchase' ? 'purchase time from your Roblox transaction history'
        : 'first time the app saw it on hold (no matching trade or purchase found; actual start may be earlier)';
  const kind = e.kind ?? kindOfBasis(e.startBasis);
  const how = e.lengthSource === 'measured' ? `measured from ${e.lengthSamples} item${e.lengthSamples === 1 ? '' : 's'}` : 'assumed, unconfirmed';
  const len = kind === 'unknown' ? `${fmtHoldLeft(e.lengthMs)} (larger of the trade and purchase lengths; ${how})` : `${fmtHoldLeft(e.lengthMs)} (${how})`;
  const word = holdKindLabel(kind);
  return `${word[0]!.toUpperCase()}${word.slice(1)}. Started ${start} — ${basis}. Length ${len}. Estimated release ${new Date(e.releaseAt).toLocaleString()}. Roblox does not publish hold end times; this is an estimate.`;
}
