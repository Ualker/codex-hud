/**
 * Git status collector
 * Phase 3: Extended with ahead/behind sync status and file change counts
 */

import { execFile, execFileSync, execSync } from 'child_process';
import type { GitStatus } from '../types.js';

const GIT_STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '--untracked-files=normal',
];
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export function emptyGitStatus(): GitStatus {
  return {
    branch: null,
    isDirty: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

function isNotRepositoryError(stderr: string): boolean {
  return (
    stderr.includes('not a git repository') ||
    stderr.includes('must be run in a work tree')
  );
}

/**
 * Parse the single porcelain-v2 status call used by the live HUD.
 */
export function parsePorcelainV2Status(output: string): GitStatus {
  const status = {
    ...emptyGitStatus(),
    isGitRepo: true,
  };
  let head = '';
  let oid = '';

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }

    if (line.startsWith('? ')) {
      status.untracked++;
      status.isDirty = true;
      continue;
    }
    if (line.startsWith('! ') || line.startsWith('# ')) {
      continue;
    }

    const recordKind = line[0];
    if (recordKind !== '1' && recordKind !== '2' && recordKind !== 'u') {
      continue;
    }
    const xy = line.split(' ', 3)[1] ?? '..';
    const indexStatus = xy[0] ?? '.';
    const workTreeStatus = xy[1] ?? '.';
    status.isDirty = true;

    if (
      indexStatus === 'M' ||
      workTreeStatus === 'M' ||
      indexStatus === 'T' ||
      workTreeStatus === 'T' ||
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      recordKind === 'u'
    ) {
      status.modified++;
    } else if (indexStatus === 'A') {
      status.added++;
    } else if (indexStatus === 'D' || workTreeStatus === 'D') {
      status.deleted++;
    } else {
      status.modified++;
    }
  }

  status.branch =
    head && head !== '(detached)'
      ? head
      : oid && oid !== '(initial)'
        ? oid.slice(0, 7)
        : null;
  return status;
}

function collectGitStatusOnce(cwd?: string): GitStatus {
  try {
    const output = execFileSync('git', GIT_STATUS_ARGS, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnvironment(),
    });
    return parsePorcelainV2Status(output);
  } catch {
    return emptyGitStatus();
  }
}

/**
 * Non-blocking live collector. Exactly one Git process is spawned per refresh.
 */
export function collectGitStatusAsync(cwd?: string): Promise<GitStatus> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      GIT_STATUS_ARGS,
      {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: gitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(parsePorcelainV2Status(stdout));
          return;
        }
        if (isNotRepositoryError(stderr)) {
          resolve(emptyGitStatus());
          return;
        }
        reject(
          new Error(
            stderr.trim() ||
            error.message ||
            'Unable to collect Git status'
          )
        );
      }
    );
  });
}

/**
 * Execute a git command and return the output
 * Returns null if the command fails
 */
function execGit(args: string[], cwd?: string): string | null {
  try {
    const result = execSync(`git ${args.join(' ')}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000, // 5 second timeout
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Check if current directory is inside a git repository
 */
export function isGitRepo(cwd?: string): boolean {
  const result = execGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return result === 'true';
}

/**
 * Get the current git branch name
 */
export function getBranch(cwd?: string): string | null {
  // Try to get branch name
  let branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  
  // If HEAD is detached, try to get a tag or short SHA
  if (branch === 'HEAD') {
    // Try tag
    const tag = execGit(['describe', '--tags', '--exact-match'], cwd);
    if (tag) {
      return `tag:${tag}`;
    }
    // Fall back to short SHA
    const sha = execGit(['rev-parse', '--short', 'HEAD'], cwd);
    if (sha) {
      return sha;
    }
  }
  
  return branch;
}

/**
 * Check if the git working tree has uncommitted changes
 */
export function isDirty(cwd?: string): boolean {
  const status = execGit(['status', '--porcelain'], cwd);
  return status !== null && status.length > 0;
}

/**
 * Get ahead/behind counts relative to upstream
 * Returns { ahead: N, behind: N }
 */
export function getAheadBehind(cwd?: string): { ahead: number; behind: number } {
  // Get the tracking branch info
  const result = execGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd);
  
  if (!result) {
    return { ahead: 0, behind: 0 };
  }
  
  // Format is "behind\tahead"
  const parts = result.split(/\s+/);
  if (parts.length >= 2) {
    return {
      behind: parseInt(parts[0], 10) || 0,
      ahead: parseInt(parts[1], 10) || 0,
    };
  }
  
  return { ahead: 0, behind: 0 };
}

/**
 * Parse git status --porcelain output to count file changes
 * Returns { modified, added, deleted, untracked }
 */
export function getFileChangeCounts(cwd?: string): {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
} {
  const status = execGit(['status', '--porcelain'], cwd);
  
  const counts = {
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  };
  
  if (!status) {
    return counts;
  }
  
  // Parse each line
  for (const line of status.split('\n')) {
    if (!line) continue;
    
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    
    // Untracked files
    if (indexStatus === '?' && workTreeStatus === '?') {
      counts.untracked++;
      continue;
    }
    
    // Modified (either in index or work tree)
    if (indexStatus === 'M' || workTreeStatus === 'M') {
      counts.modified++;
      continue;
    }
    
    // Added (new file in index)
    if (indexStatus === 'A') {
      counts.added++;
      continue;
    }
    
    // Deleted
    if (indexStatus === 'D' || workTreeStatus === 'D') {
      counts.deleted++;
      continue;
    }
    
    // Renamed, copied, etc. count as modified
    if (indexStatus === 'R' || indexStatus === 'C') {
      counts.modified++;
      continue;
    }
  }
  
  return counts;
}

/**
 * Get the repository root directory
 */
export function getRepoRoot(cwd?: string): string | null {
  return execGit(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Collect all git status information
 * Phase 3: Extended with sync status and file counts
 */
export function collectGitStatus(cwd?: string): GitStatus {
  return collectGitStatusOnce(cwd);
}

/**
 * Format git status for display
 */
export function formatGitStatus(status: GitStatus): string {
  if (!status.isGitRepo) {
    return '';
  }
  
  const branch = status.branch || 'unknown';
  const indicator = status.isDirty ? '●' : '';
  
  return `git:(${branch})${indicator ? ' ' + indicator : ''}`;
}
