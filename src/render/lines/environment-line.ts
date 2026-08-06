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
  const critical: string[] = [];
  const details: string[] = [];

  // Runtime turn_context state takes precedence over static config.
  const sandbox = data.session?.sandboxMode ?? data.config.sandbox_mode;
  const approvalPolicy =
    data.session?.approvalPolicy ?? data.config.approval_policy;
  const fullAccess = sandbox === 'danger-full-access';
  if (fullAccess) {
    critical.push(theme.error('[FULL ACCESS]'));
  }

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
  if (!fullAccess || approvalDisplay !== 'full access') {
    critical.push(colors.dim('Approval: ') + theme.value(approvalDisplay));
  }

  if (sandbox && !fullAccess) {
    const sandboxDisplay =
      sandbox === 'workspace-write'
        ? theme.warning('workspace-write')
        : theme.info(sanitizeTerminalText(sandbox));
    critical.push(colors.dim('Sandbox: ') + sandboxDisplay);
  }

  // The default state carries no signal; it stays visible but recedes.
  const fastDisplay = getFastModeDisplay(data.config, {
    serviceTier: data.session?.serviceTier,
  });
  critical.push(
    fastDisplay === 'Fast: off'
      ? colors.dim(fastDisplay)
      : theme.value(fastDisplay)
  );

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
  const selected = [...critical];
  for (const detail of details) {
    const candidate = [...selected, detail].join(separator);
    if (
      !Number.isFinite(width) ||
      visualLength(candidate) <= width
    ) {
      selected.push(detail);
    }
  }

  return truncateAnsi(selected.join(separator), width);
}
