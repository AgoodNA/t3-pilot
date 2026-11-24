import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const daemonDir = fileURLToPath(new URL("../", import.meta.url));
const repoModules = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

it("packs a standalone CLI and serves its Cockpit outside the monorepo", { timeout: 60_000 }, async () => {
  const packDir = mkdtempSync(join(tmpdir(), "t3-pilot-pack-"));
  const externalDir = mkdtempSync(join(tmpdir(), "t3-pilot-external-npx-"));
  try {
    execFileSync("npm", ["pack", "--silent", "--offline", "--pack-destination", packDir], {
      cwd: daemonDir, stdio: "pipe", timeout: 20_000,
    });
    const tarball = join(packDir, "t3-pilot-0.2.0.tgz");
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
    expect(entries).toEqual(expect.arrayContaining([
      "package/dist/cli.js",
      "package/native-ui-overlay/pilot-overlay-manifest.json",
      "package/dist/index.js",
      "package/dist/_core/index.d.ts",
      "package/cockpit-dist/index.html",
      "package/README.md",
      "package/LICENSE",
    ]));
    expect(entries.filter((path) => /^package\/(src|test)\//.test(path))).toEqual([]);

    const modules = join(externalDir, "node_modules");
    const installDir = join(modules, "t3-pilot");
    mkdirSync(installDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", installDir]);
    const manifest = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).not.toContain("@t3-pilot/core");
    mkdirSync(join(modules, "@modelcontextprotocol"));
    for (const dependency of ["@modelcontextprotocol/sdk", "zod"]) {
      symlinkSync(join(repoModules, dependency), join(modules, dependency), "junction");
    }
    const cli = join(installDir, "dist", "cli.js");
    const child = spawn(cli, ["up", "--port", "0", "--dry-run"], {
      cwd: externalDir,
      env: { ...process.env, T3CODE_HOME: join(externalDir, "t3-home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    try {
      const [line] = await Promise.race([
        once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
        closed.then(([code, signal]) => { throw new Error(`Packed CLI exited during startup (${code ?? signal})\n${stderr}`); }),
      ]);
      const origin = /^Pilot cockpit running at (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];
      expect(origin, stderr).toBeDefined();
      const get = (path: string) => fetch(new URL(path, origin), { signal: AbortSignal.timeout(5_000) });
      const page = await get("/");
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<div id="root"></div>');
      const assets = [...html.matchAll(/(?:src|href)="(?:\.\/|\/)(assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]!);
      expect(assets).toEqual(expect.arrayContaining([expect.stringMatching(/\.js$/), expect.stringMatching(/\.css$/)]));
      await Promise.all(assets.map(async (path) => {
        const asset = await get(path);
        expect(asset.status, path).toBe(200);
        expect((await asset.arrayBuffer()).byteLength, path).toBeGreaterThan(0);
      }));

      const status = await get("/api/status");
      expect(status.status).toBe(200);
      const token = status.headers.get("x-pilot-token")!;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(await status.json()).toMatchObject({ pilotToken: token });
      const route = await fetch(new URL("/api/route", origin), {
        method: "POST",
        headers: { "content-type": "application/json", "x-pilot-token": token, origin: "https://connect.t3.gg" },
        body: JSON.stringify({ task: "Debug parser tests" }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(route.status).toBe(200);
      expect(await route.json()).toMatchObject({ task: "Debug parser tests", manualOverride: false });
    } finally {
      lines.close();
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      try {
        await closed;
      } finally {
        clearTimeout(forceStop);
      }
    }
    expect(await closed, stderr).toEqual([0, null]);
  } finally {
    rmSync(externalDir, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
