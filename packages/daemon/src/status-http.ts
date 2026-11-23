import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PilotStatusSummary } from "./types.js";

export interface PilotStatusServerOptions {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  getStatus: () => Promise<PilotStatusSummary> | PilotStatusSummary;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

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

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/api/status") {
        const status = await options.getStatus();
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }
      if (url.pathname === "/") {
        const status = await options.getStatus();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderStatusPreviewHtml(status));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Internal status server error",
      }));
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
