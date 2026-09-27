import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '../shared/contracts/index.js';
export function configuration(env = process.env) {
  const vault = env.OBSIDIAN_VAULT_PATH;
  const state = env.TRACKER_STATE_PATH;
  if (!vault || !path.isAbsolute(vault) || !state || !path.isAbsolute(state))
    throw new AppError(
      'CONFIGURATION_ERROR',
      'OBSIDIAN_VAULT_PATH and TRACKER_STATE_PATH must be explicit absolute paths',
    );
  const relative = env.TRACKER_RELATIVE_PATH || 'Life/HabitTracker';
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
    throw new AppError('CONFIGURATION_ERROR', 'TRACKER_RELATIVE_PATH must stay inside the Vault');
  const root = path.resolve(vault, relative);
  const stateRoot = path.resolve(state);
  if (stateRoot === path.resolve(vault) || stateRoot.startsWith(path.resolve(vault) + path.sep))
    throw new AppError('CONFIGURATION_ERROR', 'State directory must be outside the entire Vault');
  const production = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN || 'http://127.0.0.1:5173';
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError('CONFIGURATION_ERROR', 'Invalid PORT');
  if (!['127.0.0.1', '::1'].includes(host))
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Bind to loopback; use Tailscale Serve for private access',
    );
  if (production) {
    if (!env.TAILSCALE_OWNER || !origin.startsWith('https://'))
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Production requires TAILSCALE_OWNER and an HTTPS APP_ORIGIN',
      );
    const resolvedVault = fs.existsSync(vault) ? fs.realpathSync(vault) : path.resolve(vault);
    const repo = fs.realpathSync(process.cwd());
    if (resolvedVault === repo || resolvedVault.startsWith(repo + path.sep))
      throw new AppError('CONFIGURATION_ERROR', 'Production Vault must be outside the repository');
  }
  return {
    root,
    stateRoot,
    host,
    port,
    origin: new URL(origin).origin,
    production,
    owner: env.TAILSCALE_OWNER,
    database: path.join(stateRoot, 'tracker.sqlite'),
  };
}
