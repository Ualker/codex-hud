// Offline full-runtime benchmark: real collectors, watchers, git and private
// tmux; synthetic rollouts only. No Codex invocation or user tmux connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const instances = option('--instances', '1,5,20').split(',').map(Number);
const seconds = Number(option('--seconds', '12'));
const historyMiB = Number(option('--history-mib', '8'));
if (instances.some(n => !Number.isInteger(n) || n < 1 || n > 40) ||
  !Number.isFinite(seconds) || seconds < 5 || seconds > 120 ||
  !Number.isInteger(historyMiB) || historyMiB < 1 || historyMiB > 64) {
  throw new Error('instances: 1..40; seconds: 5..120; history-mib: 1..64');
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-runtime-bench-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}
const encode = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CODEX_|CMUX_|TMUX|NODE_OPTIONS|NODE_COMPILE_CACHE)/.test(key)));
const report = { fixtureVersion: 2, node: process.version, platform: `${process.platform}/${process.arch}`, seconds, historyMiB, journalMode: 'wal',
  note: 'RSS is summed per process and includes shared pages; CPU excludes subprocess CPU. Event-loop p95 is the worst per-HUD p95. Startup and continuous appends are included.', runs: [] };
try {
  for (const count of instances) {
    const run = path.join(root, String(count));
    const home = path.join(run, 'home');
    const codexHome = path.join(home, '.codex');
    const sessions = path.join(codexHome, 'sessions', ...new Date().toISOString().slice(0, 10).split('-'));
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'shell_snapshots'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="fixture-model"\n');
    const socket = path.join(run, 'tmux.sock');
    const scopedEnv = { ...env, HOME: home, CODEX_HOME: codexHome, CODEX_SESSIONS_PATH: path.join(codexHome, 'sessions'),
      XDG_STATE_HOME: path.join(run, 'state'), TERM: 'xterm-256color', NO_COLOR: '1' };
    const tmux = parameters => execFileSync('tmux', ['-S', socket, ...parameters], { env: scopedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const children = [];
    const rollouts = [];
    let writer;
    let appendBatches = 0;
    try {
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', 'exec sleep 180']);
      const serverPid = tmux(['display-message', '-p', '#{pid}']);
      const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
      const sql = (file, statement) => execFileSync('sqlite3', [path.join(codexHome, file), statement], { stdio: 'pipe' });
      // Match the journal mode observed in Codex's logs/state databases. A
      // rollback-journal fixture adds startup reader/writer contention that
      // is absent from the WAL setup being measured.
      sql('logs_1.sqlite', 'PRAGMA journal_mode=WAL; CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, process_uuid TEXT, target TEXT, feedback_log_body TEXT); CREATE INDEX idx_logs_ts ON logs(ts); CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts, ts_nanos) WHERE thread_id IS NULL;');
      sql('state_5.sqlite', 'PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, thread_source TEXT, archived INTEGER); CREATE TABLE thread_spawn_edges(child_thread_id TEXT);');
      const filler = encode('response_item', { type: 'reasoning', content: 'x'.repeat(1000) });
      const block = filler.repeat(Math.ceil(historyMiB * 1048576 / Buffer.byteLength(filler)));
      for (let i = 0; i < count; i++) {
        const cwd = path.join(run, `project-${i}`); fs.mkdirSync(cwd);
        execFileSync('git', ['init', '-q', cwd], { env: scopedEnv, stdio: 'pipe' });
        const id = `019fffff-0000-7000-8000-${String(i).padStart(12, '0')}`;
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
        const rollout = path.join(sessions, `rollout-${stamp}-${id}.jsonl`);
        fs.writeFileSync(rollout, encode('session_meta', { id, cwd, timestamp: new Date().toISOString(), source: 'cli' }) + block +
          encode('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 24000 }, model_context_window: 128000 } }));
        rollouts.push(rollout);
        const name = `codex-hud-benchmark-${i}`;
        // A harmless sleeper with Codex's argv[0] exercises the live-process
        // cache; an ordinary sleep would benchmark a permanently exited CLI.
        const main = tmux(['new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', "exec /bin/bash -c 'exec -a codex sleep 180'"]);
        const mainPid = tmux(['display-message', '-p', '-t', main, '#{pane_pid}']);
        const pane = tmux(['split-window', '-d', '-t', name, '-P', '-F', '#{pane_id}', 'exec sleep 180']);
        tmux(['set-option', '-t', name, '@codex_hud_pane', pane]);
        tmux(['set-option', '-t', name, '@codex_hud_main_pane', main]);
        sql('state_5.sqlite', `INSERT INTO threads VALUES (${sqlQuote(id)},${sqlQuote(rollout)},'cli',0);`);
        sql('logs_1.sqlite', `INSERT INTO logs(ts,ts_nanos,thread_id,process_uuid,target,feedback_log_body) VALUES (${Math.floor(Date.now() / 1000)},0,${sqlQuote(id)},'pid:${mainPid}:fixture','codex_core','fixture');`);
        // Model an in-process TUI explicitly. A managed daemon elsewhere on
        // the host must not make this synthetic sleeper look like its client.
        sql('logs_1.sqlite', `INSERT INTO logs(ts,ts_nanos,thread_id,process_uuid,target,feedback_log_body) VALUES (${Math.floor(Date.now() / 1000)},0,NULL,'pid:${mainPid}:fixture','codex_core','app_server.request{app_server.connection_id=0}: fixture');`);
        const metrics = path.join(run, `${i}.json`);
        const child = spawn(process.execPath, ['--import', path.join(repo, 'scripts/runtime-metrics.mjs'), path.join(repo, 'dist/index.js')], {
          cwd, env: { ...scopedEnv, TMUX: `${socket},${serverPid},0`,
            CODEX_HUD_CWD: cwd, CODEX_HUD_MAIN_PANE: main, CODEX_HUD_TMUX_SESSION: name, CODEX_HUD_MODE: 'overview',
            CODEX_HUD_LOG_FILE: path.join(run, `hud-${i}.log`), CODEX_HUD_ANIMATION: '0',
            HUD_BENCH_METRICS: metrics, COLUMNS: '140', LINES: '8' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = ''; let errors = '';
        child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
        children.push({ child, metrics, name, id, rollout, output: () => output, errors: () => errors });
      }
      writer = setInterval(() => {
        appendBatches++;
        for (const file of rollouts) fs.appendFileSync(file,
          encode('event_msg', { type: 'task_started', turn_id: `turn-${appendBatches}` }) +
          encode('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 24000 + appendBatches }, model_context_window: 128000 } }) +
          encode('event_msg', { type: 'task_complete', turn_id: `turn-${appendBatches}` }));
      }, 200);
      await delay(seconds * 1000);
      for (const item of children) {
        assert.equal(item.child.exitCode, null, item.errors());
        assert.match(item.output(), /project-/, 'real overview must render fixture sessions');
        const encoded = tmux(['show-option', '-qv', '-t', item.name, '@codex_hud_bound']);
        const binding = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
        const diagnostic = JSON.parse(fs.readFileSync(item.metrics, 'utf8'));
        assert.equal(binding?.sessionId, item.id,
          `each HUD must bind its own fixture, not just show scan results: ${JSON.stringify({ binding, sqlite: diagnostic.sqlite, probes: diagnostic.probes })}`);
        assert.equal(binding?.rolloutPath, item.rollout);
      }
      clearInterval(writer);
      await Promise.all(children.map(({ child }) => stopChild(child)));
      const metrics = children.map(item => JSON.parse(fs.readFileSync(item.metrics, 'utf8')));
      assert.ok(metrics.every(item => item.probes.ps?.count > 0 && item.probes.sqlite?.count > 0),
        'benchmark must exercise process binding and SQLite, not just render frames');
      assert.ok(metrics.every(item => item.sqlite.failures === 0),
        'SQL failures invalidate the benchmark; update the fixture or fix the collector');
      const sum = key => Number(metrics.reduce((total, item) => total + (item[key] ?? 0), 0).toFixed(2));
      const subprocesses = {};
      for (const item of metrics) for (const [command, n] of Object.entries(item.subprocesses)) subprocesses[command] = (subprocesses[command] ?? 0) + n;
      report.runs.push({ instances: count, appendBatches, cpuMs: sum('cpuMs'), rssSumMiB: sum('rssMiB'),
        peakRssSumMiB: sum('peakRssMiB'), stdoutWrites: sum('stdoutWrites'),
        worstEventLoopP95Ms: Math.max(...metrics.map(item => item.eventLoopP95Ms)),
        worstEventLoopMaxMs: Math.max(...metrics.map(item => item.eventLoopMaxMs)), subprocesses, metrics });
    } finally {
      clearInterval(writer);
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
      try { tmux(['kill-server']); } catch { /* Only this private socket. */ }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
