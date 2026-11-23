import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { unifiedDiff } from "./sync-diff.js";
import { mergeJsonMcp, readCanonicalMcp, renderCodexMcp, type JsonHarness } from "./sync-mcp.js";
import type { SyncHarnessTarget, SyncOptions, SyncPlanResult, SyncRollbackResult } from "./types.js";

const skillRoots: Record<SyncHarnessTarget, string> = {
  antigravity: ".agents/skills",
  codex: ".codex/skills",
  "claude-code": ".claude/skills",
};
const mcpPaths: Record<SyncHarnessTarget, string> = {
  antigravity: ".agents/mcp_config.json",
  codex: ".codex/config.toml",
  "claude-code": ".mcp.json",
};
const allTargets = Object.keys(skillRoots) as SyncHarnessTarget[];
const supportDirectories = ["scripts", "references", "examples", "resources"];
const syncManifestPath = ".t3-pilot/sync-manifest.json";

type FileImage = { data: Buffer; mode: number };
type StagedFile = { path: string; before: FileImage | null; after: FileImage };
type BackupFile = { path: string; before: { data: string; mode: number } | null };
type BackupManifest = {
  snapshotId: string;
  targetRoot: string;
  files: BackupFile[];
  createdDirectories: string[];
  rolledBack?: boolean;
};
type ManagedServers = Partial<Record<JsonHarness, string[]>>;

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Sync path escapes its root: ${path}`);
  }
  let current = root;
  if (stat(current)?.isSymbolicLink()) throw new Error(`Sync root is a symbolic link: ${current}`);
  for (const part of local.split(sep)) {
    current = join(current, part);
    if (stat(current)?.isSymbolicLink()) throw new Error(`Sync path is a symbolic link: ${current}`);
  }
  return absolute;
}

function fileAt(root: string, path: string): FileImage | null {
  const absolute = safePath(root, path);
  const status = stat(absolute);
  if (!status) return null;
  if (!status.isFile()) throw new Error(`Expected a file at ${absolute}.`);
  return { data: readFileSync(absolute), mode: status.mode & 0o777 };
}

function entriesAt(root: string, path: string): string[] {
  const absolute = safePath(root, path);
  const status = stat(absolute);
  if (!status) return [];
  if (!status.isDirectory()) throw new Error(`Expected a directory at ${absolute}.`);
  return readdirSync(absolute).sort();
}

function collectFiles(root: string, directory: string): string[] {
  return entriesAt(root, directory).flatMap((name) => {
    const path = join(directory, name);
    return stat(safePath(root, path))?.isDirectory() ? collectFiles(root, path) : [path];
  });
}

function frontmatterText(raw: string): string {
  const value = raw.trim();
  const singleQuoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
  if (singleQuoted) return singleQuoted[1]!.replaceAll("''", "'");
  const doubleQuoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value);
  if (doubleQuoted) {
    try {
      return JSON.parse(doubleQuoted[1]!) as string;
    } catch {
      return doubleQuoted[1]!.slice(1, -1);
    }
  }
  return value.replace(/\s+#.*$/, "");
}

function generateOpenAiYaml(skillName: string, skill: Buffer): Buffer {
  const lines = skill.toString("utf8").split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  const metadata = new Map<string, string>();
  if (lines[0]?.replace(/^\uFEFF/, "").trim() === "---" && closing > 0) {
    for (let index = 1; index < closing; index++) {
      const field = /^(name|description):\s*(.*)$/.exec(lines[index]!);
      if (!field) continue;
      const value = field[2]!;
      if (/^[|>][+-]?(?:\s+#.*)?$/.test(value)) {
        const continuation: string[] = [];
        while (index + 1 < closing && /^(?:\s|$)/.test(lines[index + 1]!)) {
          continuation.push(lines[++index]!.trim());
        }
        const separator = value.startsWith(">") ? " " : "\n";
        metadata.set(field[1]!, continuation.join(separator).trim());
      } else {
        metadata.set(field[1]!, frontmatterText(value));
      }
    }
  }

  const name = JSON.stringify(metadata.get("name") || skillName);
  const description = metadata.get("description");
  const yaml = [`interface:\n  display_name: ${name}\n`];
  if (description) yaml.push(`  short_description: ${JSON.stringify(description)}\n`);
  return Buffer.from(yaml.join(""));
}

function readManagedServers(data: Buffer | undefined): ManagedServers {
  if (!data) return {};
  const raw = JSON.parse(data.toString("utf8")) as { managedMcpServers?: ManagedServers } | null;
  const managed = raw?.managedMcpServers;
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("Invalid t3-pilot sync manifest.");
  }
  for (const [harness, ids] of Object.entries(managed)) {
    if ((harness !== "antigravity" && harness !== "claude-code")
      || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error("Invalid managed MCP server list in the sync manifest.");
    }
  }
  return managed;
}

function compileSync(options: SyncOptions): { result: SyncPlanResult; staged: StagedFile[]; targetRoot: string } {
  const workspace = resolve(options.workspaceRoot);
  const targetRoot = resolve(options.targetRoot ?? workspace);
  const targets = [...new Set(options.targets ?? allTargets)].sort();
  const skillsPath = ".t3-pilot/skills";
  const sourceMcp = ".t3-pilot/mcp.json";
  const mcpSourceFile = fileAt(workspace, sourceMcp);
  const servers = readCanonicalMcp(mcpSourceFile?.data.toString("utf8") ?? null);
  const result: SyncPlanResult = {
    sourceSkillsDir: join(workspace, skillsPath),
    sourceMcpPath: join(workspace, sourceMcp),
    discoveredSkills: [],
    discoveredMcpServers: Object.keys(servers).sort(),
    changes: [],
    applied: false,
  };
  const staged: StagedFile[] = [];
  function stage(harness: SyncHarnessTarget, path: string, data: Buffer, mode = 0o644) {
    const before = fileAt(targetRoot, path);
    const action = before === null ? "create" : before.data.equals(data) ? "unchanged" : "update";
    const targetPath = safePath(targetRoot, path);
    result.changes.push({
      harness, targetPath, action,
      beforeContent: before?.data.toString("utf8") ?? null,
      afterContent: data.toString("utf8"),
      unifiedDiff: action === "unchanged" ? "" : unifiedDiff(path.split(sep).join("/"), before?.data ?? null, data),
    });
    if (action !== "unchanged") staged.push({ path, before, after: { data, mode: before?.mode ?? mode } });
  }

  for (const name of entriesAt(workspace, skillsPath)) {
    const source = join(skillsPath, name);
    if (!stat(safePath(workspace, source))?.isDirectory()) continue;
    const skill = fileAt(workspace, join(source, "SKILL.md"));
    if (!skill) continue;
    result.discoveredSkills.push(name);
    const support = supportDirectories.flatMap((directory) => collectFiles(workspace, join(source, directory)))
      .map((path) => ({ path: relative(source, path), file: fileAt(workspace, path)! }));
    const openAi = targets.includes("codex") ? fileAt(workspace, join(source, "agents/openai.yaml")) : null;
    for (const harness of targets) {
      const destination = join(skillRoots[harness], name);
      stage(harness, join(destination, "SKILL.md"), skill.data, skill.mode);
      for (const { path, file } of support) stage(harness, join(destination, path), file.data, file.mode);
      if (harness === "codex") {
        stage(harness, join(destination, "agents/openai.yaml"),
          openAi?.data ?? generateOpenAiYaml(name, skill.data), openAi?.mode);
      }
    }
  }

  const jsonTargets = targets.filter((target) => target !== "codex");
  const oldManifest = jsonTargets.length ? fileAt(targetRoot, syncManifestPath) : null;
  const oldManaged = readManagedServers(oldManifest?.data);
  const managed = { ...oldManaged };
  const warnings: string[] = [];
  for (const harness of targets) {
    const path = mcpPaths[harness];
    const before = fileAt(targetRoot, path)?.data.toString("utf8") ?? null;
    const merged = (() => {
      if (harness === "codex") return renderCodexMcp(before ?? "", servers);
      if (!mcpSourceFile && !oldManaged[harness]?.length) return null;
      const value = mergeJsonMcp(before, servers, managed[harness] ?? [], harness);
      if (value.managed.length) managed[harness] = value.managed;
      else delete managed[harness];
      return value;
    })();
    if (!merged) continue;
    for (const id of merged.collisions) warnings.push(`${harness} already has a user-managed MCP server named ${id}.`);
    if (harness === "codex" && before === null && !merged.content) continue;
    stage(harness, path, Buffer.from(merged.content), mcpSourceFile?.mode);
  }
  if (jsonTargets[0] && (oldManifest || Object.keys(managed).length > 0)) {
    const sorted = Object.fromEntries(Object.entries(managed).sort(([a], [b]) => a.localeCompare(b)));
    stage(jsonTargets[0], syncManifestPath, Buffer.from(`${JSON.stringify({ managedMcpServers: sorted }, null, 2)}\n`), 0o600);
  }
  if (warnings.length) result.warnings = warnings;
  return { result, staged, targetRoot };
}

export function planSync(options: SyncOptions): SyncPlanResult {
  return compileSync(options).result;
}

function atomicWrite(path: string, image: FileImage) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.t3-pilot-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, image.data, { mode: image.mode, flag: "wx" });
    chmodSync(tmp, image.mode);
    renameSync(tmp, path);
  } finally {
    removeFile(tmp);
  }
}

function removeFile(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function replaceFile(root: string, path: string, file: FileImage | null) {
  const absolute = safePath(root, path);
  if (file) atomicWrite(absolute, file);
  else removeFile(absolute);
}

function withSyncLock<T>(root: string, work: () => T): T {
  const hash = createHash("sha256").update(root).digest("hex");
  const lock = join(tmpdir(), `t3-pilot-sync-${hash}.lock`);
  const descriptor = openSync(lock, "wx", 0o600);
  try {
    return work();
  } finally {
    closeSync(descriptor);
    removeFile(lock);
  }
}

function missingDirectories(root: string, files: StagedFile[]): string[] {
  const paths = new Set<string>();
  for (const { path } of files) {
    let directory = dirname(path);
    while (directory !== "." && !stat(safePath(root, directory))) {
      paths.add(directory);
      directory = dirname(directory);
    }
  }
  if (!stat(root)) paths.add(".");
  return [...paths].sort((a, b) => b.split(sep).length - a.split(sep).length || b.length - a.length);
}

function removeCreatedDirectories(root: string, paths: string[]) {
  for (const path of paths) {
    try {
      rmdirSync(safePath(root, path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

function backupPath(workspace: string, snapshotId: string): string {
  if (!/^\d{13}-[a-f0-9-]{36}$/.test(snapshotId)) throw new Error("Invalid sync snapshot ID.");
  return safePath(workspace, join(".t3-pilot/backups", snapshotId, "manifest.json"));
}

function writeBackup(path: string, manifest: BackupManifest) {
  atomicWrite(path, { data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o600 });
}

function restoreOnFailure(root: string, applied: { path: string; before: FileImage | null }[], error: unknown): never {
  const errors = [error];
  for (const { path, before } of applied.reverse()) {
    try {
      replaceFile(root, path, before);
    } catch (restoreError) {
      errors.push(restoreError);
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, "Sync failed and some files could not be restored.");
  throw error;
}

export function applySync(options: SyncOptions): SyncPlanResult {
  if (options.dryRun) return planSync(options);
  const root = resolve(options.targetRoot ?? options.workspaceRoot);
  return withSyncLock(root, () => {
    const { result, staged, targetRoot } = compileSync(options);
    if (!staged.length) return { ...result, applied: true };

    const snapshotId = `${Date.now()}-${randomUUID()}`;
    const backup: BackupManifest = {
      snapshotId, targetRoot,
      files: staged.map(({ path, before }) => ({
        path, before: before && { data: before.data.toString("base64"), mode: before.mode },
      })),
      createdDirectories: missingDirectories(targetRoot, staged),
    };
    const workspace = resolve(options.workspaceRoot);
    const manifestPath = backupPath(workspace, snapshotId);
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeBackup(manifestPath, backup);
    const applied: StagedFile[] = [];
    try {
      for (const file of staged) {
        const current = fileAt(targetRoot, file.path);
        if ((current === null) !== (file.before === null)
          || (current && file.before && (!current.data.equals(file.before.data) || current.mode !== file.before.mode))) {
          throw new Error(`Sync target changed during apply: ${file.path}`);
        }
        replaceFile(targetRoot, file.path, file.after);
        applied.push(file);
      }
    } catch (error) {
      try {
        restoreOnFailure(targetRoot, applied, error);
      } catch (failure) {
        if (failure === error) {
          writeBackup(manifestPath, { ...backup, rolledBack: true });
          removeCreatedDirectories(targetRoot, backup.createdDirectories);
        }
        throw failure;
      }
    }
    return { ...result, applied: true, snapshotId };
  });
}

function readBackup(path: string): BackupManifest {
  return JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
}

export function rollbackSync(workspaceRoot: string, snapshotId?: string): SyncRollbackResult {
  const workspace = resolve(workspaceRoot);
  if (snapshotId === undefined) {
    snapshotId = entriesAt(workspace, ".t3-pilot/backups").reverse().find((id) => {
      if (!/^\d{13}-[a-f0-9-]{36}$/.test(id)) return false;
      const path = backupPath(workspace, id);
      return Boolean(stat(path)) && !readBackup(path).rolledBack;
    });
  }
  if (!snapshotId) throw new Error("No sync snapshot is available for rollback.");
  const manifestPath = backupPath(workspace, snapshotId);
  const { targetRoot } = readBackup(manifestPath);
  return withSyncLock(targetRoot, () => {
    const backup = readBackup(manifestPath);
    if (backup.rolledBack) throw new Error(`Sync snapshot ${backup.snapshotId} was already rolled back.`);
    const restoredPaths: string[] = [];
    const removedPaths: string[] = [];
    const applied: { path: string; before: FileImage | null }[] = [];
    try {
      for (const { path, before } of [...backup.files].reverse()) {
        const absolute = safePath(targetRoot, path);
        const current = fileAt(targetRoot, path);
        replaceFile(targetRoot, path, before && { data: Buffer.from(before.data, "base64"), mode: before.mode });
        applied.push({ path, before: current });
        if (before) restoredPaths.push(absolute);
        else if (current) removedPaths.push(absolute);
      }
      writeBackup(manifestPath, { ...backup, rolledBack: true });
    } catch (error) {
      restoreOnFailure(targetRoot, applied, error);
    }
    removeCreatedDirectories(targetRoot, backup.createdDirectories);
    return { snapshotId: backup.snapshotId, restoredPaths, removedPaths };
  });
}
