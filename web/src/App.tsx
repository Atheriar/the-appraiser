/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { TradesPage } from './pages/TradesPage';
import { HistoryPage } from './pages/HistoryPage';
import { MarketPage } from './pages/MarketPage';
import { InventoryPage } from './pages/InventoryPage';
import { MyTradesPage } from './pages/MyTradesPage';
import { DropsPage } from './pages/DropsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useInboundAlerts } from './lib/inboundAlerts';

const TABS = ['inbound', 'inventory', 'my-trades', 'drops', 'history', 'market', 'settings'] as const;
type Tab = (typeof TABS)[number];

function readTab(): Tab {
  const h = window.location.hash.replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'inbound';
}

export function App() {
  const [tab, setTab] = useState<Tab>(readTab);
  const inboundCount = useInboundAlerts();
  useEffect(() => {
    const on = () => setTab(readTab());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200">
      <Header />
      <nav className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-neutral-800 px-4 [scrollbar-width:none]">
        {TABS.map((t) => (
          <a key={t} href={`#${t}`} className={`border-b-2 px-3 py-1.5 text-xs capitalize ${tab === t ? 'border-sky-500 text-neutral-100' : 'border-transparent text-neutral-500 hover:text-neutral-300'}`}>{t.replace('-', ' ')}
            {t === 'inbound' && inboundCount > 0 && <span className="ml-1 rounded-full bg-sky-600 px-1.5 text-[10px] font-semibold text-white">{inboundCount}</span>}
          </a>
        ))}
      </nav>
      <main className="p-4">
        {tab === 'inbound' && <TradesPage key="in" direction="inbound" />}
        {tab === 'inventory' && <InventoryPage />}
        {tab === 'my-trades' && <MyTradesPage />}
        {tab === 'drops' && <DropsPage />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'market' && <MarketPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
