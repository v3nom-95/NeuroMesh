/**
 * Entry point for `node --test test/backend` (and therefore for `npm run test:unit`).
 *
 * See `./runner.js` for why a directory needs an entry point at all on this Node version.
 *
 * @module test/backend
 */
import { importTestsIn } from './runner.js';

await importTestsIn(import.meta.url);
