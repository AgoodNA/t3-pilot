import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { PilotService } from "../src/service.js";
import { loadRuntimeState } from "../src/sparkle-queue.js";
import { startPilotStatusServer } from "../src/status-http.js";
import { installPilotProjectScript, loadPilotConfig } from "../src/t3-installer.js";
import { DatabaseSync } from "node:sqlite";
import { createQuotaHome, tempWorkspace } from "./fixtures.js";

let root: string;
let home: string;

beforeEach(() => {
  root = tempWorkspace();
  home = createQuotaHome(root);
  vi.stubEnv("T3CODE_HOME", home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function invoke(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { cwd: root,
    stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

async function json(...args: string[]) {
  const result = await invoke(...args, "--json");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout);
}

describe("t3-pilot CLI", () => {
  it("reports help and version and rejects invalid flags and inputs", async () => {
    expect(await invoke("-h")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: t3-pilot"), stderr: "" });
    expect(await invoke("--version")).toMatchObject({ code: 0, stdout: "0.1.0\n", stderr: "" });
    expect(await invoke("init", "--port", "70000")).toMatchObject({ code: 1, stderr: expect.stringContaining("65535") });
    expect(await invoke("route", "--json")).toMatchObject({ code: 1, stderr: expect.stringContaining("Task is required") });
    expect(await invoke("sparkle", "add", "One", "--mode", "unknown")).toMatchObject({ code: 1, stderr: expect.stringContaining("Sparkle mode") });
    expect(await invoke("sync", "--diff", "--apply")).toMatchObject({ code: 1, stderr: expect.stringContaining("Choose one") });
  });

  it("initializes, preserves and force-refreshes a workspace and emits its Pilot script", async () => {
    const result = await json("init", "--port", "4900", "--project-id", "t3-project", "--base-branch", "trunk");
    expect(result).toMatchObject({ workspaceRoot: root, createdFiles: expect.arrayContaining([join(root, "SPARKLES.md")]),
      preservedFiles: [], pilotScript: { id: "pilot-cockpit", name: "Pilot", previewUrl: "http://127.0.0.1:4900" },
    });
    expect(loadPilotConfig(root)).toMatchObject({ projectId: "t3-project", cockpitPort: 4900, baseBranch: "trunk" });
    const queuePath = join(root, "SPARKLES.md");
    writeFileSync(queuePath, "# Personal notes\n");
    const again = await json("init");
    expect(again).toMatchObject({ createdFiles: [], preservedFiles: expect.arrayContaining([queuePath]) });
    expect(readFileSync(queuePath, "utf8")).toBe("# Personal notes\n");
    await json("init", "--force");
    expect(readFileSync(queuePath, "utf8")).toContain("Sparkle Queue");
  });

  it("reads status, routes, adds and lists Sparkles, and simulates both one-shot commands", async () => {
    await json("init");
    const status = await json("status");
    expect(status).toMatchObject({ workspaceRoot: root, pools: [{ poolId: "codex" }], pacing: [{ harvestMode: "FULL_THROTTLE_HARVEST" }] });
    expect(await json("route", "Debug", "parser", "tests", "--manual-override")).toMatchObject({
      task: "Debug parser tests", manualOverride: true, selected: { candidate: { id: "gpt-6.2-sol" } },
    });
    const added = await json("sparkle", "add", "Visual", "demo", "--mode", "scratch", "--prompt", "Make a small visual demo.");
    expect(added.added).toMatchObject({ title: "Visual demo", mode: "scratch", prompt: "Make a small visual demo.", status: "pending" });
    expect(await json("sparkle", "list")).toContainEqual(added.added);
    const queue = readFileSync(join(root, "SPARKLES.md"), "utf8");
    const first = await json("sparkle", "run-once", "--dry-run");
    expect(first).toMatchObject({ action: "SPARKLE_LAUNCHED", launchedRun: { threadId: "dry-run-1", mode: "scratch" } });
    expect(existsSync(first.launchedRun.scratchDir)).toBe(false);
    expect(await json("up", "--once", "--dry-run", "--port", "0", "--host", "127.0.0.1")).toMatchObject({ action: "SPARKLE_LAUNCHED" });
    expect(readFileSync(join(root, "SPARKLES.md"), "utf8")).toBe(queue);
    expect(existsSync(join(root, ".t3-pilot", "state.json"))).toBe(false);
  });

  it("safely previews sync by default, applies target filters and rolls back explicit and latest snapshots", async () => {
    await json("init");
    const config = join(root, ".codex", "config.toml");
    expect(await json("sync", "--diff", "--targets", "codex")).toMatchObject({ mode: "plan", result: { applied: false } });
    expect(await json("sync")).toMatchObject({ mode: "plan", result: { applied: false } });
    expect(existsSync(config)).toBe(false);
    const apply = await json("sync", "--apply", "--targets", "codex");
    expect(apply).toMatchObject({ mode: "apply", result: { applied: true, snapshotId: expect.any(String) } });
    expect(existsSync(config)).toBe(true);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(loadRuntimeState(root).lastSyncSnapshotId).toBe(apply.result.snapshotId);
    expect(await json("sync", "--rollback", apply.result.snapshotId)).toMatchObject({ mode: "rollback", result: { snapshotId: apply.result.snapshotId } });
    expect(existsSync(config)).toBe(false);
    const next = await json("sync", "--apply", "--targets", "codex");
    expect(await json("sync", "--rollback")).toMatchObject({ mode: "rollback", result: { snapshotId: next.result.snapshotId } });
  });

  it("restores harness files if runtime state cannot record the applied snapshot", async () => {
    await json("init");
    writeFileSync(join(root, ".t3-pilot", "state.json"), "invalid JSON");
    const result = await invoke("sync", "--apply", "--targets", "codex");
    expect(result.code).toBe(1);
    expect(existsSync(join(root, ".codex", "config.toml"))).toBe(false);
  });
});

describe("Pilot status HTTP", () => {
  it("serves health, live service status, the HTML preview and a 404 on an ephemeral port", async () => {
    await json("init");
    const service = new PilotService({ workspaceRoot: root });
    const running = await startPilotStatusServer({ port: 0, getStatus: () => service.getStatus() });
    try {
      expect(running.port).toBeGreaterThan(0);
      const health = await fetch(`${running.url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const status = await fetch(`${running.url}/api/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toMatchObject({ workspaceRoot: root, pacing: [{ harvestMode: "FULL_THROTTLE_HARVEST" }] });
      const html = await fetch(running.url);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      const body = await html.text();
      expect(body).toContain("Coupled 7d × 5h Governor");
      expect(body).toContain("FULL_THROTTLE_HARVEST");
      expect(body).toContain("90.0%");
      expect((await fetch(`${running.url}/missing`)).status).toBe(404);
    } finally {
      await running.close();
    }
    await expect(startPilotStatusServer({ host: "0.0.0.0", port: 0, getStatus: () => service.getStatus() }))
      .rejects.toThrow(/non-loopback/);
  });

  it("auto-discovers project in read-only statev2.sqlite and installs top-bar Pilot script via t3_project_update", async () => {
    const sqlitePath = join(home, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec("CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, scripts_json TEXT);");
    db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?)").run(
      "proj-auto-1",
      "demo",
      root,
      JSON.stringify([{ id: "existing-test", name: "Test", command: "npm test", icon: "test", runOnWorktreeCreate: false }]),
    );
    db.close();

    const acp = vi.fn().mockResolvedValue({ ok: true });
    const installed = await installPilotProjectScript({
      workspaceRoot: root,
      port: 4733,
      t3Home: home,
      acpMcpCall: acp,
    });
    expect(installed).toMatchObject({
      installed: true,
      projectId: "proj-auto-1",
      scripts: [
        expect.objectContaining({ id: "existing-test" }),
        expect.objectContaining({ id: "pilot-cockpit", name: "Pilot", previewUrl: "http://127.0.0.1:4733" }),
      ],
    });
    expect(acp).toHaveBeenCalledExactlyOnceWith("t3_project_update", {
      projectId: "proj-auto-1",
      scripts: installed.scripts,
    });
  });
});
