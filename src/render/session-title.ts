import { sanitizeTerminalText } from './colors.js';

/** Keep task/file identity instead of spending the heading on parent paths. */
export function compactSessionTitle(title: string | undefined, cwd?: string): string {
  if (!title) return '';
  const directory = sanitizeTerminalText(cwd ?? '').replace(/\/+$/, '');
  let clean = sanitizeTerminalText(title);

  // Handle a quoted path (including spaces), then ordinary Unix paths.
  // A slash following ':' or '/' belongs to a URL and is left alone.
  const shorten = (value: string): string => {
    const normalized = value.replace(/\/+$/, '');
    if (directory && normalized === directory) return '';
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  };
  clean = clean.replace(/(["'])(\/[^"'\n]+|~\/[^"'\n]+)\1/g,
    (_match, _quote: string, value: string) => shorten(value));
  clean = clean.replace(/(?<![\w/:])(?:~\/|\/)[^\s"'`<>，。；：！？、,;:!?()[\]{}]+/gu,
    (value) => shorten(value));
  return clean.replace(/^[\s,，:：]+/, '').replace(/\s+/g, ' ').trim();
}
