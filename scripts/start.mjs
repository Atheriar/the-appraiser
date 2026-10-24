#!/usr/bin/env node
/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Real-mode launcher (npm run real / scripts\start.cmd).
 *  1. Builds if dist/ is missing or older than src/ or web/src/.
 *  2. If the app already answers on the port (e.g. the logon service is running), just opens the browser.
 *  3. Otherwise starts node dist/server/main.js in THIS console (real mode, %APPDATA% data dir,
 *     notifications on), waits for /api/health and opens the browser. Ctrl+C stops it.
 * Never touches the cookie; enter it in the UI (Settings).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 47615);
const BASE = `http://127.0.0.1:${PORT}`;
const force = process.argv.includes('--build');

function newest(dir) {
  let t = 0;
  if (!existsSync(dir)) return t;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

function needsBuild() {
  const server = join(ROOT, 'dist', 'server', 'main.js');
  const web = join(ROOT, 'web', 'dist', 'index.html');
  if (!existsSync(server) || !existsSync(web)) return true;
  const built = Math.min(statSync(server).mtimeMs, statSync(web).mtimeMs);
  return Math.max(newest(join(ROOT, 'src')), newest(join(ROOT, 'web', 'src'))) > built;
}

async function healthy() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}

async function openBrowser() {
  const { default: open } = await import('open');
  await open(`${BASE}/`);
  console.log(`Opened ${BASE}/`);
}

if (await healthy()) {
  console.log(`Appraiser is already running on port ${PORT}.`);
  await openBrowser();
  process.exit(0);
}

if (force || needsBuild()) {
  console.log('Building (dist missing or older than sources)...');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('Build failed.'); process.exit(r.status ?? 1); }
}

const env = { ...process.env, RTA_NO_OPEN: '1' };
delete env.DEMO;
delete env.RTA_NO_NOTIFY;
// Keep the server alive: if it crashes, log it here and restart (back off if it keeps crashing),
// instead of closing this window. Ctrl+C stops both.
let child;
let stopping = false;
let quickCrashes = 0;
function startServer() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [join(ROOT, 'dist', 'server', 'main.js')], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    quickCrashes = Date.now() - startedAt < 60_000 ? quickCrashes + 1 : 0;
    const wait = Math.min(60_000, 2_000 * 2 ** Math.min(quickCrashes, 5));
    console.error(`[${new Date().toLocaleTimeString()}] Server stopped (code ${code}${signal ? ', ' + signal : ''}). Restarting in ${Math.round(wait / 1000)}s. Details: %APPDATA%\the-appraiser\logs\analyst.log`);
    setTimeout(startServer, wait);
  });
}
startServer();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; child.kill(sig); });

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  if (await healthy()) {
    console.log(`Appraiser running at ${BASE}/  (Ctrl+C to stop)`);
    await openBrowser();
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (child.exitCode === null && !(await healthy())) console.error(`Server did not answer on ${BASE} within 60s; check the log in %APPDATA%\\the-appraiser\\logs.`);
