/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Guard test: no source file may reference trade action endpoints (accept / decline / counter / send).
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(f) && !f.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('hard rule: no trade automation', () => {
  it('no file references accept/decline/counter/send trade endpoints', () => {
    const bad = /trades\/(send|\d+\/(accept|counter|decline)|\$\{[^}]+\}\/(accept|counter|decline))|\/(accept|counter|decline)['"`]|v\d\/trades\/send|declineTrade/i;
    const files = [...walk('src'), ...walk('web/src'), ...walk('scripts')];
    const offenders = files.filter((f) => bad.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('no file references a purchase / buy endpoint (drops are bought by the user on roblox.com)', () => {
    const bad = /purchase-item|\/purchase|v1\/purchases?|economy\.roblox\.com\/v\d\/purchases|marketplace-sales\/v\d\/item\/[^'"`]*\/purchase/i;
    const files = [...walk('src'), ...walk('web/src'), ...walk('scripts')];
    const offenders = files.filter((f) => bad.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
