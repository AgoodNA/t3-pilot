import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeTask, type NormalizedWindowState, type QuotaPoolSnapshot } from "@t3-pilot/core";

export const minute = 60_000;
export const hour = 60 * minute;
export const baseTime = new Date("2026-11-23T18:00:00.000Z");
export const at = (offset: number) => new Date(baseTime.getTime() + offset);

export function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "t3-pilot-daemon-"));
}

export function window(kind: NormalizedWindowState["kind"], remainingPercent: number, resetsAt: Date): NormalizedWindowState {
  return {
    id: kind, label: kind, kind, windowDurationMins: kind === "session" ? 300 : 10080,
    remainingPercent, usedPercent: 100 - remainingPercent, resetsAt: resetsAt.toISOString(),
  };
}

export function codexPool(overrides: Partial<QuotaPoolSnapshot> = {}): QuotaPoolSnapshot {
  return {
    poolId: "codex", providerInstanceId: "codex_fixture", driver: "codex", displayName: "Codex",
    enabled: true, installed: true, status: "ready", source: "t3-cache-windows", checkedAt: baseTime.toISOString(),
    sessionWindow: window("session", 90, at(3 * hour)), weeklyWindow: window("weekly", 80, at(24 * hour)),
    ...overrides,
  };
}

export function fixtureRoute() {
  return routeTask("Debug TypeScript parser tests", [codexPool()], { now: baseTime }).selected!;
}

export function createQuotaHome(workspaceRoot: string, now = new Date()): string {
  const home = join(workspaceRoot, "t3-home");
  mkdirSync(join(home, "caches"), { recursive: true });
  mkdirSync(join(home, "userdata"), { recursive: true });
  writeFileSync(join(home, "caches", "codex_fixture.json"), JSON.stringify({
    instanceId: "codex_fixture", driver: "codex", enabled: true, installed: true, status: "ready",
    checkedAt: now.toISOString(), usageLimits: { windows: [
      window("session", 90, new Date(now.getTime() + 3 * hour)),
      window("weekly", 80, new Date(now.getTime() + 24 * hour)),
    ] },
  }));
  return home;
}
