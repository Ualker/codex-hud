/**
 * Identity Line Renderer
 * Renders: [Model] █████░░░░░ 45%
 * Model name with context usage bar
 */

import type { HudData, ContextUsage, LayoutConfig } from '../../types.js';
import { theme, colors, remainingBar, getContextColor, icons, sanitizeTerminalText, truncate, truncateAnsi, visualLength } from '../colors.js';
import { getModelDisplayName } from '../../collectors/codex-config.js';

/**
 * Format token count for display (e.g., 12500 -> "12.5K")
 */
function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Render context breakdown (shown when usage >= 85%)
 * Format: (in: 135K, cache: 2K, ↻2)
 */
function renderContextBreakdown(context: ContextUsage): string {
  const parts: string[] = [];
  
  if (context.inputTokens > 0) {
    parts.push(`in: ${formatTokenCount(context.inputTokens)}`);
  }
  if (context.cachedTokens > 0) {
    parts.push(`cache: ${formatTokenCount(context.cachedTokens)}`);
  }
  // Show compact count if any compactions occurred
  if (context.compactCount && context.compactCount > 0) {
    parts.push(`${icons.refresh}${context.compactCount}`);
  }
  
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Render the identity line
 * Format: [Model] █████░░░░░ 45%
 */
export function renderIdentityLine(
  data: HudData,
  layout: LayoutConfig,
  options: { maxWidth?: number; showContext?: boolean; framed?: boolean } = {}
): string {
  const parts: string[] = [];

  // Model name in brackets. "default" is a true statement only once the config
  // has been read and found to set no model; before the first collection it is
  // a guess that happens to look like a real model name. The provisional frame
  // painted at startup is on screen for ~200ms of every launch and every
  // --reload, and it used to assert "[default]" there.
  //
  // Keyed on "has ever loaded" rather than the status word: a collector that
  // errored before its first success has no config either, while one that
  // errors later still holds the last good snapshot.
  const configHealth = data.collectorHealth?.environment;
  const configKnown =
    configHealth === undefined || configHealth.lastSuccessAt !== undefined;
  // A clean state scan makes a bounded history complete for runtime facts;
  // see environment-line.ts for the reasoning.
  const partialRuntime =
    data.partialHistory === true && data.runtimeStateComplete !== true;
  const runtimeModel = data.session?.model;
  const modelUnknown = partialRuntime && runtimeModel === undefined;
  const modelName = modelUnknown
    ? '?'
    : runtimeModel ?? getModelDisplayName(data.config);
  const runtimeReasoningEffort = data.session?.reasoningEffort;
  const reasoningUnknown =
    partialRuntime && runtimeModel !== undefined && runtimeReasoningEffort === undefined;
  const reasoningEffort =
    runtimeReasoningEffort ??
    (partialRuntime ? undefined : data.config.model_reasoning_effort);
  const showReasoningEffort = Boolean(
    !modelUnknown &&
    (runtimeModel ?? data.config.model) &&
    (reasoningEffort || reasoningUnknown)
  );
  // Same marker the truncation helpers use for "there is more than this".
  const identityName = modelUnknown
    ? '?'
    : data.session?.model === undefined && !configKnown
    ? '…'
    : sanitizeTerminalText(
        showReasoningEffort
          ? `${modelName} ${reasoningEffort ?? '?'}`
          : modelName
      ) || 'default';
  let contextDisplay = '';

  // Expanded mode suppresses this because its token line already renders the
  // same context information with a used/total breakdown. Compact mode keeps it.
  const showContext = options.showContext !== false;
  if (showContext && data.contextUsage) {
    const ctx = data.contextUsage;
    const bar = remainingBar(ctx.percent, layout.barWidth);
    const percentStr = getContextColor(ctx.percent)(
      `${Math.max(0, 100 - ctx.percent)}% left`
    );
    
    contextDisplay = `${bar} ${percentStr}`;
    
    // Add breakdown when usage is high
    if (layout.showContextBreakdown && ctx.percent >= 85) {
      contextDisplay += colors.dim(renderContextBreakdown(ctx));
    }
    
  } else if (showContext && data.tokenUsage?.total_token_usage) {
    // Fallback to old token usage format
    const usage = data.tokenUsage.total_token_usage;
    const total = usage.total_tokens ?? 0;
    const contextWindow = data.tokenUsage.model_context_window;
    
    if (contextWindow && contextWindow > 0) {
      const percent = Math.round((total / contextWindow) * 100);
      const bar = remainingBar(percent, layout.barWidth);
      const percentStr = getContextColor(percent)(
        `${Math.max(0, 100 - percent)}% left`
      );
      contextDisplay = `${bar} ${percentStr}`;
    } else {
      // Just show token count without bar
      contextDisplay = colors.dim(`Tokens: ${formatTokenCount(total)}`);
    }
  }

  const maxWidth = options.maxWidth;
  const framed = options.framed !== false;
  const modelOverhead = framed ? 2 : 0;
  const formatModel = (name: string): string => framed
    ? theme.modelBracket('[') + theme.model(name) + theme.modelBracket(']')
    : theme.model(name);
  let modelDisplay = formatModel(identityName);
  if (maxWidth && maxWidth > 0) {
    const contextLen = contextDisplay ? visualLength(contextDisplay) + 1 : 0;
    const availableForModel = Math.max(0, maxWidth - contextLen);
    if (availableForModel <= modelOverhead && contextDisplay) {
      return truncateAnsi(contextDisplay, maxWidth);
    }
    if (availableForModel > modelOverhead) {
      const maxModelLen = Math.max(1, availableForModel - modelOverhead);
      const trimmedModel = truncate(identityName, maxModelLen, '…');
      modelDisplay = formatModel(trimmedModel);
    }
  }

  parts.push(modelDisplay);
  if (contextDisplay) {
    parts.push(contextDisplay);
  }
  
  const line = parts.join(' ');
  return maxWidth ? truncateAnsi(line, maxWidth) : line;
}
