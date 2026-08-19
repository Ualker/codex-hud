/**
 * Type definitions for codex-hud
 * Phase 3: Redesigned to match claude-hud structure
 */

// ============================================================================
// Constants (matching openai/codex protocol)
// ============================================================================

/**
 * Baseline tokens reserved for system prompts, tools and space to call compact.
 * This matches the BASELINE_TOKENS constant in codex-rs/protocol/src/protocol.rs
 */
export const BASELINE_TOKENS = 12000;

// ============================================================================
// Configuration Types
// ============================================================================

export interface CodexConfig {
  model?: string;
  model_reasoning_effort?: string;
  model_provider?: string;
  service_tier?: string;
  hooks?: boolean;
  approval_policy?: string;
  sandbox_mode?: string;
  mcp_servers?: Record<string, McpServerConfig>;
}

export interface PermissionState {
  approvalPolicy?: string;
  sandboxMode?: string;
}

export interface FastModeState {
  serviceTier?: string | null;
}

export interface McpServerConfig {
  command?: string[];
  url?: string;
  enabled?: boolean;
}

// ============================================================================
// Git Status (Extended)
// ============================================================================

export interface GitStatus {
  branch: string | null;
  isDirty: boolean;
  isGitRepo: boolean;
  // Extended git sync status
  ahead: number;
  behind: number;
  // File stats
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

// ============================================================================
// Project Information (Extended)
// ============================================================================

export interface ProjectInfo {
  cwd: string;
  projectName: string;
  agentsMdCount: number;
  // Extended config counts
  rulesCount: number;           // .codex/rules/*.md
  mcpCount: number;             // From config
  // Codex-specific module status
  configsCount: number;         // Active configuration files
  extensionsCount: number;      // Loaded extensions/plugins
  skillsCount: number;          // Codex-authoritative enabled skills
  otherAgentSkillsCount?: number; // Non-Codex .agents copies, diagnostic only
  hooksCount: number;           // Effective enabled hooks
  globalConfigActive?: boolean;
}

// ============================================================================
// Context Usage (Token/Context Window)
// ============================================================================

export interface ContextUsage {
  /**
   * Tokens used, in the same basis as `total` — so `used / total` matches
   * `percent`. These are display values (effective for a normal window, raw
   * bounded for a small window), not raw `total_tokens`. See
   * `calculateContextUsage` in `context-usage.ts`.
   */
  used: number;
  /** Denominator the percentage is measured against (see `used`). */
  total: number;
  /** Rounded 0–100 context-window usage percentage, matching Codex. */
  percent: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  // Compact tracking
  compactCount: number;
  lastCompactTime?: Date;
}

// ============================================================================
// Display Mode (Single vs Overview)
// ============================================================================

export type HudDisplayMode = 'single' | 'overview';

export interface SessionOverviewItem {
  id: string;
  projectName?: string;
  cwd?: string;
  /**
   * tmux session hosting this Codex session, when it runs under a codex-hud
   * pane. With several sessions open in one project every other column reads
   * the same, and this is the address that switches to one: the session id
   * resumes a session but cannot select a live pane. Absent for rows found by
   * the rollout scan alone.
   */
  tmuxSession?: string;
  model?: string;
  turnActivity?: TurnActivity;
  lastActivityAt?: Date;
  activeAgentCount?: number;
  contextUsage?: ContextUsage;
  /**
   * The session is open but has never run a turn, so Codex has not created a
   * rollout for it yet. Distinguishes "nothing to report" from "we could not
   * read what happened", which the phase column would otherwise merge.
   */
  neverStarted?: boolean;
}

export interface SessionOverview {
  sessions: SessionOverviewItem[];
  updatedAt: Date;
}

// ============================================================================
// Layout Configuration
// ============================================================================

export type LayoutMode = 'compact' | 'standard' | 'expanded';

export interface LayoutConfig {
  mode: LayoutMode;
  maxWidth?: number;
  showSeparators?: boolean;
  showDuration: boolean;
  showContextBar?: boolean;
  showGitStatus?: boolean;
  showToolActivity?: boolean;
  showPlanProgress?: boolean;
  showContextBreakdown?: boolean;  // Show token breakdown when usage >= 85%
  barWidth?: number;               // Width of context progress bar
  contextBarWidth?: number;
}

// ============================================================================
// Rollout Parsing Types
// ============================================================================

export interface RolloutLine {
  timestamp: string;
  type:
    | 'session_meta'
    | 'response_item'
    | 'event_msg'
    | 'turn_context'
    | 'compacted'
    | 'world_state'
    | (string & {});
  payload: RolloutPayload;
}

export type RolloutPayload =
  | SessionMetaPayload
  | ResponseItemPayload
  | EventMsgPayload
  | TurnContextPayload;

export type SessionSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'mcp'
  | 'unknown'
  | { custom: string }
  | { internal: unknown }
  | { subagent: SubagentSource };

export type SubagentSource =
  | 'review'
  | 'compact'
  | 'memory_consolidation'
  | { other: string }
  | {
      thread_spawn: {
        parent_thread_id: string;
        depth: number;
        agent_path?: string;
        agent_nickname?: string;
        agent_role?: string;
      };
    };

export interface SessionMetaPayload {
  id: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  instructions?: string;
  source?: SessionSource;
  forked_from_id?: string;
  parent_thread_id?: string;
  agent_path?: string;
  model_provider?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

export interface ResponseItemPayload {
  type:
    | 'message'
    | 'reasoning'
    | 'function_call'
    | 'function_call_output'
    | 'custom_tool_call'
    | 'custom_tool_call_output'
    | 'tool_search_call'
    | 'tool_search_output'
    | (string & {});
  role?: 'user' | 'assistant' | 'developer';
  content?: ContentBlock[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  input?: string;
  execution?: string;
  tools?: unknown[];
  status?: string;
  output?: FunctionOutput | ContentBlock[] | string | null;
}

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface FunctionOutput {
  content?: string;
  success?: boolean;
  content_items?: ContentBlock[];
}

export interface EventMsgPayload {
  type:
    | 'plan_update'
    | 'token_count'
    | 'rate_limit'
    | 'context_compacted'
    | 'turn_started'
    | 'task_started'
    | 'task_complete'
    | 'turn_aborted'
    | 'agent_reasoning'
    | 'agent_message'
    | 'user_message'
    | 'thread_settings_applied'
    | 'mcp_tool_call_begin'
    | 'mcp_tool_call_end'
    | (string & {});
  explanation?: string;
  plan?: PlanStep[];
  info?: TokenUsageInfo;
  rate_limits?: RateLimitSnapshot;
  turn_id?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  time_to_first_token_ms?: number;
  // For context_compacted events
  compacted_items?: CompactedItem[];
  summary?: string;
  // For turn_started events
  model_context_window?: number;
  // For thread_settings_applied events
  thread_settings?: {
    model?: string;
    model_provider_id?: string;
    service_tier?: string | null;
    reasoning_effort?: string;
    approval_policy?: string;
    sandbox_mode?: string;
    sandbox_policy?: {
      type?: string;
    };
    collaboration_mode?: {
      settings?: {
        model?: string;
        reasoning_effort?: string;
      };
    };
  };
  // For mcp_tool_call_begin / mcp_tool_call_end events
  call_id?: string;
  invocation?: {
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  };
  duration?: {
    secs?: number;
    nanos?: number;
  };
  result?: Record<string, unknown>;
}

export interface TurnContextPayload {
  approval_policy?: string;
  sandbox_policy?: {
    type?: string;
  };
  model?: string;
  reasoning_effort?: string;
  /** codex-cli 0.147 writes the effective effort under this top-level key. */
  effort?: string;
  collaboration_mode?: {
    settings?: {
      model?: string;
      reasoning_effort?: string;
    };
  };
}

/**
 * Represents an item that was compacted/summarized during /compact
 */
export interface CompactedItem {
  type: string;
  id?: string;
}

export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TokenUsageInfo {
  total_token_usage?: TokenUsage;
  last_token_usage?: TokenUsage;
  model_context_window?: number;
}

export interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface RateLimitSnapshot {
  limit_id?: string;
  limit_name?: string | null;
  plan_type?: string;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | null;
  } | null;
  rate_limit_reached_type?: string | null;
  spend_control_reached?: boolean | null;
  // Older protocol compatibility.
  requests_remaining?: number;
  tokens_remaining?: number;
  reset_time?: string;
}

export interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

// ============================================================================
// Turn and collector health
// ============================================================================

export type TurnPhase =
  | 'awaiting-approval'
  | 'thinking'
  | 'running-tool'
  | 'responding'
  | 'idle'
  | 'aborted'
  /**
   * Render-time overlay, never written by the parser: a stream error is drawn
   * only on the Codex TUI, not into the rollout, so a turn it kills stays
   * `thinking` forever. The stall detector sets this after confirming the
   * error banner on the main pane.
   */
  | 'interrupted';

export interface TurnActivity {
  phase: TurnPhase;
  turnId?: string;
  since: Date;
  lastActivityAt: Date;
  lastTurnDurationMs?: number;
  lastTimeToFirstTokenMs?: number;
}

export interface ProtocolHealth {
  unknownTopLevelTypes: Record<string, number>;
  unknownResponseTypes: Record<string, number>;
  unknownEventTypes: Record<string, number>;
  malformedLines: number;
}

/**
 * `pending` is "has not finished its first run yet", which is not a fault.
 * Folding it into `stale` made every HUD start report two broken collectors
 * for the ~0.6s before the first round completed, which is exactly the kind
 * of false alarm that teaches a user to ignore the health row.
 */
export type CollectorHealthStatus = 'pending' | 'fresh' | 'stale' | 'error';

export interface CollectorHealth {
  status: CollectorHealthStatus;
  lastAttemptAt: Date;
  lastSuccessAt?: Date;
  errorSummary?: string;
}

export type CollectorHealthMap = Partial<
  Record<'environment' | 'config' | 'git' | 'project' | 'session' | 'rollout' | 'agents' | 'overview' | 'renderer', CollectorHealth>
>;

// ============================================================================
// Tool Activity Tracking
// ============================================================================

export type ToolStatus = 'running' | 'completed' | 'error';

export type ToolResultKind = 'completed' | 'exited' | 'yielded' | 'unknown';

export interface ToolResult {
  kind: ToolResultKind;
  exitCode?: number;
  sessionId?: string;
  wallTimeMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  timestamp: Date;
  status: ToolStatus;
  duration?: number;
  target?: string;
  /**
   * Sanitized, bounded display text derived from allow-listed arguments.
   * Raw commands, tool arguments, and stdout are intentionally not retained.
   */
  summary?: string;
  workdir?: string;
  result?: ToolResult;
}

export interface ToolActivity {
  recentCalls: ToolCall[];
  totalCalls: number;
  callsByType: Record<string, number>;
  lastUpdateTime: Date;
}

// ============================================================================
// Agent Activity
// ============================================================================

export type AgentDisplayStatus = 'starting' | 'running' | 'tracking-error';

export interface AgentActivityRow {
  threadId: string;
  agentPath: string;
  label: string;
  status: AgentDisplayStatus;
  elapsedStartedAt?: Date;
  activeDescendantCount: number;
}

export interface AgentActivity {
  rows: AgentActivityRow[];
  visibleAgentCount: number;
  rootTrackingError: boolean;
  updatedAt: Date;
}

// ============================================================================
// Todo/Plan Progress
// ============================================================================

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
}

export interface PlanProgress {
  steps: PlanStep[];
  todos?: TodoItem[];
  completedSteps: number;
  totalSteps: number;
  completedTodos?: number;
  totalTodos?: number;
  // Backward compat aliases
  completed?: number;
  total?: number;
  lastUpdate: Date;
}

// ============================================================================
// Session Information
// ============================================================================

export interface SessionInfo {
  id: string;
  rolloutPath: string;
  startTime: Date;
  cwd: string;
  cliVersion: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  serviceTier?: string | null;
  modelProvider?: string;
  source?: SessionSource;
  forkedFromId?: string;
  parentThreadId?: string;
  agentPath?: string;
  git?: {
    branch?: string;
    commitHash?: string;
  };
}

// ============================================================================
// Complete HUD Data
// ============================================================================

export interface HudData {
  // Core info
  config: CodexConfig;
  git: GitStatus;
  project: ProjectInfo;
  sessionStart: Date;
  
  // Session and rollout data
  session?: SessionInfo;
  
  // Context/token usage
  contextUsage?: ContextUsage;
  tokenUsage?: TokenUsageInfo;
  rateLimits?: RateLimitSnapshot;
  
  // Activity tracking
  toolActivity?: ToolActivity;
  agentActivity?: AgentActivity;
  planProgress?: PlanProgress;
  turnActivity?: TurnActivity;
  protocolHealth?: ProtocolHealth;
  collectorHealth?: CollectorHealthMap;
  /**
   * The rollout was large enough that its middle was skipped on the first
   * read, so cumulative counters (tool totals, compactions) are lower bounds
   * and must be rendered as such.
   */
  partialHistory?: boolean;
  /**
   * Every byte so far was examined for runtime-state records (the bounded
   * first read scans the skipped middle for their markers) and none were lost
   * to malformed lines. When true, a runtime fact the scan did not find is
   * genuinely absent from the file, so renderers may fall back to config
   * instead of hedging with "?" — a hedge that otherwise never resolves for a
   * session that stays idle. Counters stay lower bounds regardless.
   */
  runtimeStateComplete?: boolean;

  // Display mode and overview data
  displayMode?: HudDisplayMode;
  overview?: SessionOverview;
  /** Session id this HUD is bound to, for marking the own row in overview. */
  overviewSelfSessionId?: string;
}

// ============================================================================
// Render Options
// ============================================================================

export interface RenderOptions {
  width: number;
  showDetails: boolean;
  layout?: LayoutConfig;
  /**
   * Rows the pane can show. The expanded layout compresses low-signal rows to
   * fit instead of letting the viewport clip whatever happened to land last.
   */
  maxLines?: number;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  mode: 'expanded',
  showSeparators: false,
  showDuration: true,
  showContextBreakdown: true,
  barWidth: 10,
};
