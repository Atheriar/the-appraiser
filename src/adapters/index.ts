/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import type { ValueSource } from '../core/types.js';
import type { AdapterFactory, CookieProvider, RobloxClient, RolimonsClient } from './interfaces.js';
import { HttpRobloxClient } from './roblox/client.js';
import { HttpRolimonsClient } from './rolimons/client.js';
import { GistBotList } from './botlist.js';
import { RobloxFirstPartyValueSource, RolimonsValueSource, type FirstPartyDeps } from './valueSources.js';

export { HttpRobloxClient } from './roblox/client.js';
export { HttpRolimonsClient, reconstructSalePrice, parseItemRow } from './rolimons/client.js';
export { buildTradeSnapshot, joinItems, parseTradeStatus, offerSignature } from './roblox/join.js';
export { GistBotList, parseBotList } from './botlist.js';
export { RolimonsValueSource, RobloxFirstPartyValueSource, estimateFromResale } from './valueSources.js';
export { AdapterError, RateLimitedHttp } from './limiter.js';
export { redact } from './redact.js';

export interface AdapterFactoryOptions {
  onCookieRotated?: (cookie: string) => void;
}

export function createAdapters(opts: AdapterFactoryOptions = {}): AdapterFactory {
  return {
    roblox: (cookie: CookieProvider) => new HttpRobloxClient({ cookie, onCookieRotated: opts.onCookieRotated }),
    rolimons: () => new HttpRolimonsClient(),
    botList: (url?: string) => new GistBotList(undefined, url || undefined),
    /**
     * Returns [Rolimons] and, when `firstParty` deps are supplied (extension beyond the contract),
     * also the Roblox first-party source.
     */
    valueSources: (deps: { rolimons: RolimonsClient; firstParty?: Omit<FirstPartyDeps, 'roblox'> & { roblox: RobloxClient } }): ValueSource[] => {
      const out: ValueSource[] = [new RolimonsValueSource(deps.rolimons)];
      if (deps.firstParty) out.push(new RobloxFirstPartyValueSource(deps.firstParty));
      return out;
    },
  };
}

export const adapters: AdapterFactory = createAdapters();
