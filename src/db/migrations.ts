/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Plain-SQL migrations. Append new entries; never edit an applied one. */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE items (
  asset_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  collectible_item_id TEXT,
  item_type TEXT NOT NULL DEFAULT 'Asset',
  is_limited_u INTEGER,
  thumbnail_url TEXT,
  catalog_fetched_at INTEGER
);
CREATE TABLE item_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  rap REAL, roli_value REAL, floor_price REAL, demand INTEGER, trend INTEGER, projected INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX ix_item_snapshots_asset_t ON item_snapshots(asset_id, t);
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  price REAL NOT NULL,
  old_rap REAL NOT NULL,
  new_rap REAL NOT NULL,
  source TEXT NOT NULL,
  sale_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX ix_sales_asset_t ON sales(asset_id, t);
CREATE TABLE resellers_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  floor_price REAL,
  reseller_count INTEGER,
  capped INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX ix_resellers_asset_t ON resellers_snapshots(asset_id, t);
CREATE TABLE trades (
  trade_id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  status_raw TEXT NOT NULL,
  is_active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,
  offer_signature TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX ix_trades_dir ON trades(direction, is_active, created_at);
CREATE INDEX ix_trades_partner ON trades(partner_id);
CREATE TABLE trade_items (
  trade_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  idx INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  serial_number INTEGER,
  user_asset_id INTEGER,
  rap REAL,
  is_on_hold INTEGER,
  join_key TEXT,
  PRIMARY KEY (trade_id, side, idx)
);
CREATE INDEX ix_trade_items_asset ON trade_items(asset_id);
CREATE TABLE trade_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_raw TEXT NOT NULL,
  is_active INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX ix_tsh_trade ON trade_status_history(trade_id);
CREATE TABLE trade_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  score REAL NOT NULL,
  verdict TEXT NOT NULL,
  model_version TEXT NOT NULL,
  scored_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX ix_scores_trade ON trade_scores(trade_id, id);
CREATE TABLE notifications (trade_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE offer_signatures (
  trade_id INTEGER PRIMARY KEY,
  signature TEXT NOT NULL,
  partner_id INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX ix_sig ON offer_signatures(signature, seen_at);
CREATE TABLE partners (user_id INTEGER PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE user_settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE watchlist (asset_id INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (asset_id, kind));
CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE outcomes (trade_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE model_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, computed_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE anomalies (id TEXT PRIMARY KEY, asset_id INTEGER NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX ix_anomalies_at ON anomalies(at);
`,
  },
  {
    id: 2,
    name: 'learning_value_marks',
    sql: `
CREATE TABLE item_value_marks (
  trade_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  asset_id INTEGER NOT NULL,
  final_status TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  value0 REAL NOT NULL,
  value7d REAL,
  value30d REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trade_id, side, asset_id)
);
CREATE INDEX ix_value_marks_decided ON item_value_marks(decided_at);
CREATE INDEX ix_anomalies_asset ON anomalies(asset_id, at);
`,
  },
  {
    id: 3,
    name: 'catalog_static_fields_and_drops',
    sql: `
ALTER TABLE items ADD COLUMN total_quantity INTEGER;
ALTER TABLE items ADD COLUMN creator_name TEXT;
-- Re-fetch catalog details once so total_quantity (copies -> rarity) fills in for items cached before this column.
UPDATE items SET catalog_fetched_at = NULL;
CREATE TABLE drops (
  key TEXT PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  created_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX ix_drops_seen ON drops(first_seen_at);
CREATE INDEX ix_drops_created ON drops(created_at);
`,
  },
  {
    id: 4,
    name: 'item_created_at',
    sql: `
ALTER TABLE items ADD COLUMN created_at INTEGER;
-- Re-fetch catalog details once so created_at (new-release / thin-history risk) fills in.
UPDATE items SET catalog_fetched_at = NULL;
`,
  },
];
