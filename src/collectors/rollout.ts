/**
 * Rollout file parser for extracting tool activity and plan updates
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files
 */

import * as fs from 'fs';
import { KNOWN_TOP_LEVEL_TYPES, KNOWN_RESPONSE_TYPES, KNOWN_EVENT_TYPES, normalizeRolloutRecord } from '../protocol/rollout-record.js';
import { fileWasReplaced, sameFile, sameFileVersion, type FileVersion } from '../utils/file-version.js';
import type {
  RolloutLine,
  ResponseItemPayload,
  EventMsgPayload,
  SessionMetaPayload,
  TurnContextPayload,
  ToolCall,
  ToolActivity,
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
import { runsShellCommand } from '../utils/tool-names.js';
import { sanitizeDisplayText } from '../utils/display-text.js';
import {
  MAX_TOOL_SUMMARY_LENGTH, MAX_TOOL_TARGET_LENGTH, MAX_WORKDIR_LENGTH,
  type ToolDisplayDetails, parseArgumentsValue, isRecord, stringValue,
  analyzeToolCall, isToolCallPayload, isToolCallOutputPayload, parseToolCompletion,
} from '../protocol/tool-call.js';
export { normalizeCustomToolName } from '../protocol/tool-call.js';
import { retainRateLimitWindows } from './rate-limit-windows.js';

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
  /** Bytes after the committed cursor; large backlogs are replayed in bounded passes. */
  pendingBytes?: number;
  hasMore?: boolean;
  /**
   * No runtime-state record can have been missed: the bounded first read
   * scans the skipped middle for state markers, so with zero malformed lines
   * and no forced truncation, "not found" means "not in the file". Lets a
   * bounded session stop hedging runtime facts (Fast/sandbox/model) that a
   * later turn may never arrive to confirm. False once any line failed to
   * parse — that line could have been the state record.
   */
  runtimeStateComplete: boolean;
}

export interface RolloutParseOutput {
  result: RolloutParseResult;
  newOffset: number;
  runningCalls: Map<string, ToolCall>;
  wasTruncated: boolean;
  executionState: ExecutionState;
}

/** CommandExecution events and their enclosing output may arrive in different reads. */
interface ExecutionState {
  openCallId: string | null;
  failures: Map<string, number>;
}

function emptyExecutionState(): ExecutionState {
  return { openCallId: null, failures: new Map() };
}

export function computeNextOffset(
  startOffset: number,
  bytesRead: number,
  latestSize: number
): number {
  return Math.min(latestSize, startOffset + bytesRead);
}

const MAX_TOOL_NAME_COMPONENT_LENGTH = 80;
const MAX_TOOL_CALL_ID_LENGTH = 512;

/** Keep room for the task after a long path; renderers compact and clip it. */
const MAX_SESSION_TITLE_LENGTH = 240;
/**
 * User-role messages Codex injects around the real prompt: the AGENTS.md
 * wrapper (`# AGENTS.md instructions` / `<INSTRUCTIONS>`), `<environment_context>`,
 * `<user_instructions>`, and skill bodies (`<skill>`), all measured on live
 * rollouts. A prompt starting with a tag is rare enough to accept the miss.
 */
const INJECTED_USER_MESSAGE_PATTERN = /^\s*(?:#\s*AGENTS\.md\b|<[a-z_]+[\s>/])/i;

function messageText(payload: ResponseItemPayload): string {
  return (payload.content ?? [])
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim();
}

/**
 * The text a session is remembered by: its first real prompt, the label
 * `codex resume` lists it under. Undefined for injected messages.
 */
function sessionTitleFromMessage(
  payload: ResponseItemPayload
): string | undefined {
  if (payload.type !== 'message' || payload.role !== 'user') {
    return undefined;
  }
  const text = messageText(payload);
  if (!text || INJECTED_USER_MESSAGE_PATTERN.test(text)) {
    return undefined;
  }
  return sanitizeDisplayText(text, MAX_SESSION_TITLE_LENGTH);
}

function isTitleMessageRecord(record: RolloutLine): boolean {
  return (
    record.type === 'response_item' &&
    sessionTitleFromMessage(record.payload as ResponseItemPayload) !== undefined
  );
}

/**
 * codex-cli 0.149.1 dropped the sandbox keys from `thread_settings_applied`
 * in favor of `permission_profile` (measured live: the payload carries
 * neither `sandbox_mode` nor `sandbox_policy`), so a mid-session `/approvals`
 * switch went dark until the next turn_context. `disabled` is the profile
 * word for "no restrictions" — turn_context pairs it with
 * `sandbox_policy: danger-full-access`; any other profile type is shown in
 * codex's own words rather than kept stale.
 */
function sandboxModeFromPermissionProfile(
  profile: { type?: string } | undefined
): string | undefined {
  const type = stringValue(profile?.type);
  if (!type) {
    return undefined;
  }
  return type === 'disabled' ? 'danger-full-access' : type;
}

/**
 * `CommandExecution.cwd` is a `file://` URL; every other path the HUD handles
 * is a plain filesystem path, so it is normalized on the way in.
 */
function decodeFileUrlPath(value: string): string | undefined {
  try {
    return decodeURIComponent(value.slice('file://'.length)) || undefined;
  } catch {
    return undefined;
  }
}


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
    error?: TurnActivity['lastTurnError'];
  } = {}
): TurnActivity {
  const sameTurn =
    !options.turnId ||
    !previous?.turnId ||
    options.turnId === previous.turnId;
  const samePhase = previous?.phase === phase && sameTurn;
  // The failure detail belongs to the failed phase; a completed turn clears
  // it, and the phases in between carry it the way the duration is carried.
  const lastTurnError =
    phase === 'failed'
      ? options.error
      : phase === 'idle'
        ? undefined
        : previous?.lastTurnError;

  return {
    phase,
    turnId: options.turnId ?? previous?.turnId,
    since: samePhase ? previous.since : timestamp,
    lastActivityAt: timestamp,
    lastTurnDurationMs:
      options.durationMs ?? previous?.lastTurnDurationMs,
    lastTimeToFirstTokenMs:
      options.timeToFirstTokenMs ?? previous?.lastTimeToFirstTokenMs,
    ...(lastTurnError ? { lastTurnError } : {}),
  };
}

const MAX_TURN_ERROR_CODE_LENGTH = 64;
const MAX_TURN_ERROR_MESSAGE_LENGTH = 200;

/**
 * Codex's verdict on a turn that ended badly: `task_complete.error` carries
 * a stable `codex_error_info` code (`usage_limit_exceeded`,
 * `server_overloaded`, `other`) and the message the TUI showed. Measured on
 * this machine: 10 of 1484 turns, every one of them a moment the user most
 * needs to be told about, and every one previously rendered as a completion.
 */
function parseTurnError(raw: unknown): TurnActivity['lastTurnError'] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const code =
    typeof raw.codex_error_info === 'string'
      ? sanitizeDisplayText(raw.codex_error_info, MAX_TURN_ERROR_CODE_LENGTH)
      : undefined;
  const message =
    typeof raw.message === 'string'
      ? sanitizeDisplayText(raw.message, MAX_TURN_ERROR_MESSAGE_LENGTH)
      : undefined;
  if (!code && !message) {
    return undefined;
  }
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
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

const RECOVERABLE_EVENT_TYPES = new Set([
  'plan_update',
  'context_compacted',
  'thread_settings_applied',
]);
const HISTORY_STATE_MARKERS = [
  '"type":"session_meta"',
  '"type":"turn_context"',
  '"type":"compacted"',
  '"type":"plan_update"',
  '"type":"context_compacted"',
  '"type":"thread_settings_applied"',
  '"type":"configuration_update"',
  '"role":"user"',
  '"name":"update_plan"',
  'tools.update_plan',
].map((marker) => Buffer.from(marker));
const HISTORY_MARKER_OVERLAP = Math.max(
  ...HISTORY_STATE_MARKERS.map((marker) => marker.length - 1)
);

interface RolloutBatch {
  pendingBytes?: number;
  hasMore?: boolean;
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
 * Convert a skipped-history record into state that is safe to replay.
 *
 * Tool calls themselves are intentionally excluded: their matching output may
 * be outside the bounded windows. `update_plan` is converted to a synthetic
 * plan event so its latest state survives without creating an orphaned call.
 */
function recoverHistoryStateRecord(record: RolloutLine): RolloutLine | undefined {
  if (!normalizeRolloutRecord(record)) throw new Error('Invalid rollout record shape.');
  if (
    record.type === 'session_meta' ||
    record.type === 'turn_context' ||
    record.type === 'compacted'
  ) {
    return record;
  }

  if (record.type === 'event_msg') {
    const payload = record.payload as EventMsgPayload;
    return RECOVERABLE_EVENT_TYPES.has(payload.type) ? record : undefined;
  }

  if (record.type !== 'response_item') {
    return undefined;
  }
  const payload = record.payload as ResponseItemPayload;
  if (payload.type === 'configuration_update') {
    return {
      timestamp: record.timestamp,
      type: 'response_item',
      payload: { type: 'configuration_update', reasoning: { effort: payload.reasoning?.effort } },
    };
  }
  const title = sessionTitleFromMessage(payload);
  if (title) {
    // Keep only the bounded display value, never an entire prompt. The
    // first real prompt can follow more than 64 KiB of injected context.
    return {
      timestamp: record.timestamp,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] },
    };
  }
  if (!isToolCallPayload(payload)) {
    return undefined;
  }

  const analyzed = analyzeToolCall(payload);
  if (analyzed.name.toLowerCase() !== 'update_plan') {
    return undefined;
  }
  const plan = parsePlanSteps(
    analyzed.parsedArguments ?? parseArgumentsValue(payload.arguments)
  );
  if (!plan) {
    return undefined;
  }

  return {
    timestamp: record.timestamp,
    type: 'event_msg',
    payload: { type: 'plan_update', plan },
  };
}

interface HistoryStateScan {
  records: RolloutLine[];
  malformedLines: number;
}

/**
 * Stream the skipped byte range as bytes and JSON.parse only low-frequency
 * state records. Non-matching lines are never decoded into strings or objects,
 * which was the expensive part of the old full-file first read.
 */
async function readSkippedHistoryState(
  rolloutPath: string,
  fromOffset: number,
  toOffset: number
): Promise<HistoryStateScan> {
  if (toOffset <= fromOffset) {
    return { records: [], malformedLines: 0 };
  }

  const records: RolloutLine[] = [];
  let malformedLines = 0;
  let lineFragments: Buffer[] = [];
  let lineBytes = 0;
  let markerTail = Buffer.alloc(0);
  let candidate = false;
  let rejected = false;
  let scannedBytes = 0;
  let recoveredTitle = false;

  const resetLine = (): void => {
    lineFragments = [];
    lineBytes = 0;
    markerTail = Buffer.alloc(0);
    candidate = false;
    rejected = false;
  };

  const appendFragment = (fragment: Buffer): void => {
    if (fragment.length === 0 || rejected) {
      return;
    }

    lineBytes += fragment.length;
    if (lineBytes > MAX_INCREMENTAL_READ_BYTES) {
      if (candidate) {
        throw new Error(
          `Rollout state record exceeds the ${MAX_INCREMENTAL_READ_BYTES}-byte limit: ${rolloutPath}`
        );
      }
      // State markers occur in the JSON envelope or at the start of an
      // update_plan source cell. Do not retain an unbounded non-state line.
      rejected = true;
      lineFragments = [];
      markerTail = Buffer.alloc(0);
      return;
    }

    if (!candidate) {
      candidate = HISTORY_STATE_MARKERS.some(
        (marker) => fragment.indexOf(marker) >= 0
      );
      if (!candidate && markerTail.length > 0) {
        const boundaryProbe = Buffer.concat([
          markerTail,
          fragment.subarray(0, HISTORY_MARKER_OVERLAP),
        ]);
        candidate = HISTORY_STATE_MARKERS.some(
          (marker) => boundaryProbe.indexOf(marker) >= 0
        );
      }
    }

    if (fragment.length >= HISTORY_MARKER_OVERLAP) {
      markerTail = Buffer.from(
        fragment.subarray(fragment.length - HISTORY_MARKER_OVERLAP)
      );
    } else {
      const combinedTail = Buffer.concat([markerTail, fragment]);
      markerTail = Buffer.from(
        combinedTail.subarray(
          Math.max(0, combinedTail.length - HISTORY_MARKER_OVERLAP)
        )
      );
    }
    lineFragments.push(fragment);
  };

  const finishLine = (): void => {
    if (candidate && !rejected) {
      try {
        const line = lineFragments.length === 1
          ? lineFragments[0]
          : Buffer.concat(lineFragments, lineBytes);
        const recovered = recoverHistoryStateRecord(
          JSON.parse(line.toString('utf8')) as RolloutLine
        );
        if (recovered) {
          const isTitle = isTitleMessageRecord(recovered);
          if (!isTitle || !recoveredTitle) records.push(recovered);
          recoveredTitle ||= isTitle;
        }
      } catch {
        malformedLines++;
      }
    }
    resetLine();
  };

  const input = fs.createReadStream(rolloutPath, {
    start: fromOffset,
    end: toOffset - 1,
  });
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      scannedBytes += chunk.length;
      let fragmentStart = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, fragmentStart);
        if (newline < 0) {
          appendFragment(chunk.subarray(fragmentStart));
          break;
        }
        appendFragment(chunk.subarray(fragmentStart, newline));
        finishLine();
        fragmentStart = newline + 1;
        if (fragmentStart >= chunk.length) {
          break;
        }
      }
    }
    const expectedBytes = toOffset - fromOffset;
    if (scannedBytes !== expectedBytes) {
      throw new Error(
        `Unexpected end of rollout state scan at offset ${fromOffset + scannedBytes}.`
      );
    }
  } finally {
    input.destroy();
  }

  return { records, malformedLines };
}

/**
 * Read the span this pass needs.
 *
 * Reading a whole rollout cost 292ms of blocked event loop and a 124MB RSS
 * spike on a measured 11.2MB file — paid on every HUD start, rebind, `--reload`
 * and first entry into the overview, once per session. The first pass over a
 * large file therefore reads a bounded head and tail instead.
 *
 * Only state records are kept from the head and skipped middle. Replaying
 * arbitrary tool calls would strand calls whose completions fell outside the
 * bounded windows, leaving them "running" forever and pinning the turn phase.
 */
async function readRolloutBatch(
  rolloutPath: string,
  fromOffset: number
): Promise<RolloutBatch> {
  const readWholeSpan = async (offset: number): Promise<RolloutBatch> => ({
    ...(await readCompleteJsonl<RolloutLine>(rolloutPath, offset, {
      skipMalformed: true,
      validateRecord: (record) => normalizeRolloutRecord(record) !== null,
      maxBytes: MAX_INCREMENTAL_READ_BYTES,
      batchBytes: 4 * 1024 * 1024,
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
      validateRecord: (record) => normalizeRolloutRecord(record) !== null,
      toOffset: INITIAL_HEAD_BYTES,
    }),
    readCompleteJsonl<RolloutLine>(rolloutPath, size - INITIAL_TAIL_BYTES, {
      skipMalformed: true,
      validateRecord: (record) => normalizeRolloutRecord(record) !== null,
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

  const headState = head.records
    .map(recoverHistoryStateRecord)
    .filter((record): record is RolloutLine => record !== undefined);
  // Both the head and the skipped-state scan recover the first prompt; a
  // large injected preamble must not turn a follow-up into the title.
  const middleState = await readSkippedHistoryState(
    rolloutPath,
    head.nextOffset,
    tail.recordsStartOffset
  );

  return {
    records: [
      ...headState,
      ...middleState.records,
      ...tail.records,
    ],
    nextOffset: tail.nextOffset,
    pendingBytes: tail.pendingBytes,
    hasMore: tail.hasMore,
    // The file did not shrink; this span was bounded deliberately.
    truncated: false,
    malformedLines:
      head.malformedLines + middleState.malformedLines + tail.malformedLines,
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
  existingTurnActivity: TurnActivity | null = null,
  existingRateLimits: RateLimitSnapshot | null = null,
  executionState: ExecutionState = emptyExecutionState()
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
  // Window announced by this batch's turn_started/task_started, handed to a
  // later token_count whose info does not restate it. A separate variable so
  // the token_count branch never reads the loop-carried tokenUsage back
  // (tsc's flow analysis rejects that self-reference).
  let capturedContextWindow: number | undefined;
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
  let pendingBytes = 0;
  let hasMore = false;
  let batchWasTruncated = false;
  const protocolHealth: ProtocolHealth = {
    unknownTopLevelTypes: {},
    unknownResponseTypes: {},
    unknownEventTypes: {},
    malformedLines: 0,
  };

  const buildResult = (): RolloutParseResult => ({
    session,
    toolActivity: { ...toolActivity, runningCalls: [...runningCalls.values()] },
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
    pendingBytes,
    hasMore,
    runtimeStateComplete:
      protocolHealth.malformedLines === 0 && !batchWasTruncated,
  });

  if (!fs.existsSync(rolloutPath)) {
    runningCalls.clear();
    executionState = emptyExecutionState();
    return {
      result: buildResult(),
      newOffset: 0,
      runningCalls,
      wasTruncated: false,
      executionState,
    };
  }

  // Commit only bytes through the final newline. A JSON object that is still
  // being written remains unread until a later pass, instead of being skipped
  // permanently by advancing the cursor to EOF.
  const batch = await readRolloutBatch(rolloutPath, fromOffset);
  partialHistory = batch.partialHistory;
  pendingBytes = batch.pendingBytes ?? 0;
  hasMore = batch.hasMore ?? false;
  batchWasTruncated = batch.truncated;
  protocolHealth.malformedLines += batch.malformedLines;
  if (batch.truncated) {
    runningCalls.clear();
    executionState = emptyExecutionState();
    session = null;
    sessionModel = undefined;
    sessionReasoningEffort = undefined;
    sessionApprovalPolicy = undefined;
    sessionSandboxMode = undefined;
    sessionServiceTier = undefined;
    turnActivity = null;
  }

  // codex emits one `item_completed`/CommandExecution per command a script
  // runs, strictly between the tool call and its output, so the open call is
  // the one they belong to — no id join is needed. This stream is the only
  // place an exit code appears: the `exec` script that wrapped the command
  // reports "Script completed" even when the command inside it exits 1, which
  // is why failures used to render as ✓.
  const execFailures = executionState.failures;

  const recordCommandExecution = (item: Record<string, unknown>): void => {
    const callId = executionState.openCallId;
    if (!callId) {
      return;
    }
    const call = runningCalls.get(callId);
    if (!call) {
      return;
    }

    const exitCode = item.exit_code;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      // Keep the first failure: it is the one that explains the rest. The
      // exit code belongs to whichever call was open — a `wait` whose cell
      // failed did fail — even when the command text below does not.
      if (!execFailures.has(callId)) {
        execFailures.set(callId, exitCode);
      }
    }

    if (!runsShellCommand(call.name)) {
      return;
    }

    const parsedCommands = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
    const firstParsed = parsedCommands.find(isRecord);
    const rawCommand =
      stringValue(firstParsed?.cmd) ??
      (Array.isArray(item.command)
        ? item.command.filter((part): part is string => typeof part === 'string').pop()
        : undefined);
    if (rawCommand && !call.summary) {
      call.summary = sanitizeDisplayText(rawCommand, MAX_TOOL_SUMMARY_LENGTH);
    }
    if (rawCommand && !call.target) {
      const head = extractCommandHead(rawCommand);
      if (head) {
        call.target = sanitizeDisplayText(head, MAX_TOOL_TARGET_LENGTH);
      }
    }
    if (!call.workdir) {
      // `cwd` arrives as a file URL.
      const cwd = stringValue(item.cwd);
      const decoded = cwd?.startsWith('file://')
        ? decodeFileUrlPath(cwd)
        : cwd;
      if (decoded) {
        call.workdir = sanitizeDisplayText(decoded, MAX_WORKDIR_LENGTH);
      }
    }
  };

  const recordWebSearch = (item: Record<string, unknown>): void => {
    const callId = executionState.openCallId;
    if (
      !callId ||
      item.type !== 'Extension' ||
      item.kind !== 'web.search'
    ) {
      return;
    }
    const call = runningCalls.get(callId);
    if (!call || call.name.toLowerCase() !== 'web__run') {
      return;
    }

    const action = isRecord(item.action) ? item.action : undefined;
    const actionQueries = Array.isArray(action?.queries)
      ? action.queries
      : [];
    const query =
      stringValue(item.query) ??
      stringValue(action?.query) ??
      actionQueries.find((candidate): candidate is string =>
        typeof candidate === 'string'
      );
    if (!query) {
      return;
    }

    call.summary = sanitizeDisplayText(query, MAX_TOOL_SUMMARY_LENGTH);
    call.target = sanitizeDisplayText(query, MAX_TOOL_TARGET_LENGTH);
  };

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
    // A command that exited non-zero inside the script is a failure even
    // though the script itself succeeded; the envelope cannot see it.
    const execExitCode = execFailures.get(callId);
    execFailures.delete(callId);
    runningCall.status =
      completion.failed || execExitCode !== undefined ? 'error' : 'completed';
    runningCall.duration = timestamp.getTime() - runningCall.timestamp.getTime();
    runningCall.result =
      execExitCode !== undefined && completion.result?.exitCode === undefined
        ? {
            ...completion.result,
            kind: 'exited',
            exitCode: execExitCode,
          }
        : completion.result;
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

  const finishRunningCalls = (timestamp: Date, status: 'completed' | 'error'): void => {
    for (const [callId, runningCall] of runningCalls) {
      const exitCode = execFailures.get(callId);
      runningCall.status = exitCode === undefined ? status : 'error';
      // A terminal turn proves the call is no longer live, but cannot supply
      // an exit code when its output was missing or malformed.
      runningCall.result ??= exitCode === undefined ? { kind: 'unknown' } : { kind: 'exited', exitCode };
      execFailures.delete(callId);
      executionState.openCallId = null;
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

  for (const raw of batch.records) {
    const entry = normalizeRolloutRecord(raw);
    if (!entry) { protocolHealth.malformedLines++; continue; }
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
        payload.effort ??
        payload.reasoning_effort ??
        payload.collaboration_mode?.settings?.reasoning_effort;

      if (payload.approval_policy !== undefined) {
        sessionApprovalPolicy = payload.approval_policy;
        if (session) {
          session.approvalPolicy = payload.approval_policy;
        }
      }
      const sandboxMode =
        payload.sandbox_policy?.type ??
        sandboxModeFromPermissionProfile(payload.permission_profile);
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

      if (payload.type === 'configuration_update') {
        const effort = stringValue(payload.reasoning?.effort);
        if (effort) {
          sessionReasoningEffort = effort;
          if (session) session.reasoningEffort = effort;
        }
        continue;
      }

      if (
        isToolCallPayload(payload) &&
        (payload.name || payload.type === 'tool_search_call')
      ) {
        lastToolActivityTime = timestamp;
        const { name: toolName, details, parsedArguments } =
          analyzeToolCall(payload);
        const callId =
          payload.call_id ?? payload.id ?? `call_${timestamp.getTime()}`;
        addToolCall(toolName, callId, timestamp, details);
        executionState.openCallId = callId;
        turnActivity = transitionTurn(
          turnActivity,
          'running-tool',
          timestamp
        );

        if (toolName.toLowerCase() === 'update_plan') {
          const plan = parsePlanSteps(
            parsedArguments ?? parseArgumentsValue(payload.arguments)
          );
          if (plan) {
            planProgress = createPlanProgress(plan, timestamp);
          }
        }
      } else if (isToolCallOutputPayload(payload) && payload.call_id) {
        lastToolActivityTime = timestamp;
        if (executionState.openCallId === payload.call_id) {
          executionState.openCallId = null;
        }
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
      } else if (session && !session.title) {
        const title = sessionTitleFromMessage(payload);
        if (title) {
          session.title = title;
        }
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
    } else if (payload.type === 'item_completed') {
      // Unified items enrich the still-open call but never create another
      // call: counting them would duplicate the response_item stream.
      const item = (payload as { item?: unknown }).item;
      if (isRecord(item)) {
        if (item.type === 'CommandExecution') {
          recordCommandExecution(item);
        } else if (item.type === 'Extension' && item.kind === 'web.search') {
          recordWebSearch(item);
        }
      }
    } else if (payload.type === 'token_count') {
      if (payload.info) {
        // info replaces the usage wholesale, but a context window captured
        // from task_started earlier in this batch must survive an info that
        // does not restate it.
        tokenUsage = {
          ...payload.info,
          model_context_window:
            payload.info.model_context_window ?? capturedContextWindow,
        };
      }
      if (payload.rate_limits) {
        rateLimits = retainRateLimitWindows(
          rateLimits ?? existingRateLimits,
          payload.rate_limits,
          timestamp.getTime()
        );
        rateLimitsAt = timestamp;
      }
    } else if (payload.type === 'rate_limit' && payload.rate_limits) {
      rateLimits = retainRateLimitWindows(
        rateLimits ?? existingRateLimits,
        payload.rate_limits,
        timestamp.getTime()
      );
      rateLimitsAt = timestamp;
    } else if (payload.type === 'context_compacted') {
      compactEventCount++;
      lastCompactTime = timestamp;
    } else if (
      payload.type === 'turn_started' ||
      payload.type === 'task_started'
    ) {
      if (payload.model_context_window) {
        capturedContextWindow = payload.model_context_window;
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
      // A task_complete carrying `error` is the provider ending the turn, not
      // the turn finishing: it must not read (or notify) as a completion.
      const turnError = parseTurnError(payload.error);
      turnActivity = transitionTurn(
        turnActivity,
        turnError ? 'failed' : 'idle',
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
          error: turnError,
        }
      );
      finishRunningCalls(completedAt, turnError ? 'error' : 'completed');
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
      finishRunningCalls(timestamp, 'error');
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
      const settingsApprovalPolicy = stringValue(
        threadSettings?.approval_policy
      );
      const settingsSandboxMode =
        stringValue(threadSettings?.sandbox_mode) ??
        stringValue(threadSettings?.sandbox_policy?.type) ??
        sandboxModeFromPermissionProfile(threadSettings?.permission_profile);

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
      if (settingsApprovalPolicy) {
        sessionApprovalPolicy = settingsApprovalPolicy;
        if (session) {
          session.approvalPolicy = settingsApprovalPolicy;
        }
      }
      if (settingsSandboxMode) {
        sessionSandboxMode = settingsSandboxMode;
        if (session) {
          session.sandboxMode = settingsSandboxMode;
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
        execFailures.delete(callId);
        if (executionState.openCallId === callId) executionState.openCallId = null;
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
    executionState,
  };
}

/**
 * Rollout parser with state tracking for incremental updates
 */
export class RolloutParser {
  private generation = 0;
  private rolloutPath: string | null = null;
  private lastOffset: number = 0;
  private cachedResult: RolloutParseResult | null = null;
  private runningCalls: Map<string, ToolCall> = new Map();
  private executionState = emptyExecutionState();
  private fileVersion: FileVersion | null = null;

  constructor(private maxRecentCalls: number = 10) {}

  /**
   * Set the rollout file to parse
   */
  setRolloutPath(path: string | null): void {
    if (this.rolloutPath === path) {
      return;
    }

    this.generation++;
    this.rolloutPath = path;
    this.lastOffset = 0;
    this.cachedResult = null;
    this.runningCalls = new Map();
    this.executionState = emptyExecutionState();
    this.fileVersion = null;
  }

  /**
   * Parse the rollout file, reading only new content since last parse
   */
  async parse(): Promise<RolloutParseResult | null> {
    if (!this.rolloutPath) {
      return null;
    }

    const generation = this.generation;
    const rolloutPath = this.rolloutPath;

    const version = await fs.promises.stat(rolloutPath);
    if (generation !== this.generation) return this.cachedResult;
    if (this.fileVersion && fileWasReplaced(this.fileVersion, version)) {
      this.lastOffset = 0;
      this.cachedResult = null;
      this.runningCalls = new Map();
      this.executionState = emptyExecutionState();
    } else if (this.cachedResult && this.fileVersion &&
      sameFileVersion(this.fileVersion, version) && !this.cachedResult.hasMore) {
      // This also caches an unfinished last line: retry only when it changes.
      return this.cachedResult;
    }

    if (generation !== this.generation) return this.cachedResult;
    const stagedCalls = new Map(Array.from(this.runningCalls, ([id,call]) => [id,{...call}]));
    const previousRunningCalls = new Map(
      Array.from(stagedCalls.entries()).map(([id, call]) => [
        id,
        { call, name: call.name },
      ])
    );
    const { result, newOffset, runningCalls, wasTruncated, executionState } = await parseRolloutFile(
      rolloutPath,
      this.lastOffset,
      this.maxRecentCalls,
      stagedCalls,
      this.cachedResult?.session ?? null,
      this.cachedResult?.turnActivity ?? null,
      this.cachedResult?.rateLimits ?? null,
      { openCallId: this.executionState.openCallId, failures: new Map(this.executionState.failures) }
    );

    if (generation !== this.generation) return this.cachedResult;

    const afterRead = await fs.promises.stat(rolloutPath);
    if (generation !== this.generation) return this.cachedResult;
    if (!sameFile(version, afterRead) || afterRead.size < version.size ||
      (afterRead.size === version.size && !sameFileVersion(version, afterRead))) {
      // A rotation during an asynchronous read must never publish mixed state.
      this.fileVersion = version;
      throw new Error('Rollout changed identity while being read; retrying.');
    }
    this.fileVersion = version;

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
    this.executionState = executionState;

    if (wasTruncated) {
      this.cachedResult = null;
    }

    // Merge with cached result for session info and accumulated stats
    if (this.cachedResult) {
      // Keep the stable session identity while retaining fields updated by
      // incremental turn_context, thread settings and configuration updates.
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

      // A batch whose only token fact was a task_started context window built a
      // window-only skeleton, and "latest parse wins" adopted it wholesale —
      // measured live as the context gauge vanishing at 85% used the moment a
      // turn started, permanently when that turn was aborted before its first
      // token_count. The skeleton only ever refreshes the window; the cached
      // cumulative usage survives underneath it.
      if (
        result.tokenUsage &&
        !result.tokenUsage.last_token_usage &&
        !result.tokenUsage.total_token_usage &&
        this.cachedResult.tokenUsage
      ) {
        result.tokenUsage = {
          ...this.cachedResult.tokenUsage,
          model_context_window:
            result.tokenUsage.model_context_window ??
            this.cachedResult.tokenUsage.model_context_window,
        };
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
      // Completeness only survives if every earlier pass was also complete: a
      // malformed line seen an hour ago could have been the state record this
      // pass did not find.
      result.runtimeStateComplete &&= this.cachedResult.runtimeStateComplete;

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
    this.generation++;
    this.lastOffset = 0;
    this.cachedResult = null;
    this.runningCalls = new Map();
    this.executionState = emptyExecutionState();
    this.fileVersion = null;
    return this.parse();
  }

  /**
   * Get the current cached result without re-parsing
   */
  getDiagnostics(): { path: string | null; offset: number; pendingBytes: number; generation: number } {
    return {path:this.rolloutPath, offset:this.lastOffset,
      pendingBytes:this.cachedResult?.pendingBytes ?? 0, generation:this.generation};
  }

  getCached(): RolloutParseResult | null {
    return this.cachedResult;
  }
}
