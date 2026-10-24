/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { spawn } from 'node:child_process';

/**
 * Windows DPAPI (CurrentUser scope) via Windows PowerShell 5.1's ProtectedData.
 * The secret travels over stdin only (never argv, never env, never logged).
 */
const PROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;` +
  `$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);` +
  `$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Console]::Out.Write([Convert]::ToBase64String($e))`;
const UNPROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;` +
  `$s=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($s);` +
  `$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))`;

function runPs(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let errLen = 0;
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { errLen += d.length; });
    child.on('error', reject);
    child.on('close', (code) => {
      // stderr is deliberately not surfaced (could echo input in pathological cases).
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`DPAPI PowerShell exited with code ${code} (stderr ${errLen} bytes suppressed)`));
    });
    child.stdin.end(input, 'utf8');
  });
}

export async function dpapiProtect(plain: string): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('DPAPI is only available on Windows');
  return Buffer.from((await runPs(PROTECT, plain)).trim(), 'base64');
}

export async function dpapiUnprotect(blob: Buffer): Promise<string> {
  if (process.platform !== 'win32') throw new Error('DPAPI is only available on Windows');
  return runPs(UNPROTECT, blob.toString('base64'));
}
