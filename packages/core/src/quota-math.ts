export const MINUTE_MS = 60_000;
export const MINIMUM_RESERVE = 20;
export const MINIMUM_EPOCH_MARGIN = 2;

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
