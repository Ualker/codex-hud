import { createHash } from 'crypto';
import { logHudError } from './hud-log.js';

interface Database {
  prepare(sql: string): { all(): Record<string, unknown>[] };
}

const BUDGET_MS = 50;
const loggedAt = new Map<string, number>();
let diagnostics = { statements: 0, failures: 0, overBudget: 0, maxMs: 0, lastErrorCode: '' };

/** Measure native synchronous work; log plans only for slow, read-only statements. */
export function runSqliteStatement(db: Database, sql: string, now: () => number = performance.now.bind(performance)): Record<string, unknown>[] {
  const started = now();
  let rows = 0;
  try {
    const result = db.prepare(sql).all();
    rows = result.length;
    return result;
  } catch (error) {
    diagnostics.failures++;
    const failure = error as { code?: unknown; errcode?: unknown } | null;
    const code = typeof failure?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(failure.code)
      ? failure.code : 'UNKNOWN';
    diagnostics.lastErrorCode = typeof failure?.errcode === 'number'
      ? `${code}:${failure.errcode}` : code;
    throw error;
  } finally {
    const ms = Math.max(0, now() - started);
    diagnostics.statements++;
    diagnostics.maxMs = Math.max(diagnostics.maxMs, ms);
    if (ms >= BUDGET_MS) {
      diagnostics.overBudget++;
      // Only the digest and query plan go to diagnostics, never SQL literals
      // (which can contain cwd, thread ids and process command text).
      const query = createHash('sha256').update(sql).digest('hex').slice(0, 12);
      const wallTime = Date.now();
      if (wallTime - (loggedAt.get(query) ?? 0) >= 60_000) {
        if (loggedAt.size >= 64) loggedAt.clear();
        loggedAt.set(query, wallTime);
        let plan: string[] = [];
        if (/^\s*(?:SELECT|WITH)\b/i.test(sql)) {
          try { plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().slice(0, 8)
            .map(row => String(row.detail ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 240)); }
          catch { /* Plan support must not change the query's result or error. */ }
        }
        logHudError('sqlite-slow', JSON.stringify({ query, ms: Math.round(ms), budgetMs: BUDGET_MS, rows, plan }));
      }
    }
  }
}

export function getSqliteDiagnostics(): typeof diagnostics { return { ...diagnostics }; }
