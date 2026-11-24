import type { CockpitMode } from "../api";
import { DEMO_SCENARIOS, type DemoScenarioId } from "../engine/demo";
import { fmtCountdown, fmtClock, msUntil } from "../format";
import type { HumanPreemptionReport } from "../types";
import { BrandMark, Icon } from "./Icons";

export type Theme = "dark" | "light";

export function humanIndicator(report: HumanPreemptionReport | null, now: number) {
  const state = report?.state ?? "CLEAR_FOR_PILOT";
  if (state === "PREEMPTED_ACTIVE_HUMAN_TURN") {
    return { tone: "danger" as const, label: "HUMAN TURN ACTIVE — YIELDED", pulse: true };
  }
  if (state === "COOLDOWN_AFTER_HUMAN_TURN") {
    const remaining = msUntil(report?.resumeAvailableAt, now) ?? report?.resumeInMs ?? 0;
    return {
      tone: "warn" as const,
      label: `${report?.cooldownMinutes ?? 15}M COOLDOWN · ${fmtCountdown(Math.max(0, remaining)).replace(/^00:/, "")}`,
      pulse: false,
    };
  }
  return { tone: "ok" as const, label: "CLEAR FOR PILOT", pulse: false };
}

export function CommandBar(props: {
  mode: CockpitMode;
  connecting: boolean;
  onSwitchMode: (mode: CockpitMode) => void;
  scenarioId: DemoScenarioId;
  onScenario: (id: DemoScenarioId) => void;
  human: HumanPreemptionReport | null;
  onCycleHuman: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  generatedAt: string | null;
  stale: boolean;
  now: number;
}) {
  const { mode, connecting, onSwitchMode, scenarioId, onScenario, human, onCycleHuman, theme, onToggleTheme, generatedAt, stale, now } = props;
  const indicator = humanIndicator(human, now);
  const scenario = DEMO_SCENARIOS.find((entry) => entry.id === scenarioId);
  const humanTitle = `${human?.reason ?? "No human activity detected."}${mode === "demo" ? " — click to simulate the next preemption state." : ""}`;

  return (
    <header className="command-bar">
      <div className="command-row">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">t3-pilot <span className="brand-sep">/</span> <span className="brand-product">Cockpit</span></span>
            <span className="brand-sub">Coupled 7d × 5h Governor · 20% Reserve Shield</span>
          </div>
        </div>

        <div className="command-controls">
          <div className="conn-switch" role="radiogroup" aria-label="Data source">
            <button
              type="button" role="radio" aria-checked={mode === "live"} disabled={connecting}
              className={`conn-option${mode === "live" ? " active live" : ""}`} onClick={() => mode !== "live" && onSwitchMode("live")}
              title="Connect to `npx t3-pilot up` on this origin"
            >
              <span className={`conn-dot${mode === "live" ? (stale ? " stale" : " on") : ""}`} />
              {connecting ? "CONNECTING…" : "LIVE T3 DAEMON"}
            </button>
            <button
              type="button" role="radio" aria-checked={mode === "demo"}
              className={`conn-option${mode === "demo" ? " active demo" : ""}`} onClick={() => mode !== "demo" && onSwitchMode("demo")}
              title="Stateful offline simulation — works on GitHub Pages"
            >
              <Icon name="flask" size={12} />
              INTERACTIVE DEMO
            </button>
          </div>

          <button
            type="button" className={`human-pill tone-${indicator.tone}${mode === "demo" ? " clickable" : ""}`}
            onClick={mode === "demo" ? onCycleHuman : undefined} title={humanTitle} aria-label={`Human preemption: ${indicator.label}`}
            aria-disabled={mode !== "demo"}
          >
            {indicator.pulse ? <span className="pulse-dot" aria-hidden="true" /> : <Icon name={indicator.tone === "ok" ? "radio" : "hourglass"} size={13} />}
            <span className="num">{indicator.label}</span>
          </button>

          <button type="button" className="icon-btn" onClick={onToggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
            <span className="icon-btn-label">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </div>

      {mode === "demo" ? (
        <div className="scenario-row">
          <span className="scenario-label"><Icon name="flask" size={12} />Scenario</span>
          <div className="scenario-chips" role="radiogroup" aria-label="Demo scenario presets">
            {DEMO_SCENARIOS.map((entry) => (
              <button
                key={entry.id} type="button" role="radio" aria-checked={entry.id === scenarioId}
                className={`scenario-chip${entry.id === scenarioId ? " active" : ""}`} onClick={() => onScenario(entry.id)} title={entry.tagline}
              >
                <span className="scenario-index num">{entry.index}</span>
                {entry.label}
              </button>
            ))}
          </div>
          {scenario ? <p className="scenario-tagline">{scenario.tagline}</p> : null}
        </div>
      ) : (
        <div className="scenario-row live-row">
          <span className="scenario-label"><Icon name="radio" size={12} />Telemetry</span>
          <span className="live-meta num">
            {stale ? "STALE · last good snapshot " : "Snapshot "}{fmtClock(generatedAt)} · polled every 10s from <code>/api/status</code>
          </span>
        </div>
      )}
    </header>
  );
}
