/**
 * Browser-side mirror of the t3-pilot REST contract (`packages/core/src/types.ts` +
 * `packages/daemon/src/types.ts`). Kept dependency-free so the Cockpit bundle never pulls
 * Node-only modules (node:sqlite, node:fs) into the browser or the GitHub Pages demo.
 */

export type QuotaPoolId = "codex" | "antigravity-gemini" | "antigravity-claude" | "claude-agent" | "cursor";
export type ProviderDriverKind = "codex" | "antigravity" | "claudeAgent" | "cursor";

export interface NormalizedWindowState {
  id: string;
  label: string;
  kind: "session" | "weekly";
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowDurationMins: number;
}

export type QuotaSourceKind =
  | "t3-cache-windows"
  | "codex-session-jsonl"
  | "manual-override"
  | "external-unmetered"
  | "unavailable";

export interface QuotaPoolSnapshot {
  poolId: QuotaPoolId;
  providerInstanceId: string;
  driver: ProviderDriverKind;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  source: QuotaSourceKind;
  checkedAt: string | null;
  sessionWindow: NormalizedWindowState | null;
  weeklyWindow: NormalizedWindowState | null;
  externalUsageUrl?: string;
  unavailableReason?: string;
}

export type HarvestMode =
  | "LOCKED_SHIELD"
  | "PRESERVE_WINDOWS"
  | "EXPIRING_5H_HARVEST"
  | "FULL_THROTTLE_HARVEST"
  | "EXTERNAL_UNMETERED";

export interface PacingConfig {
  reserveFloorPercent?: number;
  singleWindowCapacityPercent?: number;
  effectiveWindowCapacityPercent?: number;
  lockUnknownPools?: boolean;
  fullThrottleRatioThreshold?: number;
  expiringSessionThresholdMins?: number;
  epochSafetyMarginMins?: number;
}

export interface PoolPacingEvaluation {
  poolId: QuotaPoolId;
  providerInstanceId: string;
  reserveFloorPercent: number;
  weeklyRemainingPercent: number | null;
  sessionRemainingPercent: number | null;
  weeklyBurnableSurplusPercent: number;
  sessionBurnableSurplusPercent: number;
  effectiveBurnablePercent: number;
  timeToWeeklyResetMs: number | null;
  timeToSessionResetMs: number | null;
  remaining5hWindowsCount: number | null;
  maxDrainCapacityPercent: number | null;
  couplingRatio: number | null;
  idealWeeklyRemainingPercent: number | null;
  paceDeltaPercent: number | null;
  shieldLocked: boolean;
  shieldReason: string | null;
  harvestMode: HarvestMode;
  harvestReason: string;
}

export interface EpochLease {
  leaseId: string;
  poolId: QuotaPoolId;
  providerInstanceId: string;
  leasedAt: string;
  targetSessionResetAt: string | null;
  targetWeeklyResetAt: string | null;
  hardDeadlineAt: string | null;
  safetyMarginMs: number;
}

export type TaskCategory =
  | "UI_FRONTEND_LONGFORM"
  | "SYSTEMS_PARSERS_TESTS_DEBUGGING"
  | "BOILERPLATE_DOCS_TRANSLATIONS"
  | "ARCHITECTURE_ORCHESTRATION";

export interface ModelCandidate {
  id: string;
  label: string;
  poolId: QuotaPoolId;
  providerInstanceId: string;
  driver: ProviderDriverKind;
  defaultOptions?: Record<string, string | boolean>;
  affinities: Record<TaskCategory, number>;
}

export interface ScoredModelRoute {
  candidate: ModelCandidate;
  eligible: boolean;
  blockedReason: string | null;
  manualOverrideApplied: boolean;
  taskAffinity: number;
  surplusFactor: number;
  urgencyWeight: number;
  compositeScore: number;
  t3ThreadConfigurePayload: {
    modelSelection: {
      instanceId: string;
      provider: ProviderDriverKind;
      model: string;
      options?: Record<string, string | boolean>;
    };
  };
}

export interface RouteDecision {
  task: string;
  category: TaskCategory;
  manualOverride: boolean;
  selected: ScoredModelRoute | null;
  ranked: ScoredModelRoute[];
  warnings: string[];
}

export type HumanActivityState = "CLEAR_FOR_PILOT" | "PREEMPTED_ACTIVE_HUMAN_TURN" | "COOLDOWN_AFTER_HUMAN_TURN";

export interface ActiveHumanRunSummary {
  runId: string;
  threadId: string;
  threadTitle: string;
  status: string;
  provider: string;
  requestedAt: string;
  completedAt: string | null;
}

export interface HumanPreemptionReport {
  shouldPreempt: boolean;
  state: HumanActivityState;
  cooldownMinutes: number;
  activeHumanRuns: ActiveHumanRunSummary[];
  lastHumanActivityAt: string | null;
  resumeAvailableAt: string | null;
  resumeInMs: number;
  reason: string;
}

export type SyncHarnessTarget = "antigravity" | "codex" | "claude-code";

export interface SyncFileChange {
  harness: SyncHarnessTarget;
  targetPath: string;
  action: "create" | "update" | "unchanged";
  beforeContent: string | null;
  afterContent: string;
  unifiedDiff: string;
}

export interface SyncPlanResult {
  sourceSkillsDir: string;
  sourceMcpPath: string;
  discoveredSkills: string[];
  discoveredMcpServers: string[];
  changes: SyncFileChange[];
  applied: boolean;
  snapshotId?: string;
  warnings?: string[];
}

export interface SyncRollbackResult {
  snapshotId: string;
  restoredPaths: string[];
  removedPaths: string[];
}

export interface PilotSyncActionInput {
  dryRun?: boolean;
  targets?: SyncHarnessTarget[];
  rollbackSnapshotId?: string | boolean;
}

export type PilotSyncActionOutput =
  | { mode: "plan" | "apply"; result: SyncPlanResult }
  | { mode: "rollback"; result: SyncRollbackResult };

export type ShieldMode = "guarded-turbo" | "strict" | "off";
export type ShieldDecision = "allow" | "deny" | "force_ask";
export type ShieldRuleCategory =
  | "destructive-fs"
  | "host-credentials"
  | "git-history"
  | "infra-containers-firewall"
  | "package-publish"
  | "repo-visibility";

export interface ShieldRule {
  id: string;
  title: string;
  description: string;
  category: ShieldRuleCategory;
  enabled: boolean;
  decision: ShieldDecision;
  commandPatterns?: string[];
  pathPatterns?: string[];
  codexPrefixPatterns?: string[][];
}

export interface ShieldPolicyConfig {
  version: 1;
  mode: ShieldMode;
  protectedBranches: string[];
  rules: ShieldRule[];
}

export type ShieldHarness = SyncHarnessTarget | "generic";

export interface ShieldToolCallInput {
  harness?: ShieldHarness;
  toolName: string;
  command?: string;
  filePath?: string;
  args?: Record<string, unknown>;
  cwd?: string;
}

export interface ShieldEvaluationResult {
  mode: ShieldMode;
  decision: ShieldDecision;
  matchedRuleId: string | null;
  matchedRuleTitle: string | null;
  reason: string;
}

export type SparkleExecutionMode = "worktree" | "scratch";
export type SparkleItemStatus = "pending" | "running" | "completed" | "halted" | "failed";

export interface SparkleItem {
  id: string;
  lineIndex?: number;
  source: "sparkles-md" | "github-issue";
  mode: SparkleExecutionMode;
  status: SparkleItemStatus;
  title: string;
  prompt: string;
  branchName?: string | null;
  threadId?: string;
  externalRef?: string;
  note?: string;
}

export interface SparkleRunRecord {
  runId: string;
  itemId: string;
  itemTitle: string;
  mode: SparkleExecutionMode;
  threadId: string;
  branchName: string | null;
  scratchDir: string | null;
  poolId: QuotaPoolId;
  providerInstanceId: string;
  driver: ProviderDriverKind;
  model: string;
  startedAt: string;
  endedAt: string | null;
  outcome: "running" | "completed" | "halted_epoch_lock" | "preempted_human" | "failed" | "halted_safety";
  stopReason: string | null;
  lease: EpochLease;
  requeue?: boolean;
}

export interface PilotRuntimeState {
  version: 1;
  updatedAt: string;
  pilotThreadIds: string[];
  activeRun: SparkleRunRecord | null;
  history: SparkleRunRecord[];
  lastSyncSnapshotId: string | null;
}

export interface PilotConfig {
  version: 1;
  projectId?: string;
  t3Home?: string;
  sqlitePath?: string;
  sparklesFile?: string;
  cooldownMinutes: number;
  tickIntervalMs: number;
  cockpitPort: number;
  baseBranch: string;
  pacing: PacingConfig;
  includeCommunityStubs?: boolean;
  githubIssues?: boolean;
  autoConfigureIdleThreads?: boolean;
  requeueOnEpochHalt?: boolean;
  maxQuotaStalenessMins?: number;
  syncTargets: SyncHarnessTarget[];
}

export interface PilotStatusSummary {
  generatedAt: string;
  workspaceRoot: string;
  config: PilotConfig;
  pools: QuotaPoolSnapshot[];
  pacing: PoolPacingEvaluation[];
  humanPreemption: HumanPreemptionReport | null;
  sparkles: SparkleItem[];
  runtimeState: PilotRuntimeState;
  shield: ShieldPolicyConfig;
}

export interface AddSparkleInput {
  title: string;
  mode?: SparkleExecutionMode;
  prompt?: string;
}

export interface ShieldPatch {
  mode?: ShieldMode;
  ruleId?: string;
  enabled?: boolean;
  decision?: ShieldDecision;
}

export interface ShieldCheckInput {
  harness?: ShieldHarness;
  toolName: string;
  command?: string;
  filePath?: string;
}
