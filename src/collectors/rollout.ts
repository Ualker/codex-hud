/**
 * Rollout file parser for extracting tool activity and plan updates
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files
 */

import * as fs from 'fs';
import type {
  RolloutLine,
  ResponseItemPayload,
  EventMsgPayload,
  SessionMetaPayload,
  TurnContextPayload,
  ToolCall,
  ToolActivity,
  ToolResult,
  PlanProgress,
  PlanStep,
  ProtocolHealth,
  RateLimitSnapshot,
  SessionInfo,
  TokenUsageInfo,
  TurnActivity,
} from '../types.js';
import { readCompleteJsonl } from '../utils/jsonl-tail.js';
import { extractCommandHead } from '../utils/command-head.js';
import { EXECUTION_TOOL_NAMES } from '../utils/tool-names.js';

/**
 * Result of parsing a rollout file
 */
export interface RolloutParseResult {
  session: SessionInfo | null;
  toolActivity: ToolActivity;
  planProgress: PlanProgress | null;
  tokenUsage: TokenUsageInfo | null;
  rateLimits: RateLimitSnapshot | null;
  /**
   * When this session last observed the account's rate limits. Rate limits are
   * account state, so a snapshot from another session can be newer than this
   * one; comparing the two requires knowing when each was written.
   */
  rateLimitsAt: Date | null;
  turnActivity: TurnActivity | null;
  protocolHealth: ProtocolHealth;
  // Compact tracking. Codex writes each compaction BOTH as a top-level
  // `compacted` record and a `context_compacted` event (verified 1:1 across
  // 38 real rollouts), so the displayed count is the max of the two totals —
  // never their sum — which also stays correct for versions that write only
  // one of the record kinds.
  compactCount: number;
  compactTopLevelCount: number;
  compactEventCount: number;
  lastCompactTime: Date | null;
  // Activity timestamps
  lastToolActivityTime: Date | null;
  lastAssistantMessageTime: Date | null;
  lastEventTime: Date | null;
  /**
   * The first pass skipped the middle of a large rollout, so cumulative
   * counters (tool totals, compactions) are lower bounds. Sticky: once set it
   * survives every later incremental parse.
   */
  partialHistory: boolean;
}

export interface RolloutParseOutput {
  result: RolloutParseResult;
  newOffset: number;
  runningCalls: Map<string, ToolCall>;
  wasTruncated: boolean;
}

export function computeNextOffset(
  startOffset: number,
  bytesRead: number,
  latestSize: number
): number {
  return Math.min(latestSize, startOffset + bytesRead);
}

const MAX_TOOL_SUMMARY_LENGTH = 240;
const MAX_TOOL_TARGET_LENGTH = 80;
const MAX_WORKDIR_LENGTH = 512;
const MAX_TOOL_NAME_COMPONENT_LENGTH = 80;
const MAX_TOOL_CALL_ID_LENGTH = 512;

interface ToolDisplayDetails {
  summary?: string;
  workdir?: string;
  target?: string;
}

interface ToolCompletion {
  failed: boolean;
  result?: ToolResult;
}

interface CustomToolInvocation {
  name: string;
  openParenIndex: number;
}

function stripTerminalSequences(value: string): string {
  return value
    // OSC sequences terminated by BEL or ST.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // CSI sequences.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining C0 controls except whitespace normalized below.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    // Bidirectional override/isolate controls can visually reorder a command.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
}

function redactSensitiveText(value: string): string {
  let redacted = value;

  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    '$1***:***@'
  );
  redacted = redacted.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1 ***'
  );
  redacted = redacted.replace(
    /\b((?:[A-Za-z_][A-Za-z0-9_]*)(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie)(?:[A-Za-z0-9_]*))(\s*=\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    '$1$2***'
  );
  redacted = redacted.replace(
    /(--(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|client[-_]?secret|authorization|cookie|credential)(?:\s*=\s*|\s+))(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    '$1***'
  );
  redacted = redacted.replace(
    /((?:"|')?(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|client[-_]?secret|authorization|cookie|credential)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}]+)/gi,
    '$1***'
  );
  redacted = redacted.replace(
    /((?:authorization|proxy-authorization|cookie|x-api-key|api-key)\s*:\s*)(?:Bearer\s+|Basic\s+)?[^'"\s]+/gi,
    '$1***'
  );

  return redacted;
}

function sanitizeDisplayText(value: string, maxLength: number): string | undefined {
  // Tool inputs can contain large heredocs. Only a bounded prefix can ever be
  // rendered, so bound the work before applying the redaction expressions.
  const inputLimit = Math.max(4096, maxLength * 4);
  const boundedInput = value.length > inputLimit
    ? `${value.slice(0, inputLimit)}…`
    : value;
  const sanitized = redactSensitiveText(stripTerminalSequences(boundedInput))
    .replace(/[\r\n\t]+/g, ' ↵ ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseJsonValue(value?: string): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseArgumentsValue(
  value: ResponseItemPayload['arguments']
): unknown {
  if (typeof value === 'string') {
    return parseJsonValue(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const KNOWN_TOP_LEVEL_TYPES = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'compacted',
  'world_state',
]);

const KNOWN_RESPONSE_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
]);

const KNOWN_EVENT_TYPES = new Set([
  'plan_update',
  'token_count',
  'rate_limit',
  'context_compacted',
  'turn_started',
  'task_started',
  'task_complete',
  'turn_aborted',
  'agent_reasoning',
  'agent_message',
  'user_message',
  'thread_settings_applied',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  // Known low-signal event kinds intentionally ignored by the HUD.
  'patch_apply_begin',
  'patch_apply_end',
  'exec_command_begin',
  'exec_command_end',
  'view_image_tool_call',
  'web_search_begin',
  'web_search_end',
  // codex-cli 0.147+ unified thread-item stream: completed items
  // (AgentMessage/CommandExecution/Reasoning/UserMessage/...) duplicate the
  // response_item records this parser already consumes; SubAgentActivity
  // variants are consumed by the agent-activity collector.
  'item_completed',
  // Subagent spawn markers, consumed by the agent-activity collector.
  'sub_agent_activity',
]);

function incrementCounter(
  counters: Record<string, number>,
  key: string
): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

function mergeCounters(
  target: Record<string, number>,
  previous: Record<string, number>
): void {
  for (const [key, count] of Object.entries(previous)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

function asValidDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') {
    return fallback;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function parsePlanSteps(value: unknown): PlanStep[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.plan)) {
    return undefined;
  }

  const steps: PlanStep[] = [];
  for (const candidate of value.plan) {
    if (!isRecord(candidate)) {
      return undefined;
    }
    const rawStep = stringValue(candidate.step);
    const step = rawStep
      ? sanitizeDisplayText(rawStep, 512)
      : undefined;
    const status = candidate.status;
    if (
      !step ||
      (status !== 'pending' &&
        status !== 'in_progress' &&
        status !== 'completed')
    ) {
      return undefined;
    }
    steps.push({ step, status });
  }
  return steps;
}

function createPlanProgress(
  steps: readonly PlanStep[],
  timestamp: Date
): PlanProgress {
  const copiedSteps = steps.map((step) => ({ ...step }));
  const completed = copiedSteps.filter(
    (step) => step.status === 'completed'
  ).length;
  return {
    steps: copiedSteps,
    todos: [],
    completedSteps: completed,
    totalSteps: copiedSteps.length,
    completedTodos: 0,
    totalTodos: 0,
    lastUpdate: timestamp,
  };
}

function transitionTurn(
  previous: TurnActivity | null,
  phase: TurnActivity['phase'],
  timestamp: Date,
  options: {
    turnId?: string;
    durationMs?: number;
    timeToFirstTokenMs?: number;
  } = {}
): TurnActivity {
  const sameTurn =
    !options.turnId ||
    !previous?.turnId ||
    options.turnId === previous.turnId;
  const samePhase = previous?.phase === phase && sameTurn;

  return {
    phase,
    turnId: options.turnId ?? previous?.turnId,
    since: samePhase ? previous.since : timestamp,
    lastActivityAt: timestamp,
    lastTurnDurationMs:
      options.durationMs ?? previous?.lastTurnDurationMs,
    lastTimeToFirstTokenMs:
      options.timeToFirstTokenMs ?? previous?.lastTimeToFirstTokenMs,
  };
}

function matchesActiveTurn(
  previous: TurnActivity | null,
  eventTurnId: string | undefined,
  allowMissingEventId: boolean
): boolean {
  if (!previous?.turnId) {
    return true;
  }
  if (!eventTurnId) {
    return allowMissingEventId;
  }
  return eventTurnId === previous.turnId;
}

function getMcpToolName(payload: EventMsgPayload): string | undefined {
  const rawServer = stringValue(payload.invocation?.server);
  const rawTool = stringValue(payload.invocation?.tool);
  if (!rawServer || !rawTool) {
    return undefined;
  }

  const server = sanitizeDisplayText(rawServer, MAX_TOOL_NAME_COMPONENT_LENGTH);
  const tool = sanitizeDisplayText(rawTool, MAX_TOOL_NAME_COMPONENT_LENGTH);
  return server && tool ? `${server}/${tool}` : undefined;
}

function getMcpCallId(payload: EventMsgPayload): string | undefined {
  const callId = stringValue(payload.call_id);
  return callId && callId.length <= MAX_TOOL_CALL_ID_LENGTH
    ? callId
    : undefined;
}

function getMcpToolStatus(payload: EventMsgPayload): 'completed' | 'error' {
  const result = payload.result;
  if (!isRecord(result)) {
    return 'completed';
  }

  return (
    Object.hasOwn(result, 'Err') ||
    Object.hasOwn(result, 'error') ||
    result.isError === true
  )
    ? 'error'
    : 'completed';
}

function getMcpDurationMs(payload: EventMsgPayload): number | undefined {
  const seconds = payload.duration?.secs;
  const nanos = payload.duration?.nanos;
  if (seconds === undefined && nanos === undefined) {
    return undefined;
  }
  if (
    (seconds !== undefined &&
      (!Number.isSafeInteger(seconds) || seconds < 0)) ||
    (nanos !== undefined &&
      (!Number.isInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000))
  ) {
    return undefined;
  }

  const durationMs = (seconds ?? 0) * 1000 + (nanos ?? 0) / 1_000_000;
  return Number.isFinite(durationMs) ? durationMs : undefined;
}

function summarizePatch(patch: string): string | undefined {
  const files: Array<{ action: string; path: string }> = [];
  const filePattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (const match of patch.matchAll(filePattern)) {
    const path = sanitizeDisplayText(match[2] ?? '', MAX_TOOL_SUMMARY_LENGTH);
    if (path) {
      files.push({ action: (match[1] ?? '').toLowerCase(), path });
    }
  }

  const movePattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of patch.matchAll(movePattern)) {
    const path = sanitizeDisplayText(match[1] ?? '', MAX_TOOL_SUMMARY_LENGTH);
    if (path) {
      const previous = files[files.length - 1];
      if (previous?.action === 'update') {
        files[files.length - 1] = { action: 'move', path };
      } else {
        files.push({ action: 'move', path });
      }
    }
  }

  if (files.length === 0) {
    return undefined;
  }

  const basename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
  };
  if (files.length === 1) {
    return sanitizeDisplayText(
      `${files[0].action} ${basename(files[0].path)}`,
      MAX_TOOL_SUMMARY_LENGTH
    );
  }

  const visibleNames = files.slice(0, 2).map((file) => basename(file.path));
  const remaining = files.length - visibleNames.length;
  const suffix = remaining > 0 ? ` +${remaining}` : '';
  return sanitizeDisplayText(
    `${files.length} files: ${visibleNames.join(', ')}${suffix}`,
    MAX_TOOL_SUMMARY_LENGTH
  );
}

function summarizeToolArguments(
  toolName: string,
  args: unknown
): ToolDisplayDetails {
  const lowerName = toolName.toLowerCase();

  if (lowerName === 'apply_patch' && typeof args === 'string') {
    const summary = summarizePatch(args);
    return { summary };
  }
  if (!isRecord(args)) {
    return {};
  }

  const workdirValue = stringValue(args.workdir);
  const workdir = workdirValue
    ? sanitizeDisplayText(workdirValue, MAX_WORKDIR_LENGTH)
    : undefined;

  switch (lowerName) {
    case 'read':
    case 'write':
    case 'edit': {
      const path = stringValue(args.file_path ?? args.path ?? args.filePath);
      const summary = path
        ? sanitizeDisplayText(path, MAX_TOOL_SUMMARY_LENGTH)
        : undefined;
      return { summary, target: summary };
    }
    case 'glob':
    case 'grep': {
      const pattern = stringValue(args.pattern);
      const summary = pattern
        ? sanitizeDisplayText(pattern, MAX_TOOL_SUMMARY_LENGTH)
        : undefined;
      return { summary, target: summary };
    }
    case 'bash':
    case 'run_terminal_command':
    case 'exec_command': {
      const command = stringValue(args.command ?? args.cmd);
      const summary = command
        ? sanitizeDisplayText(command, MAX_TOOL_SUMMARY_LENGTH)
        : undefined;
      // The target is the privacy-preserving command head (`npm test`,
      // `sed && rg`). The full summary stays reserved for `full` mode.
      const head = command ? extractCommandHead(command) : undefined;
      const target = head
        ? sanitizeDisplayText(head, MAX_TOOL_TARGET_LENGTH)
        : undefined;
      return { summary, workdir, target };
    }
    case 'write_stdin': {
      const sessionId = args.session_id;
      const rawSessionLabel =
        typeof sessionId === 'string' || typeof sessionId === 'number'
          ? String(sessionId)
          : '?';
      const sessionLabel =
        sanitizeDisplayText(rawSessionLabel, 64) ?? '?';
      const chars = stringValue(args.chars) ?? '';
      const summary = chars.length === 0
        ? `poll session ${sessionLabel}`
        : `send ${chars.length} chars to session ${sessionLabel}`;
      // The synthetic summary contains no command content, so it can double
      // as the target shown in the default `targets` mode.
      return { summary, target: summary };
    }
    case 'wait': {
      const cellId = args.cell_id;
      const summary =
        typeof cellId === 'string' || typeof cellId === 'number'
          ? sanitizeDisplayText(`cell ${String(cellId)}`, MAX_TOOL_SUMMARY_LENGTH)
          : undefined;
      return { summary };
    }
    case 'update_plan': {
      const plan = Array.isArray(args.plan) ? args.plan : [];
      if (plan.length === 0) {
        return {};
      }
      const completed = plan.filter(
        (step) => isRecord(step) && step.status === 'completed'
      ).length;
      const summary = `${completed}/${plan.length}`;
      return { summary };
    }
    case 'tool_search': {
      const limit = args.limit;
      const summary =
        typeof limit === 'number' && Number.isFinite(limit)
          ? `limit ${limit}`
          : undefined;
      return { summary };
    }
    case 'apply_patch': {
      const patch = stringValue(args.patch ?? args.input);
      const summary = patch ? summarizePatch(patch) : undefined;
      return { summary };
    }
    case 'task': {
      const description = stringValue(args.description ?? args.subagent_type);
      const summary = description
        ? sanitizeDisplayText(description, MAX_TOOL_SUMMARY_LENGTH)
        : undefined;
      return { summary, target: summary };
    }
    default:
      return {};
  }
}

/**
 * Replace JavaScript strings and comments with spaces while preserving offsets.
 * Custom tool inputs are executable source, so HUD must inspect them without evaluating them.
 */
function maskJavaScriptLiterals(source: string): string {
  const masked = source.split('');
  let quote: "'" | '"' | '`' | null = null;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      masked[index] = char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        if (index + 1 < source.length) {
          index++;
          masked[index] = source[index] === '\n' ? '\n' : ' ';
        }
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      masked[index] = ' ';
      continue;
    }

    if (char === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        masked[index] = ' ';
        index++;
      }
      index--;
      continue;
    }

    if (char === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          masked[index] = ' ';
          masked[index + 1] = ' ';
          index++;
          break;
        }
        masked[index] = source[index] === '\n' ? '\n' : ' ';
        index++;
      }
    }
  }

  return masked.join('');
}

function findCustomToolInvocations(source: string): CustomToolInvocation[] {
  const maskedSource = maskJavaScriptLiterals(source);
  const invocationPattern = /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  return [...maskedSource.matchAll(invocationPattern)].map((match) => ({
    name: match[1],
    openParenIndex:
      (match.index ?? 0) + match[0].lastIndexOf('('),
  }));
}

function extractCustomInvocationArgument(
  source: string,
  invocation: CustomToolInvocation
): string | undefined {
  const maskedSource = maskJavaScriptLiterals(source);
  let depth = 1;

  for (let index = invocation.openParenIndex + 1; index < maskedSource.length; index++) {
    const char = maskedSource[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return source.slice(invocation.openParenIndex + 1, index).trim();
      }
    }
  }

  return undefined;
}

function summarizeCustomInvocations(
  invocations: readonly CustomToolInvocation[]
): string | undefined {
  if (invocations.length === 0) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const invocation of invocations) {
    counts.set(invocation.name, (counts.get(invocation.name) ?? 0) + 1);
  }

  const parts = [...counts.entries()].slice(0, 3).map(([name, count]) =>
    count > 1 ? `${name}×${count}` : name
  );
  const remainingTypes = Math.max(0, counts.size - parts.length);
  if (remainingTypes > 0) {
    parts.push(`+${remainingTypes} types`);
  }
  return sanitizeDisplayText(parts.join(' + '), MAX_TOOL_SUMMARY_LENGTH);
}

/**
 * Codex custom tool calls currently wrap concrete tools in an `exec` source cell.
 * Use a concrete name only when one unambiguous invocation is visible; otherwise
 * keep the truthful top-level name instead of guessing or double-counting.
 */
export function normalizeCustomToolName(
  toolName: string,
  input?: string
): string {
  if (toolName.toLowerCase() !== 'exec' || !input) {
    return toolName;
  }

  const invocations = findCustomToolInvocations(input);
  return invocations.length === 1 ? invocations[0].name : toolName;
}

function analyzeToolCall(payload: ResponseItemPayload): {
  name: string;
  details: ToolDisplayDetails;
} {
  if (payload.type === 'tool_search_call') {
    return {
      name: 'tool_search',
      details: summarizeToolArguments(
        'tool_search',
        parseArgumentsValue(payload.arguments)
      ),
    };
  }

  const protocolName =
    sanitizeDisplayText(payload.name ?? 'unknown', 80) ?? 'unknown';

  if (payload.type !== 'custom_tool_call') {
    return {
      name: protocolName,
      details: summarizeToolArguments(
        protocolName,
        parseArgumentsValue(payload.arguments)
      ),
    };
  }

  if (protocolName.toLowerCase() !== 'exec') {
    const rawInput = payload.input;
    const details = protocolName.toLowerCase() === 'apply_patch' && rawInput
      ? summarizeToolArguments(protocolName, rawInput)
      : {};
    return { name: protocolName, details };
  }

  const source = payload.input ?? '';
  const invocations = findCustomToolInvocations(source);
  if (invocations.length !== 1) {
    const summary = summarizeCustomInvocations(invocations);
    return {
      name: protocolName,
      details: { summary },
    };
  }

  const invocation = invocations[0];
  const argumentSource = extractCustomInvocationArgument(source, invocation);
  const parsedArgument = parseJsonValue(argumentSource);
  return {
    name: invocation.name,
    details: summarizeToolArguments(invocation.name, parsedArgument),
  };
}

function isToolCallPayload(payload: ResponseItemPayload): boolean {
  return (
    payload.type === 'function_call' ||
    payload.type === 'custom_tool_call' ||
    payload.type === 'tool_search_call'
  );
}

function isToolCallOutputPayload(payload: ResponseItemPayload): boolean {
  return (
    payload.type === 'function_call_output' ||
    payload.type === 'custom_tool_call_output' ||
    payload.type === 'tool_search_output'
  );
}

function extractToolOutputTexts(
  output: ResponseItemPayload['output']
): string[] {
  if (typeof output === 'string') {
    return [output];
  }
  if (Array.isArray(output)) {
    return output.flatMap((item) =>
      typeof item.text === 'string' ? [item.text] : []
    );
  }
  if (!output || typeof output !== 'object') {
    return [];
  }

  const texts: string[] = [];
  if (typeof output.content === 'string') {
    texts.push(output.content);
  }
  if (Array.isArray(output.content_items)) {
    for (const item of output.content_items) {
      if (typeof item.text === 'string') {
        texts.push(item.text);
      }
    }
  }
  return texts;
}

function parseWallTimeMs(line: string | undefined): number | undefined {
  const match = /^Wall time:?\s*([0-9]+(?:\.[0-9]+)?)\s*seconds?$/i.exec(
    line?.trim() ?? ''
  );
  if (!match) {
    return undefined;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : undefined;
}

function parseProcessEnvelope(text: string): ToolResult | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  if (!/^Chunk ID:\s*\S+/i.test(lines[0]?.trim() ?? '')) {
    return undefined;
  }

  let wallTimeMs: number | undefined;
  let statusLine = '';
  // Only inspect the metadata header before Output:. Never scan user stdout,
  // which may itself contain strings resembling an execution status.
  for (const rawLine of lines.slice(1, 7)) {
    const line = rawLine.trim();
    if (/^Output:\s*$/i.test(line)) {
      break;
    }
    wallTimeMs ??= parseWallTimeMs(line);
    if (
      /^Process exited with code -?\d+$/.test(line) ||
      /^Process running with session ID [A-Za-z0-9._:-]+$/i.test(line)
    ) {
      statusLine = line;
    }
  }

  const exitMatch = /^Process exited with code (-?\d+)$/.exec(statusLine);
  if (exitMatch) {
    return {
      kind: 'exited',
      exitCode: Number(exitMatch[1]),
      ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    };
  }

  const runningMatch =
    /^Process running with session ID ([A-Za-z0-9._:-]+)$/i.exec(statusLine);
  if (runningMatch) {
    return {
      kind: 'yielded',
      sessionId: runningMatch[1],
      ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    };
  }

  return {
    kind: 'unknown',
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
  };
}

function parseScriptEnvelope(text: string): {
  failed: boolean;
  result?: ToolResult;
} | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  const statusLine = lines[0]?.trim() ?? '';
  const failed = /^Script (?:failed\b|error:)/i.test(statusLine);
  const completed = /^Script completed\b/i.test(statusLine);
  if (!failed && !completed) {
    return null;
  }

  const wallTimeMs = parseWallTimeMs(lines[1]);
  return {
    failed,
    result: {
      kind: 'completed',
      ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    },
  };
}

function parseToolCompletion(
  toolName: string,
  output: ResponseItemPayload['output']
): ToolCompletion {
  let failed =
    output !== null &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    output.success === false;
  let result: ToolResult | undefined;
  const outputTexts = extractToolOutputTexts(output);

  for (const text of outputTexts) {
    const processResult = parseProcessEnvelope(text);
    if (processResult) {
      result = processResult;
      if (
        processResult.kind === 'exited' &&
        processResult.exitCode !== undefined &&
        processResult.exitCode !== 0
      ) {
        failed = true;
      }
      break;
    }

    const scriptResult = parseScriptEnvelope(text);
    if (scriptResult) {
      result = scriptResult.result;
      failed = failed || scriptResult.failed;
      break;
    }
  }

  if (
    !result &&
    EXECUTION_TOOL_NAMES.has(toolName.toLowerCase()) &&
    outputTexts.length > 0
  ) {
    result = { kind: 'unknown' };
  }

  return { failed, result };
}

/**
 * Enough to cover the first line (`session_meta`) with room to spare.
 */
const INITIAL_HEAD_BYTES = 64 * 1024;
/**
 * How much of a large rollout's end is read on the first pass. Everything the
 * HUD renders live — turn state, plan, token counts, recent calls — is written
 * at the end, while the middle is transcript the HUD never displays.
 */
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
/**
 * Backstop for incremental reads. A rollout that grows by this much between
 * two passes is pathological; surfacing it beats materializing it.
 */
const MAX_INCREMENTAL_READ_BYTES = 64 * 1024 * 1024;

interface RolloutBatch {
  records: RolloutLine[];
  nextOffset: number;
  truncated: boolean;
  malformedLines: number;
  partialHistory: boolean;
}

function hasTokenCount(records: readonly RolloutLine[]): boolean {
  return records.some(
    (record) =>
      record?.type === 'event_msg' &&
      (record.payload as EventMsgPayload | undefined)?.type === 'token_count'
  );
}

/**
 * Read the span this pass needs.
 *
 * Reading a whole rollout cost 292ms of blocked event loop and a 124MB RSS
 * spike on a measured 11.2MB file — paid on every HUD start, rebind, `--reload`
 * and first entry into the overview, once per session. The first pass over a
 * large file therefore reads a bounded head and tail instead.
 *
 * Only `session_meta` is kept from the head. Replaying arbitrary head records
 * would strand tool calls whose completions fell in the skipped middle, leaving
 * them "running" forever and pinning the turn phase.
 */
async function readRolloutBatch(
  rolloutPath: string,
  fromOffset: number
): Promise<RolloutBatch> {
  const readWholeSpan = async (offset: number): Promise<RolloutBatch> => ({
    ...(await readCompleteJsonl<RolloutLine>(rolloutPath, offset, {
      skipMalformed: true,
      maxBytes: MAX_INCREMENTAL_READ_BYTES,
    })),
    partialHistory: false,
  });

  const { size } = await fs.promises.stat(rolloutPath);
  if (fromOffset !== 0 || size <= INITIAL_HEAD_BYTES + INITIAL_TAIL_BYTES) {
    return readWholeSpan(fromOffset);
  }

  const [head, tail] = await Promise.all([
    readCompleteJsonl<RolloutLine>(rolloutPath, 0, {
      skipMalformed: true,
      toOffset: INITIAL_HEAD_BYTES,
    }),
    readCompleteJsonl<RolloutLine>(rolloutPath, size - INITIAL_TAIL_BYTES, {
      skipMalformed: true,
      alignToLineStart: true,
    }),
  ]);

  // A tail this size normally spans many turns, but a single turn with an
  // enormous tool output can fill it alone and leave no token_count behind.
  // Context capacity is the HUD's most-read cell, so pay for the whole file
  // rather than render a bound session with no capacity information.
  if (!hasTokenCount(tail.records)) {
    return readWholeSpan(0);
  }

  return {
    records: [
      ...head.records.filter((record) => record?.type === 'session_meta'),
      ...tail.records,
    ],
    nextOffset: tail.nextOffset,
    // The file did not shrink; this span was bounded deliberately.
    truncated: false,
    malformedLines: tail.malformedLines,
    partialHistory: true,
  };
}

/**
 * Parse a single rollout file incrementally
 * Supports reading from a specific byte offset for incremental updates
 */
export async function parseRolloutFile(
  rolloutPath: string,
  fromOffset: number = 0,
  maxRecentCalls: number = 10,
  runningCalls: Map<string, ToolCall> = new Map(),
  existingSession: SessionInfo | null = null,
  existingTurnActivity: TurnActivity | null = null
): Promise<RolloutParseOutput> {
  const toolActivity: ToolActivity = {
    recentCalls: [],
    totalCalls: 0,
    callsByType: {},
    lastUpdateTime: new Date(0),
  };

  let session: SessionInfo | null = existingSession ? { ...existingSession } : null;
  let sessionModel: string | undefined = existingSession?.model;
  let sessionReasoningEffort: string | undefined = existingSession?.reasoningEffort;
  let sessionApprovalPolicy: string | undefined = existingSession?.approvalPolicy;
  let sessionSandboxMode: string | undefined = existingSession?.sandboxMode;
  let sessionServiceTier: string | null | undefined = existingSession?.serviceTier;
  let planProgress: PlanProgress | null = null;
  let tokenUsage: TokenUsageInfo | null = null;
  let rateLimits: RateLimitSnapshot | null = null;
  let rateLimitsAt: Date | null = null;
  let turnActivity: TurnActivity | null = existingTurnActivity
    ? { ...existingTurnActivity }
    : null;
  let compactTopLevelCount = 0;
  let compactEventCount = 0;
  let lastCompactTime: Date | null = null;
  let lastToolActivityTime: Date | null = null;
  let lastAssistantMessageTime: Date | null = null;
  let lastEventTime: Date | null = null;
  let partialHistory = false;
  const protocolHealth: ProtocolHealth = {
    unknownTopLevelTypes: {},
    unknownResponseTypes: {},
    unknownEventTypes: {},
    malformedLines: 0,
  };

  const buildResult = (): RolloutParseResult => ({
    session,
    toolActivity,
    planProgress,
    tokenUsage,
    rateLimits,
    rateLimitsAt,
    turnActivity,
    protocolHealth,
    compactCount: Math.max(compactTopLevelCount, compactEventCount),
    compactTopLevelCount,
    compactEventCount,
    lastCompactTime,
    lastToolActivityTime,
    lastAssistantMessageTime,
    lastEventTime,
    partialHistory,
  });

  if (!fs.existsSync(rolloutPath)) {
    runningCalls.clear();
    return {
      result: buildResult(),
      newOffset: 0,
      runningCalls,
      wasTruncated: false,
    };
  }

  // Commit only bytes through the final newline. A JSON object that is still
  // being written remains unread until a later pass, instead of being skipped
  // permanently by advancing the cursor to EOF.
  const batch = await readRolloutBatch(rolloutPath, fromOffset);
  partialHistory = batch.partialHistory;
  protocolHealth.malformedLines += batch.malformedLines;
  if (batch.truncated) {
    runningCalls.clear();
    session = null;
    sessionModel = undefined;
    sessionReasoningEffort = undefined;
    sessionApprovalPolicy = undefined;
    sessionSandboxMode = undefined;
    sessionServiceTier = undefined;
    turnActivity = null;
  }

  const addToolCall = (
    toolName: string,
    callId: string,
    timestamp: Date,
    details: ToolDisplayDetails = {}
  ): ToolCall => {
    const toolCall: ToolCall = {
      id: callId,
      name: toolName,
      timestamp,
      status: 'running',
      target: details.target,
      summary: details.summary,
      workdir: details.workdir,
    };
    runningCalls.set(callId, toolCall);
    toolActivity.totalCalls++;
    toolActivity.callsByType[toolName] =
      (toolActivity.callsByType[toolName] ?? 0) + 1;
    toolActivity.recentCalls.push(toolCall);
    if (toolActivity.recentCalls.length > maxRecentCalls) {
      toolActivity.recentCalls.shift();
    }
    return toolCall;
  };

  const completeToolCall = (
    callId: string,
    timestamp: Date,
    output: ResponseItemPayload['output']
  ): void => {
    const runningCall = runningCalls.get(callId);
    if (!runningCall) {
      return;
    }
    const completion = parseToolCompletion(runningCall.name, output);
    runningCall.status = completion.failed ? 'error' : 'completed';
    runningCall.duration = timestamp.getTime() - runningCall.timestamp.getTime();
    runningCall.result = completion.result;
    runningCalls.delete(callId);

    const index = toolActivity.recentCalls.findIndex(
      (call) => call.id === callId
    );
    if (index >= 0) {
      toolActivity.recentCalls[index] = runningCall;
    } else {
      toolActivity.recentCalls.push(runningCall);
      if (toolActivity.recentCalls.length > maxRecentCalls) {
        toolActivity.recentCalls.shift();
      }
    }
  };

  const abortRunningCalls = (timestamp: Date): void => {
    for (const [callId, runningCall] of runningCalls) {
      runningCall.status = 'error';
      runningCall.duration = Math.max(
        0,
        timestamp.getTime() - runningCall.timestamp.getTime()
      );
      runningCalls.delete(callId);

      const index = toolActivity.recentCalls.findIndex(
        (call) => call.id === callId
      );
      if (index >= 0) {
        toolActivity.recentCalls[index] = runningCall;
      } else {
        toolActivity.recentCalls.push(runningCall);
        if (toolActivity.recentCalls.length > maxRecentCalls) {
          toolActivity.recentCalls.shift();
        }
      }
    }
  };

  for (const entry of batch.records) {
    const timestamp = new Date(entry.timestamp);
    if (!Number.isFinite(timestamp.getTime())) {
      continue;
    }

    lastEventTime = timestamp;
    toolActivity.lastUpdateTime = timestamp;
    if (!KNOWN_TOP_LEVEL_TYPES.has(entry.type)) {
      incrementCounter(protocolHealth.unknownTopLevelTypes, entry.type);
      continue;
    }

    if (entry.type === 'session_meta' && !session) {
      const meta = entry.payload as SessionMetaPayload;
      session = {
        id: meta.id,
        rolloutPath,
        startTime: new Date(meta.timestamp),
        cwd: meta.cwd,
        cliVersion: meta.cli_version,
        model: sessionModel,
        reasoningEffort: sessionReasoningEffort,
        approvalPolicy: sessionApprovalPolicy,
        sandboxMode: sessionSandboxMode,
        serviceTier: sessionServiceTier,
        modelProvider: meta.model_provider,
        source: meta.source,
        forkedFromId: meta.forked_from_id,
        parentThreadId: meta.parent_thread_id,
        agentPath: meta.agent_path,
        git: meta.git
          ? {
              branch: meta.git.branch,
              commitHash: meta.git.commit_hash,
            }
          : undefined,
      };
      continue;
    }

    if (entry.type === 'turn_context') {
      const payload = entry.payload as TurnContextPayload;
      const contextModel =
        payload.model ?? payload.collaboration_mode?.settings?.model;
      const reasoningEffort =
        payload.reasoning_effort ??
        payload.collaboration_mode?.settings?.reasoning_effort;

      if (payload.approval_policy !== undefined) {
        sessionApprovalPolicy = payload.approval_policy;
        if (session) {
          session.approvalPolicy = payload.approval_policy;
        }
      }
      const sandboxMode = payload.sandbox_policy?.type;
      if (sandboxMode !== undefined) {
        sessionSandboxMode = sandboxMode;
        if (session) {
          session.sandboxMode = sandboxMode;
        }
      }
      if (contextModel) {
        sessionModel = contextModel;
        if (session) {
          session.model = contextModel;
        }
      }
      if (reasoningEffort) {
        sessionReasoningEffort = reasoningEffort;
        if (session) {
          session.reasoningEffort = reasoningEffort;
        }
      }
      continue;
    }

    if (entry.type === 'compacted') {
      compactTopLevelCount++;
      lastCompactTime = timestamp;
      continue;
    }
    if (entry.type === 'world_state') {
      continue;
    }

    if (entry.type === 'response_item') {
      const payload = entry.payload as ResponseItemPayload;
      if (!KNOWN_RESPONSE_TYPES.has(payload.type)) {
        incrementCounter(protocolHealth.unknownResponseTypes, payload.type);
        continue;
      }

      if (
        isToolCallPayload(payload) &&
        (payload.name || payload.type === 'tool_search_call')
      ) {
        lastToolActivityTime = timestamp;
        const { name: toolName, details } = analyzeToolCall(payload);
        const callId =
          payload.call_id ?? payload.id ?? `call_${timestamp.getTime()}`;
        addToolCall(toolName, callId, timestamp, details);
        turnActivity = transitionTurn(
          turnActivity,
          'running-tool',
          timestamp
        );

        if (toolName.toLowerCase() === 'update_plan') {
          const plan = parsePlanSteps(
            parseArgumentsValue(payload.arguments)
          );
          if (plan) {
            planProgress = createPlanProgress(plan, timestamp);
          }
        }
      } else if (isToolCallOutputPayload(payload) && payload.call_id) {
        lastToolActivityTime = timestamp;
        completeToolCall(payload.call_id, timestamp, payload.output);
        if (
          turnActivity?.phase === 'running-tool' &&
          runningCalls.size === 0
        ) {
          turnActivity = transitionTurn(
            turnActivity,
            'thinking',
            timestamp
          );
        }
      } else if (
        payload.type === 'message' &&
        payload.role === 'assistant'
      ) {
        lastAssistantMessageTime = timestamp;
        turnActivity = transitionTurn(
          turnActivity,
          'responding',
          timestamp
        );
      }
      continue;
    }

    if (entry.type !== 'event_msg') {
      continue;
    }

    const payload = entry.payload as EventMsgPayload;
    if (!KNOWN_EVENT_TYPES.has(payload.type)) {
      incrementCounter(protocolHealth.unknownEventTypes, payload.type);
      continue;
    }

    if (payload.type === 'plan_update' && payload.plan) {
      const plan = parsePlanSteps({ plan: payload.plan });
      if (plan) {
        planProgress = createPlanProgress(plan, timestamp);
      }
    } else if (payload.type === 'token_count') {
      if (payload.info) {
        tokenUsage = payload.info;
      }
      if (payload.rate_limits) {
        rateLimits = payload.rate_limits;
        rateLimitsAt = timestamp;
      }
    } else if (payload.type === 'rate_limit' && payload.rate_limits) {
      rateLimits = payload.rate_limits;
      rateLimitsAt = timestamp;
    } else if (payload.type === 'context_compacted') {
      compactEventCount++;
      lastCompactTime = timestamp;
    } else if (
      payload.type === 'turn_started' ||
      payload.type === 'task_started'
    ) {
      if (payload.model_context_window) {
        tokenUsage ??= {};
        tokenUsage.model_context_window = payload.model_context_window;
      }
      const startedAt = asValidDate(payload.started_at, timestamp);
      turnActivity = transitionTurn(
        turnActivity,
        'thinking',
        startedAt,
        { turnId: payload.turn_id }
      );
    } else if (payload.type === 'task_complete') {
      if (!matchesActiveTurn(turnActivity, payload.turn_id, false)) {
        continue;
      }
      const completedAt = asValidDate(payload.completed_at, timestamp);
      turnActivity = transitionTurn(
        turnActivity,
        'idle',
        completedAt,
        {
          turnId: payload.turn_id,
          durationMs:
            typeof payload.duration_ms === 'number'
              ? payload.duration_ms
              : undefined,
          timeToFirstTokenMs:
            typeof payload.time_to_first_token_ms === 'number'
              ? payload.time_to_first_token_ms
              : undefined,
        }
      );
    } else if (payload.type === 'turn_aborted') {
      if (!matchesActiveTurn(turnActivity, payload.turn_id, true)) {
        continue;
      }
      turnActivity = transitionTurn(
        turnActivity,
        'aborted',
        timestamp,
        { turnId: payload.turn_id }
      );
      // Tools do not survive an aborted turn: without this, interrupted
      // calls would spin as "running" forever and hold the current-tool slot.
      abortRunningCalls(timestamp);
    } else if (payload.type === 'agent_reasoning') {
      turnActivity = transitionTurn(
        turnActivity,
        'thinking',
        timestamp,
        { turnId: payload.turn_id }
      );
    } else if (payload.type === 'agent_message') {
      lastAssistantMessageTime = timestamp;
      turnActivity = transitionTurn(
        turnActivity,
        'responding',
        timestamp,
        { turnId: payload.turn_id }
      );
    } else if (payload.type === 'thread_settings_applied') {
      const threadSettings = payload.thread_settings;
      const settingsModel =
        stringValue(threadSettings?.model) ??
        stringValue(threadSettings?.collaboration_mode?.settings?.model);
      const settingsEffort =
        stringValue(threadSettings?.reasoning_effort) ??
        stringValue(
          threadSettings?.collaboration_mode?.settings?.reasoning_effort
        );

      if (settingsModel) {
        sessionModel = settingsModel;
        if (session) {
          session.model = settingsModel;
        }
      }
      if (settingsEffort) {
        sessionReasoningEffort = settingsEffort;
        if (session) {
          session.reasoningEffort = settingsEffort;
        }
      }
      const serviceTier = threadSettings?.service_tier;
      if (serviceTier !== undefined) {
        sessionServiceTier = serviceTier;
        if (session) {
          session.serviceTier = serviceTier;
        }
      }
    } else if (
      payload.type === 'mcp_tool_call_begin' ||
      payload.type === 'mcp_tool_call_end'
    ) {
      const mcpName = getMcpToolName(payload);
      const callId = getMcpCallId(payload);
      if (!mcpName || !callId) {
        continue;
      }

      lastToolActivityTime = timestamp;
      const existingCall = runningCalls.get(callId);
      if (payload.type === 'mcp_tool_call_begin') {
        if (!existingCall) {
          addToolCall(mcpName, callId, timestamp);
        }
        turnActivity = transitionTurn(
          turnActivity,
          'running-tool',
          timestamp
        );
        continue;
      }

      const status = getMcpToolStatus(payload);
      const duration = getMcpDurationMs(payload);
      if (existingCall) {
        const previousName = existingCall.name;
        existingCall.name = mcpName;
        if (previousName !== mcpName) {
          const previousCount =
            toolActivity.callsByType[previousName] ?? 0;
          if (previousCount <= 1) {
            delete toolActivity.callsByType[previousName];
          } else {
            toolActivity.callsByType[previousName] = previousCount - 1;
          }
          toolActivity.callsByType[mcpName] =
            (toolActivity.callsByType[mcpName] ?? 0) + 1;
        }
        existingCall.status = status;
        existingCall.duration = duration;
        runningCalls.delete(callId);
        const index = toolActivity.recentCalls.findIndex(
          (call) => call.id === callId
        );
        if (index >= 0) {
          toolActivity.recentCalls[index] = existingCall;
        } else {
          toolActivity.recentCalls.push(existingCall);
          if (toolActivity.recentCalls.length > maxRecentCalls) {
            toolActivity.recentCalls.shift();
          }
        }
      } else {
        const toolCall: ToolCall = {
          id: callId,
          name: mcpName,
          timestamp,
          status,
          duration,
        };
        toolActivity.totalCalls++;
        toolActivity.callsByType[mcpName] =
          (toolActivity.callsByType[mcpName] ?? 0) + 1;
        toolActivity.recentCalls.push(toolCall);
        if (toolActivity.recentCalls.length > maxRecentCalls) {
          toolActivity.recentCalls.shift();
        }
      }
      if (
        turnActivity?.phase === 'running-tool' &&
        runningCalls.size === 0
      ) {
        turnActivity = transitionTurn(
          turnActivity,
          'thinking',
          timestamp
        );
      }
    }
  }

  return {
    result: buildResult(),
    newOffset: batch.nextOffset,
    runningCalls,
    wasTruncated: batch.truncated,
  };
}

/**
 * Rollout parser with state tracking for incremental updates
 */
export class RolloutParser {
  private rolloutPath: string | null = null;
  private lastOffset: number = 0;
  private cachedResult: RolloutParseResult | null = null;
  private runningCalls: Map<string, ToolCall> = new Map();

  constructor(private maxRecentCalls: number = 10) {}

  /**
   * Set the rollout file to parse
   */
  setRolloutPath(path: string | null): void {
    if (this.rolloutPath === path) {
      return;
    }

    this.rolloutPath = path;
    this.lastOffset = 0;
    this.cachedResult = null;
    this.runningCalls = new Map();
  }

  /**
   * Parse the rollout file, reading only new content since last parse
   */
  async parse(): Promise<RolloutParseResult | null> {
    if (!this.rolloutPath) {
      return null;
    }

    // Fallback polling calls parse every couple of seconds; when the file has
    // not grown past the committed offset there is nothing to read and the
    // merge below would only churn allocations. A size below the offset means
    // truncation and must take the full path.
    if (this.cachedResult) {
      try {
        const { size } = await fs.promises.stat(this.rolloutPath);
        if (size === this.lastOffset) {
          return this.cachedResult;
        }
      } catch {
        // Missing file and other stat errors follow the full parse path.
      }
    }

    const previousRunningCalls = new Map(
      Array.from(this.runningCalls.entries()).map(([id, call]) => [
        id,
        { call, name: call.name },
      ])
    );
    const { result, newOffset, runningCalls, wasTruncated } = await parseRolloutFile(
      this.rolloutPath,
      this.lastOffset,
      this.maxRecentCalls,
      this.runningCalls,
      this.cachedResult?.session ?? null,
      this.cachedResult?.turnActivity ?? null
    );

    // Some rollouts first emit a generic function_call and later enrich that
    // same call_id with mcp_tool_call_end. The running ToolCall object is
    // renamed in place, so migrate the already-cached type counter as well.
    // Keep the object reference here instead of relying on recentCalls: a long
    // incremental chunk may have already trimmed the completed call from view.
    if (this.cachedResult && !wasTruncated) {
      for (const { call, name: previousName } of previousRunningCalls.values()) {
        if (call.name === previousName) {
          continue;
        }

        const previousCount =
          this.cachedResult.toolActivity.callsByType[previousName] ?? 0;
        if (previousCount <= 1) {
          delete this.cachedResult.toolActivity.callsByType[previousName];
        } else {
          this.cachedResult.toolActivity.callsByType[previousName] =
            previousCount - 1;
        }
        this.cachedResult.toolActivity.callsByType[call.name] =
          (this.cachedResult.toolActivity.callsByType[call.name] ?? 0) + 1;

        // The end event incremented the new name in this incremental result
        // while renaming the cached call. Remove that local increment before
        // merging the accumulated counters below.
        const currentCount = result.toolActivity.callsByType[call.name] ?? 0;
        if (currentCount <= 1) {
          delete result.toolActivity.callsByType[call.name];
        } else {
          result.toolActivity.callsByType[call.name] = currentCount - 1;
        }
      }
    }

    this.lastOffset = newOffset;
    this.runningCalls = runningCalls;

    if (wasTruncated) {
      this.cachedResult = null;
    }

    // Merge with cached result for session info and accumulated stats
    if (this.cachedResult) {
      // Keep the stable session identity while retaining fields updated by
      // incremental turn_context and thread_settings_applied records.
      if (this.cachedResult.session && result.session) {
        result.session = { ...this.cachedResult.session, ...result.session };
      } else {
        result.session = this.cachedResult.session ?? result.session;
      }

      // Merge tool activity
      result.toolActivity.totalCalls += this.cachedResult.toolActivity.totalCalls;
      for (const [type, count] of Object.entries(
        this.cachedResult.toolActivity.callsByType
      )) {
        result.toolActivity.callsByType[type] =
          (result.toolActivity.callsByType[type] ?? 0) + count;
      }

      // Prepend cached recent calls, then trim
      const allCalls = [
        ...this.cachedResult.toolActivity.recentCalls,
        ...result.toolActivity.recentCalls,
      ];
      const deduped: ToolCall[] = [];
      const seen = new Set<string>();
      for (let i = allCalls.length - 1; i >= 0; i--) {
        const call = allCalls[i];
        if (seen.has(call.id)) {
          continue;
        }
        seen.add(call.id);
        deduped.unshift(call);
      }
      result.toolActivity.recentCalls = deduped.slice(-this.maxRecentCalls);
      if (
        this.cachedResult.toolActivity.lastUpdateTime.getTime() >
        result.toolActivity.lastUpdateTime.getTime()
      ) {
        result.toolActivity.lastUpdateTime =
          this.cachedResult.toolActivity.lastUpdateTime;
      }

      // Merge compact tracking: accumulate each record kind separately, then
      // derive the displayed count as their max (paired records would double
      // the count if summed).
      result.compactTopLevelCount += this.cachedResult.compactTopLevelCount;
      result.compactEventCount += this.cachedResult.compactEventCount;
      result.compactCount = Math.max(
        result.compactTopLevelCount,
        result.compactEventCount
      );
      if (!result.lastCompactTime && this.cachedResult.lastCompactTime) {
        result.lastCompactTime = this.cachedResult.lastCompactTime;
      }

      // Keep tokenUsage from latest parse (it contains cumulative data from API)
      // but preserve model_context_window if not in new result
      if (this.cachedResult.tokenUsage?.model_context_window && result.tokenUsage) {
        result.tokenUsage.model_context_window = 
          result.tokenUsage.model_context_window ?? this.cachedResult.tokenUsage.model_context_window;
      }

      // Keep tokenUsage from latest parse if available, otherwise use cached
      if (!result.tokenUsage && this.cachedResult.tokenUsage) {
        result.tokenUsage = this.cachedResult.tokenUsage;
      }

      // Plans, limits and lifecycle snapshots are state, not per-batch events.
      // Preserve the previous value until a later record explicitly supersedes it.
      result.planProgress ??= this.cachedResult.planProgress;
      if (!result.rateLimits && this.cachedResult.rateLimits) {
        // Carry the observation time with the snapshot; a limits value whose
        // timestamp came from a different record cannot be compared for
        // freshness against another session's.
        result.rateLimits = this.cachedResult.rateLimits;
        result.rateLimitsAt = this.cachedResult.rateLimitsAt;
      }
      result.turnActivity ??= this.cachedResult.turnActivity;

      // Sticky: a bounded first read keeps every later incremental result
      // honest about its lower-bound counters.
      result.partialHistory ||= this.cachedResult.partialHistory;

      result.lastToolActivityTime ??=
        this.cachedResult.lastToolActivityTime;
      result.lastAssistantMessageTime ??=
        this.cachedResult.lastAssistantMessageTime;
      result.lastEventTime ??= this.cachedResult.lastEventTime;

      mergeCounters(
        result.protocolHealth.unknownTopLevelTypes,
        this.cachedResult.protocolHealth.unknownTopLevelTypes
      );
      mergeCounters(
        result.protocolHealth.unknownResponseTypes,
        this.cachedResult.protocolHealth.unknownResponseTypes
      );
      mergeCounters(
        result.protocolHealth.unknownEventTypes,
        this.cachedResult.protocolHealth.unknownEventTypes
      );
      result.protocolHealth.malformedLines +=
        this.cachedResult.protocolHealth.malformedLines;
    }

    this.cachedResult = result;
    return result;
  }

  /**
   * Force a full re-parse from the beginning
   */
  async fullParse(): Promise<RolloutParseResult | null> {
    this.lastOffset = 0;
    this.cachedResult = null;
    return this.parse();
  }

  /**
   * Get the current cached result without re-parsing
   */
  getCached(): RolloutParseResult | null {
    return this.cachedResult;
  }
}
