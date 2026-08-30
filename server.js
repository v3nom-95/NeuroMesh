/**
 * Root entrypoint shim. Nothing lives here.
 *
 * `package.json` pins `"start": "node server.js"` and `"dev": "node --watch server.js"`, and the
 * Dockerfile COPYs and runs this path, so the file has to exist at the repository root. The real
 * bootstrap - config, services, the Express app and the lifecycle - is `src/server.js`.
 *
 * No dotenv call here (`src/config/env.js` owns that, and owns it conditionally so a test run
 * never reads the operator's real `.env`), no top-level await, and no side effects of its own.
 *
 * @module server
 */
import './src/server.js';
