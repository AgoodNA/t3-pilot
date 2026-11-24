import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createEpochLease, evaluateAllPools, evaluateHumanPreemptionFromSnapshot, inspectT3State, readQuotaPools, routeTask,
  verifyEpochLease, type EpochCheckResult, type QuotaPoolSnapshot, type T3StateSnapshot,
} from "@t3-pilot/core";
import { loadRuntimeState, readSparklesQueue, saveRuntimeState, updateSparkleStatusInMarkdown, type SparkleExternalSource } from "./sparkle-queue.js";
import { T3_COMMAND_TIMEOUT_MS } from "./t3-adapter.js";
import { loadPilotConfig } from "./t3-installer.js";
import type {
  GovernorTickResult, IdleThreadShieldAdvisory, PilotConfig, PilotRuntimeState, SparkleItem, SparkleItemStatus,
  SparkleRunRecord, SparkleThreadStatus, T3ExecutionAdapter,
} from "./types.js";

export interface PilotGovernorOptions {
  workspaceRoot: string;
  adapter: T3ExecutionAdapter;
  config?: PilotConfig;
  externalSource?: SparkleExternalSource;
  dryRun?: boolean;
  requireHumanSnapshot?: boolean;
  readPools?: () => QuotaPoolSnapshot[];
  readT3State?: (sqlitePath: string) => T3StateSnapshot | null;
  onError?: (error: unknown) => void;
}

export function resolvePilotPaths(workspaceRoot: string, config: PilotConfig) {
  const t3Home = resolve(workspaceRoot, config.t3Home ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3"));
  return {
    t3Home,
    sqlitePath: config.sqlitePath ? resolve(workspaceRoot, config.sqlitePath) : join(t3Home, "userdata", "statev2.sqlite"),
    sparklesPath: resolve(workspaceRoot, config.sparklesFile ?? "SPARKLES.md"),
  };
}

export function readPilotQuotaPools(t3Home: string, config: PilotConfig): QuotaPoolSnapshot[] {
  return readQuotaPools({ t3Home, poolOverrides: config.poolOverrides, includeCommunityStubs: config.includeCommunityStubs });
}

export function readPilotT3State(sqlitePath: string): T3StateSnapshot | null {
  return existsSync(sqlitePath) ? inspectT3State(sqlitePath) : null;
}

function runStatus(run: SparkleRunRecord): SparkleItemStatus {
  if (run.outcome === "running" || run.outcome === "completed" || run.outcome === "failed") return run.outcome;
  return run.outcome === "halted_epoch_lock" && run.requeue === false ? "halted" : "pending";
}

export function readPilotSparkles(sparklesPath: string, state: PilotRuntimeState, external: SparkleItem[] = []): SparkleItem[] {
  const runs = new Map(state.history.map((run) => [run.itemId, run]));
  if (state.activeRun) runs.set(state.activeRun.itemId, state.activeRun);
  const local = readSparklesQueue(sparklesPath);
  const localIds = new Set(local.map((item) => item.id));
  return [...local, ...external.filter((item) => !localIds.has(item.id))].map((item) => {
    const run = runs.get(item.id);
    const staleRunningItem = item.status === "running" && item.threadId === run?.threadId;
    if (!run || (item.source === "sparkles-md" && run.outcome !== "running" && !staleRunningItem)) return item;
    return {
      ...item, status: runStatus(run), threadId: run.threadId, branchName: run.branchName,
    };
  });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function pilotOwnership(snapshot: T3StateSnapshot, knownIds: string[]): Set<string> {
  const owned = new Set(knownIds);
  const children = new Map<string, string[]>();
  const link = (parent: string, child: string) => children.set(parent, [...(children.get(parent) ?? []), child]);
  for (const thread of snapshot.threads) {
    if (/^\[(Sparkle|t3-pilot)\]/.test(thread.title)) owned.add(thread.threadId);
    try {
      const metadata = JSON.parse(thread.payloadJson ?? "{}") as { createdBy?: string; delegatedFrom?: { threadId?: string } } | null;
      if (metadata?.createdBy === "pilot") owned.add(thread.threadId);
      if (metadata?.delegatedFrom?.threadId) link(metadata.delegatedFrom.threadId, thread.threadId);
    } catch {
      // Some legacy projections have no JSON ownership metadata.
    }
  }
  for (const agent of snapshot.subagents) if (agent.childThreadId) link(agent.threadId, agent.childThreadId);
  for (const id of owned) for (const child of children.get(id) ?? []) owned.add(child);
  return owned;
}

interface StopIntent {
  action: "HALTED_EPOCH_LOCK" | "HALTED_STATE_UNAVAILABLE" | "PREEMPTED_BY_HUMAN";
  outcome: "halted_epoch_lock" | "halted_safety" | "preempted_human";
  reason: string;
  detail: string;
  status: "pending" | "halted";
}

export class PilotGovernor {
  readonly workspaceRoot: string;
  readonly config: PilotConfig;
  readonly paths: ReturnType<typeof resolvePilotPaths>;
  private tail: Promise<unknown> = Promise.resolve();
  private simulatedState?: PilotRuntimeState;
  private enabled = false;
  private monitoring?: { resolve: () => void; reject: (error: unknown) => void };
  private polling = false;
  private pollRequested = false;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: { runId: string; timer: ReturnType<typeof setTimeout> };
  private safetyTimer?: ReturnType<typeof setTimeout>;
  private watchers: FSWatcher[] = [];
  private watchedFiles = new Set<string>();
  private stopRequest?: { runId: string; intent: StopIntent; promise?: Promise<void> };

  constructor(private readonly options: PilotGovernorOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.config = options.config ?? loadPilotConfig(this.workspaceRoot);
    this.paths = resolvePilotPaths(this.workspaceRoot, this.config);
  }

  runTick(now?: Date): Promise<GovernorTickResult> {
    const next = this.tail.then(() => this.withWorkspaceLock(() => this.tick(now, !this.monitoring)));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async withWorkspaceLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.options.dryRun) return work();
    const directory = join(this.workspaceRoot, ".t3-pilot", "governor-locks");
    mkdirSync(directory, { recursive: true });
    const token = `${process.pid}-${randomUUID()}.lock`;
    const path = join(directory, token);
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    try {
      // Publish before scanning. A competing tick sees this token or encounters the current one.
      for (const entry of readdirSync(directory)) {
        if (entry === token) continue;
        const owner = /^([1-9]\d*)-[0-9a-f-]{36}\.lock$/.exec(entry);
        if (!owner) continue;
        if (processIsRunning(Number(owner[1]))) throw new Error("Another Sparkle governor tick is in progress in this workspace.");
        rmSync(join(directory, entry), { force: true });
      }
      return await work();
    } finally {
      rmSync(path, { force: true });
    }
  }

  private runtimeState(): PilotRuntimeState {
    if (!this.options.dryRun) return loadRuntimeState(this.workspaceRoot);
    return this.simulatedState ??= loadRuntimeState(this.workspaceRoot);
  }

  private persist(state: PilotRuntimeState, now: Date): void {
    state.updatedAt = now.toISOString();
    if (this.options.dryRun) this.simulatedState = state;
    else {
      // Sync can finish while the governor is waiting for a T3 command.
      state.lastSyncSnapshotId = loadRuntimeState(this.workspaceRoot).lastSyncSnapshotId;
      saveRuntimeState(this.workspaceRoot, state);
    }
  }

  private readSnapshot(state: PilotRuntimeState, now: Date) {
    let pools: QuotaPoolSnapshot[] = [];
    let poolError: unknown;
    let snapshotError: unknown;
    let t3State: T3StateSnapshot | null = null;
    try {
      pools = this.options.readPools?.() ?? readPilotQuotaPools(this.paths.t3Home, this.config);
    } catch (error) {
      poolError = error;
    }
    try {
      t3State = (this.options.readT3State ?? readPilotT3State)(this.paths.sqlitePath);
    } catch (error) {
      snapshotError = error;
    }
    return {
      pools, poolError, snapshotError, t3State,
      pacing: evaluateAllPools(pools, now, this.config.pacing),
      humanPreemption: t3State && evaluateHumanPreemptionFromSnapshot(t3State, {
        now, pilotThreadIds: state.pilotThreadIds, cooldownMinutes: this.config.cooldownMinutes,
      }),
    };
  }

  private async tick(nowOverride: Date | undefined, allowLaunch: boolean): Promise<GovernorTickResult> {
    const state = this.runtimeState();
    const active = state.activeRun;
    this.armDeadline(active);
    let threadStatus: SparkleThreadStatus | undefined;
    let statusError: unknown;
    if (active) {
      try {
        threadStatus = await this.options.adapter.getThreadStatus(active.threadId);
      } catch (error) {
        statusError = error;
      }
    }
    let now = nowOverride ?? new Date();
    let live = this.readSnapshot(state, now);
    const result = (action: GovernorTickResult["action"], detail: string, extra: Partial<GovernorTickResult> = {}): GovernorTickResult => ({
      timestamp: now.toISOString(), action, detail, pools: live.pools, pacing: live.pacing, humanPreemption: live.humanPreemption,
      epochCheck: null, activeRun: state.activeRun, launchedRun: null, haltedRun: null, shieldAdvisories: [], ...extra,
    });

    if (active) {
      const priorStop = this.stopRequest?.runId === active.runId ? this.stopRequest.intent : undefined;
      if (!priorStop && threadStatus && threadStatus.state !== "running") {
        const completed = threadStatus.state === "completed";
        const detail = threadStatus.summary ?? `Sparkle thread ${threadStatus.state}.`;
        const history = this.finishRun(state, active, now, completed ? "completed" : "failed",
          completed ? null : threadStatus.state, completed ? "completed" : "failed", detail);
        return result(completed ? "SPARKLE_COMPLETED" : "HALTED_EPOCH_LOCK", detail, { haltedRun: completed ? null : history });
      }
      const epochCheck = this.checkLease(active, live.pools, now);
      const intent = priorStop ?? this.safetyStop(epochCheck, live);
      if (intent) {
        await this.interruptRun(active, intent);
        const haltedRun = this.finishRun(state, active, now, intent.outcome, intent.reason, intent.status, intent.detail);
        return result(intent.action, intent.detail, { epochCheck, haltedRun });
      }
      if (statusError) throw statusError;
      const shieldAdvisories = await this.shieldAdvisories(state, live, now);
      return result("SPARKLE_CONTINUING", "The active Sparkle lease is clear.", { epochCheck, shieldAdvisories });
    }

    if (!allowLaunch) return result("IDLE_NO_HARVEST_SURPLUS", "There is no active Sparkle to monitor.");
    const idle = () => {
      if (live.humanPreemption?.shouldPreempt) {
        const { state: humanState, reason } = live.humanPreemption;
        return result(humanState === "PREEMPTED_ACTIVE_HUMAN_TURN" ? "YIELDED_TO_HUMAN" : "COOLDOWN_WAITING", reason);
      }
      if (live.snapshotError || (this.options.requireHumanSnapshot && !live.t3State)) {
        return result("IDLE_NO_HARVEST_SURPLUS", "T3 human activity could not be verified.");
      }
      return null;
    };
    const harvestingPools = () => live.pools.filter((pool, index) => {
      const mode = live.pacing[index]?.harvestMode;
      return (mode === "FULL_THROTTLE_HARVEST" || mode === "EXPIRING_5H_HARVEST") && !this.isPoolStale(pool, now);
    });
    const shieldAdvisories = await this.shieldAdvisories(state, live, now);
    const finishIdle = (action: GovernorTickResult["action"], detail: string) => result(action, detail, { shieldAdvisories });
    const refresh = () => {
      now = nowOverride ?? new Date();
      live = this.readSnapshot(state, now);
    };
    const blocked = idle();
    if (blocked) return { ...blocked, shieldAdvisories };
    if (live.poolError) throw live.poolError;
    if (!harvestingPools().length) return finishIdle("IDLE_NO_HARVEST_SURPLUS", "No pool has harvestable quota surplus.");

    let item = readPilotSparkles(this.paths.sparklesPath, state).find((entry) => entry.status === "pending");
    if (!item && this.options.externalSource) {
      const external = await this.options.externalSource.listSparkles(this.workspaceRoot);
      item = readPilotSparkles(this.paths.sparklesPath, state, external).find((entry) => entry.status === "pending");
    }
    if (!item) return finishIdle("IDLE_QUEUE_EMPTY", "The Sparkle queue has no pending items.");
    const previous = state.history.findLast((run) => run.itemId === item.id);
    const resume = previous?.mode === item.mode && runStatus(previous) === "pending" ? previous : undefined;
    if (resume && !this.options.dryRun && (await this.options.adapter.getThreadStatus(resume.threadId)).state === "running") {
      return finishIdle("IDLE_NO_HARVEST_SURPLUS", "The previous Sparkle interrupt is still settling.");
    }
    refresh();
    const blockedBeforeLaunch = idle();
    if (blockedBeforeLaunch) return { ...blockedBeforeLaunch, shieldAdvisories };
    if (live.poolError) throw live.poolError;
    const harvesting = harvestingPools();
    const route = routeTask(item.prompt, harvesting, { now, pacingConfig: this.config.pacing }).selected;
    if (!route) return finishIdle("IDLE_NO_HARVEST_SURPLUS", "No eligible route is available in the harvesting pools.");
    const pool = harvesting.find((entry) => entry.poolId === route.candidate.poolId && entry.providerInstanceId === route.candidate.providerInstanceId)!;
    const lease = createEpochLease(pool, now, this.config.pacing.epochSafetyMarginMins);
    if (!lease.hardDeadlineAt) return finishIdle("IDLE_NO_HARVEST_SURPLUS", "The harvesting pool has no verifiable reset deadline.");
    if (this.options.requireHumanSnapshot && Date.parse(lease.hardDeadlineAt) - now.getTime() <= T3_COMMAND_TIMEOUT_MS) {
      return finishIdle("IDLE_NO_HARVEST_SURPLUS", "There is too little time to start a live Sparkle before the lease deadline.");
    }
    const { threadId, branchName, scratchDir } = await this.options.adapter.launchSparkle({
      workspaceRoot: this.workspaceRoot, projectId: this.config.projectId, item, route, baseBranch: this.config.baseBranch,
      resume,
    });
    const launched: SparkleRunRecord = {
      runId: randomUUID(), itemId: item.id, itemTitle: item.title, mode: item.mode, threadId, branchName, scratchDir,
      poolId: pool.poolId, providerInstanceId: pool.providerInstanceId, driver: pool.driver, model: route.candidate.id,
      startedAt: now.toISOString(), endedAt: null, outcome: "running", stopReason: null, lease,
    };
    state.activeRun = launched;
    if (!state.pilotThreadIds.includes(threadId)) state.pilotThreadIds.push(threadId);
    try {
      this.persist(state, now);
    } catch (error) {
      try {
        await this.options.adapter.stopSparkle(threadId, "The Sparkle lease could not be saved.");
      } catch (stopError) {
        throw new AggregateError([error, stopError], "Could not save the Sparkle lease or interrupt its thread.");
      }
      throw error;
    }
    this.armDeadline(launched);

    // A command can return after the quota or human state changes while T3 is starting the turn.
    refresh();
    const epochCheck = this.checkLease(launched, live.pools, now);
    const launchStop = this.safetyStop(epochCheck, live);
    if (launchStop) {
      await this.interruptRun(launched, launchStop);
      const haltedRun = this.finishRun(state, launched, now, launchStop.outcome, launchStop.reason, launchStop.status, launchStop.detail);
      return result(launchStop.action, launchStop.detail, { launchedRun: launched, epochCheck, haltedRun, shieldAdvisories });
    }
    try {
      this.writeQueue(launched, "running", "");
    } catch (error) {
      const intent: StopIntent = {
        action: "HALTED_STATE_UNAVAILABLE", outcome: "halted_safety", reason: "SPARKLE_QUEUE_UNAVAILABLE",
        detail: "The Sparkle queue could not be updated.", status: "pending",
      };
      await this.interruptRun(launched, intent);
      this.finishRun(state, launched, now, intent.outcome, intent.reason, intent.status, intent.detail);
      throw error;
    }
    return result("SPARKLE_LAUNCHED", `Launched ${item.title}.`, { launchedRun: launched, epochCheck, shieldAdvisories });
  }

  private isPoolStale(pool: QuotaPoolSnapshot | undefined, now: Date): boolean {
    const maxMins = this.config.maxQuotaStalenessMins;
    if (!pool || maxMins === undefined || maxMins <= 0 || pool.source === "external-unmetered" || pool.source === "manual-override") {
      return false;
    }
    if (!pool.checkedAt) return true;
    const checkedMs = Date.parse(pool.checkedAt);
    return !Number.isFinite(checkedMs) || now.getTime() - checkedMs > maxMins * 60_000;
  }

  private checkLease(run: SparkleRunRecord, pools: QuotaPoolSnapshot[], now: Date): EpochCheckResult {
    const pool = pools.find((entry) => entry.poolId === run.poolId && entry.providerInstanceId === run.providerInstanceId);
    const usablePool = pool?.weeklyWindow && pool.source !== "unavailable" && !this.isPoolStale(pool, now) ? pool : null;
    return verifyEpochLease(run.lease, usablePool, now, this.config.pacing.reserveFloorPercent);
  }

  private epochStop(check: Pick<EpochCheckResult, "reason" | "detail">): StopIntent {
    return { action: "HALTED_EPOCH_LOCK", outcome: "halted_epoch_lock", reason: check.reason, detail: check.detail,
      status: this.config.requeueOnEpochHalt === false ? "halted" : "pending" };
  }

  private safetyStop(check: EpochCheckResult, live: ReturnType<PilotGovernor["readSnapshot"]>): StopIntent | undefined {
    if (!check.allowed) return this.epochStop(check);
    if (live.humanPreemption?.shouldPreempt) return {
      action: "PREEMPTED_BY_HUMAN", outcome: "preempted_human", reason: live.humanPreemption.state,
      detail: live.humanPreemption.reason, status: "pending",
    };
    if (live.snapshotError || (this.options.requireHumanSnapshot && !live.t3State)) return {
      action: "HALTED_STATE_UNAVAILABLE", outcome: "halted_safety", reason: "T3_STATE_UNAVAILABLE",
      detail: "T3 human activity could not be verified.", status: "pending",
    };
    return undefined;
  }

  private interruptRun(run: SparkleRunRecord, intent: StopIntent): Promise<void> {
    if (this.stopRequest?.runId !== run.runId) this.stopRequest = { runId: run.runId, intent };
    const request = this.stopRequest;
    return request.promise ??= this.options.adapter.stopSparkle(run.threadId, intent.detail).catch((error) => {
      request.promise = undefined;
      throw error;
    });
  }

  private finishRun(state: PilotRuntimeState, active: SparkleRunRecord, now: Date, outcome: SparkleRunRecord["outcome"],
    reason: string | null, status: SparkleItemStatus, note: string): SparkleRunRecord {
    const finished = { ...active, endedAt: now.toISOString(), outcome, stopReason: reason,
      ...(outcome === "halted_epoch_lock" && { requeue: status === "pending" }) };
    state.activeRun = null;
    state.history.push(finished);
    this.persist(state, now);
    this.armDeadline(null);
    if (this.stopRequest?.runId === active.runId) this.stopRequest = undefined;
    this.writeQueue(finished, status, note);
    return finished;
  }

  private writeQueue(run: SparkleRunRecord, status: SparkleItemStatus, note: string): void {
    if (!this.options.dryRun) updateSparkleStatusInMarkdown(this.paths.sparklesPath, run.itemId, {
      status, note, threadId: run.threadId, branchName: run.branchName,
    });
  }

  private async shieldAdvisories(state: PilotRuntimeState, live: ReturnType<PilotGovernor["readSnapshot"]>, now: Date): Promise<IdleThreadShieldAdvisory[]> {
    if (!live.t3State) return [];
    const owned = pilotOwnership(live.t3State, state.pilotThreadIds);
    const active = new Set(live.humanPreemption?.activeHumanRuns.map((run) => run.threadId));
    const advisories: IdleThreadShieldAdvisory[] = [];
    for (const thread of live.t3State.threads) {
      if (thread.archivedAt || thread.deletedAt || owned.has(thread.threadId) || active.has(thread.threadId)) continue;
      const blocked = live.pacing.find((pool) => pool.providerInstanceId === thread.providerInstanceId && pool.shieldLocked);
      if (!blocked) continue;
      const route = routeTask(thread.title || "general task", live.pools, { now, pacingConfig: this.config.pacing }).selected;
      let applied = false;
      if (route && this.config.autoConfigureIdleThreads && !this.options.dryRun && this.options.adapter.configureIdleThread) {
        try {
          const current = (this.options.readT3State ?? readPilotT3State)(this.paths.sqlitePath);
          if (current && !evaluateHumanPreemptionFromSnapshot(current, { now }).activeHumanRuns.some((run) => run.threadId === thread.threadId)) {
            applied = await this.options.adapter.configureIdleThread({ threadId: thread.threadId, route });
          }
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      advisories.push({ threadId: thread.threadId, threadTitle: thread.title, blockedPoolId: blocked.poolId, recommendedRoute: route, applied });
    }
    return advisories;
  }

  start(): void {
    if (this.enabled) return;
    const activeRun = this.runtimeState().activeRun;
    this.enabled = true;
    this.armDeadline(activeRun);
    const filename = basename(this.paths.sqlitePath);
    const sqliteNames = new Set([filename, `${filename}-wal`, `${filename}-journal`]);
    this.watchInputs(dirname(this.paths.sqlitePath), (changed) => {
      const matched = sqliteNames.has(changed);
      if (matched) this.watchSqliteFiles();
      return matched;
    });
    this.watchSqliteFiles();
    this.watchInputs(join(this.paths.t3Home, "caches"), (changed) => changed.endsWith(".json"));
    this.schedule(0);
  }

  private triggerSafetyCheck(): void {
    if (!this.enabled || this.safetyTimer) return;
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = undefined;
      this.checkOnInputChange();
    }, 25);
  }

  private watchSqliteFiles(): void {
    for (const target of [this.paths.sqlitePath, `${this.paths.sqlitePath}-wal`]) {
      if (!existsSync(target)) continue;
      let resolved: string;
      try {
        resolved = realpathSync(target);
      } catch {
        continue;
      }
      if (this.watchedFiles.has(resolved)) continue;
      try {
        const watcher = watch(resolved, (event) => {
          if (event === "rename") this.watchedFiles.delete(resolved);
          this.triggerSafetyCheck();
        });
        watcher.on("error", (error) => {
          this.watchedFiles.delete(resolved);
          this.options.onError?.(error);
        });
        this.watchedFiles.add(resolved);
        this.watchers.push(watcher);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private watchInputs(path: string, matches: (filename: string) => boolean): void {
    if (!existsSync(path)) return;
    try {
      const resolved = realpathSync(path);
      const watcher = watch(resolved, (_event, changed) => {
        if (!this.enabled || (changed && !matches(changed))) return;
        this.triggerSafetyCheck();
      });
      watcher.on("error", (error) => this.options.onError?.(error));
      this.watchers.push(watcher);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private checkOnInputChange(): void {
    try {
      const state = this.runtimeState();
      const run = state.activeRun;
      if (run) {
        const now = new Date();
        const live = this.readSnapshot(state, now);
        const intent = this.safetyStop(this.checkLease(run, live.pools, now), live);
        if (intent) void this.interruptRun(run, intent).catch((error) => this.options.onError?.(error));
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.schedule(0);
    }
  }

  monitorActiveRun(): Promise<void> {
    if (this.enabled) throw new Error("The Sparkle governor is already running.");
    if (!this.runtimeState().activeRun) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.monitoring = { resolve, reject };
      this.start();
    });
  }

  private schedule(delay: number): void {
    if (!this.enabled) return;
    if (this.polling) {
      this.pollRequested = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    this.timer = undefined;
    this.polling = true;
    this.pollRequested = false;
    try {
      const result = await this.runTick();
      if (this.monitoring && !result.activeRun) {
        this.endScheduling();
        this.monitoring.resolve();
        this.monitoring = undefined;
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.polling = false;
      this.schedule(this.pollRequested ? 0 : Math.max(1, this.config.tickIntervalMs));
    }
  }

  private armDeadline(run: SparkleRunRecord | null): void {
    if (run && this.deadline?.runId === run.runId) return;
    clearTimeout(this.deadline?.timer);
    this.deadline = undefined;
    if (!this.enabled || !run?.lease.hardDeadlineAt || this.stopRequest?.runId === run.runId) return;
    const deadline = Date.parse(run.lease.hardDeadlineAt);
    const delay = Math.min(2_147_483_647, Math.max(0, deadline - Date.now()));
    const timer = setTimeout(() => {
      this.deadline = undefined;
      if (!this.enabled) return;
      if (Date.now() < deadline) {
        this.armDeadline(run);
        return;
      }
      try {
        if (this.runtimeState().activeRun?.runId !== run.runId) {
          this.schedule(0);
          return;
        }
      } catch (error) {
        this.options.onError?.(error);
      }
      const intent = this.epochStop({ reason: "HARD_STOP_SAFETY_MARGIN", detail: "The leased reset safety deadline has been reached." });
      void this.interruptRun(run, intent).catch((error) => this.options.onError?.(error)).finally(() => this.schedule(0));
    }, delay);
    this.deadline = { runId: run.runId, timer };
  }

  private endScheduling(): void {
    this.enabled = false;
    clearTimeout(this.timer);
    clearTimeout(this.deadline?.timer);
    clearTimeout(this.safetyTimer);
    this.timer = undefined;
    this.deadline = undefined;
    this.safetyTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.watchedFiles.clear();
  }

  async stop(): Promise<void> {
    this.endScheduling();
    await this.tail;
    try {
      await this.withWorkspaceLock(async () => {
        const state = this.runtimeState();
        const active = state.activeRun;
        if (!active) return;
        const intent: StopIntent = this.stopRequest?.runId === active.runId ? this.stopRequest.intent : {
          action: "HALTED_STATE_UNAVAILABLE", outcome: "halted_safety", reason: "GOVERNOR_STOPPED",
          detail: "The Sparkle governor shut down.", status: "pending",
        };
        await this.interruptRun(active, intent);
        this.finishRun(state, active, new Date(), intent.outcome, intent.reason, intent.status, intent.detail);
      });
      this.monitoring?.resolve();
    } catch (error) {
      this.monitoring?.reject(error);
      throw error;
    } finally {
      this.monitoring = undefined;
    }
  }
}
