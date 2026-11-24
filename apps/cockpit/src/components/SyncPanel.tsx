import { useEffect, useRef, useState } from "react";
import type { CockpitActions } from "../api";
import { errorMessage } from "../format";
import type { PilotSyncActionOutput, SyncFileChange, SyncHarnessTarget } from "../types";
import { Icon } from "./Icons";
import { InlineError, Pill, Toggle } from "./primitives";

export const SYNC_TARGETS: { value: SyncHarnessTarget; label: string; paths: string }[] = [
  { value: "antigravity", label: "Antigravity", paths: ".agents/skills · mcp_config.json · hooks.json" },
  { value: "codex", label: "Codex", paths: ".codex/skills · config.toml · rules/" },
  { value: "claude-code", label: "Claude Code", paths: ".claude/skills · .mcp.json · settings.json" },
];

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="muted diff-empty">No textual changes.</p>;
  return (
    <pre className="diff" aria-label="Unified diff">
      {diff.replace(/\n$/, "").split("\n").map((line, index) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        return <span key={index} className={`diff-line diff-${kind}`}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}

function ChangeRow({ change, open }: { change: SyncFileChange; open: boolean }) {
  const tone = change.action === "create" ? "ok" : change.action === "update" ? "warn" : "neutral";
  return (
    <details className={`change change-${change.action}`} open={open}>
      <summary>
        <Pill tone={tone}>{change.action.toUpperCase()}</Pill>
        <span className="change-path num">{change.targetPath}</span>
        <span className="change-harness">{change.harness}</span>
      </summary>
      {change.action === "unchanged" ? <p className="muted diff-empty">Already in sync.</p> : <DiffView diff={change.unifiedDiff} />}
    </details>
  );
}

export function SyncResult({ output }: { output: PilotSyncActionOutput }) {
  if (output.mode === "rollback") {
    const { result } = output;
    return (
      <div className="sync-result">
        <p className="sync-headline"><Icon name="rollback" size={14} />Rolled back snapshot <code>{result.snapshotId}</code></p>
        <ul className="path-list">
          {result.restoredPaths.map((path) => <li key={`r${path}`}><Pill tone="info">RESTORED</Pill><span className="num">{path}</span></li>)}
          {result.removedPaths.map((path) => <li key={`d${path}`}><Pill tone="warn">REMOVED</Pill><span className="num">{path}</span></li>)}
          {!result.restoredPaths.length && !result.removedPaths.length ? <li className="muted">Nothing to restore.</li> : null}
        </ul>
      </div>
    );
  }
  const { result } = output;
  const count = (action: SyncFileChange["action"]) => result.changes.filter((change) => change.action === action).length;
  const firstChanged = result.changes.findIndex((change) => change.action !== "unchanged");
  return (
    <div className="sync-result">
      <p className="sync-headline">
        <Icon name={output.mode === "apply" ? "check" : "diff"} size={14} />
        {output.mode === "apply" ? "Applied" : "Dry-run plan"} · <span className="text-ok">{count("create")} create</span> · <span className="text-warn">{count("update")} update</span> · <span className="muted">{count("unchanged")} unchanged</span>
        {result.snapshotId ? <> · snapshot <code>{result.snapshotId}</code></> : null}
      </p>
      <div className="sync-sources">
        <span className="muted">Skills</span>{result.discoveredSkills.map((skill) => <code key={skill}>{skill}</code>)}
        <span className="muted">MCP</span>{result.discoveredMcpServers.map((server) => <code key={server}>{server}</code>)}
      </div>
      {(result.warnings ?? []).map((warning) => <p key={warning} className="warning-line"><Icon name="alert" size={13} />{warning}</p>)}
      <div className="changes">
        {result.changes.map((change, index) => <ChangeRow key={`${output.mode}:${change.harness}:${change.targetPath}`} change={change} open={index === firstChanged} />)}
        {result.changes.length === 0 ? <p className="muted">No target files for the selected harnesses.</p> : null}
      </div>
    </div>
  );
}

export function SyncPanel({ actions, defaultTargets, lastSnapshotId, initialOutput = null }: {
  actions: CockpitActions; defaultTargets: SyncHarnessTarget[]; lastSnapshotId: string | null; initialOutput?: PilotSyncActionOutput | null;
}) {
  const [targets, setTargets] = useState<SyncHarnessTarget[]>(defaultTargets.length ? defaultTargets : SYNC_TARGETS.map((target) => target.value));
  const [output, setOutput] = useState<PilotSyncActionOutput | null>(initialOutput);
  const [busy, setBusy] = useState<"plan" | "apply" | "rollback" | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  const toggle = (target: SyncHarnessTarget, on: boolean) =>
    setTargets((current) => on ? [...new Set([...current, target])] : current.filter((entry) => entry !== target));

  const run = async (kind: "plan" | "apply" | "rollback") => {
    if (kind !== "rollback" && targets.length === 0) {
      setError("Select at least one harness.");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      setOutput(await actions.sync(kind === "rollback" ? { rollbackSnapshotId: lastSnapshotId ?? true } : { dryRun: kind === "plan", targets }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
      setArmed(false);
    }
  };

  const onApply = () => {
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    void run("apply");
  };

  return (
    <div className="sync">
      <ul className="target-list">
        {SYNC_TARGETS.map((target) => (
          <li key={target.value} className={`target${targets.includes(target.value) ? " on" : ""}`}>
            <Toggle checked={targets.includes(target.value)} label={`Sync ${target.label}`} onChange={(on) => toggle(target.value, on)} />
            <div><strong>{target.label}</strong><span className="muted num">{target.paths}</span></div>
          </li>
        ))}
      </ul>
      <div className="sync-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run("plan")}><Icon name="diff" size={13} />{busy === "plan" ? "Diffing…" : "Preview Diff"}</button>
        <button type="button" className={`btn ${armed ? "btn-danger" : "btn-primary"}`} disabled={busy !== null} onClick={onApply}>
          <Icon name={armed ? "alert" : "sync"} size={13} />{busy === "apply" ? "Applying…" : armed ? "Confirm Apply" : "Apply Sync"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void run("rollback")} title={lastSnapshotId ? `Roll back ${lastSnapshotId}` : "Roll back the latest snapshot"}>
          <Icon name="rollback" size={13} />{busy === "rollback" ? "Rolling back…" : "Rollback Latest"}
        </button>
      </div>
      <p className="muted sync-note num">Source of truth: <code>.t3-pilot/skills/</code> · <code>.t3-pilot/mcp.json</code> · <code>.t3-pilot/shield.json</code>{lastSnapshotId ? <> · latest snapshot <code>{lastSnapshotId}</code></> : null}</p>
      <InlineError message={error} />
      {output ? <SyncResult output={output} /> : null}
    </div>
  );
}
