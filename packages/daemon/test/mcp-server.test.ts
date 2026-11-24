import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPilotMcpServer } from "../src/mcp-server.js";
import { PilotService } from "../src/service.js";
import { loadRuntimeState } from "../src/sparkle-queue.js";
import { createDefaultPilotConfig, initPilotWorkspace } from "../src/t3-installer.js";
import type { PilotStatusSummary, PilotSyncActionOutput } from "../src/types.js";
import { createQuotaHome, tempWorkspace } from "./fixtures.js";

let root: string;
let client: Client;
let server: ReturnType<typeof createPilotMcpServer>;

beforeEach(async () => {
  root = tempWorkspace();
  initPilotWorkspace({ workspaceRoot: root });
  const service = new PilotService({ workspaceRoot: root, config: createDefaultPilotConfig({ t3Home: createQuotaHome(root) }) });
  server = createPilotMcpServer(service);
  client = new Client({ name: "pilot-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function call<Result>(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  const content = result.content as { type: string; text: string }[];
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text) as Result;
}

describe("Pilot MCP end-to-end", () => {
  it("advertises all five tools and serves status, routing, and Sparkle additions through MCP", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(["pilot_route", "pilot_shield", "pilot_sparkle_add", "pilot_status", "pilot_sync"]);
    expect(await call<PilotStatusSummary>("pilot_status")).toMatchObject({ workspaceRoot: root,
      pools: [{ poolId: "codex", sessionWindow: { remainingPercent: 90 }, weeklyWindow: { remainingPercent: 80 } }],
      pacing: [{ harvestMode: "FULL_THROTTLE_HARVEST" }], humanPreemption: null, runtimeState: { version: 1, activeRun: null },
      shield: { mode: "guarded-turbo" },
    });
    expect(await call("pilot_route", { task: "Debug TypeScript parser tests" })).toMatchObject({
      category: "SYSTEMS_PARSERS_TESTS_DEBUGGING",
      manualOverride: false,
      selected: { candidate: { id: "gpt-6.2-sol", providerInstanceId: "codex_fixture" } },
    });
    // Verify MCP tool schema never exposes manualOverride to agents
    const routeTool = tools.find(({ name }) => name === "pilot_route");
    expect(routeTool?.inputSchema.properties).not.toHaveProperty("manualOverride");
    expect(await call("pilot_sparkle_add", { title: "Study agent timing", mode: "scratch", prompt: "Compare a few sessions." })).toMatchObject({
      added: { title: "Study agent timing", mode: "scratch", status: "pending", prompt: "Compare a few sessions." },
    });
    const status = await call<PilotStatusSummary>("pilot_status");
    expect(status.sparkles).toContainEqual(expect.objectContaining({ title: "Study agent timing", mode: "scratch" }));
  });

  it("exposes shield status and evaluation without a policy mutation action", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "pilot_shield")?.annotations?.readOnlyHint).toBe(true);
    const policy = await call("pilot_shield", { action: "status" });
    expect(policy).toMatchObject({ mode: "guarded-turbo", rules: expect.any(Array) });
    expect(await call("pilot_shield", { action: "check", command: "npm publish" })).toMatchObject({
      decision: "force_ask", matchedRuleId: "ask-package-publish",
    });
    expect(await call("pilot_shield", { action: "check", toolName: "Read", filePath: "~/.ssh/id_rsa" })).toMatchObject({
      decision: "deny", matchedRuleId: "deny-host-credentials",
    });
    expect((await client.callTool({ name: "pilot_shield", arguments: { action: "mode", mode: "off" } })).isError).toBe(true);
    expect(await call("pilot_shield", { action: "status" })).toEqual(policy);
  });

  it("previews by default, applies and records a snapshot, and rolls back through MCP", async () => {
    const target = join(root, ".codex", "config.toml");
    const planned = await call<PilotSyncActionOutput>("pilot_sync", { targets: ["codex"] });
    expect(planned).toMatchObject({ mode: "plan", result: { applied: false, changes: expect.arrayContaining([
      expect.objectContaining({ harness: "codex", action: "create", targetPath: target }),
    ]) } });
    expect(existsSync(target)).toBe(false);
    const applied = await call<PilotSyncActionOutput>("pilot_sync", { dryRun: false, targets: ["codex"] });
    expect(applied.mode).toBe("apply");
    const snapshotId = applied.result.snapshotId;
    expect(snapshotId).toEqual(expect.any(String));
    expect(existsSync(target)).toBe(true);
    expect(loadRuntimeState(root).lastSyncSnapshotId).toBe(snapshotId);
    expect(await call("pilot_sync", { rollbackSnapshotId: true })).toMatchObject({ mode: "rollback", result: { snapshotId, removedPaths: expect.arrayContaining([target]) } });
    expect(existsSync(target)).toBe(false);
  });
});
