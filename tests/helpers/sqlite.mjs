import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
}

// Match the runtime contract: built-in SQLite where available, CLI on Node 20.
export function executeSql(dbPath, statements) {
  if (!DatabaseSync) {
    execFileSync('sqlite3', [dbPath, statements]);
    return;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
}
