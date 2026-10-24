/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import type { Logger } from './log.js';
import { CATALOG_URL_RE } from '../core/drops.js';

export interface Notifier {
  /** Desktop notification ONLY. Clicking opens the local UI (or a roblox.com catalog page for a drop); it never acts on anything. */
  notify(title: string, message: string, url: string): Promise<void>;
}

export class NullNotifier implements Notifier {
  readonly sent: Array<{ title: string; message: string; url: string }> = [];
  async notify(title: string, message: string, url: string) { this.sent.push({ title, message, url }); }
}

/** Only our own UI or an exact roblox.com catalog/bundle page may be opened. */
export function isOpenableUrl(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) || CATALOG_URL_RE.test(url);
}

export async function openUrl(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  const { default: open } = await import('open');
  await open(url);
}

export class DesktopNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async notify(title: string, message: string, url: string): Promise<void> {
    try {
      const mod = await import('node-notifier');
      const nn = (mod as unknown as { default?: typeof mod }).default ?? mod;
      nn.notify({ title, message, appID: 'The Appraiser', wait: true, sound: true } as never, (err: Error | null, response: string) => {
        if (err) this.log.warn('notification failed', err);
        if (typeof response === 'string' && /activate|click/i.test(response)) void openUrl(url);
      });
    } catch (e) {
      this.log.warn('node-notifier unavailable', e);
    }
  }
}
