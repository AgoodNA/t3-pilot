import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySync, planSync, rollbackSync } from "../src/sync-engine.js";
import type { CanonicalMcpConfig } from "../src/types.js";

const workspaceFixture = new URL("./fixtures/pilot-workspace/.t3-pilot/", import.meta.url);
let root: string;
const read = (path: string, from = root) => readFileSync(join(from, path), "utf8");
const exists = (path: string, from = root) => existsSync(join(from, path));
const write = (path: string, content: string | Buffer, from = root) => {
  const dest = join(from, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
};
const setMcp = (mcpServers: CanonicalMcpConfig["mcpServers"]) => {
  write(".t3-pilot/mcp.json", JSON.stringify({ mcpServers }));
};
const marker = "# >>> t3-pilot managed mcp start >>>";
const endMarker = "# <<< t3-pilot managed mcp end <<<";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pilot-sync-"));
  cpSync(workspaceFixture, join(root, ".t3-pilot"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cross-harness sync", () => {
  it("plans deterministic context-bearing unified diffs without modifying disk", () => {
    const path = ".agents/skills/quota-guard/SKILL.md";
    write(path, read(".t3-pilot/skills/quota-guard/SKILL.md").replace("Quota Guard Skill", "Old heading"));
    const options = { workspaceRoot: root, targets: ["antigravity"] as const, dryRun: true };
    const original = read(path);
    const plan = planSync(options);
    expect(applySync(options)).toEqual(plan);
    expect(planSync(options)).toEqual(plan);
    expect(plan).toMatchObject({
      applied: false, discoveredSkills: ["quota-guard"], discoveredMcpServers: ["fetch", "t3-pilot-tools"],
    });
    expect(plan.changes.find(({ targetPath }) => targetPath === join(root, path))).toMatchObject({
      action: "update", unifiedDiff: expect.stringContaining(
        "--- a/.agents/skills/quota-guard/SKILL.md\n+++ b/.agents/skills/quota-guard/SKILL.md\n",
      ),
    });
    expect(plan.changes.find(({ targetPath }) => targetPath === join(root, path))?.unifiedDiff)
      .toContain("-# Old heading\n+# Quota Guard Skill\n \n Monitors session");
    expect(read(path)).toBe(original);
    expect(exists(".agents/mcp_config.json")).toBe(false);
    expect(exists(".t3-pilot/backups")).toBe(false);
    expect(exists(".t3-pilot/sync-manifest.json")).toBe(false);
  });

  it("compiles skills and HTTP/stdio MCP across all three harnesses", () => {
    setMcp({
      docs: { url: "https://example.test/mcp" },
      helper: { command: "node", args: ["mcp.mjs", 'say "hello"'], env: { "MY.TOKEN": "value" } },
    });
    const script = ".t3-pilot/skills/quota-guard/scripts/check.sh";
    chmodSync(join(root, script), 0o755);
    const result = applySync({ workspaceRoot: root });
    expect(result.applied).toBe(true);
    expect(result.snapshotId).toBeDefined();
    for (const harness of [".agents", ".codex", ".claude"]) {
      expect(read(`${harness}/skills/quota-guard/SKILL.md`)).toBe(read(".t3-pilot/skills/quota-guard/SKILL.md"));
      const destination = `${harness}/skills/quota-guard/scripts/check.sh`;
      expect(read(destination)).toBe(read(script));
      expect(statSync(join(root, destination)).mode & 0o777).toBe(0o755);
    }
    expect(read(".codex/skills/quota-guard/agents/openai.yaml")).toContain(
      'interface:\n  display_name: "quota-guard"\n  short_description: "Cross-harness quota monitoring and emergency safety skill"',
    );
    expect(JSON.parse(read(".agents/mcp_config.json")).mcpServers).toMatchObject({
      docs: { url: "https://example.test/mcp" }, helper: { command: "node", env: { "MY.TOKEN": "value" } },
    });
    expect(JSON.parse(read(".mcp.json")).mcpServers).toMatchObject({
      docs: { type: "http", url: "https://example.test/mcp" }, helper: { type: "stdio", command: "node" },
    });
    expect(read(".codex/config.toml")).toContain('[mcp_servers.docs]\nurl = "https://example.test/mcp"');
    expect(read(".codex/config.toml")).toContain('env = { "MY.TOKEN" = "value" }');
    expect(planSync({ workspaceRoot: root }).changes.every(({ action, unifiedDiff }) =>
      action === "unchanged" && unifiedDiff === "")).toBe(true);
  });

  it("preserves user entries and removes only formerly managed MCP keys", () => {
    const userServer = { command: "my-fetch", args: ["--user"] };
    write(".agents/mcp_config.json", JSON.stringify({ other: true, mcpServers: { fetch: userServer } }));
    write(".mcp.json", JSON.stringify({ mcpServers: { fetch: { type: "stdio", ...userServer } } }));
    const codex = 'model = "user-model"\r\nsandbox_mode = "read-only"\r\n[mcp_servers."fetch"]\r\ncommand = "my-fetch"';
    write(".codex/config.toml", codex);
    const first = applySync({ workspaceRoot: root });
    expect(first.warnings).toHaveLength(3);
    expect(read(".codex/config.toml")).toContain(codex + "\r\n" + marker);
    expect(read(".codex/config.toml").match(/\[mcp_servers\."?fetch"?\]/g)).toHaveLength(1);
    expect(JSON.parse(read(".agents/mcp_config.json"))).toMatchObject({ other: true, mcpServers: { fetch: userServer } });

    setMcp({ telemetry: { url: "https://example.test/telemetry" } });
    applySync({ workspaceRoot: root, targets: ["antigravity", "claude-code", "codex"] });
    expect(JSON.parse(read(".agents/mcp_config.json")).mcpServers).toEqual({
      fetch: userServer, telemetry: { url: "https://example.test/telemetry" },
    });
    expect(JSON.parse(read(".mcp.json")).mcpServers).toEqual({
      fetch: { type: "stdio", ...userServer }, telemetry: { type: "http", url: "https://example.test/telemetry" },
    });
    expect(read(".codex/config.toml")).toContain("[mcp_servers.telemetry]");
    expect(read(".codex/config.toml")).not.toContain("[mcp_servers.t3-pilot-tools]");
  });

  it("replaces only the managed TOML block and honors source-provided Codex agents metadata", () => {
    const head = 'model = "user-model"\n';
    const tail = '[profiles.custom]\nmodel = "custom-model"\n';
    const previous = `${head}${marker}\n[mcp_servers.old]\ncommand = "old"\n${endMarker}\n${tail}`;
    write(".codex/config.toml", previous);
    const data = 'interface:\n  display_name: "My own name"\n';
    write(".t3-pilot/skills/quota-guard/agents/openai.yaml", data);
    const result = applySync({ workspaceRoot: root, targets: ["codex"] });
    const output = read(".codex/config.toml");
    expect(output.startsWith(head + marker)).toBe(true);
    expect(output.endsWith(endMarker + "\n" + tail)).toBe(true);
    expect(output).not.toContain("[mcp_servers.old]");
    expect(read(".codex/skills/quota-guard/agents/openai.yaml")).toBe(data);
    rollbackSync(root, result.snapshotId);
    expect(read(".codex/config.toml")).toBe(previous);
    expect(exists(".codex/skills")).toBe(false);
    expect(exists(".agents")).toBe(false);
  });

  it("rolls back content, permissions and new files with no snapshot ID, even in a separate target", () => {
    const target = join(root, "target");
    const config = '{ "mcpServers": {"manual":{"command":"hello"}} }\r\n';
    write(".mcp.json", config, target);
    chmodSync(join(target, ".mcp.json"), 0o640);
    const doc = ".t3-pilot/skills/quota-guard/resources/binary.dat";
    const data = Buffer.from([0, 255, 13, 10, 129]);
    write(doc, data);
    const before = Buffer.from([128, 129, 2]);
    const resourcePath = ".claude/skills/quota-guard/resources/binary.dat";
    write(resourcePath, before, target);

    const result = applySync({ workspaceRoot: root, targetRoot: target });
    expect(readFileSync(join(target, resourcePath))).toEqual(data);
    expect(result.changes.find(({ targetPath }) => targetPath === join(target, resourcePath))?.unifiedDiff)
      .toContain("Binary files");
    expect(exists(".t3-pilot/sync-manifest.json", target)).toBe(true);
    expect(rollbackSync(root).snapshotId).toBe(result.snapshotId);
    expect(read(".mcp.json", target)).toBe(config);
    expect(statSync(join(target, ".mcp.json")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(target, resourcePath))).toEqual(before);
    expect(exists(".codex", target)).toBe(false);
    expect(exists(".agents", target)).toBe(false);
    expect(exists(".t3-pilot", target)).toBe(false);
    expect(exists(".t3-pilot/mcp.json")).toBe(true);
  });

  it("rejects malformed markers before creating a snapshot or changing any target", () => {
    const config = `model = "user"\n${marker}\n`;
    write(".codex/config.toml", config);
    expect(() => applySync({ workspaceRoot: root })).toThrow(/markers/);
    expect(read(".codex/config.toml")).toBe(config);
    expect(exists(".agents")).toBe(false);
    expect(exists(".t3-pilot/backups")).toBe(false);
  });

  it("does not follow a harness path symlink outside the target", () => {
    const outside = join(root, "user-files");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".agents"), "dir");
    expect(() => applySync({ workspaceRoot: root })).toThrow(/symbolic link/);
    expect(exists("mcp_config.json", outside)).toBe(false);
  });
});
