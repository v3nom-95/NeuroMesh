/**
 * Entry point for `node --test test/backend/protocol`.
 *
 * See `../runner.js` for why a directory needs an entry point at all on this Node version.
 *
 * @module test/backend/protocol
 */
import { importTestsIn } from '../runner.js';

await importTestsIn(import.meta.url);
