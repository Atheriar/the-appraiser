/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type AssetId, type ItemSnapshot, type MarketAnomaly, type ModelAccuracy, type PartnerInfo,
  type ReconstructedSale, type Settings, type TradeDirection, type TradeId, type TradeMetadata,
  type TradeOutcome, type ItemValueMark, type DropItem, type TradeScore, type TradeSnapshot, type TradeStatus, type UserId,
} from '../core/types.js';
import type { ItemRecord, Repository } from './interfaces.js';
import { MIGRATIONS } from './migrations.js';
import { deepMerge } from './merge.js';

type Row = Record<string, unknown>;
const j = <T>(s: unknown): T => JSON.parse(String(s)) as T;

/** better-sqlite3 implementation of Repository. Pass ':memory:' for tests. */
export class SqliteRepository implements Repository {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT id FROM schema_migrations').all() as Row[]).map((r) => Number(r.id)));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
      })();
    }
  }

  close(): void { this.db.close(); }

  // ---------------- items
  upsertItem(item: ItemRecord): void {
    // collectibleItemId is cached forever: never overwrite a known id with null.
    this.db.prepare(`INSERT INTO items (asset_id, name, collectible_item_id, item_type, is_limited_u, thumbnail_url, catalog_fetched_at, total_quantity, creator_name, created_at)
      VALUES (@assetId, @name, @cid, @itemType, @lu, @thumb, @fetched, @tq, @creator, @created)
      ON CONFLICT(asset_id) DO UPDATE SET
        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE items.name END,
        collectible_item_id = COALESCE(items.collectible_item_id, excluded.collectible_item_id),
        item_type = excluded.item_type,
        is_limited_u = COALESCE(excluded.is_limited_u, items.is_limited_u),
        thumbnail_url = COALESCE(excluded.thumbnail_url, items.thumbnail_url),
        catalog_fetched_at = COALESCE(excluded.catalog_fetched_at, items.catalog_fetched_at),
        total_quantity = COALESCE(excluded.total_quantity, items.total_quantity),
        creator_name = COALESCE(excluded.creator_name, items.creator_name),
        created_at = COALESCE(excluded.created_at, items.created_at)`).run({
      assetId: item.assetId, name: item.name, cid: item.collectibleItemId, itemType: item.itemType,
      lu: item.isLimitedU == null ? null : item.isLimitedU ? 1 : 0, thumb: item.thumbnailUrl, fetched: item.catalogFetchedAt,
      tq: item.totalQuantity ?? null, creator: item.creatorName ?? null, created: item.createdAt ?? null,
    });
  }

  private rowToItem(r: Row): ItemRecord {
    return {
      assetId: Number(r.asset_id), name: String(r.name), collectibleItemId: (r.collectible_item_id as string | null) ?? null,
      itemType: r.item_type === 'Bundle' ? 'Bundle' : 'Asset',
      isLimitedU: r.is_limited_u == null ? null : Number(r.is_limited_u) === 1,
      thumbnailUrl: (r.thumbnail_url as string | null) ?? null,
      catalogFetchedAt: r.catalog_fetched_at == null ? null : Number(r.catalog_fetched_at),
      totalQuantity: r.total_quantity == null ? null : Number(r.total_quantity),
      creatorName: (r.creator_name as string | null) ?? null,
      createdAt: r.created_at == null ? null : Number(r.created_at),
    };
  }

  getItem(assetId: AssetId): ItemRecord | null {
    const r = this.db.prepare('SELECT * FROM items WHERE asset_id = ?').get(assetId) as Row | undefined;
    return r ? this.rowToItem(r) : null;
  }

  getItems(assetIds: AssetId[]): Map<AssetId, ItemRecord> {
    const out = new Map<AssetId, ItemRecord>();
    const stmt = this.db.prepare('SELECT * FROM items WHERE asset_id = ?');
    for (const id of new Set(assetIds)) {
      const r = stmt.get(id) as Row | undefined;
      if (r) out.set(id, this.rowToItem(r));
    }
    return out;
  }

  insertItemSnapshot(s: ItemSnapshot): void {
    this.db.prepare(`INSERT INTO item_snapshots (asset_id, t, rap, roli_value, floor_price, demand, trend, projected, json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      s.assetId, s.fetchedAt, s.rap, s.roliValue, s.floorPrice, s.roliDemand, s.roliTrend,
      s.roliProjected == null ? null : s.roliProjected ? 1 : 0, JSON.stringify({ ...s, lastSales: [] })); // sales live in the sales table; don't repeat them per row
  }

  latestItemSnapshot(assetId: AssetId): ItemSnapshot | null {
    const r = this.db.prepare('SELECT json FROM item_snapshots WHERE asset_id = ? ORDER BY t DESC, id DESC LIMIT 1').get(assetId) as Row | undefined;
    return r ? j<ItemSnapshot>(r.json) : null;
  }

  latestItemSnapshots(assetIds: AssetId[]): Map<AssetId, ItemSnapshot> {
    const out = new Map<AssetId, ItemSnapshot>();
    for (const id of new Set(assetIds)) {
      const s = this.latestItemSnapshot(id);
      if (s) out.set(id, s);
    }
    return out;
  }

  /** Latest snapshot taken at or before `t` (for "value at time" / movers). */
  itemSnapshotAtOrBefore(assetId: AssetId, t: number): ItemSnapshot | null {
    const r = this.db.prepare('SELECT json FROM item_snapshots WHERE asset_id = ? AND t <= ? ORDER BY t DESC, id DESC LIMIT 1').get(assetId, t) as Row | undefined;
    return r ? j<ItemSnapshot>(r.json) : null;
  }

  itemSnapshotHistory(assetId: AssetId, sinceMs: number): ItemSnapshot[] {
    return (this.db.prepare('SELECT json FROM item_snapshots WHERE asset_id = ? AND t >= ? ORDER BY t ASC').all(assetId, sinceMs) as Row[])
      .map((r) => j<ItemSnapshot>(r.json));
  }

  /** Light history for charts without parsing full JSON. */
  itemSnapshotSeries(assetId: AssetId, sinceMs: number): Array<{ t: number; rap: number; roliValue: number | null; floorPrice: number | null }> {
    return (this.db.prepare('SELECT t, rap, roli_value, floor_price FROM item_snapshots WHERE asset_id = ? AND t >= ? ORDER BY t ASC').all(assetId, sinceMs) as Row[])
      .map((r) => ({ t: Number(r.t), rap: Number(r.rap ?? 0), roliValue: r.roli_value == null ? null : Number(r.roli_value), floorPrice: r.floor_price == null ? null : Number(r.floor_price) }));
  }

  prune(now: number): { snapshots: number; sales: number; resellers: number } {
    const DAY = 86_400_000;
    let snapshots = 0; let sales = 0; let resellers = 0;
    this.db.transaction(() => {
      // Keep every snapshot from the last 7 days; older ones thinned to the newest per item per UTC day.
      snapshots = this.db.prepare(`DELETE FROM item_snapshots WHERE t < ? AND id NOT IN (
          SELECT MAX(id) FROM item_snapshots WHERE t < ? GROUP BY asset_id, t / ${DAY})`).run(now - 7 * DAY, now - 7 * DAY).changes;
      sales = this.db.prepare('DELETE FROM sales WHERE t < ?').run(now - 90 * DAY).changes;
      resellers = this.db.prepare('DELETE FROM resellers_snapshots WHERE t < ?').run(now - 7 * DAY).changes;
    })();
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    return { snapshots, sales, resellers };
  }

  // ---------------- drops (new limited releases)
  upsertDrop(d: DropItem): void {
    this.db.prepare(`INSERT INTO drops (key, asset_id, created_at, first_seen_at, json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`)
      .run(d.key, d.assetId, d.createdAt, d.firstSeenAt, JSON.stringify(d));
  }

  getDrop(key: string): DropItem | null {
    const r = this.db.prepare('SELECT json FROM drops WHERE key = ?').get(key) as Row | undefined;
    return r ? j<DropItem>(r.json) : null;
  }

  /** Newest first by created time (first-seen when Roblox gave none). */
  listDrops(q: { sinceMs?: number; limit: number }): DropItem[] {
    const rows = this.db.prepare(`SELECT json FROM drops WHERE COALESCE(created_at, first_seen_at) >= ?
      ORDER BY COALESCE(created_at, first_seen_at) DESC LIMIT ?`).all(q.sinceMs ?? 0, q.limit) as Row[];
    return rows.map((r) => j<DropItem>(r.json));
  }

  /** Drops with a scheduled release at or after `sinceMs` (announced timed releases may be older than the window). */
  listDropsWithRelease(sinceMs: number): DropItem[] {
    const rows = this.db.prepare(`SELECT json FROM drops WHERE json_extract(json, '$.releaseAt') >= ? LIMIT 500`).all(sinceMs) as Row[];
    return rows.map((r) => j<DropItem>(r.json));
  }

  /** Any stored drop for this asset/bundle (either key form). */
  findDropByAsset(itemType: string, assetId: number): DropItem | null {
    const rows = this.db.prepare('SELECT json FROM drops WHERE asset_id = ?').all(assetId) as Row[];
    return rows.map((r) => j<DropItem>(r.json)).find((d) => d.itemType === itemType) ?? null;
  }

  deleteDrop(key: string): void {
    this.db.prepare('DELETE FROM drops WHERE key = ?').run(key);
  }

  countDrops(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM drops').get() as Row).n);
  }

  pruneDrops(beforeMs: number): number {
    return this.db.prepare(`DELETE FROM drops WHERE COALESCE(created_at, first_seen_at) < ?
      AND COALESCE(json_extract(json, '$.releaseAt'), 0) < ?`).run(beforeMs, beforeMs).changes;
  }

  countItemSnapshots(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM item_snapshots').get() as Row).n);
  }

  insertResellersSnapshot(assetId: AssetId, t: number, floor: number | null, count: number | null, capped: boolean, rows: unknown): void {
    this.db.prepare('INSERT INTO resellers_snapshots (asset_id, t, floor_price, reseller_count, capped, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(assetId, t, floor, count, capped ? 1 : 0, JSON.stringify(rows));
  }

  // ---------------- sales
  insertSales(sales: ReconstructedSale[]): number {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO sales (asset_id, t, price, old_rap, new_rap, source, sale_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    // The same sale can arrive from the Rolimons feed and from the RAP-snapshot delta reconstruction:
    // match on (asset, price, old_rap, new_rap) within +-10 min and keep the feed row only.
    const W = 10 * 60_000;
    const dup = this.db.prepare(`SELECT rowid AS rid FROM sales WHERE asset_id = ? AND price = ? AND old_rap = ? AND new_rap = ?
      AND source = ? AND t BETWEEN ? AND ? LIMIT 1`);
    const del = this.db.prepare('DELETE FROM sales WHERE rowid = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const s of sales) {
        const other = s.source === 'rap_snapshot_delta' ? 'rolimons_feed' : 'rap_snapshot_delta';
        const hit = dup.get(s.assetId, s.price, s.oldRap, s.newRap, other, s.t - W, s.t + W) as { rid: number } | undefined;
        if (hit) {
          if (s.source === 'rap_snapshot_delta') continue;
          del.run(hit.rid);
        }
        const key = s.saleId ? `id:${s.saleId}` : `k:${s.assetId}:${s.t}:${s.price}`;
        n += stmt.run(s.assetId, s.t, s.price, s.oldRap, s.newRap, s.source, s.saleId ?? null, key).changes;
      }
    })();
    return n;
  }

  salesFor(assetId: AssetId, sinceMs: number): ReconstructedSale[] {
    return (this.db.prepare('SELECT * FROM sales WHERE asset_id = ? AND t >= ? ORDER BY t DESC').all(assetId, sinceMs) as Row[]).map((r) => {
      const s: ReconstructedSale = {
        assetId: Number(r.asset_id), t: Number(r.t), price: Number(r.price), oldRap: Number(r.old_rap), newRap: Number(r.new_rap),
        source: r.source === 'rap_snapshot_delta' ? 'rap_snapshot_delta' : 'rolimons_feed',
      };
      if (r.sale_id != null) s.saleId = String(r.sale_id);
      return s;
    });
  }

  // ---------------- trades
  upsertTrade(t: TradeSnapshot): void {
    const now = Date.now();
    this.db.transaction(() => {
      const prev = this.db.prepare('SELECT status_raw, is_active FROM trades WHERE trade_id = ?').get(t.tradeId) as Row | undefined;
      this.db.prepare(`INSERT INTO trades (trade_id, direction, status, status_raw, is_active, created_at, partner_id, offer_signature, fetched_at, updated_at, json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trade_id) DO UPDATE SET direction = excluded.direction, status = excluded.status, status_raw = excluded.status_raw,
          is_active = excluded.is_active, created_at = excluded.created_at, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at, json = excluded.json`)
        .run(t.tradeId, t.direction, t.status, t.statusRaw, t.isActive ? 1 : 0, t.createdAt, t.partner.userId, t.offerSignature, t.fetchedAt, now, JSON.stringify(t));
      if (!prev || prev.status_raw !== t.statusRaw || Number(prev.is_active) !== (t.isActive ? 1 : 0)) {
        this.db.prepare('INSERT INTO trade_status_history (trade_id, status, status_raw, is_active, at) VALUES (?, ?, ?, ?, ?)')
          .run(t.tradeId, t.status, t.statusRaw, t.isActive ? 1 : 0, t.fetchedAt);
      }
      this.db.prepare('DELETE FROM trade_items WHERE trade_id = ?').run(t.tradeId);
      const ins = this.db.prepare(`INSERT INTO trade_items (trade_id, side, idx, asset_id, serial_number, user_asset_id, rap, is_on_hold, join_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [side, items] of [['give', t.give.items], ['get', t.get.items]] as const) {
        items.forEach((it, idx) => ins.run(t.tradeId, side, idx, it.assetId, it.serialNumber, it.userAssetId, it.rap,
          it.isOnHold == null ? null : it.isOnHold ? 1 : 0, it.joinKey));
      }
      // Only inbound offers count toward the bot pattern; first sighting time is kept.
      if (t.direction === 'inbound') {
        this.db.prepare('INSERT OR IGNORE INTO offer_signatures (trade_id, signature, partner_id, seen_at) VALUES (?, ?, ?, ?)')
          .run(t.tradeId, t.offerSignature, t.partner.userId, t.createdAt || t.fetchedAt);
      }
    })();
  }

  getTrade(id: TradeId): TradeSnapshot | null {
    const r = this.db.prepare('SELECT json FROM trades WHERE trade_id = ?').get(id) as Row | undefined;
    return r ? j<TradeSnapshot>(r.json) : null;
  }

  private directionWhere(d: TradeDirection | undefined): string {
    switch (d) {
      case 'inbound': return "direction = 'inbound' AND is_active = 1";
      case 'completed': return "(status = 'Completed' OR direction = 'completed')";
      case 'inactive': return "(direction = 'inactive' OR is_active = 0) AND status <> 'Completed' AND direction <> 'completed'";
      default: return '1 = 1';
    }
  }

  listTrades(q: { direction?: TradeDirection; statuses?: TradeStatus[]; limit: number; offset: number }): TradeSnapshot[] {
    const params: unknown[] = [];
    let where = this.directionWhere(q.direction);
    if (q.statuses?.length) {
      where += ` AND status IN (${q.statuses.map(() => '?').join(',')})`;
      params.push(...q.statuses);
    }
    params.push(q.limit, q.offset);
    return (this.db.prepare(`SELECT json FROM trades WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as Row[])
      .map((r) => j<TradeSnapshot>(r.json));
  }

  /** Decided trades (not active), newest decision first. */
  listDecided(limit: number, offset: number): TradeSnapshot[] {
    return (this.db.prepare('SELECT json FROM trades WHERE is_active = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset) as Row[])
      .map((r) => j<TradeSnapshot>(r.json));
  }

  countTrades(direction?: TradeDirection): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ${this.directionWhere(direction)}`).get() as Row).n);
  }

  knownTradeIds(direction: TradeDirection): Set<TradeId> {
    return new Set((this.db.prepare('SELECT trade_id FROM trades WHERE direction = ?').all(direction) as Row[]).map((r) => Number(r.trade_id)));
  }

  activeTradeIds(direction?: TradeDirection): TradeId[] {
    const rows = direction
      ? this.db.prepare('SELECT trade_id FROM trades WHERE is_active = 1 AND direction = ?').all(direction)
      : this.db.prepare('SELECT trade_id FROM trades WHERE is_active = 1').all();
    return (rows as Row[]).map((r) => Number(r.trade_id));
  }

  updateTradeStatus(id: TradeId, status: TradeStatus, statusRaw: string, isActive: boolean, at: number): void {
    const t = this.getTrade(id);
    if (!t) return;
    if (t.statusRaw === statusRaw && t.isActive === isActive) return;
    const next: TradeSnapshot = { ...t, status, statusRaw, isActive, fetchedAt: at };
    this.db.transaction(() => {
      this.db.prepare('UPDATE trades SET status = ?, status_raw = ?, is_active = ?, updated_at = ?, json = ? WHERE trade_id = ?')
        .run(status, statusRaw, isActive ? 1 : 0, at, JSON.stringify(next), id);
      this.db.prepare('INSERT INTO trade_status_history (trade_id, status, status_raw, is_active, at) VALUES (?, ?, ?, ?, ?)')
        .run(id, status, statusRaw, isActive ? 1 : 0, at);
    })();
  }

  statusHistory(id: TradeId): Array<{ status: TradeStatus; statusRaw: string; isActive: boolean; at: number }> {
    return (this.db.prepare('SELECT * FROM trade_status_history WHERE trade_id = ? ORDER BY id').all(id) as Row[]).map((r) => ({
      status: r.status as TradeStatus, statusRaw: String(r.status_raw), isActive: Number(r.is_active) === 1, at: Number(r.at),
    }));
  }

  /** When the trade first left the active state (outcome timing). */
  decidedAt(id: TradeId): number | null {
    const r = this.db.prepare('SELECT MIN(at) AS at FROM trade_status_history WHERE trade_id = ? AND is_active = 0').get(id) as Row;
    return r.at == null ? null : Number(r.at);
  }

  // ---------------- scores
  insertScore(s: TradeScore): void {
    this.db.prepare('INSERT INTO trade_scores (trade_id, score, verdict, model_version, scored_at, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.tradeId, s.score, s.verdict, s.modelVersion, s.scoredAt, JSON.stringify(s));
  }

  latestScore(id: TradeId): TradeScore | null {
    const r = this.db.prepare('SELECT json FROM trade_scores WHERE trade_id = ? ORDER BY id DESC LIMIT 1').get(id) as Row | undefined;
    return r ? j<TradeScore>(r.json) : null;
  }

  /** Last score recorded at or before `at` (score at decision time). */
  scoreAtOrBefore(id: TradeId, at: number): TradeScore | null {
    const r = this.db.prepare('SELECT json FROM trade_scores WHERE trade_id = ? AND scored_at <= ? ORDER BY id DESC LIMIT 1').get(id, at) as Row | undefined;
    return r ? j<TradeScore>(r.json) : null;
  }

  scoreHistory(id: TradeId): Array<Pick<TradeScore, 'score' | 'verdict' | 'scoredAt'>> {
    return (this.db.prepare('SELECT score, verdict, scored_at FROM trade_scores WHERE trade_id = ? ORDER BY id').all(id) as Row[])
      .map((r) => ({ score: Number(r.score), verdict: r.verdict as TradeScore['verdict'], scoredAt: Number(r.scored_at) }));
  }

  markNotified(id: TradeId, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO notifications (trade_id, at) VALUES (?, ?)').run(id, at);
  }

  wasNotified(id: TradeId): boolean {
    return !!this.db.prepare('SELECT 1 FROM notifications WHERE trade_id = ?').get(id);
  }

  // ---------------- bot pattern
  countOfferSignature(signature: string, sinceMs: number): { count: number; accounts: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT partner_id) AS a FROM offer_signatures WHERE signature = ? AND seen_at >= ?')
      .get(signature, sinceMs) as Row;
    return { count: Number(r.c), accounts: Number(r.a) };
  }

  // ---------------- partners
  upsertPartner(p: PartnerInfo): void {
    this.db.prepare(`INSERT INTO partners (user_id, fetched_at, json) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json`).run(p.userId, p.fetchedAt, JSON.stringify(p));
  }

  getPartner(userId: UserId): PartnerInfo | null {
    const r = this.db.prepare('SELECT json FROM partners WHERE user_id = ?').get(userId) as Row | undefined;
    return r ? j<PartnerInfo>(r.json) : null;
  }

  priorTradesWith(userId: UserId): PartnerInfo['priorTrades'] {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM trades WHERE partner_id = ? GROUP BY status').all(userId) as Row[];
    const by = new Map(rows.map((r) => [String(r.status), Number(r.n)]));
    return { completed: by.get('Completed') ?? 0, declined: by.get('Declined') ?? 0, countered: by.get('Countered') ?? 0 };
  }

  // ---------------- settings / kv
  getSettings(): Settings {
    const r = this.db.prepare('SELECT json FROM user_settings WHERE id = 1').get() as Row | undefined;
    const base = structuredClone(DEFAULT_SETTINGS);
    if (!r) return base;
    try { return deepMerge(base, JSON.parse(String(r.json))); } catch { return base; }
  }

  saveSettings(s: Settings): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO user_settings (id, json, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(JSON.stringify(s), Date.now());
      this.db.prepare('DELETE FROM watchlist').run();
      const ins = this.db.prepare('INSERT OR IGNORE INTO watchlist (asset_id, kind) VALUES (?, ?)');
      for (const id of s.watchlist) ins.run(id, 'watch');
      for (const id of s.wishlist) ins.run(id, 'wish');
      for (const id of s.holdList) ins.run(id, 'hold');
    })();
  }

  getKv<T>(key: string): T | null {
    const r = this.db.prepare('SELECT json FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? j<T>(r.json) : null;
  }

  setKv<T>(key: string, value: T): void {
    this.db.prepare(`INSERT INTO kv (key, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), Date.now());
  }

  getTradeMetadata(): TradeMetadata | null { return this.getKv<TradeMetadata>('tradeMetadata'); }
  setTradeMetadata(m: TradeMetadata): void { this.setKv('tradeMetadata', m); }

  // ---------------- learning
  upsertOutcome(o: TradeOutcome): void {
    this.db.prepare(`INSERT INTO outcomes (trade_id, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(trade_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(o.tradeId, JSON.stringify(o), Date.now());
  }

  outcomes(sinceMs: number): TradeOutcome[] {
    return (this.db.prepare('SELECT json FROM outcomes WHERE updated_at >= ?').all(sinceMs) as Row[]).map((r) => j<TradeOutcome>(r.json));
  }

  getOutcome(id: TradeId): TradeOutcome | null {
    const r = this.db.prepare('SELECT json FROM outcomes WHERE trade_id = ?').get(id) as Row | undefined;
    return r ? j<TradeOutcome>(r.json) : null;
  }

  insertModelRun(a: ModelAccuracy): void {
    this.db.prepare('INSERT INTO model_runs (computed_at, json) VALUES (?, ?)').run(a.computedAt, JSON.stringify(a));
  }

  latestModelRun(): ModelAccuracy | null {
    const r = this.db.prepare('SELECT json FROM model_runs ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? j<ModelAccuracy>(r.json) : null;
  }

  // ---------------- item value marks (learning: tradeValue at decision, +7d, +30d)
  /** Insert a mark; existing rows keep value0 and only fill missing 7d/30d values. */
  upsertValueMark(m: ItemValueMark): void {
    this.db.prepare(`INSERT INTO item_value_marks (trade_id, side, asset_id, final_status, decided_at, value0, value7d, value30d, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_id, side, asset_id) DO UPDATE SET final_status = excluded.final_status,
        value7d = COALESCE(item_value_marks.value7d, excluded.value7d),
        value30d = COALESCE(item_value_marks.value30d, excluded.value30d), updated_at = excluded.updated_at`)
      .run(m.tradeId, m.side, m.assetId, m.finalStatus, m.decidedAt, m.value0, m.value7d, m.value30d, Date.now());
  }

  valueMarks(q: { tradeId?: TradeId; pendingOnly?: boolean } = {}): ItemValueMark[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.tradeId != null) { where.push('trade_id = ?'); args.push(q.tradeId); }
    if (q.pendingOnly) where.push('value30d IS NULL');
    const rows = this.db.prepare(`SELECT * FROM item_value_marks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY decided_at`).all(...args) as Row[];
    return rows.map((r) => ({
      tradeId: Number(r.trade_id), side: r.side as 'give' | 'get', assetId: Number(r.asset_id), finalStatus: r.final_status as TradeStatus,
      decidedAt: Number(r.decided_at), value0: Number(r.value0),
      value7d: r.value7d == null ? null : Number(r.value7d), value30d: r.value30d == null ? null : Number(r.value30d),
    }));
  }

  // ---------------- market feed
  insertAnomaly(a: MarketAnomaly): void {
    this.db.prepare('INSERT OR IGNORE INTO anomalies (id, asset_id, at, json) VALUES (?, ?, ?, ?)').run(a.id, a.assetId, a.at, JSON.stringify(a));
  }

  recentAnomalies(limit: number): MarketAnomaly[] {
    return (this.db.prepare('SELECT json FROM anomalies ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((r) => j<MarketAnomaly>(r.json));
  }
}
