/**
 * Git status collector
 * Phase 3: Extended with ahead/behind sync status and file change counts
 */

import { execFile, execFileSync } from 'child_process';
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
 * Collect all git status information (synchronous variant for scripts).
 */
export function collectGitStatus(cwd?: string): GitStatus {
  return collectGitStatusOnce(cwd);
}
