#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { SyncHarnessTarget } from "@t3-pilot/core";
import { runPilotMcpStdioServer } from "./mcp-server.js";
import { PilotService } from "./service.js";
import { startPilotStatusServer } from "./status-http.js";
import { initPilotWorkspace, installPilotProjectScript } from "./t3-installer.js";
import type { PilotSyncActionOutput, SparkleExecutionMode } from "./types.js";

export interface PilotCliIO {
  cwd?: string;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
}

const help = `Usage: t3-pilot <command> [options]

  init [--port <n>] [--project-id <id>] [--base-branch <ref>] [--no-install-script] [--force] [--json]
  status [--json]
  route <task...> [--manual-override] [--json]
  up [--once] [--dry-run] [--port <n>] [--host <ip>] [--allow-remote] [--json]
  sparkle list [--json]
  sparkle add <title...> [--mode worktree|scratch] [--prompt <text>] [--json]
  sparkle run-once [--dry-run] [--json]
  sync [--diff | --apply | --rollback [snapshotId]] [--targets a,b] [--json]
  mcp
  --help, -h
  --version, -v
`;

const boolean = { type: "boolean" } as const;
const string = { type: "string" } as const;
const jsonOptions = { json: boolean };
const runOptions = { ...jsonOptions, "dry-run": boolean };
const syncTargets = new Set<string>(["antigravity", "codex", "claude-code"]);

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65_535) throw new Error("Port must be an integer from 0 to 65535.");
  return port;
}

function requiredText(values: string[], label: string): string {
  const text = values.join(" ").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function describeSync(output: PilotSyncActionOutput): string {
  if (output.mode === "rollback") return `Rolled back sync snapshot ${output.result.snapshotId}.`;
  const diffs = output.result.changes.map((change) => change.unifiedDiff).filter(Boolean);
  const heading = output.mode === "apply" ? "Sync applied." : "Sync preview.";
  const snapshot = output.result.snapshotId ? ` Snapshot ${output.result.snapshotId}.` : "";
  return [heading + snapshot, ...(output.result.warnings ?? []), ...diffs].join("\n");
}

function shutdownSignal() {
  let handler: () => void;
  const received = new Promise<void>((resolve) => { handler = resolve; });
  process.once("SIGINT", handler!);
  process.once("SIGTERM", handler!);
  return {
    received,
    dispose: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

export async function runCli(argv: string[], io: PilotCliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const workspaceRoot = io.cwd ?? process.cwd();
  const [command, ...args] = argv;
  const print = (json: boolean | undefined, result: unknown, description: string) => {
    stdout.write(`${json ? JSON.stringify(result, null, 2) : description}\n`);
  };
  const onError = (error: unknown) => stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);

  try {
    if (!command || command === "--help" || command === "-h") {
      stdout.write(help);
      return 0;
    }
    if (command === "--version" || command === "-v") {
      const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      stdout.write(`${version}\n`);
      return 0;
    }
    if (command === "init") {
      const { values } = parseArgs({
        args,
        options: { ...jsonOptions, port: string, "project-id": string, "base-branch": string, "no-install-script": boolean, force: boolean },
      });
      const port = parsePort(values.port);
      const installResult = values["no-install-script"]
        ? { installed: false, projectId: values["project-id"] }
        : await installPilotProjectScript({ workspaceRoot, projectId: values["project-id"], port });
      const result = initPilotWorkspace({
        workspaceRoot, cockpitPort: port, projectId: installResult.projectId ?? values["project-id"],
        baseBranch: values["base-branch"], force: values.force,
      });
      const fullResult = { ...result, scriptInstalled: installResult.installed };
      print(values.json, fullResult, `Initialized t3-pilot in ${result.workspaceRoot}.`);
      return 0;
    }
    const service = new PilotService({ workspaceRoot });
    const runOnce = async (dryRun: boolean | undefined, json: boolean | undefined) => {
      const governor = service.createGovernor({ dryRun, onError });
      const signal = dryRun ? undefined : shutdownSignal();
      try {
        const tick = await governor.runTick();
        print(json, tick, `${tick.action} · ${tick.detail}`);
        if (signal && tick.activeRun) {
          try {
            await Promise.race([governor.monitorActiveRun(), signal.received]);
          } finally {
            await governor.stop();
          }
        }
      } finally {
        signal?.dispose();
      }
    };
    switch (command) {
      case "status": {
        const { values } = parseArgs({ args, options: jsonOptions });
        const status = await service.getStatus();
        const summary = status.pacing.map((pool) => `${pool.poolId} · ${pool.harvestMode} · ${pool.effectiveBurnablePercent.toFixed(1)}% burnable`);
        print(values.json, status, [
          ...summary, status.humanPreemption?.reason ?? "T3 human activity data unavailable.",
          `${status.sparkles.filter((item) => item.status === "pending").length} pending Sparkles`,
          status.runtimeState.activeRun ? `Running ${status.runtimeState.activeRun.itemTitle}` : "No active Sparkle",
        ].join("\n"));
        break;
      }
      case "route": {
        const { values, positionals } = parseArgs({ args, options: { ...jsonOptions, "manual-override": boolean }, allowPositionals: true });
        const result = await service.routeTask(requiredText(positionals, "Task"), values["manual-override"]);
        const candidate = result.selected?.candidate;
        print(values.json, result, [candidate ? `${candidate.id} · ${candidate.providerInstanceId}` : "No eligible model route.", ...result.warnings].join("\n"));
        break;
      }
      case "up": {
        const { values } = parseArgs({ args, options: { ...runOptions, once: boolean, port: string, host: string, "allow-remote": boolean } });
        const port = parsePort(values.port) ?? service.config.cockpitPort;
        if (values.once) {
          await runOnce(values["dry-run"], values.json);
          break;
        }
        const governor = service.createGovernor({ dryRun: values["dry-run"], onError });
        const status = await startPilotStatusServer({
          port, host: values.host, allowRemote: values["allow-remote"], getStatus: () => service.getStatus(),
        });
        const signal = shutdownSignal();
        try {
          governor.start();
          print(values.json, { url: status.url, host: status.host, port: status.port }, `Pilot cockpit running at ${status.url}`);
          await signal.received;
        } finally {
          signal.dispose();
          try {
            await governor.stop();
          } finally {
            await status.close();
          }
        }
        break;
      }
      case "sparkle": {
        const [subcommand, ...sparkleArgs] = args;
        if (subcommand === "list") {
          const { values } = parseArgs({ args: sparkleArgs, options: jsonOptions });
          const queue = await service.listSparkles();
          print(values.json, queue, queue.map((item) => `${item.status} · ${item.mode} · ${item.title}`).join("\n") || "The Sparkle queue is empty.");
        } else if (subcommand === "add") {
          const { values, positionals } = parseArgs({ args: sparkleArgs, options: { ...jsonOptions, mode: string, prompt: string }, allowPositionals: true });
          const mode = values.mode;
          if (mode !== undefined && mode !== "worktree" && mode !== "scratch") throw new Error("Sparkle mode must be worktree or scratch.");
          const result = await service.addSparkle({ title: requiredText(positionals, "Sparkle title"), mode: mode as SparkleExecutionMode | undefined, prompt: values.prompt });
          print(values.json, result, `Added ${result.added.title}.`);
        } else if (subcommand === "run-once") {
          const { values } = parseArgs({ args: sparkleArgs, options: runOptions });
          await runOnce(values["dry-run"], values.json);
        } else {
          throw new Error("Expected sparkle list, add, or run-once.");
        }
        break;
      }
      case "sync": {
        const { values, positionals } = parseArgs({ args, options: { ...jsonOptions, diff: boolean, apply: boolean, rollback: boolean, targets: string }, allowPositionals: true });
        if ([values.diff, values.apply, values.rollback].filter(Boolean).length > 1) throw new Error("Choose one of --diff, --apply, or --rollback.");
        if (positionals.length > (values.rollback ? 1 : 0)) throw new Error("Only --rollback accepts a snapshot ID.");
        const targets = values.targets?.split(",").map((target) => target.trim());
        if (targets?.some((target) => !syncTargets.has(target))) throw new Error("Sync targets are antigravity, codex, and claude-code.");
        const result = await service.syncHarnesses({
          dryRun: !values.apply, targets: targets as SyncHarnessTarget[] | undefined,
          rollbackSnapshotId: values.rollback ? positionals[0] ?? true : undefined,
        });
        print(values.json, result, describeSync(result));
        break;
      }
      case "mcp": {
        parseArgs({ args, options: {} });
        await runPilotMcpStdioServer(service);
        break;
      }
      default:
        throw new Error(`Unknown command ${command}. Run t3-pilot --help for usage.`);
    }
    return 0;
  } catch (error) {
    onError(error);
    return 1;
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
