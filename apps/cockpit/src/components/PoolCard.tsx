import { fmtCountdown, fmtPct, fmtRatio, fmtSigned, HARVEST_META, msUntil, poolMeta } from "../format";
import type { PoolPacingEvaluation, QuotaPoolSnapshot } from "../types";
import { Icon } from "./Icons";
import { Meter, Pill, Stat } from "./primitives";

function resetLabel(resetsAt: string | null | undefined, now: number) {
  const ms = msUntil(resetsAt, now);
  if (ms === null) return <span className="muted">no resetAt reported</span>;
  if (ms <= 0) return <span className="text-ok">reset · restored to 100%</span>;
  return <>resets in <b className="num">{fmtCountdown(ms)}</b></>;
}

export function PoolCard({ pool, pacing, now, floor }: {
  pool: QuotaPoolSnapshot; pacing: PoolPacingEvaluation | undefined; now: number; floor: number;
}) {
  const meta = poolMeta(pool.poolId);
  const mode = pacing?.harvestMode ?? "EXTERNAL_UNMETERED";
  const harvest = HARVEST_META[mode];
  const delta = pacing?.paceDeltaPercent ?? null;
  const ready = pool.enabled && pool.status === "ready" && pool.source !== "unavailable";

  return (
    <article className={`pool-card mode-${mode.toLowerCase()}`} style={{ ["--pool" as string]: meta.color }}>
      <header className="pool-head">
        <span className="pool-glyph num" aria-hidden="true">{meta.short}</span>
        <div className="pool-titles">
          <h3 className="pool-name">{meta.label}</h3>
          <span className="pool-sub num">{pool.providerInstanceId} · {pool.source}</span>
        </div>
        <Pill tone={harvest.tone} solid title={harvest.hint} icon={mode === "LOCKED_SHIELD" ? "lock" : mode === "FULL_THROTTLE_HARVEST" ? "bolt" : undefined}>
          {harvest.label}
        </Pill>
      </header>

      {mode === "EXTERNAL_UNMETERED" && !pool.sessionWindow && !pool.weeklyWindow ? (
        <p className="pool-external">
          Usage is metered outside T3 Code.{" "}
          {pool.externalUsageUrl ? <a href={pool.externalUsageUrl} target="_blank" rel="noreferrer">Open usage dashboard</a> : null}
        </p>
      ) : (
        <div className="pool-meters">
          <Meter
            label="5h Session Remaining" value={pacing?.sessionRemainingPercent ?? pool.sessionWindow?.remainingPercent ?? null}
            floor={floor} color={meta.color} sublabel={resetLabel(pool.sessionWindow?.resetsAt, now)}
          />
          <Meter
            label="7d Weekly Remaining" value={pacing?.weeklyRemainingPercent ?? pool.weeklyWindow?.remainingPercent ?? null}
            floor={floor} color={meta.color} sublabel={resetLabel(pool.weeklyWindow?.resetsAt, now)}
          />
        </div>
      )}

      <div className="stat-grid">
        <Stat label="Burnable now" value={fmtPct(pacing?.effectiveBurnablePercent ?? null)} hint="min(weekly surplus, session surplus) above the reserve floor" tone={pacing?.effectiveBurnablePercent ? "ok" : undefined} />
        <Stat label="κ coupling" value={fmtRatio(pacing?.couplingRatio)} hint="S_week / (⌈T_left / 5h⌉ · C_5h) — ≥ 0.85 enters Full-Throttle" tone={(pacing?.couplingRatio ?? 0) >= 0.85 ? "ok" : undefined} />
        <Stat label="Pace Δ" value={fmtSigned(delta)} hint="Weekly remaining minus the ideal linear 100% → 20% burn curve" tone={delta === null ? undefined : delta >= 0 ? "ok" : "danger"} />
        <Stat label="5h windows left" value={pacing?.remaining5hWindowsCount ?? "—"} hint="⌈time to weekly reset / 5h⌉" />
      </div>

      <p className={`pool-reason${pacing?.shieldLocked ? " locked" : ""}`}>
        <Icon name={pacing?.shieldLocked ? "lock" : !ready ? "alert" : "gauge"} size={13} />
        {!ready ? pool.unavailableReason ?? `Pool status: ${pool.status}` : pacing?.harvestReason ?? "Awaiting telemetry."}
      </p>
    </article>
  );
}
