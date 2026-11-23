import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execCommand, type CommandRunner } from "./t3-adapter.js";
import type { PilotRuntimeState, SparkleExecutionMode, SparkleItem, SparkleItemStatus } from "./types.js";

const markerStatus = { " ": "pending", "~": "running", x: "completed", X: "completed", "!": "halted" } as const;
const statusMarker = { pending: " ", running: "~", completed: "x", halted: "!", failed: "!" } as const;
const checkbox = /^(\uFEFF?[\t ]*[-+*][\t ]+\[)([ ~xX!])(\][\t ]+)(.*)$/;
const metadataSuffix = /([\t ]+)<!-- t3-pilot:(\{(?:(?!-->).)*\}) -->[\t ]*$/;

type Metadata = Partial<Pick<SparkleItem, "id" | "prompt" | "status" | "threadId" | "note">> & {
  branchName?: string | null;
};

export interface SparkleInput {
  title: string;
  mode?: SparkleExecutionMode;
  prompt?: string;
}

export interface SparkleStatusUpdate {
  status: SparkleItemStatus;
  threadId?: string;
  branchName?: string | null;
  note?: string;
}

export interface SparkleExternalSource {
  listSparkles(workspaceRoot: string): Promise<SparkleItem[]>;
}

function readMetadata(json: string | undefined): Metadata {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Metadata;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : undefined,
      prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
      status: raw.status === "failed" ? "failed" : undefined,
      threadId: typeof raw.threadId === "string" ? raw.threadId : undefined,
      branchName: typeof raw.branchName === "string" || raw.branchName === null ? raw.branchName : undefined,
      note: typeof raw.note === "string" ? raw.note : undefined,
    };
  } catch {
    return {};
  }
}

function encodeMetadata(value: Metadata): string {
  const json = JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("--", "\\u002d\\u002d");
  return `<!-- t3-pilot:${json} -->`;
}

function parseLines(lines: string[]): SparkleItem[] {
  const occurrences = new Map<string, number>();
  const queue: SparkleItem[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index]!;
    const fenceMatch = /^\uFEFF? {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const delimiter = fenceMatch[1]!;
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !fenceMatch[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = checkbox.exec(line);
    if (!match) continue;
    const metadataMatch = metadataSuffix.exec(match[4]!);
    const metadata = readMetadata(metadataMatch?.[2]);
    const body = (metadataMatch ? match[4]!.slice(0, metadataMatch.index) : match[4]!).trim();
    const tag = /^\[(worktree|scratch)\][\t ]+/.exec(body);
    const mode = tag?.[1] === "scratch" ? "scratch" : "worktree";
    const title = body.slice(tag?.[0].length ?? 0).trim();
    if (!title) continue;
    const key = `${mode}\0${title}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const status = markerStatus[match[2] as keyof typeof markerStatus];
    queue.push({
      id: metadata.id ?? createHash("sha256").update(`${key}\0${occurrence}`).digest("hex").slice(0, 16),
      lineIndex: index / 2,
      source: "sparkles-md",
      mode,
      status: status === "halted" ? metadata.status ?? status : status,
      title,
      prompt: metadata.prompt ?? title,
      ...(metadata.threadId !== undefined && { threadId: metadata.threadId }),
      ...(metadata.branchName !== undefined && { branchName: metadata.branchName }),
      ...(metadata.note !== undefined && { note: metadata.note }),
    });
  }
  return queue;
}

export function parseSparklesMarkdown(markdown: string): SparkleItem[] {
  return parseLines(markdown.split(/(\r\n|\n|\r)/));
}

function readOptionalFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function atomicWrite(path: string, data: string, defaultMode: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const mode = statSync(path, { throwIfNoEntry: false })?.mode ?? defaultMode;
  const temp = join(directory, `.t3-pilot-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readSparklesQueue(sparklesPath: string): SparkleItem[] {
  return parseSparklesMarkdown(readOptionalFile(sparklesPath) ?? "");
}

export function appendSparkleToMarkdown(sparklesPath: string, input: SparkleInput): { added: SparkleItem; queue: SparkleItem[] } {
  const title = input.title.trim();
  if (!title || /[\r\n]/.test(title)) throw new Error("A Sparkle title must be a non-empty single line.");
  const mode = input.mode ?? "worktree";
  const markdown = readOptionalFile(sparklesPath) ?? "";
  const eol = /\r\n|\n|\r/.exec(markdown)?.[0] ?? "\n";
  const separator = markdown && !/[\r\n]$/.test(markdown) ? eol : "";
  const id = randomUUID();
  const metadata = encodeMetadata({ id, prompt: input.prompt });
  const updated = `${markdown}${separator}- [ ] [${mode}] ${title} ${metadata}${eol}`;
  const queue = parseSparklesMarkdown(updated);
  const added = queue.find((item) => item.id === id);
  if (!added) throw new Error("The Sparkle could not be appended outside a Markdown code fence.");
  atomicWrite(sparklesPath, updated, 0o644);
  return { added, queue };
}

export function updateSparkleStatusInMarkdown(sparklesPath: string, itemId: string, update: SparkleStatusUpdate): SparkleItem | null {
  const lines = (readOptionalFile(sparklesPath) ?? "").split(/(\r\n|\n|\r)/);
  const item = parseLines(lines).find((entry) => entry.id === itemId);
  if (item?.lineIndex === undefined) return null;

  const index = item.lineIndex * 2;
  const [, prefix, , bracket, tail] = checkbox.exec(lines[index]!)!;
  const match = metadataSuffix.exec(tail!);
  const existing = readMetadata(match?.[2]);
  const trailing = /[\t ]*$/.exec(tail!)![0];
  const body = match ? tail!.slice(0, match.index) : tail!.slice(0, tail!.length - trailing.length);
  const metadata = encodeMetadata({
    ...existing,
    id: item.id,
    status: update.status,
    threadId: update.threadId ?? existing.threadId,
    branchName: update.branchName === undefined ? existing.branchName : update.branchName,
    note: update.note ?? existing.note,
  });
  lines[index] = `${prefix}${statusMarker[update.status]}${bracket}${body}${match?.[1] ?? " "}${metadata}${trailing}`;
  atomicWrite(sparklesPath, lines.join(""), 0o644);
  return parseLines(lines).find((entry) => entry.id === itemId)!;
}

export class GhCliSparkleIssueSource implements SparkleExternalSource {
  constructor(private readonly options: { enabled?: boolean; execCommand?: CommandRunner } = {}) {}

  async listSparkles(workspaceRoot: string): Promise<SparkleItem[]> {
    if (this.options.enabled === false) return [];
    try {
      const { stdout } = await (this.options.execCommand ?? execCommand)(
        "gh", ["issue", "list", "--label", "sparkle", "--json", "number,title,body"], { cwd: workspaceRoot },
      );
      const issues: unknown = JSON.parse(stdout);
      if (!Array.isArray(issues)) return [];
      return issues.flatMap((issue): SparkleItem[] => {
        if (!Number.isSafeInteger(issue?.number) || issue.number <= 0 || typeof issue.title !== "string") return [];
        const title = issue.title.trim();
        if (!title) return [];
        return [{
          id: `gh-${issue.number}`,
          source: "github-issue",
          mode: "worktree",
          status: "pending",
          externalRef: `#${issue.number}`,
          title,
          prompt: typeof issue.body === "string" && issue.body.trim() ? issue.body : title,
        }];
      });
    } catch {
      return [];
    }
  }
}

export function loadRuntimeState(workspaceRoot: string): PilotRuntimeState {
  const raw = readOptionalFile(join(workspaceRoot, ".t3-pilot", "state.json"));
  if (raw === null) return {
    version: 1, updatedAt: new Date(0).toISOString(), pilotThreadIds: [], activeRun: null, history: [], lastSyncSnapshotId: null,
  };
  const state = JSON.parse(raw) as PilotRuntimeState | null;
  if (state?.version !== 1 || !Array.isArray(state.pilotThreadIds) || !Array.isArray(state.history)) {
    throw new Error("Invalid or unsupported t3-pilot runtime state.");
  }
  return state;
}

export function saveRuntimeState(workspaceRoot: string, state: PilotRuntimeState): void {
  atomicWrite(join(workspaceRoot, ".t3-pilot", "state.json"), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
