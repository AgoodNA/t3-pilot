import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readQuotaPools } from "../src/limits-reader.js";

const fixtures = new URL("./fixtures/", import.meta.url);
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pilot-limits-"));
  cpSync(new URL("caches/", fixtures), join(home, "caches"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function configureCodex(runtimePaths: Record<string, string>) {
  const path = join(home, "caches", "codex_oauth.json");
  const cache = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...cache, runtimePaths }));
}

describe("readQuotaPools", () => {
  it("splits Antigravity using the independent session and weekly windows", () => {
    vi.stubEnv("T3CODE_HOME", home);
    const pools = readQuotaPools();
    expect(pools.find(({ poolId }) => poolId === "antigravity-gemini")).toMatchObject({
      providerInstanceId: "antigravity",
      source: "t3-cache-windows",
      checkedAt: "2026-11-23T18:01:09.148Z",
      sessionWindow: { id: "gemini-5h", remainingPercent: 75 },
      weeklyWindow: { id: "gemini-weekly", remainingPercent: 58 },
    });
    expect(pools.find(({ poolId }) => poolId === "antigravity-claude")).toMatchObject({
      sessionWindow: { id: "3p-5h", remainingPercent: 87.5 },
      weeklyWindow: { id: "3p-weekly", remainingPercent: 65 },
    });
  });

  it("returns the ready OAuth instance and external usage link instead of the errored bare cache", () => {
    writeFileSync(join(home, "caches", "codex.json"), JSON.stringify({
      instanceId: "codex", driver: "codex", enabled: true, status: "error", checkedAt: "2026-12-01T00:00:00Z",
    }));
    const pools = readQuotaPools({ t3Home: home }).filter(({ poolId }) => poolId === "codex");
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      source: "external-unmetered",
      providerInstanceId: "codex_test_instance",
      sessionWindow: null,
      weeklyWindow: null,
      externalUsageUrl: "https://chatgpt.com/#settings/Usage",
      unavailableReason: "unsupported",
    });
  });

  it("joins normal and shadow session trees and reads the newest valid rate-limit event", () => {
    const normal = join(home, "normal");
    const shadow = join(home, "shadow");
    cpSync(new URL("codex-sessions/", fixtures), join(shadow, "sessions"), { recursive: true });
    const original = join(shadow, "sessions", "2026", "11", "23", "rollout-sample.jsonl");
    mkdirSync(join(normal, "sessions"), { recursive: true });
    const fresh = join(normal, "sessions", "fresh.jsonl");
    const event = (used: number) => JSON.stringify({ timestamp: "2026-11-23T18:10:00.000Z", payload: { rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: Date.parse("2026-11-23T22:00:00Z") / 1000 },
      secondary: { used_percent: -5, window_minutes: 10080, resets_at: "2026-11-29T22:00:00.000Z" },
    } } });
    writeFileSync(fresh, [event(12), event(120), '{"rate_limits":'].join("\n"));
    // A log can be modified after its last rate-limit event by other session messages.
    utimesSync(fresh, new Date(), new Date("2026-11-23T18:10:00.000Z"));
    utimesSync(original, new Date(), new Date("2026-11-24T00:00:00.000Z"));
    configureCodex({ homePath: normal, shadowHomePath: shadow });
    const codex = () => readQuotaPools({ t3Home: home }).find(({ poolId }) => poolId === "codex");
    expect(codex()).toMatchObject({
      source: "codex-session-jsonl",
      sessionWindow: { usedPercent: 100, remainingPercent: 0, resetsAt: "2026-11-23T22:00:00.000Z" },
      weeklyWindow: { usedPercent: 0, remainingPercent: 100, resetsAt: "2026-11-29T22:00:00.000Z" },
    });
    rmSync(fresh);
    expect(codex()).toMatchObject({
      source: "codex-session-jsonl",
      checkedAt: "2026-11-23T18:01:54.695Z",
      sessionWindow: { remainingPercent: 77.5 },
      weeklyWindow: { remainingPercent: 52 },
    });
  });

  it("prefers a manual Codex quota override over session telemetry", () => {
    cpSync(new URL("codex-sessions/", fixtures), join(home, "sessions"), { recursive: true });
    configureCodex({ homePath: home });
    const pool = readQuotaPools({
      t3Home: home,
      poolOverrides: { codex: { weeklyWindow: { usedPercent: 35, resetsAt: null } } },
    }).find(({ poolId }) => poolId === "codex");
    expect(pool).toMatchObject({
      source: "manual-override",
      sessionWindow: null,
      weeklyWindow: { remainingPercent: 65, resetsAt: null, windowDurationMins: 10080 },
    });
  });

  it("includes ready community pools and optionally exposes disabled cache stubs", () => {
    const path = join(home, "caches", "cursor.json");
    const cursor = JSON.parse(readFileSync(path, "utf8"));
    expect(readQuotaPools({ t3Home: home }).map(({ poolId }) => poolId)).toEqual(expect.arrayContaining([
      "claude-agent", "cursor",
    ]));
    writeFileSync(path, JSON.stringify({ ...cursor, enabled: false, status: "disabled" }));
    expect(readQuotaPools({ t3Home: home }).some(({ poolId }) => poolId === "cursor")).toBe(false);
    expect(readQuotaPools({ t3Home: home, includeCommunityStubs: true })).toContainEqual(
      expect.objectContaining({ poolId: "cursor", enabled: false }),
    );
  });

  it("only returns whitelisted quota metadata and clamps cache percentages", () => {
    const path = join(home, "caches", "antigravity.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.usageLimits.windows[0].usedPercent = -11;
    cache.usageLimits.windows[2].usedPercent = 200;
    writeFileSync(path, JSON.stringify(cache));
    const pools = readQuotaPools({ t3Home: home });
    expect(pools.find(({ poolId }) => poolId === "antigravity-claude")).toMatchObject({
      sessionWindow: { usedPercent: 0, remainingPercent: 100 },
      weeklyWindow: { usedPercent: 100, remainingPercent: 0 },
    });
    expect(JSON.stringify(pools)).not.toMatch(/auth|credentialFingerprint|should-never-leak|@example\.com/);
  });
});
