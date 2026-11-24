import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateAllPools, evaluatePoolPacing } from "../src/pacing-engine.js";
import type { PoolPacingEvaluation, QuotaPoolSnapshot } from "../src/types.js";

const vectors: { name: string; now: string; pool: QuotaPoolSnapshot; expected: Partial<PoolPacingEvaluation> }[] =
  JSON.parse(readFileSync(new URL("./fixtures/golden-pacing-vectors.json", import.meta.url), "utf8"));
const baseline = vectors[0]!.pool;
const start = Date.parse("2026-11-23T00:00:00Z");
const minute = 60_000;
const hour = 60 * minute;
const date = (offsetMs: number) => new Date(start + offsetMs);
const weekly = (remaining: number, resetsAt: string | null) => ({
  ...baseline.weeklyWindow!, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt,
});
const session = (remaining: number, resetsAt: string | null) => ({
  ...baseline.sessionWindow!, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt,
});

describe("evaluatePoolPacing", () => {
  it.each(vectors)("$name", ({ pool, now, expected }) => {
    expect(evaluatePoolPacing(pool, new Date(now))).toMatchObject(expected);
  });

  it("triggers FULL_THROTTLE_HARVEST out-of-the-box on SPEC.md canonical example (24h left, 80% weekly remaining)", () => {
    const pool = { ...baseline, sessionWindow: session(90, date(3 * hour).toISOString()), weeklyWindow: weekly(80, date(24 * hour).toISOString()) };
    const result = evaluatePoolPacing(pool, date(0));
    expect(result).toMatchObject({
      harvestMode: "FULL_THROTTLE_HARVEST",
      remaining5hWindowsCount: 5,
      weeklyBurnableSurplusPercent: 60,
      maxDrainCapacityPercent: 70,
    });
    expect(result.couplingRatio).toBeCloseTo(60 / 70, 5);
  });

  it.each([[0, 100], [84, 60], [168, 20]])("glides linearly at hour %i", (elapsed, ideal) => {
    const pool = { ...baseline, sessionWindow: null, weeklyWindow: weekly(70, date(168 * hour).toISOString()) };
    const result = evaluatePoolPacing(pool, date(elapsed * hour));
    expect(result.idealWeeklyRemainingPercent).toBe(ideal);
    expect(result.paceDeltaPercent).toBe(70 - ideal);
    expect(result.timeToWeeklyResetMs).toBe((168 - elapsed) * hour);
  });

  it.each(["weekly", "session"] as const)("locks at the exact 2-minute %s guard", (kind) => {
    const pool = {
      ...baseline,
      weeklyWindow: weekly(80, date((kind === "weekly" ? 2 * minute : 120 * hour)).toISOString()),
      sessionWindow: session(80, date((kind === "session" ? 2 * minute : 3 * hour)).toISOString()),
    };
    expect(evaluatePoolPacing(pool, date(-1), { epochSafetyMarginMins: 0 }).shieldLocked).toBe(false);
    expect(evaluatePoolPacing(pool, date(0), { epochSafetyMarginMins: 0 })).toMatchObject({
      harvestMode: "LOCKED_SHIELD", effectiveBurnablePercent: 0, shieldLocked: true,
    });
  });

  it("recovers session window to 100% and does NOT lock shield when sessionWindow.resetsAt is already in the past (now >= sessionReset)", () => {
    const pool = {
      ...baseline,
      // Pre-reset cached state had 15% remaining, and resetsAt already passed
      sessionWindow: session(15, date(0).toISOString()),
      weeklyWindow: weekly(60, date(120 * hour).toISOString()),
    };
    // Inside critical (0, 2m] window before reset -> LOCKED_SHIELD (via 15% <= 20% or 90s <= 2m)
    const beforeReset = {
      ...baseline,
      sessionWindow: session(75, date(90_000).toISOString()),
      weeklyWindow: weekly(60, date(120 * hour).toISOString()),
    };
    expect(evaluatePoolPacing(beforeReset, date(0))).toMatchObject({
      shieldLocked: true,
      harvestMode: "LOCKED_SHIELD",
      effectiveBurnablePercent: 0,
    });

    // At exact resetAt (now === sessionReset) and past resetAt (now > sessionReset): restored to 100%, unlocked!
    for (const checkAt of [date(0), date(3 * hour)]) {
      const evaluated = evaluatePoolPacing(pool, checkAt);
      expect(evaluated).toMatchObject({
        shieldLocked: false,
        harvestMode: "PRESERVE_WINDOWS",
        sessionRemainingPercent: 100,
        sessionBurnableSurplusPercent: 80,
        weeklyBurnableSurplusPercent: 40,
        effectiveBurnablePercent: 40,
        timeToSessionResetMs: null,
      });
    }
  });

  it("requires strictly under 45 minutes for expiring-session harvest", () => {
    const pool = {
      ...baseline,
      weeklyWindow: weekly(90, date(72 * hour).toISOString()),
      sessionWindow: session(60, date(45 * minute).toISOString()),
    };
    expect(evaluatePoolPacing(pool, date(0)).harvestMode).toBe("PRESERVE_WINDOWS");
    expect(evaluatePoolPacing(pool, date(1)).harvestMode).toBe("EXPIRING_5H_HARVEST");
  });

  it("uses ceil(24 / 5) and supports overriding both nominal and effective session capacity", () => {
    const pool = { ...baseline, sessionWindow: null, weeklyWindow: weekly(92, date(24 * hour).toISOString()) };
    const highCap = evaluatePoolPacing(pool, date(0), { singleWindowCapacityPercent: 80 });
    expect(highCap).toMatchObject({
      harvestMode: "PRESERVE_WINDOWS", remaining5hWindowsCount: 5,
      maxDrainCapacityPercent: 400, couplingRatio: 0.18, effectiveBurnablePercent: 72,
    });
    expect(evaluatePoolPacing(pool, date(0), { singleWindowCapacityPercent: 16 })).toMatchObject({
      harvestMode: "FULL_THROTTLE_HARVEST", maxDrainCapacityPercent: 80, couplingRatio: 0.9,
    });
    expect(evaluatePoolPacing(pool, date(0), {
      singleWindowCapacityPercent: 80, effectiveWindowCapacityPercent: 16,
    }).harvestMode).toBe("FULL_THROTTLE_HARVEST");
  });

  it("supports a higher reserve but keeps the required minimum reserve", () => {
    const pool = { ...baseline, sessionWindow: null, weeklyWindow: weekly(29, null) };
    expect(evaluatePoolPacing(pool, date(0), { reserveFloorPercent: 10 }).effectiveBurnablePercent).toBe(9);
    expect(evaluatePoolPacing(pool, date(0), { reserveFloorPercent: 30 }).shieldLocked).toBe(true);
  });

  it("treats a past weeklyWindow.resetsAt (now > weeklyReset) as a rolled-over fresh 100% cycle instead of false FULL_THROTTLE_HARVEST", () => {
    const staleWeeklyPool = {
      ...baseline,
      sessionWindow: null,
      weeklyWindow: weekly(65, date(-10 * minute).toISOString()),
    };
    expect(evaluatePoolPacing(staleWeeklyPool, date(0))).toMatchObject({
      harvestMode: "PRESERVE_WINDOWS",
      weeklyRemainingPercent: 100,
      weeklyBurnableSurplusPercent: 80,
      effectiveBurnablePercent: 80,
      paceDeltaPercent: 0,
      shieldLocked: false,
    });
  });

  it("evaluates multiple pools with the option to lock external quota", () => {
    const external = vectors.at(-1)!.pool;
    const [a, b] = evaluateAllPools([external, baseline], date(0), { lockUnknownPools: true });
    expect(a).toMatchObject({ shieldLocked: true, harvestMode: "LOCKED_SHIELD" });
    expect(b?.poolId).toBe(baseline.poolId);
  });
});
