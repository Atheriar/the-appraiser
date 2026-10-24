/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Pure join of v1 + v2 trade detail into one TradeSnapshot.
 *  v1: assetId + userAssetId.  v2: isOnHold, itemTarget, collectibleItemInstanceId.
 * Matching per side: (1) same asset + same serial, (2) same asset in order (non-serialised
 * duplicates), leftovers are kept as v1_only / v2_only.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  ItemTargetType, TradeDirection, TradeItem, TradeSide, TradeSnapshot, TradeStatus, UserId,
} from '../../core/types.js';
import { toMs, type V1DetailSchema, type V2DetailSchema, type V1UserAsset, type V2Item } from './schemas.js';
import { AdapterError } from '../limiter.js';

type V1 = z.infer<typeof V1DetailSchema>;
type V2 = z.infer<typeof V2DetailSchema>;
type V1A = z.infer<typeof V1UserAsset>;
type V2I = z.infer<typeof V2Item>;

/** Legacy reference order: Unknown=1 .. TwoStepVerificationRequired=11. */
export const TRADE_STATUSES: TradeStatus[] = [
  'Unknown', 'Open', 'Pending', 'Completed', 'Expired', 'Declined', 'RejectedDueToError',
  'Countered', 'Processing', 'InterventionRequired', 'TwoStepVerificationRequired',
];

/** Lenient: accepts names (any case/spacing) or 1-based ints; anything else => Unknown. */
export function parseTradeStatus(raw: unknown): TradeStatus {
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
    return TRADE_STATUSES[Number(raw) - 1] ?? 'Unknown';
  }
  if (typeof raw !== 'string') return 'Unknown';
  const k = raw.replace(/[\s_-]/g, '').toLowerCase();
  return TRADE_STATUSES.find((s) => s.toLowerCase() === k) ?? 'Unknown';
}

export function parseItemType(raw: unknown): ItemTargetType {
  if (raw === 2 || (typeof raw === 'string' && raw.toLowerCase() === 'bundle')) return 'Bundle';
  return 'Asset';
}

const ACTIVE: TradeStatus[] = ['Open', 'Pending', 'Processing', 'InterventionRequired', 'TwoStepVerificationRequired'];
export function isActiveStatus(s: TradeStatus): boolean { return ACTIVE.includes(s); }

export function offerSignature(give: TradeSide, get: TradeSide): string {
  const side = (s: TradeSide) => [...s.items.map((i) => i.assetId)].sort((a, b) => a - b).join(',') + `|r${Math.round(s.robux)}`;
  return createHash('sha1').update(`${side(give)}#${side(get)}`).digest('hex').slice(0, 20);
}

function fromV1(a: V1A, joinKey: TradeItem['joinKey']): TradeItem {
  return {
    assetId: a.assetId, itemType: 'Asset', targetId: String(a.assetId), name: a.name ?? `Asset ${a.assetId}`,
    userAssetId: a.id ?? null, collectibleItemInstanceId: null, collectibleItemId: null,
    serialNumber: a.serialNumber || null, rap: a.recentAveragePrice ?? 0, originalPrice: a.originalPrice ?? null,
    assetStock: a.assetStock ?? null, isOnHold: null, joinKey,
  };
}

function fromV2(b: V2I): TradeItem {
  const itemType = parseItemType(b.itemTarget?.itemType);
  const targetId = b.itemTarget?.targetId != null ? String(b.itemTarget.targetId) : '';
  return {
    assetId: itemType === 'Asset' && /^\d+$/.test(targetId) ? Number(targetId) : 0,
    itemType, targetId, name: b.itemName ?? `Item ${targetId}`,
    userAssetId: null, collectibleItemInstanceId: b.collectibleItemInstanceId ?? null,
    collectibleItemId: b.collectibleItemId ?? null, serialNumber: b.serialNumber || null,
    rap: b.recentAveragePrice ?? 0, originalPrice: b.originalPrice ?? null, assetStock: b.assetStock ?? null,
    isOnHold: b.isOnHold ?? null, joinKey: 'v2_only',
  };
}

function merge(a: V1A, b: V2I, joinKey: TradeItem['joinKey']): TradeItem {
  const v2 = fromV2(b);
  const v1 = fromV1(a, joinKey);
  return {
    ...v1,
    itemType: v2.itemType,
    targetId: v2.targetId || v1.targetId,
    collectibleItemInstanceId: v2.collectibleItemInstanceId,
    collectibleItemId: v2.collectibleItemId,
    serialNumber: v1.serialNumber ?? v2.serialNumber,
    rap: v1.rap || v2.rap,
    isOnHold: v2.isOnHold,
    joinKey,
  };
}

/** Join one side's item lists. Exported for tests. */
export function joinItems(v1: V1A[] | null, v2: V2I[] | null): TradeItem[] {
  if (!v1) return (v2 ?? []).map(fromV2);
  if (!v2) return v1.map((a) => fromV1(a, 'v1_only'));
  const out: TradeItem[] = [];
  const pool = v2.map((b, idx) => ({ b, idx, used: false, asset: String(b.itemTarget?.targetId ?? '') }));
  const pending: V1A[] = [];
  for (const a of v1) {
    const serial = a.serialNumber || null;
    const hit = serial != null
      ? pool.find((p) => !p.used && p.asset === String(a.assetId) && (p.b.serialNumber || null) === serial)
      : undefined;
    if (hit) { hit.used = true; out.push(merge(a, hit.b, 'serial+asset')); } else pending.push(a);
  }
  for (const a of pending) {
    const hit = pool.find((p) => !p.used && p.asset === String(a.assetId));
    if (hit) { hit.used = true; out.push(merge(a, hit.b, 'asset+order')); } else out.push(fromV1(a, 'v1_only'));
  }
  for (const p of pool) if (!p.used) out.push(fromV2(p.b));
  return out;
}

export interface JoinInput {
  tradeId: number;
  me: UserId;
  direction: TradeDirection;
  v1: V1 | null;
  v2: V2 | null;
  now: number;
}

export function buildTradeSnapshot({ tradeId, me, direction, v1, v2, now }: JoinInput): TradeSnapshot {
  if (!v1 && !v2) throw new AdapterError(`trade ${tradeId}: neither v1 nor v2 detail available`);
  const v1Offers = v1?.offers ?? [];
  const v1Mine = v1Offers.find((o) => o.user?.id === me) ?? null;
  const v1Theirs = v1Offers.find((o) => o.user?.id !== me && o !== v1Mine) ?? null;

  const v2Offers = [v2?.participantAOffer, v2?.participantBOffer].filter((o): o is NonNullable<typeof o> => !!o);
  const uid = (o: (typeof v2Offers)[number]) => o.user?.id ?? o.userId ?? null;
  let v2Mine = v2Offers.find((o) => uid(o) === me) ?? null;
  let v2Theirs = v2Offers.find((o) => o !== v2Mine) ?? null;
  // If v2 omits user ids, fall back to A = initiator. For inbound trades the partner initiated.
  if (!v2Mine && v2Offers.length === 2) {
    const [a, b] = v2Offers as [typeof v2Offers[0], typeof v2Offers[0]];
    if ((uid(a) != null) !== (uid(b) != null)) {
      // Exactly one side carries an id and it is not me: that side is theirs, the other one is mine.
      if (uid(a) != null) { v2Theirs = a; v2Mine = b; } else { v2Theirs = b; v2Mine = a; }
    } else if (uid(a) == null) {
      if (direction === 'inbound') { v2Theirs = a; v2Mine = b; } else { v2Mine = a; v2Theirs = b; }
    }
  }

  const partnerUser = v1Theirs?.user ?? v2Theirs?.user ?? v1?.user ?? null;
  const partnerId = partnerUser?.id ?? (v2Theirs ? uid(v2Theirs) : null) ?? 0;
  const partner = { userId: partnerId, name: partnerUser?.name ?? '', displayName: partnerUser?.displayName ?? partnerUser?.name ?? '' };
  const meUser = v1Mine?.user ?? v2Mine?.user ?? null;

  const give: TradeSide = {
    userId: me, userName: meUser?.name ?? '', displayName: meUser?.displayName ?? meUser?.name ?? '',
    items: joinItems(v1 ? (v1Mine?.userAssets ?? []) : null, v2 ? (v2Mine?.items ?? []) : null),
    robux: v1Mine?.robux ?? v2Mine?.robux ?? 0,
  };
  const get: TradeSide = {
    userId: partner.userId, userName: partner.name, displayName: partner.displayName,
    items: joinItems(v1 ? (v1Theirs?.userAssets ?? []) : null, v2 ? (v2Theirs?.items ?? []) : null),
    robux: v1Theirs?.robux ?? v2Theirs?.robux ?? 0,
  };
  const statusRaw = String(v1?.status ?? v2?.status ?? '');
  const status = parseTradeStatus(v1?.status ?? v2?.status);
  return {
    tradeId, direction, status, statusRaw,
    isActive: v1?.isActive ?? isActiveStatus(status),
    createdAt: toMs(v1?.created) ?? now,
    expiresAt: toMs(v1?.expiration),
    partner, give, get, fetchedAt: now, hadV1: !!v1, hadV2: !!v2,
    offerSignature: offerSignature(give, get),
  };
}
