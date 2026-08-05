/**
 * OSC 8 terminal hyperlinks. Modern terminals (and tmux >= 3.4) make the
 * wrapped text clickable; terminals without support silently drop the
 * sequences and show the plain text.
 */

const ALLOWED_PROTOCOLS = /^(?:https:|file:)/;

function hyperlinksEnabled(): boolean {
  return !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

/** Wrap text in an OSC 8 hyperlink; returns plain text for unsafe URLs. */
export function osc8Link(text: string, url: string): string {
  if (!hyperlinksEnabled() || !ALLOWED_PROTOCOLS.test(url)) {
    return text;
  }
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * file:// URL for an absolute local path, usable in OSC 8 links.
 * The empty authority (file:///path) is the portable local form; embedding
 * os.hostname() makes some terminals (e.g. iTerm2) treat the link as remote
 * and refuse to open it.
 */
export function fileUrl(absolutePath: string): string {
  const encoded = absolutePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `file://${encoded}`;
}
