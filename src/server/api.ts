/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * REST API contract doc (implemented in src/server/**; consumed by web/).
 * Types: src/core/api-types.ts. Canonical list: API_ROUTES.
 *
 * Bind to 127.0.0.1 only. Serve web/dist statically at "/" in production; Vite proxies /api in dev.
 *
 *  GET    /api/health              -> HealthResponse
 *  GET    /api/header              -> HeaderResponse
 *  GET    /api/trades              ?direction&minScore&hideBots&shape&watchlistOnly&verdict&limit&cursor -> TradesResponse
 *                                    (inbound sorted by score desc; others by created desc)
 *  GET    /api/trades/:id          -> TradeDetailResponse
 *  POST   /api/trades/:id/rescore  -> TradeRow       (LOCAL recompute only)
 *  POST   /api/poll                -> { queued: true }
 *  GET    /api/history             ?limit&cursor -> HistoryResponse
 *  GET    /api/market              -> MarketResponse
 *  GET    /api/items/search        ?q -> ItemSearchResponse
 *  GET    /api/items/:assetId      -> ItemDetailResponse
 *  GET    /api/inventory           -> InventoryResponse
 *  GET    /api/partners/:userId    -> PartnerResponse
 *  GET    /api/settings            -> SettingsResponse
 *  PUT    /api/settings            body SettingsPatch -> SettingsResponse
 *  GET    /api/cookie              -> CookieStatusResponse   (never returns the cookie)
 *  PUT    /api/cookie              body CookiePutBody -> CookieStatusResponse
 *  DELETE /api/cookie              -> CookieStatusResponse
 *  POST   /api/values/csv          text/csv -> { imported: number }
 *
 * There are deliberately NO routes that accept, decline, counter or send a trade.
 */
export { API_ROUTES, ROBLOX_TRADES_URL } from '../core/api-types.js';
export type * from '../core/api-types.js';
