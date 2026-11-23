import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendSparkleToMarkdown, GhCliSparkleIssueSource, loadRuntimeState, parseSparklesMarkdown,
  readSparklesQueue, saveRuntimeState, updateSparkleStatusInMarkdown,
} from "../src/sparkle-queue.js";
import { tempWorkspace } from "./fixtures.js";

let root: string;
let path: string;

beforeEach(() => {
  root = tempWorkspace();
  path = join(root, "SPARKLES.md");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Markdown Sparkle queue", () => {
  it("parses every marker, defaults the mode, and ignores fenced examples", () => {
    const markdown = [
      "# Ideas", "Intro prose", "- [ ] [worktree] Build X", "  * [ ] [scratch] Prototype Y",
      "- [ ] Default worktree", "- [~] [scratch] In flight", "- [X] Finished", "- [!] Halted",
      '  + [!] [worktree] Broken <!-- t3-pilot:{"id":"fixed-id","status":"failed","threadId":"t1","branchName":"sparkle/topic"} -->',
      "```md", "- [ ] Fenced example", "```",
    ].join("\n");
    const queue = parseSparklesMarkdown(markdown);
    expect(queue.map(({ title, status, mode }) => [title, status, mode])).toEqual([
      ["Build X", "pending", "worktree"], ["Prototype Y", "pending", "scratch"], ["Default worktree", "pending", "worktree"],
      ["In flight", "running", "scratch"], ["Finished", "completed", "worktree"], ["Halted", "halted", "worktree"],
      ["Broken", "failed", "worktree"],
    ]);
    expect(queue.at(-1)).toMatchObject({ id: "fixed-id", prompt: "Broken", threadId: "t1", branchName: "sparkle/topic", lineIndex: 8 });
    expect(parseSparklesMarkdown(`# Another heading\n${markdown}`).map(({ id }) => id)).toEqual(queue.map(({ id }) => id));
  });

  it("appends Markdown without rewriting prose and round-trips multiline prompt and status metadata", () => {
    const initial = "# Ideas\r\n\r\nLead **prose**.\r\n  * [ ] Earlier idea  \r\n\r\n## Notes\r\nTrailing prose";
    writeFileSync(path, initial);
    const prompt = "Line 1\nLine 2 -->\n<!-- ordinary comment -->\nUnicode ✨";
    const { added, queue } = appendSparkleToMarkdown(path, { title: "New idea", mode: "scratch", prompt });
    expect(queue).toHaveLength(2);
    expect(readSparklesQueue(path).at(-1)).toEqual(added);
    expect(added).toMatchObject({ status: "pending", prompt, source: "sparkles-md" });
    expect(readFileSync(path, "utf8").startsWith(`${initial}\r\n`)).toBe(true);
    for (const [status, marker] of [["running", "~"], ["completed", "x"], ["halted", "!"], ["failed", "!"], ["pending", " "]] as const) {
      const updated = updateSparkleStatusInMarkdown(path, added.id, { status, threadId: "t-42", branchName: "sparkle/test", note: "A note -->" });
      const markdown = readFileSync(path, "utf8");
      expect(markdown.startsWith(`${initial}\r\n- [${marker}] [scratch] New idea `)).toBe(true);
      expect(markdown.match(/<!-- t3-pilot:/g)).toHaveLength(1);
      expect(updated).toMatchObject({ id: added.id, status, prompt, threadId: "t-42", branchName: "sparkle/test", note: "A note -->" });
      expect(readSparklesQueue(path).at(-1)).toEqual(updated);
    }
    const updated = updateSparkleStatusInMarkdown(path, added.id, { status: "running", branchName: null });
    expect(updated?.branchName).toBeNull();
    expect(readFileSync(path, "utf8")).toContain('"branchName":null');
  });

  it("updates just one duplicate item and preserves the other lines, whitespace, and final newline choice", () => {
    const original = "# Queue\n\t+  [ ]\t Repeat \t\n- [ ] Repeat\nplain text";
    writeFileSync(path, original);
    const [first, second] = readSparklesQueue(path);
    expect(first!.id).not.toBe(second!.id);
    updateSparkleStatusInMarkdown(path, first!.id, { status: "running" });
    const updated = readFileSync(path, "utf8");
    expect(updated.split("\n")).toEqual([
      "# Queue", expect.stringMatching(/^\t\+  \[~\]\t Repeat <!-- t3-pilot:.* --> \t$/), "- [ ] Repeat", "plain text",
    ]);
    expect(readSparklesQueue(path).map(({ id }) => id)).toEqual([first!.id, second!.id]);
    expect(updateSparkleStatusInMarkdown(path, "missing", { status: "completed" })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(updated);
  });

  it("starts a missing queue and rejects titles that could add extra checklist lines", () => {
    expect(readSparklesQueue(path)).toEqual([]);
    expect(() => appendSparkleToMarkdown(path, { title: "One\n- [ ] Two" })).toThrow(/single line/);
    expect(existsSync(path)).toBe(false);
    expect(appendSparkleToMarkdown(path, { title: "First" }).added).toMatchObject({ title: "First", prompt: "First", mode: "worktree" });
  });
});

describe("Sparkle runtime state and external queue", () => {
  it("atomically replaces state.json, leaves no temporary files, and rejects invalid versions", () => {
    const state = loadRuntimeState(root);
    expect(state).toMatchObject({ version: 1, pilotThreadIds: [], activeRun: null, history: [], lastSyncSnapshotId: null });
    saveRuntimeState(root, { ...state, pilotThreadIds: ["t1"], lastSyncSnapshotId: "snapshot-1" });
    const directory = join(root, ".t3-pilot");
    expect(readdirSync(directory)).toEqual(["state.json"]);
    expect(loadRuntimeState(root)).toEqual({ ...state, pilotThreadIds: ["t1"], lastSyncSnapshotId: "snapshot-1" });
    saveRuntimeState(root, state);
    expect(loadRuntimeState(root)).toEqual(state);
    expect(readdirSync(directory)).toEqual(["state.json"]);
    writeFileSync(join(directory, "state.json"), JSON.stringify({ ...state, version: 2 }));
    expect(() => loadRuntimeState(root)).toThrow(/unsupported/);
  });

  it("converts labelled GitHub issues, ignores invalid entries, and handles disabled or missing gh", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify([
      { number: 12, title: "Research", body: "Full research prompt" },
      { number: 15, title: "Fix it", body: "" }, { number: false, title: "Broken" }, null,
    ]) });
    const source = new GhCliSparkleIssueSource({ execCommand: runner });
    await expect(source.listSparkles(root)).resolves.toEqual([
      { id: "gh-12", title: "Research", prompt: "Full research prompt", mode: "worktree", status: "pending", source: "github-issue", externalRef: "#12" },
      { id: "gh-15", title: "Fix it", prompt: "Fix it", mode: "worktree", status: "pending", source: "github-issue", externalRef: "#15" },
    ]);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "list", "--label", "sparkle", "--json", "number,title,body"], { cwd: root });
    await expect(new GhCliSparkleIssueSource({ enabled: false, execCommand: runner }).listSparkles(root)).resolves.toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
    runner.mockRejectedValue(new Error("ENOENT"));
    await expect(source.listSparkles(root)).resolves.toEqual([]);
  });
});
