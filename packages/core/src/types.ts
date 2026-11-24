/**
 * Shared canonical domain types for t3-pilot (@t3-pilot/core & t3-pilot daemon).
 * Engineered for T3 Code (statev2.sqlite + ~/.t3/caches/*.json).
 */

export type QuotaPoolId =
  | "codex"
  | "antigravity-gemini"
  | "antigravity-claude"
  | "claude-agent"
  | "cursor";

export type ProviderDriverKind =
  | "codex"
  | "antigravity"
  | "claudeAgent"
  | "cursor";

export interface RawT3UsageWindow {
  id: string;
  label: string;
  kind: "session" | "weekly" | string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins: number;
}

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
  /** Weekly & session emergency reserve shield percentage (default: 20) */
  reserveFloorPercent?: number;
  /** Weekly quota % drained by exhausting a single 5h window, C_5h (default: 14, ~7 full 5h sessions/week) */
  singleWindowCapacityPercent?: number;
  /** Measured 5h weekly-equivalent drain capacity, when calibrated. Takes precedence over nominal C_5h. */
  effectiveWindowCapacityPercent?: number;
  lockUnknownPools?: boolean;
  /** Coupling ratio threshold S_week / (N_5h * C_5h) to enter FULL_THROTTLE_HARVEST (default: 0.85) */
  fullThrottleRatioThreshold?: number;
  /** Remaining minutes in 5h session window to trigger EXPIRING_5H_HARVEST when weekly pace has surplus (default: 45) */
  expiringSessionThresholdMins?: number;
  /** Minimum minutes before resetAt to enforce hard stop (default: 2, minimum enforced >= 2) */
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
  /** Current harvestable percent in this 5h session without violating weekly or session floor */
  effectiveBurnablePercent: number;
  timeToWeeklyResetMs: number | null;
  timeToSessionResetMs: number | null;
  remaining5hWindowsCount: number | null;
  maxDrainCapacityPercent: number | null;
  /** S_week / (ceil(T_left / 5h) * C_5h) */
  couplingRatio: number | null;
  /** Ideal remaining weekly % on a linear burn curve from 100% -> 20% across 168h */
  idealWeeklyRemainingPercent: number | null;
  /** Positive means ahead of pace (surplus), negative means burning faster than linear pace */
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
  /** Earliest stamped resetAt minus >= 2 min safety margin */
  hardDeadlineAt: string | null;
  safetyMarginMs: number;
}

export type EpochStopReason =
  | "OK"
  | "HARD_STOP_SAFETY_MARGIN"
  | "HARD_STOP_SESSION_EPOCH_ADVANCED"
  | "HARD_STOP_WEEKLY_EPOCH_ADVANCED"
  | "HARD_STOP_RESERVE_SHIELD"
  | "HARD_STOP_POOL_UNAVAILABLE";

export interface EpochCheckResult {
  allowed: boolean;
  shouldHaltImmediately: boolean;
  reason: EpochStopReason;
  detail: string;
  remainingBeforeDeadlineMs: number | null;
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

export type HumanActivityState =
  | "CLEAR_FOR_PILOT"
  | "PREEMPTED_ACTIVE_HUMAN_TURN"
  | "COOLDOWN_AFTER_HUMAN_TURN";

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

export interface CanonicalMcpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description?: string;
}

export interface CanonicalMcpConfig {
  mcpServers: Record<string, CanonicalMcpServerSpec>;
}

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

export interface QuotaWindowOverride {
  usedPercent: number;
  id?: string;
  label?: string;
  resetsAt?: string | null;
  windowDurationMins?: number;
}

export interface QuotaPoolOverride {
  sessionWindow?: QuotaWindowOverride | null;
  weeklyWindow?: QuotaWindowOverride | null;
  checkedAt?: string | null;
}

export interface ReadQuotaOptions {
  t3Home?: string;
  codexHome?: string;
  poolOverrides?: Partial<Record<QuotaPoolId, QuotaPoolOverride>>;
  includeCommunityStubs?: boolean;
}

export interface RouteTaskOptions {
  modelCatalog?: ModelCandidate[];
  pacingConfig?: PacingConfig;
  now?: Date;
  manualOverride?: boolean;
  externalUnmeteredSurplusFactor?: number;
}

export interface T3ProjectSnapshot {
  projectId: string;
  title: string;
  workspaceRoot: string;
  scriptsJson: string | null;
}

export interface T3ThreadSnapshot {
  threadId: string;
  projectId: string;
  title: string;
  defaultProvider: string | null;
  providerInstanceId: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  payloadJson: string | null;
  latestUserMessageAt: string | null;
}

export interface T3RunSnapshot {
  runId: string;
  threadId: string;
  ordinal: number | null;
  provider: string;
  providerInstanceId: string | null;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  payloadJson: string | null;
}

export interface T3SubagentSnapshot {
  subagentId: string;
  threadId: string;
  childThreadId: string | null;
  origin: string | null;
  status: string | null;
}

export interface T3StateSnapshot {
  projects: T3ProjectSnapshot[];
  threads: T3ThreadSnapshot[];
  runs: T3RunSnapshot[];
  subagents: T3SubagentSnapshot[];
}

export interface HumanPreemptionOptions {
  now?: Date;
  cooldownMinutes?: number;
  pilotThreadIds?: ReadonlySet<string> | readonly string[];
  pilotTitlePrefixes?: readonly string[];
}

export interface SyncOptions {
  workspaceRoot: string;
  targetRoot?: string;
  targets?: readonly SyncHarnessTarget[];
  dryRun?: boolean;
}

export interface SyncRollbackResult {
  snapshotId: string;
  restoredPaths: string[];
  removedPaths: string[];
}

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

export interface ShieldToolCallInput {
  harness?: SyncHarnessTarget | "generic";
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
