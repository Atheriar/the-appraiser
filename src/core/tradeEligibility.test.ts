/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { describe, expect, it } from 'vitest';
import { describeEligibility, tradeStatusFrom } from './tradeEligibility.js';

describe('trade eligibility', () => {
  it('maps premium / age / unknown enums to human text', () => {
    expect(describeEligibility('UserNeedsPremium')).toMatch(/Roblox Plus/);
    expect(describeEligibility('InsufficientMembership')).toMatch(/Roblox Plus/);
    expect(describeEligibility('AgeCheckRequiredForTrading')).toMatch(/age check/);
    expect(describeEligibility('SomethingNew42')).toBe('Roblox says "SomethingNew42"');
    expect(describeEligibility(null)).toMatch(/did not say/);
  });
  it('builds a status with free-trade allowance and no reason when eligible', () => {
    expect(tradeStatusFrom(null)).toBeNull();
    const ok = tradeStatusFrom({ canTrade: true, tradeEligibility: 'Eligible', freeTradesAllowance: { limit: 5, remaining: 3, window: 'Daily' } })!;
    expect(ok).toMatchObject({ canTrade: true, reason: null, freeTradesRemaining: 3, freeTradesLimit: 5, freeTradesWindow: 'Daily' });
    const no = tradeStatusFrom({ canTrade: false, tradeEligibility: 'UserNeedsPremium', freeTradesAllowance: null })!;
    expect(no.reason).toMatch(/Roblox Plus/);
    expect(no.freeTradesRemaining).toBeNull();
  });
});
