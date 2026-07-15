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

/**
 * Extract target/path from tool arguments for display
 */
function extractToolTarget(toolName: string, argsStr?: string): string | undefined {
  if (!argsStr) return undefined;

  try {
    const args = JSON.parse(argsStr);
    switch (toolName.toLowerCase()) {
      case 'read':
      case 'write':
      case 'edit':
        return args.file_path ?? args.path ?? args.filePath;
      case 'glob':
      case 'grep':
        return args.pattern;
      case 'bash':
      case 'run_terminal_command':
      case 'exec_command':
        const cmd = (args.command ?? args.cmd) as string;
        if (cmd) {
          return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
        }
        return undefined;
      case 'task':
        return args.description ?? args.subagent_type;
      default:
        return undefined;
    }
  } catch {
    return undefined;
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

  const source = maskJavaScriptLiterals(input);
  const invocationPattern = /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const matches = [...source.matchAll(invocationPattern)];
  return matches.length === 1 ? matches[0][1] : toolName;
}

function isToolCallPayload(payload: ResponseItemPayload): boolean {
  return payload.type === 'function_call' || payload.type === 'custom_tool_call';
}

function isToolCallOutputPayload(payload: ResponseItemPayload): boolean {
  return payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
}

function didToolOutputFail(output: ResponseItemPayload['output']): boolean {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output.success === false;
  }

  const outputTexts = typeof output === 'string'
    ? [output]
    : Array.isArray(output)
      ? output.flatMap((item) => typeof item.text === 'string' ? [item.text] : [])
      : [];

  return outputTexts.some((text) => /^Script (?:failed\b|error:)/i.test(text.trimStart()));
}

/**
 * Parse a single rollout file incrementally
 * Supports reading from a specific byte offset for incremental updates
 */
export async function parseRolloutFile(
  rolloutPath: string,
  fromOffset: number = 0,
  maxRecentCalls: number = 10,
  runningCalls: Map<string, ToolCall> = new Map()
): Promise<RolloutParseOutput> {
  const toolActivity: ToolActivity = {
    recentCalls: [],
    totalCalls: 0,
    callsByType: {},
    lastUpdateTime: new Date(),
  };

  let session: SessionInfo | null = null;
  let sessionModel: string | undefined;
  let sessionReasoningEffort: string | undefined;
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
            const toolName = payload.type === 'custom_tool_call'
              ? normalizeCustomToolName(payload.name, payload.input)
              : payload.name;
            const toolInput = payload.type === 'custom_tool_call'
              ? payload.input
              : payload.arguments;
            const toolCall: ToolCall = {
              id: payload.call_id ?? payload.id ?? `call_${Date.now()}`,
              name: toolName,
              timestamp,
              status: 'running',
              target: extractToolTarget(toolName, toolInput),
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
              runningCall.status = didToolOutputFail(payload.output) ? 'error' : 'completed';
              runningCall.duration = timestamp.getTime() - runningCall.timestamp.getTime();
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

    const { result, newOffset, runningCalls, wasTruncated } = await parseRolloutFile(
      this.rolloutPath,
      this.lastOffset,
      this.maxRecentCalls,
      this.runningCalls
    );

    this.lastOffset = newOffset;
    this.runningCalls = runningCalls;

    if (wasTruncated) {
      this.cachedResult = null;
    }

    // Merge with cached result for session info and accumulated stats
    if (this.cachedResult) {
      // Keep session from first parse
      result.session = this.cachedResult.session ?? result.session;

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
