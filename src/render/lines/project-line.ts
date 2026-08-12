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
  let gitContent = '';
  let fileStats = '';

  // Format as "git:(branch * ↑1)"
  const buildGitDisplay = (content: string): string =>
    theme.gitPrefix('git:(') + theme.gitBranch(content) + theme.gitPrefix(')');

  // Git status (if in a git repo)
  if (data.git.isGitRepo && data.git.branch) {
    // Build git status string
    gitContent = sanitizeTerminalText(data.git.branch);

    // Add dirty indicator
    if (data.git.isDirty) {
      gitContent += ` ${icons.dirty}`;
    }

    // Add sync status (ahead/behind)
    const syncStatus = renderGitSync(data.git);
    if (syncStatus) {
      gitContent += ` ${syncStatus}`;
    }

    gitDisplay = buildGitDisplay(gitContent);
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

  // Shrink the branch, not the project name. The old order reserved the whole
  // git segment first and spent whatever remained on the project, so a 34-char
  // branch survived intact while the project name decayed to "…" and then
  // vanished — backwards, because on a narrow pane with several sessions open
  // "which project is this" is the identity the row exists to carry.
  if (gitDisplay) {
    const projectWidth = visualLength(projectLabel);
    // "git:()" plus at least one character of branch; below that the segment
    // states nothing and the row is better off spending the cells on the name.
    const gitOverhead = visualLength('git:()');
    const availableForGit = maxWidth - projectWidth - 1;
    if (availableForGit > gitOverhead) {
      return truncateAnsi(
        [
          projectLabel,
          buildGitDisplay(truncate(gitContent, availableForGit - gitOverhead)),
        ].join(' '),
        maxWidth
      );
    }
  }

  const truncatedName = truncate(projectName, maxWidth);
  return truncateAnsi(linkProject(theme.projectName(truncatedName)), maxWidth);
}
