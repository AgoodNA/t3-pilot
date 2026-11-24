/**
 * Stateful Interactive Demo backend. Mirrors every daemon endpoint with the same engines
 * (pacing, router, Guarded Turbo runtime) so the GitHub Pages export behaves like the real Cockpit.
 */
import type { CockpitClient } from "../api";
import { unifiedDiff } from "./diff";
import { evaluateAllPools, HOUR_MS, MINUTE_MS } from "./pacing";
import { routeTask } from "./router";
import { createDefaultShieldPolicy, evaluateShieldToolCall } from "./shield";
import type {
  AddSparkleInput, HumanActivityState, HumanPreemptionReport, PilotConfig, PilotStatusSummary, PilotSyncActionInput,
  PilotSyncActionOutput, ProviderDriverKind, QuotaPoolId, QuotaPoolSnapshot, ShieldCheckInput, ShieldPatch,
  ShieldPolicyConfig, SparkleItem, SparkleRunRecord, SyncFileChange, SyncHarnessTarget, SyncPlanResult,
} from "../types";

export type DemoScenarioId = "cruise" | "expiring" | "full-throttle" | "shield-locked";
type MeteredPoolId = "codex" | "antigravity-gemini" | "antigravity-claude";

interface PoolSpec {
  weekly: number;
  session: number;
  sessionResetMins: number;
}

export interface DemoScenario {
  id: DemoScenarioId;
  index: number;
  label: string;
  tagline: string;
  weeklyResetHours: number;
  pools: Record<MeteredPoolId, PoolSpec>;
  human: HumanActivityState;
  activeRun: { poolId: MeteredPoolId; model: string } | null;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "cruise", index: 1, label: "Early-Week Cruise (Preserve)",
    tagline: "Day 2 of the cycle — every pool near the ideal line, 5h windows preserved for later.",
    weeklyResetHours: 140,
    pools: {
      codex: { weekly: 88, session: 72, sessionResetMins: 190 },
      "antigravity-gemini": { weekly: 92, session: 80, sessionResetMins: 225 },
      "antigravity-claude": { weekly: 85, session: 66, sessionResetMins: 160 },
    },
    human: "CLEAR_FOR_PILOT",
    activeRun: null,
  },
  {
    id: "expiring", index: 2, label: "<45m Expiring 5h Harvest",
    tagline: "Mid-week, ahead of pace, and two 5h windows reset in under 45 minutes — harvest them.",
    weeklyResetHours: 96,
    pools: {
      codex: { weekly: 74, session: 62, sessionResetMins: 32 },
      "antigravity-gemini": { weekly: 70, session: 55, sessionResetMins: 38 },
      "antigravity-claude": { weekly: 58, session: 48, sessionResetMins: 130 },
    },
    human: "CLEAR_FOR_PILOT",
    activeRun: { poolId: "codex", model: "gpt-6.2-sol" },
  },
  {
    id: "full-throttle", index: 3, label: "24h Left · 80% Full-Throttle",
    tagline: "24h to weekly reset with 80% left: S_week ≥ 0.85 · ⌈T/5h⌉ · C_5h — burn every window.",
    weeklyResetHours: 24,
    pools: {
      codex: { weekly: 80, session: 88, sessionResetMins: 210 },
      "antigravity-gemini": { weekly: 84, session: 92, sessionResetMins: 240 },
      "antigravity-claude": { weekly: 66, session: 58, sessionResetMins: 20 },
    },
    human: "CLEAR_FOR_PILOT",
    activeRun: { poolId: "antigravity-gemini", model: "gemini-4-carbon" },
  },
  {
    id: "shield-locked", index: 4, label: "<=20% Reserve Shield Locked",
    tagline: "Codex weekly and Claude 5h are under the 20% floor — locked out, and a human turn is live.",
    weeklyResetHours: 60,
    pools: {
      codex: { weekly: 18, session: 40, sessionResetMins: 140 },
      "antigravity-gemini": { weekly: 34, session: 40, sessionResetMins: 120 },
      "antigravity-claude": { weekly: 52, session: 15, sessionResetMins: 90 },
    },
    human: "PREEMPTED_ACTIVE_HUMAN_TURN",
    activeRun: null,
  },
];

export function getScenario(id: DemoScenarioId): DemoScenario {
  return DEMO_SCENARIOS.find((scenario) => scenario.id === id) ?? DEMO_SCENARIOS[0]!;
}

export const DEMO_CONFIG: PilotConfig = {
  version: 1,
  projectId: "demo-project",
  sparklesFile: "SPARKLES.md",
  cooldownMinutes: 15,
  tickIntervalMs: 60_000,
  cockpitPort: 4733,
  baseBranch: "main",
  pacing: {
    reserveFloorPercent: 20,
    singleWindowCapacityPercent: 14,
    fullThrottleRatioThreshold: 0.85,
    expiringSessionThresholdMins: 45,
    epochSafetyMarginMins: 2,
  },
  autoConfigureIdleThreads: true,
  requeueOnEpochHalt: true,
  maxQuotaStalenessMins: 60,
  syncTargets: ["antigravity", "codex", "claude-code"],
};

const POOL_IDENTITY: Record<MeteredPoolId, { displayName: string; driver: ProviderDriverKind; instanceId: string }> = {
  codex: { displayName: "Codex", driver: "codex", instanceId: "codex" },
  "antigravity-gemini": { displayName: "Antigravity · Gemini", driver: "antigravity", instanceId: "antigravity" },
  "antigravity-claude": { displayName: "Antigravity · Claude", driver: "antigravity", instanceId: "antigravity" },
};

const iso = (ms: number) => new Date(ms).toISOString();

export function buildDemoPools(scenario: DemoScenario, anchorMs: number): QuotaPoolSnapshot[] {
  return (Object.keys(scenario.pools) as MeteredPoolId[]).map((poolId) => {
    const spec = scenario.pools[poolId];
    const identity = POOL_IDENTITY[poolId];
    return {
      poolId,
      providerInstanceId: identity.instanceId,
      driver: identity.driver,
      displayName: identity.displayName,
      enabled: true,
      installed: true,
      status: "ready",
      source: poolId === "codex" ? "codex-session-jsonl" : "t3-cache-windows",
      checkedAt: iso(anchorMs - 40_000),
      sessionWindow: {
        id: `${poolId}-5h`, label: "5h session", kind: "session",
        usedPercent: 100 - spec.session, remainingPercent: spec.session,
        resetsAt: iso(anchorMs + spec.sessionResetMins * MINUTE_MS), windowDurationMins: 300,
      },
      weeklyWindow: {
        id: `${poolId}-7d`, label: "7d weekly", kind: "weekly",
        usedPercent: 100 - spec.weekly, remainingPercent: spec.weekly,
        resetsAt: iso(anchorMs + scenario.weeklyResetHours * HOUR_MS), windowDurationMins: 10_080,
      },
    } satisfies QuotaPoolSnapshot;
  });
}

const RUN_ITEM_ID = "sp-02";

function baseSparkles(): SparkleItem[] {
  return [
    {
      id: "sp-01", lineIndex: 3, source: "sparkles-md", mode: "worktree", status: "completed",
      title: "Sweep TODOs in packages/daemon into GitHub issues",
      prompt: "Find every TODO/FIXME in packages/daemon, group them, and file one GitHub issue per group.",
      branchName: "sparkle/sweep-daemon-todos", threadId: "thr_7f2a91", note: "PR #14 opened · 9 issues filed",
    },
    {
      id: RUN_ITEM_ID, lineIndex: 4, source: "sparkles-md", mode: "scratch", status: "pending",
      title: "Prototype a 3D quota-nebula visualizer for the Cockpit hero",
      prompt: "Build a standalone, dependency-free WebGL prototype that renders each quota pool as a particle nebula.",
      threadId: "thr_c09e44",
    },
    {
      id: "sp-03", lineIndex: 5, source: "sparkles-md", mode: "worktree", status: "pending",
      title: "Bilingual EN/ZH README first draft",
      prompt: "Draft README.zh-CN.md mirroring README.md, keeping code blocks untouched.",
    },
    {
      id: "sp-04", lineIndex: 6, source: "github-issue", mode: "worktree", status: "pending",
      title: "Fuzz the shield shell tokenizer with 10k random commands",
      prompt: "Write a property-based fuzz suite for the Guarded Turbo shell segmenter.", externalRef: "#21",
    },
    {
      id: "sp-05", lineIndex: 7, source: "sparkles-md", mode: "scratch", status: "halted",
      title: "Research report: T3 Code MCP ecosystem landscape",
      prompt: "Survey public MCP servers that work with T3 Code and summarize gaps.",
      threadId: "thr_51aa0d", note: "halted_epoch_lock · stopped 2m before 5h resetAt, requeued",
    },
    {
      id: "sp-06", lineIndex: 8, source: "sparkles-md", mode: "scratch", status: "pending",
      title: "Animated terminal GIF storyboard for Show HN",
      prompt: "Storyboard a 20-second terminal recording of `npx t3-pilot up` and the Cockpit.",
    },
    {
      id: "sp-07", lineIndex: 9, source: "sparkles-md", mode: "worktree", status: "failed",
      title: "Regenerate fixtures with gemini-3.8-flash snapshots",
      prompt: "Refresh test fixtures using the flash model and verify the suite.",
      branchName: "sparkle/regen-fixtures", threadId: "thr_9be310", note: "Typecheck failed after 3 attempts",
    },
  ];
}

function makeRun(
  pool: QuotaPoolSnapshot, model: string, item: SparkleItem, startedAt: number, outcome: SparkleRunRecord["outcome"],
  endedAt: number | null, stopReason: string | null,
): SparkleRunRecord {
  const sessionReset = pool.sessionWindow?.resetsAt ?? null;
  const weeklyReset = pool.weeklyWindow?.resetsAt ?? null;
  const deadlines = [sessionReset, weeklyReset].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  const earliest = deadlines.length ? Math.min(...deadlines) : null;
  return {
    runId: `run_${item.id}_${startedAt.toString(36).slice(-5)}`,
    itemId: item.id,
    itemTitle: item.title,
    mode: item.mode,
    threadId: item.threadId ?? `thr_${item.id}`,
    branchName: item.mode === "worktree" ? item.branchName ?? `sparkle/${item.id}` : null,
    scratchDir: item.mode === "scratch" ? `.t3-pilot/scratch/${item.id}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28).replace(/-$/, "")}` : null,
    poolId: pool.poolId,
    providerInstanceId: pool.providerInstanceId,
    driver: pool.driver,
    model,
    startedAt: iso(startedAt),
    endedAt: endedAt === null ? null : iso(endedAt),
    outcome,
    stopReason,
    lease: {
      leaseId: `lease_${item.id}`,
      poolId: pool.poolId,
      providerInstanceId: pool.providerInstanceId,
      leasedAt: iso(startedAt),
      targetSessionResetAt: sessionReset,
      targetWeeklyResetAt: weeklyReset,
      hardDeadlineAt: earliest === null ? null : iso(earliest - 2 * MINUTE_MS),
      safetyMarginMs: 2 * MINUTE_MS,
    },
  };
}

export function buildHumanReport(state: HumanActivityState, anchorMs: number, nowMs: number, cooldownMinutes = 15): HumanPreemptionReport {
  if (state === "PREEMPTED_ACTIVE_HUMAN_TURN") {
    return {
      shouldPreempt: true, state, cooldownMinutes,
      activeHumanRuns: [{
        runId: "run_human_01", threadId: "thr_human_ab12", threadTitle: "Refactor sqlite inspector read-only pragma",
        status: "running", provider: "codex", requestedAt: iso(anchorMs - 2 * MINUTE_MS), completedAt: null,
      }],
      lastHumanActivityAt: iso(anchorMs - 2 * MINUTE_MS), resumeAvailableAt: null, resumeInMs: 0,
      reason: "A human-initiated turn is running — t3-pilot yielded immediately.",
    };
  }
  if (state === "COOLDOWN_AFTER_HUMAN_TURN") {
    const resumeAt = anchorMs + 9 * MINUTE_MS;
    return {
      shouldPreempt: true, state, cooldownMinutes, activeHumanRuns: [],
      lastHumanActivityAt: iso(resumeAt - cooldownMinutes * MINUTE_MS), resumeAvailableAt: iso(resumeAt),
      resumeInMs: Math.max(0, resumeAt - nowMs),
      reason: `Waiting out the ${cooldownMinutes}-minute idle cooldown after the last human turn.`,
    };
  }
  return {
    shouldPreempt: false, state: "CLEAR_FOR_PILOT", cooldownMinutes, activeHumanRuns: [],
    lastHumanActivityAt: iso(anchorMs - 3 * HOUR_MS), resumeAvailableAt: null, resumeInMs: 0,
    reason: `No human-initiated turns in the last ${cooldownMinutes} minutes.`,
  };
}

/* ---------------------------------------------------------------- Sync model */

interface SyncTargetFile {
  harness: SyncHarnessTarget;
  path: string;
  content: string;
}

const CANONICAL_SERVERS = {
  "t3-pilot": { command: "npx", args: ["-y", "t3-pilot", "mcp"], description: "t3-pilot quota router, Sparkle queue & Guarded Turbo shield" },
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function initialDisk(): Map<string, string | null> {
  return new Map<string, string | null>([
    [".agents/mcp_config.json", json({ mcpServers: { github: CANONICAL_SERVERS.github } })],
    [".codex/config.toml", 'model = "gpt-6.2-sol"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n'],
    [".mcp.json", json({ mcpServers: { github: CANONICAL_SERVERS.github } })],
    [".claude/settings.json", json({ permissions: { allow: ["Bash(npm test)", "Bash(npm run build)"] } })],
  ]);
}

function skillMarkdown(policy: ShieldPolicyConfig): string {
  const enabled = policy.rules.filter((rule) => rule.enabled);
  const list = (decision: string) => enabled.filter((rule) => rule.decision === decision).map((rule) => `- **${rule.title}** — ${rule.description}`);
  return [
    "---",
    "name: guarded-turbo",
    "description: t3-pilot Guarded Turbo red lines (soft-normative layer paired with the PreToolUse hook).",
    "---",
    "",
    `# Guarded Turbo · mode: ${policy.mode}`,
    "",
    "## Never attempt (hard deny)",
    ...(list("deny").length ? list("deny") : ["- _(none enabled)_"]),
    "",
    "## Ask the human first (force_ask)",
    ...(list("force_ask").length ? list("force_ask") : ["- _(none enabled)_"]),
    "",
    `Protected branches: ${policy.protectedBranches.join(", ")}`,
    "Everything else inside this workspace: cruise at full speed.",
    "",
  ].join("\n");
}

function codexRules(policy: ShieldPolicyConfig): string {
  const lines = ["# Generated by t3-pilot · Guarded Turbo", `# mode: ${policy.mode}`, ""];
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.decision === "allow" || policy.mode === "off") continue;
    for (const pattern of rule.codexPrefixPatterns ?? []) {
      lines.push(`prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = "${rule.decision === "deny" ? "forbidden" : "prompt"}")`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function syncTargetFiles(policy: ShieldPolicyConfig): SyncTargetFile[] {
  const hook = (harness: string) => `node .t3-pilot/hooks/guarded-turbo.mjs --harness ${harness}`;
  const skill = skillMarkdown(policy);
  return [
    { harness: "antigravity", path: ".agents/skills/guarded-turbo/SKILL.md", content: skill },
    { harness: "antigravity", path: ".agents/mcp_config.json", content: json({ mcpServers: CANONICAL_SERVERS }) },
    { harness: "antigravity", path: ".agents/hooks.json", content: json({ hooks: { PreToolUse: [{ matcher: "*", command: hook("antigravity"), timeoutMs: 5000 }] } }) },
    { harness: "codex", path: ".codex/skills/guarded-turbo/SKILL.md", content: skill },
    {
      harness: "codex", path: ".codex/config.toml",
      content: [
        'model = "gpt-6.2-sol"', "",
        "[mcp_servers.t3-pilot]", 'command = "npx"', 'args = ["-y", "t3-pilot", "mcp"]', "",
        "[mcp_servers.github]", 'command = "npx"', 'args = ["-y", "@modelcontextprotocol/server-github"]', "",
      ].join("\n"),
    },
    { harness: "codex", path: ".codex/rules/t3-pilot-guarded-turbo.rules", content: codexRules(policy) },
    { harness: "claude-code", path: ".claude/skills/guarded-turbo/SKILL.md", content: skill },
    { harness: "claude-code", path: ".mcp.json", content: json({ mcpServers: CANONICAL_SERVERS }) },
    {
      harness: "claude-code", path: ".claude/settings.json",
      content: json({
        permissions: { allow: ["Bash(npm test)", "Bash(npm run build)"] },
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook("claude-code") }] }] },
      }),
    },
  ];
}

interface SyncSnapshot {
  id: string;
  entries: { path: string; before: string | null }[];
}

/* ---------------------------------------------------------------- Backend */

export interface DemoBackendOptions {
  scenarioId?: DemoScenarioId;
  now?: () => number;
}

export class DemoBackend implements CockpitClient {
  readonly mode = "demo" as const;
  private readonly clock: () => number;
  scenarioId: DemoScenarioId;
  private anchorMs: number;
  humanState: HumanActivityState;
  private humanAnchorMs: number;
  private sparkles: SparkleItem[] = baseSparkles();
  private shield: ShieldPolicyConfig = createDefaultShieldPolicy();
  private disk = initialDisk();
  private snapshots: SyncSnapshot[] = [];
  private lastSnapshotId: string | null = null;
  private counter = 0;

  constructor(options: DemoBackendOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.scenarioId = options.scenarioId ?? "full-throttle";
    this.anchorMs = this.clock();
    this.humanState = getScenario(this.scenarioId).human;
    this.humanAnchorMs = this.anchorMs;
  }

  get scenario(): DemoScenario {
    return getScenario(this.scenarioId);
  }

  setScenario(id: DemoScenarioId): PilotStatusSummary {
    this.scenarioId = id;
    this.anchorMs = this.clock();
    this.humanState = getScenario(id).human;
    this.humanAnchorMs = this.anchorMs;
    return this.snapshot();
  }

  /** CLEAR → HUMAN TURN ACTIVE → 15M COOLDOWN → CLEAR. */
  cycleHuman(): PilotStatusSummary {
    const order: HumanActivityState[] = ["CLEAR_FOR_PILOT", "PREEMPTED_ACTIVE_HUMAN_TURN", "COOLDOWN_AFTER_HUMAN_TURN"];
    this.humanState = order[(order.indexOf(this.humanState) + 1) % order.length]!;
    this.humanAnchorMs = this.clock();
    return this.snapshot();
  }

  snapshot(): PilotStatusSummary {
    const now = this.clock();
    const scenario = this.scenario;
    const pools = buildDemoPools(scenario, this.anchorMs);
    const pacing = evaluateAllPools(pools, new Date(now), DEMO_CONFIG.pacing);
    const human = buildHumanReport(this.humanState, this.humanAnchorMs, now, DEMO_CONFIG.cooldownMinutes);
    const poolById = new Map(pools.map((pool) => [pool.poolId, pool]));
    const codex = poolById.get("codex")!;

    const runItem = this.sparkles.find((item) => item.id === RUN_ITEM_ID)!;
    const history: SparkleRunRecord[] = [
      makeRun(codex, "gpt-6.2-sol", this.sparkles[0]!, this.anchorMs - 11 * HOUR_MS, "completed", this.anchorMs - 9 * HOUR_MS, null),
      makeRun(poolById.get("antigravity-gemini")!, "gemini-4-neon", this.sparkles[4]!, this.anchorMs - 7 * HOUR_MS, "halted_epoch_lock",
        this.anchorMs - 6 * HOUR_MS, "HARD_STOP_SAFETY_MARGIN: 2 minutes before session resetAt."),
    ];

    let activeRun: SparkleRunRecord | null = null;
    let runStatus: SparkleItem["status"] = "pending";
    let runNote: string | undefined;
    if (scenario.activeRun) {
      const pool = poolById.get(scenario.activeRun.poolId)!;
      if (human.state === "CLEAR_FOR_PILOT") {
        activeRun = makeRun(pool, scenario.activeRun.model, runItem, this.anchorMs - 18 * MINUTE_MS, "running", null, null);
        runStatus = "running";
      } else {
        history.unshift({ ...makeRun(pool, scenario.activeRun.model, runItem, this.anchorMs - 18 * MINUTE_MS, "preempted_human", this.humanAnchorMs,
          "Human-initiated turn detected — yielded instantly."), requeue: true });
        runNote = "Preempted by a human turn · requeued";
      }
    } else if (scenario.id === "shield-locked") {
      history.unshift({ ...makeRun(codex, "gpt-6.2-sol", runItem, this.anchorMs - 50 * MINUTE_MS, "preempted_human", this.anchorMs - 2 * MINUTE_MS,
        "Human-initiated turn detected — yielded instantly."), requeue: true });
      runNote = "Preempted by a human turn · requeued";
    }

    const leaseNote = activeRun ? `Leased ${activeRun.poolId} · ${activeRun.model}` : undefined;
    const sparkles = this.sparkles.map((item): SparkleItem => {
      if (item.id !== RUN_ITEM_ID) return { ...item };
      const note = runNote ?? leaseNote ?? item.note;
      return { ...item, status: runStatus, ...(note !== undefined ? { note } : {}) };
    });

    return {
      generatedAt: iso(now),
      workspaceRoot: "~/projects/t3-pilot-demo",
      config: structuredClone(DEMO_CONFIG),
      pools,
      pacing,
      humanPreemption: human,
      sparkles,
      runtimeState: {
        version: 1,
        updatedAt: iso(now),
        pilotThreadIds: ["thr_7f2a91", "thr_c09e44", "thr_51aa0d", "thr_9be310"],
        activeRun,
        history,
        lastSyncSnapshotId: this.lastSnapshotId,
      },
      shield: structuredClone(this.shield),
    };
  }

  async getStatus(): Promise<PilotStatusSummary> {
    return this.snapshot();
  }

  async route(task: string) {
    const trimmed = task.trim();
    if (!trimmed) throw new Error("Describe a task to route.");
    const pools = buildDemoPools(this.scenario, this.anchorMs);
    return routeTask(trimmed, pools, { now: new Date(this.clock()), pacingConfig: DEMO_CONFIG.pacing });
  }

  async addSparkle(input: AddSparkleInput) {
    const title = input.title.trim();
    if (!title) throw new Error("A Sparkle needs a title.");
    if (/[\r\n]/.test(title)) throw new Error("A Sparkle title must be a single line.");
    this.counter += 1;
    const added: SparkleItem = {
      id: `sp-${String(this.sparkles.length + 1).padStart(2, "0")}-${this.counter}`,
      lineIndex: this.sparkles.length + 3,
      source: "sparkles-md",
      mode: input.mode ?? "worktree",
      status: "pending",
      title,
      prompt: input.prompt?.trim() || title,
    };
    this.sparkles.push(added);
    return { added: { ...added }, queue: this.snapshot().sparkles };
  }

  async configureShield(patch: ShieldPatch) {
    const changesRule = patch.enabled !== undefined || patch.decision !== undefined;
    if (changesRule !== (patch.ruleId !== undefined)) {
      throw new Error("Provide a ruleId and either enabled or decision to update a rule.");
    }
    if (patch.ruleId && !this.shield.rules.some((rule) => rule.id === patch.ruleId)) {
      throw new Error(`Unknown Guarded Turbo rule "${patch.ruleId}".`);
    }
    if (patch.mode) this.shield.mode = patch.mode;
    if (patch.ruleId) {
      this.shield.rules = this.shield.rules.map((rule) => rule.id === patch.ruleId
        ? { ...rule, ...(patch.enabled !== undefined && { enabled: patch.enabled }), ...(patch.decision && { decision: patch.decision }) }
        : rule);
    }
    return { shield: structuredClone(this.shield) };
  }

  async checkShield(check: ShieldCheckInput) {
    if (!check.toolName.trim()) throw new Error("A shield check requires a tool name.");
    return { shield: structuredClone(this.shield), evaluation: evaluateShieldToolCall(check, this.shield) };
  }

  private plan(targets: readonly SyncHarnessTarget[]): SyncPlanResult {
    const changes: SyncFileChange[] = syncTargetFiles(this.shield)
      .filter((file) => targets.includes(file.harness))
      .map((file) => {
        const before = this.disk.get(file.path) ?? null;
        return {
          harness: file.harness,
          targetPath: file.path,
          action: before === null ? "create" : before === file.content ? "unchanged" : "update",
          beforeContent: before,
          afterContent: file.content,
          unifiedDiff: unifiedDiff(file.path, before, file.content),
        };
      });
    return {
      sourceSkillsDir: ".t3-pilot/skills",
      sourceMcpPath: ".t3-pilot/mcp.json",
      discoveredSkills: ["guarded-turbo", "sparkle-scout"],
      discoveredMcpServers: Object.keys(CANONICAL_SERVERS),
      changes,
      applied: false,
      warnings: this.shield.mode === "off" ? ["Guarded Turbo is Off — synced hooks will allow every tool call."] : [],
    };
  }

  async sync(input: PilotSyncActionInput): Promise<PilotSyncActionOutput> {
    if (input.rollbackSnapshotId !== undefined && input.rollbackSnapshotId !== false) {
      const index = typeof input.rollbackSnapshotId === "string"
        ? this.snapshots.findIndex((snapshot) => snapshot.id === input.rollbackSnapshotId)
        : this.snapshots.length - 1;
      const snapshot = this.snapshots[index];
      if (!snapshot) throw new Error("No sync snapshot is available to roll back.");
      this.snapshots.splice(index, 1);
      const restoredPaths: string[] = [];
      const removedPaths: string[] = [];
      for (const entry of snapshot.entries) {
        if (entry.before === null) {
          this.disk.delete(entry.path);
          removedPaths.push(entry.path);
        } else {
          this.disk.set(entry.path, entry.before);
          restoredPaths.push(entry.path);
        }
      }
      this.lastSnapshotId = this.snapshots.at(-1)?.id ?? null;
      return { mode: "rollback", result: { snapshotId: snapshot.id, restoredPaths, removedPaths } };
    }
    const targets = input.targets?.length ? input.targets : DEMO_CONFIG.syncTargets;
    const plan = this.plan(targets);
    if (input.dryRun !== false) return { mode: "plan", result: plan };
    const changed = plan.changes.filter((change) => change.action !== "unchanged");
    const snapshotId = `sync-${new Date(this.clock()).toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${++this.counter}`;
    if (changed.length) {
      this.snapshots.push({ id: snapshotId, entries: changed.map((change) => ({ path: change.targetPath, before: change.beforeContent })) });
      for (const change of changed) this.disk.set(change.targetPath, change.afterContent);
      this.lastSnapshotId = snapshotId;
    }
    return { mode: "apply", result: { ...plan, applied: true, ...(changed.length > 0 ? { snapshotId } : {}) } };
  }
}

export function scenarioPoolIds(): QuotaPoolId[] {
  return ["codex", "antigravity-gemini", "antigravity-claude"];
}
