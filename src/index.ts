/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
// Service entry alias: `node dist/index.js` == `node dist/server/main.js`.
import { main } from './server/main.js';

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
