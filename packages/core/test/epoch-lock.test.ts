import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEpochLease, verifyEpochLease } from "../src/epoch-lock.js";
import type { QuotaPoolSnapshot } from "../src/types.js";

const vectors: { pool: QuotaPoolSnapshot; now: string }[] =
  JSON.parse(readFileSync(new URL("./fixtures/golden-pacing-vectors.json", import.meta.url), "utf8"));
const { pool, now: timestamp } = vectors[0]!;
const now = new Date(timestamp);

describe("epoch leases", () => {
  it("stamps the earliest reset and applies at least two minutes of safety", () => {
    const lease = createEpochLease(pool, now, 0.5);
    const deadline = Date.parse(pool.sessionWindow!.resetsAt!) - 120_000;
    expect(lease).toMatchObject({
      safetyMarginMs: 120_000, hardDeadlineAt: new Date(deadline).toISOString(),
      targetWeeklyResetAt: pool.weeklyWindow?.resetsAt, targetSessionResetAt: pool.sessionWindow?.resetsAt,
    });
    expect(verifyEpochLease(lease, pool, new Date(deadline - 1))).toMatchObject({
      allowed: true, shouldHaltImmediately: false, remainingBeforeDeadlineMs: 1,
    });
    expect(verifyEpochLease(lease, pool, new Date(deadline))).toMatchObject({
      allowed: false, shouldHaltImmediately: true, reason: "HARD_STOP_SAFETY_MARGIN", remainingBeforeDeadlineMs: 0,
    });
  });

  it("honors a stricter safety margin and uses the weekly reset when it is earlier", () => {
    const earlier = {
      ...pool, weeklyWindow: { ...pool.weeklyWindow!, resetsAt: "2026-11-24T01:00:00.000Z" },
    };
    expect(createEpochLease(earlier, now, 5)).toMatchObject({
      safetyMarginMs: 300_000, hardDeadlineAt: "2026-11-24T00:55:00.000Z",
    });
  });

  it.each([["sessionWindow", "SESSION"], ["weeklyWindow", "WEEKLY"]] as const)(
    "halts immediately when the %s advances or disappears",
    (key, kind) => {
      const lease = createEpochLease(pool, now);
      const advanced = { ...pool, [key]: { ...pool[key]!, resetsAt: "2026-12-05T18:00:00.000Z" } };
      for (const live of [advanced, { ...pool, [key]: null }]) {
        expect(verifyEpochLease(lease, live, now)).toMatchObject({
          allowed: false, shouldHaltImmediately: true, reason: `HARD_STOP_${kind}_EPOCH_ADVANCED`,
        });
      }
    },
  );

  it.each(["sessionWindow", "weeklyWindow"] as const)("halts at the reserve floor in the %s", (key) => {
    const lease = createEpochLease(pool, now);
    const live = { ...pool, [key]: { ...pool[key]!, remainingPercent: 20 } };
    expect(verifyEpochLease(lease, live, now, 0).reason).toBe("HARD_STOP_RESERVE_SHIELD");
  });

  it("requires the leased instance to remain ready", () => {
    const lease = createEpochLease(pool, now);
    for (const live of [null, { ...pool, enabled: false }, { ...pool, status: "errored" },
      { ...pool, providerInstanceId: "antigravity_other" }]) {
      expect(verifyEpochLease(lease, live, now).reason).toBe("HARD_STOP_POOL_UNAVAILABLE");
    }
  });
});
