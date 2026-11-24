import { useId, useMemo, useState, type PointerEvent } from "react";
import { HOUR_MS, WEEK_HOURS, clamp } from "../engine/pacing";
import { fmtPct, fmtSigned, poolMeta } from "../format";
import type { PoolPacingEvaluation, QuotaPoolSnapshot } from "../types";

const W = 720;
const H = 300;
const L = 46;
const R = 18;
const T = 18;
const B = 34;
const PW = W - L - R;
const PH = H - T - B;

const x = (hour: number) => L + (clamp(hour, 0, WEEK_HOURS) / WEEK_HOURS) * PW;
const y = (pct: number) => T + (1 - clamp(pct, 0, 100) / 100) * PH;

export interface PacePoint {
  poolId: string;
  label: string;
  short: string;
  color: string;
  hour: number;
  weekly: number;
  ideal: number;
  delta: number;
  mode: string;
}

/** Projects each metered pool onto the 168h weekly cycle. Exported for unit tests. */
export function pacePoints(pools: QuotaPoolSnapshot[], pacing: PoolPacingEvaluation[]): PacePoint[] {
  return pools.flatMap((pool) => {
    const evaluation = pacing.find((entry) => entry.poolId === pool.poolId && entry.providerInstanceId === pool.providerInstanceId);
    if (!evaluation || evaluation.weeklyRemainingPercent === null || evaluation.timeToWeeklyResetMs === null) return [];
    const durationHours = (pool.weeklyWindow?.windowDurationMins ?? WEEK_HOURS * 60) / 60;
    const elapsed = clamp(durationHours - evaluation.timeToWeeklyResetMs / HOUR_MS, 0, durationHours);
    const floor = evaluation.reserveFloorPercent;
    const hour = (elapsed / durationHours) * WEEK_HOURS;
    const ideal = evaluation.idealWeeklyRemainingPercent ?? 100 - (hour / WEEK_HOURS) * (100 - floor);
    const meta = poolMeta(pool.poolId);
    return [{
      poolId: pool.poolId, label: meta.label, short: meta.short, color: meta.color, hour,
      weekly: evaluation.weeklyRemainingPercent, ideal, delta: evaluation.paceDeltaPercent ?? evaluation.weeklyRemainingPercent - ideal,
      mode: evaluation.harvestMode,
    }];
  });
}

export function PaceCurve({ pools, pacing, floor }: { pools: QuotaPoolSnapshot[]; pacing: PoolPacingEvaluation[]; floor: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const points = useMemo(() => pacePoints(pools, pacing), [pools, pacing]);

  const labels = useMemo(() => {
    const placed = points
      .map((point) => {
        const right = x(point.hour) < W - 130;
        return { point, lx: x(point.hour) + (right ? 12 : -12), ly: y(point.weekly) - 10, anchor: right ? ("start" as const) : ("end" as const) };
      })
      .sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < placed.length; i++) {
      const prev = placed[i - 1]!;
      const cur = placed[i]!;
      if (cur.ly - prev.ly < 16 && Math.abs(cur.lx - prev.lx) < 140) cur.ly = prev.ly + 16;
    }
    return placed;
  }, [points]);

  const idealAt = (hour: number) => 100 - (hour / WEEK_HOURS) * (100 - floor);
  const nowHour = points[0]?.hour ?? null;
  const sharedNow = nowHour !== null && points.every((point) => Math.abs(point.hour - nowHour) < 0.25);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const px = ((event.clientX - rect.left) / rect.width) * W;
    setHoverHour(clamp(((px - L) / PW) * WEEK_HOURS, 0, WEEK_HOURS));
  };

  return (
    <div className="pace-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`} className="pace-svg" role="img"
        aria-label={`Weekly pace curve: ${points.map((point) => `${point.label} ${fmtPct(point.weekly)} remaining, ${fmtSigned(point.delta)} vs ideal`).join("; ") || "no metered pools"}`}
        onPointerMove={onMove} onPointerLeave={() => setHoverHour(null)}
      >
        <defs>
          <pattern id={`hatch-${uid}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--danger)" strokeWidth="1.4" opacity="0.45" />
          </pattern>
          <linearGradient id={`surplus-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ok)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--ok)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* zones */}
        <polygon points={`${x(0)},${y(100)} ${x(WEEK_HOURS)},${y(floor)} ${x(WEEK_HOURS)},${y(100)}`} fill={`url(#surplus-${uid})`} />
        <polygon points={`${x(0)},${y(100)} ${x(WEEK_HOURS)},${y(floor)} ${x(0)},${y(floor)}`} fill="var(--warn)" opacity="0.05" />
        <rect x={x(0)} y={y(floor)} width={PW} height={y(0) - y(floor)} fill="var(--danger)" opacity="0.08" />
        <rect x={x(0)} y={y(floor)} width={PW} height={y(0) - y(floor)} fill={`url(#hatch-${uid})`} />
        <line x1={x(0)} x2={x(WEEK_HOURS)} y1={y(floor)} y2={y(floor)} stroke="var(--danger)" strokeWidth="1.5" />

        {/* grid */}
        {[0, 20, 40, 60, 80, 100].map((pct) => (
          <g key={`y${pct}`}>
            <line x1={L} x2={W - R} y1={y(pct)} y2={y(pct)} className="grid-line" />
            <text x={L - 8} y={y(pct) + 3.5} textAnchor="end" className="axis-text">{pct}%</text>
          </g>
        ))}
        {Array.from({ length: 8 }, (_, index) => index * 24).map((hour) => (
          <g key={`x${hour}`}>
            <line x1={x(hour)} x2={x(hour)} y1={T} y2={H - B} className="grid-line" />
            <text x={x(hour)} y={H - B + 16} textAnchor="middle" className="axis-text">{hour}h</text>
          </g>
        ))}
        {Array.from({ length: 7 }, (_, index) => index).map((day) => (
          <text key={`d${day}`} x={x(day * 24 + 12)} y={H - 4} textAnchor="middle" className="axis-text dim">D{day + 1}</text>
        ))}

        <text x={x(2)} y={y(floor) + 13} className="zone-text danger">EMERGENCY RESERVE SHIELD · 0–{floor}%</text>
        <text x={x(WEEK_HOURS) - 6} y={y(96)} textAnchor="end" className="zone-text ok">AHEAD OF PACE · SURPLUS</text>
        <text x={x(4)} y={y(floor + 6)} className="zone-text warn">BEHIND PACE</text>

        {/* ideal burn */}
        <line x1={x(0)} y1={y(100)} x2={x(WEEK_HOURS)} y2={y(floor)} className="ideal-line" />
        <text x={x(40)} y={y(idealAt(40)) - 7} className="zone-text ideal" transform={`rotate(${(Math.atan2(y(floor) - y(100), PW) * 180) / Math.PI} ${x(40)} ${y(idealAt(40)) - 7})`}>
          IDEAL BURN 100% → {floor}%
        </text>

        {sharedNow && nowHour !== null ? (
          <g>
            <line x1={x(nowHour)} x2={x(nowHour)} y1={T} y2={H - B} className="now-line" />
            <text x={x(nowHour)} y={T - 5} textAnchor="middle" className="now-text">NOW · T+{nowHour.toFixed(1)}h</text>
          </g>
        ) : null}

        {/* pools */}
        {points.map((point) => {
          const dim = focus !== null && focus !== point.poolId;
          return (
            <g key={point.poolId} className="pace-pool" opacity={dim ? 0.25 : 1} style={{ ["--pool" as string]: point.color }}>
              <line x1={x(0)} y1={y(100)} x2={x(point.hour)} y2={y(point.weekly)} className="trajectory" />
              <line x1={x(point.hour)} x2={x(point.hour)} y1={y(point.ideal)} y2={y(point.weekly)} className={`stem ${point.delta >= 0 ? "ahead" : "behind"}`} />
              <circle cx={x(point.hour)} cy={y(point.ideal)} r="3" className="ideal-dot" />
              <circle cx={x(point.hour)} cy={y(point.weekly)} r="9" className="marker-halo" />
              <circle cx={x(point.hour)} cy={y(point.weekly)} r="5" className="marker" />
              <title>{`${point.label}: ${fmtPct(point.weekly)} remaining · ideal ${fmtPct(point.ideal)} · ${fmtSigned(point.delta)} · ${point.mode}`}</title>
            </g>
          );
        })}
        {labels.map(({ point, lx, ly, anchor }) => (
          <text
            key={`label-${point.poolId}`} x={lx} y={ly} textAnchor={anchor} className={`marker-label ${point.delta >= 0 ? "ahead" : "behind"}`}
            opacity={focus !== null && focus !== point.poolId ? 0.25 : 1}
          >
            <tspan className="marker-short" style={{ fill: point.color }}>{point.short}</tspan> {fmtSigned(point.delta)}
          </text>
        ))}

        {hoverHour !== null ? (
          <g className="crosshair" pointerEvents="none">
            <line x1={x(hoverHour)} x2={x(hoverHour)} y1={T} y2={H - B} />
            <circle cx={x(hoverHour)} cy={y(idealAt(hoverHour))} r="3.5" />
            <g transform={`translate(${Math.min(x(hoverHour) + 8, W - R - 132)} ${T + 6})`}>
              <rect width="128" height="34" rx="6" />
              <text x="8" y="14">T+{hoverHour.toFixed(1)}h · D{Math.min(7, Math.floor(hoverHour / 24) + 1)}</text>
              <text x="8" y="27">ideal {idealAt(hoverHour).toFixed(1)}% remaining</text>
            </g>
          </g>
        ) : null}
      </svg>

      <div className="pace-legend">
        {points.length === 0 ? <span className="muted">No metered weekly windows to plot.</span> : null}
        {points.map((point) => (
          <button
            key={point.poolId} type="button" className={`legend-item${focus === point.poolId ? " active" : ""}`}
            onMouseEnter={() => setFocus(point.poolId)} onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(point.poolId)} onBlur={() => setFocus(null)}
            style={{ ["--pool" as string]: point.color }}
          >
            <span className="legend-swatch" />
            <span>{point.label}</span>
            <span className={`num ${point.delta >= 0 ? "text-ok" : "text-danger"}`}>{fmtSigned(point.delta)}</span>
          </button>
        ))}
        <span className="legend-key"><span className="key-dash" />ideal</span>
        <span className="legend-key"><span className="key-band" />reserve</span>
      </div>
    </div>
  );
}
