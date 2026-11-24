import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadNodeSqlite, type QuotaPoolSnapshot } from "@t3-pilot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PilotGovernor } from "../src/governor.js";
import { loadRuntimeState, readSparklesQueue } from "../src/sparkle-queue.js";
import { DryRunT3ExecutionAdapter } from "../src/t3-adapter.js";
import { createDefaultPilotConfig } from "../src/t3-installer.js";
import type { PilotConfig, SparkleItem } from "../src/types.js";
import { at, baseTime, codexPool, hour, minute, tempWorkspace, window } from "./fixtures.js";

const { DatabaseSync } = loadNodeSqlite();
let root: string;
let sparklesPath: string;
let sqlitePath: string;
let db: InstanceType<typeof DatabaseSync> | undefined;
let pools: QuotaPoolSnapshot[];
let adapter: DryRunT3ExecutionAdapter;

beforeEach(() => {
  root = tempWorkspace();
  sparklesPath = join(root, "SPARKLES.md");
  sqlitePath = join(root, "t3-home", "userdata", "statev2.sqlite");
  writeFileSync(sparklesPath, "# Sparkle Queue\n\n- [ ] [worktree] Debug the TypeScript parser\n");
  pools = [codexPool()];
  adapter = new DryRunT3ExecutionAdapter();
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function governor(config: Partial<PilotConfig> = {}, options: Partial<ConstructorParameters<typeof PilotGovernor>[0]> = {}) {
  return new PilotGovernor({
    workspaceRoot: root, adapter, config: createDefaultPilotConfig({ t3Home: join(root, "t3-home"), ...config }),
    readPools: () => pools, ...options,
  });
}

function openFixture(replaceJournal = false): InstanceType<typeof DatabaseSync> {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  db = new DatabaseSync(sqlitePath);
  if (replaceJournal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, provider_instance_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT, child_thread_id TEXT);
  `);
  return db;
}

function putThread(id: string, title: string, provider = "codex_fixture") {
  db!.prepare("INSERT INTO projection_threads VALUES (?, ?, ?, '{}')").run(id, title, provider);
}

function putRun(id: string, status = "running") {
  db!.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, NULL)").run(`run-${id}`, id, status, baseTime.toISOString());
}

function settleRun(id: string, completedAt: Date) {
  db!.prepare("UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ? WHERE thread_id = ?").run(completedAt.toISOString(), id);
}

describe("harvest and Sparkle lifecycle", () => {
  it.each([
    { mode: "FULL_THROTTLE_HARVEST", sessionLeft: 3 * hour, weeklyLeft: 24 * hour, remaining: 80, action: "SPARKLE_LAUNCHED" },
    { mode: "EXPIRING_5H_HARVEST", sessionLeft: 20 * minute, weeklyLeft: 72 * hour, remaining: 90, action: "SPARKLE_LAUNCHED" },
    { mode: "PRESERVE_WINDOWS", sessionLeft: 3 * hour, weeklyLeft: 72 * hour, remaining: 90, action: "IDLE_NO_HARVEST_SURPLUS" },
    { mode: "LOCKED_SHIELD", sessionLeft: 20 * minute, weeklyLeft: 24 * hour, remaining: 20, action: "IDLE_NO_HARVEST_SURPLUS" },
  ])("handles $mode", async ({ mode, sessionLeft, weeklyLeft, remaining, action }) => {
    pools = [codexPool({ sessionWindow: window("session", 90, at(sessionLeft)), weeklyWindow: window("weekly", remaining, at(weeklyLeft)) })];
    const launch = vi.spyOn(adapter, "launchSparkle");
    const result = await governor().runTick(baseTime);
    expect(result).toMatchObject({ action, pacing: [{ harvestMode: mode }] });
    if (action === "SPARKLE_LAUNCHED") {
      expect(launch).toHaveBeenCalledTimes(1);
      expect(loadRuntimeState(root)).toMatchObject({ pilotThreadIds: ["dry-run-1"], activeRun: { threadId: "dry-run-1" } });
      expect(readSparklesQueue(sparklesPath)[0]).toMatchObject({ status: "running", threadId: "dry-run-1" });
    } else {
      expect(launch).not.toHaveBeenCalled();
      expect(readSparklesQueue(sparklesPath)[0]?.status).toBe("pending");
    }
  });

  it("routes strictly within harvesting pools", async () => {
    const gemini = {
      ...codexPool(), poolId: "antigravity-gemini", driver: "antigravity", providerInstanceId: "ag-fixture",
      sessionWindow: window("session", 80, at(20 * minute)), weeklyWindow: window("weekly", 90, at(72 * hour)),
    } as const;
    pools = [codexPool({ sessionWindow: window("session", 100, at(4 * hour)), weeklyWindow: window("weekly", 100, at(105 * hour)) }), gemini];
    const result = await governor().runTick(baseTime);
    expect(result).toMatchObject({ action: "SPARKLE_LAUNCHED", launchedRun: { poolId: "antigravity-gemini" } });
  });

  it("serializes simultaneous ticks and persists a completed run exactly once", async () => {
    const pilot = governor();
    const launch = vi.spyOn(adapter, "launchSparkle");
    const [first, second] = await Promise.all([pilot.runTick(baseTime), pilot.runTick(at(1))]);
    expect(first.action).toBe("SPARKLE_LAUNCHED");
    expect(second.action).toBe("SPARKLE_CONTINUING");
    expect(launch).toHaveBeenCalledTimes(1);
    adapter.setThreadStatus(first.activeRun!.threadId, "completed");
    const completed = await pilot.runTick(at(2));
    expect(completed).toMatchObject({ action: "SPARKLE_COMPLETED", activeRun: null });
    expect(readFileSync(sparklesPath, "utf8")).toContain("- [x] [worktree]");
    expect(loadRuntimeState(root)).toMatchObject({ activeRun: null, history: [{ endedAt: at(2).toISOString(), outcome: "completed" }] });
    expect((await pilot.runTick(at(3))).action).toBe("IDLE_QUEUE_EMPTY");
  });

  it("coordinates separate governors and recovers an abandoned workspace lock", async () => {
    const locks = join(root, ".t3-pilot", "governor-locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, "2147483647-00000000-0000-0000-0000-000000000000.lock"), "");
    const first = governor();
    const other = governor();
    const launch = adapter.launchSparkle.bind(adapter);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const launchSpy = vi.spyOn(adapter, "launchSparkle").mockImplementationOnce(async (request) => {
      enter();
      await proceed;
      return launch(request);
    });
    const waiting = first.runTick(baseTime);
    await entered;
    try {
      await expect(other.runTick(baseTime)).rejects.toThrow(/another sparkle governor/i);
    } finally {
      release();
    }
    expect((await waiting).action).toBe("SPARKLE_LAUNCHED");
    expect((await other.runTick(at(1))).action).toBe("SPARKLE_CONTINUING");
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(readdirSync(locks)).toEqual([]);
  });

  it.each(["failed", "stopped"] as const)("records a thread that becomes %s as failed", async (status) => {
    const pilot = governor();
    const result = await pilot.runTick(baseTime);
    adapter.setThreadStatus(result.activeRun!.threadId, status);
    const tick = await pilot.runTick(at(1));
    expect(tick).toMatchObject({ action: "HALTED_EPOCH_LOCK", activeRun: null, haltedRun: { outcome: "failed", stopReason: status } });
    expect(readSparklesQueue(sparklesPath)[0]?.status).toBe("failed");
    expect(readFileSync(sparklesPath, "utf8")).toContain("- [!]");
  });

  it("uses issue items after the local queue and remembers their status through restarts", async () => {
    const issue: SparkleItem = { id: "gh-7", source: "github-issue", mode: "worktree", status: "pending", title: "Issue idea", prompt: "Idea" };
    const external = { listSparkles: vi.fn().mockResolvedValue([issue]) };
    writeFileSync(sparklesPath, "# Queue\n- [x] Already done\n");
    const pilot = governor({}, { externalSource: external });
    const launched = await pilot.runTick(baseTime);
    expect(launched).toMatchObject({ action: "SPARKLE_LAUNCHED", activeRun: { itemId: "gh-7" } });
    adapter.setThreadStatus(launched.activeRun!.threadId, "completed");
    await pilot.runTick(at(1));
    const restarted = governor({}, { externalSource: external });
    expect((await restarted.runTick(at(2))).action).toBe("IDLE_QUEUE_EMPTY");
    expect(readFileSync(sparklesPath, "utf8")).toBe("# Queue\n- [x] Already done\n");
  });

  it("keeps dry runs in memory and leaves the queue and runtime state untouched", async () => {
    const initial = readFileSync(sparklesPath, "utf8");
    const pilot = governor({}, { dryRun: true });
    expect((await pilot.runTick(baseTime)).action).toBe("SPARKLE_LAUNCHED");
    expect((await pilot.runTick(at(1))).action).toBe("SPARKLE_CONTINUING");
    expect(readFileSync(sparklesPath, "utf8")).toBe(initial);
    expect(existsSync(join(root, ".t3-pilot"))).toBe(false);
  });
});

describe("epoch lock and reserve hard stops", () => {
  it("stops at exactly resetAt minus two minutes and requeues remaining work", async () => {
    const reset = 11 * minute;
    pools = [codexPool({ sessionWindow: window("session", 90, at(reset)) })];
    const pilot = governor();
    const stop = vi.spyOn(adapter, "stopSparkle");
    const { activeRun } = await pilot.runTick(baseTime);
    expect(activeRun?.lease.hardDeadlineAt).toBe(at(reset - 2 * minute).toISOString());
    expect((await pilot.runTick(at(reset - 2 * minute - 1))).action).toBe("SPARKLE_CONTINUING");
    expect(stop).not.toHaveBeenCalled();
    const halted = await pilot.runTick(at(reset - 2 * minute));
    expect(halted).toMatchObject({ action: "HALTED_EPOCH_LOCK", activeRun: null, epochCheck: { reason: "HARD_STOP_SAFETY_MARGIN" },
      haltedRun: { outcome: "halted_epoch_lock", stopReason: "HARD_STOP_SAFETY_MARGIN" } });
    expect(stop).toHaveBeenCalledExactlyOnceWith(activeRun!.threadId, expect.stringContaining("safety deadline"));
    expect(readSparklesQueue(sparklesPath)[0]).toMatchObject({ status: "pending", note: expect.stringContaining("safety deadline") });
  });

  it.each(["session", "weekly"] as const)("halts when the %s reset advances even when the new pool reports 100%% remaining", async (kind) => {
    const pilot = governor();
    const stop = vi.spyOn(adapter, "stopSparkle");
    const launch = vi.spyOn(adapter, "launchSparkle");
    const { activeRun } = await pilot.runTick(baseTime);
    pools[0] = { ...pools[0]!, [`${kind}Window`]: window(kind, 100, at(kind === "session" ? 8 * hour : 192 * hour)) };
    const reason = `HARD_STOP_${kind.toUpperCase()}_EPOCH_ADVANCED`;
    expect(await pilot.runTick(at(1))).toMatchObject({ action: "HALTED_EPOCH_LOCK", haltedRun: { stopReason: reason } });
    expect(stop).toHaveBeenCalledExactlyOnceWith(activeRun!.threadId, expect.stringContaining("changed"));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(["weekly", "session", "unavailable"] as const)("halts when the lease loses %s quota", async (kind) => {
    const pilot = governor({ requeueOnEpochHalt: false });
    const stop = vi.spyOn(adapter, "stopSparkle");
    await pilot.runTick(baseTime);
    if (kind === "unavailable") pools = [];
    else pools[0] = { ...pools[0]!, [`${kind}Window`]: { ...pools[0]![`${kind}Window`]!, remainingPercent: 20, usedPercent: 80 } };
    expect(await pilot.runTick(at(1))).toMatchObject({ action: "HALTED_EPOCH_LOCK", haltedRun: {
      stopReason: kind === "unavailable" ? "HARD_STOP_POOL_UNAVAILABLE" : "HARD_STOP_RESERVE_SHIELD",
    } });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(readSparklesQueue(sparklesPath)[0]?.status).toBe("halted");
  });

  it("interrupts at the deadline even when the periodic thread status command is still pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    pools = [codexPool({ sessionWindow: window("session", 90, at(2 * minute + 2000)) })];
    const pilot = governor({ tickIntervalMs: 30_000 });
    const launched = await pilot.runTick();
    let finishStatus: () => void = () => undefined;
    vi.spyOn(adapter, "getThreadStatus").mockImplementationOnce(() => new Promise((resolve) => {
      finishStatus = () => resolve({ threadId: launched.activeRun!.threadId, state: "running" });
    }));
    const stop = vi.spyOn(adapter, "stopSparkle");
    pilot.start();
    try {
      await vi.advanceTimersByTimeAsync(1999);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stop).toHaveBeenCalledExactlyOnceWith(launched.activeRun!.threadId, expect.stringContaining("safety deadline"));
      finishStatus();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadRuntimeState(root).history[0]?.stopReason).toBe("HARD_STOP_SAFETY_MARGIN");
    } finally {
      finishStatus();
      await pilot.stop();
    }
  });
});

describe("read-only human preemption and idle shield advisories", () => {
  it("ignores pilot runs and delegates, preempts for human activity, and resumes after fifteen minutes", async () => {
    openFixture();
    const pilot = governor({}, { requireHumanSnapshot: true });
    const first = await pilot.runTick(baseTime);
    const pilotId = first.activeRun!.threadId;
    putThread(pilotId, "Opaque T3 title");
    putRun(pilotId);
    putThread("pilot-child", "Delegate without a Sparkle title");
    putRun("pilot-child");
    db!.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('delegate', ?, 'pilot-child')").run(pilotId);
    expect(await pilot.runTick(at(minute))).toMatchObject({ action: "SPARKLE_CONTINUING", humanPreemption: { state: "CLEAR_FOR_PILOT" } });
    putThread("human", "Working on UI");
    putRun("human");
    const before = readFileSync(sqlitePath);
    const stop = vi.spyOn(adapter, "stopSparkle");
    const next = await pilot.runTick(at(2 * minute));
    expect(next).toMatchObject({ action: "PREEMPTED_BY_HUMAN", activeRun: null, haltedRun: { outcome: "preempted_human", stopReason: "PREEMPTED_ACTIVE_HUMAN_TURN" },
      humanPreemption: { activeHumanRuns: [{ threadId: "human" }] } });
    expect(stop).toHaveBeenCalledExactlyOnceWith(pilotId, "A human turn is active.");
    expect(readFileSync(sqlitePath)).toEqual(before);
    expect(readSparklesQueue(sparklesPath)[0]).toMatchObject({ status: "pending", note: "A human turn is active." });
    expect((await pilot.runTick(at(3 * minute))).action).toBe("YIELDED_TO_HUMAN");
    settleRun("human", at(4 * minute));
    expect(await pilot.runTick(at(19 * minute - 1))).toMatchObject({ action: "COOLDOWN_WAITING", humanPreemption: { resumeInMs: 1 } });
    expect(await pilot.runTick(at(19 * minute))).toMatchObject({ action: "SPARKLE_LAUNCHED", activeRun: { threadId: pilotId } });
  });

  it("reacts to a SQLite WAL write while the periodic status command is still pending", async () => {
    openFixture(true);
    const now = Date.now();
    pools = [codexPool({
      checkedAt: new Date(now).toISOString(),
      sessionWindow: window("session", 90, new Date(now + 3 * hour)),
      weeklyWindow: window("weekly", 85, new Date(now + 24 * hour)),
    })];
    const pilot = governor({ tickIntervalMs: 60_000 }, { requireHumanSnapshot: true });
    const launched = await pilot.runTick();
    let finishStatus: () => void = () => undefined;
    const status = vi.spyOn(adapter, "getThreadStatus").mockImplementationOnce(() => new Promise((resolve) => {
      finishStatus = () => resolve({ threadId: launched.activeRun!.threadId, state: "running" });
    }));
    const stop = vi.spyOn(adapter, "stopSparkle");
    pilot.start();
    try {
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
      putThread("human", "Active Human");
      putRun("human");
      await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(launched.activeRun!.threadId, "A human turn is active."));
      finishStatus();
      await vi.waitFor(() => expect(loadRuntimeState(root).history[0]).toMatchObject({ threadId: launched.activeRun!.threadId, outcome: "preempted_human" }), { timeout: 2500 });
    } finally {
      finishStatus();
      await pilot.stop();
    }
  });

  it("rechecks human activity when it changes during a T3 launch", async () => {
    openFixture();
    const launch = adapter.launchSparkle.bind(adapter);
    vi.spyOn(adapter, "launchSparkle").mockImplementationOnce(async (request) => {
      const result = await launch(request);
      putThread("human", "New human turn");
      putRun("human");
      return result;
    });
    const stop = vi.spyOn(adapter, "stopSparkle");
    expect(await governor().runTick(baseTime)).toMatchObject({
      action: "PREEMPTED_BY_HUMAN", activeRun: null,
      launchedRun: { threadId: "dry-run-1" }, haltedRun: { outcome: "preempted_human" },
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith("dry-run-1", "A human turn is active.");
    expect(readSparklesQueue(sparklesPath)[0]?.status).toBe("pending");
  });

  it("only recommends and configures idle human threads on shielded pools", async () => {
    openFixture();
    putThread("idle", "Build a dashboard");
    putThread("busy", "Editing a dashboard");
    putRun("busy");
    putThread("sparkle", "[Sparkle] Pilot-owned idle thread");
    putThread("elsewhere", "Healthy thread", "ag-fixture");
    pools = [
      codexPool({ weeklyWindow: window("weekly", 20, at(24 * hour)) }),
      { ...codexPool(), providerInstanceId: "ag-fixture", driver: "antigravity", poolId: "antigravity-gemini" },
    ];
    const configure = vi.fn().mockResolvedValue(true);
    const exec = { launchSparkle: adapter.launchSparkle.bind(adapter), getThreadStatus: adapter.getThreadStatus.bind(adapter),
      stopSparkle: adapter.stopSparkle.bind(adapter), configureIdleThread: configure };
    const advisory = await governor({}, { adapter: exec }).runTick(baseTime);
    expect(advisory.shieldAdvisories).toEqual([{ threadId: "idle", threadTitle: "Build a dashboard", blockedPoolId: "codex",
      recommendedRoute: expect.objectContaining({ candidate: expect.objectContaining({ poolId: "antigravity-gemini" }) }), applied: false }]);
    expect(configure).not.toHaveBeenCalled();
    const adjusted = await governor({ autoConfigureIdleThreads: true }, { adapter: exec }).runTick(baseTime);
    expect(adjusted).toMatchObject({ action: "YIELDED_TO_HUMAN", shieldAdvisories: [{ threadId: "idle", applied: true }] });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ threadId: "idle", route: adjusted.shieldAdvisories[0]?.recommendedRoute });
  });

  it("holds live launches when human activity cannot be verified", async () => {
    const launch = vi.spyOn(adapter, "launchSparkle");
    expect(await governor({}, { requireHumanSnapshot: true }).runTick(baseTime)).toMatchObject({
      action: "IDLE_NO_HARVEST_SURPLUS", detail: expect.stringContaining("human activity"),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses to launch and halts active Sparkles when cached quota telemetry exceeds maxQuotaStalenessMins", async () => {
    const pilot = governor({ maxQuotaStalenessMins: 30 });
    pools = [codexPool({ checkedAt: at(-31 * minute).toISOString() })];
    expect((await pilot.runTick(baseTime)).action).toBe("IDLE_NO_HARVEST_SURPLUS");

    pools = [codexPool({ checkedAt: baseTime.toISOString() })];
    const launched = await pilot.runTick(baseTime);
    expect(launched.action).toBe("SPARKLE_LAUNCHED");

    const stop = vi.spyOn(adapter, "stopSparkle");
    const staleTick = await pilot.runTick(at(31 * minute));
    expect(staleTick).toMatchObject({
      action: "HALTED_EPOCH_LOCK",
      haltedRun: { outcome: "halted_epoch_lock", stopReason: "HARD_STOP_POOL_UNAVAILABLE" },
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
