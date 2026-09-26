import { open } from 'fs/promises';
export class JsonlReadError extends Error {
  constructor(public readonly code: 'JSONL_RECORD_TOO_LARGE' | 'JSONL_INVALID' | 'JSONL_TRUNCATED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonlReadError';
  }
}
/**
 * Replay complete records without retaining the whole history. The EOF is
 * captured once, so a busy writer cannot extend a scan forever. Callers stage
 * their state and commit it only after this function succeeds; a partial last
 * line is retried from its beginning on the next scan.
 */
export async function scanCompleteJsonl(filePath: string, fromOffset: number, consume: (record: unknown) => void | Promise<void>, maxLineBytes: number = 64 * 1024 * 1024): Promise<number> {
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
    throw new RangeError('JSONL offset must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError('JSONL line limit must be a positive safe integer.');
  }
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < fromOffset) {
      throw new JsonlReadError('JSONL_TRUNCATED', `JSONL file was truncated below committed offset ${fromOffset}: ${filePath}`);
    }
    let position = fromOffset;
    let nextOffset = fromOffset;
    let fragments: Buffer[] = [];
    let lineBytes = 0;
    const append = (fragment: Buffer): void => {
      lineBytes += fragment.length;
      if (lineBytes > maxLineBytes) {
        throw new JsonlReadError('JSONL_RECORD_TOO_LARGE', `JSONL record at byte ${nextOffset} exceeds the ${maxLineBytes}-byte limit: ${filePath}`);
      }
      if (fragment.length > 0)
        fragments.push(fragment);
    };
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        throw new JsonlReadError('JSONL_TRUNCATED', `Unexpected end of JSONL file at offset ${position}: ${filePath}`);
      }
      const bytes = chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, start);
        if (newline < 0) {
          append(bytes.subarray(start));
          break;
        }
        append(bytes.subarray(start, newline));
        const line = (fragments.length === 1
          ? fragments[0] : Buffer.concat(fragments, lineBytes)).toString('utf8');
        fragments = [];
        lineBytes = 0;
        if (line.trim().length > 0) {
          let record: unknown;
          try {
            record = JSON.parse(line);
          }
          catch (error) {
            throw new JsonlReadError('JSONL_INVALID', `Invalid JSONL record at byte ${nextOffset}: ${filePath}`, { cause: error });
          }
          await consume(record);
        }
        nextOffset = position + newline + 1;
        start = newline + 1;
        if (start >= bytes.length)
          break;
      }
      position += bytesRead;
    }
    return nextOffset;
  }
  finally {
    await handle.close();
  }
}
export interface JsonlTailBatch<T> {
  records: T[];
  /** Absolute offset of the first record returned after optional alignment. */
  recordsStartOffset: number;
  nextOffset: number;
  truncated: boolean;
  /** Newline-terminated lines that failed JSON.parse and were skipped. */
  malformedLines: number;
  pendingBytes?: number;
}
export interface JsonlTailOptions {
  /**
   * Skip committed lines that fail JSON.parse instead of throwing. The HUD
   * rollout parser prefers availability; authoritative agent tracking keeps
   * the default strict behavior so protocol drift surfaces as an error.
   */
  skipMalformed?: boolean;
  validateRecord?: (record: unknown) => boolean;
  /** Target batch size. Extend only to accommodate a single complete record. */
  batchBytes?: number;
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
export async function readCompleteJsonl<T>(filePath: string, fromOffset: number, options: JsonlTailOptions = {}): Promise<JsonlTailBatch<T>> {
  if (!Number.isFinite(fromOffset) || !Number.isInteger(fromOffset) || fromOffset < 0) {
    throw new RangeError('JSONL offset must be a non-negative finite integer.');
  }
  if (options.batchBytes !== undefined && (!Number.isSafeInteger(options.batchBytes) || options.batchBytes <= 0)) {
    throw new RangeError('JSONL batchBytes must be a positive safe integer.');
  }
  const handle = await open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const truncated = fileSize < fromOffset;
    const startOffset = truncated ? 0 : fromOffset;
    const requestedEnd = options.toOffset !== undefined
      ? Math.max(startOffset, Math.min(fileSize, options.toOffset))
      : fileSize;
    let endOffset = options.batchBytes === undefined ? requestedEnd
      : Math.min(requestedEnd, startOffset + options.batchBytes);
    if (options.maxBytes !== undefined &&
      endOffset - startOffset > options.maxBytes) {
      throw new Error(`JSONL batch of ${endOffset - startOffset} bytes exceeds the ${options.maxBytes}-byte limit: ${filePath}`);
    }
    // allocUnsafe skips zero-filling; the read loop below either fills every
    // byte or throws, so uninitialized memory is never observed.
    let bytes = Buffer.allocUnsafe(endOffset - startOffset);
    let totalBytesRead = 0;
    for (;;) {
      while (totalBytesRead < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, totalBytesRead, bytes.byteLength - totalBytesRead, startOffset + totalBytesRead);
        if (bytesRead === 0) {
          throw new Error(`Unexpected end of JSONL file at offset ${startOffset + totalBytesRead}.`);
        }
        totalBytesRead += bytesRead;
      }
      if (!options.batchBytes || bytes.includes(0x0a) || endOffset >= requestedEnd)
        break;
      const capacity = Math.min(options.maxBytes ?? 64 * 1024 * 1024, Math.max(bytes.length * 2, options.batchBytes));
      if (capacity <= bytes.length) {
        throw new JsonlReadError('JSONL_RECORD_TOO_LARGE', `JSONL record at byte ${startOffset} exceeds the ${capacity}-byte limit: ${filePath}`);
      }
      endOffset = Math.min(requestedEnd, startOffset + capacity);
      const expanded = Buffer.allocUnsafe(endOffset - startOffset);
      bytes.copy(expanded);
      bytes = expanded;
    }
    const finalNewlineIndex = bytes.lastIndexOf(0x0a);
    if (finalNewlineIndex === -1) {
      return {
        records: [],
        recordsStartOffset: startOffset,
        nextOffset: startOffset,
        truncated,
        malformedLines: 0,
        pendingBytes: fileSize - startOffset,
      };
    }
    // A tail read starts mid-record; those leading bytes belong to a line
    // whose beginning was never read, so they are dropped rather than parsed.
    const scanStart = options.alignToLineStart && startOffset > 0
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
        const record: unknown = JSON.parse(line);
        if (options.validateRecord && !options.validateRecord(record)) {
          throw new JsonlReadError('JSONL_INVALID', 'Invalid JSONL record structure.');
        }
        records.push(record as T);
      }
      catch (error) {
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
      pendingBytes: fileSize - (startOffset + finalNewlineIndex + 1),
    };
  }
  finally {
    await handle.close();
  }
}
