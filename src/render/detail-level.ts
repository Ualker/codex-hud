/** HUD density is independent of how much of a tool command is displayed. */
let expandedOverride: boolean | undefined;
let noticeUntilMs = 0;

export function hudDetailsExpanded(): boolean {
  return expandedOverride ?? process.env.CODEX_HUD_DETAILS === 'full';
}

export function toggleHudDetails(nowMs: number = Date.now()): boolean {
  expandedOverride = !hudDetailsExpanded();
  noticeUntilMs = nowMs + 3000;
  return expandedOverride;
}

/** Brief feedback even when both densities fit the same visible rows. */
export function hudDetailsNotice(nowMs: number = Date.now()): string | null {
  return nowMs < noticeUntilMs ? `Details: ${hudDetailsExpanded() ? 'full' : 'compact'}` : null;
}
