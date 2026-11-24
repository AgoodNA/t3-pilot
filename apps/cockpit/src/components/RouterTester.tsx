import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CockpitActions } from "../api";
import { CATEGORY_LABELS } from "../engine/router";
import { errorMessage, poolMeta } from "../format";
import type { RouteDecision } from "../types";
import { Icon } from "./Icons";
import { CodeBlock, InlineError, Pill } from "./primitives";

export const ROUTER_PRESETS = [
  "Polish Cockpit React UI with animated SVG gauges",
  "Debug SQLite WAL parser race in the daemon",
  "Translate README into Chinese and fix typos",
  "Architect a multi-agent orchestration spec",
  "Write Vitest tests for the epoch lock",
];

export function configureSnippet(decision: RouteDecision): string {
  if (!decision.selected) return "// Every candidate is locked by the 20% Reserve Shield — no automatic route.";
  return JSON.stringify({ threadId: "<idle-thread-id>", ...decision.selected.t3ThreadConfigurePayload }, null, 2);
}

export function RouteResult({ decision }: { decision: RouteDecision }) {
  const max = Math.max(0.0001, ...decision.ranked.map((route) => route.compositeScore));
  const category = CATEGORY_LABELS[decision.category];
  const winner = decision.selected;
  return (
    <div className="route-result">
      <div className="route-summary">
        <div className="route-cell">
          <span className="eyebrow">Task archetype</span>
          <span className="route-category" title={category.long}>{category.short}</span>
          <code className="route-code">{decision.category}</code>
        </div>
        <div className={`route-cell winner${winner ? "" : " none"}`}>
          <span className="eyebrow">Winning route</span>
          {winner ? (
            <>
              <span className="winner-model" style={{ ["--pool" as string]: poolMeta(winner.candidate.poolId).color }}>
                <Icon name="route" size={15} />{winner.candidate.label}
              </span>
              <span className="muted num">{winner.candidate.id} · {poolMeta(winner.candidate.poolId).label} · score {winner.compositeScore.toFixed(3)}</span>
            </>
          ) : (
            <span className="text-danger"><Icon name="lock" size={14} /> All pools shield-locked</span>
          )}
        </div>
      </div>

      <ol className="rank-list" aria-label="Ranked model candidates">
        {decision.ranked.map((route, index) => {
          const meta = poolMeta(route.candidate.poolId);
          return (
            <li key={`${route.candidate.id}-${route.candidate.providerInstanceId}`} className={`rank-row${route.eligible ? "" : " blocked"}${route === winner ? " top" : ""}`} style={{ ["--pool" as string]: meta.color }}>
              <span className="rank-index num">{String(index + 1).padStart(2, "0")}</span>
              <div className="rank-main">
                <div className="rank-head">
                  <span className="rank-model">{route.candidate.label}</span>
                  <span className="rank-pool">{meta.short}</span>
                  {!route.eligible ? <Pill tone="danger" icon="lock" title={route.blockedReason ?? undefined}>SHIELD LOCKOUT</Pill> : null}
                  {route.manualOverrideApplied ? <Pill tone="warn">MANUAL OVERRIDE</Pill> : null}
                  <span className="rank-score num">{route.compositeScore.toFixed(3)}</span>
                </div>
                <div className="rank-bar"><span style={{ width: `${(route.compositeScore / max) * 100}%` }} /></div>
                <div className="rank-factors num">
                  <span title="Task affinity">A {route.taskAffinity.toFixed(2)}</span>
                  <span className="op">×</span>
                  <span title="Burnable surplus factor (effective burnable / 80)">S {route.surplusFactor.toFixed(2)}</span>
                  <span className="op">×</span>
                  <span title="Reset urgency weight (1 + 0.5·κ)">U {route.urgencyWeight.toFixed(2)}</span>
                  {route.blockedReason ? <span className="rank-blocked">{route.blockedReason}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {decision.warnings.map((warning) => <p key={warning} className="warning-line"><Icon name="alert" size={13} />{warning}</p>)}

      <CodeBlock title="t3_thread_configure" lang="json" code={configureSnippet(decision)} />
    </div>
  );
}

export function RouterTester({ actions, initial = null, refreshKey }: {
  actions: CockpitActions; initial?: RouteDecision | null; refreshKey?: string;
}) {
  const [task, setTask] = useState(initial?.task ?? ROUTER_PRESETS[0]!);
  const taskRef = useRef(task);
  taskRef.current = task;
  const [decision, setDecision] = useState<RouteDecision | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Describe a task to route.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDecision(await actions.route(trimmed));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  // Re-score whenever the data source or demo scenario changes so the ranking never goes stale.
  useEffect(() => {
    if (refreshKey !== undefined) void run(taskRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(task);
  };

  return (
    <div className="router">
      <div className="chip-row" aria-label="Preset tasks">
        {ROUTER_PRESETS.map((preset) => (
          <button key={preset} type="button" className={`chip${preset === task ? " active" : ""}`} onClick={() => { setTask(preset); void run(preset); }}>
            {preset}
          </button>
        ))}
      </div>
      <form className="router-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="route-task">Task description</label>
        <input id="route-task" className="input" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe a task, e.g. “refactor the CLI parser”" />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <Icon name="route" size={14} />{busy ? "Scoring…" : "Route"}
        </button>
      </form>
      <InlineError message={error} />
      {decision ? <RouteResult decision={decision} /> : (
        <p className="empty-hint">Pick a preset or describe a task — the router scores <b>Affinity × Surplus × Urgency</b> across every pool and locks out anything under the 20% floor.</p>
      )}
    </div>
  );
}
