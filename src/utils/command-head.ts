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

// These tokens describe shell grammar rather than an executable. Prefix
// keywords can share a segment with the command they guard (`if grep ...`),
// while closing/compound keywords carry no command at all.
const CONTROL_FLOW_PREFIXES = new Set([
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  '!',
]);
const CONTROL_FLOW_ONLY = new Set([
  'fi',
  'done',
  'esac',
  'for',
  'select',
  'case',
  'in',
]);
const SHELL_TEST_COMMANDS = new Set(['[', '[[', 'test']);
const MULTI_SEGMENT_NOISE = new Set(['cd', 'set', 'export']);

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

/** Return the closing brace of a shell `name() { ... }` definition. */
function shellFunctionEnd(command: string, start: number): number | undefined {
  const match = /^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/
    .exec(command.slice(start));
  if (!match) {
    return undefined;
  }

  const openBrace = start + match[0].lastIndexOf('{');
  let depth = 1;
  let quote: "'" | '"' | '`' | null = null;
  let inComment = false;
  for (let index = openBrace + 1; index < command.length; index++) {
    const char = command[index];

    if (inComment) {
      if (char === '\n') {
        inComment = false;
      }
      continue;
    }
    if (quote) {
      if (char === '\\' && quote !== "'" && index + 1 < command.length) {
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '#') {
      inComment = true;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index++;
      continue;
    }
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
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

    // A function definition declares a later command; it is not itself the
    // command being run. Skip the whole body so its first internal command
    // cannot leak into the display head either.
    if (current.trim().length === 0) {
      const functionEnd = shellFunctionEnd(command, index);
      if (functionEnd !== undefined) {
        current = '';
        index = functionEnd;
        continue;
      }
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    // A backslash before a newline is a line continuation: it joins the lines
    // and contributes no token of its own. Keeping the pair left a segment
    // whose first token was the newline itself, which reached the pane as a
    // `↵` cell where a program name belonged.
    if (char === '\\' && next === '\n') {
      index++;
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
  const cleaned = token
    .replace(/\(\)$/, '')
    .replace(/^[\\(]+/, '')
    .replace(/\)+$/, '');
  // Whatever survives the stripping is printed as a program name, so a token
  // made only of whitespace is not one. A line continuation used to leave the
  // newline itself here, and it reached the pane as a `↵` cell where a
  // command belonged.
  if (!cleaned.trim() || cleaned.startsWith('<') || cleaned.startsWith('>')) {
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

    if (CONTROL_FLOW_PREFIXES.has(lowerName)) {
      index++;
      continue;
    }
    if (
      CONTROL_FLOW_ONLY.has(lowerName) ||
      SHELL_TEST_COMMANDS.has(lowerName)
    ) {
      return undefined;
    }

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
  const heads: {
    head: string;
    separatorBefore?: string;
    count: number;
  }[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index].trim();
    if (!segment) {
      continue;
    }
    const head = segmentHead(segment, depth);
    if (!head) {
      continue;
    }
    // Navigation and shell setup before the real command are not the action.
    if (
      MULTI_SEGMENT_NOISE.has(head.toLowerCase()) &&
      segments.length > 1
    ) {
      continue;
    }

    const separatorBefore = index > 0 ? separators[index - 1] : undefined;
    const previous = heads[heads.length - 1];
    // Repeated sequential commands are common in generated shell snippets.
    // Keep the count, but do not collapse pipelines or fallbacks where the
    // repeated program names describe distinct data-flow stages.
    if (
      previous?.head === head &&
      separatorBefore !== '|' &&
      separatorBefore !== '||'
    ) {
      previous.count++;
      continue;
    }
    heads.push({
      head,
      separatorBefore,
      count: 1,
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
    if (entry.count > 1) {
      output += ` ×${entry.count}`;
    }
  });
  if (heads.length > MAX_SEGMENTS) {
    output += ' …';
  }
  return output;
}

export function extractCommandHead(command: string): string | undefined {
  return commandHead(command, 0);
}
