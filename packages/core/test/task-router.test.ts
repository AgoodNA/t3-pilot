import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyTask, getDefaultModelCatalog, routeTask } from "../src/task-router.js";
import type { QuotaPoolSnapshot } from "../src/types.js";

const vectors: { pool: QuotaPoolSnapshot }[] =
  JSON.parse(readFileSync(new URL("./fixtures/golden-pacing-vectors.json", import.meta.url), "utf8"));
const gemini = vectors[0]!.pool;
const claude = vectors[1]!.pool;
const codex = vectors.at(-1)!.pool;
const now = new Date("2026-11-25T10:00:00Z");

describe("task routing", () => {
  it.each([
    ["Implement a React animation for the Cockpit", "UI_FRONTEND_LONGFORM"],
    ["Debug the SQLite state machine and add Vitest cases", "SYSTEMS_PARSERS_TESTS_DEBUGGING"],
    ["Translate the changelog and generate fixtures", "BOILERPLATE_DOCS_TRANSLATIONS"],
    ["Update the API documentation", "BOILERPLATE_DOCS_TRANSLATIONS"],
    ["Review architecture tradeoffs for multi-agent orchestration", "ARCHITECTURE_ORCHESTRATION"],
  ])("classifies %s", (task, expected) => {
    expect(classifyTask(task)).toBe(expected);
  });

  it("binds each configured model to its observed provider instance", () => {
    const catalog = getDefaultModelCatalog([gemini, claude, codex]);
    expect(catalog).toHaveLength(6);
    expect(catalog.find(({ id }) => id === "gemini-3.8-flash")).toMatchObject({
      providerInstanceId: "antigravity", driver: "antigravity", defaultOptions: { thought_level: "medium" },
    });
  });

  it("can route systems to unmetered Codex and emits the T3 configuration payload", () => {
    const decision = routeTask("Debug the daemon parser", [gemini, claude, codex], { now });
    expect(decision.selected).toMatchObject({
      taskAffinity: 1, surplusFactor: 0.5, urgencyWeight: 1, compositeScore: 0.5,
      t3ThreadConfigurePayload: {
        modelSelection: {
          instanceId: "codex_oauth", provider: "codex", model: "gpt-6.2-sol", options: { reasoningEffort: "high" },
        },
      },
    });
    const geminiNow = new Date(gemini.checkedAt!);
    expect(routeTask("Translate a fixture", [gemini, codex], { now: geminiNow }).selected?.candidate.id)
      .toBe("gemini-3.8-flash");
  });

  it("calculates the coupled surplus and urgency weights before ranking", () => {
    const pool = {
      ...gemini,
      weeklyWindow: { ...gemini.weeklyWindow!, remainingPercent: 84, resetsAt: "2026-11-25T15:00:00Z" },
      sessionWindow: { ...gemini.sessionWindow!, remainingPercent: 60, resetsAt: "2026-11-25T13:00:00Z" },
    };
    const route = routeTask("Translate a changelog", [pool, codex], { now }).selected;
    expect(route).toMatchObject({
      taskAffinity: 1, surplusFactor: 0.5, urgencyWeight: 1.75, compositeScore: 0.875,
    });
  });

  it("blocks shielded pools until a manual override and reports the bypass", () => {
    const limited = { ...claude, sessionWindow: { ...claude.sessionWindow!, remainingPercent: 20 } };
    const blocked = routeTask("Design a React UI", [limited], { now });
    expect(blocked.selected).toBeNull();
    expect(blocked.ranked[0]).toMatchObject({
      eligible: false, blockedReason: expect.stringContaining("20%"), compositeScore: 0,
    });

    const forced = routeTask("Design a React UI", [limited], { now, manualOverride: true });
    expect(forced.selected).toMatchObject({ eligible: true, manualOverrideApplied: true });
    expect(forced.warnings).toEqual([expect.stringContaining("antigravity-claude")]);
  });

  it("blocks automatic routing inside the epoch guard", () => {
    const withinMargin = { ...claude, sessionWindow: { ...claude.sessionWindow!, resetsAt: "2026-11-25T10:02:00Z" } };
    const decision = routeTask("Design the cockpit", [withinMargin], { now });
    expect(decision.selected).toBeNull();
    expect(decision.ranked[0]?.blockedReason).toContain("reset safety margin");
  });

  it("takes a custom unmetered fallback and never enables an offline instance via shield override", () => {
    const unavailable = { ...gemini, status: "error" };
    const routed = routeTask("Debug a parser", [unavailable, codex], {
      now, externalUnmeteredSurplusFactor: 0.3, manualOverride: true,
    });
    expect(routed.selected?.surplusFactor).toBe(0.3);
    expect(routed.ranked.filter(({ eligible }) => !eligible)).toHaveLength(3);
    expect(routed.warnings).toEqual([]);
  });
});
