import type { CollectorHealth } from '../types.js';

export interface AsyncSnapshotCacheOptions {
  ttlMs: number;
  staleAfterMs?: number;
  /**
   * Minimum delay between attempts while the last refresh failed. Defaults
   * to min(ttlMs, 15s): persistent failures stop retrying on every caller
   * tick, without stretching recovery to a long success TTL.
   */
  errorRetryMs?: number;
  now?: () => number;
}

function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 180);
}

/**
 * Keeps slow collectors out of the render path. Refreshes are deduplicated,
 * failures retain the last good snapshot, and consumers can expose freshness.
 */
export class AsyncSnapshotCache<T> {
  private value: T;
  private lastAttemptAtMs = 0;
  private lastSuccessAtMs = 0;
  private lastError: string | undefined;
  private inFlight: Promise<T> | null = null;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly errorRetryMs: number;

  constructor(
    initialValue: T,
    private readonly loader: () => Promise<T>,
    private readonly options: AsyncSnapshotCacheOptions
  ) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError('Async snapshot cache ttlMs must be non-negative.');
    }
    this.value = initialValue;
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? Math.max(options.ttlMs * 2, 1);
    this.errorRetryMs = options.errorRetryMs ?? Math.min(options.ttlMs, 15_000);
  }

  get(): T {
    return this.value;
  }

  refresh(force: boolean = false): Promise<T> {
    const now = this.now();
    if (!force) {
      if (this.lastError === undefined) {
        if (
          this.lastSuccessAtMs > 0 &&
          now - this.lastSuccessAtMs < this.options.ttlMs
        ) {
          return Promise.resolve(this.value);
        }
      } else if (now - this.lastAttemptAtMs < this.errorRetryMs) {
        // Failed collectors retry on their own cadence instead of on every
        // caller tick; the retained last-good snapshot keeps serving reads.
        return Promise.resolve(this.value);
      }
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.lastAttemptAtMs = now;
    const request = this.loader()
      .then((value) => {
        this.value = value;
        this.lastSuccessAtMs = this.now();
        this.lastError = undefined;
        return value;
      })
      .catch((error: unknown) => {
        this.lastError = errorSummary(error);
        throw error;
      })
      .finally(() => {
        if (this.inFlight === request) {
          this.inFlight = null;
        }
      });
    this.inFlight = request;
    return request;
  }

  getHealth(): CollectorHealth {
    const now = this.now();
    // A collector that has never succeeded is not stale, it is uninitialized:
    // "never refreshed" and "stopped refreshing" need different words because
    // only the second one is a fault the user can act on.
    const status =
      this.lastError !== undefined
        ? 'error'
        : this.lastSuccessAtMs === 0
          ? 'pending'
          : now - this.lastSuccessAtMs > this.staleAfterMs
            ? 'stale'
            : 'fresh';

    return {
      status,
      lastAttemptAt: new Date(this.lastAttemptAtMs || now),
      lastSuccessAt:
        this.lastSuccessAtMs > 0
          ? new Date(this.lastSuccessAtMs)
          : undefined,
      errorSummary: this.lastError,
    };
  }
}
