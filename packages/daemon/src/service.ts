import { resolve } from "node:path";
import { applySync, evaluateAllPools, evaluateHumanPreemptionFromSnapshot, planSync, rollbackSync, routeTask } from "@t3-pilot/core";
import { PilotGovernor, readPilotQuotaPools, readPilotSparkles, readPilotT3State, resolvePilotPaths, type PilotGovernorOptions } from "./governor.js";
import { appendSparkleToMarkdown, GhCliSparkleIssueSource, loadRuntimeState, saveRuntimeState, type SparkleExternalSource, type SparkleInput } from "./sparkle-queue.js";
import { CliT3ExecutionAdapter, DryRunT3ExecutionAdapter } from "./t3-adapter.js";
import { loadPilotConfig } from "./t3-installer.js";
import type { PilotConfig, PilotMcpBackend, PilotStatusSummary, PilotSyncActionInput, PilotSyncActionOutput } from "./types.js";

export interface PilotServiceOptions {
  workspaceRoot: string;
  config?: PilotConfig;
  externalSource?: SparkleExternalSource;
}

export class PilotService implements PilotMcpBackend {
  readonly workspaceRoot: string;
  readonly config: PilotConfig;
  readonly paths: ReturnType<typeof resolvePilotPaths>;
  private readonly externalSource?: SparkleExternalSource;

  constructor(options: PilotServiceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.config = options.config ?? loadPilotConfig(this.workspaceRoot);
    this.paths = resolvePilotPaths(this.workspaceRoot, this.config);
    this.externalSource = options.externalSource ?? (this.config.githubIssues ? new GhCliSparkleIssueSource() : undefined);
  }

  async getStatus(): Promise<PilotStatusSummary> {
    const external = await this.externalSource?.listSparkles(this.workspaceRoot);
    const now = new Date();
    const runtimeState = loadRuntimeState(this.workspaceRoot);
    const pools = readPilotQuotaPools(this.paths.t3Home, this.config);
    const t3State = readPilotT3State(this.paths.sqlitePath);
    return {
      generatedAt: now.toISOString(), workspaceRoot: this.workspaceRoot, config: this.config, pools,
      pacing: evaluateAllPools(pools, now, this.config.pacing),
      humanPreemption: t3State && evaluateHumanPreemptionFromSnapshot(t3State, {
        now, cooldownMinutes: this.config.cooldownMinutes, pilotThreadIds: runtimeState.pilotThreadIds,
      }),
      sparkles: readPilotSparkles(this.paths.sparklesPath, runtimeState, external), runtimeState,
    };
  }

  async routeTask(task: string, manualOverride = false) {
    return routeTask(task, readPilotQuotaPools(this.paths.t3Home, this.config), { manualOverride, pacingConfig: this.config.pacing });
  }

  async listSparkles() {
    const external = await this.externalSource?.listSparkles(this.workspaceRoot);
    return readPilotSparkles(this.paths.sparklesPath, loadRuntimeState(this.workspaceRoot), external);
  }

  async addSparkle(input: SparkleInput) {
    return appendSparkleToMarkdown(this.paths.sparklesPath, input);
  }

  async syncHarnesses(input: PilotSyncActionInput): Promise<PilotSyncActionOutput> {
    if (input.rollbackSnapshotId === true || typeof input.rollbackSnapshotId === "string") {
      const snapshotId = typeof input.rollbackSnapshotId === "string" ? input.rollbackSnapshotId : undefined;
      return { mode: "rollback", result: rollbackSync(this.workspaceRoot, snapshotId) };
    }
    const options = { workspaceRoot: this.workspaceRoot, targets: input.targets ?? this.config.syncTargets };
    if (input.dryRun !== false) return { mode: "plan", result: planSync(options) };
    const result = applySync(options);
    if (result.snapshotId) {
      try {
        const state = loadRuntimeState(this.workspaceRoot);
        state.lastSyncSnapshotId = result.snapshotId;
        state.updatedAt = new Date().toISOString();
        saveRuntimeState(this.workspaceRoot, state);
      } catch (error) {
        try {
          rollbackSync(this.workspaceRoot, result.snapshotId);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Could not record or roll back the sync snapshot.");
        }
        throw error;
      }
    }
    return { mode: "apply", result };
  }

  createGovernor(options: Omit<PilotGovernorOptions, "workspaceRoot" | "config" | "externalSource" | "adapter"> & {
    adapter?: PilotGovernorOptions["adapter"];
  } = {}): PilotGovernor {
    let adapter = options.adapter;
    if (!adapter && options.dryRun) {
      const simulation = new DryRunT3ExecutionAdapter();
      const active = loadRuntimeState(this.workspaceRoot).activeRun;
      if (active) simulation.setThreadStatus(active.threadId, "running");
      adapter = simulation;
    }
    return new PilotGovernor({
      workspaceRoot: this.workspaceRoot, config: this.config, externalSource: this.externalSource,
      requireHumanSnapshot: !options.dryRun && !options.adapter,
      ...options,
      adapter: adapter ?? new CliT3ExecutionAdapter({ t3Home: this.paths.t3Home, requireInterrupt: true }),
    });
  }
}
