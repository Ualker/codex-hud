import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'render'
);
const renderModule = path.join(distDir, 'index.js');
const colorsModule = path.join(distDir, 'colors.js');

/**
 * The renderer emits escape sequences and spaces, so the captured frame needs a
 * delimiter that cannot occur inside it. NUL is written explicitly rather than
 * as a literal, which would be invisible in the source.
 */
const MARKER = String.fromCharCode(0);

/**
 * The renderer reads its environment once at module load and writes escape
 * sequences to stdout, so each case needs a fresh process with a captured pipe.
 */
function renderInChild(body, env = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const render = await import(${JSON.stringify(renderModule)});
       const { stripAnsi } = await import(${JSON.stringify(colorsModule)});
       ${body}`,
    ],
    {
      env: { ...process.env, COLUMNS: '146', LINES: '7', ...env },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// ---- a render failure has to look like one --------------------------------
// The pane used to keep the last good frame when a render threw, and with
// CODEX_HUD_LOG_FILE unset the failure reached neither screen nor disk. A
// frozen HUD is indistinguishable from an idle session.
{
  const raw = renderInChild(
    `render.renderFallbackFrame('TypeError: bad thing');
     process.stdout.write(String.fromCharCode(0) + 'done');`
  );
  const frame = raw.slice(0, raw.indexOf(MARKER));
  const text = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

  assert.match(text, /HUD display error/, 'the pane says the display broke');
  assert.match(text, /retrying/, 'and that it is still trying');
  assert.match(
    text,
    /TypeError: bad thing/,
    'and carries enough of the cause to act on'
  );
  assert.equal(
    frame.split('\n').length,
    7,
    'the whole pane is repainted, so no stale rows survive underneath'
  );
  assert.ok(
    frame.includes('\x1b[2K'),
    'each row is cleared rather than overwritten in place'
  );
}

{
  // The fallback is the last line of defense; it must not throw even when the
  // terminal reports nonsense.
  const out = renderInChild(
    `render.renderFallbackFrame('x');
     process.stdout.write(String.fromCharCode(0) + 'ok');`,
    { COLUMNS: '0', LINES: '0' }
  );
  assert.ok(out.endsWith('ok'), 'a zero-sized terminal is survivable');
}

{
  // A very long cause is clipped to the pane instead of wrapping into rows
  // that the next frame would not clear.
  const raw = renderInChild(
    `render.renderFallbackFrame('E'.repeat(400));
     process.stdout.write(String.fromCharCode(0) + 'ok');`
  );
  const frame = raw.slice(0, raw.indexOf(MARKER));
  for (const line of frame.split('\n')) {
    const visible = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.ok(
      visible.length <= 146,
      `no row exceeds the pane width (${visible.length})`
    );
  }
}

// ---- the hint teaches the binding this session actually has ---------------
const hintBody = `
  const data = {
    config: { model: 'gpt-5.6-sol' },
    git: { isGitRepo: false },
    project: {
      cwd: '/tmp/x', projectName: 'x', agentsMdCount: 0, rulesCount: 0,
      mcpCount: 0, configsCount: 0, extensionsCount: 0, skillsCount: 0,
      otherAgentSkillsCount: 0, hooksCount: 0, globalConfigActive: false,
    },
    sessionStart: new Date(),
    collectorHealth: {},
    displayMode: 'single',
  };
  render.renderToStdout(data);
  process.stdout.write(String.fromCharCode(0) + 'done');
`;

{
  const raw = renderInChild(hintBody);
  const text = raw.slice(0, raw.indexOf(MARKER)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(
    text,
    /\[view\]/,
    'without a global binding the hint teaches the click'
  );
  assert.match(text, /wheel: details/, 'and the wheel');
}

{
  // The wrapper installs Prefix+H only when asked, because tmux key tables are
  // server-wide. When it has, the hint must stop teaching the clunkier path.
  const raw = renderInChild(hintBody, { CODEX_HUD_TOGGLE_KEY: 'Prefix+H' });
  const text = raw.slice(0, raw.indexOf(MARKER)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(text, /Prefix\+H view/, 'the working key is the one advertised');
  assert.equal(
    /Ctrl\+T/.test(text),
    false,
    'and the focus-first key path is no longer the headline'
  );
  assert.match(text, /wheel: details/, 'the wheel still cycles details');
}

// A busy overview has room for the button but not the full hint. Its exact
// screen cells are clickable; text, a different row and stale frames are not.
{
  const body = `
    let painted = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { painted += chunk; return true; };
    render.renderToStdout({ config: {}, git: { isGitRepo: false }, project: { cwd: '/x', projectName: 'x' },
      displayMode: 'overview', overview: { updatedAt: new Date(), sessions: [
        { id: 'session-1', projectName: 'long-project', title: 'Review layout and controls',
          model: 'gpt-6-astra', turnActivity: { phase: 'awaiting-approval' }, contextUsage: { percent: 55 },
          tmuxSession: 'codex-hud-demo-20260909000000-12345', lastActivityAt: new Date() }
      ] } });
    process.stdout.write = originalWrite;
    const row = painted.replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '').split('\\n')[0];
    const start = row.indexOf('[view]') + 1;
    if (start < 1 || !render.isViewToggleClick(start, 1) || !render.isViewToggleClick(start + 5, 1)
      || render.isViewToggleClick(start - 1, 1) || render.isViewToggleClick(start, 2)) process.exit(2);
    render.invalidateRenderedFrame();
    if (render.isViewToggleClick(start, 1)) process.exit(3);
  `;
  renderInChild(body);
}
console.log('test-render-failure-and-hint: PASS');
