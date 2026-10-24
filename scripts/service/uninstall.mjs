/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Removes the logon task and launchers. Leaves the data dir (DB, encrypted cookie) in place;
// pass --purge-cookie to also delete the stored cookie (keyring entry + cookie.bin).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TASK = 'Appraiser';
const dataDir = process.env.RTA_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'the-appraiser');

try { execFileSync('schtasks.exe', ['/End', '/TN', TASK], { stdio: 'ignore' }); } catch { /* not running */ }
try { execFileSync('schtasks.exe', ['/Delete', '/TN', TASK, '/F'], { stdio: 'inherit' }); } catch { console.log('Task not found.'); }
// Stop a running instance started by the task (node running our dist entry).
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dist*server*main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
  { stdio: 'ignore' });
} catch { /* none */ }

for (const f of [join(dataDir, 'run-hidden.vbs'), join(dataDir, 'task.xml'), join(dataDir, 'Open Appraiser.bat'), join(homedir(), 'Desktop', 'Appraiser.url')]) {
  if (existsSync(f)) rmSync(f, { force: true });
}
if (process.argv.includes('--purge-cookie')) {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry('the-appraiser', 'roblosecurity').deletePassword();
  } catch { /* none */ }
  rmSync(join(dataDir, 'cookie.bin'), { force: true });
  console.log('Stored cookie removed.');
}
console.log('Uninstalled. Data kept in', dataDir);
