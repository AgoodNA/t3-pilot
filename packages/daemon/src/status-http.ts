import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { PilotService } from "./service.js";
import type { PilotStatusSummary } from "./types.js";

export interface PilotStatusServerOptions {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  getStatus?: () => Promise<PilotStatusSummary> | PilotStatusSummary;
  service?: Pick<PilotService, "getStatus" | "routeTask" | "addSparkle" | "getShieldPolicy" | "configureShield" | "checkShield" | "syncHarnesses">;
  staticDir?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const MAX_JSON_BYTES = 64 * 1024;
const requiredText = z.string().trim().min(1);
const routeInput = z.object({ task: requiredText }).strict();
const sparkleInput = z.object({
  title: requiredText.regex(/^[^\r\n]+$/, "A Sparkle title must be a single line."),
  mode: z.enum(["worktree", "scratch"]).optional(),
  prompt: z.string().optional(),
}).strict();
const syncInput = z.object({
  dryRun: z.boolean().optional(),
  targets: z.array(z.enum(["antigravity", "codex", "claude-code"])).optional(),
  rollbackSnapshotId: z.union([requiredText, z.boolean()]).optional(),
}).strict();
const shieldInput = z.object({
  mode: z.enum(["guarded-turbo", "strict", "off"]).optional(),
  ruleId: requiredText.optional(),
  enabled: z.boolean().optional(),
  decision: z.enum(["allow", "deny", "force_ask"]).optional(),
  check: z.object({
    harness: z.enum(["antigravity", "codex", "claude-code", "generic"]).optional(),
    toolName: requiredText,
    command: z.string().optional(),
    filePath: z.string().optional(),
    args: z.record(z.unknown()).optional(),
    cwd: z.string().optional(),
  }).strict().optional(),
}).strict().superRefine(({ mode, ruleId, enabled, decision, check }, ctx) => {
  const changesRule = enabled !== undefined || decision !== undefined;
  if (check && (mode !== undefined || ruleId !== undefined || changesRule)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A shield check must be a separate dry-run request." });
  }
  if (changesRule !== (ruleId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide a ruleId and either enabled or decision to update a rule." });
  }
});

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function validated<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(" "));
  return result.data;
}

function respondJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  if (Number(req.headers["content-length"]) > MAX_JSON_BYTES) throw new HttpError(413, "JSON body exceeds 64 KB.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "JSON body exceeds 64 KB.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

const staticContentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
};

async function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let local: string;
  try {
    local = decodeURIComponent(pathname).slice(1);
  } catch {
    throw new HttpError(400, "Invalid static asset path.");
  }
  if (local.includes("\\") || local.includes("\0") || local.split("/").some((part) => part.startsWith("."))) return false;
  try {
    const file = await realpath(resolve(root, local || "index.html"));
    const path = relative(root, file);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !(await stat(file)).isFile()) return false;
    const bytes = await readFile(file);
    res.writeHead(200, {
      "content-type": staticContentTypes[extname(file)] ?? "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export interface RunningPilotStatusServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPercent(value: number | null): string {
  return value === null ? "External / N/A" : `${value.toFixed(1)}%`;
}

export function renderStatusPreviewHtml(status: PilotStatusSummary): string {
  const pacingByPool = new Map(status.pacing.map((entry) => [entry.poolId, entry]));
  const cards = status.pools.map((pool) => {
    const pacing = pacingByPool.get(pool.poolId);
    const weekly = pacing?.weeklyRemainingPercent ?? null;
    const session = pacing?.sessionRemainingPercent ?? null;
    const mode = pacing?.harvestMode ?? "EXTERNAL_UNMETERED";
    const badgeColor = pacing?.shieldLocked
      ? "#ef4444"
      : mode === "FULL_THROTTLE_HARVEST" || mode === "EXPIRING_5H_HARVEST"
        ? "#10b981"
        : "#3b82f6";
    return `<section class="card">
      <div class="card-head">
        <strong>${escapeHtml(pool.poolId)}</strong>
        <span class="badge" style="background:${badgeColor}">${escapeHtml(mode)}</span>
      </div>
      <div class="metrics">
        <div><span class="label">5h Remaining</span><span class="val">${escapeHtml(formatPercent(session))}</span></div>
        <div><span class="label">7d Remaining</span><span class="val">${escapeHtml(formatPercent(weekly))}</span></div>
        <div><span class="label">Burnable Surplus</span><span class="val">${escapeHtml(`${(pacing?.effectiveBurnablePercent ?? 0).toFixed(1)}%`)}</span></div>
      </div>
      <p class="reason">${escapeHtml(pacing?.harvestReason ?? pool.unavailableReason ?? "Ready")}</p>
    </section>`;
  }).join("\n");

  const humanState = status.humanPreemption?.state ?? "CLEAR_FOR_PILOT";
  const pendingSparkles = status.sparkles.filter((item) => item.status === "pending").length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>t3-pilot Cockpit Live Feed</title>
  <style>
    :root { color-scheme: dark light; font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 20px; background: #0b0f19; color: #e5e7eb; }
    header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; }
    h1 { font-size: 1.25rem; margin: 0; }
    .meta { font-size: 0.85rem; color: #9ca3af; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; }
    .card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
    .badge { color: #fff; font-size: 0.7rem; font-weight: 600; padding: 3px 8px; border-radius: 999px; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .label { display: block; font-size: 0.72rem; color: #9ca3af; }
    .val { font-size: 1rem; font-weight: 700; }
    .reason { margin: 10px 0 0; font-size: 0.8rem; color: #9ca3af; }
    .footer-bar { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 12px 14px; font-size: 0.85rem; display: flex; gap: 20px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <header>
    <h1>t3-pilot · Coupled 7d × 5h Governor</h1>
    <span class="meta">Updated ${escapeHtml(status.generatedAt)} · Reserve Floor ${escapeHtml(String(status.config.pacing.reserveFloorPercent ?? 20))}%</span>
  </header>
  <div class="grid">${cards}</div>
  <div class="footer-bar">
    <span><strong>Human Preemption:</strong> ${escapeHtml(humanState)}</span>
    <span><strong>Pending Sparkles:</strong> ${pendingSparkles} / ${status.sparkles.length}</span>
    <span><strong>Active Sparkle Lease:</strong> ${escapeHtml(status.runtimeState.activeRun?.itemTitle ?? "None")}</span>
  </div>
</body>
</html>`;
}

export async function startPilotStatusServer(
  options: PilotStatusServerOptions,
): Promise<RunningPilotStatusServer> {
  const host = options.host ?? "127.0.0.1";
  if (!options.allowRemote && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`Refusing to bind status server to non-loopback host "${host}" without --allow-remote.`);
  }
  const requestedPort = options.port ?? 4733;
  const { service } = options;
  const getStatus = options.getStatus ?? (() => service!.getStatus());
  if (!options.getStatus && !service) throw new Error("A Cockpit status provider is required.");
  const staticDir = options.staticDir ? await realpath(options.staticDir) : undefined;
  const pilotToken = randomBytes(32).toString("hex");
  const pilotTokenBytes = Buffer.from(pilotToken, "utf8");

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { pathname } = url;
      const isRead = req.method === "GET" || req.method === "HEAD";
      if (isRead && pathname === "/healthz") {
        respondJson(res, 200, { ok: true });
        return;
      }
      if (isRead && pathname === "/api/status") {
        const status = await getStatus();
        res.setHeader("x-pilot-token", pilotToken);
        respondJson(res, 200, { ...status, pilotToken });
        return;
      }
      if (service && ["/api/route", "/api/sparkle", "/api/shield", "/api/sync"].includes(pathname)) {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          throw new HttpError(405, "Method not allowed.");
        }
        if (options.allowRemote !== true && !LOOPBACK_HOSTS.has(req.socket.remoteAddress ?? "")) {
          throw new HttpError(403, "Cockpit actions require a loopback connection.");
        }
        const token = req.headers["x-pilot-token"];
        const tokenBytes = typeof token === "string" ? Buffer.from(token, "utf8") : null;
        if (tokenBytes?.length !== pilotTokenBytes.length || !timingSafeEqual(tokenBytes, pilotTokenBytes)) {
          throw new HttpError(403, "Missing or invalid X-Pilot-Token header.");
        }
        const body = await readJson(req);
        if (pathname === "/api/route") {
          const { task } = validated(routeInput, body);
          respondJson(res, 200, await service.routeTask(task, false));
        } else if (pathname === "/api/sparkle") {
          respondJson(res, 200, await service.addSparkle(validated(sparkleInput, body)));
        } else if (pathname === "/api/sync") {
          respondJson(res, 200, await service.syncHarnesses(validated(syncInput, body)));
        } else {
          const { check, ...patch } = validated(shieldInput, body);
          const policy = service.getShieldPolicy();
          if (patch.ruleId && !policy.rules.some((rule) => rule.id === patch.ruleId)) {
            throw new HttpError(400, `Unknown Guarded Turbo rule "${patch.ruleId}".`);
          }
          const shield = patch.mode !== undefined || patch.ruleId !== undefined ? service.configureShield(patch) : policy;
          respondJson(res, 200, { shield, ...(check && { evaluation: service.checkShield(check) }) });
        }
        return;
      }
      if (isRead && staticDir && !pathname.startsWith("/api/") && await serveStatic(staticDir, pathname, req, res)) return;
      if (isRead && pathname === "/" && !staticDir) {
        const status = await getStatus();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderStatusPreviewHtml(status));
        return;
      }
      respondJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (!req.complete) req.resume();
      respondJson(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : "Internal status server error",
      });
    }
  };

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const boundHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    host,
    port: address.port,
    url: `http://${boundHost}:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    }),
  };
}
