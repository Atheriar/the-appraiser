/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIX = join(process.cwd(), 'docs', 'fixtures');
export const fx = (name: string) => readFileSync(join(FIX, name), 'utf8');

export function hdr(name: string): { status: number; headers: Headers } {
  const p = join(FIX, name);
  const headers = new Headers();
  if (!existsSync(p)) return { status: 200, headers };
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  const status = Number(/HTTP\/[\d.]+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 200);
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
  }
  return { status, headers };
}

export interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
export type Route = (url: URL, init: RequestInit, call: Call) => Response | undefined;

export function respond(body: string | object, status = 200, headers: Headers | Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}
export function fixtureResponse(base: string, status?: number): Response {
  const h = hdr(`${base}.hdr`);
  if (!existsSync(join(FIX, `${base}.hdr`))) {
    const alt = hdr(`${base}.json.hdr`);
    return respond(fx(`${base}.json`), status ?? alt.status, alt.headers);
  }
  return respond(fx(`${base}.json`), status ?? h.status, h.headers);
}

export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const call: Call = { url: url.toString(), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined };
    calls.push(call);
    for (const r of routes) { const res = r(url, init, call); if (res) return res; }
    return respond({ errors: [{ code: 0, message: 'no fixture' }] }, 404);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const testDeps = (f: typeof fetch, now = () => Date.parse('2026-10-20T12:00:00Z')) => ({
  fetch: f, now, sleep: async () => undefined, limits: false as const,
});
