import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, type PlannedFile } from './markdown/vault.js';

// A write-ahead note of the canonical write the app is about to make, kept in the
// state directory. After a crash it proves that a source change is exactly the
// app's own commit: `from` must be the accepted fingerprint and the Vault must
// match `to`, or `from` plus any subset of the planned revisions (manifest missing).
// It never makes SQLite an authority and never accepts any other change.
export interface Intent {
  from: string;
  to: string;
  files: PlannedFile[];
}
export class CommitIntent {
  constructor(public file: string) {}
  static beside(indexFile: string) {
    return new CommitIntent(path.join(path.dirname(indexFile), 'commit-intent.json'));
  }
  read(): Intent | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Intent;
      const hash = /^[0-9a-f]{64}$/;
      return hash.test(value.from) &&
        hash.test(value.to) &&
        Array.isArray(value.files) &&
        value.files.every((f) => typeof f.path === 'string' && hash.test(f.sha256))
        ? value
        : null;
    } catch {
      return null;
    }
  }
  write(intent: Intent) {
    atomicWrite(this.file, JSON.stringify(intent));
  }
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}
