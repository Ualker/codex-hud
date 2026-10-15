import type { Stats } from 'fs';

/** Identity plus revision: size alone misses atomic replacement and rewrites. */
export type FileVersion = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;

export function sameFile(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function fileWasReplaced(previous: FileVersion, current: FileVersion): boolean {
  return !sameFile(previous, current) || current.size < previous.size ||
    (current.size === previous.size && !sameFileVersion(previous, current));
}
