import { open } from 'fs/promises';

export interface JsonlTailBatch<T> {
  records: T[];
  /** Absolute offset of the first record returned after optional alignment. */
  recordsStartOffset: number;
  nextOffset: number;
  truncated: boolean;
  /** Newline-terminated lines that failed JSON.parse and were skipped. */
  malformedLines: number;
}

export interface JsonlTailOptions {
  /**
   * Skip committed lines that fail JSON.parse instead of throwing. The HUD
   * rollout parser prefers availability; authoritative agent tracking keeps
   * the default strict behavior so protocol drift surfaces as an error.
   */
  skipMalformed?: boolean;
  /**
   * Refuse batches larger than this many bytes. The whole span is
   * materialized in memory, so a pathological rollout should surface as an
   * error (callers show it and back off) instead of ballooning the process.
   */
  maxBytes?: number;
  /**
   * Stop at this absolute byte offset instead of end-of-file. Lets a caller
   * read a bounded head of a large file without materializing the rest.
   */
  toOffset?: number;
  /**
   * Treat `fromOffset` as an arbitrary byte position rather than a known line
   * boundary: bytes up to the first newline are discarded instead of being
   * parsed as a truncated record. Required for tail reads, which would
   * otherwise report the leading fragment as a malformed line.
   */
  alignToLineStart?: boolean;
}

export async function readCompleteJsonl<T>(
  filePath: string,
  fromOffset: number,
  options: JsonlTailOptions = {}
): Promise<JsonlTailBatch<T>> {
  if (!Number.isFinite(fromOffset) || !Number.isInteger(fromOffset) || fromOffset < 0) {
    throw new RangeError('JSONL offset must be a non-negative finite integer.');
  }

  const handle = await open(filePath, 'r');

  try {
    const { size: fileSize } = await handle.stat();
    const truncated = fileSize < fromOffset;
    const startOffset = truncated ? 0 : fromOffset;
    const endOffset =
      options.toOffset !== undefined
        ? Math.max(startOffset, Math.min(fileSize, options.toOffset))
        : fileSize;
    if (
      options.maxBytes !== undefined &&
      endOffset - startOffset > options.maxBytes
    ) {
      throw new Error(
        `JSONL batch of ${endOffset - startOffset} bytes exceeds the ${options.maxBytes}-byte limit: ${filePath}`
      );
    }
    // allocUnsafe skips zero-filling; the read loop below either fills every
    // byte or throws, so uninitialized memory is never observed.
    const bytes = Buffer.allocUnsafe(endOffset - startOffset);

    let totalBytesRead = 0;
    while (totalBytesRead < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        totalBytesRead,
        bytes.byteLength - totalBytesRead,
        startOffset + totalBytesRead
      );

      if (bytesRead === 0) {
        throw new Error(`Unexpected end of JSONL file at offset ${startOffset + totalBytesRead}.`);
      }

      totalBytesRead += bytesRead;
    }

    const finalNewlineIndex = bytes.lastIndexOf(0x0a);
    if (finalNewlineIndex === -1) {
      return {
        records: [],
        recordsStartOffset: startOffset,
        nextOffset: startOffset,
        truncated,
        malformedLines: 0,
      };
    }

    // A tail read starts mid-record; those leading bytes belong to a line
    // whose beginning was never read, so they are dropped rather than parsed.
    const scanStart =
      options.alignToLineStart && startOffset > 0
        ? bytes.indexOf(0x0a) + 1
        : 0;
    const committed = bytes.subarray(scanStart, finalNewlineIndex + 1);
    const records: T[] = [];
    let malformedLines = 0;

    for (const line of committed.toString('utf8').split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }

      // A malformed line is committed (newline-terminated), so waiting will
      // not repair it; optionally skip it instead of failing the batch forever.
      try {
        records.push(JSON.parse(line) as T);
      } catch (error) {
        if (!options.skipMalformed) {
          throw error;
        }
        malformedLines++;
      }
    }

    return {
      records,
      recordsStartOffset: startOffset + scanStart,
      // Derived from the absolute final newline so a discarded leading
      // fragment cannot shift the committed cursor.
      nextOffset: startOffset + finalNewlineIndex + 1,
      truncated,
      malformedLines,
    };
  } finally {
    await handle.close();
  }
}
