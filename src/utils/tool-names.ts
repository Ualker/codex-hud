/**
 * Tool names that run a shell command themselves.
 *
 * `exec` is the codex-cli 0.147 wrapper: every tool now arrives as an `exec`
 * custom call whose script runs one or more commands, so a call left named
 * `exec` (because its script ran several) is still a command runner.
 *
 * The distinction from {@link EXECUTION_TOOL_NAMES} matters when attributing
 * command records: a `wait` polling a cell, or a `write_stdin` feeding one, is
 * not the call that ran the command that happens to finish during it.
 */
export const SHELL_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'exec',
  'exec_command',
  'run_terminal_command',
]);

/**
 * Tool names whose arguments carry a raw shell command (or terminal input).
 * Shared by the collector (summary/head extraction) and the renderer
 * (detail gating) so the two sides cannot drift apart.
 */
export const EXECUTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SHELL_COMMAND_TOOL_NAMES,
  'write_stdin',
]);

export function runsShellCommand(toolName: string): boolean {
  return SHELL_COMMAND_TOOL_NAMES.has(toolName.toLowerCase());
}

export function isExecutionTool(toolName: string): boolean {
  return EXECUTION_TOOL_NAMES.has(toolName.toLowerCase());
}
