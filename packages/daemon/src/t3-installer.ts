import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectT3State } from "@t3-pilot/core";
import { execCommand, type AcpMcpCall, type CommandRunner } from "./t3-adapter.js";
import type {
  PilotConfig,
  PilotInitOptions,
  PilotInitResult,
  T3ProjectScriptSpec,
} from "./types.js";

export const DEFAULT_COCKPIT_PORT = 4733;
export const PILOT_SCRIPT_ID = "pilot-cockpit";

export function createDefaultPilotConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return {
    version: 1,
    cooldownMinutes: 15,
    tickIntervalMs: 30_000,
    cockpitPort: DEFAULT_COCKPIT_PORT,
    baseBranch: "main",
    maxQuotaStalenessMins: 60,
    pacing: {
      reserveFloorPercent: 20,
      singleWindowCapacityPercent: 14,
      fullThrottleRatioThreshold: 0.85,
      expiringSessionThresholdMins: 45,
      epochSafetyMarginMins: 2,
    },
    syncTargets: ["antigravity", "codex", "claude-code"],
    ...overrides,
  };
}

export function buildPilotProjectScript(options: { port?: number } = {}): T3ProjectScriptSpec {
  const port = options.port ?? DEFAULT_COCKPIT_PORT;
  return {
    id: PILOT_SCRIPT_ID,
    name: "Pilot",
    command: `npx t3-pilot up --port ${port}`,
    icon: "play",
    runOnWorktreeCreate: false,
    autoOpenPreview: true,
    previewUrl: `http://127.0.0.1:${port}`,
    async: true,
  };
}

export function mergeProjectScripts(
  existingScripts: readonly T3ProjectScriptSpec[],
  pilotScript: T3ProjectScriptSpec = buildPilotProjectScript(),
): T3ProjectScriptSpec[] {
  const index = existingScripts.findIndex((script) => script.id === pilotScript.id || script.name === pilotScript.name);
  if (index === -1) {
    return [...existingScripts, pilotScript];
  }
  const updated = [...existingScripts];
  updated[index] = pilotScript;
  return updated;
}

const DEFAULT_SPARKLES_MD = `# Sparkle Queue ✨

Drop wild brainstorms, prototypes, or cleanup ideas below. \`t3-pilot\` only runs these using **expiring surplus quota** above your 20% reserve floor, yields immediately if you start using T3 Code, and hard-stops before quota reset so 0% of your fresh cycle is ever touched.

- [ ] [scratch] Prototype an interactive visual timeline of multi-agent token burn vs git commits
`;

const DEFAULT_SAMPLE_SKILL_MD = `---
name: pilot-autopilot
description: >-
  Guides quota-aware model routing, 20% emergency reserve shield checks, Sparkle Queue idea capture,
  and cross-harness Skills/MCP synchronization in T3 Code workspaces via t3-pilot.
---

# t3-pilot Autopilot Workflow

1. Call \`pilot_status\` (or run \`npx t3-pilot status\`) before launching multi-agent batches to inspect live 5-hour and 7-day quota pools, \`resetAt\` countdowns, and coupled \`7d x 5h\` harvest modes.
2. Call \`pilot_route\` with a task summary to select the highest-affinity model above the 20% weekly & session reserve floor, then apply \`t3ThreadConfigurePayload\` only on idle threads between turns.
3. Capture exploratory prototypes or backlog ideas with \`pilot_sparkle_add\` (\`worktree\` for isolated git branches, \`scratch\` for standalone demos) so expiring quota harvests them safely.
4. Preview cross-harness changes with \`pilot_sync\` (\`dryRun: true\`) before syncing skills and MCP configs across Antigravity, Codex, and Claude Code.
`;

export function initPilotWorkspace(options: PilotInitOptions): PilotInitResult {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cockpitPort = options.cockpitPort ?? DEFAULT_COCKPIT_PORT;
  const config = createDefaultPilotConfig({
    ...(options.projectId ? { projectId: options.projectId } : {}),
    cockpitPort,
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
  });

  const configPath = join(workspaceRoot, ".t3-pilot", "config.json");
  const sparklesPath = join(workspaceRoot, "SPARKLES.md");
  const mcpConfigPath = join(workspaceRoot, ".t3-pilot", "mcp.json");
  const sampleSkillPath = join(workspaceRoot, ".t3-pilot", "skills", "pilot-autopilot", "SKILL.md");

  const defaultMcp = {
    mcpServers: {
      "t3-pilot": {
        command: "npx",
        args: ["t3-pilot", "mcp"],
      },
    },
  };

  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];

  const writeIfMissing = (targetPath: string, content: string) => {
    if (existsSync(targetPath) && !options.force) {
      preservedFiles.push(targetPath);
      return;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, "utf8");
    createdFiles.push(targetPath);
  };

  writeIfMissing(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeIfMissing(sparklesPath, DEFAULT_SPARKLES_MD);
  writeIfMissing(mcpConfigPath, `${JSON.stringify(defaultMcp, null, 2)}\n`);
  writeIfMissing(sampleSkillPath, DEFAULT_SAMPLE_SKILL_MD);

  const pilotScript = buildPilotProjectScript({ port: cockpitPort });
  return {
    workspaceRoot,
    configPath,
    sparklesPath,
    mcpConfigPath,
    sampleSkillPath,
    pilotScript,
    ...(options.projectId ? { resolvedProjectId: options.projectId } : {}),
    createdFiles,
    preservedFiles,
  };
}

export interface InstallPilotScriptOptions {
  workspaceRoot: string;
  projectId?: string;
  port?: number;
  t3Home?: string;
  acpMcpCall?: AcpMcpCall;
  execCommand?: CommandRunner;
}

export async function installPilotProjectScript(
  options: InstallPilotScriptOptions,
): Promise<{ installed: boolean; projectId?: string; scripts: T3ProjectScriptSpec[] }> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const t3Home = options.t3Home ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const sqlitePath = join(t3Home, "userdata", "statev2.sqlite");
  let projectId = options.projectId;
  let existingScripts: T3ProjectScriptSpec[] = [];

  if (existsSync(sqlitePath)) {
    try {
      const state = inspectT3State(sqlitePath);
      const match = state.projects.find((project) =>
        (projectId && project.projectId === projectId) || resolve(project.workspaceRoot) === workspaceRoot);
      if (match) {
        projectId ??= match.projectId;
        if (match.scriptsJson) {
          const parsed: unknown = JSON.parse(match.scriptsJson);
          if (Array.isArray(parsed)) existingScripts = parsed as T3ProjectScriptSpec[];
        }
      }
    } catch {
      // Proceed gracefully if SQLite state cannot be read.
    }
  }

  const pilotScript = buildPilotProjectScript({ port: options.port });
  const scripts = mergeProjectScripts(existingScripts, pilotScript);
  const run = options.execCommand ?? execCommand;
  const node = process.env.T3_ACP_MCP_NODE;
  const entrypoint = process.env.T3_ACP_MCP_ENTRYPOINT;
  const acp = options.acpMcpCall ?? (node ? async (tool: string, args: Record<string, unknown>) => {
    const { stdout } = await run(node, [...(entrypoint ? [entrypoint] : []), "acp-mcp-call", tool, JSON.stringify(args)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: t3Home },
    });
    return JSON.parse(stdout.trim()) as unknown;
  } : undefined);

  if (!projectId || !acp) {
    return { installed: false, ...(projectId ? { projectId } : {}), scripts };
  }

  try {
    const raw = await acp("t3_project_update", { projectId, scripts }) as Record<string, unknown> | null;
    if (raw?.isError || raw?.error) {
      return { installed: false, projectId, scripts };
    }
    return { installed: true, projectId, scripts };
  } catch {
    return { installed: false, projectId, scripts };
  }
}

export function loadPilotConfig(workspaceRoot: string): PilotConfig {
  const configPath = join(resolve(workspaceRoot), ".t3-pilot", "config.json");
  if (!existsSync(configPath)) {
    return createDefaultPilotConfig();
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<PilotConfig>;
  const defaults = createDefaultPilotConfig();
  return {
    ...defaults,
    ...parsed,
    pacing: {
      ...defaults.pacing,
      ...parsed.pacing,
    },
    syncTargets: parsed.syncTargets ?? defaults.syncTargets,
  };
}
