/**
 * Collect effective Codex skills and hooks without starting app-server.
 *
 * Async throughout: this runs in the HUD process (see slow-project.ts), and
 * the walk is a few hundred stats and reads that must not block the render
 * loop between them.
 */

import { promises as fs, type Dirent } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import type { CodexConfig } from '../types.js';

export interface CodexAssetCounts {
  skillsCount: number;
  hooksCount: number;
}

export interface CodexAssetBreakdown {
  codexSkillsCount: number;
  otherAgentSkillsCount: number;
  hooksCount: number;
}

export interface CodexAssetCollectionOptions {
  forceRefresh?: boolean;
  runtimeHookOverrides?: readonly string[];
  runtimeHooksEnabled?: boolean | null;
}

const ASSET_CACHE_TTL_MS = 60_000;
const assetCache = new Map<
  string,
  { checkedAt: number; breakdown: CodexAssetBreakdown }
>();

type AssetEnvironment = NodeJS.ProcessEnv;

interface SkillManifest {
  name: string;
  enabled: boolean;
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function existingDirectory(candidate: string | undefined): Promise<string | null> {
  if (!candidate) return null;
  try {
    return (await fs.stat(candidate)).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

async function existingFile(candidate: string | undefined): Promise<string | null> {
  if (!candidate) return null;
  try {
    return (await fs.stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function ancestorDirectories(cwd: string): Promise<string[]> {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    if (await pathExists(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function parseSkillManifest(filePath: string): Promise<SkillManifest | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  let name = '';
  let enabled = true;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.includes(':') ? ':' : '=';
    const index = line.indexOf(separator);
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = parseScalar(line.slice(index + 1));
    if (key === 'name') {
      name = value;
    } else if (key === 'enabled') {
      if (value === 'true') enabled = true;
      else if (value === 'false') enabled = false;
      else return null;
    }
  }

  if (!name) return null;
  return { name, enabled };
}

async function skillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop() as string;
    const resolved = await canonicalPath(current);
    if (visited.has(resolved)) continue;
    visited.add(resolved);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === 'SKILL.md') {
        files.push(entryPath);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (await existingDirectory(entryPath)) pending.push(entryPath);
      }
    }
  }

  return files;
}

async function collectSkillCount(roots: string[]): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  for (const root of roots) {
    if (!(await existingDirectory(root))) continue;
    for (const filePath of await skillFiles(root)) {
      const key = await canonicalPath(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      const manifest = await parseSkillManifest(filePath);
      if (manifest?.enabled) count++;
    }
  }
  return count;
}

function hookIdentity(eventName: string, entry: Record<string, unknown>): string {
  const identity = entry.sourcePath
    ?? entry.path
    ?? entry.command
    ?? entry.script
    ?? entry.handler
    ?? entry.handlerType;
  return `${eventName}:${typeof identity === 'string' ? identity : JSON.stringify(identity ?? entry)}`;
}

function looksLikeHookEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.some((key) => [
    'command',
    'script',
    'handler',
    'handlerType',
    'source',
    'sourcePath',
    'path',
    'executable',
    'url',
    'name',
    'type',
  ].includes(key));
}

function collectHookEntries(
  value: unknown,
  eventName: string,
  output: Array<{ eventName: string; entry: Record<string, unknown> }>
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikeHookEntry(item)) output.push({ eventName, entry: item });
      else collectHookEntries(item, eventName, output);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'hooks') collectHookEntries(child, eventName, output);
    else collectHookEntries(child, key, output);
  }
}

function addParsedHookEntries(
  parsed: unknown,
  seenEntries: Set<string>
): number {
  const entries: Array<{ eventName: string; entry: Record<string, unknown> }> = [];
  collectHookEntries(parsed, '', entries);

  let added = 0;
  for (const { eventName, entry } of entries) {
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') continue;
    if (entry.enabled === false) continue;
    const key = hookIdentity(eventName, entry);
    if (seenEntries.has(key)) continue;
    seenEntries.add(key);
    added++;
  }
  return added;
}

function runtimeHookFallback(override: string): {
  eventName: string;
  entry: Record<string, unknown>;
} | null {
  const match = /^hooks\.([A-Za-z][A-Za-z0-9_-]*)\s*=/.exec(override);
  if (!match) return null;
  return {
    eventName: match[1],
    entry: { handler: `runtime-config:${override}` },
  };
}

async function collectHookCount(
  files: string[],
  runtimeHookOverrides: readonly string[] = []
): Promise<number> {
  const seenFiles = new Set<string>();
  const seenEntries = new Set<string>();
  let count = 0;

  for (const filePath of files) {
    const existing = await existingFile(filePath);
    if (!existing) continue;
    const canonical = await canonicalPath(existing);
    if (seenFiles.has(canonical)) continue;
    seenFiles.add(canonical);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(existing, 'utf8'));
    } catch {
      continue;
    }

    count += addParsedHookEntries(parsed, seenEntries);
  }

  for (const override of new Set(runtimeHookOverrides)) {
    try {
      count += addParsedHookEntries(TOML.parse(override), seenEntries);
    } catch {
      // A platform-specific `ps` representation can make the TOML fragment
      // incomplete. Keep the event visible without exposing or executing it.
      const fallback = runtimeHookFallback(override);
      if (fallback) {
        const key = hookIdentity(fallback.eventName, fallback.entry);
        if (!seenEntries.has(key)) {
          seenEntries.add(key);
          count++;
        }
      }
    }
  }

  return count;
}

async function resolveOptionalRoot(env: AssetEnvironment, key: string): Promise<string | null> {
  const value = env[key];
  if (!value) return null;
  return (await existingDirectory(value)) ?? (await existingFile(value));
}

/**
 * Count enabled skills and hooks for the current cwd and configured scopes.
 */
export async function collectCodexAssetCounts(
  cwd: string,
  env: AssetEnvironment = process.env,
  config?: CodexConfig,
  options: CodexAssetCollectionOptions = {}
): Promise<CodexAssetCounts> {
  const breakdown = await collectCodexAssetBreakdown(cwd, env, config, options);
  return {
    skillsCount:
      breakdown.codexSkillsCount + breakdown.otherAgentSkillsCount,
    hooksCount: breakdown.hooksCount,
  };
}

/**
 * Keep Codex-authoritative skills separate from `.agents` copies owned by
 * other Agent runtimes. The legacy aggregate remains available above.
 */
export async function collectCodexAssetBreakdown(
  cwd: string,
  env: AssetEnvironment = process.env,
  config?: CodexConfig,
  options: CodexAssetCollectionOptions = {}
): Promise<CodexAssetBreakdown> {
  const runtimeHookOverrides = [...new Set(options.runtimeHookOverrides ?? [])].sort();
  const runtimeHooksEnabled = options.runtimeHooksEnabled ?? null;
  const hooksEnabled = runtimeHooksEnabled ?? (config?.hooks !== false);
  const cacheKey = JSON.stringify({
    cwd: path.resolve(cwd),
    codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    systemSkills: env.CODEX_SYSTEM_SKILLS_DIR || null,
    adminSkills: env.CODEX_ADMIN_SKILLS_DIR || null,
    systemHooks: env.CODEX_SYSTEM_HOOKS_FILE || null,
    adminHooks: env.CODEX_ADMIN_HOOKS_FILE || null,
    hooksEnabled,
    runtimeHooksEnabled,
    runtimeHookOverrides,
  });
  const now = Date.now();
  const cached = assetCache.get(cacheKey);
  if (!options.forceRefresh && cached && now - cached.checkedAt < ASSET_CACHE_TTL_MS) {
    return cached.breakdown;
  }

  const ancestors = await ancestorDirectories(cwd);
  const codexSkillsRoots: string[] = [];
  const otherAgentSkillsRoots: string[] = [];
  const hooksFiles: string[] = [];

  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  codexSkillsRoots.push(path.join(codexHome, 'skills'));
  hooksFiles.push(path.join(codexHome, 'hooks.json'));

  for (const directory of ancestors) {
    otherAgentSkillsRoots.push(path.join(directory, '.agents', 'skills'));
    codexSkillsRoots.push(path.join(directory, '.codex', 'skills'));
    hooksFiles.push(path.join(directory, '.agents', 'hooks.json'));
    hooksFiles.push(path.join(directory, '.codex', 'hooks.json'));
  }

  for (const key of ['CODEX_SYSTEM_SKILLS_DIR', 'CODEX_ADMIN_SKILLS_DIR']) {
    const root = await resolveOptionalRoot(env, key);
    if (root) codexSkillsRoots.push(root);
  }
  for (const key of ['CODEX_SYSTEM_HOOKS_FILE', 'CODEX_ADMIN_HOOKS_FILE']) {
    const file = await resolveOptionalRoot(env, key);
    if (file) hooksFiles.push(file);
  }

  const breakdown = {
    codexSkillsCount: await collectSkillCount(codexSkillsRoots),
    otherAgentSkillsCount: await collectSkillCount(otherAgentSkillsRoots),
    hooksCount: await collectHookCount(
      hooksEnabled ? hooksFiles : [],
      hooksEnabled ? runtimeHookOverrides : []
    ),
  };
  assetCache.set(cacheKey, { checkedAt: now, breakdown });
  return breakdown;
}

export function invalidateCodexAssetCache(): void {
  assetCache.clear();
}
