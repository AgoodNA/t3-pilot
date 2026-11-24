import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const daemonDir = fileURLToPath(new URL("../", import.meta.url));
const dist = join(daemonDir, "dist");

// esbuild preserves the CLI entry point's existing shebang.
await build({
  absWorkingDir: daemonDir,
  entryPoints: ["src/index.ts", "src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod", "node:*"],
});
chmodSync(join(dist, "cli.js"), 0o755);

const coreDist = join(daemonDir, "../core/dist");
const coreDeclarations = join(dist, "_core");
const readDeclaration = (path) => readFileSync(path, "utf8").replace(/^\/\/# sourceMappingURL=.*(?:\r?\n)?$/gm, "");
rmSync(coreDeclarations, { recursive: true, force: true });
mkdirSync(coreDeclarations, { recursive: true });
for (const name of readdirSync(coreDist)) {
  if (name.endsWith(".d.ts")) {
    writeFileSync(join(coreDeclarations, name), readDeclaration(join(coreDist, name)));
  }
}
for (const name of readdirSync(dist)) {
  const path = join(dist, name);
  if (name.endsWith(".d.ts")) {
    writeFileSync(path, readDeclaration(path).replaceAll('"@t3-pilot/core"', '"./_core/index.js"'));
  } else if (name.endsWith(".map") || (name.endsWith(".js") && name !== "index.js" && name !== "cli.js")) {
    rmSync(path);
  }
}

const cockpitSource = join(daemonDir, "../../apps/cockpit/dist");
const cockpitDist = join(daemonDir, "cockpit-dist");
rmSync(cockpitDist, { recursive: true, force: true });
if (existsSync(join(cockpitSource, "index.html"))) {
  cpSync(cockpitSource, cockpitDist, { recursive: true });
}

cpSync(join(daemonDir, "../../LICENSE"), join(daemonDir, "LICENSE"));
const readme = join(daemonDir, "../../README.md");
const packageReadme = join(daemonDir, "README.md");
if (existsSync(readme)) cpSync(readme, packageReadme);
else writeFileSync(packageReadme, "# t3-pilot\n\nRun `npx t3-pilot --help` to see available commands.\n");
