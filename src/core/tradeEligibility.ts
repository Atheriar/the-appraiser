/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Maps /v2/users/me/can-trade into a human-readable trade status.
 * Advice-only: this never gates scoring, it only drives a banner + one notification per change.
 */
import type { TradeStatusInfo } from './api-types.js';

export interface CanTradeRaw {
  canTrade: boolean;
  tradeEligibility: string;
  freeTradesAllowance: { limit: number; remaining: number; window: string } | null;
  currencyTransferEligibility?: string | null;
}

/** Known/likely tradeEligibility enum values. Matched case-insensitively; unknown values fall through to keyword rules. */
const EXACT: Record<string, string> = {
  eligible: 'eligible',
  userneedspremium: 'you need Roblox Plus (Premium) to trade',
  needspremium: 'you need Roblox Plus (Premium) to trade',
  premiumrequired: 'you need Roblox Plus (Premium) to trade',
  usernotpremium: 'you need Roblox Plus (Premium) to trade',
  insufficientmembership: 'you need Roblox Plus (Premium) to trade',
  useragecheckrequired: 'Roblox needs an age check (ID verification) before you can trade',
  ageverificationrequired: 'Roblox needs an age check (ID verification) before you can trade',
  userunderage: 'your account is below the minimum trading age',
  usertoonew: 'your account is too new to trade',
  accountrestricted: 'your account is restricted from trading',
  userbanned: 'your account is restricted from trading',
  tradingdisabled: 'trading is turned off in your privacy settings',
  privacysettings: 'trading is turned off in your privacy settings',
  twostepverificationrequired: '2-step verification must be enabled to trade',
  tradingunavailable: 'trading is temporarily unavailable',
};

const RULES: Array<[RegExp, string]> = [
  [/premium|membership|plus|builders?club/i, 'you need Roblox Plus (Premium) to trade'],
  [/agecheck|ageverif|underage|idverif|^age/i, 'Roblox needs an age check (ID verification) before you can trade'],
  [/2sv|twostep|2fa/i, '2-step verification must be enabled to trade'],
  [/privacy|disabled|settings/i, 'trading is turned off in your privacy settings'],
  [/ban|restrict|moderat|suspend/i, 'your account is restricted from trading'],
  [/toonew|accounttooyoung|accountage/i, 'your account is too new to trade'],
];

export function describeEligibility(raw: string | null | undefined): string {
  if (!raw) return 'Roblox did not say why';
  const key = raw.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (EXACT[key]) return EXACT[key]!;
  for (const [re, text] of RULES) if (re.test(raw)) return text;
  return `Roblox says "${raw}"`;
}

export function tradeStatusFrom(c: CanTradeRaw | null | undefined): TradeStatusInfo | null {
  if (!c) return null;
  const fa = c.freeTradesAllowance;
  return {
    canTrade: c.canTrade,
    eligibility: c.tradeEligibility ?? null,
    reason: c.canTrade ? null : describeEligibility(c.tradeEligibility),
    freeTradesRemaining: fa ? fa.remaining : null,
    freeTradesLimit: fa ? fa.limit : null,
    freeTradesWindow: fa ? fa.window || null : null,
  };
}
