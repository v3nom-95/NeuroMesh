/**
 * Deterministic gas snapshotting, independent of hardhat-gas-reporter.
 *
 * The point is not to know the absolute numbers - they change with every solc release - but to fail
 * CI when a refactor moves one of them by more than the tolerance without anyone noticing.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Sends a transaction, waits for it, and returns the gas actually consumed. */
export async function gasOf(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return Number(receipt.gasUsed);
}

/** Reads a committed baseline, returning `{}` when the file does not exist yet. */
export function loadSnapshot(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Compares one measurement against the baseline.
 * @returns `{ status: "new" }` when unseen, otherwise `{ status: "ok"|"drift", delta }`.
 */
export function checkGas(name, used, baseline, tolerancePct = 10) {
  const previous = baseline[name];
  if (previous === undefined) return { status: 'new', delta: 0 };
  const delta = (used - previous) / previous;
  return { status: Math.abs(delta) <= tolerancePct / 100 ? 'ok' : 'drift', delta };
}

/**
 * Writes the baseline back, but ONLY under `UPDATE_GAS_SNAPSHOT=true`.
 *
 * Without that guard a drifting run would quietly rewrite its own baseline and the check could never
 * fail, which is the classic way a gas snapshot becomes decorative.
 */
export function writeSnapshot(filePath, data) {
  if (process.env.UPDATE_GAS_SNAPSHOT !== 'true') return false;
  const sorted = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  return true;
}
