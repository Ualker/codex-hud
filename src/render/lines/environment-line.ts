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

  // Runtime turn_context state takes precedence over static config. A bounded
  // history with no recovered runtime value is unknown: falling back to the
  // current config can make an older full-access session look sandboxed.
  const partialRuntime = data.partialHistory === true;
  const runtimeSandbox = data.session?.sandboxMode;
  const runtimeApprovalPolicy = data.session?.approvalPolicy;
  const sandbox =
    runtimeSandbox ?? (partialRuntime ? undefined : data.config.sandbox_mode);
  const approvalPolicy =
    runtimeApprovalPolicy ??
    (partialRuntime ? undefined : data.config.approval_policy);
  const fullAccess = sandbox === 'danger-full-access';
  const badgePart = fullAccess ? theme.error('[FULL ACCESS]') : null;

  // Approval and sandbox are security state, so they must survive before
  // inventory counts on narrow panes. The badge already states the whole
  // permission mode, though: repeating it as "Approval: full access |
  // Sandbox: off" was three spellings of one fact, so cells whose value the
  // badge implies are dropped and only a diverging approval policy remains
  // visible.
  const approvalUncertain =
    partialRuntime &&
    (runtimeApprovalPolicy === undefined ||
      (runtimeApprovalPolicy === 'never' && runtimeSandbox === undefined));
  const approvalDisplay = approvalUncertain
    ? '?'
    : getApprovalPolicyDisplay(data.config, {
        approvalPolicy,
        sandboxMode: sandbox,
      });
  const approvalPart =
    !fullAccess || approvalDisplay !== 'full access'
      ? colors.dim('Approval: ') + theme.value(approvalDisplay)
      : null;

  const sandboxPart = !fullAccess && (sandbox || partialRuntime)
    ? colors.dim('Sandbox: ') +
      (sandbox === undefined
        ? colors.dim('?')
        : sandbox === 'workspace-write'
          ? theme.warning('workspace-write')
          : theme.info(sanitizeTerminalText(sandbox)))
    : null;

  // The default state carries no signal; it stays visible but recedes, and it
  // is the first critical cell to go when the row cannot fit them all.
  const runtimeServiceTier = data.session?.serviceTier;
  const fastUnknown = partialRuntime && runtimeServiceTier === undefined;
  const fastDisplay = fastUnknown
    ? 'Fast: ?'
    : getFastModeDisplay(data.config, {
        serviceTier: runtimeServiceTier,
      });
  const fastPart = fastUnknown || fastDisplay === 'Fast: off'
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

  // One priority order, most to least worth the space, and the row is the
  // longest prefix of it that fits.
  //
  // The critical cells were once exempt from the width check and hard
  // truncated instead, so a 40-column pane spent a whole row on
  // "Approval: ask for approval | Sandbox: w…" — a half-spelled security
  // state, which is worse than a shorter true one. Shedding whole cells fixed
  // that, but as two separate ladders — critical tiers, then a greedy pack of
  // the details — the set of visible cells was not monotone in width: at 56
  // columns the row carried MCP and Hooks, at 64 Hooks vanished in favour of
  // the longer skills cell, and at 76 it came back; widening from 52 to 53
  // brought "Fast: off" back and pushed the MCP count out. Dragging the pane
  // wider is not supposed to remove information. A single prefix also keeps
  // the order honest: a shorter low-priority cell can no longer take the slot
  // of one that outranks it just by being shorter.
  const ordered = [
    badgePart,
    approvalPart,
    sandboxPart,
    fastPart,
    ...details,
  ].filter((part): part is string => Boolean(part));

  const selected: string[] = [];
  for (const part of ordered) {
    const candidate = [...selected, part];
    if (!fits(candidate)) {
      break;
    }
    selected.push(part);
  }
  // Not even the shortest true statement fits: give the row back so the layout
  // can spend it on something that does.
  if (selected.length === 0) {
    return null;
  }

  return truncateAnsi(selected.join(separator), width);
}
