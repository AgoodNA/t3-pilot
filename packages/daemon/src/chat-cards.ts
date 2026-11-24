import type { PilotStatusSummary } from "./types.js";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatRemaining(value: number | null): string {
  return value === null ? "Unmetered" : `${value.toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalMins = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Renders a T3 `html_render`-compliant inline Quota + Guarded Turbo + Sparkle status card.
 * Strictly obeys T3 Code inline frame rules:
 * - No background, card, border, or side padding on html/body/outer container
 * - Uses T3 theme CSS variables (--card, --border, --foreground, --muted-foreground, --primary, --success, --warning, --destructive, --chart-1..6, --radius)
 * - Fluid widths, fixed pixel chart height, zero vh / height:100%
 */
export function renderPilotInlineCardHtml(status: PilotStatusSummary): string {
  const pacingByPool = new Map(status.pacing.map((entry) => [entry.poolId, entry]));
  const floor = status.config.pacing.reserveFloorPercent ?? 20;

  const poolRows = status.pools.map((pool, idx) => {
    const pacing = pacingByPool.get(pool.poolId);
    const sRem = pacing?.sessionRemainingPercent ?? null;
    const wRem = pacing?.weeklyRemainingPercent ?? null;
    const surplus = pacing?.effectiveBurnablePercent ?? 0;
    const mode = pacing?.harvestMode ?? "EXTERNAL_UNMETERED";
    const locked = pacing?.shieldLocked === true;
    const chartVar = `var(--chart-${(idx % 5) + 1})`;
    const toneColor = locked
      ? "var(--destructive)"
      : mode === "FULL_THROTTLE_HARVEST" || mode === "EXPIRING_5H_HARVEST"
        ? "var(--success)"
        : "var(--primary)";

    const sWidth = sRem === null ? 100 : Math.max(0, Math.min(100, sRem));
    const wWidth = wRem === null ? 100 : Math.max(0, Math.min(100, wRem));

    return `<div class="box pool-card">
      <div class="row-between">
        <div class="pool-title">
          <span class="dot" style="background:${chartVar}"></span>
          <strong>${escapeHtml(pool.poolId)}</strong>
        </div>
        <span class="pill" style="color:${toneColor};border-color:${toneColor}">${escapeHtml(mode)}</span>
      </div>
      <div class="bars">
        <div class="bar-group">
          <div class="row-between tiny">
            <span>5h Window (${escapeHtml(formatDuration(pacing?.timeToSessionResetMs ?? null))})</span>
            <span class="mono">${escapeHtml(formatRemaining(sRem))}</span>
          </div>
          <div class="track">
            <div class="floor-tick" style="left:${floor}%"></div>
            <div class="fill" style="width:${sWidth.toFixed(1)}%;background:${sRem === null ? "var(--muted-foreground)" : chartVar}"></div>
          </div>
        </div>
        <div class="bar-group">
          <div class="row-between tiny">
            <span>7d Weekly (${escapeHtml(formatDuration(pacing?.timeToWeeklyResetMs ?? null))})</span>
            <span class="mono">${escapeHtml(formatRemaining(wRem))}</span>
          </div>
          <div class="track">
            <div class="floor-tick" style="left:${floor}%"></div>
            <div class="fill" style="width:${wWidth.toFixed(1)}%;background:${wRem === null ? "var(--muted-foreground)" : toneColor}"></div>
          </div>
        </div>
      </div>
      <div class="row-between tiny muted">
        <span>Burnable above ${floor}% floor: <strong class="fg mono">${surplus.toFixed(1)}%</strong></span>
        <span>${escapeHtml(pacing?.paceDeltaPercent != null ? `Pace ${pacing.paceDeltaPercent >= 0 ? "+" : ""}${pacing.paceDeltaPercent.toFixed(1)}%` : "External OAuth")}</span>
      </div>
    </div>`;
  }).join("\n");

  // Build SVG points for metered pools on the 168h Live Pace Curve (fixed 160px height)
  const plotLeft = 40;
  const plotRight = 660;
  const plotTop = 18;
  const plotBottom = 132;
  const xAt = (frac: number) => plotLeft + Math.max(0, Math.min(1, frac)) * (plotRight - plotLeft);
  const yAt = (pct: number) => plotBottom - (Math.max(0, Math.min(100, pct)) / 100) * (plotBottom - plotTop);
  const floorY = yAt(floor);

  const poolMarkers = status.pools.flatMap((pool, idx) => {
    const pacing = pacingByPool.get(pool.poolId);
    if (!pacing || pacing.weeklyRemainingPercent === null || pacing.timeToWeeklyResetMs === null) return [];
    const durationMs = (pool.weeklyWindow?.windowDurationMins ?? 10080) * 60_000;
    const elapsedFrac = durationMs > 0 ? 1 - pacing.timeToWeeklyResetMs / durationMs : 0;
    const cx = xAt(elapsedFrac);
    const cy = yAt(pacing.weeklyRemainingPercent);
    const color = `var(--chart-${(idx % 5) + 1})`;
    return [`<g>
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${color}" stroke="var(--card)" stroke-width="2" />
      <text x="${Math.min(plotRight - 70, cx + 8).toFixed(1)}" y="${Math.max(plotTop + 10, cy - 6).toFixed(1)}" fill="var(--foreground)" font-size="10.5" font-family="var(--font-mono, monospace)">${escapeHtml(pool.poolId.replace("antigravity-", "ag-"))} ${pacing.weeklyRemainingPercent.toFixed(0)}%</text>
    </g>`];
  }).join("\n");

  const denyCount = status.shield.rules.filter((r) => r.enabled && r.decision === "deny").length;
  const askCount = status.shield.rules.filter((r) => r.enabled && r.decision === "force_ask").length;
  const pendingSparkles = status.sparkles.filter((s) => s.status === "pending").length;
  const humanState = status.humanPreemption?.state ?? "CLEAR_FOR_PILOT";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; color: var(--foreground); font-family: var(--font-sans, system-ui, -apple-system, sans-serif); }
  .stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
  .box { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius, 10px); padding: 16px; }
  .pool-card { display: flex; flex-direction: column; gap: 10px; }
  .row-between { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pool-title { display: flex; align-items: center; gap: 7px; font-size: 0.88rem; }
  .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
  .pill { font-size: 0.68rem; font-weight: 600; font-family: var(--font-mono, monospace); padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); }
  .bars { display: flex; flex-direction: column; gap: 7px; }
  .bar-group { display: flex; flex-direction: column; gap: 3px; }
  .track { position: relative; height: 7px; background: var(--secondary); border-radius: 999px; overflow: hidden; }
  .fill { height: 7px; border-radius: 999px; }
  .floor-tick { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--destructive); z-index: 2; }
  .tiny { font-size: 0.74rem; }
  .muted { color: var(--muted-foreground, var(--muted)); }
  .fg { color: var(--foreground); }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
  .chart-wrap { width: 100%; height: 160px; }
  .chart-head { margin-bottom: 8px; }
  .status-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .stat-label { font-size: 0.72rem; color: var(--muted-foreground, var(--muted)); margin-bottom: 4px; }
  .stat-val { font-size: 0.88rem; font-weight: 600; }
</style>
</head>
<body>
  <div class="stack">
    <div class="grid">
      ${poolRows}
    </div>
    <div class="box">
      <div class="row-between chart-head">
        <strong style="font-size:0.86rem">Coupled 7d × 5h Live Pace Curve (168h Cycle → ${floor}% Reserve Floor)</strong>
        <span class="tiny muted mono">Ideal Glide: 100% → ${floor}%</span>
      </div>
      <div class="chart-wrap">
        <svg viewBox="0 0 680 160" width="100%" height="160" preserveAspectRatio="none" role="img" aria-label="Weekly quota live pace curve">
          <rect x="${plotLeft}" y="${floorY.toFixed(1)}" width="${plotRight - plotLeft}" height="${(plotBottom - floorY).toFixed(1)}" fill="var(--destructive)" opacity="0.12" />
          <line x1="${plotLeft}" y1="${plotTop}" x2="${plotRight}" y2="${plotTop}" stroke="var(--border)" stroke-dasharray="3 3" />
          <line x1="${plotLeft}" y1="${yAt(60).toFixed(1)}" x2="${plotRight}" y2="${yAt(60).toFixed(1)}" stroke="var(--border)" stroke-dasharray="3 3" />
          <line x1="${plotLeft}" y1="${floorY.toFixed(1)}" x2="${plotRight}" y2="${floorY.toFixed(1)}" stroke="var(--destructive)" stroke-width="1.5" stroke-dasharray="4 3" />
          <line x1="${plotLeft}" y1="${yAt(100).toFixed(1)}" x2="${plotRight}" y2="${floorY.toFixed(1)}" stroke="var(--primary)" stroke-width="2" stroke-dasharray="6 4" />
          <text x="6" y="${(plotTop + 4).toFixed(1)}" fill="var(--muted-foreground, currentColor)" font-size="10" font-family="var(--font-mono, monospace)">100%</text>
          <text x="10" y="${(floorY + 3).toFixed(1)}" fill="var(--destructive)" font-size="10" font-family="var(--font-mono, monospace)">${floor}%</text>
          <text x="${plotLeft}" y="150" fill="var(--muted-foreground, currentColor)" font-size="10" font-family="var(--font-mono, monospace)">0h (Cycle Start)</text>
          <text x="${(plotLeft + plotRight) / 2 - 20}" y="150" fill="var(--muted-foreground, currentColor)" font-size="10" font-family="var(--font-mono, monospace)">84h</text>
          <text x="${plotRight - 72}" y="150" fill="var(--muted-foreground, currentColor)" font-size="10" font-family="var(--font-mono, monospace)">168h (resetAt)</text>
          ${poolMarkers}
        </svg>
      </div>
    </div>
    <div class="status-strip">
      <div class="box">
        <div class="stat-label">Guarded Turbo Shield</div>
        <div class="stat-val mono">${escapeHtml(status.shield.mode.toUpperCase())} · ${denyCount} deny / ${askCount} ask</div>
      </div>
      <div class="box">
        <div class="stat-label">Human-First Preemption</div>
        <div class="stat-val mono">${escapeHtml(humanState)}</div>
      </div>
      <div class="box">
        <div class="stat-label">Sparkle Queue &amp; Lease</div>
        <div class="stat-val mono">${pendingSparkles} pending · ${escapeHtml(status.runtimeState.activeRun ? "ACTIVE" : "IDLE")}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
