import type { Stats } from 'fs';
import * as fs from 'node:fs';

/** Identity plus revision: size alone misses atomic replacement and rewrites. */
export type FileVersion = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'> & {
  head?: Buffer;
  tail?: Buffer;
  tailOffset?: number;
  previousContentMatches?: boolean;
};

/** Check both identity and the old append boundary; changed files cost at most 2 KiB. */
export function readFileVersion(file: string, previous?: FileVersion | null): FileVersion {
  const version: FileVersion = fs.statSync(file);
  if (previous && sameFileVersion(previous, version)) {
    return { ...previous, previousContentMatches: true };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const read = (offset: number, length: number): Buffer => {
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, offset));
    };
    const head = read(0, Math.min(512, version.size));
    const tailOffset = Math.max(0, version.size - 512);
    const tail = read(tailOffset, version.size - tailOffset);
    const previousContentMatches = !previous?.head || !previous.tail ||
      (head.subarray(0, previous.head.length).equals(previous.head) &&
        read(previous.tailOffset ?? 0, previous.tail.length).equals(previous.tail));
    return { ...version, head, tail, tailOffset, previousContentMatches };
  } finally { fs.closeSync(fd); }
}

export function sameFile(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function fileWasReplaced(previous: FileVersion, current: FileVersion): boolean {
  return !sameFile(previous, current) || current.size < previous.size ||
    current.previousContentMatches === false ||
    (current.size === previous.size && !sameFileVersion(previous, current));
}
