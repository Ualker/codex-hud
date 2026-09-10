/** HUD density is independent of how much of a tool command is displayed. */
let expandedOverride: boolean | undefined;

export function hudDetailsExpanded(): boolean {
  return expandedOverride ?? process.env.CODEX_HUD_DETAILS === 'full';
}

export function toggleHudDetails(): boolean {
  expandedOverride = !hudDetailsExpanded();
  return expandedOverride;
}
