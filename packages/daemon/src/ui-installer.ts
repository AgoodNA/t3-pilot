import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK_SIZE = 4 * 1024 * 1024;
const OFFICIAL_0_1_11_ASAR_SHA256 =
  "4b2808d2229814596264726f45445d5400182759c83c41878514ad4a1c5c234a";

export interface OverlayManifest {
  readonly schemaVersion: number;
  readonly targetT3Version: string;
  readonly targetCommit: string;
  readonly overlayFileCount: number;
  readonly removedFiles: readonly string[];
}

export interface DiscoveredT3Target {
  readonly kind: "macos-app" | "asar-bundle" | "runtime-client-dir";
  readonly targetPath: string;
  readonly asarPath?: string;
  readonly infoPlistPath?: string;
}

export interface UiInstallerOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly appPath?: string;
  readonly runtimeDir?: string;
  readonly overlayDir?: string;
  readonly backupRoot?: string;
  readonly restart?: boolean;
}

export interface UiInstallResult {
  readonly action: "install" | "restore" | "status";
  readonly targets: ReadonlyArray<{
    readonly kind: DiscoveredT3Target["kind"];
    readonly path: string;
    readonly status: string;
    readonly backupPath?: string;
    readonly stagedAppPath?: string;
    readonly asarHeaderSha256?: string;
  }>;
}

export function computeAsarFileIntegrity(buf: Buffer) {
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const blocks: string[] = [];
  if (buf.length === 0) {
    blocks.push(crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  } else {
    for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
      blocks.push(
        crypto
          .createHash("sha256")
          .update(buf.subarray(i, Math.min(i + BLOCK_SIZE, buf.length)))
          .digest("hex"),
      );
    }
  }
  return {
    algorithm: "SHA256" as const,
    hash,
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  integrity?: ReturnType<typeof computeAsarFileIntegrity>;
}

export function applyClientOverlayToAsar(input: {
  readonly sourceAsarPath: string;
  readonly overlayDir: string;
  readonly outputAsarPath: string;
}): { readonly headerSha256: string; readonly patchedFiles: number } {
  const manifestPath = path.join(input.overlayDir, "pilot-overlay-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as OverlayManifest;
  const overlayFilesRoot = path.join(input.overlayDir, "files");

  const stat = fs.statSync(input.sourceAsarPath);
  const fd = fs.openSync(input.sourceAsarPath, "r");
  const pre = Buffer.alloc(16);
  fs.readSync(fd, pre, 0, 16, 0);

  if (pre.readUInt32LE(0) !== 4) {
    fs.closeSync(fd);
    throw new Error(`Invalid ASAR header in ${input.sourceAsarPath}`);
  }
  const origHeaderSize = pre.readUInt32LE(4);
  const origJsonLen = pre.readUInt32LE(12);
  const origJsonBuf = Buffer.alloc(origJsonLen);
  fs.readSync(fd, origJsonBuf, 0, origJsonLen, 16);

  const origPayloadStart = 8 + origHeaderSize;
  const origPayloadSize = stat.size - origPayloadStart;

  const tree = JSON.parse(origJsonBuf.toString("utf8")) as AsarNode;
  const clientRoot =
    tree.files?.apps?.files?.server?.files?.dist?.files?.client;
  if (!clientRoot?.files) {
    fs.closeSync(fd);
    throw new Error(`apps/server/dist/client not found inside ${input.sourceAsarPath}`);
  }

  // Remove obsolete chunk entries listed in manifest
  for (const rel of manifest.removedFiles) {
    const parts = rel.split("/").filter(Boolean);
    let cursor: AsarNode | undefined = clientRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor?.files?.[parts[i]!];
    }
    const leaf = parts[parts.length - 1];
    if (cursor?.files && leaf) {
      delete cursor.files[leaf];
    }
  }

  // Append overlay files at the end of payload so all untouched offsets remain valid
  let appendOffset = BigInt(origPayloadSize);
  const appendedChunks: Buffer[] = [];
  let patchedFiles = 0;

  function walkOverlay(currentDir: string, relPrefix = "") {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name.endsWith(".map")) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walkOverlay(full, rel);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full);
        const parts = rel.split("/").filter(Boolean);
        let cursor = clientRoot!;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i]!;
          cursor.files ??= {};
          cursor.files[seg] ??= { files: {} };
          cursor = cursor.files[seg]!;
        }
        const leaf = parts[parts.length - 1]!;
        cursor.files ??= {};
        cursor.files[leaf] = {
          size: content.length,
          offset: appendOffset.toString(),
          integrity: computeAsarFileIntegrity(content),
        };
        appendOffset += BigInt(content.length);
        appendedChunks.push(content);
        patchedFiles++;
      }
    }
  }
  walkOverlay(overlayFilesRoot);

  const newJsonStr = JSON.stringify(tree);
  const headerSha256 = crypto.createHash("sha256").update(newJsonStr).digest("hex");
  const newJsonBuf = Buffer.from(newJsonStr, "utf8");
  const alignedJsonLen = Math.ceil(newJsonBuf.length / 4) * 4;
  const newHeaderBodySize = 4 + alignedJsonLen;
  const newHeaderSize = 4 + newHeaderBodySize;

  const newPre = Buffer.alloc(16 + alignedJsonLen, 0);
  newPre.writeUInt32LE(4, 0);
  newPre.writeUInt32LE(newHeaderSize, 4);
  newPre.writeUInt32LE(newHeaderBodySize, 8);
  newPre.writeUInt32LE(newJsonBuf.length, 12);
  newJsonBuf.copy(newPre, 16);

  const outFd = fs.openSync(input.outputAsarPath, "w");
  fs.writeSync(outFd, newPre, 0, newPre.length);

  const copyBuf = Buffer.alloc(8 * 1024 * 1024);
  let remaining = origPayloadSize;
  let readPos = origPayloadStart;
  while (remaining > 0) {
    const toRead = Math.min(copyBuf.length, remaining);
    const bytesRead = fs.readSync(fd, copyBuf, 0, toRead, readPos);
    if (bytesRead <= 0) break;
    fs.writeSync(outFd, copyBuf, 0, bytesRead);
    readPos += bytesRead;
    remaining -= bytesRead;
  }

  for (const chunk of appendedChunks) {
    fs.writeSync(outFd, chunk, 0, chunk.length);
  }

  fs.closeSync(fd);
  fs.closeSync(outFd);
  return { headerSha256, patchedFiles };
}

export function applyClientOverlayToDirectory(input: {
  readonly sourceDir: string;
  readonly overlayDir: string;
  readonly targetDir: string;
}): number {
  const manifestPath = path.join(input.overlayDir, "pilot-overlay-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as OverlayManifest;
  const overlayFilesRoot = path.join(input.overlayDir, "files");

  const tempDir = `${input.targetDir}.pilot-tmp-${process.pid}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.cpSync(input.sourceDir, tempDir, { recursive: true });

  for (const rel of manifest.removedFiles) {
    fs.rmSync(path.join(tempDir, rel), { force: true });
  }
  if (fs.existsSync(overlayFilesRoot)) {
    fs.cpSync(overlayFilesRoot, tempDir, { recursive: true, force: true });
  }
  fs.rmSync(input.targetDir, { recursive: true, force: true });
  fs.renameSync(tempDir, input.targetDir);
  return manifest.overlayFileCount;
}

export function discoverT3InstallTargets(options: UiInstallerOptions = {}): DiscoveredT3Target[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const targets: DiscoveredT3Target[] = [];

  if (options.appPath) {
    const resolved = path.resolve(options.appPath);
    if (resolved.endsWith(".app") && fs.existsSync(path.join(resolved, "Contents/Resources/app.asar"))) {
      targets.push({
        kind: "macos-app",
        targetPath: resolved,
        asarPath: path.join(resolved, "Contents/Resources/app.asar"),
        infoPlistPath: path.join(resolved, "Contents/Info.plist"),
      });
    } else if (resolved.endsWith(".asar") && fs.existsSync(resolved)) {
      targets.push({ kind: "asar-bundle", targetPath: resolved, asarPath: resolved });
    }
  }

  if (options.runtimeDir) {
    const resolved = path.resolve(options.runtimeDir);
    if (fs.existsSync(path.join(resolved, "index.html"))) {
      targets.push({ kind: "runtime-client-dir", targetPath: resolved });
    }
  }

  if (targets.length > 0) return targets;

  if (platform === "darwin") {
    const macCandidates = [
      "/Applications/T3 Code (Beta).app",
      "/Applications/T3 Code.app",
      path.join(homeDir, "Applications/T3 Code (Beta).app"),
      path.join(homeDir, "Applications/T3 Code.app"),
    ];
    for (const candidate of macCandidates) {
      const asarPath = path.join(candidate, "Contents/Resources/app.asar");
      if (fs.existsSync(asarPath)) {
        targets.push({
          kind: "macos-app",
          targetPath: candidate,
          asarPath,
          infoPlistPath: path.join(candidate, "Contents/Info.plist"),
        });
      }
    }
  } else if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData/Local");
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    for (const root of [path.join(localAppData, "Programs"), programFiles]) {
      for (const appDirName of ["T3 Code (Beta)", "T3 Code"]) {
        for (const asarName of ["server.asar", "app.asar"]) {
          const asarPath = path.join(root, appDirName, "resources", asarName);
          if (fs.existsSync(asarPath)) {
            targets.push({ kind: "asar-bundle", targetPath: asarPath, asarPath });
            break;
          }
        }
      }
    }
  } else {
    const linuxAsarCandidates = [
      "/opt/T3 Code (Beta)/resources/app.asar",
      "/opt/T3 Code/resources/app.asar",
      "/usr/lib/t3code/resources/app.asar",
    ];
    for (const asarPath of linuxAsarCandidates) {
      if (fs.existsSync(asarPath)) {
        targets.push({ kind: "asar-bundle", targetPath: asarPath, asarPath });
      }
    }
  }

  // Also check headless / CLI runtime client directories (~/.t3/runtime/versions/*/client)
  const runtimeVersionsDir = path.join(homeDir, ".t3/runtime/versions");
  if (fs.existsSync(runtimeVersionsDir)) {
    for (const ver of fs.readdirSync(runtimeVersionsDir)) {
      const clientDir = path.join(runtimeVersionsDir, ver, "client");
      if (fs.existsSync(path.join(clientDir, "index.html"))) {
        targets.push({ kind: "runtime-client-dir", targetPath: clientDir });
      }
    }
  }

  return targets;
}

export function resolveBundledOverlayDir(explicitDir?: string): string {
  if (explicitDir && fs.existsSync(path.join(explicitDir, "pilot-overlay-manifest.json"))) {
    return path.resolve(explicitDir);
  }
  const candidates = [
    fileURLToPath(new URL("../native-ui-overlay", import.meta.url)),
    fileURLToPath(new URL("../../native-ui-overlay", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "pilot-overlay-manifest.json"))) {
      return candidate;
    }
  }
  throw new Error(
    "Native UI overlay bundle not found. Pass --overlay-dir <path> or reinstall t3-pilot >= 0.2.0.",
  );
}

function updateDarwinInfoPlistAndCodesign(appBundlePath: string, newHeaderSha256: string) {
  const infoPlistPath = path.join(appBundlePath, "Contents/Info.plist");
  let xml = fs.readFileSync(infoPlistPath, "utf8");
  const integrityRegex =
    /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>\s*<string>)[0-9a-fA-F]+(<\/string>)/;
  if (integrityRegex.test(xml)) {
    xml = xml.replace(integrityRegex, `$1${newHeaderSha256}$2`);
  }
  xml = xml.replace(/\s*<key>ElectronTeamID<\/key>\s*<string>[^<]*<\/string>/g, "");
  fs.writeFileSync(infoPlistPath, xml, "utf8");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pilot-sign-"));
  const entitlementsPath = path.join(tmpDir, "entitlements.plist");
  fs.writeFileSync(
    entitlementsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
</dict>
</plist>
`,
    "utf8",
  );

  try {
    const frameworksDir = path.join(appBundlePath, "Contents/Frameworks");
    if (fs.existsSync(frameworksDir)) {
      for (const item of fs.readdirSync(frameworksDir)) {
        const full = path.join(frameworksDir, item);
        if (item.endsWith(".framework")) {
          execFileSync("codesign", ["--force", "--deep", "--sign", "-", full], { stdio: "pipe" });
        }
      }
      for (const item of fs.readdirSync(frameworksDir)) {
        const full = path.join(frameworksDir, item);
        if (item.endsWith(".app")) {
          const helperPlist = path.join(full, "Contents/Info.plist");
          if (fs.existsSync(helperPlist)) {
            const hXml = fs
              .readFileSync(helperPlist, "utf8")
              .replace(/\s*<key>ElectronTeamID<\/key>\s*<string>[^<]*<\/string>/g, "");
            fs.writeFileSync(helperPlist, hXml, "utf8");
          }
          execFileSync(
            "codesign",
            ["--force", "--entitlements", entitlementsPath, "--sign", "-", full],
            { stdio: "pipe" },
          );
        }
      }
    }
    execFileSync(
      "codesign",
      ["--force", "--entitlements", entitlementsPath, "--sign", "-", appBundlePath],
      { stdio: "pipe" },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function runNativeUiCommand(
  action: "install" | "restore" | "status",
  options: UiInstallerOptions = {},
): UiInstallResult {
  const homeDir = options.homeDir ?? os.homedir();
  const backupRoot = options.backupRoot ?? path.join(homeDir, ".t3-pilot/ui-backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const targets = discoverT3InstallTargets(options);

  if (targets.length === 0) {
    return { action, targets: [] };
  }

  const results: Array<UiInstallResult["targets"][number]> = [];

  for (const target of targets) {
    const safeSlug = crypto.createHash("sha256").update(target.targetPath).digest("hex").slice(0, 12);

    if (target.kind === "macos-app") {
      const backupApp = path.join(backupRoot, `${path.basename(target.targetPath, ".app")}.${safeSlug}.orig.app`);
      // Also recognize legacy local backup path if present
      const legacyBackup = path.join(homeDir, ".local/t3-pilot/backups/T3 Code (Beta).orig-0.1.11.app");
      const effectiveBackup = fs.existsSync(backupApp)
        ? backupApp
        : fs.existsSync(legacyBackup)
          ? legacyBackup
          : backupApp;

      if (action === "status") {
        const xml = fs.existsSync(target.infoPlistPath!)
          ? fs.readFileSync(target.infoPlistPath!, "utf8")
          : "";
        const match = xml.match(
          /<key>Resources\/app\.asar<\/key>[\s\S]{0,240}?<string>([0-9a-fA-F]{64})<\/string>/,
        );
        const hash = match?.[1]?.toLowerCase() ?? "";
        const isOfficial = hash === OFFICIAL_0_1_11_ASAR_SHA256;
        results.push({
          kind: target.kind,
          path: target.targetPath,
          status: isOfficial ? "official" : "pilot-installed",
          backupPath: fs.existsSync(effectiveBackup) ? effectiveBackup : undefined,
          asarHeaderSha256: hash || undefined,
        });
        continue;
      }

      if (action === "restore") {
        if (!fs.existsSync(effectiveBackup)) {
          results.push({ kind: target.kind, path: target.targetPath, status: "no-backup-found" });
          continue;
        }
        if (options.restart) {
          const appName = path.basename(target.targetPath, ".app");
          try {
            execFileSync("osascript", ["-e", `tell application "${appName}" to quit`], { stdio: "pipe" });
          } catch {
            // Ignore if not running
          }
        }
        fs.rmSync(target.targetPath, { recursive: true, force: true });
        execFileSync("cp", ["-cR", effectiveBackup, target.targetPath]);
        if (options.restart) {
          execFileSync("open", ["-a", target.targetPath]);
        }
        results.push({
          kind: target.kind,
          path: target.targetPath,
          status: "restored",
          backupPath: effectiveBackup,
        });
        continue;
      }

      // action === "install"
      const overlayDir = resolveBundledOverlayDir(options.overlayDir);
      if (!fs.existsSync(effectiveBackup)) {
        execFileSync("cp", ["-cR", target.targetPath, backupApp]);
      }
      const cleanSourceApp = fs.existsSync(effectiveBackup) ? effectiveBackup : target.targetPath;
      const stagedApp = path.join(path.dirname(target.targetPath), "T3 Code Pilot.app");
      fs.rmSync(stagedApp, { recursive: true, force: true });
      execFileSync("cp", ["-cR", cleanSourceApp, stagedApp]);
      execFileSync("xattr", ["-cr", stagedApp]);

      const stagedAsar = path.join(stagedApp, "Contents/Resources/app.asar");
      const tmpAsar = `${stagedAsar}.tmp`;
      const { headerSha256 } = applyClientOverlayToAsar({
        sourceAsarPath: path.join(cleanSourceApp, "Contents/Resources/app.asar"),
        overlayDir,
        outputAsarPath: tmpAsar,
      });
      fs.renameSync(tmpAsar, stagedAsar);
      updateDarwinInfoPlistAndCodesign(stagedApp, headerSha256);

      let isRunning = false;
      try {
        execFileSync("pgrep", ["-f", `${target.targetPath}/Contents/MacOS/`], { stdio: "pipe" });
        isRunning = true;
      } catch {
        isRunning = false;
      }

      if (isRunning && !options.restart) {
        results.push({
          kind: target.kind,
          path: target.targetPath,
          status: "staged-while-running (pass --restart to hot-swap active app)",
          backupPath: fs.existsSync(effectiveBackup) ? effectiveBackup : backupApp,
          stagedAppPath: stagedApp,
          asarHeaderSha256: headerSha256,
        });
        continue;
      }

      if (isRunning && options.restart) {
        const appName = path.basename(target.targetPath, ".app");
        try {
          execFileSync("osascript", ["-e", `tell application "${appName}" to quit`], { stdio: "pipe" });
        } catch {
          // Ignore
        }
      }

      fs.rmSync(target.targetPath, { recursive: true, force: true });
      execFileSync("cp", ["-cR", stagedApp, target.targetPath]);
      execFileSync("xattr", ["-cr", target.targetPath]);
      if (options.restart) {
        execFileSync("open", ["-a", target.targetPath]);
      }
      results.push({
        kind: target.kind,
        path: target.targetPath,
        status: "installed",
        backupPath: fs.existsSync(effectiveBackup) ? effectiveBackup : backupApp,
        stagedAppPath: stagedApp,
        asarHeaderSha256: headerSha256,
      });
      continue;
    }

    if (target.kind === "asar-bundle" && target.asarPath) {
      const backupAsar = path.join(backupRoot, `${path.basename(target.asarPath)}.${safeSlug}.orig`);
      if (action === "status") {
        results.push({
          kind: target.kind,
          path: target.asarPath,
          status: fs.existsSync(backupAsar) ? "pilot-installed" : "official",
          backupPath: fs.existsSync(backupAsar) ? backupAsar : undefined,
        });
        continue;
      }
      if (action === "restore") {
        if (!fs.existsSync(backupAsar)) {
          results.push({ kind: target.kind, path: target.asarPath, status: "no-backup-found" });
          continue;
        }
        fs.copyFileSync(backupAsar, target.asarPath);
        results.push({ kind: target.kind, path: target.asarPath, status: "restored", backupPath: backupAsar });
        continue;
      }
      const overlayDir = resolveBundledOverlayDir(options.overlayDir);
      if (!fs.existsSync(backupAsar)) {
        fs.copyFileSync(target.asarPath, backupAsar);
      }
      const tmpAsar = `${target.asarPath}.pilot-tmp`;
      const { headerSha256 } = applyClientOverlayToAsar({
        sourceAsarPath: backupAsar,
        overlayDir,
        outputAsarPath: tmpAsar,
      });
      fs.renameSync(tmpAsar, target.asarPath);
      results.push({
        kind: target.kind,
        path: target.asarPath,
        status: "installed",
        backupPath: backupAsar,
        asarHeaderSha256: headerSha256,
      });
      continue;
    }

    if (target.kind === "runtime-client-dir") {
      const siblingOrig = `${target.targetPath}.orig-0.1.11`;
      const backupDir = fs.existsSync(siblingOrig)
        ? siblingOrig
        : path.join(backupRoot, `runtime-client.${safeSlug}.orig`);

      if (action === "status") {
        results.push({
          kind: target.kind,
          path: target.targetPath,
          status: fs.existsSync(backupDir) ? "pilot-installed" : "official",
          backupPath: fs.existsSync(backupDir) ? backupDir : undefined,
        });
        continue;
      }
      if (action === "restore") {
        if (!fs.existsSync(backupDir)) {
          results.push({ kind: target.kind, path: target.targetPath, status: "no-backup-found" });
          continue;
        }
        fs.rmSync(target.targetPath, { recursive: true, force: true });
        fs.cpSync(backupDir, target.targetPath, { recursive: true });
        results.push({ kind: target.kind, path: target.targetPath, status: "restored", backupPath: backupDir });
        continue;
      }
      const overlayDir = resolveBundledOverlayDir(options.overlayDir);
      if (!fs.existsSync(backupDir)) {
        fs.cpSync(target.targetPath, backupDir, { recursive: true });
      }
      applyClientOverlayToDirectory({
        sourceDir: backupDir,
        overlayDir,
        targetDir: target.targetPath,
      });
      results.push({
        kind: target.kind,
        path: target.targetPath,
        status: "installed",
        backupPath: backupDir,
      });
    }
  }

  return { action, targets: results };
}
