import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IdleThreadReconfigureRequest, LaunchSparkleRequest, LaunchSparkleResult, SparkleThreadStatus, T3ExecutionAdapter,
} from "./types.js";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface CommandResult {
  stdout: string;
  child?: Pick<ChildProcess, "kill" | "exitCode" | "signalCode">;
}

export type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
export type AcpMcpCall = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
export const T3_COMMAND_TIMEOUT_MS = 15_000;

export function execCommand(command: string, args: string[], { input, ...options }: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: T3_COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}

export interface CliT3ExecutionAdapterOptions {
  execCommand?: CommandRunner;
  acpMcpCall?: AcpMcpCall;
  t3Home?: string;
  requireInterrupt?: boolean;
}

function safeSlug(raw: string, fallback: string, maxLength: number): string {
  return raw.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength).replace(/-+$/, "") || fallback;
}

function sparkleSlug(request: LaunchSparkleRequest): string {
  return `${safeSlug(request.item.id, "item", 48)}-${safeSlug(request.item.title, "sparkle", 60)}`;
}

function parseOutput(stdout: string): unknown {
  const value = stdout.trim();
  try {
    return JSON.parse(value);
  } catch {
    if (/^[^\s"{}[\]]+$/.test(value)) return value;
    throw new Error("T3 returned malformed output.");
  }
}

function payload(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function acpResult(raw: unknown): unknown {
  const result = payload(raw);
  if (result.isError || result.error || result.ok === false || raw === false) throw new Error("The T3 MCP tool reported an error.");
  if (result.structuredContent) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const value = result.content.find((item) => item?.type === "text" && typeof item.text === "string");
    if (value) {
      try {
        return JSON.parse(value.text);
      } catch {
        return value.text.trim();
      }
    }
  }
  return raw;
}

function threadIdFrom(raw: unknown): string {
  const result = payload(raw);
  const id = typeof raw === "string" ? raw : result.threadId ?? result.id;
  if (typeof id !== "string" || !id.trim() || /\s/.test(id.trim())) throw new Error("T3 did not return a thread ID.");
  return id.trim();
}

const statusMap = new Map<string, SparkleThreadStatus["state"]>([
  ...["running", "starting", "queued", "waiting", "preparing", "pending", "in_progress", "interrupt_requested"].map((key) => [key, "running"] as const),
  ...["completed", "idle", "settled", "succeeded"].map((key) => [key, "completed"] as const),
  ...["cancelled", "canceled", "interrupted", "stopped", "rolled_back"].map((key) => [key, "stopped"] as const),
  ...["failed", "error", "errored"].map((key) => [key, "failed"] as const),
]);

export class CliT3ExecutionAdapter implements T3ExecutionAdapter {
  private readonly run: CommandRunner;
  private readonly acp?: AcpMcpCall;
  private readonly commandOptions: CommandOptions;
  private readonly children = new Map<string, NonNullable<CommandResult["child"]>>();

  constructor(private readonly options: CliT3ExecutionAdapterOptions = {}) {
    this.run = options.execCommand ?? execCommand;
    this.commandOptions = options.t3Home ? { env: { ...process.env, T3CODE_HOME: options.t3Home } } : {};
    const node = process.env.T3_ACP_MCP_NODE;
    const entrypoint = process.env.T3_ACP_MCP_ENTRYPOINT;
    this.acp = options.acpMcpCall ?? (node ? async (tool, args) => {
      const { stdout } = await this.run(node, [...(entrypoint ? [entrypoint] : []), "acp-mcp-call", tool, JSON.stringify(args)], {
        env: { ...(this.commandOptions.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
      });
      return parseOutput(stdout);
    } : undefined);
  }

  get canInterrupt(): boolean {
    return this.acp !== undefined;
  }

  async launchSparkle(request: LaunchSparkleRequest): Promise<LaunchSparkleResult> {
    if (this.options.requireInterrupt && !this.canInterrupt) {
      throw new Error("Live Sparkles require the T3 ACP MCP interrupt bridge (T3_ACP_MCP_NODE).");
    }
    const { item, route, workspaceRoot } = request;
    const title = `[Sparkle] ${item.title}`;
    const { modelSelection } = route.t3ThreadConfigurePayload;
    const cliPrompt = item.prompt.startsWith("-") ? "-" : item.prompt;
    const promptOptions = cliPrompt === "-" ? { ...this.commandOptions, input: item.prompt } : this.commandOptions;
    const worktree = item.mode === "worktree";
    const slug = sparkleSlug(request);
    const branchName = worktree ? request.resume?.branchName ?? `sparkle/${slug}` : null;
    const scratchDir = worktree ? null : request.resume?.scratchDir ?? request.scratchDir ?? join(workspaceRoot, ".t3-pilot", "scratch", slug);
    if (request.resume) {
      const { threadId } = request.resume;
      if (request.resume.model !== modelSelection.model || request.resume.providerInstanceId !== modelSelection.instanceId) {
        if (!await this.configureIdleThread({ threadId, route })) throw new Error("The T3 ACP MCP bridge is required to reroute a paused Sparkle.");
      }
      const { child } = await this.run("t3", ["thread", "send", threadId, cliPrompt, "--json"], { ...promptOptions, cwd: workspaceRoot });
      this.trackChild(threadId, child);
      return { threadId, branchName, scratchDir };
    }
    if (scratchDir) {
      await mkdir(scratchDir, { recursive: true });
      try {
        await writeFile(join(scratchDir, "README.md"), `# ${title}\n\n${item.prompt}\n`, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (this.acp) {
        const result = acpResult(await this.acp("t3_thread_launch", { title, scratch: true, message: item.prompt, modelSelection }));
        return { threadId: threadIdFrom(result), branchName, scratchDir };
      }
      // CLI paths can resolve to an enclosing project, so register the scratch root explicitly.
      await this.run("t3", ["project", "add", scratchDir, "--title", title], { ...this.commandOptions, cwd: scratchDir });
    }

    const target = scratchDir ?? request.projectId ?? workspaceRoot;
    const args = ["thread", "start", target, cliPrompt,
      "--title", title, "--provider", modelSelection.instanceId, "--model", modelSelection.model];
    for (const [key, value] of Object.entries(modelSelection.options ?? {})) args.push("--option", `${key}=${value}`);
    if (branchName) args.push("--worktree", request.baseBranch, "--branch", branchName);
    let result: CommandResult;
    let threadId: string;
    try {
      result = await this.run("t3", [...args, "--json"], { ...promptOptions, cwd: scratchDir ?? workspaceRoot });
      threadId = threadIdFrom(parseOutput(result.stdout));
    } catch (error) {
      await this.cleanupOrphanLaunch(target, title);
      throw error;
    }
    this.trackChild(threadId, result.child);
    return { threadId, branchName, scratchDir };
  }

  private async cleanupOrphanLaunch(projectTarget: string, expectedTitle: string): Promise<void> {
    if (!this.acp) return;
    try {
      const { stdout } = await this.run("t3", ["thread", "list", "--project", projectTarget, "--json"], this.commandOptions);
      const parsed = parseOutput(stdout);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(payload(parsed).threads) ? payload(parsed).threads as unknown[] : []);
      for (const entry of list) {
        const item = payload(entry);
        const id = typeof item.threadId === "string" ? item.threadId : (typeof item.id === "string" ? item.id : null);
        if (id && item.title === expectedTitle) {
          await this.stopSparkle(id, "Cleaning up unleased orphan Sparkle after launch failure.");
          break;
        }
      }
    } catch {
      // Best-effort orphan cleanup; preserve original launch error.
    }
  }

  private trackChild(threadId: string, child: CommandResult["child"]): void {
    if (child) this.children.set(threadId, child);
  }

  async getThreadStatus(threadId: string): Promise<SparkleThreadStatus> {
    const { stdout } = await this.run("t3", ["thread", "show", threadId, "--json"], this.commandOptions);
    const result = payload(parseOutput(stdout));
    const thread = payload(result.thread);
    const run = payload(result.activeRun ?? thread.activeRun ?? result.latestRun ?? thread.latestRun);
    const status = run.status ?? result.status ?? result.state ?? thread.status ?? thread.state;
    const state = typeof status === "string" ? statusMap.get(status.trim().toLowerCase()) : undefined;
    if (!state) throw new Error(`T3 did not return a recognized status for thread ${threadId}.`);
    if (state !== "running") this.children.delete(threadId);
    return { threadId, state, ...(typeof result.summary === "string" && { summary: result.summary }) };
  }

  async stopSparkle(threadId: string, reason: string): Promise<void> {
    const child = this.children.get(threadId);
    const errors: unknown[] = [];
    let signalled = false;
    if (child && child.exitCode == null && child.signalCode == null) {
      try {
        signalled = child.kill("SIGTERM");
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.acp) {
      try {
        acpResult(await this.acp("t3_thread_interrupt", { threadId, stop: true, reason }));
      } catch (error) {
        errors.push(error);
      }
    } else if (!signalled) {
      errors.push(new Error("Interrupting a live Sparkle requires the T3 ACP MCP bridge."));
    }
    if (errors.length) throw new AggregateError(errors, `Could not stop Sparkle thread ${threadId}.`);
    this.children.delete(threadId);
  }

  async configureIdleThread({ threadId, route }: IdleThreadReconfigureRequest): Promise<boolean> {
    if (!this.acp) return false;
    acpResult(await this.acp("t3_thread_configure", { threadId, ...route.t3ThreadConfigurePayload }));
    return true;
  }
}

export class DryRunT3ExecutionAdapter implements T3ExecutionAdapter {
  private readonly threads = new Map<string, SparkleThreadStatus>();
  private nextId = 0;

  async launchSparkle(request: LaunchSparkleRequest): Promise<LaunchSparkleResult> {
    const slug = sparkleSlug(request);
    const threadId = request.resume?.threadId ?? `dry-run-${++this.nextId}`;
    this.threads.set(threadId, { threadId, state: "running" });
    return {
      threadId,
      branchName: request.item.mode === "worktree" ? request.resume?.branchName ?? `sparkle/${slug}` : null,
      scratchDir: request.item.mode === "scratch" ? request.resume?.scratchDir ?? request.scratchDir ?? join(request.workspaceRoot, ".t3-pilot", "scratch", slug) : null,
    };
  }

  async getThreadStatus(threadId: string): Promise<SparkleThreadStatus> {
    return this.threads.get(threadId) ?? { threadId, state: "failed" };
  }

  setThreadStatus(threadId: string, state: SparkleThreadStatus["state"], summary?: string): void {
    this.threads.set(threadId, { threadId, state, summary });
  }

  async stopSparkle(threadId: string, reason: string): Promise<void> {
    this.setThreadStatus(threadId, "stopped", reason);
  }
}
