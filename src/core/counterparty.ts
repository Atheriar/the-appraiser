/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Counterparty risk assessment (flags + evidence, never auto-decisions). */
import type { Evidence, PartnerFlag, PartnerInfo, Settings, TradeSide, UserId } from './types.js';
import { fmtR } from './util.js';

export function assessPartner(p: Omit<PartnerInfo, 'flags' | 'evidence'>, settings: Settings, myUserId: UserId): PartnerInfo {
  const flags: PartnerFlag[] = [];
  const evidence: Evidence[] = [];
  const S = settings.scoring;
  if (p.userId === myUserId) return { ...p, flags, evidence };
  if (p.inBotList) {
    flags.push('bot_list');
    const asOf = settings.botList?.asOf;
    evidence.push({ code: 'bot_list', severity: 'warn', message: `Listed in the bot list (${asOf ? `data as of ${asOf}, ` : ''}weak signal)` });
  }
  if (p.repeatOfferAccounts >= S.repeatOfferMinAccounts || p.repeatOfferCount >= 3) {
    flags.push('repeat_offer');
    evidence.push({
      code: 'repeat_offer', severity: 'warn',
      message: `repeat-offer x${Math.max(p.repeatOfferAccounts, 1)}: identical offer seen ${p.repeatOfferCount} time(s) from ${p.repeatOfferAccounts} account(s) in ${Math.round(S.repeatOfferWindowMs / 3_600_000)}h`,
      data: { accounts: p.repeatOfferAccounts, count: p.repeatOfferCount },
    });
  }
  if (p.accountAgeDays != null && p.accountAgeDays < S.newAccountDays) {
    flags.push('new_account');
    evidence.push({ code: 'new_account', severity: 'warn', message: `Account is ${Math.floor(p.accountAgeDays)} days old`, data: { days: p.accountAgeDays } });
  }
  if (p.inventoryVisible === false) {
    flags.push('hidden_inventory');
    evidence.push({ code: 'hidden_inventory', severity: 'info', message: 'Inventory is hidden' });
  }
  if (p.terminated) {
    flags.push('terminated');
    evidence.push({ code: 'terminated', severity: 'bad', message: 'Rolimons reports the account as terminated' });
  }
  if (p.isBanned) {
    flags.push('banned');
    evidence.push({ code: 'banned', severity: 'bad', message: 'Roblox reports the account as banned' });
  }
  const { completed, declined } = p.priorTrades;
  if (completed > 0) {
    flags.push('prior_good_history');
    evidence.push({ code: 'prior_good_history', severity: 'good', message: `${completed} completed trade(s) with you before` });
  } else if (declined >= 3) {
    flags.push('prior_bad_history');
    evidence.push({ code: 'prior_bad_history', severity: 'info', message: `You declined ${declined} of their trades before` });
  }
  if (p.inventoryValue != null && p.inventoryItemCount != null && p.inventoryItemCount <= 2 && p.inventoryValue > 0) {
    flags.push('low_inventory');
    evidence.push({ code: 'low_inventory', severity: 'info', message: `Only ${p.inventoryItemCount} item(s) worth ${fmtR(p.inventoryValue)} in inventory` });
  }
  return { ...p, flags, evidence };
}

/** Order-independent offer signature (helper for repo/jobs; matches TradeSnapshot.offerSignature intent). */
export function offerSignature(give: Pick<TradeSide, 'items' | 'robux'>, get: Pick<TradeSide, 'items' | 'robux'>): string {
  const side = (s: Pick<TradeSide, 'items' | 'robux'>) => [...s.items.map((i) => i.assetId)].sort((a, b) => a - b).join(',') + `|r${s.robux}`;
  return `g:${side(give)};r:${side(get)}`;
}
