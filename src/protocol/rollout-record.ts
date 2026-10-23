import type { RolloutLine } from '../types.js';
export type JsonRecord = Record<string, unknown>;
export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord : null;
}
function stringFields(record: JsonRecord, keys: string[]): boolean {
  return keys.every(key => record[key] == null || typeof record[key] === 'string');
}

function textBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.every(block => {
    const record = asRecord(block);
    return record !== null && stringFields(record, ['type', 'text']);
  });
}

function validSettings(value: unknown): boolean {
  const settings = asRecord(value);
  if (!settings || !stringFields(settings, [
    'model', 'model_provider_id', 'reasoning_effort', 'effort',
    'approval_policy', 'sandbox_mode', 'service_tier',
  ])) return false;
  for (const key of ['sandbox_policy', 'permission_profile']) {
    if (settings[key] != null) {
      const policy = asRecord(settings[key]);
      if (!policy || !stringFields(policy, ['type'])) return false;
    }
  }
  if (settings.collaboration_mode != null) {
    const collaboration = asRecord(settings.collaboration_mode);
    if (!collaboration || (collaboration.settings != null && !validSettings(collaboration.settings))) return false;
  }
  return true;
}

/** Validate fields we consume; unknown kinds/fields survive for drift diagnostics. */
function validPayload(type: string, payload: JsonRecord): boolean {
  if (type === 'session_meta') {
    return typeof payload.id === 'string' && typeof payload.cwd === 'string' &&
      stringFields(payload, ['timestamp', 'cli_version', 'model_provider', 'forked_from_id', 'parent_thread_id', 'agent_path']) &&
      (payload.git == null || (asRecord(payload.git) !== null &&
        stringFields(payload.git as JsonRecord, ['branch', 'commit_hash'])));
  }
  if (type === 'turn_context') return validSettings(payload);
  if (type === 'response_item') {
    if (!stringFields(payload, ['name', 'call_id', 'id', 'role', 'status', 'execution'])) return false;
    if (['message', 'agent_message'].includes(String(payload.type)) && payload.content != null && !textBlocks(payload.content)) return false;
    if (payload.output != null && typeof payload.output !== 'string') {
      if (Array.isArray(payload.output)) return textBlocks(payload.output);
      const output = asRecord(payload.output);
      if (!output || !stringFields(output, ['content']) ||
        (output.content_items != null && !textBlocks(output.content_items))) return false;
    }
  }
  if (type === 'event_msg') {
    if (!stringFields(payload, ['turn_id', 'call_id'])) return false;
    for (const key of ['started_at', 'completed_at']) {
      if (payload[key] != null && typeof payload[key] !== 'string' && typeof payload[key] !== 'number') return false;
    }
    if (payload.thread_settings != null && !validSettings(payload.thread_settings)) return false;
    for (const key of ['info', 'rate_limits', 'invocation', 'duration']) {
      if (payload[key] != null && !asRecord(payload[key])) return false;
    }
    if (payload.model_context_window != null && typeof payload.model_context_window !== 'number') return false;
  }
  return true;
}

/** Shared envelope and consumed-field guard. Invalid committed records can be skipped. */
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
    if (!validPayload(entry.type, payload)) return null;
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
  // Observed in codex-cli 0.164.0: dynamically supplied tool definitions,
  // not invocations, tool results, or turn lifecycle changes.
  'additional_tools',
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
