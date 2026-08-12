/**
 * Usage Line Renderer
 * Renders: up 10m (session duration and other usage info)
 */

import type { HudData, LayoutConfig } from '../../types.js';
import { colors } from '../colors.js';
import { formatUptime } from '../../utils/format-age.js';

/**
 * Render the usage line
 * Format: up 10m
 *
 * Plain dim text instead of the ⏱️ emoji: it was the only emoji in the HUD
 * (every other glyph is a text-style character) and its VS16 width is
 * ambiguous in some terminals.
 */
export function renderUsageLine(data: HudData, layout: LayoutConfig): string | null {
  if (!layout.showDuration) {
    return null;
  }

  // Only a bound session has an uptime. Falling back to the HUD process start
  // made the provisional first frame claim "up 0s" for a session that turned
  // out to be hours old, and put "up 3h0m" next to
  // "○ Waiting for a Codex session…" — an uptime for a session that does not
  // exist. Saying nothing is the honest form of both.
  const startTime = data.session?.startTime;
  if (!startTime) {
    return null;
  }
  return colors.dim(`up ${formatUptime(startTime)}`);
}
