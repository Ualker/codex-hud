/** Bounded terminal-safe text with common credential forms redacted. */
function stripTerminalSequences(value: string): string {
  return value
    // OSC sequences terminated by BEL or ST.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // CSI sequences.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining C0 controls except whitespace normalized below.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    // Bidirectional override/isolate controls can visually reorder a command.
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
}

function redactSensitiveText(value: string): string {
  let redacted = value;

  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    '$1***:***@'
  );
  redacted = redacted.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1 ***'
  );
  redacted = redacted.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s;&|]+)/g,
    (assignment, key: string, separator: string) =>
      /token|secret|password|passwd|api_?key|access_?key|private_?key|credential|authorization|cookie/i.test(key)
        ? `${key}${separator}***` : assignment
  );
  redacted = redacted.replace(
    /(--(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|client[-_]?secret|authorization|cookie|credential)(?:\s*=\s*|\s+))(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    '$1***'
  );
  redacted = redacted.replace(
    /((?:"|')?(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|client[-_]?secret|authorization|cookie|credential)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}]+)/gi,
    '$1***'
  );
  redacted = redacted.replace(
    /((?:authorization|proxy-authorization|cookie|x-api-key|api-key)\s*:\s*)(?:Bearer\s+|Basic\s+)?[^'"\s]+/gi,
    '$1***'
  );

  return redacted;
}

export function sanitizeDisplayText(value: string, maxLength: number): string | undefined {
  // Tool inputs can contain large heredocs. Only a bounded prefix can ever be
  // rendered, so bound the work before applying the redaction expressions.
  const inputLimit = Math.max(4096, maxLength * 4);
  const boundedInput = value.length > inputLimit
    ? `${value.slice(0, inputLimit)}…`
    : value;
  const sanitized = redactSensitiveText(stripTerminalSequences(boundedInput))
    .replace(/[\r\n\t]+/g, ' ↵ ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}
