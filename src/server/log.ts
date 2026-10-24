/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../secrets/index.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Tiny structured logger. Every line passes through cookie redaction before leaving the process. */
export class Logger {
  private file: string | null = null;

  constructor(dir: string | null, private readonly toConsole = true) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, 'analyst.log');
    }
  }

  private write(level: Level, msg: string, extra?: unknown): void {
    let line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra !== undefined ? { extra: serialize(extra) } : {}) });
    line = redact(line);
    if (this.toConsole) (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    if (this.file) {
      try {
        try { if (statSync(this.file).size > 5_000_000) renameSync(this.file, `${this.file}.1`); } catch { /* new file */ }
        appendFileSync(this.file, line + '\n');
      } catch { /* logging must never crash the service */ }
    }
  }

  debug(m: string, e?: unknown) { if (process.env.DEBUG) this.write('debug', m, e); }
  info(m: string, e?: unknown) { this.write('info', m, e); }
  warn(m: string, e?: unknown) { this.write('warn', m, e); }
  error(m: string, e?: unknown) { this.write('error', m, e); }
}

function serialize(e: unknown): unknown {
  if (e instanceof Error) return { name: e.name, message: redact(e.message) };
  return e;
}

export function errMsg(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}
