/**
 * Revert-classification helpers for the property/fuzz suites.
 *
 * A fuzz pass is only worth running if an unexpected revert FAILS it. These helpers turn a caught
 * error into the custom-error name (or the panic code) so a test can compare it against an
 * allow-list instead of swallowing everything in a bare `catch`.
 */

/** Matches Hardhat's `reverted with custom error 'Name(...)'` message. */
const CUSTOM_ERROR_RE = /reverted with custom error '([A-Za-z0-9_]+)/;

/** Matches Hardhat's `reverted with panic code 0x11 (...)` message - always a test failure for us. */
const PANIC_RE = /reverted with panic code (0x[0-9a-fA-F]+)/;

/** Every place ethers/hardhat may hide raw revert data. */
function rawData(err) {
  return [
    err?.data,
    err?.info?.error?.data,
    err?.error?.data,
    err?.error?.error?.data,
    err?.info?.error?.error?.data,
  ].filter((d) => typeof d === 'string' && d.length >= 10);
}

/**
 * @param {unknown} err   the caught error
 * @param {import("ethers").Interface} [iface] an interface that declares the protocol's errors
 * @returns {{ kind: "custom"|"panic"|"unknown", name: string, message: string }}
 */
export function classifyRevert(err, iface) {
  const message = String(err?.message ?? err);

  const panic = PANIC_RE.exec(message);
  if (panic) return { kind: 'panic', name: panic[1], message };

  const custom = CUSTOM_ERROR_RE.exec(message);
  if (custom) return { kind: 'custom', name: custom[1], message };

  if (err?.revert?.name) return { kind: 'custom', name: err.revert.name, message };

  if (iface) {
    for (const data of rawData(err)) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return { kind: 'custom', name: parsed.name, message };
      } catch {
        /* not one of ours - fall through */
      }
    }
  }

  return { kind: 'unknown', name: '', message };
}

/**
 * Runs `fn`, returning `{ ok: true }` on success or `{ ok: false, ... }` with the classified revert.
 * Any panic (0x11 overflow, 0x12 divide-by-zero, 0x32 array bounds) or unrecognised revert is
 * reported verbatim so the caller can fail the test with a useful message.
 */
export async function attempt(fn, iface) {
  try {
    const tx = await fn();
    if (tx && typeof tx.wait === 'function') await tx.wait();
    return { ok: true };
  } catch (err) {
    return { ok: false, ...classifyRevert(err, iface) };
  }
}
