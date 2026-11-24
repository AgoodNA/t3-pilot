/**
 * Faithful browser port of `packages/core/src/task-router.ts`
 * (Task-Affinity × Burnable Surplus × Reset Urgency, with the 20% Reserve Shield lockout).
 */
import { clamp, evaluateAllPools, finiteOr } from "./pacing";
import type {
  ModelCandidate, PacingConfig, QuotaPoolSnapshot, RouteDecision, ScoredModelRoute, TaskCategory,
} from "../types";

const taskSignals: [TaskCategory, RegExp][] = [
  ["BOILERPLATE_DOCS_TRANSLATIONS", /\b(?:translat\w*|i18n|locali[sz]\w*|fixtures?|renam\w*|boilerplate|changelog|formatting|typos?)\b/i],
  ["ARCHITECTURE_ORCHESTRATION", /\b(?:architect\w*|spec(?:ification)?s?|plan(?:ning|s)?|orchestrat\w*|multi[- ]agent|trade[- ]?offs?|reviews?)\b/i],
  ["UI_FRONTEND_LONGFORM", /\b(?:ui|ux|react|css|front[- ]?end|design\w*|animat\w*|cockpit|html(?:\s+cards?)?|long[- ]form|readme|blog|copywriting)\b/i],
  ["BOILERPLATE_DOCS_TRANSLATIONS", /\b(?:docs|documentation)\b/i],
  ["SYSTEMS_PARSERS_TESTS_DEBUGGING", /\b(?:sqlite|pars\w*|state\s+machine|math|algorithm\w*|cli|daemon|concurren\w*|bugs?|debug\w*|test\w*|vitest|typescript(?:\s+engine)?)\b/i],
];

export function classifyTask(task: string): TaskCategory {
  return taskSignals.find(([, pattern]) => pattern.test(task))?.[0] ?? "SYSTEMS_PARSERS_TESTS_DEBUGGING";
}

export const CATEGORY_LABELS: Record<TaskCategory, { short: string; long: string }> = {
  UI_FRONTEND_LONGFORM: { short: "UI · Frontend · Long-form", long: "UI/UX, React, CSS, cockpit visuals and long-form writing" },
  SYSTEMS_PARSERS_TESTS_DEBUGGING: { short: "Systems · Parsers · Tests", long: "State machines, parsers, SQLite, CLI/daemon concurrency, tests and debugging" },
  BOILERPLATE_DOCS_TRANSLATIONS: { short: "Boilerplate · Docs · i18n", long: "Fixtures, translations, renames, changelogs and documentation" },
  ARCHITECTURE_ORCHESTRATION: { short: "Architecture · Orchestration", long: "Specs, plans, multi-agent orchestration, trade-offs and reviews" },
};

type ModelProfile = Omit<ModelCandidate, "providerInstanceId" | "driver">;

function affinities(ui: number, systems: number, boilerplate: number, architecture: number): ModelCandidate["affinities"] {
  return {
    UI_FRONTEND_LONGFORM: ui,
    SYSTEMS_PARSERS_TESTS_DEBUGGING: systems,
    BOILERPLATE_DOCS_TRANSLATIONS: boilerplate,
    ARCHITECTURE_ORCHESTRATION: architecture,
  };
}

const profiles: ModelProfile[] = [
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", poolId: "codex", defaultOptions: { reasoningEffort: "high" }, affinities: affinities(0.35, 1, 0.45, 0.65) },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", poolId: "antigravity-claude", defaultOptions: { thought_level: "high" }, affinities: affinities(1, 0.36, 0.48, 1) },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", poolId: "antigravity-claude", defaultOptions: { thought_level: "high" }, affinities: affinities(0.97, 0.35, 0.55, 0.95) },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon", poolId: "antigravity-gemini", defaultOptions: { thought_level: "high" }, affinities: affinities(0.9, 0.35, 0.55, 0.94) },
  { id: "gemini-4-neon", label: "Gemini 4 Neon", poolId: "antigravity-gemini", defaultOptions: { thought_level: "high" }, affinities: affinities(0.86, 0.32, 0.62, 0.9) },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", poolId: "antigravity-gemini", defaultOptions: { thought_level: "medium" }, affinities: affinities(0.45, 0.23, 1, 0.48) },
];

export function getDefaultModelCatalog(pools: readonly QuotaPoolSnapshot[]): ModelCandidate[] {
  return profiles.flatMap((profile) => pools
    .filter((pool) => pool.poolId === profile.poolId)
    .map((pool) => ({
      ...profile,
      affinities: { ...profile.affinities },
      defaultOptions: { ...profile.defaultOptions },
      driver: pool.driver,
      providerInstanceId: pool.providerInstanceId,
    })));
}

export interface RouteTaskOptions {
  pacingConfig?: PacingConfig;
  now?: Date;
  manualOverride?: boolean;
  externalUnmeteredSurplusFactor?: number;
}

export function routeTask(task: string, pools: readonly QuotaPoolSnapshot[], options: RouteTaskOptions = {}): RouteDecision {
  const category = classifyTask(task);
  const manualOverride = options.manualOverride ?? false;
  const externalFactor = clamp(finiteOr(options.externalUnmeteredSurplusFactor, 0.5), 0, 1);
  const pacing = evaluateAllPools(pools, options.now, options.pacingConfig);
  const ranked = getDefaultModelCatalog(pools).map((candidate): ScoredModelRoute => {
    const index = pools.findIndex((pool) => pool.poolId === candidate.poolId
      && pool.providerInstanceId === candidate.providerInstanceId && pool.driver === candidate.driver);
    const pool = pools[index];
    const metrics = pacing[index];
    const ready = Boolean(pool?.enabled && pool.status === "ready" && pool.source !== "unavailable");
    const manualOverrideApplied = ready && manualOverride && metrics?.shieldLocked === true;
    const blockedReason = !ready ? "The provider pool is unavailable." : manualOverrideApplied ? null : metrics?.shieldReason ?? null;
    const eligible = blockedReason === null;
    const taskAffinity = candidate.affinities[category];
    const surplusFactor = metrics?.harvestMode === "EXTERNAL_UNMETERED"
      ? externalFactor
      : clamp((metrics?.effectiveBurnablePercent ?? 0) / 80, 0, 1);
    const urgencyWeight = 1 + 0.5 * clamp(metrics?.couplingRatio ?? 0, 0, 1.5);
    return {
      candidate, eligible, blockedReason, manualOverrideApplied, taskAffinity, surplusFactor, urgencyWeight,
      compositeScore: eligible ? taskAffinity * surplusFactor * urgencyWeight : 0,
      t3ThreadConfigurePayload: {
        modelSelection: {
          instanceId: candidate.providerInstanceId,
          provider: candidate.driver,
          model: candidate.id,
          ...(candidate.defaultOptions && { options: { ...candidate.defaultOptions } }),
        },
      },
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.compositeScore - a.compositeScore);

  const overridePools = new Set(ranked.filter((route) => route.manualOverrideApplied).map((route) => route.candidate.poolId));
  return {
    task, category, manualOverride, ranked,
    selected: ranked.find((route) => route.eligible) ?? null,
    warnings: [...overridePools].map((pool) => `Manual override bypassed the quota shield for ${pool}.`),
  };
}
