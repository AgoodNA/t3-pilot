import type { CockpitActions } from "../api";
import type { PilotStatusSummary, RouteDecision } from "../types";
import { PaceCurve } from "./PaceCurve";
import { PoolCard } from "./PoolCard";
import { Panel, Pill } from "./primitives";
import { RouterTester } from "./RouterTester";

export function PacingView({ status, now, actions, initialRoute, contextKey }: {
  status: PilotStatusSummary; now: number; actions: CockpitActions; initialRoute?: RouteDecision | null; contextKey?: string;
}) {
  const floor = status.config.pacing.reserveFloorPercent ?? 20;
  const locked = status.pacing.filter((entry) => entry.shieldLocked).length;
  const harvesting = status.pacing.filter((entry) => entry.harvestMode === "FULL_THROTTLE_HARVEST" || entry.harvestMode === "EXPIRING_5H_HARVEST").length;

  return (
    <div className="view view-pacing">
      <Panel
        eyebrow="01 · Quota Pool Telemetry" title="Coupled 7d × 5h Pacing" icon="gauge"
        actions={(
          <div className="panel-pills">
            <Pill tone="danger" icon="shield">{floor}% RESERVE FLOOR</Pill>
            <Pill tone={harvesting ? "ok" : "neutral"} icon="bolt">{harvesting} HARVESTING</Pill>
            <Pill tone={locked ? "danger" : "neutral"} icon="lock">{locked} LOCKED</Pill>
          </div>
        )}
      >
        <div className="pool-grid">
          {status.pools.map((pool) => (
            <PoolCard
              key={`${pool.poolId}-${pool.providerInstanceId}`} pool={pool} now={now} floor={floor}
              pacing={status.pacing.find((entry) => entry.poolId === pool.poolId && entry.providerInstanceId === pool.providerInstanceId)}
            />
          ))}
          {status.pools.length === 0 ? <p className="empty-hint">No quota pools reported by the daemon yet.</p> : null}
        </div>
      </Panel>

      <div className="split">
        <Panel eyebrow="02 · Live Pace Curve" title="168h Weekly Burn vs Ideal" icon="gauge" className="split-wide">
          <PaceCurve pools={status.pools} pacing={status.pacing} floor={floor} />
        </Panel>
        <Panel eyebrow="03 · Smart Router" title="Task-Fit × Surplus Router" icon="route" className="split-narrow">
          <RouterTester actions={actions} initial={initialRoute ?? null} refreshKey={contextKey} />
        </Panel>
      </div>
    </div>
  );
}
