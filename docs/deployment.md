# Mac mini deployment

## Configure and verify locally

1. Install Node.js 24 LTS and run `npm ci` and `npm run build` in the application checkout. Runtime currently uses `tsx`, so include development dependencies when installing.
2. Set `.env` with the real external Vault path and a state directory outside that Vault. The repository's fixture Vault is rejected in production. The selected tracker directory must be a local filesystem directory; make sure any cloud-synced Vault is fully downloaded. Keep a single application writer.
3. Initialize only if this is a new, empty tracker directory (`npm run vault:init` in development mode). Otherwise validate the existing source first.
4. Set `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`, `APP_ORIGIN=https://<mac>.<tailnet>.ts.net`, and `TAILSCALE_OWNER=<your-login>`.
5. Validate and rebuild, then run `npm start` and verify local logs. The API requires the owner identity header in production, so use the private Serve URL for actual browser checks.

## Private remote access

Install Tailscale on the Mac mini, Mac and Galaxy. Sign into the owner's tailnet. Use the tailnet access policy to limit access to the tracker owner's devices. Enable HTTPS certificates and run `tailscale serve --bg 3000`. Configure `APP_ORIGIN` to exactly match the resulting private HTTPS origin. Use Serve, not public Funnel, and do not forward router ports.

The app trusts identity headers only on a loopback-bound server behind Serve. It checks owner login, host and mutation origin. Habit data remains local. Tailscale coordination is an external dependency for remote connectivity, not a database.

Reference: https://tailscale.com/docs/features/tailscale-serve

## launchd

Copy `scripts/deployment/com.lifebot.tracker.plist.example` to `~/Library/LaunchAgents/com.lifebot.tracker.plist` after replacing every uppercase placeholder. Use an absolute Node binary, application directory, and local log directory. Create the log directory first. The template uses Node's `--import tsx` and `--env-file` to avoid reliance on a login shell PATH.

Load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lifebot.tracker.plist`. This is a per-user LaunchAgent: it starts after that user logs in. For unattended restart after reboot, account for FileVault unlock and login; do not assume a LaunchAgent starts before login. Configure Mac power settings so the server stays available while needed.

Before changing files/dependencies, stop with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.lifebot.tracker.plist`, update/build/test, then bootstrap again. No deployment or network configuration is performed automatically by this repository.

## Backup, recovery and acceptance

- Back up the complete canonical tracker directory using Time Machine or your existing local backup system. For a consistent manual copy, stop the application during copying. Include Tracker, definitions, Commits and Daily together.
- SQLite, logs and temporary files are disposable. A rebuild is not a source backup.
- Restore the canonical directory, point the app at it, validate, and rebuild. Verify counts and history before using it.
- After an interrupted definition write, validation reports uncommitted revisions. They are ignored; subsequent writes select unused revision paths. Do not delete committed revisions to clear a warning.
- An interrupted writer may leave a lock; the lock library recovers a stale lock after five minutes. Do not manually clear a lock while another writer is running.
- If indexing fails after a save, the UI reports the problem and derives its response from canonical data; a restart keeps working. Fix state-directory permissions/disk space, then rebuild.
- If the state directory is not writable, every change is refused with `STATE_UNAVAILABLE` and nothing is saved, because a crash could not be recovered safely; viewing still works. Fix permissions/disk space and retry.
- If the Vault is missing or invalid at startup, the server still starts and the System screen reports the error.
- Actual-device acceptance still requires Galaxy Chrome/Samsung Internet and Mac Safari/Chrome over the configured private URL: create, complete, undo, annotate, view history, rotate/rescale, reconnect, cross midnight, restart the process, delete/rebuild a test index, and restore a copied test Vault.

Do not test destructive recovery against the only copy of a personal Vault.
