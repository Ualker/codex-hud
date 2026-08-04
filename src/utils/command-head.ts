/**
 * Derive a short, privacy-preserving display head from a shell command.
 *
 * The head keeps only program names, one known subcommand or script
 * basename, and the operators joining pipeline segments — never flags,
 * paths, or argument values — so it is safe to show in the default
 * `targets` tool-details mode.
 */

const WRAPPER_COMMANDS = new Set([
  'sudo',
  'doas',
  'env',
  'time',
  'nohup',
  'nice',
  'stdbuf',
  'command',
]);

const SUBCOMMAND_TOOLS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'cargo',
  'docker',
  'podman',
  'kubectl',
  'pip',
  'pip3',
  'uv',
  'uvx',
  'npx',
  'go',
  'gh',
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'conda',
  'make',
  'tmux',
  'systemctl',
]);

const SCRIPT_INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'python2',
  'ruby',
  'perl',
]);

const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh']);

const MAX_SEGMENTS = 3;
const MAX_RECURSION = 2;
const SAFE_SUBCOMMAND_PATTERN = /^[\w@.:+-]+$/;

/** Split into whitespace-delimited tokens, honoring quotes and backslashes. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < text.length) {
      current += text[++index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

interface TopLevelSplit {
  segments: string[];
  /** separators[i] joins segments[i] and segments[i + 1]. */
  separators: string[];
}

/** Split on top-level `&&`, `||`, `|`, `;` while honoring quotes. */
function splitTopLevel(command: string): TopLevelSplit {
  const segments: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      current += char;
      if (char === '\\' && quote !== "'" && index + 1 < command.length) {
        current += command[++index];
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[++index];
      continue;
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      segments.push(current);
      separators.push(char + next);
      current = '';
      index++;
      continue;
    }
    // Single `&` stays inside the segment so redirections like 2>&1 survive.
    if (char === '|' || char === ';') {
      segments.push(current);
      separators.push(char);
      current = '';
      continue;
    }
    // An unquoted newline separates commands just like `;`.
    if (char === '\n') {
      segments.push(current);
      separators.push(';');
      current = '';
      continue;
    }
    current += char;
  }

  segments.push(current);
  return { segments, separators };
}

function baseName(token: string): string {
  const normalized = token.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

/** Normalize a candidate program token; empty result means "skip token". */
function programName(token: string): string {
  let cleaned = token.replace(/^[\\(]+/, '').replace(/\)+$/, '');
  if (!cleaned || cleaned.startsWith('<') || cleaned.startsWith('>')) {
    return '';
  }
  return baseName(cleaned);
}

function segmentHead(segment: string, depth: number): string | undefined {
  const tokens = tokenize(segment);
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }

    const name = programName(token);
    if (!name) {
      index++;
      continue;
    }
    const lowerName = name.toLowerCase();

    if (WRAPPER_COMMANDS.has(lowerName)) {
      index++;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        index++;
        if (
          lowerName === 'sudo' &&
          (option === '-u' || option === '-g') &&
          index < tokens.length
        ) {
          index++;
        }
      }
      continue;
    }

    if (lowerName === 'timeout') {
      index++;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        index++;
      }
      if (
        index < tokens.length &&
        /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index])
      ) {
        index++;
      }
      continue;
    }

    if (SHELL_NAMES.has(lowerName)) {
      let optionEnd = index + 1;
      let hasCommandFlag = false;
      while (optionEnd < tokens.length && tokens[optionEnd].startsWith('-')) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(tokens[optionEnd])) {
          hasCommandFlag = true;
        }
        optionEnd++;
      }
      const nextToken = tokens[optionEnd];
      if (nextToken === undefined) {
        return name;
      }
      if (hasCommandFlag) {
        if (depth < MAX_RECURSION) {
          const inner = commandHead(nextToken, depth + 1);
          if (inner) {
            return inner;
          }
        }
        return name;
      }
      return `${name} ${baseName(nextToken)}`;
    }

    if (SUBCOMMAND_TOOLS.has(lowerName)) {
      const subcommand = tokens[index + 1];
      if (
        subcommand &&
        !subcommand.startsWith('-') &&
        SAFE_SUBCOMMAND_PATTERN.test(subcommand)
      ) {
        // `npm run build` is only informative with the script name attached.
        const runTarget = tokens[index + 2];
        if (
          subcommand === 'run' &&
          runTarget &&
          !runTarget.startsWith('-') &&
          SAFE_SUBCOMMAND_PATTERN.test(runTarget)
        ) {
          return `${name} run ${runTarget}`;
        }
        return `${name} ${subcommand}`;
      }
      return name;
    }

    if (SCRIPT_INTERPRETERS.has(lowerName)) {
      let scriptIndex = index + 1;
      while (
        scriptIndex < tokens.length &&
        tokens[scriptIndex].startsWith('-')
      ) {
        scriptIndex++;
      }
      const script = tokens[scriptIndex];
      return script ? `${name} ${baseName(script)}` : name;
    }

    return name;
  }

  return undefined;
}

function commandHead(command: string, depth: number): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  const { segments, separators } = splitTopLevel(trimmed);
  const heads: { head: string; separatorBefore?: string }[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index].trim();
    if (!segment) {
      continue;
    }
    const head = segmentHead(segment, depth);
    if (!head) {
      continue;
    }
    // `cd` before the real command is navigation noise, not the action.
    if (head.toLowerCase() === 'cd' && segments.length > 1) {
      continue;
    }
    heads.push({
      head,
      separatorBefore: index > 0 ? separators[index - 1] : undefined,
    });
  }

  if (heads.length === 0) {
    return undefined;
  }

  const visible = heads.slice(0, MAX_SEGMENTS);
  let output = '';
  visible.forEach((entry, position) => {
    if (position > 0) {
      output += ` ${entry.separatorBefore ?? '&&'} `;
    }
    output += entry.head;
  });
  if (heads.length > MAX_SEGMENTS) {
    output += ' …';
  }
  return output;
}

export function extractCommandHead(command: string): string | undefined {
  return commandHead(command, 0);
}
