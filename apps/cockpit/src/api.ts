import type {
  AddSparkleInput, PilotStatusSummary, PilotSyncActionInput, PilotSyncActionOutput, RouteDecision,
  ShieldCheckInput, ShieldEvaluationResult, ShieldPatch, ShieldPolicyConfig, SparkleItem,
} from "./types";

export type CockpitMode = "live" | "demo";

/** One surface for both the live `npx t3-pilot up` daemon and the stateful Interactive Demo. */
export interface CockpitClient {
  readonly mode: CockpitMode;
  getStatus(): Promise<PilotStatusSummary>;
  route(task: string): Promise<RouteDecision>;
  addSparkle(input: AddSparkleInput): Promise<{ added: SparkleItem; queue: SparkleItem[] }>;
  configureShield(patch: ShieldPatch): Promise<{ shield: ShieldPolicyConfig }>;
  checkShield(check: ShieldCheckInput): Promise<{ shield: ShieldPolicyConfig; evaluation: ShieldEvaluationResult }>;
  sync(input: PilotSyncActionInput): Promise<PilotSyncActionOutput>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class LiveClient implements CockpitClient {
  readonly mode = "live" as const;
  private sessionToken: string | null = null;

  constructor(
    private readonly baseUrl = "",
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 5000,
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined
          ? { accept: "application/json" }
          : {
            accept: "application/json", "content-type": "application/json",
            ...(this.sessionToken && { "x-pilot-token": this.sessionToken }),
          },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(controller && { signal: controller.signal }),
        cache: "no-store",
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new HttpError(response.status, `${path} did not return JSON (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : "";
        throw new HttpError(response.status, message || `${path} failed with HTTP ${response.status}.`);
      }
      return { data: payload as T, headers: response.headers };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`${path} timed out after ${this.timeoutMs} ms.`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getStatus(): Promise<PilotStatusSummary> {
    const { data: status, headers } = await this.request<PilotStatusSummary>("/api/status");
    if (!status || !Array.isArray(status.pools) || !Array.isArray(status.pacing) || !status.shield) {
      throw new Error("/api/status returned an unexpected payload.");
    }
    this.sessionToken = headers.get("x-pilot-token") ?? status.pilotToken ?? this.sessionToken;
    return status;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    if (!this.sessionToken) await this.getStatus();
    try {
      return (await this.request<T>(path, body)).data;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      await this.getStatus();
      return (await this.request<T>(path, body)).data;
    }
  }

  route(task: string) {
    return this.postJson<RouteDecision>("/api/route", { task });
  }

  addSparkle(input: AddSparkleInput) {
    return this.postJson<{ added: SparkleItem; queue: SparkleItem[] }>("/api/sparkle", input);
  }

  configureShield(patch: ShieldPatch) {
    return this.postJson<{ shield: ShieldPolicyConfig }>("/api/shield", patch);
  }

  async checkShield(check: ShieldCheckInput) {
    const result = await this.postJson<{ shield: ShieldPolicyConfig; evaluation?: ShieldEvaluationResult }>("/api/shield", { check });
    if (!result.evaluation) throw new Error("/api/shield did not return an evaluation.");
    return { shield: result.shield, evaluation: result.evaluation };
  }

  sync(input: PilotSyncActionInput) {
    return this.postJson<PilotSyncActionOutput>("/api/sync", input);
  }
}

export function wantsDemoFromUrl(search: string): boolean {
  const params = new URLSearchParams(search);
  const value = params.get("demo");
  return value !== null && value !== "0" && value !== "false";
}

/** View-level actions; App wires them to the active client and folds results back into status. */
export interface CockpitActions {
  route(task: string): Promise<RouteDecision>;
  addSparkle(input: AddSparkleInput): Promise<SparkleItem>;
  configureShield(patch: ShieldPatch): Promise<void>;
  checkShield(check: ShieldCheckInput): Promise<ShieldEvaluationResult>;
  sync(input: PilotSyncActionInput): Promise<PilotSyncActionOutput>;
}
