/**
 * Entry point for `node --test test/backend/infra`.
 *
 * See `../runner.js` for why a directory needs an entry point at all on this Node version.
 *
 * @module test/backend/infra
 */
import { importTestsIn } from '../runner.js';

await importTestsIn(import.meta.url);
