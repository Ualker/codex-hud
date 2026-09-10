/**
 * Environment Line Renderer
 * Renders Codex-specific module status:
 * Format: 2 configs | 3 extensions | N skills | M hooks | Approval: policy | Fast: on
 */

import type { HudData } from '../../types.js';
import {
  theme,
  colors,
  inlineSeparator,
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
  width: number = Number.POSITIVE_INFINITY,
  options: { compact?: boolean } = {}
): string | null {
  const details: string[] = [];

  // Runtime turn_context state takes precedence over static config. A bounded
  // history with no recovered runtime value is unknown: falling back to the
  // current config can make an older full-access session look sandboxed.
  // Unless the state scan completed cleanly — then every runtime record in
  // the file was seen, "not found" is definitive, and the config fallback is
  // the truth. Without this, "Fast: ?" stood for 21 hours on an idle session
  // whose file provably contained no thread_settings record.
  const partialRuntime =
    data.partialHistory === true && data.runtimeStateComplete !== true;
  // The pane's live launch flags are the second-best witness: they override
  // the config file, so once the session's own records exist those win, but
  // with no records at all the flags are the truth and the config is exactly
  // what they replaced. A fresh session at the prompt runs the flags too —
  // the bound records describe the previous session there.
  const cliPolicy = data.paneCliPolicy;
  const sessionSandbox = data.session?.sandboxMode;
  const sessionApprovalPolicy = data.session?.approvalPolicy;
  const runtimeSandbox =
    data.paneFreshSession === true
      ? cliPolicy?.sandboxMode ?? sessionSandbox
      : sessionSandbox ?? cliPolicy?.sandboxMode;
  const runtimeApprovalPolicy =
    data.paneFreshSession === true
      ? cliPolicy?.approvalPolicy ?? sessionApprovalPolicy
      : sessionApprovalPolicy ?? cliPolicy?.approvalPolicy;
  // A bound session with no rollout yet (0.149 defers it to the first
  // message) has no records for flags to have reached; trusting config there
  // showed `Approval: ask for approval | Sandbox: workspace-write` under a
  // live `--yolo` process. Codex's own exit reopens the config fallback —
  // and so does a captured command line walked to its end with no policy
  // flag and no profile: that argv provably overrides nothing, so a plain
  // launch no longer sits on `?` until its first message.
  const configBlind =
    partialRuntime ||
    (data.boundWithoutRollout === true &&
      data.codexExited !== true &&
      cliPolicy?.exhaustive !== true);
  const sandbox =
    runtimeSandbox ?? (configBlind ? undefined : data.config.sandbox_mode);
  const approvalPolicy =
    runtimeApprovalPolicy ??
    (configBlind ? undefined : data.config.approval_policy);
  const fullAccess = sandbox === 'danger-full-access';
  const badgePart = fullAccess ? theme.warning('[FULL ACCESS]') : null;

  // Approval and sandbox are security state, so they must survive before
  // inventory counts on narrow panes. The badge already states the whole
  // permission mode, though: repeating it as "Approval: full access |
  // Sandbox: off" was three spellings of one fact, so cells whose value the
  // badge implies are dropped and only a diverging approval policy remains
  // visible.
  const approvalUncertain =
    configBlind &&
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

  const sandboxPart = !fullAccess && (sandbox || configBlind)
    ? colors.dim('Sandbox: ') +
      (sandbox === undefined
        ? colors.dim('?')
        : sandbox === 'workspace-write'
          ? theme.value('workspace-write')
          : theme.value(sanitizeTerminalText(sandbox)))
    : null;

  // The default state carries no signal, and since 0.149 the Codex footer two
  // rows above already states `Fast off`; the cell is omitted rather than
  // dimmed. `Fast: on` and the hedged `Fast: ?` still render.
  const runtimeServiceTier = data.session?.serviceTier;
  const fastUnknown = partialRuntime && runtimeServiceTier === undefined;
  const fastDisplay = fastUnknown
    ? 'Fast: ?'
    : getFastModeDisplay(data.config, {
        serviceTier: runtimeServiceTier,
      });
  const fastPart = fastUnknown
    ? colors.dim(fastDisplay)
    : fastDisplay === 'Fast: off'
      ? null
      : theme.value(fastDisplay);

  const mcpCount =
    data.project.mcpCount || getMcpServerCount(data.config);
  if (mcpCount > 0) {
    details.push(
      colors.dim(options.compact ? 'MCP: ' : 'MCP configured: ') + theme.value(`${mcpCount}`)
    );
  }
  if (data.project.skillsCount > 0) {
    details.push(
      colors.dim(options.compact ? 'Skills: ' : 'Codex skills: ') +
        theme.value(`${data.project.skillsCount}`)
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
      colors.dim('Hooks: ') + theme.value(`${data.project.hooksCount}`)
    );
  }
  if (!options.compact && data.project.agentsMdCount > 0) {
    details.push(
      colors.dim('AGENTS.md: ') +
        theme.success(`${data.project.agentsMdCount}`)
    );
  }

  const configSources =
    (data.project.globalConfigActive ? 1 : 0) +
    data.project.configsCount;
  if (!options.compact && configSources > 0) {
    const sourceLabel = [
      data.project.globalConfigActive ? 'global' : '',
      data.project.configsCount > 0
        ? `${data.project.configsCount} project`
        : '',
    ].filter(Boolean).join('+');
    details.push(colors.dim(`Config: ${sourceLabel}`));
  }
  if (!options.compact && data.project.rulesCount > 0) {
    details.push(
      colors.dim('Rules: ') + theme.info(`${data.project.rulesCount}`)
    );
  }

  const separator = inlineSeparator();
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
    // Installed inventory is stable metadata. Keep it in full details, while
    // the everyday view states only the effective permissions and Fast mode.
    ...(options.compact ? [] : details),
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
