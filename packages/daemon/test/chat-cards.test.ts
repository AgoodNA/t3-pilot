import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPilotInlineCardHtml } from "../src/chat-cards.js";
import { PilotService } from "../src/service.js";
import { createDefaultPilotConfig, initPilotWorkspace } from "../src/t3-installer.js";
import { createQuotaHome, tempWorkspace } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = tempWorkspace();
  initPilotWorkspace({ workspaceRoot: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("T3 html_render inline chat cards", () => {
  it("renders a theme-variable-compliant inline quota & Guarded Turbo card with zero vh or outer background", async () => {
    const service = new PilotService({
      workspaceRoot: root,
      config: createDefaultPilotConfig({ t3Home: createQuotaHome(root) }),
    });
    const status = await service.getStatus();
    const html = renderPilotInlineCardHtml(status);

    expect(html).toContain("var(--card)");
    expect(html).toContain("var(--border)");
    expect(html).toContain("var(--destructive)");
    expect(html).toContain("Coupled 7d × 5h Live Pace Curve");
    expect(html).toContain("GUARDED-TURBO");
    expect(html).toContain("FULL_THROTTLE_HARVEST");
    expect(html).not.toMatch(/\b100vh\b|\bheight:\s*100%/i);
  });
});
