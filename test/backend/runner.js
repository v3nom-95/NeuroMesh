/**
 * Directory entry-point helper for the backend unit tests.
 *
 * ## Why this file exists
 *
 * `npm run test:unit` is `node --test --test-reporter=spec test/backend`, and the npm scripts cannot
 * be changed (they also cannot set env vars inline on Windows, which is why every test here must run
 * with no `.env`, no network, no private key and no model download).
 *
 * On the Node build this project targets (v22.13.1) a **directory** passed positionally to
 * `node --test` is not expanded into the test files it contains — it is handed straight to the
 * module loader, which fails with `MODULE_NOT_FOUND` before a single test runs. Only globs and
 * explicit files work. Verified directly, and it reproduces outside this repository.
 *
 * The fix that needs no change to `package.json`: give each test directory a `package.json` with a
 * `main`, so resolving the directory resolves to its `index.js`, and have that `index.js` import
 * every `*.test.js` beneath it. `node --test test/backend` and `node --test test/backend/protocol`
 * then both work, and so does the glob form. Newer Node versions that do expand directories are
 * unaffected: `index.js` is not a test file, so their discovery ignores it.
 *
 * Discovery is dynamic rather than a hand-maintained import list so that later phases can drop new
 * `*.test.js` files into `test/backend/**` and have them picked up with no edit here.
 *
 * @module test/backend/runner
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Import every `*.test.js` file under `dirUrl`, recursively, in sorted order.
 *
 * Sorted so the registration order — and therefore the reported order — is identical on every
 * machine and every filesystem.
 *
 * @param {string|URL} dirUrl `import.meta.url` of the index module, or a directory file: URL.
 * @returns {Promise<string[]>} Absolute paths of the files that were imported.
 */
export async function importTestsIn(dirUrl) {
  const here = fileURLToPath(dirUrl);
  const dir = here.endsWith('.js') ? join(here, '..') : here;

  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();

  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
  return files;
}
