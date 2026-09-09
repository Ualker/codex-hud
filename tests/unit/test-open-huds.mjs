import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'collectors',
  'open-huds.js'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-open-huds-'));

/**
 * Run the collector with a stub `tmux` first on PATH, so the test exercises
 * the parsing and failure handling rather than a live tmux server.
 */
function withStubTmux(script, body) {
  const binDir = fs.mkdtempSync(path.join(tempRoot, 'bin-'));
  const stub = path.join(binDir, 'tmux');
  fs.writeFileSync(stub, `#!/bin/sh\n${script}\n`, 'utf8');
  fs.chmodSync(stub, 0o755);

  const result = spawnSync(process.execPath, ['-e', body], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A stub that emits the given lines verbatim. */
function emitStub(lines) {
  const file = path.join(fs.mkdtempSync(path.join(tempRoot, 'out-')), 'stdout');
  const rows = lines.map((line) => {
    if (line.includes(' ')) return line;
    let name = 'codex-hud-invalid';
    try { name = JSON.parse(Buffer.from(line, 'base64').toString()).tmuxSession ?? name; } catch {}
    return `${name} %2 0 %2 ${line}`;
  });
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8');
  return `cat ${file}`;
}

const encode = (payload) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

const listBody = `
  const { listOpenHudBindings } = await import(${JSON.stringify(modulePath)});
  process.stdout.write(JSON.stringify(await listOpenHudBindings()));
`;

try {
  {
    // A HUD bound before its first turn has no rollout path. That is exactly
    // the case no file-timestamp scan can represent, so it must survive.
    const parsed = JSON.parse(
      withStubTmux(
        emitStub([
          encode({
            tmuxSession: 'codex-hud-a',
            sessionId: 'session-a',
            rolloutPath: '/tmp/a.jsonl',
            cwd: '/work/a',
            approvalNeeded: true,
          }),
          encode({
            tmuxSession: 'codex-hud-b',
            sessionId: 'session-b',
            cwd: '/work/b',
          }),
          encode({
            tmuxSession: 'codex-hud-c',
            sessionId: 'session-c',
            cwd: '/work/c',
            likelyInterrupted: true,
            codexExited: true,
          }),
          encode({
            tmuxSession: 'codex-hud-d',
            sessionId: 'session-d',
            rolloutPath: '/tmp/d.jsonl',
            cwd: '/work/d',
            freshPrompt: true,
          }),
          '', // a tmux session with no HUD
        ]),
        listBody
      )
    );

    assert.equal(parsed.length, 4, 'sessions with no HUD binding are skipped');
    assert.deepEqual(parsed[0], {
      tmuxSession: 'codex-hud-a',
      sessionId: 'session-a',
      rolloutPath: '/tmp/a.jsonl',
      cwd: '/work/a',
      approvalNeeded: true,
    });
    assert.deepEqual(
      parsed[1],
      { tmuxSession: 'codex-hud-b', sessionId: 'session-b', cwd: '/work/b' },
      'a bound session with no rollout keeps its identity'
    );
    assert.deepEqual(
      parsed[2],
      {
        tmuxSession: 'codex-hud-c',
        sessionId: 'session-c',
        cwd: '/work/c',
        likelyInterrupted: true,
        codexExited: true,
      },
      'confirmed pane findings travel with the binding'
    );
    assert.deepEqual(
      parsed[3],
      {
        tmuxSession: 'codex-hud-d',
        sessionId: 'session-d',
        rolloutPath: '/tmp/d.jsonl',
        cwd: '/work/d',
        freshPrompt: true,
      },
      'a confirmed fresh prompt travels with the binding'
    );
  }

  {
    // Two panes can bind the same Codex session; the dashboard lists it once.
    const parsed = JSON.parse(
      withStubTmux(
        emitStub([
          encode({ tmuxSession: 'codex-hud-a', sessionId: 'shared' }),
          encode({ tmuxSession: 'codex-hud-b', sessionId: 'shared' }),
        ]),
        listBody
      )
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].tmuxSession, 'codex-hud-a', 'the first pane wins');
  }

  {
    // Garbage from a different build or a hand-edited option is skipped, not
    // fatal, and never blocks the valid rows around it.
    const parsed = JSON.parse(
      withStubTmux(
        emitStub([
          'not-base64!!',
          Buffer.from('{"incomplete":', 'utf8').toString('base64'),
          encode({ tmuxSession: 'codex-hud-a', sessionId: '' }),
          encode({ tmuxSession: 'codex-hud-b', sessionId: 'session-b' }),
        ]),
        listBody
      )
    );
    assert.deepEqual(parsed, [
      { tmuxSession: 'codex-hud-b', sessionId: 'session-b' },
    ]);
  }

  {
    // No tmux server, or a tmux too old for this format, is "no data" — the
    // overview falls back to the rollout scan instead of failing.
    assert.deepEqual(JSON.parse(withStubTmux('exit 1', listBody)), []);
  }

  {
    const payload = encode({ tmuxSession: 'codex-hud-a', sessionId: 'a' });
    const rows = [
      `codex-hud-a %1 0 %2 ${payload}`, // main pane, missing HUD
      `codex-hud-a %2 1 %2 ${payload}`, // dead HUD retained by tmux
      `codex-hud-other %2 0 %2 ${payload}`, // stale/copy from another session
    ];
    assert.deepEqual(JSON.parse(withStubTmux(emitStub(rows), listBody)), []);
    const strictBody = `
      const { listOpenHudBindings } = await import(${JSON.stringify(modulePath)});
      try { await listOpenHudBindings({ strict: true }); process.exit(2); }
      catch { process.stdout.write('unavailable'); }
    `;
    assert.equal(withStubTmux('exit 1', strictBody), 'unavailable');
  }

  {
    // A slow tmux must still be waited for. Measured on a loaded machine, a
    // bare /bin/sh spawn here takes 0.7-2.1s, and the original two-second
    // budget expired on 10 of 25 consecutive calls — silently dropping every
    // open HUD from the overview and leaving the mtime scan, the very source
    // this collector exists to replace, as the only answer. Nothing waits on
    // this call, so a late result costs nothing.
    const slow = emitStub([
      encode({ tmuxSession: 'codex-hud-slow', sessionId: 'session-slow' }),
    ]);
    const parsed = JSON.parse(
      withStubTmux(`sleep 3\n${slow}`, listBody)
    );
    assert.deepEqual(
      parsed,
      [{ tmuxSession: 'codex-hud-slow', sessionId: 'session-slow' }],
      'a three-second tmux still reports its bindings'
    );
  }

  {
    // Publishing without a tmux session name must not spawn anything.
    const publishBody = `
      const { publishHudBinding } = await import(${JSON.stringify(modulePath)});
      await publishHudBinding(undefined, 'session-a', '/tmp/a.jsonl', '/work/a');
      process.stdout.write('ok');
    `;
    assert.equal(
      withStubTmux('echo "stub must not run" >&2; exit 3', publishBody),
      'ok'
    );
  }

  {
    // A binding change lands as one option write, and an unbind clears the
    // whole advertisement rather than leaving half of it behind.
    const log = path.join(tempRoot, 'publish.log');
    const publishBody = `
      const { publishHudBinding } = await import(${JSON.stringify(modulePath)});
      await publishHudBinding('codex-hud-a', 'session-a', '/tmp/a.jsonl', '/work/a', true, true, true, true);
      await publishHudBinding('codex-hud-a', null, null, '/work/a');
      process.stdout.write('ok');
    `;
    withStubTmux(`printf '%s\\n' "$*" >> ${log}`, publishBody);

    const lines = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.trim());
    assert.equal(lines.length, 2, 'one option write per binding change');

    const encoded = lines[0].slice(lines[0].lastIndexOf(' ') + 1);
    const published = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.ok(Number.isInteger(published.ownerPid) && published.ownerPid > 0);
    delete published.ownerPid;
    assert.deepEqual(
      published,
      {
        tmuxSession: 'codex-hud-a',
        sessionId: 'session-a',
        rolloutPath: '/tmp/a.jsonl',
        cwd: '/work/a',
        approvalNeeded: true,
        likelyInterrupted: true,
        codexExited: true,
        freshPrompt: true,
      },
      'every field travels together in one write'
    );
    assert.ok(
      lines[1].startsWith('if-shell -F') && lines[1].includes(encoded) && lines[1].includes("@codex_hud_bound ''"),
      'an unbind clears the whole advertisement'
    );
  }

  {
    // The payload must survive tmux verbatim. tmux escapes non-printable
    // bytes as it stores an option value — a \\x1f-joined value came back as
    // the four literal characters \\, 0, 3, 7 — so the encoding may only use
    // characters tmux passes through.
    const publishBody = `
      const { publishHudBinding } = await import(${JSON.stringify(modulePath)});
      await publishHudBinding('codex-hud-a', 'session-a', '/tmp/a.jsonl', '/work/a');
      process.stdout.write('ok');
    `;
    const log = path.join(tempRoot, 'charset.log');
    withStubTmux(`printf '%s\\n' "$*" >> ${log}`, publishBody);

    const written = fs.readFileSync(log, 'utf8').trim();
    const encoded = written.slice(written.lastIndexOf(' ') + 1);
    assert.match(
      encoded,
      /^[A-Za-z0-9+/]+={0,2}$/,
      'the published value stays inside an alphabet tmux stores verbatim'
    );
  }

  console.log('test-open-huds: PASS');
} finally {
  const resolvedRoot = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedRoot), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith('codex-hud-open-huds-'));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
