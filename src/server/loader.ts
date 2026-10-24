/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/**
 * Integration point: binds the adapters and the scoring engine statically so a broken
 * module fails loudly at startup instead of silently falling back to the stand-in fakes.
 */
import type { AdapterFactory } from '../adapters/interfaces.js';
import type { CoreEngine } from '../core/contracts.js';
import { createAdapters, type AdapterFactoryOptions } from '../adapters/index.js';
import { engine } from '../core/index.js';

export async function loadEngine(): Promise<{ engine: CoreEngine; real: boolean }> {
  return { engine, real: true };
}

export async function loadAdapters(opts: AdapterFactoryOptions = {}): Promise<AdapterFactory | null> {
  return createAdapters(opts);
}
