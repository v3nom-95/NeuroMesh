/**
 * Entry point for `node --test test/backend/routes`.
 *
 * See `../runner.js` for why a directory needs an entry point at all on this Node version.
 *
 * @module test/backend/routes
 */
import { importTestsIn } from '../runner.js';

await importTestsIn(import.meta.url);
