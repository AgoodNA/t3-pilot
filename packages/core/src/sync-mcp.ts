import type { CanonicalMcpServerSpec, SyncHarnessTarget } from "./types.js";

export type JsonHarness = Exclude<SyncHarnessTarget, "codex">;
export type McpServers = Record<string, CanonicalMcpServerSpec>;
type JsonObject = Record<string, unknown>;

const startMarker = "# >>> t3-pilot managed mcp start >>>";
const endMarker = "# <<< t3-pilot managed mcp end <<<";

function parseObject(value: unknown, source: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object in ${source}.`);
  }
  return value as JsonObject;
}

export function readCanonicalMcp(content: string | null): McpServers {
  if (content === null) return {};
  const config = parseObject(JSON.parse(content), ".t3-pilot/mcp.json");
  const servers = parseObject(config.mcpServers, ".t3-pilot/mcp.json mcpServers");
  return Object.fromEntries(Object.keys(servers).sort().map((id) => {
    const raw = parseObject(servers[id], `MCP server ${id}`);
    const { url, command, args, env } = raw;
    if (!id || /[\x00-\x1f\x7f]/.test(id) || Boolean(url) === Boolean(command)) {
      throw new Error(`MCP server ${id} must have an ID and either a URL or a command.`);
    }
    if (typeof url === "string" && url) return [id, { url }];
    if (typeof command !== "string" || !command || (args !== undefined
      && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")))) {
      throw new Error(`Invalid command or arguments for MCP server ${id}.`);
    }
    const vars = env === undefined ? undefined : parseObject(env, `MCP server ${id} environment`);
    if (vars && Object.values(vars).some((value) => typeof value !== "string")) {
      throw new Error(`Invalid environment value for MCP server ${id}.`);
    }
    return [id, {
      command,
      ...(args !== undefined && { args }),
      ...(vars && { env: Object.fromEntries(Object.keys(vars).sort().map((key) => [key, vars[key]])) }),
    }];
  })) as McpServers;
}

export function mergeJsonMcp(
  before: string | null, desired: McpServers, previouslyManaged: string[], harness: JsonHarness,
) {
  const existing = before === null ? {} : parseObject(JSON.parse(before), `${harness} MCP settings`);
  const existingServers = existing.mcpServers === undefined
    ? {} : parseObject(existing.mcpServers, `${harness} mcpServers`);
  const oldManaged = new Set(previouslyManaged);
  const nextServers = new Map(Object.entries(existingServers));
  const managed: string[] = [];
  const collisions: string[] = [];
  let changed = !Object.hasOwn(existing, "mcpServers");

  for (const id of oldManaged) {
    if (!Object.hasOwn(desired, id)) changed = nextServers.delete(id) || changed;
  }
  for (const [id, server] of Object.entries(desired)) {
    if (nextServers.has(id) && !oldManaged.has(id)) {
      collisions.push(id);
      continue;
    }
    const entry = harness === "claude-code" ? { type: server.url ? "http" : "stdio", ...server } : server;
    if (!nextServers.has(id) || JSON.stringify(nextServers.get(id)) !== JSON.stringify(entry)) {
      nextServers.set(id, entry);
      changed = true;
    }
    managed.push(id);
  }

  return {
    managed: managed.sort(),
    collisions,
    content: before !== null && !changed
      ? before
      : `${JSON.stringify({ ...existing, mcpServers: Object.fromEntries(nextServers) }, null, 2)}\n`,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlKeyPath(raw: string): string[] | null {
  const keys: string[] = [];
  let rest = raw.trim();
  const token = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/;
  while (rest) {
    const part = token.exec(rest)?.[0];
    if (!part) return null;
    if (part.startsWith('"')) {
      try {
        keys.push(JSON.parse(part.replace(/\\U([a-fA-F0-9]{8})/g, (_match, digits: string) =>
          JSON.stringify(String.fromCodePoint(Number.parseInt(digits, 16))).slice(1, -1))));
      } catch {
        return null;
      }
    } else {
      keys.push(part.startsWith("'") ? part.slice(1, -1) : part);
    }
    rest = rest.slice(part.length).trimStart();
    if (!rest) return keys;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
  }
  return null;
}

function tomlLines(content: string) {
  const statements: { text: string; start: number; end: number }[] = [];
  let multiline: string | null = null;
  let offset = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (multiline === null) statements.push({ text: line.trim(), start: offset, end: offset + line.length });
    offset += line.length;
    // Ignore table headers or marker comments inside multiline TOML string values.
    for (let index = 0; index < line.length; index++) {
      if (multiline) {
        if (multiline === '"""' && line[index] === "\\") { index++; continue; }
        if (line.startsWith(multiline, index)) {
          const quote = multiline[0];
          index += 2;
          while (line[index + 1] === quote) index++;
          multiline = null;
        }
        continue;
      }
      const quote = line[index];
      if (quote === "#") break;
      if (quote !== "'" && quote !== '"') continue;
      if (line.startsWith(quote.repeat(3), index)) {
        multiline = quote.repeat(3);
        index += 2;
        continue;
      }
      while (++index < line.length && line[index] !== quote) {
        if (quote === '"' && line[index] === "\\") index++;
      }
    }
  }
  return statements;
}

function userTomlServers(statements: ReturnType<typeof tomlLines>) {
  // Match delimiters only outside quoted keys.
  const header = /^(\[\[?)((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\]"'])+)\]\]?\s*(?:#.*)?$/;
  const assignment = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^="'#])+?)\s*=/;
  const ids = new Set<string>();
  let inlineRoot = false;
  let table: string[] = [];
  for (const { text } of statements) {
    const section = header.exec(text);
    if (section) {
      table = tomlKeyPath(section[2]!) ?? [];
      if (table[0] === "mcp_servers" && table[1] !== undefined) ids.add(table[1]);
      if (table.length === 1 && table[0] === "mcp_servers" && section[1] === "[[") inlineRoot = true;
      continue;
    }
    const entry = assignment.exec(text);
    if (!entry) continue;
    const keyPath = tomlKeyPath(entry[1]!);
    if (!keyPath) continue;
    const path = [...table, ...keyPath];
    if (path[0] !== "mcp_servers") continue;
    if (path[1] === undefined) inlineRoot = true;
    else ids.add(path[1]);
  }
  return { ids, inlineRoot };
}

export function renderCodexMcp(before: string, servers: McpServers) {
  const lines = tomlLines(before);
  const starts = lines.filter((line) => line.text === startMarker);
  const ends = lines.filter((line) => line.text === endMarker);
  const start = starts[0];
  const end = ends[0];
  if (starts.length > 1 || ends.length > 1 || Boolean(start) !== Boolean(end)
    || (start && end && start.start >= end.start)) {
    throw new Error("The Codex managed MCP markers are incomplete or out of order.");
  }

  const userStatements = start && end
    ? lines.filter(({ start: offset }) => offset < start.start || offset >= end.end)
    : lines;
  const { ids, inlineRoot } = userTomlServers(userStatements);
  const newline = /\r\n/.test(before) ? "\r\n" : "\n";
  const block: string[] = [];
  const collisions: string[] = [];
  for (const [id, server] of Object.entries(servers)) {
    if (inlineRoot || ids.has(id)) {
      collisions.push(id);
      continue;
    }
    if (block.length) block.push("");
    block.push(`[mcp_servers.${tomlKey(id)}]`);
    if (server.url) {
      block.push(`url = ${tomlString(server.url)}`);
    } else {
      block.push(`command = ${tomlString(server.command!)}`);
      if (server.args) block.push(`args = [${server.args.map(tomlString).join(", ")}]`);
      if (server.env) {
        const vars = Object.entries(server.env).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);
        block.push(`env = { ${vars.join(", ")} }`);
      }
    }
  }
  const rendered = block.length ? [startMarker, ...block, endMarker, ""].join(newline) : "";
  if (start && end) {
    return { content: before.slice(0, start.start) + rendered + before.slice(end.end), collisions };
  }
  if (!rendered) return { content: before, collisions };
  const separator = before && !before.endsWith("\n") ? newline : "";
  return { content: before + separator + rendered, collisions };
}
