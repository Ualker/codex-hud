import type { ResponseItemPayload, ToolResult } from '../types.js';
import { extractCommandHead } from '../utils/command-head.js';
import { EXECUTION_TOOL_NAMES, runsShellCommand } from '../utils/tool-names.js';
import { findJsStringContaining, parseJsLiteral } from '../utils/js-literal.js';
import { sanitizeDisplayText } from '../utils/display-text.js';

export const MAX_TOOL_SUMMARY_LENGTH = 240;
export const MAX_TOOL_TARGET_LENGTH = 80;
export const MAX_WORKDIR_LENGTH = 512;

export interface ToolDisplayDetails {
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

export function parseArgumentsValue(
  value: ResponseItemPayload['arguments']
): unknown {
  if (typeof value === 'string') {
    return parseJsonValue(value);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function webQueryDetails(query: string | undefined): ToolDisplayDetails {
  if (!query) {
    return {};
  }
  return {
    summary: sanitizeDisplayText(query, MAX_TOOL_SUMMARY_LENGTH),
    target: sanitizeDisplayText(query, MAX_TOOL_TARGET_LENGTH),
  };
}

/** Recover the first `search_query[].q` string from a malformed JS object. */
function extractWebQueryLiteral(source: string | undefined): string | undefined {
  const searchIndex = source?.indexOf('search_query') ?? -1;
  if (!source || searchIndex < 0) {
    return undefined;
  }
  const querySource = source.slice(searchIndex);
  // Some 0.147 calls contain `q":"..."`: the property key is malformed,
  // but the quoted query itself is still unambiguous and safe to decode.
  const match = /(?:^|[,{])\s*["']?q["']?\s*:\s*((['"`])(?:\\.|(?!\2)[\s\S])*?\2)/
    .exec(querySource);
  const decoded = match ? parseJsLiteral(`[${match[1]}]`) : undefined;
  return Array.isArray(decoded) && typeof decoded[0] === 'string'
    ? decoded[0]
    : undefined;
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
    case 'web__run': {
      const searches = Array.isArray(args.search_query)
        ? args.search_query
        : [];
      const firstSearch = searches.find(
        (candidate) => isRecord(candidate) && stringValue(candidate.q)
      );
      const query = isRecord(firstSearch)
        ? stringValue(firstSearch.q)
        : undefined;
      return webQueryDetails(query);
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

/** Read a local `const name = { ... }` or `const name = [ ... ]` literal. */
function extractAssignedJsLiteral(
  source: string,
  name: string
): unknown {
  const maskedSource = maskJavaScriptLiterals(source);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(
    `\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*([\\[{])`
  ).exec(maskedSource);
  if (!assignment || assignment.index === undefined) {
    return undefined;
  }

  const start = assignment.index + assignment[0].lastIndexOf(assignment[1]);
  const stack: string[] = [];
  for (let index = start; index < maskedSource.length; index++) {
    const char = maskedSource[index];
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') {
      continue;
    }
    const expected = char === '}' ? '{' : '[';
    if (stack.pop() !== expected) {
      return undefined;
    }
    if (stack.length === 0) {
      return parseJsLiteral(source.slice(start, index + 1));
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
  return invocations.length === 1
    ? displayCustomToolName(invocations[0].name)
    : toolName;
}

/**
 * The display name for a wrapped invocation. `exec_command` is the one inner
 * tool that means the same thing as the `exec` wrapper — a shell command — so
 * surfacing it split the tool row into `exec` and `exec_command` groups for
 * one kind of activity (0.150 models batch commands into scripts, putting
 * both shapes side by side). Concrete names other than `exec_command`
 * (web_search, update_plan, view_image) still surface: those say something
 * `exec` does not.
 */
function displayCustomToolName(invocationName: string): string {
  return invocationName.toLowerCase() === 'exec_command'
    ? 'exec'
    : invocationName;
}

export function analyzeToolCall(payload: ResponseItemPayload): {
  name: string;
  details: ToolDisplayDetails;
  /**
   * The decoded arguments, for callers that need more than the display
   * summary. `update_plan` used to re-read `payload.arguments`, which a
   * custom tool call never has — the plan lives in `input` — so the plan row
   * never rendered once codex moved every tool behind `exec`.
   */
  parsedArguments?: unknown;
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
    const parsedArguments = parseArgumentsValue(payload.arguments);
    return {
      name: protocolName,
      details: summarizeToolArguments(protocolName, parsedArguments),
      parsedArguments,
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
  // The argument is JavaScript source, not JSON: `{cmd: "…", workdir: "…"}`
  // has unquoted keys, so strict parsing failed on every call ever made by
  // codex-cli 0.147 and the tool row lost its commands. JSON is still tried
  // first for the protocols that do send it.
  let parsedArgument =
    parseJsonValue(argumentSource) ?? parseJsLiteral(argumentSource);
  if (
    invocation.name.toLowerCase() === 'update_plan' &&
    isRecord(parsedArgument) &&
    !Array.isArray(parsedArgument.plan) &&
    /\bplan\b/.test(argumentSource ?? '')
  ) {
    const assignedPlan = extractAssignedJsLiteral(source, 'plan');
    if (Array.isArray(assignedPlan)) {
      parsedArgument = { ...parsedArgument, plan: assignedPlan };
    }
  }
  let details = summarizeToolArguments(invocation.name, parsedArgument);
  if (
    invocation.name.toLowerCase() === 'web__run' &&
    details.summary === undefined
  ) {
    details = webQueryDetails(
      extractWebQueryLiteral(argumentSource ?? source)
    );
  }
  if (
    details.summary === undefined &&
    invocation.name.toLowerCase() === 'apply_patch'
  ) {
    // `tools.apply_patch(patch)` passes a variable, so there is no literal to
    // read; the patch body is still in the script as a plain string.
    const patch = findJsStringContaining(source, '*** Begin Patch');
    if (patch) {
      return {
        name: displayCustomToolName(invocation.name),
        details: summarizeToolArguments(invocation.name, { patch }),
        parsedArguments: { patch },
      };
    }
  }
  return {
    name: displayCustomToolName(invocation.name),
    details,
    parsedArguments: parsedArgument,
  };
}

export function isToolCallPayload(payload: ResponseItemPayload): boolean {
  return (
    payload.type === 'function_call' ||
    payload.type === 'custom_tool_call' ||
    payload.type === 'tool_search_call'
  );
}

export function isToolCallOutputPayload(payload: ResponseItemPayload): boolean {
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

export function parseToolCompletion(
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
