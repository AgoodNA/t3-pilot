import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { evaluateAllPools as coreEvaluateAllPools } from "../../../packages/core/src/pacing-engine";
import { evaluateShieldToolCall as coreEvaluateShield } from "../../../packages/core/src/shield-policy";
import { routeTask as coreRouteTask } from "../../../packages/core/src/task-router";
import type { PilotStatusSummary as CorePilotStatus } from "../../../packages/daemon/src/types";
import { LiveClient, wantsDemoFromUrl } from "../src/api";
import { App, type ViewId } from "../src/App";
import { humanIndicator } from "../src/components/CommandBar";
import { pacePoints } from "../src/components/PaceCurve";
import { configureSnippet } from "../src/components/RouterTester";
import { SANDBOX_PRESETS } from "../src/components/ShieldView";
import { filterSparkles } from "../src/components/SparkleView";
import { DEMO_CONFIG, DEMO_SCENARIOS, DemoBackend, buildDemoPools, getScenario, type DemoScenarioId } from "../src/engine/demo";
import { unifiedDiff } from "../src/engine/diff";
import { evaluateAllPools } from "../src/engine/pacing";
import { classifyTask, routeTask } from "../src/engine/router";
import { createDefaultShieldPolicy, evaluateShieldToolCall, formatHookDecisionOutput } from "../src/engine/shield";
import { fmtCountdown, fmtSigned } from "../src/format";
import type { PilotStatusSummary, ShieldToolCallInput } from "../src/types";

const NOW = Date.parse("2026-11-24T05:00:00.000Z");
const clock = () => NOW;
const backend = (scenarioId: DemoScenarioId) => new DemoBackend({ scenarioId, now: clock });
const modes = (status: PilotStatusSummary) => Object.fromEntries(status.pacing.map((entry) => [entry.poolId, entry.harvestMode]));

// Shape bridge: the mirrored browser contract is used where the daemon PilotStatusSummary is expected.
const contractCheck = (status: PilotStatusSummary): CorePilotStatus => status as unknown as CorePilotStatus;

describe("demo scenarios × coupled 7d × 5h harvest law", () => {
  it("Early-Week Cruise preserves every 5h window", () => {
    const status = backend("cruise").snapshot();
    expect(Object.values(modes(status))).toEqual(["PRESERVE_WINDOWS", "PRESERVE_WINDOWS", "PRESERVE_WINDOWS"]);
    expect(status.runtimeState.activeRun).toBeNull();
    expect(status.humanPreemption?.state).toBe("CLEAR_FOR_PILOT");
  });

  it("<45m Expiring scenario harvests expiring windows only when weekly pace has surplus", () => {
    const status = backend("expiring").snapshot();
    expect(modes(status)).toEqual({
      codex: "EXPIRING_5H_HARVEST",
      "antigravity-gemini": "EXPIRING_5H_HARVEST",
      "antigravity-claude": "PRESERVE_WINDOWS",
    });
    const claude = status.pacing.find((entry) => entry.poolId === "antigravity-claude")!;
    expect(claude.paceDeltaPercent!).toBeLessThan(0);
    const lease = status.runtimeState.activeRun!.lease;
    expect(Date.parse(lease.hardDeadlineAt!)).toBe(Date.parse(lease.targetSessionResetAt!) - 2 * 60_000);
  });

  it("24h left with 80% weekly enters FULL_THROTTLE_HARVEST (κ = 60 / 70 ≈ 0.857)", () => {
    const status = backend("full-throttle").snapshot();
    const codex = status.pacing.find((entry) => entry.poolId === "codex")!;
    expect(codex.harvestMode).toBe("FULL_THROTTLE_HARVEST");
    expect(codex.remaining5hWindowsCount).toBe(5);
    expect(codex.couplingRatio).toBeCloseTo(60 / 70, 5);
    expect(modes(status)["antigravity-claude"]).toBe("EXPIRING_5H_HARVEST");
    expect(status.runtimeState.activeRun?.poolId).toBe("antigravity-gemini");
  });

  it("<=20% Reserve Shield locks codex (weekly) and claude (5h) and yields to the human", () => {
    const status = backend("shield-locked").snapshot();
    expect(modes(status)).toEqual({
      codex: "LOCKED_SHIELD",
      "antigravity-gemini": "PRESERVE_WINDOWS",
      "antigravity-claude": "LOCKED_SHIELD",
    });
    expect(status.pacing.find((entry) => entry.poolId === "codex")!.effectiveBurnablePercent).toBe(0);
    expect(status.humanPreemption?.state).toBe("PREEMPTED_ACTIVE_HUMAN_TURN");
    expect(humanIndicator(status.humanPreemption, NOW).label).toBe("HUMAN TURN ACTIVE — YIELDED");
  });

  it("matches the canonical @t3-pilot/core pacing engine for every scenario", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const pools = buildDemoPools(scenario, NOW);
      const later = new Date(NOW + 17 * 60_000);
      expect(evaluateAllPools(pools, later, DEMO_CONFIG.pacing)).toEqual(coreEvaluateAllPools(pools as never, later, DEMO_CONFIG.pacing));
    }
  });

  it("projects pools onto the 168h pace curve with signed pace deltas", () => {
    const status = backend("full-throttle").snapshot();
    const points = pacePoints(status.pools, status.pacing);
    expect(points).toHaveLength(3);
    for (const point of points) {
      expect(point.hour).toBeCloseTo(144, 5);
      expect(point.ideal).toBeCloseTo(100 - (144 / 168) * 80, 5);
      expect(point.delta).toBeCloseTo(point.weekly - point.ideal, 5);
    }
    expect(contractCheck(status).pools).toHaveLength(3);
  });
});

describe("Task-Fit × Surplus smart router", () => {
  it("classifies archetypes", () => {
    expect(classifyTask("Polish Cockpit React UI")).toBe("UI_FRONTEND_LONGFORM");
    expect(classifyTask("Debug SQLite WAL parser race")).toBe("SYSTEMS_PARSERS_TESTS_DEBUGGING");
    expect(classifyTask("Translate README into Chinese")).toBe("BOILERPLATE_DOCS_TRANSLATIONS");
    expect(classifyTask("Architect a multi-agent spec")).toBe("ARCHITECTURE_ORCHESTRATION");
  });

  it("never auto-routes into a shield-locked pool", async () => {
    const decision = await backend("shield-locked").route("Debug the SQLite parser");
    expect(decision.selected?.candidate.poolId).toBe("antigravity-gemini");
    const locked = decision.ranked.filter((route) => !route.eligible);
    expect(locked.map((route) => route.candidate.poolId).sort()).toEqual(["antigravity-claude", "antigravity-claude", "codex"]);
    expect(locked.every((route) => route.compositeScore === 0 && route.blockedReason)).toBe(true);
    expect(JSON.parse(configureSnippet(decision)).modelSelection.instanceId).toBe("antigravity");
  });

  it("matches the canonical @t3-pilot/core router", () => {
    for (const scenario of DEMO_SCENARIOS) {
      const pools = buildDemoPools(scenario, NOW);
      for (const task of ["Polish Cockpit React UI", "Write vitest tests", "Translate docs", "Plan the architecture"]) {
        const options = { now: new Date(NOW), pacingConfig: DEMO_CONFIG.pacing };
        expect(routeTask(task, pools, options)).toEqual(coreRouteTask(task, pools as never, options));
      }
    }
  });

  it("emits a ready-to-paste t3_thread_configure payload", () => {
    const decision = routeTask("Polish Cockpit React UI", buildDemoPools(getScenario("full-throttle"), NOW), { now: new Date(NOW), pacingConfig: DEMO_CONFIG.pacing });
    const snippet = JSON.parse(configureSnippet(decision));
    expect(snippet.modelSelection).toEqual(decision.selected!.t3ThreadConfigurePayload.modelSelection);
    expect(snippet.threadId).toBe("<idle-thread-id>");
  });
});

describe("Guarded Turbo PreToolUse sandbox", () => {
  const expected: Record<string, string> = {
    "rm -rf /": "deny",
    "cat ~/.ssh/id_rsa": "deny",
    "git push --force origin main": "deny",
    "ufw disable": "deny",
    "npm publish": "force_ask",
    "gh repo edit --visibility public": "force_ask",
    "npm test": "allow",
  };

  it("returns the documented verdict for every quick-test button", () => {
    const policy = createDefaultShieldPolicy();
    for (const preset of SANDBOX_PRESETS) {
      const result = evaluateShieldToolCall({ harness: "antigravity", toolName: "run_command", command: preset.command }, policy);
      expect(result.decision, preset.label).toBe(expected[preset.label]);
    }
  });

  it("is a verbatim port of the core runtime across harnesses and modes", () => {
    const inputs: ShieldToolCallInput[] = [
      ...SANDBOX_PRESETS.map((preset) => ({ harness: "claude-code" as const, toolName: "Bash", command: preset.command })),
      { harness: "generic", toolName: "read_file", filePath: "~/.aws/credentials" },
      { harness: "codex", toolName: "exec_command", command: "bash -c 'docker system prune -af'" },
      { harness: "antigravity", toolName: "run_command", command: "git status && echo ok" },
    ];
    for (const mode of ["guarded-turbo", "strict", "off"] as const) {
      const policy = createDefaultShieldPolicy({ mode });
      for (const input of inputs) expect(evaluateShieldToolCall(input, policy)).toEqual(coreEvaluateShield(input, policy));
    }
  });

  it("formats hook stdout for Antigravity and Claude Code", () => {
    const deny = evaluateShieldToolCall({ toolName: "run_command", command: "rm -rf /" });
    expect(formatHookDecisionOutput(deny, "antigravity")).toMatchObject({ decision: "deny" });
    const ask = evaluateShieldToolCall({ toolName: "Bash", command: "npm publish" });
    expect(formatHookDecisionOutput(ask, "claude-code")).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
  });
});

describe("stateful DemoBackend endpoints", () => {
  it("appends Sparkles to the queue and rejects multi-line titles", async () => {
    const demo = backend("cruise");
    const before = demo.snapshot().sparkles.length;
    const { added, queue } = await demo.addSparkle({ title: "  Heatmap prototype  ", mode: "scratch" });
    expect(added).toMatchObject({ title: "Heatmap prototype", mode: "scratch", status: "pending", prompt: "Heatmap prototype" });
    expect(queue).toHaveLength(before + 1);
    await expect(demo.addSparkle({ title: "two\nlines" })).rejects.toThrow(/single line/);
    expect(filterSparkles(queue, "halted").map((item) => item.status).sort()).toEqual(["failed", "halted"]);
  });

  it("applies shield rule/mode patches and validates like the daemon", async () => {
    const demo = backend("cruise");
    await demo.configureShield({ ruleId: "deny-destructive-delete", enabled: false });
    expect((await demo.checkShield({ toolName: "run_command", command: "rm -rf /" })).evaluation.decision).toBe("allow");
    await demo.configureShield({ ruleId: "ask-package-publish", decision: "deny" });
    expect((await demo.checkShield({ toolName: "run_command", command: "npm publish" })).evaluation.decision).toBe("deny");
    await demo.configureShield({ mode: "strict" });
    expect((await demo.checkShield({ toolName: "run_command", command: "curl example.invalid" })).evaluation.decision).toBe("force_ask");
    await expect(demo.configureShield({ ruleId: "deny-host-credentials" })).rejects.toThrow(/ruleId/);
    await expect(demo.configureShield({ ruleId: "nope", enabled: true })).rejects.toThrow(/Unknown/);
  });

  it("plans, applies and rolls back cross-harness sync with unified diffs", async () => {
    const demo = backend("cruise");
    const plan = await demo.sync({ dryRun: true, targets: ["antigravity", "claude-code"] });
    if (plan.mode === "rollback") throw new Error("expected a plan");
    expect(plan.result.applied).toBe(false);
    expect(plan.result.changes.every((change) => change.harness !== "codex")).toBe(true);
    const hooks = plan.result.changes.find((change) => change.targetPath === ".agents/hooks.json")!;
    expect(hooks.action).toBe("create");
    expect(hooks.unifiedDiff).toContain("--- /dev/null");

    const applied = await demo.sync({ dryRun: false, targets: ["antigravity", "claude-code"] });
    if (applied.mode !== "apply") throw new Error("expected apply");
    expect(applied.result.snapshotId).toMatch(/^sync-/);
    expect(demo.snapshot().runtimeState.lastSyncSnapshotId).toBe(applied.result.snapshotId);

    const replan = await demo.sync({ dryRun: true, targets: ["antigravity", "claude-code"] });
    if (replan.mode === "rollback") throw new Error("expected a plan");
    expect(replan.result.changes.every((change) => change.action === "unchanged")).toBe(true);

    const rollback = await demo.sync({ rollbackSnapshotId: true });
    if (rollback.mode !== "rollback") throw new Error("expected rollback");
    expect(rollback.result.removedPaths).toContain(".agents/hooks.json");
    expect(rollback.result.restoredPaths).toContain(".agents/mcp_config.json");
    await expect(demo.sync({ rollbackSnapshotId: true })).rejects.toThrow(/No sync snapshot/);
  });

  it("human preemption cycling yields the active Sparkle lease instantly", () => {
    const demo = backend("full-throttle");
    expect(demo.snapshot().runtimeState.activeRun).not.toBeNull();
    const preempted = demo.cycleHuman();
    expect(preempted.humanPreemption?.state).toBe("PREEMPTED_ACTIVE_HUMAN_TURN");
    expect(preempted.runtimeState.activeRun).toBeNull();
    expect(preempted.runtimeState.history[0]).toMatchObject({ outcome: "preempted_human", requeue: true });
    const cooldown = demo.cycleHuman();
    expect(humanIndicator(cooldown.humanPreemption, NOW).label).toMatch(/^15M COOLDOWN/);
    expect(demo.cycleHuman().runtimeState.activeRun).not.toBeNull();
  });
});

describe("helpers", () => {
  it("formats countdowns and signed deltas", () => {
    expect(fmtCountdown(3 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000)).toBe("3d 04h 12m");
    expect(fmtCountdown(42 * 60_000 + 9_000)).toBe("00:42:09");
    expect(fmtCountdown(-5)).toBe("00:00:00");
    expect(fmtSigned(8.29)).toBe("+8.3%");
    expect(fmtSigned(-7.71)).toBe("−7.7%");
  });

  it("produces git-style unified diffs", () => {
    expect(unifiedDiff("a.txt", "one\ntwo\n", "one\nthree\n")).toBe("--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n");
    expect(unifiedDiff("same", "x\n", "x\n")).toBe("");
  });

  it("detects ?demo=1", () => {
    expect(wantsDemoFromUrl("?demo=1")).toBe(true);
    expect(wantsDemoFromUrl("?demo")).toBe(true);
    expect(wantsDemoFromUrl("?demo=0")).toBe(false);
    expect(wantsDemoFromUrl("")).toBe(false);
  });
});

describe("LiveClient REST contract", () => {
  it("posts JSON to the daemon endpoints and surfaces daemon errors", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new LiveClient("", async (url, init) => {
      calls.push({ url, ...(init && { init }) });
      if (url === "/api/status") {
        return Response.json({ ...backend("cruise").snapshot(), pilotToken: "body-token" }, { headers: { "x-pilot-token": "header-token" } });
      }
      if (url === "/api/shield") return new Response(JSON.stringify({ error: "A shield check must be a separate dry-run request." }), { status: 400 });
      return new Response(JSON.stringify({ task: "x", category: "UI_FRONTEND_LONGFORM", ranked: [], selected: null, warnings: [], manualOverride: false }), { status: 200 });
    });
    await client.route("Polish UI");
    await expect(client.checkShield({ toolName: "Bash", command: "ls" })).rejects.toThrow(/separate dry-run/);
    expect(calls).toMatchObject([
      { url: "/api/status", init: { method: "GET" } },
      { url: "/api/route", init: {
        method: "POST", body: JSON.stringify({ task: "Polish UI" }),
        headers: { "content-type": "application/json", "x-pilot-token": "header-token" },
      } },
      { url: "/api/shield", init: { method: "POST", body: JSON.stringify({ check: { toolName: "Bash", command: "ls" } }) } },
    ]);
  });

  it.each([true, false])("refreshes a rotated token once (retry authorized: %s)", async (retryAuthorized) => {
    const status = backend("cruise").snapshot();
    const calls: { url: string; token: string | null }[] = [];
    let serverToken = "initial-token";
    const client = new LiveClient("", async (url, init) => {
      const token = new Headers(init?.headers).get("x-pilot-token");
      calls.push({ url, token });
      if (url === "/api/status") return Response.json({ ...status, pilotToken: serverToken });
      if (!retryAuthorized || token !== serverToken) {
        return Response.json({ error: "Missing or invalid X-Pilot-Token header." }, { status: 403 });
      }
      return Response.json({ shield: status.shield });
    });
    await client.getStatus();
    serverToken = "rotated-token";
    const action = client.configureShield({ mode: "strict" });
    if (retryAuthorized) await expect(action).resolves.toEqual({ shield: status.shield });
    else await expect(action).rejects.toThrow(/Missing or invalid X-Pilot-Token/);
    expect(calls).toEqual([
      { url: "/api/status", token: null },
      { url: "/api/shield", token: "initial-token" },
      { url: "/api/status", token: null },
      { url: "/api/shield", token: "rotated-token" },
    ]);
  });

  it("rejects non-JSON status pages (e.g. GitHub Pages 404) so the UI falls back to demo", async () => {
    const client = new LiveClient("", async () => new Response("<!doctype html><title>404</title>", { status: 404 }));
    await expect(client.getStatus()).rejects.toThrow(/did not return JSON/);
  });
});

describe("server-rendered Cockpit views (react-dom/server)", () => {
  const render = (scenarioId: DemoScenarioId, view: ViewId) => {
    const demo = backend(scenarioId);
    return renderToStaticMarkup(createElement(App, {
      demo, initialMode: "demo", initialStatus: demo.snapshot(), initialView: view, initialTheme: "dark", now: NOW,
    }));
  };

  it("renders the command bar, scenario presets and pacing dashboard", () => {
    const html = render("full-throttle", "pacing");
    for (const text of [
      "LIVE T3 DAEMON", "INTERACTIVE DEMO", "CLEAR FOR PILOT",
      "Early-Week Cruise (Preserve)", "&lt;45m Expiring 5h Harvest", "24h Left · 80% Full-Throttle", "&lt;=20% Reserve Shield Locked",
      "FULL_THROTTLE_HARVEST", "EXPIRING_5H_HARVEST", "5h Session Remaining", "7d Weekly Remaining",
      "EMERGENCY RESERVE SHIELD", "IDEAL BURN 100% → 20%", "Task-Fit × Surplus Router",
    ]) expect(html, text).toContain(text);
  });

  it("renders the shield-locked scenario with lockout badges and the yielded human state", () => {
    const html = render("shield-locked", "pacing");
    expect(html).toContain("LOCKED_SHIELD");
    expect(html).toContain("HUMAN TURN ACTIVE — YIELDED");
  });

  it("renders the Sparkle queue and epoch lease monitor", () => {
    const html = render("expiring", "sparkles");
    for (const text of ["EPOCH LEASE ACTIVE", "hardDeadlineAt = resetAt − 2m", "Add to SPARKLES.md", "Worktree (Branch/PR)", "Scratch (Isolated Sandbox)", "Pending", "Halted"]) {
      expect(html, text).toContain(text);
    }
  });

  it("renders the Guarded Turbo switchboard, all six red-line rules and the sync panel", () => {
    const html = render("cruise", "shield");
    for (const ruleId of [
      "deny-destructive-delete", "deny-host-credentials", "deny-force-push-protected",
      "deny-foreign-containers-and-firewall", "ask-package-publish", "ask-public-repo-visibility",
    ]) expect(html).toContain(ruleId);
    for (const text of ["Guarded Turbo", "Strict", "Preview Diff", "Apply Sync", "Rollback Latest", "git push --force origin main"]) {
      expect(html, text).toContain(text);
    }
  });
});

describe("zero external CDNs", () => {
  it("ships no remote URLs in cockpit sources (SVG namespace excepted)", () => {
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(root);
    const offenders = files.flatMap((file) => (readFileSync(file, "utf8").match(/https?:\/\/[^\s"'`)]+/g) ?? [])
      .filter((url) => !url.startsWith("http://www.w3.org/") && !url.startsWith("http://169.254.169.254"))
      .map((url) => `${file}: ${url}`));
    expect(offenders).toEqual([]);
  });
});
