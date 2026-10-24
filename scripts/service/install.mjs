/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Registers a per-user Task Scheduler task that starts the analyst hidden at logon,
// plus an "Open UI" launcher. Runs as the current user (needed for keyring/DPAPI + toasts).
// Usage: npm run build && npm run service:install   [-- --demo]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK = 'Appraiser';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(root, 'dist', 'server', 'main.js');
const dataDir = process.env.RTA_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'the-appraiser');
const port = Number(process.env.PORT ?? 47615);
const demo = process.argv.includes('--demo');

if (process.platform !== 'win32') { console.error('Windows only.'); process.exit(1); }
if (!existsSync(entry)) { console.error(`Missing ${entry}. Run "npm run build" first.`); process.exit(1); }
mkdirSync(dataDir, { recursive: true });

const node = process.execPath;
const vbs = join(dataDir, 'run-hidden.vbs');
const q = (s) => s.replace(/"/g, '""');
// wscript runs node with no console window (style 0) and WAITS for it (bWaitOnReturn=True), then exits
// with node's exit code, so the task's RestartOnFailure policy actually sees a node crash.
writeFileSync(vbs, [
  'Set sh = CreateObject("WScript.Shell")',
  `sh.CurrentDirectory = "${q(root)}"`,
  demo ? 'sh.Environment("PROCESS")("DEMO") = "1"' : '',
  process.env.PORT ? `sh.Environment("PROCESS")("PORT") = "${q(String(port))}"` : '',
  `sh.Environment("PROCESS")("RTA_DATA_DIR") = "${q(dataDir)}"`,
  `rc = sh.Run("""${q(node)}"" ""${q(entry)}""", 0, True)`,
  'WScript.Quit rc',
].filter(Boolean).join('\r\n'), 'utf8');

const openBat = join(dataDir, 'Open Appraiser.bat');
writeFileSync(openBat, `@echo off\r\nstart "" "http://127.0.0.1:${port}/"\r\n`, 'utf8');
const repoBat = join(root, 'scripts', 'service', 'open-ui.bat');
writeFileSync(repoBat, `@echo off\r\nstart "" "http://127.0.0.1:${port}/"\r\n`, 'utf8');

// Desktop shortcut (Internet shortcut file).
const desktop = join(homedir(), 'Desktop');
if (existsSync(desktop)) writeFileSync(join(desktop, 'Appraiser.url'), `[InternetShortcut]\r\nURL=http://127.0.0.1:${port}/\r\n`, 'utf8');

const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>The Appraiser (read-only trade decision support). Never acts on trades.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${x(user)}</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${x(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>&quot;${x(vbs)}&quot;</Arguments><WorkingDirectory>${x(root)}</WorkingDirectory></Exec></Actions>
</Task>`;
const xmlFile = join(dataDir, 'task.xml');
writeFileSync(xmlFile, '﻿' + xml, 'utf16le');

execFileSync('schtasks.exe', ['/Create', '/TN', TASK, '/XML', xmlFile, '/F'], { stdio: 'inherit' });
try { execFileSync('schtasks.exe', ['/Run', '/TN', TASK], { stdio: 'inherit' }); } catch { /* starts at next logon */ }
console.log(`\nInstalled task "${TASK}" (runs at logon, hidden). UI: http://127.0.0.1:${port}/`);
console.log(`Open-UI launcher: ${openBat}  (also "Appraiser.url" on the Desktop)`);
console.log('Logs and data:', dataDir);
