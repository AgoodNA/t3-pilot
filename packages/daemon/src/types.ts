import type {
  EpochCheckResult,
  EpochLease,
  HumanPreemptionReport,
  PacingConfig,
  PoolPacingEvaluation,
  ProviderDriverKind,
  QuotaPoolId,
  QuotaPoolOverride,
  QuotaPoolSnapshot,
  RouteDecision,
  ScoredModelRoute,
  ShieldEvaluationResult,
  ShieldPolicyConfig,
  ShieldToolCallInput,
  SyncHarnessTarget,
  SyncPlanResult,
  SyncRollbackResult,
} from "@t3-pilot/core";

export type SparkleExecutionMode = "worktree" | "scratch";

export type SparkleItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "halted"
  | "failed";

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
  poolOverrides?: Partial<Record<QuotaPoolId, QuotaPoolOverride>>;
  includeCommunityStubs?: boolean;
  githubIssues?: boolean;
  autoConfigureIdleThreads?: boolean;
  requeueOnEpochHalt?: boolean;
  /** Maximum age in minutes for cached quota telemetry before failing closed (default: 60) */
  maxQuotaStalenessMins?: number;
  syncTargets: SyncHarnessTarget[];
}

export interface T3ProjectScriptSpec {
  id: string;
  name: string;
  command: string;
  icon: "play" | "test" | "lint" | "configure" | "build" | "debug";
  runOnWorktreeCreate: boolean;
  autoOpenPreview?: boolean;
  previewUrl?: string;
  async?: boolean;
  runOnSettle?: boolean;
  stopOnSettle?: boolean;
}

export interface PilotInitOptions {
  workspaceRoot: string;
  projectId?: string;
  cockpitPort?: number;
  baseBranch?: string;
  force?: boolean;
}

export interface PilotInitResult {
  workspaceRoot: string;
  configPath: string;
  sparklesPath: string;
  mcpConfigPath: string;
  sampleSkillPath: string;
  pilotScript: T3ProjectScriptSpec;
  resolvedProjectId?: string;
  scriptInstalled?: boolean;
  createdFiles: string[];
  preservedFiles: string[];
}

export interface LaunchSparkleRequest {
  workspaceRoot: string;
  projectId?: string;
  item: SparkleItem;
  route: ScoredModelRoute;
  baseBranch: string;
  scratchDir?: string;
  resume?: Pick<SparkleRunRecord, "threadId" | "branchName" | "scratchDir" | "providerInstanceId" | "model">;
}

export interface LaunchSparkleResult {
  threadId: string;
  branchName: string | null;
  scratchDir: string | null;
}

export interface SparkleThreadStatus {
  threadId: string;
  state: "running" | "completed" | "failed" | "stopped";
  summary?: string;
}

export interface IdleThreadReconfigureRequest {
  threadId: string;
  route: ScoredModelRoute;
}

export interface T3ExecutionAdapter {
  launchSparkle(request: LaunchSparkleRequest): Promise<LaunchSparkleResult>;
  getThreadStatus(threadId: string): Promise<SparkleThreadStatus>;
  stopSparkle(threadId: string, reason: string): Promise<void>;
  configureIdleThread?(request: IdleThreadReconfigureRequest): Promise<boolean>;
}

export interface IdleThreadShieldAdvisory {
  threadId: string;
  threadTitle: string;
  blockedPoolId: QuotaPoolId;
  recommendedRoute: ScoredModelRoute | null;
  applied: boolean;
}

export type GovernorTickAction =
  | "IDLE_NO_HARVEST_SURPLUS"
  | "IDLE_QUEUE_EMPTY"
  | "YIELDED_TO_HUMAN"
  | "COOLDOWN_WAITING"
  | "SPARKLE_LAUNCHED"
  | "SPARKLE_CONTINUING"
  | "SPARKLE_COMPLETED"
  | "HALTED_EPOCH_LOCK"
  | "HALTED_STATE_UNAVAILABLE"
  | "PREEMPTED_BY_HUMAN";

export interface GovernorTickResult {
  timestamp: string;
  action: GovernorTickAction;
  detail: string;
  pools: QuotaPoolSnapshot[];
  pacing: PoolPacingEvaluation[];
  humanPreemption: HumanPreemptionReport | null;
  epochCheck: EpochCheckResult | null;
  activeRun: SparkleRunRecord | null;
  launchedRun: SparkleRunRecord | null;
  haltedRun: SparkleRunRecord | null;
  shieldAdvisories: IdleThreadShieldAdvisory[];
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

export interface PilotSyncActionInput {
  dryRun?: boolean;
  targets?: SyncHarnessTarget[];
  rollbackSnapshotId?: string | boolean;
}

export type PilotSyncActionOutput =
  | { mode: "plan" | "apply"; result: SyncPlanResult }
  | { mode: "rollback"; result: SyncRollbackResult };

export interface PilotMcpBackend {
  getStatus(): Promise<PilotStatusSummary>;
  getShieldPolicy(): ShieldPolicyConfig;
  checkShield(input: ShieldToolCallInput): ShieldEvaluationResult;
  routeTask(task: string, manualOverride?: boolean): Promise<RouteDecision>;
  addSparkle(input: {
    title: string;
    mode?: SparkleExecutionMode;
    prompt?: string;
  }): Promise<{ added: SparkleItem; queue: SparkleItem[] }>;
  syncHarnesses(input: PilotSyncActionInput): Promise<PilotSyncActionOutput>;
}
