import { open } from 'fs/promises';

export interface JsonlTailBatch<T> {
  records: T[];
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
    // allocUnsafe skips zero-filling; the read loop below either fills every
    // byte or throws, so uninitialized memory is never observed.
    const bytes = Buffer.allocUnsafe(fileSize - startOffset);

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
        nextOffset: startOffset,
        truncated,
        malformedLines: 0,
      };
    }

    const committed = bytes.subarray(0, finalNewlineIndex + 1);
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
      nextOffset: startOffset + committed.byteLength,
      truncated,
      malformedLines,
    };
  } finally {
    await handle.close();
  }
}
