import { parentPort } from 'node:worker_threads';
import { readCodexConfigStrict } from './codex-config.js';
import { collectProjectInfo } from './project.js';
import type { CodexConfig } from '../types.js';

interface SlowProjectRequest {
  id: number;
  cwd: string;
  runtimeHookOverrides: string[];
  runtimeHooksEnabled: boolean | null;
  forceAssetRefresh: boolean;
  fallbackConfig: CodexConfig;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

if (!parentPort) {
  throw new Error('slow-project-worker must run inside a Worker thread');
}

parentPort.on('message', (request: SlowProjectRequest) => {
  try {
    let config: CodexConfig;
    let configError: string | undefined;
    try {
      config = readCodexConfigStrict();
    } catch (error) {
      config = request.fallbackConfig ?? {};
      configError = errorMessage(error);
    }
    const project = collectProjectInfo(request.cwd, config, {
      runtimeHookOverrides: request.runtimeHookOverrides,
      runtimeHooksEnabled: request.runtimeHooksEnabled,
      forceAssetRefresh: request.forceAssetRefresh,
    });
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      snapshot: {
        config,
        project,
        collectedAt: new Date(),
        configError,
      },
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: errorMessage(error),
    });
  }
});
