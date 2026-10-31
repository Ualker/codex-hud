// Preloaded only by benchmark-runtime.mjs, never by a normal HUD launch.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getProbeDiagnostics } from '../dist/utils/probe-latency.js';
import { getSqliteDiagnostics } from '../dist/utils/sqlite-probe.js';

const started = performance.now();
const initialCpu = process.cpuUsage();
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
const subprocesses = {};
let stdoutWrites = 0;
let peakRss = 0;
let peakHeap = 0;
let peakExternal = 0;
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = function(command, ...args) {
    const kind = String(command).split('/').at(-1);
    subprocesses[kind] = (subprocesses[kind] ?? 0) + 1;
    return original.call(this, command, ...args);
  };
  // execFile's custom promisifier returns { stdout, stderr }. A transparent
  // counter must preserve that contract or every async collector fails.
  if (name === 'execFile') childProcess[name][promisify.custom] = (file, args, options) =>
    new Promise((resolve, reject) => childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
      else resolve({ stdout, stderr });
    }));
}
syncBuiltinESMExports();
const write = process.stdout.write;
process.stdout.write = function(...args) { stdoutWrites++; return write.apply(this, args); };
function flush() {
  const cpu = process.cpuUsage(initialCpu);
  const memory = process.memoryUsage();
  const rss = memory.rss;
  peakRss = Math.max(peakRss, rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakExternal = Math.max(peakExternal, memory.external);
  let fileDescriptors;
  try { fileDescriptors = fs.readdirSync('/dev/fd').length; } catch { /* Platform optional. */ }
  fs.writeFileSync(process.env.HUD_BENCH_METRICS, JSON.stringify({
    pid: process.pid, elapsedMs: performance.now() - started,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssMiB: rss / 1048576, peakRssMiB: peakRss / 1048576,
    mainHeapUsedMiB: memory.heapUsed / 1048576, mainExternalMiB: memory.external / 1048576,
    mainArrayBuffersMiB: memory.arrayBuffers / 1048576,
    mainPeakHeapMiB: peakHeap / 1048576, mainPeakExternalMiB: peakExternal / 1048576,
    eventLoopP95Ms: eventLoop.percentile(95) / 1e6, eventLoopMaxMs: eventLoop.max / 1e6,
    stdoutWrites, fileDescriptors, subprocesses, probes: getProbeDiagnostics(), sqlite: getSqliteDiagnostics(),
  }));
}
setInterval(flush, 500).unref();
process.once('exit', flush);
