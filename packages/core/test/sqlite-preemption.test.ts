import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectHumanActivity, evaluateHumanPreemptionFromSnapshot } from "../src/human-preemption.js";
import { inspectT3State, openReadOnlyT3Database } from "../src/sqlite-inspector.js";

let directory: string;
let path: string;
let writable: DatabaseSync;
const requested = "2026-11-23T18:00:00.000Z";
const completed = "2026-11-23T18:05:00.000Z";
const now = new Date("2026-11-23T18:10:00Z");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pilot-sqlite-"));
  path = join(directory, "state #?.sqlite");
  writable = new DatabaseSync(path);
  writable.exec(`
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, scripts_json TEXT);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, latest_user_message_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, provider_instance_id TEXT,
      runtime_mode TEXT, interaction_mode TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT,
      deleted_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_instance_id TEXT,
      status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY, thread_id TEXT, child_thread_id TEXT, origin TEXT, status TEXT
    );
    INSERT INTO projection_projects VALUES ('project', 'Pilot Tests', '/tmp/workspace', '[]');
  `);
});

afterEach(() => {
  writable.close();
  rmSync(directory, { recursive: true, force: true });
});

function thread(id: string, title: string, payload: object = {}) {
  writable.prepare(`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, payload_json)
    VALUES (?, 'project', ?, 'codex', 'codex_user', 'full-access', 'default', ?)
  `).run(id, title, JSON.stringify(payload));
}

function run(threadId: string, status: string, completedAt: string | null = null) {
  writable.prepare(`
    INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at)
    VALUES (?, ?, 1, 'codex', 'codex_user', ?, ?, ?)
  `).run(`run-${threadId}`, threadId, status, requested, completedAt);
}

function child(parent: string, childThread: string) {
  writable.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, ?, 'delegate', 'running')")
    .run(`${parent}-${childThread}`, parent, childThread);
}

describe("read-only T3 SQLite preemption", () => {
  it("opens a URI-safe filename and rejects writes even if query_only is disabled", () => {
    const db = openReadOnlyT3Database(path);
    try {
      expect(db.prepare("PRAGMA query_only").get()?.query_only).toBe(1);
      expect(db.prepare("SELECT title FROM projection_projects").get()?.title).toBe("Pilot Tests");
      expect(() => db.exec("INSERT INTO projection_projects VALUES ('intruder', NULL, NULL, NULL)")).toThrow(/readonly/i);
      db.exec("PRAGMA query_only = OFF");
      expect(() => db.exec("CREATE TABLE forbidden (id INTEGER)")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
    expect(() => openReadOnlyT3Database(join(directory, "absent.sqlite"))).toThrow();
  });

  it("reads v2 projections and immediately reports an active human turn", () => {
    thread("human", "Alice's thread");
    run("human", "In_Progress");
    expect(inspectT3State(path)).toMatchObject({
      projects: [{ projectId: "project", workspaceRoot: "/tmp/workspace", scriptsJson: "[]" }],
      threads: [{ threadId: "human", defaultProvider: "codex", providerInstanceId: "codex_user" }],
      runs: [{ runId: "run-human", ordinal: 1, status: "In_Progress" }],
    });
    expect(detectHumanActivity(path, { now })).toMatchObject({
      shouldPreempt: true, state: "PREEMPTED_ACTIVE_HUMAN_TURN", resumeInMs: 900_000,
      activeHumanRuns: [{ runId: "run-human", threadTitle: "Alice's thread" }],
    });
  });

  it("resolves pilot ownership transitively through thread payloads and subagent relationships", () => {
    for (const [id, title, payload] of [
      ["sparkle", "[Sparkle] one", {}], ["listed", "Opaque", {}], ["pilot", "[t3-pilot] job", {}],
      ["origin", "Job", { createdBy: "pilot" }], ["payload-child", "Job", { delegatedFrom: { threadId: "origin" } }],
      ["child", "Delegate", {}], ["grandchild", "Delegate", {}],
    ] as const) {
      thread(id, title, payload);
      run(id, "running");
    }
    child("payload-child", "child");
    child("child", "grandchild");
    child("grandchild", "child");
    const snapshot = inspectT3State(path);
    expect(evaluateHumanPreemptionFromSnapshot(snapshot, { now, pilotThreadIds: new Set(["listed"]) })).toMatchObject({
      shouldPreempt: false, state: "CLEAR_FOR_PILOT", activeHumanRuns: [],
    });
    expect(evaluateHumanPreemptionFromSnapshot(snapshot, { now, pilotThreadIds: ["listed"], pilotTitlePrefixes: ["[pilot]"] }))
      .toMatchObject({ activeHumanRuns: [{ threadId: "sparkle" }, { threadId: "pilot" }] });
  });

  it("treats unfinished unknown statuses as active, including runs without a projected thread", () => {
    run("unprojected", "resuming");
    run("failed", "FAILED");
    expect(detectHumanActivity(path, { now, cooldownMinutes: 2 })).toMatchObject({
      shouldPreempt: true, activeHumanRuns: [{ threadId: "unprojected", threadTitle: "unprojected" }], resumeInMs: 120_000,
    });
  });

  it("counts down from the latest human completion and resumes at exactly fifteen minutes", () => {
    thread("human", "Human");
    run("human", "completed", completed);
    expect(detectHumanActivity(path, { now })).toMatchObject({
      shouldPreempt: true, state: "COOLDOWN_AFTER_HUMAN_TURN", resumeInMs: 600_000,
      lastHumanActivityAt: completed, resumeAvailableAt: "2026-11-23T18:20:00.000Z",
    });
    expect(detectHumanActivity(path, { now: new Date("2026-11-23T18:20:00Z") })).toMatchObject({
      shouldPreempt: false, state: "CLEAR_FOR_PILOT", resumeInMs: 0,
    });
  });

  it("uses the legacy thread projection and preserves newer user-message timestamps alongside v2", () => {
    thread("human", "v2 title");
    run("human", "completed", completed);
    writable.exec(`INSERT INTO projection_threads VALUES
      ('human', 'project', 'old title', '2026-11-23T18:09:00.000Z'),
      ('legacy', 'project', 'legacy thread', '2026-11-23T18:08:00.000Z');`);
    expect(inspectT3State(path).threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "legacy", title: "legacy thread" }),
      expect.objectContaining({ threadId: "human", title: "v2 title" }),
    ]));
    expect(detectHumanActivity(path, { now })).toMatchObject({
      lastHumanActivityAt: "2026-11-23T18:09:00.000Z", resumeInMs: 840_000,
    });
    writable.exec("DROP TABLE orchestration_v2_projection_threads");
    expect(inspectT3State(path).threads).toContainEqual(expect.objectContaining({ threadId: "human", title: "old title" }));
  });
});
