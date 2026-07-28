/**
 * Rollout file parser for extracting tool activity and plan updates
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files
 */

import * as fs from 'fs';
import * as readline from 'readline';
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
  SessionInfo,
  TokenUsageInfo,
} from '../types.js';

/**
 * Result of parsing a rollout file
 */
export interface RolloutParseResult {
  session: SessionInfo | null;
  toolActivity: ToolActivity;
  planProgress: PlanProgress | null;
  tokenUsage: TokenUsageInfo | null;
  // Compact event tracking
  compactCount: number;
  lastCompactTime: Date | null;
  // Activity timestamps
  lastToolActivityTime: Date | null;
  lastAssistantMessageTime: Date | null;
  lastEventTime: Date | null;
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
const MAX_WORKDIR_LENGTH = 512;
const MAX_TOOL_NAME_COMPONENT_LENGTH = 80;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const EXECUTION_TOOL_NAMES = new Set([
  'bash',
  'exec_command',
  'run_terminal_command',
  'write_stdin',
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
      return { summary, workdir, target: summary };
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
      return { summary };
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
  const protocolName =
    sanitizeDisplayText(payload.name ?? 'unknown', 80) ?? 'unknown';

  if (payload.type !== 'custom_tool_call') {
    return {
      name: protocolName,
      details: summarizeToolArguments(
        protocolName,
        parseJsonValue(payload.arguments)
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
  return payload.type === 'function_call' || payload.type === 'custom_tool_call';
}

function isToolCallOutputPayload(payload: ResponseItemPayload): boolean {
  return payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
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
 * Parse a single rollout file incrementally
 * Supports reading from a specific byte offset for incremental updates
 */
export async function parseRolloutFile(
  rolloutPath: string,
  fromOffset: number = 0,
  maxRecentCalls: number = 10,
  runningCalls: Map<string, ToolCall> = new Map(),
  existingSession: SessionInfo | null = null
): Promise<RolloutParseOutput> {
  const toolActivity: ToolActivity = {
    recentCalls: [],
    totalCalls: 0,
    callsByType: {},
    lastUpdateTime: new Date(),
  };

  let session: SessionInfo | null = existingSession ? { ...existingSession } : null;
  let sessionModel: string | undefined = existingSession?.model;
  let sessionReasoningEffort: string | undefined = existingSession?.reasoningEffort;
  let sessionApprovalPolicy: string | undefined = existingSession?.approvalPolicy;
  let sessionSandboxMode: string | undefined = existingSession?.sandboxMode;
  let sessionServiceTier: string | null | undefined = existingSession?.serviceTier;
  let planProgress: PlanProgress | null = null;
  let tokenUsage: TokenUsageInfo | null = null;
  let compactCount = 0;
  let lastCompactTime: Date | null = null;
  let lastToolActivityTime: Date | null = null;
  let lastAssistantMessageTime: Date | null = null;
  let lastEventTime: Date | null = null;

  if (!fs.existsSync(rolloutPath)) {
    runningCalls.clear();
    return {
      result: {
        session,
        toolActivity,
        planProgress,
        tokenUsage,
        compactCount,
        lastCompactTime,
        lastToolActivityTime,
        lastAssistantMessageTime,
        lastEventTime,
      },
      newOffset: 0,
      runningCalls,
      wasTruncated: false,
    };
  }

  const stats = fs.statSync(rolloutPath);
  const fileSize = stats.size;

  // If fromOffset is beyond file size, file might have been truncated
  const wasTruncated = fromOffset > fileSize;
  const startOffset = wasTruncated ? 0 : fromOffset;
  if (wasTruncated) {
    runningCalls.clear();
    session = null;
    sessionModel = undefined;
    sessionReasoningEffort = undefined;
    sessionApprovalPolicy = undefined;
    sessionSandboxMode = undefined;
    sessionServiceTier = undefined;
  }

  return new Promise((resolve) => {
    const fileStream = fs.createReadStream(rolloutPath, {
      encoding: 'utf8',
      start: startOffset,
    });

    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let resolved = false;
    const finish = (newOffset: number) => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve({
        result: {
          session,
          toolActivity,
          planProgress,
          tokenUsage,
          compactCount,
          lastCompactTime,
          lastToolActivityTime,
          lastAssistantMessageTime,
          lastEventTime,
        },
        newOffset,
        runningCalls,
        wasTruncated,
      });
    };

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const entry = JSON.parse(line) as RolloutLine;
        const timestamp = new Date(entry.timestamp);

        // Process based on entry type
        lastEventTime = timestamp;
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
        } else if (entry.type === 'turn_context') {
          const payload = entry.payload as TurnContextPayload;
          const contextModel = payload.model ?? payload.collaboration_mode?.settings?.model;
          const reasoningEffort =
            payload.reasoning_effort ?? payload.collaboration_mode?.settings?.reasoning_effort;

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
        } else if (entry.type === 'response_item') {
          const payload = entry.payload as ResponseItemPayload;

          if (isToolCallPayload(payload) && payload.name) {
            // New tool call started
            lastToolActivityTime = timestamp;
            const { name: toolName, details } = analyzeToolCall(payload);
            const toolCall: ToolCall = {
              id: payload.call_id ?? payload.id ?? `call_${Date.now()}`,
              name: toolName,
              timestamp,
              status: 'running',
              target: details.target,
              summary: details.summary,
              workdir: details.workdir,
            };

            runningCalls.set(toolCall.id, toolCall);
            toolActivity.totalCalls++;
            toolActivity.callsByType[toolName] =
              (toolActivity.callsByType[toolName] ?? 0) + 1;

            // Add to recent calls (will update status when completed)
            toolActivity.recentCalls.push(toolCall);
            if (toolActivity.recentCalls.length > maxRecentCalls) {
              toolActivity.recentCalls.shift();
            }
          } else if (isToolCallOutputPayload(payload) && payload.call_id) {
            // Tool call completed
            lastToolActivityTime = timestamp;
            const runningCall = runningCalls.get(payload.call_id);
            if (runningCall) {
              const completion = parseToolCompletion(
                runningCall.name,
                payload.output
              );
              runningCall.status = completion.failed ? 'error' : 'completed';
              runningCall.duration = timestamp.getTime() - runningCall.timestamp.getTime();
              runningCall.result = completion.result;
              runningCalls.delete(payload.call_id);

              // Update in recentCalls array
              const idx = toolActivity.recentCalls.findIndex(
                (c) => c.id === payload.call_id
              );
              if (idx >= 0) {
                toolActivity.recentCalls[idx] = runningCall;
              } else {
                toolActivity.recentCalls.push(runningCall);
                if (toolActivity.recentCalls.length > maxRecentCalls) {
                  toolActivity.recentCalls.shift();
                }
              }
            }
          } else if (payload.type === 'message' && payload.role === 'assistant') {
            lastAssistantMessageTime = timestamp;
          }
        } else if (entry.type === 'event_msg') {
          const payload = entry.payload as EventMsgPayload;

          if (payload.type === 'plan_update' && payload.plan) {
            const completed = payload.plan.filter((s) => s.status === 'completed').length;
            planProgress = {
              steps: payload.plan,
              todos: [],
              completedSteps: completed,
              totalSteps: payload.plan.length,
              completedTodos: 0,
              totalTodos: 0,
              lastUpdate: timestamp,
            };
          } else if (payload.type === 'token_count' && payload.info) {
            tokenUsage = payload.info;
          } else if (payload.type === 'context_compacted') {
            // /compact command was executed - track it
            compactCount++;
            lastCompactTime = timestamp;
          } else if (payload.type === 'turn_started' && payload.model_context_window) {
            // New turn started - update context window if provided
            if (!tokenUsage) {
              tokenUsage = { model_context_window: payload.model_context_window };
            } else {
              tokenUsage.model_context_window = payload.model_context_window;
            }
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
            if (mcpName && callId) {
              lastToolActivityTime = timestamp;
              const existingCall = runningCalls.get(callId);

              if (payload.type === 'mcp_tool_call_begin') {
                if (!existingCall) {
                  const toolCall: ToolCall = {
                    id: callId,
                    name: mcpName,
                    timestamp,
                    status: 'running',
                  };

                  runningCalls.set(callId, toolCall);
                  toolActivity.totalCalls++;
                  toolActivity.callsByType[mcpName] =
                    (toolActivity.callsByType[mcpName] ?? 0) + 1;
                  toolActivity.recentCalls.push(toolCall);
                  if (toolActivity.recentCalls.length > maxRecentCalls) {
                    toolActivity.recentCalls.shift();
                  }
                }
              } else {
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
                      toolActivity.callsByType[previousName] =
                        previousCount - 1;
                    }
                    toolActivity.callsByType[mcpName] =
                      (toolActivity.callsByType[mcpName] ?? 0) + 1;
                  }

                  existingCall.status = status;
                  existingCall.duration = duration;
                  runningCalls.delete(callId);

                  const idx = toolActivity.recentCalls.findIndex(
                    (call) => call.id === callId
                  );
                  if (idx >= 0) {
                    toolActivity.recentCalls[idx] = existingCall;
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
              }
            }
          }
        }

        toolActivity.lastUpdateTime = timestamp;
      } catch {
        // Skip malformed lines
      }
    });

    const computeNewOffset = (): number => {
      const latestSize = fs.statSync(rolloutPath).size;
      return computeNextOffset(startOffset, fileStream.bytesRead, latestSize);
    };

    rl.on('close', () => {
      finish(computeNewOffset());
    });

    rl.on('error', () => {
      finish(computeNewOffset());
    });

    fileStream.on('error', () => {
      finish(computeNewOffset());
    });
  });
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
      this.cachedResult?.session ?? null
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

      // Merge compact tracking
      result.compactCount += this.cachedResult.compactCount;
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
