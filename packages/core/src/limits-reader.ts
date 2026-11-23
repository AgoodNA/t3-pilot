import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { clamp, parseTimestamp } from "./quota-math.js";
import type {
  NormalizedWindowState, ProviderDriverKind, QuotaPoolId, QuotaPoolSnapshot,
  QuotaWindowOverride, ReadQuotaOptions,
} from "./types.js";

type JsonObject = Record<string, unknown>;
type WindowKind = NormalizedWindowState["kind"];

const sessionFileLimit = 64;
const sessionDirectoryLimit = 512;
const sessionEntryLimit = 20_000;
const sessionTailBytes = 1024 * 1024;

function object(raw: unknown): JsonObject {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
}

function readJson(value: string): JsonObject {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function string(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function resetTimestamp(raw: unknown): string | null {
  const ms = typeof raw === "number" ? raw * 1000 : parseTimestamp(string(raw));
  if (ms === null || !Number.isFinite(new Date(ms).getTime())) return null;
  return typeof raw === "string" ? raw : new Date(ms).toISOString();
}

function normalizeWindow(window: JsonObject | QuotaWindowOverride, kind: WindowKind): NormalizedWindowState | null {
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = clamp(window.usedPercent, 0, 100);
  const duration = window.windowDurationMins;
  return {
    id: string(window.id) ?? kind,
    label: string(window.label) ?? (kind === "session" ? "5-hour" : "Weekly"),
    kind,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: resetTimestamp(window.resetsAt),
    windowDurationMins: typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? duration
      : kind === "session" ? 300 : 10080,
  };
}

function sessionJsonlFiles(roots: string[]): { path: string; mtime: number }[] {
  const files: { path: string; mtime: number }[] = [];
  const pending = [...new Set(roots)];
  const seen = new Set<string>();
  let visitedEntries = 0;
  while (pending.length > 0 && seen.size < sessionDirectoryLimit && visitedEntries < sessionEntryLimit) {
    const path = pending.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const entry of entries(path)) {
      if (visitedEntries++ >= sessionEntryLimit) break;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ path: child, mtime: statSync(child).mtimeMs });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))
    .slice(0, sessionFileLimit);
}

function readSessionTail(path: string): string[] {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const start = Math.max(0, size - sessionTailBytes);
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // Drop the potentially partial first line.
    return lines.reverse();
  } finally {
    closeSync(descriptor);
  }
}

type SessionLimits = {
  sessionWindow: NormalizedWindowState | null;
  weeklyWindow: NormalizedWindowState | null;
  checkedAt: string | undefined;
};

function readCodexSessionLimits(runtimePaths: JsonObject): SessionLimits | null {
  const roots = [string(runtimePaths.homePath), string(runtimePaths.shadowHomePath)]
    .filter((path) => path !== undefined)
    .map((path) => join(path, "sessions"));

  let latest: SessionLimits | null = null;
  let latestMs = -Infinity;
  for (const { path, mtime } of sessionJsonlFiles(roots)) {
    let lines: string[];
    try {
      lines = readSessionTail(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      const event = readJson(line);
      const payload = object(event.payload);
      const limits = object(payload.rate_limits ?? event.rate_limits);
      const toWindow = (raw: unknown, kind: WindowKind) => {
        const window = object(raw);
        return normalizeWindow({
          id: kind === "session" ? "codex-5h" : "codex-weekly",
          usedPercent: window.used_percent,
          resetsAt: window.resets_at,
          windowDurationMins: window.window_minutes,
        }, kind);
      };
      const sessionWindow = toWindow(limits.primary, "session");
      const weeklyWindow = toWindow(limits.secondary, "weekly");
      if (sessionWindow || weeklyWindow) {
        const checkedAt = string(event.timestamp) ?? string(payload.timestamp);
        const eventMs = parseTimestamp(checkedAt) ?? mtime;
        if (eventMs > latestMs) {
          latest = { sessionWindow, weeklyWindow, checkedAt };
          latestMs = eventMs;
        }
        break;
      }
    }
  }
  return latest;
}

function externalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function readPool(
  cache: JsonObject,
  poolId: QuotaPoolId,
  driver: ProviderDriverKind,
  fileInstanceId: string,
  options: ReadQuotaOptions,
): QuotaPoolSnapshot {
  const usage = object(cache.usageLimits);
  const windows: JsonObject[] = Array.isArray(usage.windows) ? usage.windows.map(object) : [];
  const prefix = poolId === "antigravity-gemini" ? "gemini" : poolId === "antigravity-claude" ? "3p" : null;
  const findWindow = (kind: WindowKind) => {
    const id = prefix && `${prefix}-${kind === "session" ? "5h" : "weekly"}`;
    for (const raw of windows) {
      if (id ? raw.id !== id : raw.kind !== kind) continue;
      const window = normalizeWindow(raw, kind);
      if (window) return window;
    }
    return null;
  };
  const sessionWindow = findWindow("session");
  const weeklyWindow = findWindow("weekly");
  const pool: QuotaPoolSnapshot = {
    poolId,
    driver,
    providerInstanceId: string(cache.instanceId) ?? fileInstanceId,
    displayName: string(cache.displayName) ?? fileInstanceId,
    enabled: cache.enabled === true,
    installed: cache.installed === true,
    status: string(cache.status) ?? "unavailable",
    checkedAt: string(usage.checkedAt) ?? string(cache.checkedAt) ?? null,
    source: sessionWindow || weeklyWindow ? "t3-cache-windows" : "unavailable",
    sessionWindow,
    weeklyWindow,
  };
  const unavailable = object(usage.unavailable);
  const reason = string(unavailable.reason);
  const url = externalUrl(object(usage.externalUsage).url ?? unavailable.externalUsageUrl ?? unavailable.usageUrl ?? unavailable.url
    ?? usage.externalUsageUrl ?? cache.externalUsageUrl);
  if (reason) pool.unavailableReason = reason;
  if (url) pool.externalUsageUrl = url;

  if (poolId === "codex" && pool.enabled && pool.status === "ready" && windows.length === 0 && reason === "unsupported") {
    const manual = options.poolOverrides?.codex;
    if (manual) {
      return {
        ...pool, source: "manual-override",
        checkedAt: manual.checkedAt ?? pool.checkedAt,
        sessionWindow: manual.sessionWindow ? normalizeWindow(manual.sessionWindow, "session") : null,
        weeklyWindow: manual.weeklyWindow ? normalizeWindow(manual.weeklyWindow, "weekly") : null,
      };
    }

    const sessionLimits = readCodexSessionLimits(object(cache.runtimePaths));
    if (sessionLimits) {
      return {
        ...pool, ...sessionLimits,
        checkedAt: sessionLimits.checkedAt ?? pool.checkedAt, source: "codex-session-jsonl",
      };
    }
    pool.source = "external-unmetered";
  }
  return pool;
}

function candidatePriority(pool: QuotaPoolSnapshot): number {
  return (pool.enabled && pool.status === "ready" ? 4 : 0)
    + (pool.source !== "unavailable" ? 2 : 0) + (pool.enabled ? 1 : 0);
}

export function readQuotaPools(options: ReadQuotaOptions = {}): QuotaPoolSnapshot[] {
  const directory = join(options.t3Home ?? (process.env.T3CODE_HOME || join(homedir(), ".t3")), "caches");
  const pools = new Map<QuotaPoolId, QuotaPoolSnapshot>();
  const add = (pool: QuotaPoolSnapshot) => {
    const previous = pools.get(pool.poolId);
    if (!previous || candidatePriority(pool) > candidatePriority(previous)
      || (candidatePriority(pool) === candidatePriority(previous)
        && (parseTimestamp(pool.checkedAt) ?? 0) > (parseTimestamp(previous.checkedAt) ?? 0))) {
      pools.set(pool.poolId, pool);
    }
  };

  for (const entry of entries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let cache: JsonObject;
    try {
      cache = readJson(readFileSync(join(directory, entry.name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const instanceId = basename(entry.name, ".json");
    const driver = cache.driver;
    if (driver === "antigravity") {
      for (const id of ["antigravity-gemini", "antigravity-claude"] as const) {
        const pool = readPool(cache, id, driver, instanceId, options);
        if (pool.source === "t3-cache-windows") add(pool);
      }
    } else if (driver === "codex") {
      add(readPool(cache, "codex", driver, instanceId, options));
    } else if (driver === "claudeAgent" || driver === "cursor") {
      if (options.includeCommunityStubs || (cache.enabled === true && cache.status === "ready")) {
        add(readPool(cache, driver === "claudeAgent" ? "claude-agent" : driver, driver, instanceId, options));
      }
    }
  }
  return [...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId));
}
