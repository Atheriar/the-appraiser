/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Typed client for the local REST API (src/core/api-types.ts). Read-only w.r.t. Roblox trades.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiError, CookieStatusResponse, DropsResponse, HeaderResponse, HealthResponse, HistoryResponse,
  InventoryResponse, ItemDetailResponse, MyTradesResponse, ItemSearchResponse, MarketResponse, SettingsPatch,
  SettingsResponse, TradeDetailResponse, TradeRow, TradesQuery, TradesResponse,
} from '@shared/api-types';
import type { ModelAccuracy } from '@shared/types';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = contentType;
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    throw new HttpError(res.status, err.error ?? `${res.status} ${res.statusText}`, err.code);
  }
  return data as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => req<HealthResponse>('GET', '/api/health'),
  header: () => req<HeaderResponse>('GET', '/api/header'),
  trades: (q: TradesQuery) => req<TradesResponse>('GET', `/api/trades${qs({ ...q })}`),
  trade: (id: number) => req<TradeDetailResponse>('GET', `/api/trades/${id}`),
  rescore: (id: number) => req<TradeRow>('POST', `/api/trades/${id}/rescore`),
  poll: () => req<{ queued: true }>('POST', '/api/poll'),
  history: (limit = 200) => req<HistoryResponse>('GET', `/api/history${qs({ limit })}`),
  myTrades: (q: MyTradesQuery) => req<MyTradesResponse>('GET', `/api/my-trades${qs({ ...q })}`),
  learning: () => req<{ accuracy: ModelAccuracy | null }>('GET', '/api/learning'),
  runLearning: () => req<{ accuracy: ModelAccuracy | null }>('POST', '/api/learning/run'),
  market: () => req<MarketResponse>('GET', '/api/market'),
  itemSearch: (q: string) => req<ItemSearchResponse>('GET', `/api/items/search${qs({ q })}`),
  item: (assetId: number) => req<ItemDetailResponse>('GET', `/api/items/${assetId}`),
  inventory: () => req<InventoryResponse>('GET', '/api/inventory'),
  drops: () => req<DropsResponse>('GET', '/api/drops'),
  lookupCreator: (query: string, type: 'User' | 'Group') =>
    req<{ creator: { id: number; type: 'User' | 'Group'; name: string } | null }>('POST', '/api/drops/creators/lookup', { query, type }),
  refreshInventory: () => req<{ queued: boolean; retryAt: number | null }>('POST', '/api/inventory/refresh'),
  settings: () => req<SettingsResponse>('GET', '/api/settings'),
  putSettings: (patch: SettingsPatch) => req<SettingsResponse>('PUT', '/api/settings', patch),
  cookie: () => req<CookieStatusResponse>('GET', '/api/cookie'),
  putCookie: (cookie: string) => req<CookieStatusResponse>('PUT', '/api/cookie', { cookie }),
  deleteCookie: () => req<CookieStatusResponse>('DELETE', '/api/cookie'),
  importCsv: (csv: string) => req<{ imported: number }>('POST', '/api/values/csv', csv, 'text/csv'),
};

export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });
export const useHeader = () => useQuery({ queryKey: ['header'], queryFn: api.header, refetchInterval: 15_000 });
export const useTrades = (q: TradesQuery) =>
  useQuery({ queryKey: ['trades', q], queryFn: () => api.trades(q), refetchInterval: 8_000 });
export const useTrade = (id: number | null) =>
  useQuery({ queryKey: ['trade', id], queryFn: () => api.trade(id!), enabled: id !== null });
export const useHistory = () => useQuery({ queryKey: ['history'], queryFn: () => api.history(), refetchInterval: 60_000 });
export interface MyTradesQuery { status?: 'all' | 'won' | 'lost'; page?: number; pageSize?: 25 | 50 | 100; q?: string; from?: string; to?: string }
export const useMyTrades = (q: MyTradesQuery) =>
  useQuery({ queryKey: ['myTrades', q], queryFn: () => api.myTrades(q), refetchInterval: 120_000, placeholderData: keepPreviousData });
export const useLearning = () => useQuery({ queryKey: ['learning'], queryFn: api.learning, refetchInterval: 300_000 });
export function useRunLearning() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.runLearning, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['learning'] }); void qc.invalidateQueries({ queryKey: ['history'] }); } });
}
export const useMarket = () => useQuery({ queryKey: ['market'], queryFn: api.market, refetchInterval: 30_000 });
export const useInventory = () =>
  useQuery({ queryKey: ['inventory'], queryFn: api.inventory, refetchInterval: (q) => (q.state.data && q.state.data.state !== 'loading' && !q.state.data.refreshing ? 60_000 : 3_000) });
/** Live drops feed: local poll every 2 s while the tab is visible (the server checks Roblox every ~10 s). */
export const useDrops = () => useQuery({ queryKey: ['drops'], queryFn: api.drops, refetchInterval: 2_000 });
export function useRefreshInventory() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.refreshInventory, onSettled: () => { void qc.invalidateQueries({ queryKey: ['inventory'] }); void qc.invalidateQueries({ queryKey: ['header'] }); } });
}
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings });
export const useCookie = () => useQuery({ queryKey: ['cookie'], queryFn: api.cookie });
export const useItemSearch = (q: string) =>
  useQuery({ queryKey: ['itemSearch', q], queryFn: () => api.itemSearch(q), enabled: q.trim().length >= 2, staleTime: 60_000 });

export function useRescore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.rescore,
    onSuccess: (_r, id) => { void qc.invalidateQueries({ queryKey: ['trades'] }); void qc.invalidateQueries({ queryKey: ['trade', id] }); },
  });
}
export function usePoll() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.poll, onSuccess: () => setTimeout(() => void qc.invalidateQueries(), 3000) });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.putSettings,
    onSuccess: (r) => { qc.setQueryData(['settings'], r); void qc.invalidateQueries({ queryKey: ['trades'] }); },
  });
}
export function useCookieMutations() {
  const qc = useQueryClient();
  const done = (r: CookieStatusResponse) => {
    qc.setQueryData(['cookie'], r);
    void qc.invalidateQueries({ queryKey: ['health'] });
    void qc.invalidateQueries({ queryKey: ['header'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    // can-trade + inventory are fetched right after a cookie save; pick them up quickly.
    setTimeout(() => { void qc.invalidateQueries({ queryKey: ['header'] }); void qc.invalidateQueries({ queryKey: ['inventory'] }); }, 4000);
  };
  return {
    put: useMutation({ mutationFn: api.putCookie, onSuccess: done }),
    del: useMutation({ mutationFn: api.deleteCookie, onSuccess: done }),
  };
}
export const useQueryItem = (assetId: number) =>
  useQuery({ queryKey: ['item', assetId], queryFn: () => api.item(assetId), staleTime: 30_000 });
