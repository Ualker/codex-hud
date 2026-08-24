/**
 * Extract Codex hook config overrides from live process command lines.
 *
 * `ps` does not preserve argv boundaries, so extraction is deliberately
 * conservative: only Codex processes and `-c/--config hooks.<event>=...`
 * values are considered. TOML quote/bracket tracking keeps hook commands that
 * contain spaces or flag-like text inside one override.
 */

const CODEX_BINARY_PATTERN = String.raw`(?:[^"\s]*/)?codex(?:\.exe)?`;
const NODE_BINARY_PATTERN = String.raw`(?:[^"\s]*/)?node(?:\.exe)?`;
const CODEX_SCRIPT_PATTERN = String.raw`(?:[^"\s]*/)?codex(?:\.(?:js|mjs|cjs))?`;

function codexArgumentsStart(command: string): number | null {
  const directMatch = new RegExp(
    `^\\s*${CODEX_BINARY_PATTERN}(?=\\s|$)`
  ).exec(command);
  if (directMatch) {
    return directMatch[0].length;
  }

  const nodeMatch = new RegExp(
    `^\\s*${NODE_BINARY_PATTERN}\\s+${CODEX_SCRIPT_PATTERN}(?=\\s|$)`
  ).exec(command);
  return nodeMatch ? nodeMatch[0].length : null;
}

function scanArgumentEnd(input: string, start: number): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: "'" | '"' | null = null;
  let tripleQuoted = false;
  let escaped = false;
  let sawValue = false;

  for (let index = start; index < input.length; index++) {
    const character = input[index];

    if (quote) {
      if (quote === '"' && !tripleQuoted && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && character === '\\' && !tripleQuoted) {
        escaped = true;
        continue;
      }

      if (tripleQuoted) {
        if (input.startsWith(quote.repeat(3), index)) {
          quote = null;
          tripleQuoted = false;
          index += 2;
        }
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (input.startsWith("'''", index) || input.startsWith('"""', index)) {
      quote = input[index] as "'" | '"';
      tripleQuoted = true;
      sawValue = true;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      sawValue = true;
      continue;
    }

    if (character === '[') {
      bracketDepth++;
      sawValue = true;
      continue;
    }
    if (character === '{') {
      braceDepth++;
      sawValue = true;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      sawValue = true;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      sawValue = true;
      continue;
    }

    if (/\s/.test(character) && sawValue && bracketDepth === 0 && braceDepth === 0) {
      return index;
    }
    if (!/\s/.test(character)) {
      sawValue = true;
    }
  }

  return input.length;
}

interface CommandHookOverrides {
  overrides: string[];
  hooksEnabledDirective: boolean | null;
}

interface ProcessArgument {
  value: string;
  end: number;
}

function readProcessArgument(command: string, start: number): ProcessArgument | null {
  let argumentStart = start;
  while (argumentStart < command.length && /\s/.test(command[argumentStart])) {
    argumentStart++;
  }
  if (argumentStart >= command.length) {
    return null;
  }

  const end = scanArgumentEnd(command, argumentStart);
  return {
    value: command.slice(argumentStart, end),
    end,
  };
}

function optionConsumesValue(option: string): boolean {
  return [
    '-m',
    '--model',
    '-p',
    '--profile',
    '-C',
    '--cd',
    '--remote',
    '-a',
    '--ask-for-approval',
    '-s',
    '--sandbox',
    '--output-last-message',
  ].includes(option);
}

function isHookOverride(value: string): boolean {
  return /^hooks\.[A-Za-z][A-Za-z0-9_-]*\s*=/.test(value);
}

function extractCommandHookOverrides(
  command: string,
  argumentsStart: number
): CommandHookOverrides {
  const overrides: string[] = [];
  let hooksEnabledDirective: boolean | null = null;
  let position = argumentsStart;

  while (position < command.length) {
    const argument = readProcessArgument(command, position);
    if (!argument) {
      break;
    }
    position = argument.end;

    if (argument.value === '--') {
      break;
    }

    if (argument.value === '-c' || argument.value === '--config') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      if (isHookOverride(valueArgument.value)) {
        overrides.push(valueArgument.value);
      }
      continue;
    }

    const inlineConfig = /^(?:-c|--config)=(.*)$/.exec(argument.value);
    if (inlineConfig) {
      if (isHookOverride(inlineConfig[1])) {
        overrides.push(inlineConfig[1]);
      }
      continue;
    }

    if (argument.value === '--enable' || argument.value === '--disable') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      if (valueArgument.value === 'hooks') {
        hooksEnabledDirective = argument.value === '--enable';
      }
      continue;
    }

    const inlineDirective = /^--(enable|disable)=hooks$/.exec(argument.value);
    if (inlineDirective) {
      hooksEnabledDirective = inlineDirective[1] === 'enable';
      continue;
    }

    if (optionConsumesValue(argument.value)) {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      continue;
    }

    if (argument.value.startsWith('-')) {
      continue;
    }

    // First bare argument is a subcommand or interactive prompt. Global hook
    // config overrides are expected before it; prompt text must not be parsed.
    break;
  }

  return { overrides, hooksEnabledDirective };
}

/**
 * Whether a `ps` command line is a Codex invocation — either the binary or
 * the `node .../bin/codex` script form. Calibrated live: on this machine
 * Codex runs as `node /Users/.../bin/codex`, a grandchild of the pane shell,
 * so tmux's `pane_current_command` reads "zsh" for the whole session and only
 * a process-tree walk with this matcher can tell alive from exited.
 */
export function isCodexProcessCommand(command: string): boolean {
  return codexArgumentsStart(command) !== null;
}

export interface CodexRuntimeHookState {
  overrides: string[];
  enabled: boolean | null;
}

/**
 * Return the effective runtime feature state and unique
 * `hooks.<event>=...` overrides from the current Codex process tree. Hook
 * commands are never executed or rendered.
 */
export function extractCodexRuntimeHookState(
  commands: readonly string[]
): CodexRuntimeHookState {
  const overrides = new Set<string>();
  let sawEnabled = false;
  let sawDisabled = false;

  for (const command of commands) {
    const argumentsStart = codexArgumentsStart(command);
    if (argumentsStart === null) {
      continue;
    }

    const extracted = extractCommandHookOverrides(command, argumentsStart);
    if (extracted.hooksEnabledDirective === false) {
      sawDisabled = true;
      continue;
    }
    if (extracted.hooksEnabledDirective === true) {
      sawEnabled = true;
    }
    for (const override of extracted.overrides) {
      overrides.add(override);
    }
  }

  return {
    overrides: [...overrides].sort(),
    enabled: sawEnabled ? true : sawDisabled ? false : null,
  };
}

export function extractCodexRuntimeHookOverrides(commands: readonly string[]): string[] {
  return extractCodexRuntimeHookState(commands).overrides;
}

/**
 * Approval/sandbox stated on a Codex invocation itself. CLI flags override
 * the config file, and in the 0.149 lazy world a session can sit at the
 * prompt for hours with no rollout — measured live: a `--yolo` pane whose HUD
 * read `Approval: ask for approval | Sandbox: workspace-write` off config,
 * the exact opposite of what the process would do.
 */
export interface CodexCliPolicy {
  approvalPolicy?: string;
  sandboxMode?: string;
}

// Only vocabulary Codex itself accepts may reach the security cells: a
// mis-parsed token must degrade to "unknown", never to a wrong claim.
const APPROVAL_POLICY_VALUES = new Set([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);
const SANDBOX_MODE_VALUES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/** `-c key="value"` carries TOML quoting inside the argument. */
function tomlStringValue(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

function assignPolicyValue(
  policy: CodexCliPolicy,
  kind: 'approval' | 'sandbox',
  raw: string
): void {
  const value = tomlStringValue(raw);
  if (kind === 'approval' && APPROVAL_POLICY_VALUES.has(value)) {
    policy.approvalPolicy = value;
  } else if (kind === 'sandbox' && SANDBOX_MODE_VALUES.has(value)) {
    policy.sandboxMode = value;
  }
}

function assignConfigOverride(policy: CodexCliPolicy, override: string): void {
  const match = /^(approval_policy|sandbox_mode)\s*=\s*(.*)$/.exec(override);
  if (!match) {
    return;
  }
  assignPolicyValue(
    policy,
    match[1] === 'approval_policy' ? 'approval' : 'sandbox',
    match[2]
  );
}

/**
 * Extract the approval/sandbox flags from one Codex process command line.
 * Later flags override earlier ones, matching the CLI. The walk stops at the
 * first bare argument for the same reason the hook walk does: `ps` loses argv
 * boundaries, and prompt text mentioning a flag must never be read as one —
 * a resume invocation with flags after the subcommand therefore reads as
 * "unknown" rather than risking a wrong security claim.
 */
export function extractCodexCliPolicy(command: string): CodexCliPolicy {
  const policy: CodexCliPolicy = {};
  const argumentsStart = codexArgumentsStart(command);
  if (argumentsStart === null) {
    return policy;
  }

  let position = argumentsStart;
  while (position < command.length) {
    const argument = readProcessArgument(command, position);
    if (!argument) {
      break;
    }
    position = argument.end;
    const value = argument.value;

    if (value === '--') {
      break;
    }

    if (
      value === '--yolo' ||
      value === '--dangerously-bypass-approvals-and-sandbox'
    ) {
      policy.approvalPolicy = 'never';
      policy.sandboxMode = 'danger-full-access';
      continue;
    }
    if (value === '--full-auto') {
      policy.approvalPolicy = 'on-failure';
      policy.sandboxMode = 'workspace-write';
      continue;
    }

    if (value === '-a' || value === '--ask-for-approval') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      assignPolicyValue(policy, 'approval', valueArgument.value);
      continue;
    }
    if (value === '-s' || value === '--sandbox') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      assignPolicyValue(policy, 'sandbox', valueArgument.value);
      continue;
    }
    const inlineFlag = /^(--ask-for-approval|--sandbox)=(.*)$/.exec(value);
    if (inlineFlag) {
      assignPolicyValue(
        policy,
        inlineFlag[1] === '--ask-for-approval' ? 'approval' : 'sandbox',
        inlineFlag[2]
      );
      continue;
    }

    if (value === '-c' || value === '--config') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      assignConfigOverride(policy, valueArgument.value);
      continue;
    }
    const inlineConfig = /^(?:-c|--config)=(.*)$/.exec(value);
    if (inlineConfig) {
      assignConfigOverride(policy, inlineConfig[1]);
      continue;
    }

    // `--enable hooks` pairs with a value; without this the feature name
    // reads as the first bare argument and stops the walk before the policy
    // flags behind it (the live invocation shape).
    if (value === '--enable' || value === '--disable') {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      continue;
    }

    if (optionConsumesValue(value)) {
      const valueArgument = readProcessArgument(command, position);
      if (!valueArgument) {
        break;
      }
      position = valueArgument.end;
      continue;
    }
    if (value.startsWith('-')) {
      continue;
    }
    break;
  }

  return policy;
}
