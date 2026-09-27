import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const PROCESS_OPERATION_TERMINAL_RETENTION_HOURS = 24;
export const PROCESS_OPERATION_TERMINAL_RETENTION_MS =
  PROCESS_OPERATION_TERMINAL_RETENTION_HOURS * 60 * 60 * 1_000;
export const PROCESS_OPERATION_MAX_RECORDS = 10_000;

export type ProcessOperationState =
  | "starting"
  | "running"
  | "shutdown_requested"
  | "exited"
  | "signaled"
  | "spawn_failed"
  | "unknown";

export interface ProcessOperationRecord {
  operationId: string;
  sessionId: number;
  serverInstanceId: string;
  requestId?: string;
  rpcId?: string;
  workspaceId: string;
  pid?: number;
  processStartIdentity?: string;
  state: ProcessOperationState;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
}

interface ProcessOperationRow {
  operation_id: string;
  session_id: number;
  server_instance_id: string;
  request_id: string | null;
  rpc_id: string | null;
  workspace_id: string;
  pid: number | null;
  process_start_identity: string | null;
  state: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
}

export class ProcessOperationExistsError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Process operation ${operationId} is still retained. Query process_status instead of starting it again.`,
    );
    this.name = "ProcessOperationExistsError";
  }
}

export class ProcessOperationCapacityError extends Error {
  constructor(readonly maxRecords: number) {
    super(
      `Process operation registry is full at ${maxRecords} protected records. No new process was started; unresolved and unexpired idempotency records were preserved.`,
    );
    this.name = "ProcessOperationCapacityError";
  }
}

export interface ProcessOperationStoreOptions {
  terminalRetentionMs?: number;
  maxRecords?: number;
  now?: () => Date;
}

export interface ProcessOperationStore {
  reserve(input: {
    operationId: string;
    serverInstanceId: string;
    requestId?: string;
    rpcId?: string;
    workspaceId: string;
  }): ProcessOperationRecord;
  get(operationId: string): ProcessOperationRecord | undefined;
  markRunning(operationId: string, pid: number, processStartIdentity?: string): void;
  markShutdownRequested(operationId: string): void;
  markFinished(operationId: string, exitCode?: number, signal?: string): void;
  markSpawnFailed(operationId: string): void;
  markUnknown(operationId: string): void;
  close(): void;
}

export function processOperationDatabasePath(stateDir: string): string {
  return join(stateDir, "process-operations.sqlite");
}

export function createProcessOperationStore(
  stateDir: string,
  options: ProcessOperationStoreOptions = {},
): ProcessOperationStore {
  const terminalRetentionMs =
    options.terminalRetentionMs ?? PROCESS_OPERATION_TERMINAL_RETENTION_MS;
  const maxRecords = options.maxRecords ?? PROCESS_OPERATION_MAX_RECORDS;
  const now = options.now ?? (() => new Date());
  if (!Number.isFinite(terminalRetentionMs) || terminalRetentionMs < 0) {
    throw new Error("Process operation terminal retention must be a non-negative finite duration.");
  }
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
    throw new Error("Process operation record limit must be a positive integer.");
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = processOperationDatabasePath(stateDir);
  const sqlite = new Database(path);
  chmodSync(path, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(`
    create table if not exists process_operations (
      session_id integer primary key autoincrement,
      operation_id text not null unique,
      server_instance_id text not null,
      request_id text,
      rpc_id text,
      workspace_id text not null,
      pid integer,
      process_start_identity text,
      state text not null,
      started_at text not null,
      updated_at text not null,
      ended_at text,
      exit_code integer,
      signal text
    );
    create index if not exists process_operations_workspace_updated_idx
      on process_operations(workspace_id, updated_at desc);
  `);
  const sequence = sqlite
    .prepare("select seq from sqlite_sequence where name = 'process_operations'")
    .get() as { seq: number } | undefined;
  if (!sequence) {
    // Legacy in-memory sessions started at 1 on every server boot. Start the
    // persistent namespace well above that range so activation itself does not
    // make an old small session ID likely to address a new process.
    sqlite.prepare("insert into sqlite_sequence(name, seq) values ('process_operations', ?)")
      .run(1_000_000_000);
  }

  const reserveStatement = sqlite.prepare(`
    insert into process_operations (
      operation_id, server_instance_id, request_id, rpc_id, workspace_id,
      state, started_at, updated_at
    ) values (?, ?, ?, ?, ?, 'starting', ?, ?)
  `);
  const getStatement = sqlite.prepare(`
    select operation_id, session_id, server_instance_id, request_id, rpc_id,
      workspace_id, pid, process_start_identity, state, started_at, updated_at,
      ended_at, exit_code, signal
    from process_operations where operation_id = ?
  `);

  const get = (operationId: string): ProcessOperationRecord | undefined => {
    const row = getStatement.get(operationId) as ProcessOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  };

  const deleteExpiredTerminalStatement = sqlite.prepare(`
    delete from process_operations
    where state in ('exited', 'signaled', 'spawn_failed')
      and coalesce(ended_at, updated_at) < ?
  `);
  const countStatement = sqlite.prepare("select count(*) as count from process_operations");
  const pruneExpiredTerminal = (): void => {
    const cutoff = new Date(now().getTime() - terminalRetentionMs).toISOString();
    deleteExpiredTerminalStatement.run(cutoff);
  };
  const countRecords = (): number => {
    const row = countStatement.get() as { count: number };
    return row.count;
  };

  // Startup cleanup is deliberately terminal-only. Unresolved states remain
  // reserved regardless of age so an old starting/running/unknown operation
  // cannot silently become executable again after a server restart.
  pruneExpiredTerminal();

  const reserve = sqlite.transaction((input: {
    operationId: string;
    serverInstanceId: string;
    requestId?: string;
    rpcId?: string;
    workspaceId: string;
  }): ProcessOperationRecord => {
    pruneExpiredTerminal();
    if (get(input.operationId)) throw new ProcessOperationExistsError(input.operationId);
    if (countRecords() >= maxRecords) throw new ProcessOperationCapacityError(maxRecords);

    const timestamp = now().toISOString();
    try {
      reserveStatement.run(
        input.operationId,
        input.serverInstanceId,
        input.requestId ?? null,
        input.rpcId ?? null,
        input.workspaceId,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (isUniqueConstraint(error) && get(input.operationId)) {
        throw new ProcessOperationExistsError(input.operationId);
      }
      throw error;
    }
    const record = get(input.operationId);
    if (!record) throw new Error(`Failed to read reserved process operation ${input.operationId}.`);
    return record;
  });

  const update = (
    operationId: string,
    changes: Parameters<typeof updateRecord>[2],
  ): void => updateRecord(sqlite, operationId, changes, now().toISOString());

  return {
    reserve,
    get,
    markRunning(operationId, pid, processStartIdentity) {
      update(operationId, {
        state: "running",
        pid,
        processStartIdentity: processStartIdentity ?? null,
      });
    },
    markShutdownRequested(operationId) {
      update(operationId, { state: "shutdown_requested" });
    },
    markFinished(operationId, exitCode, signal) {
      const state: ProcessOperationState = signal ? "signaled" : "exited";
      update(operationId, {
        state,
        endedAt: now().toISOString(),
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      });
      pruneExpiredTerminal();
    },
    markSpawnFailed(operationId) {
      update(operationId, {
        state: "spawn_failed",
        endedAt: now().toISOString(),
      });
      pruneExpiredTerminal();
    },
    markUnknown(operationId) {
      update(operationId, {
        state: "unknown",
        endedAt: null,
        exitCode: null,
        signal: null,
      });
    },
    close() {
      sqlite.close();
    },
  };
}

export function newProcessOperationId(): string {
  return randomUUID();
}

function updateRecord(
  sqlite: Database.Database,
  operationId: string,
  changes: {
    state: ProcessOperationState;
    pid?: number;
    processStartIdentity?: string | null;
    endedAt?: string | null;
    exitCode?: number | null;
    signal?: string | null;
  },
  updatedAt: string,
): void {
  const assignments = ["state = ?", "updated_at = ?"];
  const values: unknown[] = [changes.state, updatedAt];
  if (changes.pid !== undefined) {
    assignments.push("pid = ?");
    values.push(changes.pid);
  }
  if (changes.processStartIdentity !== undefined) {
    assignments.push("process_start_identity = ?");
    values.push(changes.processStartIdentity);
  }
  if (changes.endedAt !== undefined) {
    assignments.push("ended_at = ?");
    values.push(changes.endedAt);
  }
  if (changes.exitCode !== undefined) {
    assignments.push("exit_code = ?");
    values.push(changes.exitCode);
  }
  if (changes.signal !== undefined) {
    assignments.push("signal = ?");
    values.push(changes.signal);
  }
  values.push(operationId);
  sqlite.prepare(`update process_operations set ${assignments.join(", ")} where operation_id = ?`).run(...values);
}

function rowToRecord(row: ProcessOperationRow): ProcessOperationRecord {
  const state = readState(row.state);
  return {
    operationId: row.operation_id,
    sessionId: row.session_id,
    serverInstanceId: row.server_instance_id,
    requestId: row.request_id ?? undefined,
    rpcId: row.rpc_id ?? undefined,
    workspaceId: row.workspace_id,
    pid: row.pid ?? undefined,
    processStartIdentity: row.process_start_identity ?? undefined,
    state,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
  };
}

function readState(value: string): ProcessOperationState {
  if (
    value === "starting"
    || value === "running"
    || value === "shutdown_requested"
    || value === "exited"
    || value === "signaled"
    || value === "spawn_failed"
    || value === "unknown"
  ) return value;
  return "unknown";
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
