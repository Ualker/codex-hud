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
