import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveClient, wantsDemoFromUrl, type CockpitActions, type CockpitClient, type CockpitMode } from "./api";
import { CommandBar, type Theme } from "./components/CommandBar";
import { Icon, type IconName } from "./components/Icons";
import { PacingView } from "./components/PacingView";
import { ShieldView } from "./components/ShieldView";
import { SparkleView } from "./components/SparkleView";
import { DemoBackend, type DemoScenarioId } from "./engine/demo";
import { errorMessage, fmtClock } from "./format";
import type { PilotStatusSummary, RouteDecision } from "./types";

export type ViewId = "pacing" | "sparkles" | "shield";

export const VIEWS: { id: ViewId; index: string; label: string; icon: IconName }[] = [
  { id: "pacing", index: "01", label: "Pacing & Router", icon: "gauge" },
  { id: "sparkles", index: "02", label: "Sparkle Queue", icon: "sparkle" },
  { id: "shield", index: "03", label: "Shield & Sync", icon: "shield" },
];

const THEME_KEY = "t3-pilot.cockpit.theme";
const POLL_MS = 10_000;

function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage may be unavailable inside sandboxed previews */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readHashView(): ViewId | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  return VIEWS.some((view) => view.id === hash) ? (hash as ViewId) : null;
}

export interface AppProps {
  initialMode?: CockpitMode;
  initialStatus?: PilotStatusSummary | null;
  initialView?: ViewId;
  initialTheme?: Theme;
  initialRoute?: RouteDecision | null;
  demo?: DemoBackend;
  live?: CockpitClient;
  now?: number;
}

export function App(props: AppProps) {
  const [demo] = useState(() => props.demo ?? new DemoBackend());
  const [live] = useState<CockpitClient>(() => props.live ?? new LiveClient());
  const [mode, setMode] = useState<CockpitMode>(props.initialMode ?? "demo");
  const [status, setStatus] = useState<PilotStatusSummary | null>(props.initialStatus ?? null);
  const [connecting, setConnecting] = useState(false);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>(demo.scenarioId);
  const [view, setView] = useState<ViewId>(() => props.initialView ?? readHashView() ?? "pacing");
  const [theme, setTheme] = useState<Theme>(() => props.initialTheme ?? readTheme());
  const [now, setNow] = useState(() => props.now ?? Date.now());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const client: CockpitClient = mode === "live" ? live : demo;

  // Boot: honour ?demo=1, otherwise probe the live daemon and fall back to the Interactive Demo.
  useEffect(() => {
    if (props.initialStatus) return;
    let cancelled = false;
    void (async () => {
      if (wantsDemoFromUrl(window.location.search)) {
        setMode("demo");
        setStatus(demo.snapshot());
        return;
      }
      try {
        const snapshot = await live.getStatus();
        if (cancelled) return;
        setMode("live");
        setStatus(snapshot);
      } catch {
        if (cancelled) return;
        setMode("demo");
        setStatus(demo.snapshot());
        setNotice({ tone: "info", text: "No t3-pilot daemon answered /api/status — running the Interactive Demo. Start one with `npx t3-pilot up`, then switch to LIVE." });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const active: CockpitClient = modeRef.current === "live" ? live : demo;
    try {
      const snapshot = await active.getStatus();
      if (active.mode !== modeRef.current) return;
      setStatus(snapshot);
      setStale(false);
    } catch {
      if (active.mode === "live" && modeRef.current === "live") setStale(true);
    }
  }, [demo, live]);

  useEffect(() => {
    if (!status) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [mode, refresh, status === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || props.initialView) return;
    if (window.location.hash !== `#${view}`) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${view}`);
  }, [view, props.initialView]);

  const switchMode = useCallback(async (next: CockpitMode) => {
    if (next === "demo") {
      setMode("demo");
      setStatus(demo.snapshot());
      setStale(false);
      setNotice(null);
      return;
    }
    setConnecting(true);
    try {
      const snapshot = await live.getStatus();
      setMode("live");
      setStatus(snapshot);
      setStale(false);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "warn", text: `Live daemon unreachable (${errorMessage(error)}). Staying in Interactive Demo — run \`npx t3-pilot up\` and retry.` });
    } finally {
      setConnecting(false);
    }
  }, [demo, live]);

  const chooseScenario = useCallback((id: DemoScenarioId) => {
    setScenarioId(id);
    setStatus(demo.setScenario(id));
  }, [demo]);

  const cycleHuman = useCallback(() => {
    if (modeRef.current === "demo") setStatus(demo.cycleHuman());
  }, [demo]);

  const actions: CockpitActions = useMemo(() => ({
    route: (task) => client.route(task),
    addSparkle: async (input) => {
      const result = await client.addSparkle(input);
      setStatus((current) => (current ? { ...current, sparkles: result.queue } : current));
      return result.added;
    },
    configureShield: async (patch) => {
      const result = await client.configureShield(patch);
      setStatus((current) => (current ? { ...current, shield: result.shield } : current));
    },
    checkShield: async (check) => (await client.checkShield(check)).evaluation,
    sync: async (input) => {
      const output = await client.sync(input);
      void refresh();
      return output;
    },
  }), [client, refresh]);

  const pending = status?.sparkles.filter((item) => item.status === "pending").length ?? 0;
  const running = Boolean(status?.runtimeState.activeRun);
  const harvesting = status?.pacing.filter((entry) => entry.harvestMode === "FULL_THROTTLE_HARVEST" || entry.harvestMode === "EXPIRING_5H_HARVEST").length ?? 0;

  return (
    <div className="app" data-mode={mode}>
      <CommandBar
        mode={mode} connecting={connecting} onSwitchMode={(next) => void switchMode(next)}
        scenarioId={scenarioId} onScenario={chooseScenario}
        human={status?.humanPreemption ?? null} onCycleHuman={cycleHuman}
        theme={theme} onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        generatedAt={status?.generatedAt ?? null} stale={stale} now={now}
      />

      {notice ? (
        <div className={`notice tone-${notice.tone}`} role="status">
          <Icon name={notice.tone === "warn" ? "alert" : "flask"} size={14} />
          <span>{notice.text}</span>
          <button type="button" className="icon-btn ghost" aria-label="Dismiss" onClick={() => setNotice(null)}><Icon name="x" size={13} /></button>
        </div>
      ) : null}

      <nav className="view-nav" role="tablist" aria-label="Cockpit views">
        {VIEWS.map((entry) => (
          <button
            key={entry.id} type="button" role="tab" aria-selected={view === entry.id}
            className={`view-tab${view === entry.id ? " active" : ""}`} onClick={() => setView(entry.id)}
          >
            <span className="view-index num">{entry.index}</span>
            <Icon name={entry.icon} size={15} />
            <span className="view-label">{entry.label}</span>
            {entry.id === "pacing" && harvesting ? <span className="view-badge ok num">{harvesting}</span> : null}
            {entry.id === "sparkles" ? <span className={`view-badge num${running ? " live" : ""}`}>{running ? "●" : ""}{pending}</span> : null}
            {entry.id === "shield" && status ? <span className={`view-badge num mode-${status.shield.mode}`}>{status.shield.mode === "guarded-turbo" ? "GT" : status.shield.mode.toUpperCase()}</span> : null}
          </button>
        ))}
      </nav>

      <main className="main">
        {!status ? (
          <div className="boot">
            <div className="radar" aria-hidden="true"><span /></div>
            <p className="num">ACQUIRING TELEMETRY · /api/status</p>
          </div>
        ) : view === "pacing" ? (
          <PacingView status={status} now={now} actions={actions} initialRoute={props.initialRoute ?? null} contextKey={`${mode}:${scenarioId}`} />
        ) : view === "sparkles" ? (
          <SparkleView status={status} now={now} actions={actions} />
        ) : (
          <ShieldView status={status} actions={actions} />
        )}
      </main>

      <footer className="footer num">
        <span>t3-pilot Cockpit · {mode === "live" ? "LIVE" : "DEMO"}</span>
        {status ? <span>workspace {status.workspaceRoot}</span> : null}
        {status ? <span>snapshot {fmtClock(status.generatedAt)}</span> : null}
        <span>zero external CDNs · offline-ready</span>
      </footer>
    </div>
  );
}
