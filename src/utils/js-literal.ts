/**
 * A tolerant reader for the JavaScript object literals codex writes as tool
 * arguments.
 *
 * codex-cli 0.147 moved every tool behind a single `exec` custom tool whose
 * input is a JavaScript program:
 *
 *   const r = await tools.exec_command({cmd: "rg -n pattern src", workdir: "/repo"})
 *
 * The argument is therefore JS source, not JSON: keys are unquoted, strings may
 * use single quotes or backticks, and trailing commas are allowed. Handing it
 * to `JSON.parse` fails on every call — measured across four live rollouts,
 * 254 of 254 — which is why the tool row lost its commands, the plan row
 * stopped rendering, and non-zero exits stopped being reported.
 *
 * This is deliberately not a JavaScript evaluator. It reads the literal subset
 * that appears in tool arguments and gives up on anything else, per value: a
 * key whose value is a variable or a call expression is dropped while its
 * siblings still parse, so `{cmd: "…", timeout: computed()}` still yields the
 * command.
 */

/** Arguments carrying a whole patch are the largest seen; beyond this the input is not a tool argument we display. */
const MAX_SOURCE_LENGTH = 512 * 1024;
/** Tool arguments are flat records of scalars, arrays, and step objects. */
const MAX_DEPTH = 8;

interface Cursor {
  readonly source: string;
  index: number;
}

function skipTrivia(cursor: Cursor): void {
  const { source } = cursor;
  while (cursor.index < source.length) {
    const char = source[cursor.index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      cursor.index++;
      continue;
    }
    if (char === '/' && source[cursor.index + 1] === '/') {
      while (cursor.index < source.length && source[cursor.index] !== '\n') {
        cursor.index++;
      }
      continue;
    }
    if (char === '/' && source[cursor.index + 1] === '*') {
      cursor.index += 2;
      while (
        cursor.index < source.length &&
        !(source[cursor.index] === '*' && source[cursor.index + 1] === '/')
      ) {
        cursor.index++;
      }
      cursor.index += 2;
      continue;
    }
    return;
  }
}

const SINGLE_CHAR_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/**
 * Read a string literal. Template literals are read as text: an interpolation
 * is kept verbatim (`ssh ${host} ls`) because the value is only ever displayed,
 * and the surrounding command is worth more than the hole in the middle.
 */
function readString(cursor: Cursor): string | undefined {
  const { source } = cursor;
  const quote = source[cursor.index];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return undefined;
  }
  let out = '';
  let index = cursor.index + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        return undefined;
      }
      if (escaped === 'u' || escaped === 'x') {
        const width = escaped === 'u' ? 4 : 2;
        const digits = source.slice(index + 2, index + 2 + width);
        const code = Number.parseInt(digits, 16);
        if (digits.length === width && Number.isFinite(code)) {
          out += String.fromCharCode(code);
          index += 2 + width;
          continue;
        }
        out += escaped;
        index += 2;
        continue;
      }
      out += SINGLE_CHAR_ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (char === quote) {
      cursor.index = index + 1;
      return out;
    }
    out += char;
    index++;
  }
  return undefined;
}

/** Property keys are bare identifiers far more often than quoted strings. */
function readKey(cursor: Cursor): string | undefined {
  const { source } = cursor;
  const char = source[cursor.index];
  if (char === '"' || char === "'" || char === '`') {
    return readString(cursor);
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(cursor.index));
  if (!match) {
    return undefined;
  }
  cursor.index += match[0].length;
  return match[0];
}

/**
 * Step over one value without interpreting it, so an unparseable entry costs
 * only its own key rather than the rest of the object.
 */
function skipValue(cursor: Cursor): void {
  const { source } = cursor;
  let depth = 0;
  while (cursor.index < source.length) {
    const char = source[cursor.index];
    if (char === '"' || char === "'" || char === '`') {
      if (readString(cursor) === undefined) {
        cursor.index = source.length;
      }
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth++;
      cursor.index++;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      if (depth === 0) {
        return;
      }
      depth--;
      cursor.index++;
      continue;
    }
    if (char === ',' && depth === 0) {
      return;
    }
    cursor.index++;
  }
}

function readValue(cursor: Cursor, depth: number): unknown {
  skipTrivia(cursor);
  const { source } = cursor;
  const char = source[cursor.index];
  if (char === undefined) {
    return undefined;
  }

  if (char === '"' || char === "'" || char === '`') {
    return readString(cursor);
  }

  if (char === '{') {
    if (depth >= MAX_DEPTH) {
      skipValue(cursor);
      return undefined;
    }
    return readObject(cursor, depth + 1);
  }

  if (char === '[') {
    if (depth >= MAX_DEPTH) {
      skipValue(cursor);
      return undefined;
    }
    return readArray(cursor, depth + 1);
  }

  const literal = /^(true|false|null|undefined)\b/.exec(source.slice(cursor.index));
  if (literal) {
    cursor.index += literal[0].length;
    switch (literal[0]) {
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        return null;
    }
  }

  const numeric = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(
    source.slice(cursor.index)
  );
  if (numeric) {
    cursor.index += numeric[0].length;
    return Number(numeric[0]);
  }

  // An identifier, call expression, spread, or anything else this reader does
  // not model. The caller drops the entry and keeps its siblings.
  skipValue(cursor);
  return undefined;
}

function readArray(cursor: Cursor, depth: number): unknown[] {
  const out: unknown[] = [];
  cursor.index++; // consume '['
  for (;;) {
    skipTrivia(cursor);
    const char = cursor.source[cursor.index];
    if (char === undefined) {
      return out;
    }
    if (char === ']') {
      cursor.index++;
      return out;
    }
    if (char === ',') {
      cursor.index++;
      continue;
    }
    out.push(readValue(cursor, depth));
  }
}

function readObject(cursor: Cursor, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  cursor.index++; // consume '{'
  for (;;) {
    skipTrivia(cursor);
    const char = cursor.source[cursor.index];
    if (char === undefined) {
      return out;
    }
    if (char === '}') {
      cursor.index++;
      return out;
    }
    if (char === ',') {
      cursor.index++;
      continue;
    }

    const key = readKey(cursor);
    if (key === undefined) {
      // Not a property at all (a spread, a computed key): skip to the next
      // entry rather than abandoning the object.
      skipValue(cursor);
      continue;
    }
    skipTrivia(cursor);
    if (cursor.source[cursor.index] !== ':') {
      // Shorthand property (`{cmd}`): the value lives in a variable this
      // reader cannot resolve.
      skipValue(cursor);
      continue;
    }
    cursor.index++;
    const value = readValue(cursor, depth);
    if (value !== undefined) {
      out[key] = value;
    }
  }
}

/**
 * Find the first string literal in a JavaScript program whose decoded text
 * contains `needle`, and return that text.
 *
 * Not every tool argument is written inline: `apply_patch` is always called as
 * `tools.apply_patch(patch)` with the patch assigned to a variable further up
 * the script, so the literal reader sees an identifier and nothing else. The
 * patch body is still right there in the source as a string literal, and
 * decoding it is what turns `✓ apply_patch` back into the file that changed.
 */
export function findJsStringContaining(
  source: string | undefined,
  needle: string
): string | undefined {
  if (!source || source.length > MAX_SOURCE_LENGTH) {
    return undefined;
  }
  const cursor: Cursor = { source, index: 0 };
  while (cursor.index < source.length) {
    const char = source[cursor.index];
    if (char === '"' || char === "'" || char === '`') {
      const start = cursor.index;
      const text = readString(cursor);
      if (text === undefined) {
        cursor.index = start + 1;
        continue;
      }
      if (text.includes(needle)) {
        return text;
      }
      continue;
    }
    cursor.index++;
  }
  return undefined;
}

/**
 * Parse a JavaScript object or array literal into plain data.
 *
 * Returns undefined when the source is not a literal at all, so callers can
 * try strict JSON first and fall back to this without changing behavior for
 * the tool protocols that do send JSON.
 */
export function parseJsLiteral(source: string | undefined): unknown {
  if (!source || source.length > MAX_SOURCE_LENGTH) {
    return undefined;
  }
  const cursor: Cursor = { source, index: 0 };
  skipTrivia(cursor);
  const char = source[cursor.index];
  if (char !== '{' && char !== '[') {
    return undefined;
  }
  const value = readValue(cursor, 0);
  return value;
}
