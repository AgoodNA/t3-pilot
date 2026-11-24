import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { PilotMcpBackend } from "./types.js";

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createPilotMcpServer(backend: PilotMcpBackend): McpServer {
  const server = new McpServer({
    name: "t3-pilot",
    version: "0.1.0",
  });

  server.tool(
    "pilot_status",
    "Inspect live T3 Code 5-hour & 7-day quota pools, coupled 7d x 5h harvest mode, 20% emergency reserve shield, human preemption state, and Sparkle Queue.",
    {},
    async () => {
      const status = await backend.getStatus();
      return jsonResult(status);
    },
  );

  server.tool(
    "pilot_route",
    "Score and select the optimal AI model for a task based on Task-Affinity x Burnable Surplus x Reset Urgency while strictly enforcing the 20% reserve shield.",
    {
      task: z.string().min(1).describe("Task description or prompt summary to classify and route."),
    },
    async ({ task }) => {
      // Manual overrides are strictly reserved for human CLI usage (`t3-pilot route --manual-override`).
      const decision = await backend.routeTask(task, false);
      return jsonResult(decision);
    },
  );

  server.tool(
    "pilot_sparkle_add",
    "Append an exploratory idea or prototype task to SPARKLES.md so t3-pilot harvests expiring surplus quota safely in an isolated worktree or scratch folder.",
    {
      title: z.string().min(1).describe("Concise Sparkle idea title."),
      mode: z
        .enum(["worktree", "scratch"])
        .optional()
        .describe("Execution isolation mode: 'worktree' opens an isolated git branch; 'scratch' creates a standalone sandbox."),
      prompt: z
        .string()
        .optional()
        .describe("Optional expanded instructions appended for the Sparkle runner."),
    },
    async ({ title, mode, prompt }) => {
      const result = await backend.addSparkle({ title, mode, prompt });
      return jsonResult(result);
    },
  );

  server.tool(
    "pilot_shield",
    "Read the workspace Guarded Turbo policy or evaluate a proposed tool call.",
    {
      action: z.enum(["status", "check"]),
      toolName: z.string().trim().min(1).optional(),
      command: z.string().optional(),
      filePath: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ action, toolName, command, filePath }) => {
      if (action === "status") return jsonResult(backend.getShieldPolicy());
      if (!toolName && !command && !filePath) throw new Error("Provide a tool name, command, or file path to check.");
      return jsonResult(backend.checkShield({ toolName: toolName ?? (command ? "run_command" : "read_file"), command, filePath }));
    },
  );

  server.tool(
    "pilot_sync",
    "Preview (dryRun), apply, or roll back Skills, MCP and Guarded Turbo synchronization across Antigravity, Codex, and Claude Code.",
    {
      dryRun: z
        .boolean()
        .optional()
        .describe("Defaults to true (diff preview only). Set false to write synced files with atomic backup."),
      targets: z
        .array(z.enum(["antigravity", "codex", "claude-code"]))
        .optional()
        .describe("Subset of harnesses to sync; defaults to all configured targets."),
      rollbackSnapshotId: z
        .union([z.string().min(1), z.boolean()])
        .optional()
        .describe("Pass true to roll back the latest sync snapshot, or a specific snapshotId."),
    },
    async ({ dryRun, targets, rollbackSnapshotId }) => {
      const output = await backend.syncHarnesses({
        dryRun: rollbackSnapshotId ? undefined : (dryRun ?? true),
        targets,
        rollbackSnapshotId,
      });
      return jsonResult(output);
    },
  );

  return server;
}

export async function runPilotMcpStdioServer(backend: PilotMcpBackend): Promise<McpServer> {
  const server = createPilotMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
