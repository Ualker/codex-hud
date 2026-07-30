/**
 * Codex config.toml parser
 * Reads configuration from ~/.codex/config.toml
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import type {
  CodexConfig,
  FastModeState,
  McpServerConfig,
  PermissionState,
} from '../types.js';
import { getCodexHome } from '../utils/codex-path.js';

/**
 * Get the path to config.toml
 */
export function getConfigPath(): string {
  return path.join(getCodexHome(), 'config.toml');
}

function optionalString(
  parsed: Record<string, unknown>,
  key: string
): string | undefined {
  const value = parsed[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Codex config ${key} must be a string.`);
  }
  return value;
}

/**
 * Read and parse the Codex config.toml file, preserving parse errors for
 * callers that maintain a last-good snapshot.
 */
export function readCodexConfigStrict(): CodexConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = TOML.parse(content) as Record<string, unknown>;

  return {
    model: optionalString(parsed, 'model'),
    model_reasoning_effort: optionalString(
      parsed,
      'model_reasoning_effort'
    ),
    model_provider: optionalString(parsed, 'model_provider'),
    service_tier: optionalString(parsed, 'service_tier'),
    hooks:
      typeof parsed.hooks === 'boolean'
        ? parsed.hooks
        : undefined,
    approval_policy: optionalString(parsed, 'approval_policy'),
    sandbox_mode: optionalString(parsed, 'sandbox_mode'),
    mcp_servers: parseMcpServers(parsed.mcp_servers),
  };
}

/**
 * Backward-compatible best-effort reader.
 */
export function readCodexConfig(): CodexConfig {
  try {
    return readCodexConfigStrict();
  } catch {
    return {};
  }
}

/**
 * Parse MCP servers configuration
 */
function parseMcpServers(
  raw: unknown
): Record<string, McpServerConfig> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  
  const servers: Record<string, McpServerConfig> = {};
  
  for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
    if (config && typeof config === 'object') {
      const serverConfig = config as Record<string, unknown>;
      servers[name] = {
        command: serverConfig.command as string[] | undefined,
        url: serverConfig.url as string | undefined,
        enabled: serverConfig.enabled !== false, // Default to true
      };
    }
  }
  
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/**
 * Get a display-friendly model name
 */
export function getModelDisplayName(config: CodexConfig): string {
  if (config.model) {
    // Shorten common model names
    const model = config.model;
    if (model.startsWith('gpt-5')) return model;
    if (model.startsWith('gpt-4')) return model;
    if (model.startsWith('o1')) return model;
    if (model.startsWith('o3')) return model;
    if (model.startsWith('codex')) return model;
    return model;
  }
  return 'default';
}

/**
 * Get MCP server count
 */
export function getMcpServerCount(config: CodexConfig): number {
  if (!config.mcp_servers) return 0;
  return Object.values(config.mcp_servers).filter(s => s.enabled !== false).length;
}

/**
 * Get approval policy display name
 */
export function getApprovalPolicyDisplay(
  config: CodexConfig,
  runtime?: PermissionState
): string {
  const approvalPolicy = runtime?.approvalPolicy ?? config.approval_policy;
  const sandboxMode = runtime?.sandboxMode ?? config.sandbox_mode;

  if (!approvalPolicy || approvalPolicy === 'untrusted' || approvalPolicy === 'on-request') {
    return 'ask for approval';
  }

  if (approvalPolicy === 'never' && sandboxMode === 'danger-full-access') {
    return 'full access';
  }

  if (approvalPolicy === 'on-failure' || approvalPolicy === 'never') {
    return 'approve for me';
  }

  return 'unknown';
}

/**
 * Get the fast-mode display from the latest runtime service tier or config fallback.
 */
export function getFastModeDisplay(
  config: CodexConfig,
  runtime?: FastModeState
): string {
  const serviceTier = runtime?.serviceTier !== undefined
    ? runtime.serviceTier
    : config.service_tier;
  return serviceTier === 'priority' || serviceTier === 'fast' ? 'Fast: on' : 'Fast: off';
}
