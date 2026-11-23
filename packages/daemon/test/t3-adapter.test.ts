import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliT3ExecutionAdapter, DryRunT3ExecutionAdapter } from "../src/t3-adapter.js";
import type { LaunchSparkleRequest } from "../src/types.js";
import { fixtureRoute, tempWorkspace } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = tempWorkspace();
  vi.stubEnv("T3_ACP_MCP_NODE", undefined);
  vi.stubEnv("T3_ACP_MCP_ENTRYPOINT", undefined);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function request(mode: "worktree" | "scratch" = "worktree"): LaunchSparkleRequest {
  const route = fixtureRoute();
  route.t3ThreadConfigurePayload.modelSelection.options = { effort: "high", enabled: true };
  return {
    workspaceRoot: root, projectId: "project-id", baseBranch: "origin/main", route,
    item: { mode, id: "s-1", title: "Café & ../ tools!", prompt: "Build the tools.\nAdd tests.", status: "pending", source: "sparkles-md" },
  };
}

const options = ["--provider", "codex_fixture", "--model", "gpt-6.2-sol", "--option", "effort=high", "--option", "enabled=true"];

describe("CLI execution adapter", () => {
  it("launches a worktree with explicit provider, options, base, and a safe branch", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"threadId":"worktree-thread"}\n' });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec });
    await expect(adapter.launchSparkle(request())).resolves.toEqual({ threadId: "worktree-thread", branchName: "sparkle/s-1-cafe-tools", scratchDir: null });
    expect(exec).toHaveBeenCalledExactlyOnceWith("t3", [
      "thread", "start", "project-id", "Build the tools.\nAdd tests.", "--title", "[Sparkle] Café & ../ tools!", ...options,
      "--worktree", "origin/main", "--branch", "sparkle/s-1-cafe-tools", "--json",
    ], { cwd: root });
  });

  it("creates a Scratch README and passes the Scratch directory to the CLI when ACP is unavailable", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "  scratch-thread\n" });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec });
    const scratchDir = join(root, ".t3-pilot", "scratch", "s-1-cafe-tools");
    await expect(adapter.launchSparkle(request("scratch"))).resolves.toEqual({ threadId: "scratch-thread", scratchDir, branchName: null });
    expect(readFileSync(join(scratchDir, "README.md"), "utf8")).toBe("# [Sparkle] Café & ../ tools!\n\nBuild the tools.\nAdd tests.\n");
    expect(exec).toHaveBeenNthCalledWith(1, "t3", ["project", "add", scratchDir, "--title", "[Sparkle] Café & ../ tools!"], { cwd: scratchDir });
    expect(exec).toHaveBeenNthCalledWith(2, "t3", [
      "thread", "start", scratchDir, "Build the tools.\nAdd tests.", "--title", "[Sparkle] Café & ../ tools!", ...options, "--json",
    ], { cwd: scratchDir });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("passes prompts beginning with a dash through stdin instead of treating them as flags", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"threadId":"from-stdin"}' });
    const launch = request();
    launch.item.prompt = "- Build a quick demo";
    await new CliT3ExecutionAdapter({ execCommand: exec }).launchSparkle(launch);
    expect(exec).toHaveBeenCalledExactlyOnceWith("t3", [
      "thread", "start", "project-id", "-", "--title", "[Sparkle] Café & ../ tools!", ...options,
      "--worktree", "origin/main", "--branch", "sparkle/s-1-cafe-tools", "--json",
    ], { cwd: root, input: launch.item.prompt });
  });

  it("uses the ACP scratch tool with the routed model and reads an MCP envelope", async () => {
    const exec = vi.fn();
    const acp = vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"id":"acp-thread"}' }] });
    const launch = request("scratch");
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec, acpMcpCall: acp });
    const result = await adapter.launchSparkle(launch);
    expect(result).toMatchObject({ threadId: "acp-thread", branchName: null });
    expect(existsSync(join(result.scratchDir!, "README.md"))).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(acp).toHaveBeenCalledExactlyOnceWith("t3_thread_launch", {
      title: "[Sparkle] Café & ../ tools!", scratch: true, message: launch.item.prompt,
      modelSelection: launch.route.t3ThreadConfigurePayload.modelSelection,
    });
  });

  it.each([
    ["running", "running"], ["starting", "running"], ["queued", "running"], ["waiting", "running"], ["preparing", "running"],
    ["completed", "completed"], ["idle", "completed"], ["settled", "completed"],
    ["cancelled", "stopped"], ["interrupted", "stopped"], ["stopped", "stopped"], ["failed", "failed"], ["error", "failed"],
  ])("maps T3 status %s to %s", async (status, state) => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ thread: { status } }) });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec });
    await expect(adapter.getThreadStatus("thread-test")).resolves.toEqual({ threadId: "thread-test", state });
    expect(exec).toHaveBeenCalledExactlyOnceWith("t3", ["thread", "show", "thread-test", "--json"], {});
  });

  it("terminates a tracked child and interrupts T3 before clearing the local process", async () => {
    const kill = vi.fn().mockReturnValue(true);
    const exec = vi.fn().mockResolvedValue({ stdout: '{"id":"active"}', child: { exitCode: null, signalCode: null, kill } });
    const acp = vi.fn().mockResolvedValue({ structuredContent: { status: "interrupt_requested" } });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec, acpMcpCall: acp });
    await adapter.launchSparkle(request());
    await adapter.stopSparkle("active", "end of lease");
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(acp).toHaveBeenCalledExactlyOnceWith("t3_thread_interrupt", { threadId: "active", stop: true, reason: "end of lease" });
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(acp.mock.invocationCallOrder[0]!);
  });

  it("uses the supplied ACP environment entrypoint and reports bridge errors", async () => {
    vi.stubEnv("T3_ACP_MCP_NODE", "/fixture/electron");
    vi.stubEnv("T3_ACP_MCP_ENTRYPOINT", "/fixture/cli.js");
    const exec = vi.fn().mockResolvedValueOnce({ stdout: '{"ok":true}' }).mockResolvedValueOnce({ stdout: '{"isError":true}' });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec });
    const route = fixtureRoute();
    await expect(adapter.configureIdleThread({ threadId: "idle", route })).resolves.toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, "/fixture/electron", [
      "/fixture/cli.js", "acp-mcp-call", "t3_thread_configure", JSON.stringify({ threadId: "idle", ...route.t3ThreadConfigurePayload }),
    ], { env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) });
    await expect(adapter.stopSparkle("another", "human active")).rejects.toThrow(/could not stop/i);
  });

  it("resumes the prior checkout, configuring an updated route before sending", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"threadId":"paused"}' });
    const acp = vi.fn().mockResolvedValue({});
    const launch = request();
    launch.resume = { threadId: "paused", branchName: "sparkle/existing", scratchDir: null, providerInstanceId: "old", model: "old-model" };
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec, acpMcpCall: acp });
    await expect(adapter.launchSparkle(launch)).resolves.toMatchObject({ threadId: "paused", branchName: "sparkle/existing" });
    expect(acp).toHaveBeenCalledExactlyOnceWith("t3_thread_configure", { threadId: "paused", ...launch.route.t3ThreadConfigurePayload });
    expect(exec).toHaveBeenCalledExactlyOnceWith("t3", ["thread", "send", "paused", launch.item.prompt, "--json"], { cwd: root });
  });

  it("reports an unavailable idle configure and blocks live launch when no interrupt transport exists", async () => {
    const exec = vi.fn();
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec, requireInterrupt: true });
    await expect(adapter.configureIdleThread({ threadId: "idle", route: fixtureRoute() })).resolves.toBe(false);
    await expect(adapter.launchSparkle(request())).rejects.toThrow(/interrupt bridge/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("cleans up an unleased orphan Sparkle thread when launch output is malformed", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "{malformed" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ id: "orphan-1", title: "[Sparkle] Café & ../ tools!" }]),
      });
    const acp = vi.fn().mockResolvedValue({ ok: true });
    const adapter = new CliT3ExecutionAdapter({ execCommand: exec, acpMcpCall: acp });
    await expect(adapter.launchSparkle(request())).rejects.toThrow(/malformed/);
    expect(acp).toHaveBeenCalledExactlyOnceWith("t3_thread_interrupt", {
      threadId: "orphan-1",
      stop: true,
      reason: expect.stringContaining("orphan Sparkle"),
    });
  });

  it("simulates launch, interruption and completion entirely in memory", async () => {
    const adapter = new DryRunT3ExecutionAdapter();
    const { threadId, scratchDir } = await adapter.launchSparkle(request("scratch"));
    expect(existsSync(scratchDir!)).toBe(false);
    await expect(adapter.getThreadStatus(threadId)).resolves.toMatchObject({ state: "running" });
    await adapter.stopSparkle(threadId, "epoch ended");
    await expect(adapter.getThreadStatus(threadId)).resolves.toMatchObject({ state: "stopped", summary: "epoch ended" });
    adapter.setThreadStatus(threadId, "completed");
    await expect(adapter.getThreadStatus(threadId)).resolves.toMatchObject({ state: "completed" });
  });
});
