import { finiteOr, MINUTE_MS, parseTimestamp } from "./quota-math.js";
import { inspectT3State } from "./sqlite-inspector.js";
import type { ActiveHumanRunSummary, HumanPreemptionOptions, HumanPreemptionReport, T3StateSnapshot } from "./types.js";

const activeStatuses = new Set(["running", "starting", "queued", "pending", "waiting", "in_progress"]);
const terminalStatuses = new Set([
  "completed", "succeeded", "cancelled", "canceled", "failed", "interrupted", "errored", "stopped",
]);

function ownership(payload: string | null): { createdBy?: unknown; delegatedFrom?: { threadId?: unknown } } {
  try {
    return JSON.parse(payload ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function getPilotThreads(snapshot: T3StateSnapshot, options: HumanPreemptionOptions): Set<string> {
  const pilot = new Set(options.pilotThreadIds);
  const prefixes = options.pilotTitlePrefixes ?? ["[Sparkle]", "[t3-pilot]"];
  const children = new Map<string, string[]>();
  function addChild(parent: string, child: string) {
    const existing = children.get(parent);
    if (existing) existing.push(child);
    else children.set(parent, [child]);
  }

  for (const thread of snapshot.threads) {
    const payload = ownership(thread.payloadJson);
    if (payload.createdBy === "pilot" || prefixes.some((prefix) => prefix && thread.title.startsWith(prefix))) {
      pilot.add(thread.threadId);
    }
    const parent = payload.delegatedFrom?.threadId;
    if (typeof parent === "string") addChild(parent, thread.threadId);
  }
  for (const subagent of snapshot.subagents) {
    if (subagent.childThreadId) addChild(subagent.threadId, subagent.childThreadId);
  }
  // Set iteration visits newly added descendants and deduplicates cycles.
  for (const parent of pilot) {
    for (const child of children.get(parent) ?? []) pilot.add(child);
  }
  return pilot;
}

export function evaluateHumanPreemptionFromSnapshot(
  snapshot: T3StateSnapshot,
  options: HumanPreemptionOptions = {},
): HumanPreemptionReport {
  const nowMs = (options.now ?? new Date()).getTime();
  const cooldownMinutes = Math.max(0, finiteOr(options.cooldownMinutes, 15));
  const cooldownMs = cooldownMinutes * MINUTE_MS;
  const pilot = getPilotThreads(snapshot, options);
  const threadTitles = new Map(snapshot.threads.map((thread) => [thread.threadId, thread.title]));
  const activeHumanRuns: ActiveHumanRunSummary[] = [];
  let lastHumanMs = -Infinity;
  for (const run of snapshot.runs) {
    if (pilot.has(run.threadId)) continue;
    const status = run.status.trim().toLowerCase();
    if (activeStatuses.has(status) || (!run.completedAt && !terminalStatuses.has(status))) {
      activeHumanRuns.push({
        runId: run.runId,
        threadId: run.threadId,
        threadTitle: threadTitles.get(run.threadId) ?? run.threadId,
        status: run.status,
        provider: run.provider,
        requestedAt: run.requestedAt,
        completedAt: run.completedAt,
      });
    }
    lastHumanMs = Math.max(lastHumanMs, parseTimestamp(run.completedAt ?? run.requestedAt) ?? -Infinity);
  }
  for (const thread of snapshot.threads) {
    if (!pilot.has(thread.threadId)) {
      lastHumanMs = Math.max(lastHumanMs, parseTimestamp(thread.latestUserMessageAt) ?? -Infinity);
    }
  }

  const lastHumanActivityAt = Number.isFinite(lastHumanMs) ? new Date(lastHumanMs).toISOString() : null;
  const base = { cooldownMinutes, lastHumanActivityAt, activeHumanRuns };
  if (activeHumanRuns.length) {
    return {
      ...base, shouldPreempt: true, state: "PREEMPTED_ACTIVE_HUMAN_TURN",
      resumeAvailableAt: null, resumeInMs: cooldownMs, reason: "A human turn is active.",
    };
  }
  const resumeMs = lastHumanMs + cooldownMs;
  if (nowMs < resumeMs) {
    return {
      ...base, shouldPreempt: true, state: "COOLDOWN_AFTER_HUMAN_TURN",
      resumeAvailableAt: new Date(resumeMs).toISOString(),
      resumeInMs: resumeMs - nowMs,
      reason: "The human activity cooldown is still running.",
    };
  }
  return {
    ...base, shouldPreempt: false, state: "CLEAR_FOR_PILOT", resumeAvailableAt: null,
    resumeInMs: 0, reason: "No human turns are active or cooling down.",
  };
}

export function detectHumanActivity(dbPath: string, options?: HumanPreemptionOptions): HumanPreemptionReport {
  return evaluateHumanPreemptionFromSnapshot(inspectT3State(dbPath), options);
}
