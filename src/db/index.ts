/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { SqliteRepository } from './sqlite.js';

export { SqliteRepository } from './sqlite.js';
export { deepMerge, checkShape } from './merge.js';
export type { ItemRecord, Repository } from './interfaces.js';

export function openRepository(file: string): SqliteRepository {
  const repo = new SqliteRepository(file);
  repo.migrate();
  return repo;
}
