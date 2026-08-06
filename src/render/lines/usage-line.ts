/**
 * Usage Line Renderer
 * Renders: up 10m (session duration and other usage info)
 */

import type { HudData, LayoutConfig } from '../../types.js';
import { colors } from '../colors.js';

/**
 * Format duration in human-readable form
 */
function formatDuration(startTime: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - startTime.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return `${diffDay}d${diffHour % 24}h`;
  }
  if (diffHour > 0) {
    return `${diffHour}h${diffMin % 60}m`;
  }
  if (diffMin > 0) {
    return `${diffMin}m`;
  }
  return `${diffSec}s`;
}

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

  const startTime = data.session?.startTime ?? data.sessionStart;
  const duration = formatDuration(startTime);
  return colors.dim(`up ${duration}`);
}
