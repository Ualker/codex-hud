/**
 * Tool names whose arguments carry a raw shell command (or terminal input).
 * Shared by the collector (summary/head extraction) and the renderer
 * (detail gating) so the two sides cannot drift apart.
 */
export const EXECUTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'exec_command',
  'run_terminal_command',
  'write_stdin',
]);

export function isExecutionTool(toolName: string): boolean {
  return EXECUTION_TOOL_NAMES.has(toolName.toLowerCase());
}
