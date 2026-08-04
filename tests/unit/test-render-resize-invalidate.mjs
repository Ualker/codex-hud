import assert from 'node:assert/strict';
import {
  renderToStdout,
  invalidateRenderedFrame,
} from '../../dist/render/index.js';

const originalWrite = process.stdout.write.bind(process.stdout);
const originalColumns = process.env.COLUMNS;
const originalLines = process.env.LINES;
const originalClear = process.env.CODEX_HUD_CLEAR_SCROLLBACK;

const writes = [];
process.stdout.write = (chunk, encoding, callback) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  writes.push(text);

  if (typeof encoding === 'function') {
    encoding();
  } else if (typeof callback === 'function') {
    callback();
  }
  return true;
};

process.env.COLUMNS = '80';
process.env.LINES = '5';
process.env.CODEX_HUD_CLEAR_SCROLLBACK = '1';

const data = {
  config: {
    model: 'gpt-5.2-codex',
    model_provider: 'openai',
  },
  git: {
    branch: null,
    isDirty: false,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
  },
  project: {
    cwd: '/tmp/codex-hud',
    projectName: 'resize-project',
    agentsMdCount: 0,
    hasCodexDir: false,
    instructionsMdCount: 0,
    rulesCount: 0,
    mcpCount: 0,
    configsCount: 0,
    extensionsCount: 0,
    workMode: 'development',
  },
  sessionStart: new Date('2026-02-09T00:00:00Z'),
  displayMode: 'single',
};

let firstRenderWrites;
let dedupedWrites;
let invalidatedWrites;

try {
  renderToStdout(data);
  firstRenderWrites = writes.length;

  renderToStdout(data);
  dedupedWrites = writes.length;

  invalidateRenderedFrame();
  renderToStdout(data);
  invalidatedWrites = writes.length;
} finally {
  process.stdout.write = originalWrite;
  if (originalColumns === undefined) {
    delete process.env.COLUMNS;
  } else {
    process.env.COLUMNS = originalColumns;
  }
  if (originalLines === undefined) {
    delete process.env.LINES;
  } else {
    process.env.LINES = originalLines;
  }
  if (originalClear === undefined) {
    delete process.env.CODEX_HUD_CLEAR_SCROLLBACK;
  } else {
    process.env.CODEX_HUD_CLEAR_SCROLLBACK = originalClear;
  }
}

assert.ok(firstRenderWrites > 0, 'first render must write to stdout');
assert.equal(
  dedupedWrites,
  firstRenderWrites,
  'an identical frame must not be rewritten'
);
assert.ok(
  invalidatedWrites > dedupedWrites,
  'an invalidated frame must be repainted even when the data is unchanged'
);

const output = writes.join('');
const clearScrollbackCount = (output.match(/\x1b\[3J/g) || []).length;
const clearScreenCount = (output.match(/\x1b\[2J/g) || []).length;

assert.equal(
  clearScrollbackCount,
  1,
  'CLEAR_SCROLLBACK must stay first-render-only across invalidations'
);
assert.equal(
  clearScreenCount,
  2,
  'invalidation must repeat the full-screen clear to drop resize artifacts'
);

console.log('test-render-resize-invalidate: PASS');
