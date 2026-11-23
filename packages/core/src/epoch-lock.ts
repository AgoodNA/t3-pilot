import { randomUUID } from "node:crypto";
import { epochMarginMs, parseTimestamp, reserveFloor } from "./quota-math.js";
import type { EpochCheckResult, EpochLease, EpochStopReason, QuotaPoolSnapshot } from "./types.js";

export function createEpochLease(
  pool: QuotaPoolSnapshot,
  now = new Date(),
  safetyMarginMins?: number,
): EpochLease {
  const targetSessionResetAt = pool.sessionWindow?.resetsAt ?? null;
  const targetWeeklyResetAt = pool.weeklyWindow?.resetsAt ?? null;
  const resets = [targetSessionResetAt, targetWeeklyResetAt]
    .map(parseTimestamp)
    .filter((value) => value !== null);
  const safetyMarginMs = epochMarginMs(safetyMarginMins);

  return {
    leaseId: randomUUID(),
    poolId: pool.poolId,
    providerInstanceId: pool.providerInstanceId,
    leasedAt: now.toISOString(),
    targetSessionResetAt,
    targetWeeklyResetAt,
    hardDeadlineAt: resets.length ? new Date(Math.min(...resets) - safetyMarginMs).toISOString() : null,
    safetyMarginMs,
  };
}

export function verifyEpochLease(
  lease: EpochLease,
  livePool: QuotaPoolSnapshot | null | undefined,
  now = new Date(),
  reserveFloorPercent?: number,
): EpochCheckResult {
  const deadline = parseTimestamp(lease.hardDeadlineAt);
  const remainingBeforeDeadlineMs = deadline === null ? null : Math.max(0, deadline - now.getTime());
  const stop = (reason: EpochStopReason, detail: string): EpochCheckResult => ({
    allowed: false, shouldHaltImmediately: true, reason, detail, remainingBeforeDeadlineMs,
  });

  if (
    !livePool?.enabled || livePool.status !== "ready" || livePool.poolId !== lease.poolId
    || livePool.providerInstanceId !== lease.providerInstanceId
  ) {
    return stop("HARD_STOP_POOL_UNAVAILABLE", "The leased pool instance is no longer ready.");
  }

  const floor = reserveFloor(reserveFloorPercent);
  if ([livePool.weeklyWindow, livePool.sessionWindow].some((window) => window && window.remainingPercent <= floor)) {
    return stop("HARD_STOP_RESERVE_SHIELD", `Live quota has reached the ${floor}% reserve floor.`);
  }
  if (lease.targetWeeklyResetAt !== null && livePool.weeklyWindow?.resetsAt !== lease.targetWeeklyResetAt) {
    return stop("HARD_STOP_WEEKLY_EPOCH_ADVANCED", "The leased weekly reset timestamp changed or disappeared.");
  }
  if (lease.targetSessionResetAt !== null && livePool.sessionWindow?.resetsAt !== lease.targetSessionResetAt) {
    return stop("HARD_STOP_SESSION_EPOCH_ADVANCED", "The leased session reset timestamp changed or disappeared.");
  }
  if (remainingBeforeDeadlineMs === 0) {
    return stop("HARD_STOP_SAFETY_MARGIN", "The leased reset safety deadline has been reached.");
  }

  return {
    allowed: true,
    shouldHaltImmediately: false,
    reason: "OK",
    detail: "The leased epochs and reserve shield are clear.",
    remainingBeforeDeadlineMs,
  };
}
