/**
 * Project Line Renderer
 * Renders: project-name git:(branch * ↑1 ↓2)
 * Oh-My-Zsh style git status display
 */

import type { HudData, GitStatus } from '../../types.js';
import { theme, icons, colors, sanitizeTerminalText, truncateAnsi, visualLength, truncate } from '../colors.js';
import { osc8Link, fileUrl } from '../../utils/hyperlinks.js';

/**
 * Render git sync status (ahead/behind)
 */
function renderGitSync(git: GitStatus): string {
  const parts: string[] = [];
  
  if (git.ahead > 0) {
    parts.push(theme.gitAhead(`${icons.ahead}${git.ahead}`));
  }
  if (git.behind > 0) {
    parts.push(theme.gitBehind(`${icons.behind}${git.behind}`));
  }
  
  return parts.join('');
}

/**
 * Render git file stats
 * Format: !N +N ✘N ?N
 */
function renderGitFileStats(git: GitStatus): string {
  const parts: string[] = [];
  
  if (git.modified > 0) {
    parts.push(theme.warning(`${icons.modified}${git.modified}`));
  }
  if (git.added > 0) {
    parts.push(theme.success(`${icons.added}${git.added}`));
  }
  if (git.deleted > 0) {
    parts.push(theme.error(`${icons.deleted}${git.deleted}`));
  }
  if (git.untracked > 0) {
    parts.push(colors.dim(`${icons.untracked}${git.untracked}`));
  }
  
  return parts.join(' ');
}

/**
 * Render the project line
 * Format: project-name git:(branch * ↑1)
 */
type ProjectLineOptions = {
  includeFileStats?: boolean;
  maxWidth?: number;
};

export function renderProjectLine(data: HudData, options: ProjectLineOptions = {}): string {
  const includeFileStats = options.includeFileStats !== false;
  const maxWidth = options.maxWidth;
  
  // Project name (yellow like claude-hud), clickable via OSC 8 when a cwd
  // is known.
  const projectName =
    sanitizeTerminalText(data.project.projectName) || 'project';
  const projectCwd = data.project.cwd;
  const linkProject = (label: string): string =>
    projectCwd ? osc8Link(label, fileUrl(projectCwd)) : label;
  const projectLabel = linkProject(theme.projectName(projectName));
  const parts: string[] = [projectLabel];
  let gitDisplay = '';
  let fileStats = '';
  
  // Git status (if in a git repo)
  if (data.git.isGitRepo && data.git.branch) {
    // Build git status string
    let gitContent = sanitizeTerminalText(data.git.branch);
    
    // Add dirty indicator
    if (data.git.isDirty) {
      gitContent += ` ${icons.dirty}`;
    }
    
    // Add sync status (ahead/behind)
    const syncStatus = renderGitSync(data.git);
    if (syncStatus) {
      gitContent += ` ${syncStatus}`;
    }
    
    // Format as "git:(branch * ↑1)"
    gitDisplay = theme.gitPrefix('git:(') + theme.gitBranch(gitContent) + theme.gitPrefix(')');
    parts.push(gitDisplay);
    
    // Add file stats if any
    if (includeFileStats) {
      fileStats = renderGitFileStats(data.git);
      if (fileStats) {
        parts.push(fileStats);
      }
    }
  }
  
  let line = parts.join(' ');
  if (maxWidth === undefined || visualLength(line) <= maxWidth) {
    return line;
  }

  // Every remaining path must honour maxWidth. Returning an untruncated git
  // segment pushed row 1 past the pane width and left the outer clamp to cut
  // it blind, losing the trailing ahead/behind markers mid-token.
  if (maxWidth <= 0) {
    return '';
  }

  // Retry without file stats if present.
  if (fileStats) {
    line = [projectLabel, gitDisplay].filter(Boolean).join(' ');
    if (visualLength(line) <= maxWidth) {
      return line;
    }
  }

  if (gitDisplay) {
    const gitSegment = ` ${gitDisplay}`;
    const availableForProject = maxWidth - visualLength(gitSegment);
    if (availableForProject <= 0) {
      return truncateAnsi(gitDisplay, maxWidth);
    }
    const truncatedName = truncate(projectName, availableForProject);
    return truncateAnsi(
      [linkProject(theme.projectName(truncatedName)), gitDisplay].join(' '),
      maxWidth
    );
  }

  const truncatedName = truncate(projectName, maxWidth);
  return truncateAnsi(linkProject(theme.projectName(truncatedName)), maxWidth);
}
