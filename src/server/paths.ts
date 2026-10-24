/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (works from src/server via tsx and from dist/server via node). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Per-user data dir: %APPDATA%\the-appraiser (override with RTA_DATA_DIR). */
export function dataDir(): string {
  if (process.env.RTA_DATA_DIR) return resolve(process.env.RTA_DATA_DIR);
  const base = process.env.APPDATA ?? join(homedir(), '.config');
  return join(base, 'the-appraiser');
}

export const webDist = () => join(PROJECT_ROOT, 'web', 'dist');
export const fixturesDir = () => join(PROJECT_ROOT, 'docs', 'fixtures');
