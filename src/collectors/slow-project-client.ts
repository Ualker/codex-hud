import { Worker } from 'node:worker_threads';
import type { CodexConfig, ProjectInfo } from '../types.js';

export interface SlowProjectSnapshot {
  config: CodexConfig;
  project: ProjectInfo;
  collectedAt: Date;
  configError?: string;
}

export interface SlowProjectCollectOptions {
  runtimeHookOverrides?: readonly string[];
  runtimeHooksEnabled?: boolean | null;
  forceAssetRefresh?: boolean;
}

export interface SlowProjectWorkerClientOptions {
  /** Respawn backoff bounds; overridable for tests. */
  respawnBackoffMinMs?: number;
  respawnBackoffMaxMs?: number;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  snapshot?: SlowProjectSnapshot;
  error?: string;
}

interface PendingRequest {
  resolve: (snapshot: SlowProjectSnapshot) => void;
  reject: (error: Error) => void;
}

// A crashed worker used to disable the collector for the rest of the HUD's
// lifetime; instead it is respawned on demand behind a bounded backoff.
const RESPAWN_BACKOFF_MIN_MS = 1000;
const RESPAWN_BACKOFF_MAX_MS = 30_000;

export class SlowProjectWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private lastGoodConfig: CodexConfig = {};
  private workerFailure: Error | null = null;
  private nextRequestId = 1;
  private closed = false;
  private respawnBackoffMs = 0;
  private nextRespawnAtMs = 0;
  private readonly respawnBackoffMinMs: number;
  private readonly respawnBackoffMaxMs: number;

  constructor(options: SlowProjectWorkerClientOptions = {}) {
    this.respawnBackoffMinMs =
      options.respawnBackoffMinMs ?? RESPAWN_BACKOFF_MIN_MS;
    this.respawnBackoffMaxMs =
      options.respawnBackoffMaxMs ?? RESPAWN_BACKOFF_MAX_MS;
    this.spawnWorker();
  }

  private spawnWorker(): void {
    const worker = new Worker(
      new URL('./slow-project-worker.js', import.meta.url)
    );
    this.worker = worker;
    worker.on('message', (response: WorkerResponse) => {
      if (this.worker !== worker) {
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok && response.snapshot) {
        if (!response.snapshot.configError) {
          this.lastGoodConfig = response.snapshot.config;
        }
        // A served request proves the worker is healthy again.
        this.workerFailure = null;
        this.respawnBackoffMs = 0;
        pending.resolve(response.snapshot);
      } else {
        pending.reject(
          new Error(response.error || 'Slow project worker failed')
        );
      }
    });
    worker.on('error', (error) => {
      this.handleWorkerDown(worker, error);
    });
    worker.on('exit', (code) => {
      if (!this.closed) {
        this.handleWorkerDown(
          worker,
          new Error(`Slow project worker exited with code ${code}`)
        );
      }
    });
  }

  /** A dead worker is replaced on the next collect once the backoff expires. */
  private handleWorkerDown(worker: Worker, error: Error): void {
    if (this.worker !== worker) {
      // Stale event from an already-replaced worker.
      return;
    }
    this.worker = null;
    this.workerFailure = error;
    this.respawnBackoffMs = Math.min(
      Math.max(this.respawnBackoffMs * 2, this.respawnBackoffMinMs),
      this.respawnBackoffMaxMs
    );
    this.nextRespawnAtMs = Date.now() + this.respawnBackoffMs;
    this.rejectAll(error);
  }

  collect(
    cwd: string,
    options: SlowProjectCollectOptions = {}
  ): Promise<SlowProjectSnapshot> {
    if (this.closed) {
      return Promise.reject(new Error('Slow project worker is closed'));
    }
    if (this.worker === null) {
      if (Date.now() < this.nextRespawnAtMs) {
        return Promise.reject(
          this.workerFailure ?? new Error('Slow project worker unavailable')
        );
      }
      this.spawnWorker();
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker?.postMessage({
          id,
          cwd,
          runtimeHookOverrides: [
            ...new Set(options.runtimeHookOverrides ?? []),
          ],
          runtimeHooksEnabled: options.runtimeHooksEnabled ?? null,
          forceAssetRefresh: options.forceAssetRefresh ?? false,
          fallbackConfig: this.lastGoodConfig,
        });
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error(String(error))
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAll(new Error('Slow project worker closed'));
    await this.worker?.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
