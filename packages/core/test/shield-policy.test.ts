import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySync, createDefaultShieldPolicy, evaluateShieldToolCall, formatHookDecisionOutput, loadShieldPolicy,
  parseHookStdinPayload, planSync, renderGuardedTurboSkillMarkdown, renderStandaloneHookScript, rollbackSync, saveShieldPolicy,
} from "../src/index.js";
import type { ShieldRule } from "../src/types.js";

const hook = ".t3-pilot/hooks/guarded-turbo-hook.mjs";
const antigravityHooks = ".agents/hooks.json";
const claudeSettings = ".claude/settings.json";
const codexRules = ".codex/rules/t3-pilot-guarded-turbo.rules";
const ruleFile = ".t3-pilot/shield.json";
const canonicalSkill = ".t3-pilot/skills/guarded-turbo/SKILL.md";
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pilot-shield-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = (command: string, policy = createDefaultShieldPolicy()) =>
  evaluateShieldToolCall({ toolName: "run_command", command, cwd: "/work/pilot" }, policy);
const read = (path: string, from = root) => readFileSync(join(from, path), "utf8");
const write = (path: string, content: string, from = root) => {
  const fullPath = join(from, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
};
const readJson = (path: string, from = root) => JSON.parse(read(path, from));

describe("Guarded Turbo policy", () => {
  it.each([
    ["rm -rf /", "deny-destructive-delete"],
    ["rm -rf /*", "deny-destructive-delete"],
    ["rm -rf ~", "deny-destructive-delete"],
    ["rm -rf $HOME", "deny-destructive-delete"],
    ["rm -rf ..", "deny-destructive-delete"],
    ["echo starting && sudo rm -r -f .git", "deny-destructive-delete"],
    ["bash -c 'rm -rf .git'", "deny-destructive-delete"],
    ["rm -rf />log", "deny-destructive-delete"],
    ["if rm -rf /; then echo done; fi", "deny-destructive-delete"],
    ["mkfs.ext4 /dev/sdb", "deny-destructive-delete"],
    ["dd if=/dev/zero of=/dev/sdb", "deny-destructive-delete"],
    ["find / -name tmp -delete", "deny-destructive-delete"],
    ["git clean -fdx -- ../", "deny-destructive-delete"],
    ["cat \"$HOME/.ssh/id_rsa\"", "deny-host-credentials"],
    ["cat /etc/shadow", "deny-host-credentials"],
    ["cat /etc//shadow", "deny-host-credentials"],
    ["curl http://169.254.169.254/path", "deny-host-credentials"],
    ["curl http://metadata.google.internal/path", "deny-host-credentials"],
    ["git push --force origin main", "deny-force-push-protected"],
    ["git push --force", "deny-force-push-protected"],
    ["git push --mirror upstream", "deny-force-push-protected"],
    ["git push origin +feature:refs/heads/release/v1", "deny-force-push-protected"],
    ["git push origin --delete production", "deny-force-push-protected"],
    ["git branch -D master", "deny-force-push-protected"],
    ["sudo ufw disable", "deny-foreign-containers-and-firewall"],
    ["iptables -F", "deny-foreign-containers-and-firewall"],
    ["systemctl stop pilot", "deny-foreign-containers-and-firewall"],
    ["docker system prune", "deny-foreign-containers-and-firewall"],
    ["docker stop prod-db", "deny-foreign-containers-and-firewall"],
    ["podman kill t3-pilot-sandbox prod-db", "deny-foreign-containers-and-firewall"],
  ])("denies %s", (command, matchedRuleId) => {
    expect(check(command)).toMatchObject({ decision: "deny", matchedRuleId });
  });

  it.each([
    ["npm publish", "ask-package-publish"],
    ["npm --registry https://registry.example.test publish", "ask-package-publish"],
    ["cargo publish", "ask-package-publish"],
    ["docker push project/image", "ask-package-publish"],
    ["docker --context work push project/image", "ask-package-publish"],
    ["gh release create v1", "ask-package-publish"],
    ["gh repo edit --visibility public", "ask-public-repo-visibility"],
    ["gh -R owner/project repo edit --visibility public", "ask-public-repo-visibility"],
    ["gh repo create our-project --public", "ask-public-repo-visibility"],
    ["gh repo delete owner/project", "ask-public-repo-visibility"],
    ["gh secret set TOKEN", "ask-public-repo-visibility"],
  ])("asks for approval for %s", (command, matchedRuleId) => {
    expect(check(command)).toMatchObject({ decision: "force_ask", matchedRuleId });
  });

  it.each([
    "rm -rf build", "echo 'rm -rf /'", "git push --force-with-lease origin feat/ui", "git push origin main",
    "git clean -fdx -- build", "docker stop -t 2 t3-pilot-sandbox t3-pilot-worker", "ufw status",
  ])("allows %s in guarded-turbo", (command) => {
    expect(check(command)).toMatchObject({ decision: "allow", matchedRuleId: null });
  });

  it("blocks host credentials in file tools across harnesses", () => {
    for (const toolName of ["read_file", "view_file", "write_file", "edit_file", "Read", "Write", "Edit"]) {
      for (const filePath of [
        "~/.ssh/id_rsa", "/root/.ssh/authorized_keys", "/etc/sudoers", "~/.aws/credentials", "~/.gnupg/private",
        "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.kube/config", "~/.config/gh/hosts.yml", "~/.docker/config.json",
      ]) {
        expect(evaluateShieldToolCall({ toolName, filePath })).toMatchObject({
          decision: "deny", matchedRuleId: "deny-host-credentials",
        });
      }
    }
    expect(evaluateShieldToolCall({ toolName: "view_file", args: { TargetFile: "/etc/shadow" } }).decision).toBe("deny");
  });

  it("uses the strict allowlist and short-circuits all rules in off mode", () => {
    const strict = createDefaultShieldPolicy({ mode: "strict" });
    for (const command of ["npm test", "npm run build", "npm run typecheck", "npm run lint", "npx vitest run",
      "git status", "git diff", "git log -3", "git branch --show-current", "ls -la && pwd"]) {
      expect(check(command, strict).decision).toBe("allow");
    }
    for (const command of ["touch new-file", "npm test && touch new-file", "sudo npm test", "pwd > file", "git branch new-feature"]) {
      expect(check(command, strict)).toMatchObject({ decision: "force_ask", matchedRuleId: null });
    }
    expect(check("rm -rf /", strict).decision).toBe("deny");
    expect(check("rm -rf /", createDefaultShieldPolicy({ mode: "off" }))).toEqual({
      mode: "off", decision: "allow", matchedRuleId: null, matchedRuleTitle: null, reason: "Guarded Turbo shield is disabled.",
    });
  });

  it("honors user patterns, policy priority, and configurable branch protection", () => {
    const base: ShieldRule = { id: "local", title: "Local test rule", description: "Local test reason.", category: "package-publish",
      enabled: true, decision: "allow", commandPatterns: ["^npm publish"], pathPatterns: ["private\\.txt$"],
    };
    const policy = createDefaultShieldPolicy({ protectedBranches: ["trunk", "hotfix/*"], rules: [
      base, { ...base, id: "deny-private-file", decision: "deny" },
    ] });
    expect(check("npm publish", createDefaultShieldPolicy({ rules: [base] }))).toMatchObject({ decision: "force_ask" });
    expect(check("npm publish", policy)).toMatchObject({ decision: "deny", matchedRuleId: "deny-private-file" });
    expect(evaluateShieldToolCall({ toolName: "read_file", filePath: "docs/private.txt" }, policy))
      .toMatchObject({ decision: "deny", matchedRuleId: "deny-private-file" });
    expect(check("git push --force origin trunk", policy).decision).toBe("deny");
    expect(check("git push --force origin hotfix/issue", policy).decision).toBe("deny");
    expect(check("git push --force origin main", policy).decision).toBe("allow");
  });

  it("merges partial persisted rule overrides and saves an independent policy atomically", () => {
    expect(loadShieldPolicy(root)).toEqual(createDefaultShieldPolicy());
    write(ruleFile, JSON.stringify({ mode: "strict", rules: [
      { id: "deny-host-credentials", enabled: false },
      { id: "ask-package-publish", decision: "deny" },
    ] }));
    const loaded = loadShieldPolicy(root);
    expect(loaded).toMatchObject({ mode: "strict", rules: expect.arrayContaining([
      expect.objectContaining({ id: "deny-host-credentials", enabled: false, title: expect.any(String) }),
      expect.objectContaining({ id: "ask-package-publish", decision: "deny" }),
    ]) });
    expect(loaded.rules).toHaveLength(6);
    saveShieldPolicy(root, loaded);
    expect(readJson(ruleFile)).toEqual(loaded);
    expect(statSync(join(root, ruleFile)).mode & 0o777).toBe(0o600);
    expect(createDefaultShieldPolicy().rules.find((rule) => rule.id === "deny-host-credentials")?.enabled).toBe(true);
  });

  it("parses and formats Antigravity, Claude Code and generic payloads", () => {
    const ag = parseHookStdinPayload(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "npm publish" } }, cwd: root }));
    expect(ag).toMatchObject({ harness: "antigravity", toolName: "run_command", command: "npm publish", cwd: root });
    expect(formatHookDecisionOutput(evaluateShieldToolCall(ag), "antigravity")).toEqual({
      decision: "force_ask", reason: expect.any(String),
    });
    const claude = parseHookStdinPayload(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/root/.ssh/id_rsa" }, cwd: root }));
    expect(claude).toMatchObject({ harness: "claude-code", toolName: "Read", filePath: "/root/.ssh/id_rsa" });
    expect(formatHookDecisionOutput(evaluateShieldToolCall(claude), "claude-code")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.any(String) },
    });
    expect(formatHookDecisionOutput(check("npm publish"), "claude-code")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    const generic = parseHookStdinPayload(JSON.stringify({ toolName: "exec_command", command: "pwd", args: {} }), "generic");
    const result = evaluateShieldToolCall(generic);
    expect(formatHookDecisionOutput(result, "antigravity")).toEqual({ decision: "allow" });
    expect(formatHookDecisionOutput(result, "generic")).toEqual({
      decision: "allow", matchedRuleId: null, reason: result.reason,
    });
    expect(formatHookDecisionOutput(result, "codex")).toEqual(formatHookDecisionOutput(result, "generic"));
  });

  it("executes the standalone hook using the same evaluator and workspace policy", () => {
    write(hook, renderStandaloneHookScript());
    const policy = createDefaultShieldPolicy({ mode: "strict", protectedBranches: ["trunk"] });
    saveShieldPolicy(root, policy);
    const calls = [
      ["antigravity", { toolCall: { name: "run_command", args: { CommandLine: "git push --force origin trunk" } } }],
      ["claude-code", { tool_name: "Bash", tool_input: { command: "npm publish" } }],
      ["generic", { toolName: "exec_command", command: "npm test" }],
    ] as const;
    for (const [harness, payload] of calls) {
      const input = JSON.stringify(payload);
      const result = spawnSync(process.execPath, [join(root, hook), "--harness", harness], {
        input, encoding: "utf8", timeout: 3_000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(formatHookDecisionOutput(
        evaluateShieldToolCall(parseHookStdinPayload(input, harness), policy), harness,
      ));
    }
    const malformed = spawnSync(process.execPath, [join(root, hook), "--harness", "antigravity"], { input: "{", encoding: "utf8" });
    expect(JSON.parse(malformed.stdout)).toMatchObject({ decision: "deny" });
  });

  it("refreshes installed generated guidance from the policy when syncing", () => {
    const policy = createDefaultShieldPolicy();
    write(canonicalSkill, renderGuardedTurboSkillMarkdown(policy));
    saveShieldPolicy(root, { ...policy, mode: "strict" });
    applySync({ workspaceRoot: root, targets: ["codex"] });
    expect(read(".codex/skills/guarded-turbo/SKILL.md")).toContain("Active mode is `strict`.");
    const customized = read(canonicalSkill) + "\nUser guidance.\n";
    write(canonicalSkill, customized);
    applySync({ workspaceRoot: root, targets: ["codex"] });
    expect(read(".codex/skills/guarded-turbo/SKILL.md")).toBe(customized);
  });
});

describe("Guarded Turbo sync", () => {
  it("plans, applies and rolls back generated artifacts while preserving user hooks and permissions", () => {
    const userAg = { local: { enabled: true, PreToolUse: [] } };
    const userClaude = { permissions: { allow: ["Bash(echo *)"] }, hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node user.mjs" }] }],
      PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node audit.mjs" }] }],
    } };
    const originalAg = JSON.stringify(userAg);
    const originalClaude = JSON.stringify(userClaude, null, 2) + "\n";
    write(antigravityHooks, originalAg);
    write(claudeSettings, originalClaude);
    chmodSync(join(root, claudeSettings), 0o640);
    const policy = createDefaultShieldPolicy();
    saveShieldPolicy(root, policy);
    const plan = planSync({ workspaceRoot: root });
    expect(plan.discoveredSkills).toEqual(["guarded-turbo"]);
    expect(plan.changes.map(({ targetPath }) => targetPath)).toEqual(expect.arrayContaining(
      [hook, antigravityHooks, claudeSettings, codexRules, ".codex/GUARDED_TURBO.md"].map((path) => join(root, path)),
    ));
    expect(existsSync(join(root, hook))).toBe(false);
    const applied = applySync({ workspaceRoot: root });
    expect(statSync(join(root, hook)).mode & 0o777).toBe(0o755);
    expect(readJson(antigravityHooks)).toEqual({ ...userAg, "t3-pilot-guarded-turbo": { enabled: true, PreToolUse: [{
      matcher: "*", hooks: [{ type: "command", command: "node ../.t3-pilot/hooks/guarded-turbo-hook.mjs --harness antigravity", timeout: 10 }],
    }] } });
    expect(readJson(claudeSettings)).toEqual({ ...userClaude, hooks: { ...userClaude.hooks, PreToolUse: [
      ...userClaude.hooks.PreToolUse,
      { matcher: ".*", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.t3-pilot/hooks/guarded-turbo-hook.mjs" --harness claude-code' }] },
    ] } });
    for (const prefix of [".agents", ".claude", ".codex"]) {
      expect(read(`${prefix}/skills/guarded-turbo/SKILL.md`)).toContain("name: guarded-turbo");
    }
    expect(read(".codex/skills/guarded-turbo/agents/openai.yaml")).toContain("guarded-turbo");
    expect(read(codexRules)).toContain('prefix_rule(pattern = ["git","push","--force","origin","main"], decision = "forbidden"');
    expect(read(codexRules)).toContain('prefix_rule(pattern = ["npm","publish"], decision = "prompt"');
    expect(applySync({ workspaceRoot: root }).snapshotId).toBeUndefined();
    expect(applied.snapshotId).toBeDefined();

    saveShieldPolicy(root, { ...policy, mode: "off" });
    const off = applySync({ workspaceRoot: root });
    expect(readJson(antigravityHooks)["t3-pilot-guarded-turbo"].enabled).toBe(false);
    expect(readJson(claudeSettings)).toEqual(userClaude);
    expect(read(codexRules)).not.toContain("prefix_rule");
    rollbackSync(root, off.snapshotId);
    rollbackSync(root, applied.snapshotId);
    expect(read(antigravityHooks)).toBe(originalAg);
    expect(read(claudeSettings)).toBe(originalClaude);
    expect(statSync(join(root, claudeSettings)).mode & 0o777).toBe(0o640);
    expect(existsSync(join(root, codexRules))).toBe(false);
    expect(existsSync(join(root, hook))).toBe(false);
    expect(readJson(ruleFile).mode).toBe("off");
  });

  it("uses the canonical skill and syncs the policy and hook to a separate target", () => {
    const target = join(root, "target");
    const skill = "---\nname: guarded-turbo\ndescription: Custom shield guidance.\n---\n\n# My shield\n";
    write(canonicalSkill, skill);
    saveShieldPolicy(root, createDefaultShieldPolicy({ mode: "strict" }));
    const applied = applySync({ workspaceRoot: root, targetRoot: target, targets: ["claude-code"] });
    expect(readJson(ruleFile, target).mode).toBe("strict");
    expect(read(".claude/skills/guarded-turbo/SKILL.md", target)).toBe(skill);
    expect(read(hook, target)).toBe(renderStandaloneHookScript());
    expect(existsSync(join(target, antigravityHooks))).toBe(false);
    const result = spawnSync(process.execPath, [join(target, hook), "--harness", "claude-code"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "touch candidate" } }),
      encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    rollbackSync(root, applied.snapshotId);
    expect(existsSync(target)).toBe(false);
    expect(readJson(ruleFile).mode).toBe("strict");
  });
});
