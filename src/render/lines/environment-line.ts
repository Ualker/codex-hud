/**
 * Environment Line Renderer
 * Renders Codex-specific module status:
 * Format: 2 configs | 3 extensions | N skills | M hooks | Approval: policy | Fast: on
 */

import type { HudData } from '../../types.js';
import {
  theme,
  colors,
  icons,
  sanitizeTerminalText,
  truncateAnsi,
  visualLength,
} from '../colors.js';
import {
  getApprovalPolicyDisplay,
  getFastModeDisplay,
  getMcpServerCount,
} from '../../collectors/codex-config.js';

/**
 * Render the environment line
 * Format: 2 configs | 3 extensions | N skills | M hooks | Approval: policy | Fast: on
 */
export function renderEnvironmentLine(
  data: HudData,
  width: number = Number.POSITIVE_INFINITY
): string | null {
  const details: string[] = [];

  // Runtime turn_context state takes precedence over static config.
  const sandbox = data.session?.sandboxMode ?? data.config.sandbox_mode;
  const approvalPolicy =
    data.session?.approvalPolicy ?? data.config.approval_policy;
  const fullAccess = sandbox === 'danger-full-access';
  const badgePart = fullAccess ? theme.error('[FULL ACCESS]') : null;

  // Approval and sandbox are security state, so they must survive before
  // inventory counts on narrow panes. The badge already states the whole
  // permission mode, though: repeating it as "Approval: full access |
  // Sandbox: off" was three spellings of one fact, so cells whose value the
  // badge implies are dropped and only a diverging approval policy remains
  // visible.
  const approvalDisplay = getApprovalPolicyDisplay(data.config, {
    approvalPolicy,
    sandboxMode: sandbox,
  });
  const approvalPart =
    !fullAccess || approvalDisplay !== 'full access'
      ? colors.dim('Approval: ') + theme.value(approvalDisplay)
      : null;

  const sandboxPart =
    sandbox && !fullAccess
      ? colors.dim('Sandbox: ') +
        (sandbox === 'workspace-write'
          ? theme.warning('workspace-write')
          : theme.info(sanitizeTerminalText(sandbox)))
      : null;

  // The default state carries no signal; it stays visible but recedes, and it
  // is the first critical cell to go when the row cannot fit them all.
  const fastDisplay = getFastModeDisplay(data.config, {
    serviceTier: data.session?.serviceTier,
  });
  const fastPart =
    fastDisplay === 'Fast: off'
      ? colors.dim(fastDisplay)
      : theme.value(fastDisplay);

  const mcpCount =
    data.project.mcpCount || getMcpServerCount(data.config);
  if (mcpCount > 0) {
    details.push(
      colors.dim('MCP configured: ') + theme.info(`${mcpCount}`)
    );
  }
  if (data.project.skillsCount > 0) {
    details.push(
      colors.dim('Codex skills: ') +
        theme.info(`${data.project.skillsCount}`)
    );
  }
  if (
    process.env.CODEX_HUD_SHOW_OTHER_AGENT_SKILLS === '1' &&
    (data.project.otherAgentSkillsCount ?? 0) > 0
  ) {
    details.push(
      colors.dim('Other-agent skills: ') +
        theme.info(`${data.project.otherAgentSkillsCount}`)
    );
  }
  if (data.project.hooksCount > 0) {
    details.push(
      colors.dim('Hooks: ') + theme.info(`${data.project.hooksCount}`)
    );
  }
  if (data.project.agentsMdCount > 0) {
    details.push(
      colors.dim('AGENTS.md: ') +
        theme.success(`${data.project.agentsMdCount}`)
    );
  }

  const configSources =
    (data.project.globalConfigActive ? 1 : 0) +
    data.project.configsCount;
  if (configSources > 0) {
    const sourceLabel = [
      data.project.globalConfigActive ? 'global' : '',
      data.project.configsCount > 0
        ? `${data.project.configsCount} project`
        : '',
    ].filter(Boolean).join('+');
    details.push(colors.dim(`Config: ${sourceLabel}`));
  }
  if (data.project.rulesCount > 0) {
    details.push(
      colors.dim('Rules: ') + theme.info(`${data.project.rulesCount}`)
    );
  }

  const separator = ` ${colors.dim(icons.pipe)} `;
  const fits = (parts: string[]): boolean =>
    !Number.isFinite(width) || visualLength(parts.join(separator)) <= width;

  // The critical cells used to be exempt from the width check and were hard
  // truncated instead, so a 40-column pane spent a whole row on
  // "Approval: ask for approval | Sandbox: w…" — a half-spelled security state,
  // which is worse than a shorter true one. Shed whole cells instead, cheapest
  // first: the fast-mode default carries no signal, and the sandbox value is
  // the one the [FULL ACCESS] badge already implies when it is present.
  const tiers: (string | null)[][] = [
    [badgePart, approvalPart, sandboxPart, fastPart],
    [badgePart, approvalPart, sandboxPart],
    [badgePart, approvalPart],
    [badgePart],
  ];
  let selected: string[] | null = null;
  for (const tier of tiers) {
    const parts = tier.filter((part): part is string => Boolean(part));
    if (parts.length === 0) {
      continue;
    }
    if (fits(parts)) {
      selected = parts;
      break;
    }
  }
  if (!selected) {
    return null;
  }

  for (const detail of details) {
    const candidate = [...selected, detail];
    if (fits(candidate)) {
      selected.push(detail);
    }
  }

  return truncateAnsi(selected.join(separator), width);
}
