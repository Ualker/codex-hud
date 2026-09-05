/**
 * The slow project collectors (config.toml, skills, hooks, AGENTS.md, rules),
 * run in-process on the async filesystem API.
 *
 * They used to run in a worker thread, which cost a second V8 isolate per
 * HUD — measured 14.5MB of a 62-77MB RSS — to keep a synchronous directory
 * walk off the render loop. The walk itself is a few hundred stats and reads
 * (240-460ms of wall time on this loaded machine, once a minute), so with
 * every call awaited the event loop stays free between them and the isolate
 * buys nothing.
 */

import type { CodexConfig, ProjectInfo } from '../types.js';
import { readCodexConfigStrictAsync } from './codex-config.js';
import { collectProjectInfo } from './project.js';

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

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

/**
 * Collect one snapshot. A config that fails to parse keeps `fallbackConfig`
 * (the caller's last good one) and reports the error; the project counts are
 * collected regardless, since they do not depend on the config parsing.
 */
export async function collectSlowProjectSnapshot(
  cwd: string,
  options: SlowProjectCollectOptions = {},
  fallbackConfig: CodexConfig = {}
): Promise<SlowProjectSnapshot> {
  let config: CodexConfig;
  let configError: string | undefined;
  try {
    config = await readCodexConfigStrictAsync();
  } catch (error) {
    config = fallbackConfig;
    configError = errorMessage(error);
  }
  const project = await collectProjectInfo(cwd, config, {
    runtimeHookOverrides: [...new Set(options.runtimeHookOverrides ?? [])],
    runtimeHooksEnabled: options.runtimeHooksEnabled ?? null,
    forceAssetRefresh: options.forceAssetRefresh ?? false,
  });
  return {
    config,
    project,
    collectedAt: new Date(),
    configError,
  };
}
