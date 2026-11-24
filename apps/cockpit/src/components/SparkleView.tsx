import { useMemo, useState, type FormEvent } from "react";
import type { CockpitActions } from "../api";
import { errorMessage, fmtAgo, fmtClock, fmtCountdown, poolMeta, type Tone } from "../format";
import type {
  HumanPreemptionReport, PilotStatusSummary, SparkleExecutionMode, SparkleItem, SparkleItemStatus, SparkleRunRecord,
} from "../types";
import { Icon } from "./Icons";
import { InlineError, Panel, Pill, Segmented } from "./primitives";

export type SparkleFilter = "all" | "pending" | "running" | "completed" | "halted";

export const SPARKLE_FILTERS: { value: SparkleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "halted", label: "Halted" },
];

export function filterSparkles(items: SparkleItem[], filter: SparkleFilter): SparkleItem[] {
  if (filter === "all") return items;
  if (filter === "halted") return items.filter((item) => item.status === "halted" || item.status === "failed");
  return items.filter((item) => item.status === filter);
}

const STATUS_META: Record<SparkleItemStatus, { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "PENDING" },
  running: { tone: "accent", label: "RUNNING" },
  completed: { tone: "ok", label: "COMPLETED" },
  halted: { tone: "warn", label: "HALTED" },
  failed: { tone: "danger", label: "FAILED" },
};

const OUTCOME_META: Record<SparkleRunRecord["outcome"], { tone: Tone; label: string }> = {
  running: { tone: "accent", label: "RUNNING" },
  completed: { tone: "ok", label: "COMPLETED" },
  halted_epoch_lock: { tone: "warn", label: "EPOCH LOCK" },
  preempted_human: { tone: "warn", label: "PREEMPTED" },
  failed: { tone: "danger", label: "FAILED" },
  halted_safety: { tone: "danger", label: "SAFETY HALT" },
};

export function LeaseBanner({ run, human, now }: { run: SparkleRunRecord | null; human: HumanPreemptionReport | null; now: number }) {
  if (!run) {
    const yielded = human?.state && human.state !== "CLEAR_FOR_PILOT";
    return (
      <div className={`lease-banner idle${yielded ? " yielded" : ""}`}>
        <Icon name={yielded ? "user" : "hourglass"} size={20} />
        <div>
          <strong>{yielded ? "Pilot yielded to a human turn" : "No active epoch lease — governor standing by"}</strong>
          <p>{yielded
            ? human?.reason
            : "Sparkles launch only inside harvest windows (Full-Throttle or <45m expiring 5h) when no human turn is active."}</p>
        </div>
      </div>
    );
  }
  const meta = poolMeta(run.poolId);
  const deadline = Date.parse(run.lease.hardDeadlineAt ?? "");
  const leased = Date.parse(run.lease.leasedAt);
  const remaining = Number.isFinite(deadline) ? deadline - now : null;
  const span = Number.isFinite(deadline) && Number.isFinite(leased) ? Math.max(1, deadline - leased) : null;
  const progress = span && remaining !== null ? Math.min(100, Math.max(0, ((span - remaining) / span) * 100)) : 0;
  const halted = remaining !== null && remaining <= 0;
  const urgent = remaining !== null && remaining > 0 && remaining < 15 * 60_000;
  const target = run.lease.targetSessionResetAt && run.lease.targetWeeklyResetAt
    ? (Date.parse(run.lease.targetSessionResetAt) <= Date.parse(run.lease.targetWeeklyResetAt) ? ["5h session", run.lease.targetSessionResetAt] : ["7d weekly", run.lease.targetWeeklyResetAt])
    : run.lease.targetSessionResetAt ? ["5h session", run.lease.targetSessionResetAt] : ["7d weekly", run.lease.targetWeeklyResetAt];

  return (
    <div className={`lease-banner active${halted ? " halted" : urgent ? " urgent" : ""}`} style={{ ["--pool" as string]: meta.color }}>
      <div className="lease-top">
        <div className="lease-title">
          <Pill tone={halted ? "danger" : "accent"} pulse={!halted} solid={halted}>{halted ? "HARD STOP" : "EPOCH LEASE ACTIVE"}</Pill>
          <strong>{run.itemTitle}</strong>
        </div>
        <div className="lease-countdown">
          <span className="eyebrow">hardDeadlineAt = resetAt − 2m</span>
          <span className={`lease-clock num${halted ? " text-danger" : urgent ? " text-warn" : ""}`}>{halted ? "HALTED" : fmtCountdown(remaining)}</span>
        </div>
      </div>
      <div className="lease-progress" aria-label="Lease consumed"><span style={{ width: `${progress}%` }} /></div>
      <dl className="lease-grid">
        <div><dt>Leased pool</dt><dd><span className="pool-chip">{meta.short}</span>{meta.label}</dd></div>
        <div><dt>Model</dt><dd className="num">{run.model}</dd></div>
        <div><dt>Target resetAt ({target[0]})</dt><dd className="num">{fmtClock(target[1])}</dd></div>
        <div><dt>Hard deadline</dt><dd className="num">{fmtClock(run.lease.hardDeadlineAt)}</dd></div>
        <div><dt>{run.mode === "worktree" ? "Branch" : "Scratch dir"}</dt><dd className="num path"><Icon name={run.mode === "worktree" ? "branch" : "box"} size={12} />{run.branchName ?? run.scratchDir ?? "—"}</dd></div>
        <div><dt>Thread</dt><dd className="num">{run.threadId} · {fmtAgo(run.startedAt, now)}</dd></div>
      </dl>
      <p className="lease-foot"><Icon name="lock" size={12} />Zero-Fresh-Quota Guarantee: halts at the deadline or the instant resetAt advances — 0.00% of the refreshed cycle is consumed.</p>
    </div>
  );
}

export function AddSparkleForm({ actions }: { actions: CockpitActions }) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SparkleExecutionMode>("worktree");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Give the Sparkle a one-line title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const item = await actions.addSparkle({ title: trimmed, mode, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
      setAdded(item.title);
      setTitle("");
      setPrompt("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sparkle-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Title</span>
        <input className="input" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, " "))} placeholder="e.g. Prototype a dark-mode heatmap for SPARKLES.md" />
      </label>
      <div className="field">
        <span className="field-label">Execution mode</span>
        <Segmented<SparkleExecutionMode>
          label="Sparkle execution mode" value={mode} onChange={setMode}
          options={[
            { value: "worktree", label: <><Icon name="branch" size={13} />Worktree (Branch/PR)</>, hint: "Isolated git worktree, opens a branch/PR — never touches main" },
            { value: "scratch", label: <><Icon name="box" size={13} />Scratch (Isolated Sandbox)</>, hint: "Standalone scratch workspace for research or demos" },
          ]}
        />
      </div>
      <label className="field">
        <span className="field-label">Expanded prompt <span className="muted">(optional)</span></span>
        <textarea className="input textarea" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Extra context, acceptance criteria, files to look at…" />
      </label>
      <div className="form-foot">
        <button type="submit" className="btn btn-primary" disabled={busy}><Icon name="plus" size={14} />{busy ? "Queuing…" : "Add to SPARKLES.md"}</button>
        {added ? <span className="text-ok form-note"><Icon name="check" size={13} />Queued “{added}”</span> : null}
      </div>
      <InlineError message={error} />
    </form>
  );
}

export function SparkleList({ items, initialFilter = "all" }: { items: SparkleItem[]; initialFilter?: SparkleFilter }) {
  const [filter, setFilter] = useState<SparkleFilter>(initialFilter);
  const counts = useMemo(() => Object.fromEntries(SPARKLE_FILTERS.map((entry) => [entry.value, filterSparkles(items, entry.value).length])) as Record<SparkleFilter, number>, [items]);
  const visible = filterSparkles(items, filter);
  return (
    <div className="sparkle-list">
      <div className="filter-row" role="tablist" aria-label="Filter Sparkles">
        {SPARKLE_FILTERS.map((entry) => (
          <button key={entry.value} type="button" role="tab" aria-selected={filter === entry.value} className={`filter-tab${filter === entry.value ? " active" : ""}`} onClick={() => setFilter(entry.value)}>
            {entry.label}<span className="count num">{counts[entry.value]}</span>
          </button>
        ))}
      </div>
      <ul className="sparkles">
        {visible.map((item) => {
          const status = STATUS_META[item.status];
          return (
            <li key={item.id} className={`sparkle status-${item.status}`}>
              <span className={`check${item.status === "completed" ? " done" : ""}`} aria-hidden="true">
                {item.status === "completed" ? <Icon name="check" size={12} /> : item.status === "running" ? <span className="pulse-dot" /> : item.status === "halted" || item.status === "failed" ? <Icon name="x" size={11} /> : null}
              </span>
              <div className="sparkle-main">
                <div className="sparkle-head">
                  <span className="sparkle-title">{item.title}</span>
                  <Pill tone={status.tone} pulse={item.status === "running"}>{status.label}</Pill>
                </div>
                <div className="sparkle-meta num">
                  <span className={`mode-badge mode-${item.mode}`}><Icon name={item.mode === "worktree" ? "branch" : "box"} size={11} />{item.mode}</span>
                  <span>{item.source === "github-issue" ? `GitHub ${item.externalRef ?? "issue"}` : `SPARKLES.md${item.lineIndex !== undefined ? `:${item.lineIndex + 1}` : ""}`}</span>
                  {item.branchName ? <span><Icon name="branch" size={11} />{item.branchName}</span> : null}
                  {item.threadId ? <span>{item.threadId}</span> : null}
                </div>
                {item.prompt && item.prompt !== item.title ? <p className="sparkle-prompt">{item.prompt}</p> : null}
                {item.note ? <p className="sparkle-note"><Icon name="terminal" size={11} />{item.note}</p> : null}
              </div>
            </li>
          );
        })}
        {visible.length === 0 ? <li className="empty-hint">Nothing {filter === "all" ? "queued" : filter} yet.</li> : null}
      </ul>
    </div>
  );
}

export function RunHistory({ history, now }: { history: SparkleRunRecord[]; now: number }) {
  if (!history.length) return <p className="empty-hint">No Sparkle runs recorded yet.</p>;
  return (
    <ul className="history">
      {history.slice(0, 8).map((run) => {
        const outcome = OUTCOME_META[run.outcome];
        return (
          <li key={run.runId} className="history-row">
            <Pill tone={outcome.tone}>{outcome.label}</Pill>
            <div className="history-main">
              <span className="history-title">{run.itemTitle}</span>
              <span className="muted num">{poolMeta(run.poolId).short} · {run.model} · {fmtAgo(run.endedAt ?? run.startedAt, now)}{run.requeue ? " · requeued" : ""}</span>
              {run.stopReason ? <span className="history-reason num">{run.stopReason}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SparkleView({ status, now, actions }: { status: PilotStatusSummary; now: number; actions: CockpitActions }) {
  const pending = status.sparkles.filter((item) => item.status === "pending").length;
  return (
    <div className="view view-sparkles">
      <Panel eyebrow="04 · resetAt Epoch Lease Monitor" title="Active Sparkle Lease" icon="clock">
        <LeaseBanner run={status.runtimeState.activeRun} human={status.humanPreemption} now={now} />
      </Panel>
      <div className="split">
        <Panel
          eyebrow="05 · SPARKLES.md" title="Sparkle Queue" icon="sparkle" className="split-wide"
          actions={<Pill tone="info">{pending} PENDING · {status.sparkles.length} TOTAL</Pill>}
        >
          <SparkleList items={status.sparkles} />
        </Panel>
        <div className="stack split-narrow">
          <Panel eyebrow="06 · Drop a brainstorm" title="Add Sparkle" icon="plus">
            <AddSparkleForm actions={actions} />
          </Panel>
          <Panel eyebrow="07 · Governor log" title="Recent Runs" icon="terminal">
            <RunHistory history={status.runtimeState.history} now={now} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

