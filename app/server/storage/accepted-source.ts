import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './markdown/vault.js';

// Records the canonical source fingerprint last written or explicitly accepted by
// this app. It lives in the state directory, independent of SQLite, so an index
// failure or crash after a Markdown commit is not mistaken for an external edit.
// Without it, the SQLite index metadata fingerprint (or, with no index either, the current
// source) is trusted once as a legacy bootstrap and the marker is written from it.
export class AcceptedSource {
  constructor(public file: string) {}
  static beside(indexFile: string) {
    return new AcceptedSource(path.join(path.dirname(indexFile), 'accepted-source'));
  }
  read(): string | null {
    try {
      const value = fs.readFileSync(this.file, 'utf8').trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  write(fingerprint: string) {
    atomicWrite(this.file, `${fingerprint}\n`);
  }
}
