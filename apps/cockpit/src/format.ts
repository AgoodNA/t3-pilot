import type { HarvestMode, QuotaPoolId, ShieldDecision } from "./types";

export function fmtPct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;
}

export function fmtSigned(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : "−"}${Math.abs(rounded).toFixed(digits)}%`;
}

export function fmtRatio(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `3d 04h 12m` for long spans, `04:12:09` under a day. */
export function fmtCountdown(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function msUntil(iso: string | null | undefined, now: number): number | null {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? at - now : null;
}

/** Stable, locale-independent `MM-DD HH:MM` local clock label. */
export function fmtClock(iso: string | null | undefined): string {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtAgo(iso: string | null | undefined, now: number): string {
  const delta = -(msUntil(iso, now) ?? Number.NaN);
  if (!Number.isFinite(delta)) return "—";
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export type Tone = "ok" | "warn" | "danger" | "info" | "accent" | "neutral" | "violet";

export const HARVEST_META: Record<HarvestMode, { tone: Tone; label: string; hint: string }> = {
  FULL_THROTTLE_HARVEST: { tone: "ok", label: "FULL_THROTTLE_HARVEST", hint: "Weekly surplus ≥ κ·remaining 5h drain capacity — burn every window." },
  EXPIRING_5H_HARVEST: { tone: "warn", label: "EXPIRING_5H_HARVEST", hint: "< 45m left in this 5h window and weekly pace has surplus — harvest before it evaporates." },
  PRESERVE_WINDOWS: { tone: "info", label: "PRESERVE_WINDOWS", hint: "Weekly surplus is better spent in later windows." },
  LOCKED_SHIELD: { tone: "danger", label: "LOCKED_SHIELD", hint: "At/below the 20% Emergency Reserve or inside the 2-minute epoch margin." },
  EXTERNAL_UNMETERED: { tone: "violet", label: "EXTERNAL_UNMETERED", hint: "Quota is reported outside T3 Code." },
};

export const DECISION_META: Record<ShieldDecision, { tone: Tone; label: string }> = {
  allow: { tone: "ok", label: "ALLOW" },
  force_ask: { tone: "warn", label: "FORCE_ASK" },
  deny: { tone: "danger", label: "DENY" },
};

export const POOL_META: Record<QuotaPoolId, { label: string; short: string; color: string }> = {
  codex: { label: "Codex", short: "CDX", color: "var(--pool-codex)" },
  "antigravity-gemini": { label: "Antigravity Gemini", short: "GEM", color: "var(--pool-gemini)" },
  "antigravity-claude": { label: "Antigravity Claude", short: "CLD", color: "var(--pool-claude)" },
  "claude-agent": { label: "Claude Agent", short: "CLA", color: "var(--pool-ext)" },
  cursor: { label: "Cursor", short: "CUR", color: "var(--pool-ext)" },
};

export function poolMeta(poolId: string) {
  return POOL_META[poolId as QuotaPoolId] ?? { label: poolId, short: poolId.slice(0, 3).toUpperCase(), color: "var(--pool-ext)" };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
