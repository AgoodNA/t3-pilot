import { resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type {
  T3ProjectSnapshot, T3RunSnapshot, T3StateSnapshot, T3SubagentSnapshot, T3ThreadSnapshot,
} from "./types.js";

type Row = Record<string, SQLOutputValue>;

export function openReadOnlyT3Database(dbPath: string): DatabaseSync {
  const uri = pathToFileURL(resolve(dbPath));
  uri.search = "mode=ro";
  const db = new DatabaseSync(uri.href, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function select(db: DatabaseSync, table: string, columns: string[]): Row[] {
  // All table and column names are static identifiers declared by the inspector.
  const schema = db.prepare(`PRAGMA table_info(${table})`).all();
  if (schema.length === 0) return [];
  const available = new Set(schema.map((column) => column.name));
  const fields = columns.map((column) => available.has(column) ? column : `NULL AS ${column}`);
  return db.prepare(`SELECT ${fields.join(", ")} FROM ${table}`).all();
}

function nullable(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

const threadColumns = [
  "thread_id", "project_id", "title", "default_provider", "provider_instance_id", "runtime_mode", "interaction_mode",
  "created_at", "updated_at", "archived_at", "deleted_at", "payload_json", "latest_user_message_at",
];

function toThread(row: Row): T3ThreadSnapshot {
  return {
    threadId: nullable(row.thread_id) ?? "",
    projectId: nullable(row.project_id) ?? "",
    title: nullable(row.title) ?? "",
    defaultProvider: nullable(row.default_provider),
    providerInstanceId: nullable(row.provider_instance_id),
    runtimeMode: nullable(row.runtime_mode),
    interactionMode: nullable(row.interaction_mode),
    createdAt: nullable(row.created_at),
    updatedAt: nullable(row.updated_at),
    archivedAt: nullable(row.archived_at),
    deletedAt: nullable(row.deleted_at),
    payloadJson: nullable(row.payload_json),
    latestUserMessageAt: nullable(row.latest_user_message_at),
  };
}

export function inspectT3State(dbPath: string): T3StateSnapshot {
  const db = openReadOnlyT3Database(dbPath);
  try {
    db.exec("BEGIN"); // Keep ownership and run status on the same SQLite read snapshot.
    const projects: T3ProjectSnapshot[] = select(db, "projection_projects", [
      "project_id", "title", "workspace_root", "scripts_json",
    ]).map((row) => ({
      projectId: nullable(row.project_id) ?? "",
      title: nullable(row.title) ?? "",
      workspaceRoot: nullable(row.workspace_root) ?? "",
      scriptsJson: nullable(row.scripts_json),
    }));

    const threads = new Map<string, T3ThreadSnapshot>();
    for (const row of select(db, "projection_threads", threadColumns)) {
      const thread = toThread(row);
      threads.set(thread.threadId, thread);
    }
    for (const row of select(db, "orchestration_v2_projection_threads", threadColumns)) {
      const thread = toThread(row);
      const legacy = threads.get(thread.threadId);
      if (legacy?.latestUserMessageAt && (!thread.latestUserMessageAt
        || Date.parse(legacy.latestUserMessageAt) > Date.parse(thread.latestUserMessageAt))) {
        thread.latestUserMessageAt = legacy.latestUserMessageAt;
      }
      threads.set(thread.threadId, thread);
    }

    const runs: T3RunSnapshot[] = select(db, "orchestration_v2_projection_runs", [
      "run_id", "thread_id", "ordinal", "provider", "provider_instance_id", "status", "requested_at",
      "completed_at", "payload_json",
    ]).map((row) => ({
      runId: nullable(row.run_id) ?? "",
      threadId: nullable(row.thread_id) ?? "",
      ordinal: typeof row.ordinal === "number" ? row.ordinal : null,
      provider: nullable(row.provider) ?? "",
      providerInstanceId: nullable(row.provider_instance_id),
      status: nullable(row.status) ?? "",
      requestedAt: nullable(row.requested_at) ?? "",
      completedAt: nullable(row.completed_at),
      payloadJson: nullable(row.payload_json),
    }));

    const subagents: T3SubagentSnapshot[] = select(db, "orchestration_v2_projection_subagents", [
      "subagent_id", "thread_id", "child_thread_id", "origin", "status",
    ]).map((row) => ({
      subagentId: nullable(row.subagent_id) ?? "",
      threadId: nullable(row.thread_id) ?? "",
      childThreadId: nullable(row.child_thread_id),
      origin: nullable(row.origin),
      status: nullable(row.status),
    }));
    db.exec("COMMIT");
    return { projects, threads: [...threads.values()], runs, subagents };
  } finally {
    db.close();
  }
}
