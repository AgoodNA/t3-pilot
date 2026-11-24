/**
 * Faithful browser port of `packages/core/src/pacing-engine.ts` (Coupled 7d × 5h Harvest Law).
 * Used by Interactive Demo mode; Live mode always shows the daemon's own evaluation.
 */
import type { PacingConfig, PoolPacingEvaluation, QuotaPoolSnapshot } from "../types";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const MINIMUM_RESERVE = 20;
export const MINIMUM_EPOCH_MARGIN = 2;
export const WEEK_HOURS = 168;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function reserveFloor(value?: number): number {
  return clamp(finiteOr(value, MINIMUM_RESERVE), MINIMUM_RESERVE, 100);
}

export function epochMarginMs(value?: number): number {
  return Math.max(MINIMUM_EPOCH_MARGIN, finiteOr(value, MINIMUM_EPOCH_MARGIN)) * MINUTE_MS;
}

export function parseTimestamp(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

export function evaluatePoolPacing(
  pool: QuotaPoolSnapshot,
  now = new Date(),
  config: PacingConfig = {},
): PoolPacingEvaluation {
  const floor = reserveFloor(config.reserveFloorPercent);
  const safetyMargin = epochMarginMs(config.epochSafetyMarginMins);
  const nominalCapacity = finiteOr(config.singleWindowCapacityPercent, 14);
  const capacity = Math.max(1, finiteOr(config.effectiveWindowCapacityPercent, nominalCapacity));
  const fullThrottleThreshold = finiteOr(config.fullThrottleRatioThreshold, 0.85);
  const expiringThresholdMs = finiteOr(config.expiringSessionThresholdMins, 45) * MINUTE_MS;

  const nowMs = now.getTime();
  const weekly = pool.weeklyWindow;
  const session = pool.sessionWindow;
  const weeklyReset = parseTimestamp(weekly?.resetsAt);
  const sessionReset = parseTimestamp(session?.resetsAt);
  const rawWeeklyDeltaMs = weeklyReset === null ? null : weeklyReset - nowMs;
  const rawSessionDeltaMs = sessionReset === null ? null : sessionReset - nowMs;
  const sessionAlreadyReset = rawSessionDeltaMs !== null && rawSessionDeltaMs <= 0;

  const weeklyRemaining = weekly?.remainingPercent ?? null;
  const sessionRemaining = session === null ? null : sessionAlreadyReset ? 100 : session.remainingPercent;
  const weeklySurplus = Math.max(0, (weeklyRemaining ?? 0) - floor);
  const sessionSurplus = session ? Math.max(0, (sessionRemaining ?? 0) - floor) : weeklySurplus;

  const pristineWeeklyCycle = weekly?.resetsAt == null && weekly?.usedPercent === 0;
  const durationMs = weekly ? weekly.windowDurationMins * MINUTE_MS : 0;
  const timeToWeeklyResetMs = rawWeeklyDeltaMs === null
    ? (pristineWeeklyCycle ? durationMs : null)
    : Math.max(0, rawWeeklyDeltaMs);
  const timeToSessionResetMs = rawSessionDeltaMs === null || sessionAlreadyReset ? null : rawSessionDeltaMs;

  const remaining5hWindowsCount = timeToWeeklyResetMs === null
    ? null
    : Math.max(1, Math.ceil(timeToWeeklyResetMs / (300 * MINUTE_MS)));
  const maxDrainCapacityPercent = remaining5hWindowsCount === null ? null : remaining5hWindowsCount * capacity;
  const couplingRatio = maxDrainCapacityPercent === null ? null : weeklySurplus / maxDrainCapacityPercent;
  const elapsed = timeToWeeklyResetMs !== null && durationMs > 0
    ? clamp(1 - timeToWeeklyResetMs / durationMs, 0, 1)
    : null;
  const ideal = elapsed === null ? null : 100 - elapsed * (100 - floor);
  const paceDelta = pristineWeeklyCycle ? 0 : (ideal === null || weeklyRemaining === null ? null : weeklyRemaining - ideal);

  let shieldReason: string | null = null;
  if (weeklyRemaining !== null && weeklyRemaining <= floor) {
    shieldReason = `Weekly quota is at or below the ${floor}% reserve floor.`;
  } else if (sessionRemaining !== null && sessionRemaining <= floor) {
    shieldReason = `Session quota is at or below the ${floor}% reserve floor.`;
  } else if (rawWeeklyDeltaMs !== null && rawWeeklyDeltaMs > 0 && rawWeeklyDeltaMs <= safetyMargin) {
    shieldReason = "Weekly quota is inside the reset safety margin.";
  } else if (rawSessionDeltaMs !== null && rawSessionDeltaMs > 0 && rawSessionDeltaMs <= safetyMargin) {
    shieldReason = "Session quota is inside the reset safety margin.";
  } else if (config.lockUnknownPools && !weekly && !session) {
    shieldReason = "No quota windows are available for this pool.";
  }

  let harvestMode: PoolPacingEvaluation["harvestMode"] = "PRESERVE_WINDOWS";
  let harvestReason = "Weekly surplus can be preserved for later windows.";
  if (shieldReason) {
    harvestMode = "LOCKED_SHIELD";
    harvestReason = shieldReason;
  } else if (pool.source === "external-unmetered" && !weekly && !session) {
    harvestMode = "EXTERNAL_UNMETERED";
    harvestReason = "The provider reports quota outside T3 Code.";
  } else if (weeklySurplus > 0 && couplingRatio !== null && couplingRatio >= fullThrottleThreshold) {
    harvestMode = "FULL_THROTTLE_HARVEST";
    harvestReason = "Weekly surplus is approaching the remaining session capacity.";
  } else if (
    weeklySurplus > 0 && (paceDelta === null || paceDelta >= 0) && sessionSurplus > 0
    && timeToSessionResetMs !== null && timeToSessionResetMs < expiringThresholdMs
  ) {
    harvestMode = "EXPIRING_5H_HARVEST";
    harvestReason = "The current session is expiring and weekly quota is on pace.";
  }

  return {
    poolId: pool.poolId,
    providerInstanceId: pool.providerInstanceId,
    reserveFloorPercent: floor,
    weeklyRemainingPercent: weeklyRemaining,
    sessionRemainingPercent: sessionRemaining,
    weeklyBurnableSurplusPercent: weeklySurplus,
    sessionBurnableSurplusPercent: sessionSurplus,
    effectiveBurnablePercent: shieldReason ? 0 : Math.min(weeklySurplus, sessionSurplus),
    timeToWeeklyResetMs,
    timeToSessionResetMs,
    remaining5hWindowsCount,
    maxDrainCapacityPercent,
    couplingRatio,
    idealWeeklyRemainingPercent: ideal,
    paceDeltaPercent: paceDelta,
    shieldLocked: shieldReason !== null,
    shieldReason,
    harvestMode,
    harvestReason,
  };
}

export function evaluateAllPools(
  pools: readonly QuotaPoolSnapshot[],
  now = new Date(),
  config?: PacingConfig,
): PoolPacingEvaluation[] {
  return pools.map((pool) => evaluatePoolPacing(pool, now, config));
}
