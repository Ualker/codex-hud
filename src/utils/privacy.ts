/** Explicit labels remain useful when prompt-derived session titles are hidden. */
export function sessionTitle(title?: string, label?: string): string | undefined {
  return label || (process.env.CODEX_HUD_HIDE_TITLES === '1' ? undefined : title);
}
