import type { HudData, PermissionState } from '../types.js';

/** Global defaults cannot establish effective project/profile permissions. */
export function runtimePermissions(data: Pick<HudData, 'session' | 'paneCliPolicy' | 'paneFreshSession'>): PermissionState {
  const session = data.paneFreshSession ? undefined : data.session;
  return {
    approvalPolicy: session?.approvalPolicy ?? data.paneCliPolicy?.approvalPolicy,
    sandboxMode: session?.sandboxMode ?? data.paneCliPolicy?.sandboxMode,
  };
}
