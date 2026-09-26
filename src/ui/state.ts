import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionOverviewItem, HudDisplayMode } from '../types.js';
import { sanitizeTerminalText } from '../render/colors.js';
const exec = promisify(execFile);
export type OverviewFilter = 'all' | 'attention';
export interface UiPreferences {
  mode: HudDisplayMode;
  details: 'compact' | 'full';
  tools: 'targets' | 'full' | 'off';
  layout: 'standard' | 'coexist';
  label: string;
  filter: OverviewFilter;
}
const option = '@codex_hud_ui';
const keys = { mode: 'CODEX_HUD_MODE', details: 'CODEX_HUD_DETAILS', tools: 'CODEX_HUD_TOOL_DETAILS', layout: 'CODEX_HUD_LAYOUT', label: 'CODEX_HUD_LABEL' } as const;
const choices = { mode: ['single', 'overview'], details: ['compact', 'full'], tools: ['targets', 'full', 'off'], layout: ['standard', 'coexist'], filter: ['all', 'attention'] } as const;
export function normalizePreferences(raw: unknown): UiPreferences {
  const defaults: UiPreferences = { mode: 'single', details: 'compact', tools: 'targets', layout: 'standard', label: '', filter: 'all' };
  if (!raw || typeof raw !== 'object')
    return defaults;
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if ((choices[key] as readonly unknown[]).includes(values[key]))
      Object.assign(defaults, { [key]: values[key] });
  }
  if (typeof values.label === 'string')
    defaults.label = sanitizeTerminalText(values.label).replace(/\s+/g, ' ').trim().slice(0, 80);
  return defaults;
}
function seeds(): Record<string, string | undefined> { return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, process.env[v]])); }
export async function loadPreferences(session?: string): Promise<UiPreferences> {
  const env = seeds();
  let saved: {
    preferences?: unknown;
    seeds?: Record<string, string>;
  } = {};
  if (session) {
    try {
      const { stdout } = await exec('tmux', ['show-option', '-qv', '-t', session, option], { timeout: 1500, maxBuffer: 16384 });
      saved = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
    }
    catch { /* Missing or older preference data uses environment defaults. */ }
  }
  const values = { ...normalizePreferences(saved?.preferences) };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (!saved?.seeds || saved.seeds[key] !== value))
      Object.assign(values, { [key]: value });
  }
  return normalizePreferences(values);
}
const savedValues = new Map<string, string>();
let saves: Promise<unknown> = Promise.resolve();
export function savePreferences(session: string | undefined, preferences: UiPreferences): Promise<void> {
  if (!session)
    return Promise.resolve();
  const value = Buffer.from(JSON.stringify({ version: 1, preferences, seeds: seeds() })).toString('base64');
  if (savedValues.get(session) === value)
    return Promise.resolve();
  savedValues.set(session, value);
  const next = saves.then(() => exec('tmux', ['set-option', '-q', '-t', session, option, value], { timeout: 1500, maxBuffer: 16384 }));
  saves = next.catch(() => undefined);
  return next.then(() => undefined, () => { if (savedValues.get(session) === value)
    savedValues.delete(session); });
}
export function needsAttention(row: SessionOverviewItem): boolean {
  return row.unavailable === true || ['awaiting-approval', 'failed', 'interrupted', 'aborted'].includes(row.turnActivity?.phase ?? '');
}
export function filteredSessions(rows: SessionOverviewItem[], filter: OverviewFilter): SessionOverviewItem[] {
  return filter === 'attention' ? rows.filter(needsAttention) : rows;
}
export function moveSelection(rows: SessionOverviewItem[], selected: string | undefined, delta: number): string | undefined {
  if (!rows.length)
    return undefined;
  const index = rows.findIndex(r => r.id === selected);
  return rows[(Math.max(0, index) + delta + rows.length) % rows.length]?.id;
}
/** Validate the advertised binding again at activation time; never jump on a stale row. */
export async function focusSession(tmuxSession: string | undefined, expectedSessionId?: string): Promise<boolean> {
  if (!tmuxSession)
    return false;
  try {
    const { stdout } = await exec('tmux', ['show-option', '-qv', '-t', tmuxSession, '@codex_hud_main_pane'], { timeout: 1500 });
    const pane = stdout.trim();
    if (!/^%\d+$/.test(pane))
      return false;
    if (expectedSessionId) {
      const bound = await exec('tmux', ['show-option', '-qv', '-t', tmuxSession, '@codex_hud_bound'], { timeout: 1500 });
      const value = JSON.parse(Buffer.from(bound.stdout.trim(), 'base64').toString('utf8'));
      if (value.sessionId !== expectedSessionId || value.tmuxSession !== tmuxSession)
        return false;
    }
    const target = await exec('tmux', ['display-message', '-p', '-t', pane, '#{session_name}|#{pane_dead}'], { timeout: 1500 });
    if (target.stdout.trim() !== `${tmuxSession}|0`)
      return false;
    // -t accepts a pane ID and switches the client to that pane's session/window.
    await exec('tmux', ['switch-client', '-t', pane], { timeout: 1500 });
    await exec('tmux', ['select-pane', '-t', pane], { timeout: 1500 });
    return true;
  }
  catch {
    return false;
  }
}
