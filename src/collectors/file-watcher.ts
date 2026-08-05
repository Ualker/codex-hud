/**
 * File watcher for monitoring config and rollout file changes
 * Uses chokidar for efficient file system watching
 */

import { watch, type FSWatcher } from 'chokidar';
import * as path from 'path';
import { getCodexHome, getSessionsDir } from '../utils/codex-path.js';
import { logHudError } from '../utils/hud-log.js';

function reportWatcherError(scope: string, error: unknown): void {
  // Never console.error: stderr lands inside the rendered HUD frame.
  logHudError(scope, error);
}

export type FileChangeCallback = (
  path: string,
  event: 'add' | 'change' | 'unlink'
) => void | Promise<void>;

/**
 * File watcher with cleanup support
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: FileChangeCallback[] = [];

  constructor(
    private paths: string[],
    private options: {
      usePolling?: boolean;
      /** Only notify callbacks for paths accepted by this predicate. */
      filter?: (filePath: string) => boolean;
    } = {}
  ) {}

  /**
   * Start watching files
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.paths, {
      persistent: true,
      ignoreInitial: true,
      usePolling: this.options.usePolling ?? false,
      interval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('error', (error) => {
      reportWatcherError('File watcher error', error);
    });
    this.watcher.on('add', (filePath) => this.notifyCallbacks(filePath, 'add'));
    this.watcher.on('change', (filePath) => this.notifyCallbacks(filePath, 'change'));
    this.watcher.on('unlink', (filePath) => this.notifyCallbacks(filePath, 'unlink'));
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Add a callback for file changes
   */
  onChange(callback: FileChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Add a new path to watch
   */
  add(filePath: string): void {
    if (this.watcher) {
      this.watcher.add(filePath);
    }
  }

  /**
   * Remove a path from watching
   */
  unwatch(filePath: string): void {
    if (this.watcher) {
      this.watcher.unwatch(filePath);
    }
  }

  private notifyCallbacks(filePath: string, event: 'add' | 'change' | 'unlink'): void {
    if (this.options.filter && !this.options.filter(filePath)) {
      return;
    }
    for (const callback of this.callbacks) {
      try {
        void Promise.resolve(callback(filePath, event)).catch((error) => {
          reportWatcherError('File watcher callback failed', error);
        });
      } catch (error) {
        reportWatcherError('File watcher callback failed', error);
      }
    }
  }
}

/**
 * Create a watcher for the Codex config file
 */
export function createConfigWatcher(): FileWatcher {
  const configPath = path.join(getCodexHome(), 'config.toml');
  return new FileWatcher([configPath]);
}

const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/;

/**
 * Create a watcher for session rollout files.
 *
 * chokidar 4+ removed glob support, so globs are treated as literal paths and
 * never match. Watch the sessions root directory and filter rollout files by
 * name instead. Watching the root (not today's dir, which the previous
 * implementation froze at construction time) also keeps the watcher valid
 * across midnight.
 */
export function createSessionWatcher(): FileWatcher {
  return new FileWatcher([getSessionsDir()], {
    filter: (filePath) => ROLLOUT_FILE_PATTERN.test(path.basename(filePath)),
  });
}

/**
 * Create a watcher for shell snapshots.
 */
export function createShellSnapshotWatcher(): FileWatcher {
  const snapshotsDir = path.join(getCodexHome(), 'shell_snapshots');
  return new FileWatcher([snapshotsDir], {
    filter: (filePath) => filePath.endsWith('.sh'),
  });
}

/**
 * Unified watcher manager for all HUD-related file monitoring
 */
export class HudFileWatcher {
  private configWatcher: FileWatcher;
  private sessionWatcher: FileWatcher | null = null;
  private shellSnapshotWatcher: FileWatcher | null = null;
  private rolloutWatcher: FileWatcher | null = null;
  private currentRolloutPath: string | null = null;

  private onConfigChangeCallbacks: (() => void | Promise<void>)[] = [];
  private onRolloutChangeCallbacks: ((path: string) => void | Promise<void>)[] = [];

  constructor() {
    this.configWatcher = createConfigWatcher();
    this.configWatcher.onChange(() => {
      this.notifyConfigChange();
    });
  }

  /**
   * Start all watchers
   */
  start(): void {
    this.configWatcher.start();
    this.startSessionWatcher();
  }

  /**
   * Stop all watchers
   */
  async stop(): Promise<void> {
    await this.configWatcher.stop();
    await this.sessionWatcher?.stop();
    await this.shellSnapshotWatcher?.stop();
    await this.rolloutWatcher?.stop();
  }

  /**
   * Set the specific rollout file to watch
   */
  setRolloutPath(rolloutPath: string | null): void {
    if (this.currentRolloutPath === rolloutPath) {
      return;
    }

    // Stop existing rollout watcher
    if (this.rolloutWatcher) {
      void this.rolloutWatcher.stop().catch((error) => {
        reportWatcherError('HUD rollout watcher stop failed', error);
      });
      this.rolloutWatcher = null;
    }

    this.currentRolloutPath = rolloutPath;

    if (!rolloutPath) {
      return;
    }

    // Create new watcher for this specific file
    this.rolloutWatcher = new FileWatcher([rolloutPath], { usePolling: true });
    this.rolloutWatcher.onChange((filePath) => {
      this.notifyRolloutChange(filePath);
    });
    this.rolloutWatcher.start();
  }

  /**
   * Register callback for config changes
   */
  onConfigChange(callback: () => void | Promise<void>): void {
    this.onConfigChangeCallbacks.push(callback);
  }

  /**
   * Register callback for rollout file changes
   */
  onRolloutChange(callback: (path: string) => void | Promise<void>): void {
    this.onRolloutChangeCallbacks.push(callback);
  }

  private startSessionWatcher(): void {
    this.sessionWatcher = createSessionWatcher();
    this.sessionWatcher.onChange((filePath, event) => {
      // New rollout file added - could be a new session starting
      if (event === 'add' && filePath.includes('rollout-')) {
        // Notify so the main app can check if this is a more recent session
        this.notifyRolloutChange(filePath);
      }
    });
    this.sessionWatcher.start();

    this.shellSnapshotWatcher = createShellSnapshotWatcher();
    this.shellSnapshotWatcher.onChange((filePath) => {
      this.notifyRolloutChange(filePath);
    });
    this.shellSnapshotWatcher.start();
  }

  private notifyConfigChange(): void {
    for (const callback of this.onConfigChangeCallbacks) {
      try {
        void Promise.resolve(callback()).catch((error) => {
          reportWatcherError('HUD config watcher callback failed', error);
        });
      } catch (error) {
        reportWatcherError('HUD config watcher callback failed', error);
      }
    }
  }

  private notifyRolloutChange(path: string): void {
    for (const callback of this.onRolloutChangeCallbacks) {
      try {
        void Promise.resolve(callback(path)).catch((error) => {
          reportWatcherError('HUD rollout watcher callback failed', error);
        });
      } catch (error) {
        reportWatcherError('HUD rollout watcher callback failed', error);
      }
    }
  }
}
