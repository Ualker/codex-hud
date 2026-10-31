// Runs before a build as well as from doctor. Match the renderer Worker's
// execArgv rather than assuming a Node major version proves native support.
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const native = await new Promise(resolve => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      const ok = db.prepare('SELECT 1 AS ready').get().ready === 1;
      db.close(); parentPort.postMessage(ok);
    } catch { parentPort.postMessage(false); }
  `, { eval: true, execArgv: [], stdout: true, stderr: true });
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void worker.terminate();
    resolve(value);
  };
  const timer = setTimeout(() => finish(false), 3000);
  worker.once('message', finish);
  worker.once('error', () => finish(false));
  worker.once('exit', () => finish(false));
});
let backend = native ? 'native' : 'unavailable';
if (!native) {
  try {
    const { stdout } = await promisify(execFile)('sqlite3', [':memory:', 'SELECT 1;'], { timeout: 2000 });
    if (stdout.trim() === '1') backend = 'cli';
  } catch { /* Report both unavailable backends without invoking a package manager. */ }
}
const message = backend === 'unavailable'
  ? 'SQLite unavailable: install sqlite3 CLI or use Node.js 22.13+ with node:sqlite enabled.'
  : `SQLite backend: ${backend === 'native' ? 'node:sqlite' : 'sqlite3 CLI'}`;
if (process.argv.includes('--json')) console.log(JSON.stringify({ backend, message }));
else (backend === 'unavailable' ? console.error : console.log)(message);
process.exitCode = backend === 'unavailable' ? 1 : 0;
