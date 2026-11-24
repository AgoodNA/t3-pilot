import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyClientOverlayToAsar,
  applyClientOverlayToDirectory,
  computeAsarFileIntegrity,
  runNativeUiCommand,
} from "../src/ui-installer.js";

function createMinimalAsarWithClient(asarPath: string, files: Record<string, string>) {
  let offset = 0n;
  const chunks: Buffer[] = [];
  const clientFiles: Record<string, unknown> = {};
  for (const [name, contentStr] of Object.entries(files)) {
    const buf = Buffer.from(contentStr, "utf8");
    clientFiles[name] = {
      size: buf.length,
      offset: offset.toString(),
      integrity: computeAsarFileIntegrity(buf),
    };
    offset += BigInt(buf.length);
    chunks.push(buf);
  }
  const tree = {
    files: {
      apps: {
        files: {
          server: {
            files: {
              dist: {
                files: {
                  client: { files: clientFiles },
                },
              },
            },
          },
        },
      },
    },
  };
  const jsonBuf = Buffer.from(JSON.stringify(tree), "utf8");
  const aligned = Math.ceil(jsonBuf.length / 4) * 4;
  const pre = Buffer.alloc(16 + aligned, 0);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(8 + aligned, 4);
  pre.writeUInt32LE(4 + aligned, 8);
  pre.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(pre, 16);
  fs.writeFileSync(asarPath, Buffer.concat([pre, ...chunks]));
}

describe("ui-installer cross-platform overlay engine", () => {
  it("patches ASAR client tree with overlay files, removes old chunks, and computes valid SHA256 header hash", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-asar-test-"));
    try {
      const sourceAsar = path.join(tmp, "source.asar");
      const outputAsar = path.join(tmp, "output.asar");
      const overlayDir = path.join(tmp, "overlay");
      fs.mkdirSync(path.join(overlayDir, "files/assets"), { recursive: true });

      createMinimalAsarWithClient(sourceAsar, {
        "index.html": "<html>old</html>",
        "old-chunk.js": "old()",
        "keep.png": "PNGDATA",
      });

      fs.writeFileSync(
        path.join(overlayDir, "pilot-overlay-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          targetT3Version: "0.1.11",
          targetCommit: "59651c1761f6",
          overlayFileCount: 2,
          removedFiles: ["old-chunk.js"],
        }),
      );
      fs.writeFileSync(path.join(overlayDir, "files/index.html"), "<html>pilot</html>");
      fs.writeFileSync(path.join(overlayDir, "files/assets/pilot.js"), "pilotCockpit()");

      const res = applyClientOverlayToAsar({
        sourceAsarPath: sourceAsar,
        overlayDir,
        outputAsarPath: outputAsar,
      });
      expect(res.patchedFiles).toBe(2);

      const raw = fs.readFileSync(outputAsar);
      const jsonLen = raw.readUInt32LE(12);
      const headerJson = raw.subarray(16, 16 + jsonLen).toString("utf8");
      expect(crypto.createHash("sha256").update(headerJson).digest("hex")).toBe(res.headerSha256);

      const parsed = JSON.parse(headerJson);
      const client = parsed.files.apps.files.server.files.dist.files.client.files;
      expect(client["old-chunk.js"]).toBeUndefined();
      expect(client["keep.png"]).toBeDefined();
      expect(client["assets"].files["pilot.js"].size).toBe("pilotCockpit()".length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installs and restores runtime client directories idempotently", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-runtime-ui-test-"));
    try {
      const runtimeClient = path.join(tmp, "client");
      const backupRoot = path.join(tmp, "backups");
      const overlayDir = path.join(tmp, "overlay");
      fs.mkdirSync(runtimeClient, { recursive: true });
      fs.mkdirSync(path.join(overlayDir, "files"), { recursive: true });

      fs.writeFileSync(path.join(runtimeClient, "index.html"), "official");
      fs.writeFileSync(
        path.join(overlayDir, "pilot-overlay-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          targetT3Version: "0.1.11",
          targetCommit: "59651c1761f6",
          overlayFileCount: 1,
          removedFiles: [],
        }),
      );
      fs.writeFileSync(path.join(overlayDir, "files/index.html"), "pilot-custom-ui");

      const installed = runNativeUiCommand("install", {
        runtimeDir: runtimeClient,
        overlayDir,
        backupRoot,
      });
      expect(installed.targets[0]?.status).toBe("installed");
      expect(fs.readFileSync(path.join(runtimeClient, "index.html"), "utf8")).toBe(
        "pilot-custom-ui",
      );

      const restored = runNativeUiCommand("restore", {
        runtimeDir: runtimeClient,
        overlayDir,
        backupRoot,
      });
      expect(restored.targets[0]?.status).toBe("restored");
      expect(fs.readFileSync(path.join(runtimeClient, "index.html"), "utf8")).toBe("official");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
