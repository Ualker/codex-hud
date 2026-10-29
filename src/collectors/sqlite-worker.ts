/** Native SQLite is synchronous: keep statements and read-only handles off the UI thread. */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { getSqliteDiagnostics, runSqliteStatement } from '../utils/sqlite-probe.js';

interface Database {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
}
let sqlite: { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database } | null = null;
const emitWarning = process.emitWarning;
try {
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  sqlite = createRequire(import.meta.url)('node:sqlite');
} catch { /* Node 20 uses the async CLI fallback in the parent. */ }
finally { process.emitWarning = emitWarning; }

const handles = new Map<string, { db: Database; dev: number; ino: number }>();
function close(file: string): void {
  try { handles.get(file)?.db.close(); } catch { /* Broken handle. */ }
  handles.delete(file);
}
function database(file: string): Database {
  const stat = fs.statSync(file);
  const cached = handles.get(file);
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino) return cached.db;
  close(file);
  if (handles.size >= 4) close(handles.keys().next().value!);
  const db = new sqlite!.DatabaseSync(file, { readOnly: true });
  handles.set(file, { db, dev: stat.dev, ino: stat.ino });
  return db;
}

parentPort!.on('message', ({ id, file, statements }: { id: number; file: string; statements: string[] }) => {
  const before = getSqliteDiagnostics();
  let value: string | null = null;
  try {
    if (sqlite) {
      const db = database(file);
      const lines: string[] = [];
      for (const sql of statements) {
        for (const row of runSqliteStatement(db, sql)) {
          lines.push(Object.values(row).map(value => value == null ? '' : String(value)).join('\x1f'));
        }
      }
      value = lines.join('\n');
    }
  } catch { close(file); }
  const after = getSqliteDiagnostics();
  parentPort!.postMessage({ id, value, supported: sqlite !== null, diagnostics: {
    ...after,
    statements: after.statements - before.statements,
    failures: after.failures - before.failures,
    overBudget: after.overBudget - before.overBudget,
  } });
});
