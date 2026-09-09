// Render deterministic README previews from the actual terminal renderer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.NO_COLOR;
process.env.TERM = 'xterm-256color';
process.env.CODEX_HUD_TOOL_DETAILS = 'targets';
process.env.CODEX_HUD_TOGGLE_KEY = 'Prefix+H';
const now = Date.parse('2026-09-09T09:00:00Z');
Date.now = () => now;
const { renderToStdout, invalidateRenderedFrame } = await import('../dist/render/index.js');
const { visualLength } = await import('../dist/render/colors.js');
const ago = (seconds) => new Date(now - seconds * 1000);
const calls = ['npm test', 'rg compact src', 'git diff'].map((target, i) => ({
  id: `tool-${i}`, name: 'exec_command', target, status: 'running', timestamp: ago(12 - i),
}));
const data = {
  config: { model: 'gpt-6-astra', sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  git: { isGitRepo: true, branch: 'main', isDirty: true, modified: 3, added: 1, deleted: 0, untracked: 0, ahead: 0, behind: 0 },
  project: { cwd: '/work/codex-hud', projectName: 'codex-hud', mcpCount: 6, skillsCount: 17, hooksCount: 2 },
  session: { id: 'session-demo-001', model: 'gpt-6-astra', reasoningEffort: 'max', startTime: ago(3600), title: 'Fix compact visibility and session controls', cwd: '/work/codex-hud', cliVersion: '0.153.4' },
  tokenUsage: { last_token_usage: { total_tokens: 71_093 }, total_token_usage: { total_tokens: 325_845 } },
  contextUsage: { used: 71_093, total: 258400, percent: 28, compactCount: 3 },
  rateLimits: { primary: { used_percent: 35, window_minutes: 300, resets_at: now / 1000 + 3600 } },
  turnActivity: { phase: 'running-tool', since: ago(42), lastActivityAt: ago(1) },
  toolActivity: { recentCalls: calls, runningCalls: calls, totalCalls: 28, callsByType: {}, lastUpdateTime: ago(1) },
  planProgress: { totalSteps: 7, completedSteps: 4, steps: [{ step: 'Verify layout and control regressions', status: 'in_progress' }] },
};
const sessions = ['Review compact layout', 'Check async collectors', 'Release checklist'].map((title, i) => ({
  id: `session-demo-00${i + 1}`, projectName: 'codex-hud', title,
  model: 'gpt-6-astra', tmuxSession: `codex-hud-demo-20260909${100000 + i * 1000}-${11223 + i}`,
  turnActivity: { phase: ['running-tool', 'awaiting-approval', 'idle'][i] },
  contextUsage: { used: 1, total: 2, percent: [28, 65, 12][i] }, lastActivityAt: ago([1, 45, 600][i]),
}));
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palette = { 30: '#161b22', 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 34: '#79c0ff', 35: '#d2a8ff', 36: '#56d4dd', 37: '#c9d1d9', 90: '#8b949e', 91: '#ffa198', 92: '#aff5b4', 93: '#f8e3a1', 94: '#a5d6ff', 95: '#e2c5ff', 96: '#a5f3fc', 97: '#f0f6fc' };
function preview(name, title, value, columns = 140) {
  process.stdout.columns = columns;
  process.stdout.rows = 6;
  let raw = '';
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { raw += chunk; return true; };
  try {
    invalidateRenderedFrame();
    renderToStdout(value);
  } finally { process.stdout.write = write; }
  raw = raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, ''); // terminal hyperlinks
  raw = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith('m') ? sequence : '');
  const cell = 8.4;
  const width = columns * cell + 40;
  const height = 226;
  let body = '';
  for (const [row, line] of raw.split('\n').entries()) {
    let x = 20, color = '#c9d1d9', opacity = 1;
    for (const segment of line.split(/(\x1b\[[\d;]*m)/)) {
      if (segment.startsWith('\x1b[')) {
        for (const code of segment.slice(2, -1).split(';').map(Number)) {
          if (code === 0) { color = '#c9d1d9'; opacity = 1; }
          else if (code === 2) opacity = 0.64;
          else if (palette[code]) color = palette[code];
        }
      } else if (segment) {
        const length = visualLength(segment) * cell;
        body += `<text x="${x}" y="${78 + row * 23}" fill="${color}" opacity="${opacity}" textLength="${length}" lengthAdjust="spacingAndGlyphs">${escape(segment)}</text>`;
        x += length;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}"><rect width="${width}" height="${height}" rx="12" fill="#0d1117"/><path d="M0 48H${width}" stroke="#30363d"/><circle cx="22" cy="24" r="5" fill="#ff5f57"/><circle cx="40" cy="24" r="5" fill="#febc2e"/><circle cx="58" cy="24" r="5" fill="#28c840"/><text x="80" y="29" fill="#8b949e" font-family="monospace" font-size="12">${escape(title)}</text><g font-family="Menlo,DejaVu Sans Mono,monospace" font-size="14" xml:space="preserve">${body}</g></svg>\n`;
  const output = fileURLToPath(new URL(`../doc/fig/${name}.svg`, import.meta.url));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, svg);
  console.log(output);
}
preview('single', 'Codex HUD / single session / rendered fixture', data);
preview('overview', 'Codex HUD / overview / rendered fixture', { ...data, displayMode: 'overview', overviewSelfSessionId: sessions[0].id, overview: { sessions, updatedAt: ago(0) } });
