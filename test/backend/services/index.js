/**
 * Entry point for `node --test test/backend/services`.
 *
 * See `../runner.js` for why a directory needs an entry point at all on this Node version.
 *
 * @module test/backend/services
 */
import { importTestsIn } from '../runner.js';

await importTestsIn(import.meta.url);
