import fs from 'node:fs';
import lockfile from 'proper-lockfile';
import { AppError } from '../../shared/contracts/index.js';

export async function withVaultLock<T>(root: string, fn: () => T | Promise<T>): Promise<T> {
  if (!fs.existsSync(root))
    throw new AppError(
      'VAULT_UNAVAILABLE',
      'Tracker directory does not exist; initialize an explicit Vault first',
      503,
    );
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(root, {
      realpath: true,
      stale: 300000,
      update: 10000,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
    });
  } catch {
    throw new AppError('VAULT_BUSY', 'Another writer owns this Vault', 409);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}
