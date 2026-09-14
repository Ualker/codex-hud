import type { CollectorHealth } from '../types.js';
import { logHudError } from './hud-log.js';

const ERROR_KINDS: Record<string, CollectorHealth['errorKind']> = {
  ENOENT: 'missing-file',
  EACCES: 'access-denied',
  EPERM: 'access-denied',
  JSONL_INVALID: 'invalid-log',
  JSONL_RECORD_TOO_LARGE: 'read-limit',
  JSONL_TRUNCATED: 'truncated',
};

/** Keep the actionable diagnostic, but log a persistent failure only once. */
export function recordCollectorFailure(
  name: string,
  error: unknown,
  previous?: CollectorHealth
): CollectorHealth {
  const errorSummary = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 180);
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  const errorKind = ERROR_KINDS[code];
  if (previous?.status !== 'error' || previous.errorSummary !== errorSummary) {
    logHudError(`collector:${name}`, error);
  }
  return {
    status: 'error',
    lastAttemptAt: previous?.lastAttemptAt ?? new Date(),
    lastSuccessAt: previous?.lastSuccessAt,
    errorSummary,
    ...(errorKind ? { errorKind } : {}),
  };
}
