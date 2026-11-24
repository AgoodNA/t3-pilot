import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadNodeSqlite } from "@t3-pilot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { PilotService } from "../src/service.js";
import { loadRuntimeState } from "../src/sparkle-queue.js";
import { startPilotStatusServer } from "../src/status-http.js";
import { installPilotProjectScript, loadPilotConfig } from "../src/t3-installer.js";
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

async function invokeWithInput(args: string[], input = "") {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { cwd: root, stdin: Readable.from([input]),
    stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

const invoke = (...args: string[]) => invokeWithInput(args);

async function json(...args: string[]) {
  const result = await invoke(...args, "--json");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout);
}

describe("t3-pilot CLI", () => {
  it("reports help and version and rejects invalid flags and inputs", async () => {
    expect(await invoke("-h")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: t3-pilot"), stderr: "" });
    expect(await invoke("--version")).toMatchObject({ code: 0, stdout: "0.2.0\n", stderr: "" });
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
    expect(result.createdFiles).toContain(join(root, ".t3-pilot/shield.json"));
    expect(readFileSync(join(root, ".t3-pilot/skills/guarded-turbo/SKILL.md"), "utf8")).toContain("name: guarded-turbo");
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
    expect(status).toMatchObject({ workspaceRoot: root, pools: [{ poolId: "codex" }], pacing: [{ harvestMode: "FULL_THROTTLE_HARVEST" }],
      shield: { mode: "guarded-turbo", rules: expect.any(Array) },
    });
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

  it("reports, updates, and checks the shield policy and evaluates a hook payload on stdin", async () => {
    await json("init");
    expect(await json("shield", "status")).toMatchObject({ mode: "guarded-turbo", rules: expect.any(Array) });
    expect(await json("shield", "mode", "strict")).toMatchObject({ mode: "strict" });
    expect(await json("shield", "check", "--command", "touch local")).toMatchObject({ decision: "force_ask", matchedRuleId: null });
    expect(await json("shield", "toggle", "deny-destructive-delete", "--disable")).toMatchObject({
      rules: expect.arrayContaining([expect.objectContaining({ id: "deny-destructive-delete", enabled: false })]),
    });
    expect(await json("shield", "check", "--tool", "Bash", "--command", "rm -rf /")).toMatchObject({ decision: "force_ask", matchedRuleId: null });
    expect(await json("shield", "toggle", "deny-destructive-delete", "--enable", "--decision", "deny")).toMatchObject({
      rules: expect.arrayContaining([expect.objectContaining({ id: "deny-destructive-delete", enabled: true, decision: "deny" })]),
    });
    expect(await json("shield", "check", "--tool", "Read", "--path", "~/.ssh/id_rsa")).toMatchObject({ decision: "deny" });
    const evaluated = await invokeWithInput(["shield", "evaluate", "--harness", "claude-code"],
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm publish" } }));
    expect(evaluated).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(evaluated.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.any(String) },
    });
    expect(await invoke("shield", "toggle", "missing", "--disable")).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown") });
    expect(await invoke("shield", "toggle", "deny-host-credentials", "--enable", "--disable")).toMatchObject({ code: 1 });
    expect(await invoke("shield", "mode", "invalid")).toMatchObject({ code: 1 });
  });
});

describe("Pilot status HTTP", () => {
  it("validates and handles Cockpit actions and serves a built Cockpit with assets", async () => {
    await json("init");
    const service = new PilotService({ workspaceRoot: root });
    const staticDir = join(root, "apps/cockpit/dist");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), '<div id="cockpit"></div>');
    writeFileSync(join(staticDir, "assets", "main.js"), "export const cockpit = true;");
    symlinkSync(join(root, ".t3-pilot/shield.json"), join(staticDir, "assets", "private.json"));
    const running = await startPilotStatusServer({ port: 0, service, staticDir });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${running.url}/api/${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    try {
      const statusUrl = `${running.url}/api/status`;
      const status = await fetch(statusUrl);
      expect(status.status).toBe(200);
      const token = status.headers.get("x-pilot-token")!;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(await status.json()).toMatchObject({ pilotToken: token });
      const head = await fetch(statusUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("x-pilot-token")).toBe(token);
      expect(await head.text()).toBe("");

      const auth = { "x-pilot-token": token };
      const authorizedPost = (path: string, body: unknown, headers: Record<string, string> = {}) => post(path, body, { ...auth, ...headers });
      const action = async (path: string, body: unknown) => {
        const response = await authorizedPost(path, body);
        expect(response.status).toBe(200);
        return response.json();
      };

      const missing = await post("shield", { mode: "off" });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({ error: "Missing or invalid X-Pilot-Token header." });
      const wrongToken = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
      expect((await post("shield", { mode: "off" }, { "x-pilot-token": wrongToken })).status).toBe(403);
      // fetch replaces Host with the URL's host, so send the forwarded headers via node:http.
      const proxiedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const proxyRequest = request(`${running.url}/api/shield`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json", host: "preview.t3.gg", origin: "https://connect.t3.gg" },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
          response.once("error", reject);
        });
        proxyRequest.once("error", reject);
        proxyRequest.end(JSON.stringify({ mode: "guarded-turbo" }));
      });
      expect(proxiedStatus).toBe(200);

      expect(await (await fetch(running.url)).text()).toContain('<div id="cockpit">');
      const asset = await fetch(`${running.url}/assets/main.js`);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toBe("export const cockpit = true;");
      expect((await fetch(`${running.url}/assets/private.json`)).status).toBe(404);
      expect((await fetch(`${running.url}/api/shield`)).status).toBe(405);
      expect(await action("route", { task: "Debug parser tests" })).toMatchObject({ task: "Debug parser tests", manualOverride: false });
      expect(await action("sparkle", { title: "Check Cockpit", mode: "scratch", prompt: "Try it out" })).toMatchObject({
        added: { title: "Check Cockpit", mode: "scratch", prompt: "Try it out" },
      });
      expect(await action("shield", { mode: "strict", ruleId: "ask-package-publish", decision: "deny" })).toMatchObject({
        shield: { mode: "strict", rules: expect.arrayContaining([expect.objectContaining({ id: "ask-package-publish", decision: "deny" })]) },
      });
      expect(await action("shield", { check: { toolName: "run_command", command: "npm publish" } })).toMatchObject({
        shield: { mode: "strict" }, evaluation: { decision: "deny", matchedRuleId: "ask-package-publish" },
      });
      const invalid = await authorizedPost("shield", { mode: "off", ruleId: "unknown", enabled: false });
      expect(invalid.status).toBe(400);
      expect((await authorizedPost("shield", { mode: "off", check: { toolName: "Read" } })).status).toBe(400);
      expect((await authorizedPost("route", { task: "x".repeat(65_536) })).status).toBe(413);
      expect((await authorizedPost("route", { task: "" })).status).toBe(400);
      expect((await authorizedPost("route", { task: "test" }, { "content-type": "text/plain" })).status).toBe(415);
      const malformed = await fetch(`${running.url}/api/sync`, {
        method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{",
      });
      expect(malformed.status).toBe(400);
      expect((await (await fetch(`${running.url}/api/status`)).json()).shield.mode).toBe("strict");
      expect(await action("sync", { targets: ["codex"] })).toMatchObject({ mode: "plan", result: { applied: false } });
      const applied = await action("sync", { dryRun: false, targets: ["codex"] });
      expect(applied).toMatchObject({ mode: "apply", result: { applied: true, snapshotId: expect.any(String) } });
      expect(await action("sync", { rollbackSnapshotId: applied.result.snapshotId })).toMatchObject({ mode: "rollback" });
      expect(existsSync(join(root, ".codex", "rules", "t3-pilot-guarded-turbo.rules"))).toBe(false);
    } finally {
      await running.close();
    }
  });

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
    const { DatabaseSync } = loadNodeSqlite();
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
