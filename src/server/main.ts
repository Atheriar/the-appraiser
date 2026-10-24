/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Service entry. Binds 127.0.0.1 only. Env:
 *   DEMO=1            fixture trades, no cookie/network (throwaway demo.db)
 *   RTA_DATA_DIR=...  override %APPDATA%\the-appraiser
 *   PORT=...          override settings.port
 *   DEMO_NO_TRADE=1   demo only: pretend the account cannot trade (no Roblox Plus) to preview the banner
 *   RTA_NO_OPEN=1     never auto-open the browser (the launcher opens it itself)
 *   RTA_NO_NOTIFY=1   disable desktop notifications (demo is quiet unless RTA_DEMO_NOTIFY=1)
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Analyst } from '../jobs/analyst.js';
import { openRepository } from '../db/index.js';
import { MemorySecretStore, WindowsSecretStore } from '../secrets/index.js';
import { buildApp } from './app.js';
import { DEMO_ACCOUNT, demoSources, primeDemo, seedDemo, seedDemoDrops, type DemoSeed } from './demo.js';
import { loadAdapters, loadEngine } from './loader.js';
import { Logger } from './log.js';
import { DesktopNotifier, NullNotifier, openUrl } from './notify.js';
import { PROJECT_ROOT, dataDir } from './paths.js';

export async function main(): Promise<void> {
  const demo = process.env.DEMO === '1' || process.argv.includes('--demo');
  const dir = dataDir();
  const log = new Logger(join(dir, 'logs'));
  let version = '0.0.0';
  try { version = (JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version; } catch { /* ignore */ }

  const dbFile = join(dir, demo ? 'demo.db' : 'analyst.db');
  if (demo) for (const ext of ['', '-wal', '-shm']) rmSync(dbFile + ext, { force: true });
  const repo = openRepository(dbFile);
  const demoSeed: DemoSeed | null = demo ? seedDemo(repo) : null;

  const settings = repo.getSettings();
  const port = Number(process.env.PORT ?? settings.port);
  const uiUrl = `http://127.0.0.1:${port}`;

  const { engine, real } = await loadEngine();
  const secrets = demo ? new MemorySecretStore(null) : new WindowsSecretStore(join(dir, 'cookie.bin'));
  // Persist a cookie Roblox rotates; log only the fact, never the value.
  const adapters = demo ? null : await loadAdapters({
    onCookieRotated: (c) => {
      log.info('Roblox rotated the session cookie; stored the new one');
      void secrets.setCookie(c).catch((e: unknown) => log.warn('failed to store rotated cookie', e));
    },
  });
  if (!real) log.warn('core engine not found; using fallback engine');
  if (!adapters && !demo) log.warn('adapters not found; running without Roblox/Rolimons data');

  const quiet = process.env.RTA_NO_NOTIFY === '1' || (demo && process.env.RTA_DEMO_NOTIFY !== '1');
  const notifier = quiet ? new NullNotifier() : new DesktopNotifier(log);
  if (demoSeed) seedDemoDrops(repo); // before the Analyst reads settings (adds a demo watchlist creator)
  const analyst = new Analyst({ repo, secrets, engine, engineReal: real, adapters, notifier, log, uiUrl, demo: demo ? { account: DEMO_ACCOUNT, rolimons: null } : null });
  if (demoSeed) {
    await primeDemo(analyst, demoSeed);
    analyst.drops.markDemoPolled(Date.now() - 4_000);
    if (process.env.DEMO_DROPS_RATELIMITED === '1') analyst.drops.simulateRateLimit(Date.now() + 45_000);
    if (process.env.DEMO_NO_TRADE === '1') {
      await analyst.recordCanTrade({ canTrade: false, tradeEligibility: 'UserNeedsPremium', freeTradesAllowance: null, currencyTransferEligibility: null });
    }
    // No network in demo: show plausible adapter health rows in Settings -> Sources.
    const realSources = analyst.sources.bind(analyst);
    const noTrade = process.env.DEMO_NO_TRADE === '1';
    analyst.sources = () => [
      ...demoSources(),
      ...(noTrade ? [{ id: 'roblox:tradesV1', ok: true, state: 'restricted' as const, note: 'restricted (no trading): Roblox says this account cannot trade',
        lastSuccessAt: Date.now() - 30_000, lastErrorAt: Date.now() - 60_000, lastError: 'HTTP 403', count429: 0, cacheHits: 0, cacheMisses: 12 }] : []),
      ...realSources(),
    ];
  }
  const app = await buildApp({ analyst, secrets, log, version });

  await app.listen({ host: '127.0.0.1', port });
  log.info(`listening on ${uiUrl}${demo ? ' (DEMO)' : ''}`, { engine: engine.modelVersion, dataDir: dir });
  await analyst.start();
  if ((settings.openUiOnStart && process.env.RTA_NO_OPEN !== '1') || process.argv.includes('--open')) void openUrl(`${uiUrl}/`);

  const shutdown = async () => {
    analyst.stop();
    await app.close().catch(() => undefined);
    repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  // Without this a stray exception kills the server with nothing in the log file.
  process.on('uncaughtException', (e) => { log.error('uncaught exception (server exiting; the launcher restarts it)', e); process.exit(1); });
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((e) => {
    console.error('fatal:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
