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
 * Chokidar 4+ has no FSEvents backend, so on macOS every watched file and
 * directory holds one kqueue file descriptor. Watching the sessions root
 * unscoped therefore scales with the entire rollout history (measured ~1400
 * fds on a months-old install) and grows by one fd per new rollout forever.
 * New rollouts only ever appear under the current date directory, so date
 * directories that ended before this window are pruned from the watch tree
 * (an ignored directory is never descended into). The window covers today
 * and yesterday including timezone slack; the predicate re-evaluates against
 * the current clock, so the directory of a new day is admitted when it
 * appears.
 */
const SESSION_DATE_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Latest instant covered by a YYYY[/MM[/DD]] prefix, in local time. */
function latestMsForDatePrefix(parts: readonly number[]): number {
  const [year, month, day] = parts;
  if (parts.length === 1) {
    return new Date(year + 1, 0, 1).getTime();
  }
  if (parts.length === 2) {
    return new Date(year, month, 1).getTime();
  }
  return new Date(year, month - 1, day + 1).getTime();
}

/**
 * True when targetPath is a date directory (relative to rootDir) whose whole
 * range ended before the active window. Files and unrecognized names are
 * never stale: their parent directory already made the decision.
 */
export function isStaleSessionDatePath(
  rootDir: string,
  targetPath: string,
  nowMs: number = Date.now()
): boolean {
  const relative = path.relative(rootDir, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const segments = relative.split(path.sep);
  if (segments.length > 3) {
    return false;
  }

  const dateParts: number[] = [];
  for (const segment of segments) {
    if (!/^\d{1,4}$/.test(segment)) {
      return false;
    }
    dateParts.push(Number(segment));
  }

  return (
    latestMsForDatePrefix(dateParts) < nowMs - SESSION_DATE_ACTIVE_WINDOW_MS
  );
}

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
      /** Paths (including directories) chokidar must not watch or descend into. */
      ignored?: (filePath: string) => boolean;
      /**
       * Debounce events until the file stops growing. Rollout JSONL is
       * appended continuously and every consumer tolerates a partial last
       * line via committed-offset reads, so for those the debounce only
       * delayed events and stat-polled every growing file at 50ms. A
       * half-written config.toml, in contrast, parses as an error frame,
       * so the config watcher opts in.
       */
      awaitWriteFinish?: boolean;
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
      ...(this.options.ignored ? { ignored: this.options.ignored } : {}),
      ...(this.options.awaitWriteFinish
        ? {
            awaitWriteFinish: {
              stabilityThreshold: 100,
              pollInterval: 50,
            },
          }
        : {}),
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
  return new FileWatcher([configPath], { awaitWriteFinish: true });
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
  const sessionsDir = getSessionsDir();
  return new FileWatcher([sessionsDir], {
    filter: (filePath) => ROLLOUT_FILE_PATTERN.test(path.basename(filePath)),
    ignored: (filePath) => isStaleSessionDatePath(sessionsDir, filePath),
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

    // Create new watcher for this specific file. fs.watch (kqueue on macOS)
    // reports an append the moment it lands; the previous one-second stat
    // poll put up to a second between Codex writing a record and the HUD
    // learning of it, on top of the render tick. The two-second stat sweep
    // in index.ts remains the safety net for the mounts fs.watch cannot see.
    this.rolloutWatcher = new FileWatcher([rolloutPath], { usePolling: false });
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
