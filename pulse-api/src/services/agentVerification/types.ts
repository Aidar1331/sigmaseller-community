// Multi-Agent v2 — V&V type definitions (Phase 0 skeleton)

export type CheckType = 'immediate' | 'deferred_30s' | 'deferred_5min' | 'impact_24h';
export type CheckResult = 'pass' | 'drift' | 'fail' | 'timeout';

export interface VerificationExpectation {
  // snapshot of WB state as understood by agent right before execute
  // check functions compare this with post-execute state
  snapshot?: Record<string, unknown>;
  // optional extra context the check function needs
  [key: string]: unknown;
}

export interface PendingCheckRow {
  checkId: string;
  actionId: number;
  checkType: CheckType;
  scheduledAt: Date;
}

export interface CheckFnArgs {
  actionId: number;
  actionType: string; // 'action_set_price', etc.
  checkType: CheckType;
  payload: Record<string, unknown>; // agent_actions.payload snapshot
  workspaceId: number;
  shopId: number | null;
}

export interface CheckFnResult {
  result: CheckResult;
  details?: Record<string, unknown>;
}

// A check function: looks at live state (WB API or DB) and compares with expected
export type CheckFn = (args: CheckFnArgs) => Promise<CheckFnResult>;

export interface RunPendingSummary {
  checked: number;
  passed: number;
  drifted: number;
  failed: number;
  timedOut: number;
  skippedNoChecker: number;
}
