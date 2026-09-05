/**
 * Project information collector
 * Phase 3: Extended with INSTRUCTIONS.md count, rules count, MCP count
 *
 * Async throughout: it runs in the HUD process now (see slow-project.ts),
 * so no call here may block the render loop.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { ProjectInfo, CodexConfig } from '../types.js';
import { getConfigPath, getMcpServerCount } from './codex-config.js';
import { collectCodexAssetBreakdown } from './codex-assets.js';

export interface ProjectCollectionOptions {
  runtimeHookOverrides?: readonly string[];
  runtimeHooksEnabled?: boolean | null;
  forceAssetRefresh?: boolean;
}

const AGENTS_MD_FILENAMES = [
  'AGENTS.md',
  'agents.md',
  'CODEX.md',
  'codex.md',
];

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the project name from the current directory
 * Tries git remote first, then falls back to folder name
 */
export function getProjectName(cwd: string): string {
  // Just use the folder name
  return path.basename(cwd);
}

/**
 * Count files matching a list of filenames in a directory tree
 * Searches from cwd up to git root or filesystem root
 */
async function countFilesInTree(
  cwd: string,
  filenames: string[],
  checkCodexDir: boolean = true
): Promise<number> {
  let count = 0;
  let currentDir = cwd;
  const visited = new Set<string>();

  // Walk up the directory tree
  while (currentDir && !visited.has(currentDir)) {
    visited.add(currentDir);

    // Check for files in current directory
    for (const filename of filenames) {
      if (await pathExists(path.join(currentDir, filename))) {
        count++;
        break; // Only count one per directory
      }
    }

    // Check in .codex subdirectory too
    if (checkCodexDir) {
      const codexDir = path.join(currentDir, '.codex');
      if (await isDirectory(codexDir)) {
        for (const filename of filenames) {
          if (await pathExists(path.join(codexDir, filename))) {
            count++;
            break;
          }
        }
      }
    }

    // Stop at git root or filesystem root
    if (await pathExists(path.join(currentDir, '.git'))) {
      break;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parent;
  }

  return count;
}

/**
 * Count AGENTS.md files in the directory tree
 * Searches from cwd up to git root or filesystem root
 */
export function countAgentsMdFiles(cwd: string): Promise<number> {
  return countFilesInTree(cwd, AGENTS_MD_FILENAMES, true);
}

/**
 * Count rule files in .codex/rules directory
 */
export async function countRulesFiles(cwd: string): Promise<number> {
  const rulesDir = path.join(cwd, '.codex', 'rules');
  if (!(await isDirectory(rulesDir))) {
    return 0;
  }
  try {
    const files = await fs.readdir(rulesDir);
    return files.filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Count configuration files in .codex directory
 * Counts: config.toml, config.json, *.toml, *.json
 */
export async function countConfigFiles(cwd: string): Promise<number> {
  const codexDir = path.join(cwd, '.codex');
  if (!(await isDirectory(codexDir))) {
    return 0;
  }
  try {
    const files = await fs.readdir(codexDir);
    return files.filter(
      (f) =>
        f.endsWith('.toml') ||
        f.endsWith('.json') ||
        f === 'config' ||
        f === 'settings'
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Collect all project information
 * Phase 3: Extended with additional file counts and Codex-specific module status
 */
export async function collectProjectInfo(
  cwd?: string,
  config?: CodexConfig,
  options: ProjectCollectionOptions = {}
): Promise<ProjectInfo> {
  const workDir = cwd || process.cwd();

  // Count config files in .codex directory
  const configsCount = await countConfigFiles(workDir);

  // Count extensions (MCP servers count as extensions)
  const mcpCount = config ? getMcpServerCount(config) : 0;
  const assetCounts = await collectCodexAssetBreakdown(workDir, process.env, config, {
    forceRefresh: options.forceAssetRefresh,
    runtimeHookOverrides: options.runtimeHookOverrides,
    runtimeHooksEnabled: options.runtimeHooksEnabled,
  });

  return {
    cwd: workDir,
    projectName: getProjectName(workDir),
    agentsMdCount: await countAgentsMdFiles(workDir),
    rulesCount: await countRulesFiles(workDir),
    mcpCount,
    configsCount,
    extensionsCount: mcpCount,  // Legacy alias; rendered as "MCP configured".
    skillsCount: assetCounts.codexSkillsCount,
    otherAgentSkillsCount: assetCounts.otherAgentSkillsCount,
    hooksCount: assetCounts.hooksCount,
    globalConfigActive: await pathExists(getConfigPath()),
  };
}
