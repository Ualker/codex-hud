import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** Reproduce container filesystems that reuse timestamps for a same-size rewrite. */
export function freezeFileRevision(file) {
  const stat = fs.statSync, fstat = fs.fstatSync;
  const before = stat(file), beforeBig = stat(file, { bigint: true });
  const freeze = value => {
    const baseline = typeof value.ino === 'bigint' ? beforeBig : before;
    if (value.dev === baseline.dev && value.ino === baseline.ino) {
      for (const key of ['size', 'mtime', 'ctime', 'mtimeMs', 'ctimeMs', 'mtimeNs', 'ctimeNs']) {
        if (key in baseline) value[key] = baseline[key];
      }
    }
    return value;
  };
  fs.statSync = (...args) => freeze(stat(...args));
  fs.fstatSync = (...args) => freeze(fstat(...args));
  syncBuiltinESMExports();
  return () => {
    fs.statSync = stat;
    fs.fstatSync = fstat;
    syncBuiltinESMExports();
  };
}
