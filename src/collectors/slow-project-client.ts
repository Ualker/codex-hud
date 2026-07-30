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

export class SlowProjectWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private lastGoodConfig: CodexConfig = {};
  private workerFailure: Error | null = null;
  private nextRequestId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker(
      new URL('./slow-project-worker.js', import.meta.url)
    );
    this.worker.on('message', (response: WorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok && response.snapshot) {
        if (!response.snapshot.configError) {
          this.lastGoodConfig = response.snapshot.config;
        }
        pending.resolve(response.snapshot);
      } else {
        pending.reject(
          new Error(response.error || 'Slow project worker failed')
        );
      }
    });
    this.worker.on('error', (error) => {
      this.workerFailure = error;
      this.rejectAll(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed) {
        const error =
          this.workerFailure ??
          new Error(`Slow project worker exited with code ${code}`);
        this.workerFailure = error;
        this.rejectAll(error);
      }
    });
  }

  collect(
    cwd: string,
    options: SlowProjectCollectOptions = {}
  ): Promise<SlowProjectSnapshot> {
    if (this.closed) {
      return Promise.reject(new Error('Slow project worker is closed'));
    }
    if (this.workerFailure) {
      return Promise.reject(this.workerFailure);
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({
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
    await this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
