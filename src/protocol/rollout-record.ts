import type { RolloutLine } from '../types.js';
export type JsonRecord = Record<string, unknown>;
export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord : null;
}
/** Shared envelope guard; unknown kinds survive so callers can diagnose drift. */
export function normalizeRolloutRecord(value: unknown): RolloutLine | null {
  const entry = asRecord(value);
  if (!entry || typeof entry.type !== 'string' || !entry.type ||
    typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)))
    return null;
  if (['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(entry.type)) {
    const payload = asRecord(entry.payload);
    if (!payload)
      return null;
    if (['event_msg', 'response_item'].includes(entry.type) &&
      (typeof payload.type !== 'string' || !payload.type))
      return null;
  }
  return entry as unknown as RolloutLine;
}
export const AGENT_ACTIVITY_KINDS = new Set(['started', 'interacted', 'interrupted', 'completed']);
export const KNOWN_TOP_LEVEL_TYPES = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'compacted',
  'world_state',
  // codex-cli 0.153+ persists each model response's token usage as its own
  // record (usage / turn_token_usage / thread_token_usage). It lands 1:1
  // beside the token_count event this parser already consumes, with the same
  // figures and without rate_limits or the context window, so it is
  // known-and-ignored rather than protocol drift.
  'token_usage_record',
  // Observed in codex-cli 0.157.1 beside response_item/agent_message.
  // The trigger_turn flag is delivery metadata, not a turn lifecycle event.
  'inter_agent_communication_metadata',
]);
export const KNOWN_RESPONSE_TYPES = new Set([
  'message',
  // Inter-agent input (author/recipient/content), observed in 0.157.1.
  // Unlike event_msg/agent_message, it is not this agent replying to the user.
  'agent_message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
]);
export const KNOWN_EVENT_TYPES = new Set([
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
  // codex-cli 0.154 /goal state updates do not change turn or token state.
  'thread_goal_updated',
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
