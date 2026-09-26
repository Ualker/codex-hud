import { open, realpath } from 'node:fs/promises';
import { asRecord } from '../protocol/rollout-record.js';
/** A newly created root in this cwd can be /new; unrelated roots/children do not wake a single view. */
export async function isRootRolloutForCwd(filePath: string, cwd: string): Promise<boolean> {
  if (!filePath.endsWith('.jsonl'))
    return false;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    const entry = asRecord(JSON.parse(first)), meta = asRecord(entry?.payload);
    if (entry?.type !== 'session_meta' || typeof meta?.cwd !== 'string' || asRecord(meta.source)?.subagent)
      return false;
    return (await realpath(meta.cwd)) === cwd;
  }
  catch {
    return false;
  }
  finally {
    await handle?.close();
  }
}
