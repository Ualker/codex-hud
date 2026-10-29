import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeSqliteDiagnostics } from '../utils/sqlite-probe.js';
import { startProbe } from '../utils/probe-latency.js';
import { readSharedSnapshot, writeSharedSnapshot } from '../utils/shared-snapshot.js';
import { logHudError } from '../utils/hud-log.js';

const exec = promisify(execFile);
const TIMEOUT_MS = 8000;
const CACHE_MS = 750;
interface Reply { value: string | null; supported: boolean }
interface Pending { resolve: (reply: Reply) => void; timer: NodeJS.Timeout }
let worker: Worker | undefined;
let retiringWorker: Worker | undefined;
let nativeSupported = Number(process.versions.node.split('.')[0]) >= 22;
let sequence = 0;
const pending = new Map<number, Pending>();

function releaseWorker(failedWorker: Worker): void {
  if (worker !== failedWorker) return;
  worker = undefined;
  retiringWorker = failedWorker;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.resolve({ value: null, supported: true });
  }
  pending.clear();
  void failedWorker.terminate().finally(() => {
    if (retiringWorker === failedWorker) retiringWorker = undefined;
  });
}

function queryWorker(file: string, statements: string[]): Promise<Reply> {
  // Native work may finish before thread termination takes effect. Never
  // accumulate replacement workers behind a stuck read-only statement.
  if (retiringWorker) return Promise.resolve({ value: null, supported: true });
  if (!worker) {
    // Do not inherit runtime instrumentation/preloads: they belong to the HUD
    // main thread and may otherwise overwrite its diagnostic snapshot.
    const created = new Worker(new URL('./sqlite-worker.js', import.meta.url), { execArgv: [], stdout: true, stderr: true });
    worker = created;
    created.on('message', message => {
      const request = pending.get(message.id);
      if (!request || worker !== created) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      mergeSqliteDiagnostics(message.diagnostics);
      request.resolve(message);
      if (pending.size === 0) created.unref();
    });
    created.on('error', error => { logHudError('sqlite-worker', error); releaseWorker(created); });
    created.on('exit', () => releaseWorker(created));
  }
  const active = worker;
  active.ref();
  return new Promise(resolve => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      logHudError('sqlite-worker', `Read-only query exceeded ${TIMEOUT_MS}ms; restarting worker`);
      releaseWorker(active);
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    active.postMessage({ id, file, statements });
  });
}

interface CachedQuery { key: string; at: number; value: string }
function reviveQueries(raw: unknown): CachedQuery[] | null {
  return Array.isArray(raw) && raw.length <= 32 && raw.every(entry => entry &&
    typeof entry.key === 'string' && typeof entry.value === 'string' && Number.isFinite(entry.at)) ? raw : null;
}
function readHeader(file: string, size: number): { version: string; bytes: Buffer } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    const bytes = Buffer.alloc(size);
    if (fs.readSync(fd, bytes, 0, size, 0) !== size) return null;
    return { version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, bytes };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function databaseVersion(file: string): string | null {
  // Rapid commits on overlayfs can have identical size and timestamps.
  // SQLite's header includes the rollback-journal change counter (offset 24).
  const database = readHeader(file, 32);
  if (!database) return null;
  const version = `${database.version}:${database.bytes.toString('hex')}`;
  try {
    fs.statSync(`${file}-wal`);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? version : null;
  }
  const wal = readHeader(`${file}-wal`, 32);
  // The first two 48-byte wal-index headers contain the transaction counter,
  // committed frame and generation salts. Readers' locks follow these headers.
  // A missing or partially updated index is safe to query, but not to cache.
  const index = readHeader(`${file}-shm`, 96);
  if (!wal || !index || !index.bytes.subarray(0, 48).equals(index.bytes.subarray(48))) return null;
  return `${version}|${wal.version}:${wal.bytes.toString('hex')}|${index.bytes.toString('hex')}`;
}

interface QueryCache {
  name: string;
  entries: Map<string, CachedQuery>;
  pending: Map<string, Promise<string | null>>;
  readAt: number;
  writtenAt: number;
}
const caches = new Map<string, QueryCache>();
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function cacheFor(file: string): QueryCache {
  let cache = caches.get(file);
  if (!cache) {
    if (caches.size >= 4) caches.delete(caches.keys().next().value!);
    cache = { name: `sqlite-${digest(file).slice(0, 20)}`, entries: new Map(), pending: new Map(), readAt: 0, writtenAt: 0 };
    caches.set(file, cache);
  }
  return cache;
}

function readShared(cache: QueryCache, now: number): void {
  cache.readAt = now;
  for (const entry of readSharedSnapshot(cache.name, CACHE_MS, reviveQueries, now) ?? []) {
    if (now - entry.at <= CACHE_MS && entry.at <= now && entry.at > (cache.entries.get(entry.key)?.at ?? 0)) {
      cache.entries.set(entry.key, entry);
    }
  }
  trimCache(cache, now);
}

function trimCache(cache: QueryCache, now: number): void {
  let size = 0;
  for (const [key, entry] of [...cache.entries].reverse()) {
    size += key.length + entry.value.length;
    if (now - entry.at > CACHE_MS || size > 64_000) cache.entries.delete(key);
  }
  while (cache.entries.size > 32) cache.entries.delete(cache.entries.keys().next().value!);
}

async function execute(file: string, statements: string[]): Promise<string | null> {
  if (nativeSupported) {
    const reply = await queryWorker(file, statements);
    nativeSupported = reply.supported;
    if (nativeSupported) return reply.value;
  }
  try {
    const result = await exec('sqlite3', ['-readonly', '-separator', '\x1f', file, statements.join(';\n') + ';'], {
      encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trimEnd();
  } catch { return null; }
}

/** Bounded, short-lived sharing; cache keys include database/WAL versions. */
export async function querySqlite(file: string, statements: string[]): Promise<string | null> {
  const finish = startProbe('sqlite');
  try {
    const now = Date.now();
    const version = databaseVersion(file);
    if (version === null) return await execute(file, statements);
    const key = digest(JSON.stringify([version, statements]));
    const cache = cacheFor(file);
    let cached = cache.entries.get(key);
    if (!cached || now - cached.at > CACHE_MS) {
      // A burst of related queries should read the shared file once, not once
      // per statement. Hot local results avoid disk reads altogether.
      if (now - cache.readAt >= 100) readShared(cache, now);
      cached = cache.entries.get(key);
    }
    if (cached && now - cached.at <= CACHE_MS && cached.at <= now) return cached.value;
    const active = cache.pending.get(key);
    if (active) return await active;
    const request = execute(file, statements).then(value => {
      // Never cache failures, large ledger answers or reads spanning a write.
      if (value !== null && value.length < 32_000 && databaseVersion(file) === version) {
        const at = Date.now();
        cache.entries.delete(key);
        cache.entries.set(key, { key, at, value });
        trimCache(cache, at);
        if (at - cache.writtenAt >= 100) {
          readShared(cache, at);
          writeSharedSnapshot(cache.name, [...cache.entries.values()], at);
          cache.writtenAt = at;
        }
      }
      return value;
    }).finally(() => cache.pending.delete(key));
    cache.pending.set(key, request);
    return await request;
  } finally { finish(); }
}
