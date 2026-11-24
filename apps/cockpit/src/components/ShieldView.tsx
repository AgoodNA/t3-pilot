import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CockpitActions } from "../api";
import { formatHookDecisionOutput } from "../engine/shield";
import { DECISION_META, errorMessage } from "../format";
import type {
  PilotStatusSummary, ShieldCheckInput, ShieldDecision, ShieldEvaluationResult, ShieldHarness, ShieldMode, ShieldPolicyConfig, ShieldRule,
} from "../types";
import { Icon } from "./Icons";
import { CodeBlock, InlineError, Panel, Pill, Segmented, Toggle } from "./primitives";
import { SyncPanel } from "./SyncPanel";

export const MODE_COPY: Record<ShieldMode, { label: string; blurb: string; position: number }> = {
  strict: {
    label: "Strict", position: 22,
    blurb: "Every shell command outside the local dev allowlist (ls, pwd, npm test/build/typecheck/lint, npx vitest, git status/diff/log) force-asks — on top of every red line.",
  },
  "guarded-turbo": {
    label: "Guarded Turbo", position: 50,
    blurb: "Routine builds, tests and local git cruise at full speed. Catastrophic red lines are hard-denied; publishing and visibility changes force a human ask.",
  },
  off: {
    label: "Off", position: 84,
    blurb: "No interception — equivalent to unguarded Full Access. Reserve for disposable sandboxes only.",
  },
};

const CATEGORY_LABEL: Record<ShieldRule["category"], string> = {
  "destructive-fs": "FS",
  "host-credentials": "SECRETS",
  "git-history": "GIT",
  "infra-containers-firewall": "INFRA",
  "package-publish": "PUBLISH",
  "repo-visibility": "REPO",
};

export function ModeSwitchboard({ policy, onMode, busy }: { policy: ShieldPolicyConfig; onMode: (mode: ShieldMode) => void; busy: boolean }) {
  const copy = MODE_COPY[policy.mode];
  return (
    <div className="switchboard">
      <Segmented<ShieldMode>
        label="Guarded Turbo mode" value={policy.mode} onChange={onMode} disabled={busy}
        options={[
          { value: "guarded-turbo", label: <><Icon name="shieldCheck" size={14} />Guarded Turbo</>, tone: "ok" },
          { value: "strict", label: <><Icon name="lock" size={14} />Strict</>, tone: "info" },
          { value: "off", label: <><Icon name="x" size={14} />Off</>, tone: "danger" },
        ]}
      />
      <div className="spectrum" aria-hidden="true">
        <div className="spectrum-track">
          <span className="spectrum-zone noisy" />
          <span className="spectrum-zone sweet" />
          <span className="spectrum-zone exposed" />
          <span className={`spectrum-cursor mode-${policy.mode}`} style={{ left: `${copy.position}%` }}>
            <span className="spectrum-cursor-label">{copy.label}</span>
          </span>
        </div>
        <div className="spectrum-ends">
          <span><b>Auto</b> · noisy prompts on routine dev commands</span>
          <span className="spectrum-mid">Guarded Turbo · the safe cruise lane</span>
          <span><b>Full Access</b> · unguarded host exposure</span>
        </div>
      </div>
      <p className={`mode-blurb mode-${policy.mode}`}>{copy.blurb}</p>
      <div className="insurance">
        <div className="insurance-card">
          <Icon name="shield" size={16} />
          <div><strong>Hard · PreToolUse hook</strong><span>Intercepts every tool call in Antigravity, Claude Code &amp; Codex rules before it executes — returns allow / deny / force_ask.</span></div>
        </div>
        <div className="insurance-card">
          <Icon name="file" size={16} />
          <div><strong>Soft · guarded-turbo/SKILL.md</strong><span>Teaches the model the same red lines so it never plans the dangerous step in the first place.</span></div>
        </div>
      </div>
    </div>
  );
}

export function PolicyMatrix({ policy, onRule, pendingRule }: {
  policy: ShieldPolicyConfig; onRule: (ruleId: string, patch: { enabled?: boolean; decision?: ShieldDecision }) => void; pendingRule: string | null;
}) {
  return (
    <div className={`matrix${policy.mode === "off" ? " bypassed" : ""}`}>
      {policy.mode === "off" ? <p className="warning-line"><Icon name="alert" size={13} />Shield is Off — every rule below is bypassed until you re-arm it.</p> : null}
      <div className="matrix-head" aria-hidden="true">
        <span>Red-line rule</span><span>Enabled</span><span>Decision</span>
      </div>
      <ul className="matrix-rows">
        {policy.rules.map((rule) => (
          <li key={rule.id} className={`matrix-row${rule.enabled ? "" : " disabled"}${pendingRule === rule.id ? " pending" : ""}`}>
            <div className="matrix-rule">
              <div className="matrix-title">
                <span className="cat-chip">{CATEGORY_LABEL[rule.category] ?? rule.category}</span>
                <strong>{rule.title}</strong>
              </div>
              <code className="rule-id">{rule.id}</code>
              <p className="rule-desc">{rule.description}</p>
            </div>
            <div className="matrix-enabled">
              <Toggle checked={rule.enabled} label={`Enable ${rule.id}`} disabled={pendingRule === rule.id} onChange={(enabled) => onRule(rule.id, { enabled })} />
            </div>
            <div className="matrix-decision">
              <Segmented<ShieldDecision>
                size="sm" label={`Decision for ${rule.id}`} value={rule.decision} disabled={pendingRule === rule.id}
                onChange={(decision) => onRule(rule.id, { decision })}
                options={[
                  { value: "deny", label: "deny", tone: "danger" },
                  { value: "force_ask", label: "force_ask", tone: "warn" },
                  { value: "allow", label: "allow", tone: "ok" },
                ]}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const SANDBOX_PRESETS: { label: string; command: string; filePath?: string }[] = [
  { label: "rm -rf /", command: "rm -rf /" },
  { label: "cat ~/.ssh/id_rsa", command: "cat ~/.ssh/id_rsa" },
  { label: "git push --force origin main", command: "git push --force origin main" },
  { label: "ufw disable", command: "sudo ufw disable" },
  { label: "npm publish", command: "npm publish --access public" },
  { label: "gh repo edit --visibility public", command: "gh repo edit --visibility public" },
  { label: "npm test", command: "npm test" },
];

const HARNESS_TOOL: Record<ShieldHarness, string> = {
  antigravity: "run_command",
  "claude-code": "Bash",
  codex: "exec_command",
  generic: "bash",
};

export function hookStdin(check: ShieldCheckInput): Record<string, unknown> {
  const harness = check.harness ?? "generic";
  if (harness === "antigravity") {
    return { toolCall: { name: check.toolName, args: { ...(check.command ? { CommandLine: check.command } : {}), ...(check.filePath ? { TargetFile: check.filePath } : {}) } } };
  }
  if (harness === "claude-code") {
    return { hook_event_name: "PreToolUse", tool_name: check.toolName, tool_input: { ...(check.command ? { command: check.command } : {}), ...(check.filePath ? { file_path: check.filePath } : {}) } };
  }
  return { toolName: check.toolName, ...(check.command ? { command: check.command } : {}), ...(check.filePath ? { filePath: check.filePath } : {}) };
}

export function SandboxResult({ evaluation, check }: { evaluation: ShieldEvaluationResult; check: ShieldCheckInput }) {
  const meta = DECISION_META[evaluation.decision];
  return (
    <div className={`sandbox-result decision-${evaluation.decision}`}>
      <div className="verdict">
        <span className={`verdict-badge tone-${meta.tone}`}>
          <Icon name={evaluation.decision === "allow" ? "check" : evaluation.decision === "deny" ? "x" : "user"} size={16} />
          {meta.label}
        </span>
        <div className="verdict-text">
          <strong>{evaluation.matchedRuleTitle ?? (evaluation.decision === "allow" ? "No red line matched" : "Mode policy")}</strong>
          {evaluation.matchedRuleId ? <code className="rule-id">{evaluation.matchedRuleId}</code> : null}
          <p>{evaluation.reason}</p>
        </div>
      </div>
      <div className="hook-grid">
        <CodeBlock title=".agents/hooks.json · PreToolUse → stdout" lang="antigravity" code={JSON.stringify(formatHookDecisionOutput(evaluation, "antigravity"), null, 2)} />
        <CodeBlock title=".claude/settings.json · PreToolUse → stdout" lang="claude-code" code={JSON.stringify(formatHookDecisionOutput(evaluation, "claude-code"), null, 2)} />
      </div>
      <details className="stdin-details">
        <summary>Hook stdin payload ({check.harness ?? "generic"})</summary>
        <pre className="code"><code>{JSON.stringify(hookStdin(check), null, 2)}</code></pre>
      </details>
    </div>
  );
}

export function GuardrailSandbox({ actions, policyKey }: { actions: CockpitActions; policyKey: string }) {
  const [harness, setHarness] = useState<ShieldHarness>("antigravity");
  const [toolName, setToolName] = useState(HARNESS_TOOL.antigravity);
  const [command, setCommand] = useState(SANDBOX_PRESETS[0]!.command);
  const [filePath, setFilePath] = useState("");
  const [result, setResult] = useState<{ evaluation: ShieldEvaluationResult; check: ShieldCheckInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seeded with the first quick test so the sandbox shows a live verdict on first paint (the mount effect below runs it).
  const lastCheck = useRef<ShieldCheckInput | null>({ harness: "antigravity", toolName: HARNESS_TOOL.antigravity, command: SANDBOX_PRESETS[0]!.command });

  const run = async (check: ShieldCheckInput) => {
    if (!check.toolName.trim()) {
      setError("A tool name is required.");
      return;
    }
    lastCheck.current = check;
    setBusy(true);
    setError(null);
    try {
      setResult({ evaluation: await actions.checkShield(check), check });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  // Re-evaluate the last check whenever the policy changes so rule toggles show their effect instantly.
  useEffect(() => {
    if (lastCheck.current) void run(lastCheck.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyKey]);

  const buildCheck = (overrides: Partial<ShieldCheckInput> = {}): ShieldCheckInput => {
    const next = { harness, toolName, command, filePath, ...overrides };
    return {
      harness: next.harness, toolName: next.toolName.trim(),
      ...(next.command?.trim() ? { command: next.command.trim() } : {}),
      ...(next.filePath?.trim() ? { filePath: next.filePath.trim() } : {}),
    };
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(buildCheck());
  };

  return (
    <div className="sandbox">
      <div className="chip-row" aria-label="Quick tests">
        {SANDBOX_PRESETS.map((preset) => (
          <button
            key={preset.label} type="button" className={`chip mono${command === preset.command ? " active" : ""}`}
            onClick={() => { setCommand(preset.command); setFilePath(preset.filePath ?? ""); void run(buildCheck({ command: preset.command, filePath: preset.filePath ?? "" })); }}
          >
            <Icon name="terminal" size={11} />{preset.label}
          </button>
        ))}
      </div>
      <form className="sandbox-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Harness</span>
          <select className="input" value={harness} onChange={(event) => { const next = event.target.value as ShieldHarness; setHarness(next); setToolName(HARNESS_TOOL[next]); }}>
            <option value="antigravity">Antigravity</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="generic">Generic</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Tool</span>
          <input className="input mono" value={toolName} onChange={(event) => setToolName(event.target.value)} />
        </label>
        <label className="field span-2">
          <span className="field-label">Command</span>
          <input className="input mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="git push --force origin main" />
        </label>
        <label className="field span-2">
          <span className="field-label">File path <span className="muted">(optional)</span></span>
          <input className="input mono" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="~/.aws/credentials" />
        </label>
        <button type="submit" className="btn btn-primary span-2" disabled={busy}><Icon name="play" size={13} />{busy ? "Evaluating…" : "Dry-run PreToolUse"}</button>
      </form>
      <InlineError message={error} />
      {result ? <SandboxResult evaluation={result.evaluation} check={result.check} /> : (
        <p className="empty-hint">Fire a quick test — the dry-run never executes anything; it only asks the shield what it would decide.</p>
      )}
    </div>
  );
}

export function ShieldView({ status, actions }: { status: PilotStatusSummary; actions: CockpitActions }) {
  const policy = status.shield;
  const [busyMode, setBusyMode] = useState(false);
  const [pendingRule, setPendingRule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const policyKey = JSON.stringify([policy.mode, policy.rules.map((rule) => [rule.id, rule.enabled, rule.decision])]);
  const denies = policy.rules.filter((rule) => rule.enabled && rule.decision === "deny").length;
  const asks = policy.rules.filter((rule) => rule.enabled && rule.decision === "force_ask").length;

  const setMode = async (mode: ShieldMode) => {
    setBusyMode(true);
    setError(null);
    try {
      await actions.configureShield({ mode });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyMode(false);
    }
  };

  const setRule = async (ruleId: string, patch: { enabled?: boolean; decision?: ShieldDecision }) => {
    setPendingRule(ruleId);
    setError(null);
    try {
      await actions.configureShield({ ruleId, ...patch });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPendingRule(null);
    }
  };

  return (
    <div className="view view-shield">
      <div className="split">
        <Panel
          eyebrow="08 · t3-pilot shield" title="Guarded Turbo Switchboard" icon="shieldCheck" className="split-narrow"
          actions={<Pill tone={policy.mode === "off" ? "danger" : policy.mode === "strict" ? "info" : "ok"} solid>{policy.mode.toUpperCase()}</Pill>}
        >
          <ModeSwitchboard policy={policy} onMode={(mode) => void setMode(mode)} busy={busyMode} />
          <InlineError message={error} />
        </Panel>
        <Panel
          eyebrow="09 · .t3-pilot/shield.json" title="Red-Line Policy Matrix" icon="lock" className="split-wide"
          actions={<div className="panel-pills"><Pill tone="danger">{denies} DENY</Pill><Pill tone="warn">{asks} FORCE_ASK</Pill></div>}
        >
          <PolicyMatrix policy={policy} pendingRule={pendingRule} onRule={(ruleId, patch) => void setRule(ruleId, patch)} />
          <p className="matrix-foot muted">Protected branches: {policy.protectedBranches.map((branch) => <code key={branch}>{branch}</code>)}</p>
        </Panel>
      </div>
      <div className="split">
        <Panel eyebrow="10 · PreToolUse dry-run" title="Guardrail Sandbox" icon="terminal" className="split-wide">
          <GuardrailSandbox actions={actions} policyKey={policyKey} />
        </Panel>
        <Panel eyebrow="11 · Skills · MCP · Hooks" title="Cross-Harness Sync" icon="sync" className="split-narrow">
          <SyncPanel actions={actions} defaultTargets={status.config.syncTargets} lastSnapshotId={status.runtimeState.lastSyncSnapshotId} />
        </Panel>
      </div>
    </div>
  );
}
