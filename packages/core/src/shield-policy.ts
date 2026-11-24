import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ShieldDecision, ShieldEvaluationResult, ShieldPolicyConfig, ShieldRule, ShieldToolCallInput,
} from "./types.js";

export const shieldPolicyPath = ".t3-pilot/shield.json";
type Harness = NonNullable<ShieldToolCallInput["harness"]>;

const defaultRules: ShieldRule[] = [
  {
    id: "deny-destructive-delete", title: "Catastrophic filesystem changes",
    description: "Recursive forced deletes of root, home, parent or Git metadata, disk formatting, device writes, root-wide find deletion and broad Git cleanup.",
    category: "destructive-fs", decision: "deny", enabled: true,
    codexPrefixPatterns: [
      ["rm", "-rf", "/"], ["rm", "-rf", "/*"], ["rm", "-rf", ".."], ["rm", "-rf", ".git"],
      ["mkfs"], ["find", "/", "-delete"], ["git", "clean", "-fdx", "--", "."],
    ],
  },
  {
    id: "deny-host-credentials", title: "Host credentials and cloud metadata",
    description: "Access to SSH, AWS, GnuPG and other host credentials, protected system files and cloud metadata endpoints.",
    category: "host-credentials", decision: "deny", enabled: true,
    codexPrefixPatterns: [["cat", "/etc/shadow"], ["cat", "/etc/sudoers"], ["curl", "http://169.254.169.254"]],
  },
  {
    id: "deny-force-push-protected", title: "Protected Git branch history",
    description: "Force pushes and deletions targeting protected branches, mirror pushes and forced deletion of protected local branches.",
    category: "git-history", decision: "deny", enabled: true,
  },
  {
    id: "deny-foreign-containers-and-firewall", title: "Host infrastructure and foreign containers",
    description: "Host firewall or system service mutations, container pruning and destructive operations on containers outside the t3-pilot namespace.",
    category: "infra-containers-firewall", decision: "deny", enabled: true,
    codexPrefixPatterns: [
      ["ufw", "disable"], ["ufw", "enable"], ["iptables", "-F"], ["ip6tables", "-F"], ["nft", "flush"],
      ...["stop", "disable", "mask", "kill"].map((operation) => ["systemctl", operation]),
      ["shutdown"], ["reboot"], ["poweroff"],
      ...["docker", "podman"].flatMap((runtime) => [[runtime, "system", "prune"], [runtime, "volume", "prune"]]),
    ],
  },
  {
    id: "ask-package-publish", title: "Package and release publishing",
    description: "Publishing packages, uploading registry artifacts or creating a GitHub release.",
    category: "package-publish", decision: "force_ask", enabled: true,
    codexPrefixPatterns: [
      ...["npm", "pnpm", "yarn", "bun", "cargo", "poetry"].map((manager) => [manager, "publish"]),
      ["twine", "upload"], ["docker", "push"], ["gh", "release", "create"],
    ],
  },
  {
    id: "ask-public-repo-visibility", title: "Repository visibility, deletion and secrets",
    description: "Changing repository visibility, creating a public repository, deleting or archiving a repository, or modifying GitHub secrets.",
    category: "repo-visibility", decision: "force_ask", enabled: true,
    codexPrefixPatterns: [
      ["gh", "repo", "create", "--public"], ["gh", "repo", "edit", "--visibility"],
      ["gh", "repo", "delete"], ["gh", "repo", "archive"],
      ...["set", "delete", "remove"].map((operation) => ["gh", "secret", operation]),
    ],
  },
];

const defaultPolicy: ShieldPolicyConfig = {
  version: 1,
  mode: "guarded-turbo",
  protectedBranches: ["main", "master", "production", "release/*"],
  rules: defaultRules,
};

// Both the library and the standalone hook use this function. Keep its dependencies inside it.
function createShieldRuntime(defaults: ShieldPolicyConfig) {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (...values: unknown[]) => values.find((value): value is string => typeof value === "string");
  const shellTools = new Set(["run_command", "bash", "exec_command"]);
  const commandFields = ["CommandLine", "command", "cmd", "command_line", "commandLine"];
  const pathFields = ["TargetFile", "FilePath", "AbsolutePath", "Path", "file_path", "filePath", "path",
    "path_to_file", "pathToFile", "absolute_path", "target_file", "targetFile", "paths", "files", "notebook_path"];

  function policyFrom(overrides: Partial<ShieldPolicyConfig> = {}): ShieldPolicyConfig {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("Expected a JSON object for the Guarded Turbo policy.");
    }
    const policy = { ...defaults, ...overrides };
    const supplied = new Map((overrides.rules ?? []).map((rule) => [rule.id, rule]));
    policy.rules = defaults.rules.map((rule) => {
      const override = supplied.get(rule.id);
      supplied.delete(rule.id);
      return { ...rule, ...override };
    });
    policy.rules.push(...supplied.values());
    if (policy.version !== 1 || !["guarded-turbo", "strict", "off"].includes(policy.mode)
      || !Array.isArray(policy.protectedBranches) || policy.protectedBranches.some((branch) => typeof branch !== "string")) {
      throw new Error("Invalid Guarded Turbo policy version, mode or protected branches.");
    }
    for (const rule of policy.rules) {
      if (typeof rule.id !== "string" || !rule.id || typeof rule.title !== "string"
        || typeof rule.description !== "string" || typeof rule.enabled !== "boolean"
        || !["allow", "deny", "force_ask"].includes(rule.decision)) {
        throw new Error("Invalid Guarded Turbo rule.");
      }
      for (const patterns of [rule.commandPatterns, rule.pathPatterns]) {
        if (patterns === undefined) continue;
        if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
          throw new Error(`Invalid regex patterns for Guarded Turbo rule ${rule.id}.`);
        }
        for (const pattern of patterns) new RegExp(pattern);
      }
      if (rule.codexPrefixPatterns !== undefined && (!Array.isArray(rule.codexPrefixPatterns)
        || rule.codexPrefixPatterns.some((pattern) => !Array.isArray(pattern) || pattern.length === 0
          || pattern.some((part) => typeof part !== "string" || !part)))) {
        throw new Error(`Invalid Codex prefixes for Guarded Turbo rule ${rule.id}.`);
      }
    }
    return structuredClone(policy);
  }

  function parse(rawJson: string, harness?: Harness): ShieldToolCallInput {
    const payload: unknown = JSON.parse(rawJson);
    const raw = record(payload);
    if (payload !== raw) throw new Error("Expected a JSON object for the Guarded Turbo hook.");
    const toolCall = record(raw.toolCall);
    const detected = harness ?? (raw.toolCall ? "antigravity" : raw.tool_name ? "claude-code" : "generic");
    const args = record(detected === "antigravity" ? toolCall.args
      : detected === "claude-code" ? raw.tool_input : raw.args);
    const toolName = text(detected === "antigravity" ? toolCall.name
      : detected === "claude-code" ? raw.tool_name : raw.toolName);
    if (!toolName?.trim()) throw new Error("The Guarded Turbo hook payload requires a tool name.");
    return {
      harness: detected,
      toolName,
      command: text(raw.command, ...commandFields.map((name) => args[name])),
      filePath: text(raw.filePath, ...pathFields.map((name) => args[name])),
      args,
      cwd: text(raw.cwd, toolCall.cwd, args.cwd, args.Cwd, args.WorkingDirectory),
    };
  }

  // Split compound commands without running expansions. Nested shell invocations are inspected separately.
  function shellSegments(source: string): string[][] {
    const redirect = /^(?:\d*|&)(?:<<<|<<-?|>>|<>|>&|<&|>\||[<>])$/;
    const tokenPattern = /#[^\n]*|\\\n|&&|\|\||(?:\d*|&)(?:<<<|<<-?|>>|<>|>&|<&|>\||[<>])|[;\n|&()]|(?:[^\s;|&()<>'"\x60\\]|\\[^\n]|'[^']*'|"(?:\\.|[^"\\])*"|\x60[^\x60]*\x60)+|\S/g;
    const segments: string[][] = [[]];
    let redirectTarget = false;
    for (const match of source.matchAll(tokenPattern)) {
      const word = match[0];
      if (/^(?:&&|\|\||[;\n|&()])$/.test(word)) {
        if (segments.at(-1)!.length) segments.push([]);
        redirectTarget = false;
      } else if (redirect.test(word)) {
        redirectTarget = true;
      } else if (!word.startsWith("#") && word !== "\\\n") {
        if (!redirectTarget) {
          segments.at(-1)!.push(word.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
            (_match, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
              single ?? double?.replace(/\\(["\\$`])/g, "$1") ?? escaped ?? ""));
        }
        redirectTarget = false;
      }
    }
    return segments.filter((words) => words.length);
  }

  function commands(source: string, depth = 0): string[][] {
    if (depth >= 6) return [];
    return shellSegments(source.replaceAll("\\\n", "")).flatMap((segment) => {
      let words = segment;
      while (words.length) {
        const head = words[0]!.split("/").at(-1);
        if (/^[a-zA-Z_]\w*=/.test(words[0]!) || ["if", "then", "do", "else", "elif", "while", "until", "!", "{"].includes(head!)) {
          words = words.slice(1);
        } else if (["sudo", "doas", "env", "command", "exec", "nohup", "time"].includes(head!)) {
          const consumesValue = head === "env" ? ["-u", "--unset", "-C", "--chdir"]
            : head === "sudo" || head === "doas" ? ["-u", "-g", "-h", "-p", "-C", "-R", "-D", "-r", "-t", "--user", "--group", "--chdir"] : [];
          words = words.slice(1);
          while (words[0]?.startsWith("-")) {
            const flag = words[0];
            words = words.slice(consumesValue.includes(flag) ? 2 : 1);
            if (flag === "--") break;
          }
        } else break;
      }
      if (!words.length) return [];
      const [binary, ...args] = words;
      const executable = binary!.split("/").at(-1)!;
      const nested = words.flatMap((arg) => [...arg.matchAll(/\$\(([^()]*)\)|\x60([^\x60]*)\x60/g)]
        .flatMap((match) => commands(match[1] ?? match[2]!, depth + 1)));
      if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(executable)) {
        const index = args.findIndex((arg) => arg === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
        if (index >= 0 && args[index + 1]) nested.push(...commands(args[index + 1]!, depth + 1));
      }
      return [[executable, ...args], ...nested];
    });
  }

  function normalizePath(path: string, cwd?: string): string {
    const value = path.replace(/^\$\{HOME\}|^\$HOME(?=\/|$)|^~(?=\/|$)/, "~");
    const absolute = value.startsWith("/") || value.startsWith("~") || !cwd ? value : `${cwd}/${value}`;
    const parts: string[] = [];
    for (const part of absolute.split("/")) {
      if (part === "." || part === "") continue;
      if (part === ".." && parts.length && !["..", "~"].includes(parts.at(-1)!)) parts.pop();
      else if (part !== ".." || !absolute.startsWith("/") || parts.length) parts.push(part);
    }
    return (absolute.startsWith("/") ? "/" : "") + parts.join("/");
  }

  function dangerousDelete([name, ...args]: string[], cwd?: string): boolean {
    const flags = args.filter((arg) => arg.startsWith("-"));
    const globalPath = (arg: string) => {
      const unwrapped = arg.replace(/\/(?:\*|\{\.\*,\*\})$/, "/");
      const path = normalizePath(unwrapped, cwd);
      return ["/", "~"].includes(path) || /^\/(?:root|home\/[^/]+)$/.test(path)
        || /^\.\.(?:\/|$)/.test(arg) || /(?:^|\/)\.git(?:\/|$)/.test(path);
    };
    if (name === "rm") {
      return flags.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg))
        && flags.some((arg) => arg === "--force" || /^-[^-]*f/.test(arg)) && args.some(globalPath);
    }
    if (/^mkfs(?:\.|$)/.test(name ?? "")) return true;
    if (name === "dd") return args.some((arg) => arg.startsWith("of=") && normalizePath(arg.slice(3), cwd).startsWith("/dev/"));
    return name === "find" && args.includes("-delete")
      && args.slice(0, args.indexOf("-delete")).some((arg) => normalizePath(arg, cwd) === "/");
  }

  function isProtected(branch: string, patterns: string[]): boolean {
    const name = branch.replace(/^refs\/heads\//, "");
    return patterns.some((pattern) => {
      const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp(`^${escaped}$`).test(name);
    });
  }

  function gitOperation(args: string[]): string[] {
    return operationArgs(args, ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  }

  function operationArgs(args: string[], optionsWithValue: string[]): string[] {
    let index = 0;
    while (args[index]?.startsWith("-")) index += optionsWithValue.includes(args[index]!) ? 2 : 1;
    return args.slice(index);
  }

  function protectedGitOperation(args: string[], branches: string[]): boolean {
    const [operation, ...params] = gitOperation(args);
    const flags = params.filter((arg) => arg.startsWith("-"));
    if (operation === "branch") {
      return flags.some((arg) => /^-[^-]*D/.test(arg))
        && params.some((arg) => !arg.startsWith("-") && isProtected(arg, branches));
    }
    if (operation !== "push") return false;
    if (flags.includes("--mirror")) return true;
    const takesValue = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
    const positionals: string[] = [];
    let options = true;
    let explicitRemote = false;
    for (let index = 0; index < params.length; index++) {
      const arg = params[index]!;
      if (options && arg === "--") {
        options = false;
      } else if (options && arg.startsWith("-")) {
        if (/^--repo(?:=|$)/.test(arg)) explicitRemote = true;
        if (takesValue.has(arg)) index++;
      } else {
        positionals.push(arg);
      }
    }
    const refs = explicitRemote ? positionals : positionals.slice(1);
    const destructive = flags.some((arg) => /^(?:--force(?:-with-lease)?(?:=|$)|--delete$|-[^-]*[fd])/.test(arg));
    if (destructive && !refs.length) return true;
    return refs.some((ref) => {
      if (!destructive && !ref.startsWith("+") && !ref.startsWith(":")) return false;
      const destination = ref.replace(/^\+/, "").split(":").at(-1)!;
      return !destination || destination === "HEAD" || destination.includes("*") || isProtected(destination, branches);
    });
  }

  function riskyInfrastructure([name, ...args]: string[]): boolean {
    if (["shutdown", "reboot", "poweroff"].includes(name ?? "")) return true;
    if (name === "systemctl") return args.some((arg) => ["stop", "disable", "mask", "kill"].includes(arg));
    if (name === "ufw") return args.some((arg) => ["enable", "disable", "reset", "reload", "default", "allow",
      "deny", "reject", "limit", "delete", "insert", "prepend", "route", "logging"].includes(arg));
    if (name === "iptables" || name === "ip6tables") {
      return args.some((arg) => /^-[AFIDRXZPNEM]/.test(arg)
        || /^--(?:append|flush|insert|delete|replace|delete-chain|zero|policy|new-chain|rename-chain|modprobe)(?:=|$)/.test(arg));
    }
    if (name === "nft") return args.some((arg) => ["add", "insert", "delete", "destroy", "flush", "replace",
      "create", "rename", "reset", "-f", "--file", "-i", "--interactive"].includes(arg) || arg.startsWith("--file="));
    if (name === "firewall-cmd") return args.some((arg) => /^--(?:add-|remove-|set-|new-|delete-|change-|reload$|complete-reload$|runtime-to-permanent$|lockdown-|panic-)/.test(arg));
    if (name !== "docker" && name !== "podman") return false;

    const takesValue = new Set(["--context", "-c", "--host", "-H", "--config", "--connection", "--url", "--time", "-t", "--signal", "-s"]);
    const positionals = args.filter((arg, index) => !arg.startsWith("-") && !takesValue.has(args[index - 1] ?? ""));
    const [operation, ...targets] = positionals[0] === "container" ? positionals.slice(1) : positionals;
    if (["system", "volume", "container"].includes(operation ?? "") && targets[0] === "prune") return true;
    if (positionals[0] === "container" && positionals[1] === "prune") return true;
    return ["rm", "stop", "kill"].includes(operation ?? "")
      && (!targets.length || args.some((arg) => arg === "--all" || arg === "-a")
        || targets.some((target) => !/^t3-pilot[\w.-]*$/.test(target)));
  }

  function isReadOnlyOrLocalTest(source: string, executable: string[][]): boolean {
    if (/[<>\x60]|\$\(|\b(?:sudo|doas)\b/.test(source) || !executable.length) return false;
    return executable.every(([name, sub, ...args]) =>
      (name === "ls" || name === "pwd") && ![sub, ...args].some((arg) => arg === "--output")
      || (name === "npm" && (sub === "test" || sub === "run" && ["build", "typecheck", "lint"].includes(args[0]!)))
      || (name === "npx" && sub === "vitest")
      || (name === "git" && (["status", "diff", "log"].includes(sub!)
        && !args.some((arg) => /^--output(?:=|$)/.test(arg))
        || sub === "branch" && args.every((arg) => ["--list", "-l", "-a", "-r", "-v", "-vv", "--show-current"].includes(arg)))));
  }

  function evaluate(input: ShieldToolCallInput, policy = defaults): ShieldEvaluationResult {
    const result = (decision: ShieldDecision, reason: string, rule?: ShieldRule): ShieldEvaluationResult => ({
      mode: policy.mode, decision, reason, matchedRuleId: rule?.id ?? null, matchedRuleTitle: rule?.title ?? null,
    });
    if (policy.mode === "off") return result("allow", "Guarded Turbo shield is disabled.");
    const args = input.args ?? {};
    const command = input.command ?? text(...commandFields.map((name) => args[name])) ?? "";
    const paths = [input.filePath, ...pathFields.flatMap((name) => args[name])].filter((value): value is string => typeof value === "string");
    const executable = commands(command);
    const operands = executable.flat();
    const credentials = /(?:^|[^\w.-])(?:\.(?:ssh|aws|gnupg|netrc|npmrc|pypirc)(?=$|[^\w.-])|\.kube\/config\b|\.config\/gh\/hosts\.yml\b|\.docker\/config\.json\b|etc\/(?:shadow|sudoers(?:\.d)?)(?=$|[^\w.-]))|\b(?:169\.254\.169\.254|metadata\.google\.internal)\b/i;
    const builtin: Record<string, () => boolean> = {
      "deny-destructive-delete": () => executable.some((words) => {
        if (dangerousDelete(words, input.cwd)) return true;
        if (words[0] !== "git") return false;
        const [operation, ...params] = gitOperation(words.slice(1));
        if (operation !== "clean" || params.some((arg) => arg === "--dry-run" || /^-[^-]*n/.test(arg))) return false;
        if (!["f", "d", "x"].every((flag) => params.some((arg) => arg === "--force" && flag === "f"
          || arg.startsWith("-") && !arg.startsWith("--") && arg.includes(flag)))) return false;
        const operands = params.filter((arg) => !arg.startsWith("-"));
        return !operands.length || operands.some((arg) => /^(?:\/|~|\$\{?HOME\}?|\.\.(?:\/|$)|\.(?:\/)?$)/.test(arg));
      }),
      "deny-host-credentials": () => [command, ...paths, ...operands,
        ...[...paths, ...operands].map((path) => normalizePath(path, input.cwd))]
        .some((value) => credentials.test(value)),
      "deny-force-push-protected": () => executable.some(([name, ...params]) =>
        name === "git" && protectedGitOperation(params, policy.protectedBranches)),
      "deny-foreign-containers-and-firewall": () => executable.some(riskyInfrastructure),
      "ask-package-publish": () => executable.some(([name, ...params]) => {
        const args = operationArgs(params, ["--registry", "--prefix", "--cwd", "--dir", "-C", "--context", "--host", "-H", "--config"]);
        return (["npm", "pnpm", "yarn", "bun", "cargo", "poetry"].includes(name!) && args[0] === "publish")
          || (name === "yarn" && args[0] === "npm" && args[1] === "publish")
          || (name === "twine" && args[0] === "upload") || (name === "docker" && args[0] === "push")
          || (name === "gh" && args[0] === "release" && args[1] === "create");
      }),
      "ask-public-repo-visibility": () => executable.some(([name, ...params]) => {
        const [area, action] = operationArgs(params, ["-R", "--repo", "--hostname"]);
        return name === "gh" && (area === "secret" && ["set", "delete", "remove"].includes(action!)
          || area === "repo" && (["delete", "archive"].includes(action!)
            || action === "edit" && params.some((arg) => /^--visibility(?:=|$)/.test(arg))
            || action === "create" && params.includes("--public")));
      }),
    };
    const priority: Record<ShieldDecision, number> = { allow: 0, force_ask: 1, deny: 2 };
    let winner: ShieldRule | undefined;
    for (const rule of policy.rules) {
      if (!rule.enabled || winner && priority[winner.decision] >= priority[rule.decision]) continue;
      if ((Object.hasOwn(builtin, rule.id) && builtin[rule.id]!())
        || (command && rule.commandPatterns?.some((pattern) => new RegExp(pattern).test(command)))
        || rule.pathPatterns?.some((pattern) => paths.some((path) => new RegExp(pattern).test(path)))) {
        winner = rule;
      }
    }
    if (winner) return result(winner.decision, winner.description, winner);
    if (policy.mode === "strict" && (shellTools.has(input.toolName.toLowerCase()) || command)
      && !isReadOnlyOrLocalTest(command, executable)) {
      return result("force_ask", "Strict mode requires approval for shell commands outside the local development allowlist.");
    }
    return result("allow", "No Guarded Turbo rules matched.");
  }

  function format(result: ShieldEvaluationResult, harness: Harness): Record<string, unknown> {
    const allowed = result.decision === "allow";
    if (harness === "antigravity") {
      return { decision: result.decision, ...(!allowed && { reason: result.reason }) };
    }
    if (harness === "claude-code") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: result.decision === "force_ask" ? "ask" : result.decision,
          ...(!allowed && { permissionDecisionReason: result.reason }),
        },
      };
    }
    return { decision: result.decision, matchedRuleId: result.matchedRuleId, reason: result.reason };
  }

  return { policyFrom, parse, evaluate, format };
}

const runtime = createShieldRuntime(defaultPolicy);
export const createDefaultShieldPolicy = runtime.policyFrom;
export const parseHookStdinPayload = runtime.parse;
export const evaluateShieldToolCall = runtime.evaluate;
export const formatHookDecisionOutput = runtime.format;

export function loadShieldPolicy(workspaceRoot: string): ShieldPolicyConfig {
  try {
    return createDefaultShieldPolicy(JSON.parse(readFileSync(join(workspaceRoot, shieldPolicyPath), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createDefaultShieldPolicy();
    throw error;
  }
}

export function saveShieldPolicy(workspaceRoot: string, policy: ShieldPolicyConfig): void {
  const path = join(workspaceRoot, shieldPolicyPath);
  const data = `${JSON.stringify(createDefaultShieldPolicy(policy), null, 2)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const generatedSkillMarker = /^<!-- t3-pilot generated shield ([a-f0-9]{64}) -->\n/m;
const skillHash = (content: string) => createHash("sha256").update(content).digest("hex");

export function isGeneratedGuardedTurboSkill(markdown: string): boolean {
  const marker = generatedSkillMarker.exec(markdown);
  return Boolean(marker && skillHash(markdown.replace(generatedSkillMarker, "")) === marker[1]);
}

export function renderGuardedTurboSkillMarkdown(policy: ShieldPolicyConfig): string {
  const content = [
    "---",
    "name: guarded-turbo",
    "description: Apply the workspace Guarded Turbo policy to tool calls and request approval for sensitive operations.",
    "---",
    "",
    "# Guarded Turbo",
    "",
    `Active mode is \`${policy.mode}\`.`,
    "",
    ...(policy.mode === "off" ? ["The shield is disabled."] : [
      "Use the hook decision and consult \`t3-pilot shield check\` when unsure about a tool call.",
      ...(policy.mode === "strict" ? ["Ask for approval before shell commands outside the local development allowlist."] : []),
      "",
      ...(["deny", "force_ask"] as const).flatMap((decision) => {
        const rules = policy.rules.filter((rule) => rule.enabled && rule.decision === decision);
        return rules.length ? [
          decision === "deny" ? "## Blocked operations" : "## Operations requiring approval", "",
          ...rules.map((rule) => `- **${rule.title}**. ${rule.description}`), "",
        ] : [];
      }),
      `Protected branches are ${policy.protectedBranches.map((branch) => `\`${branch}\``).join(", ") || "unset"}.`,
    ]),
    "",
  ].join("\n");
  return content.replace("\n# Guarded Turbo\n", `\n<!-- t3-pilot generated shield ${skillHash(content)} -->\n# Guarded Turbo\n`);
}

export function renderStandaloneHookScript(): string {
  return `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const __name = (value) => value; // Function name metadata from TypeScript-aware bundlers.
const createShieldRuntime = ${createShieldRuntime.toString()};
const runtime = createShieldRuntime(${JSON.stringify(defaultPolicy)});
const harnessOption = process.argv.indexOf("--harness");
let harness = harnessOption < 0 ? undefined : process.argv[harnessOption + 1];
try {
  const path = harness === "claude-code" && process.env.CLAUDE_PROJECT_DIR
    ? join(process.env.CLAUDE_PROJECT_DIR, ".t3-pilot/shield.json")
    : new URL("../shield.json", import.meta.url);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const policy = runtime.policyFrom(config);
  const input = runtime.parse(readFileSync(0, "utf8"), harness);
  harness = input.harness;
  process.stdout.write(JSON.stringify(runtime.format(runtime.evaluate(input, policy), harness)) + "\\n");
} catch (error) {
  const result = { decision: "deny", matchedRuleId: null, reason: "Guarded Turbo could not evaluate the tool call. " + error.message };
  process.stdout.write(JSON.stringify(runtime.format(result, harness ?? "generic")) + "\\n");
}
`;
}

export function renderCodexRulesFile(policy: ShieldPolicyConfig): string {
  const lines = ["# Generated by t3-pilot shield. Run t3-pilot sync --apply to refresh.", ""];
  if (policy.mode === "off") return lines.join("\n");

  const prefixes = new Map<string, { rule: ShieldRule; decision: "forbidden" | "prompt" }>();
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.decision === "allow") continue;
    const patterns = [...(rule.codexPrefixPatterns ?? [])];
    if (rule.id === "deny-force-push-protected") {
      patterns.push(["git", "push", "--mirror"]);
      for (const branch of policy.protectedBranches.filter((name) => !name.includes("*"))) {
        patterns.push(["git", "branch", "-D", branch]);
        for (const flag of ["--force", "-f", "--force-with-lease", "--delete", "-d"]) {
          patterns.push(["git", "push", flag, "origin", branch], ["git", "push", "origin", branch, flag]);
        }
        patterns.push(["git", "push", "origin", `+${branch}`], ["git", "push", "origin", `:${branch}`]);
      }
    }
    const decision = rule.decision === "deny" ? "forbidden" : "prompt";
    for (const pattern of patterns) {
      const key = JSON.stringify(pattern);
      if (prefixes.get(key)?.decision !== "forbidden") prefixes.set(key, { rule, decision });
    }
  }
  for (const [pattern, { rule, decision }] of prefixes) {
    lines.push(`prefix_rule(pattern = ${pattern}, decision = ${JSON.stringify(decision)}, justification = ${JSON.stringify(rule.title)})`);
  }
  return [...lines, ""].join("\n");
}

export function renderCodexShieldSummary(policy: ShieldPolicyConfig): string {
  const skill = renderGuardedTurboSkillMarkdown(policy);
  return skill.slice(skill.indexOf("# Guarded Turbo")) + [
    "",
    "Codex enforces the command prefixes in \`.codex/rules/t3-pilot-guarded-turbo.rules\`.",
    "Use \`t3-pilot shield check\` for path and regex checks, wildcard branch names and strict-mode shell decisions.",
    "",
  ].join("\n");
}
