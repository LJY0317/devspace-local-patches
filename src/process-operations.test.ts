import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import test from "node:test";
import {
  createProcessOperationStore,
  processOperationDatabasePath,
  ProcessOperationCapacityError,
  ProcessOperationExistsError,
  PROCESS_OPERATION_TERMINAL_RETENTION_MS,
} from "./process-operations.js";
import { inspectProcessLiveness } from "./process-platform.js";
import { ProcessSessionManager } from "./process-sessions.js";

const node = JSON.stringify(process.execPath);

test("explicit operation IDs make response-loss retries observable without duplicate execution", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-op-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  const manager = new ProcessSessionManager({
    serverInstanceId: "server-response-loss",
    operationStore: store,
  });
  t.after(async () => {
    await manager.shutdown();
    store.close();
  });

  const operationId = "operation-response-loss";
  const started = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => {}, 250)"`,
    operationId,
    requestId: "request-a",
    rpcId: "rpc-a",
    yieldTimeMs: 5,
  });
  assert.equal(started.running, true);
  assert.equal(started.operationId, operationId);
  assert.ok(started.sessionId);

  // Treat the start result as if its transport response were lost. The caller
  // can query the operation it chose without issuing the command again.
  const status = manager.status("workspace-a", operationId);
  assert.equal(status.ioAvailable, true);
  assert.equal(status.liveness, "alive");
  assert.equal(status.sessionId, started.sessionId);
  const persisted = store.get(operationId);
  assert.equal(persisted?.requestId, "request-a");
  assert.equal(persisted?.rpcId, "rpc-a");

  await assert.rejects(
    manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "console.log('must-not-run')"`,
      operationId,
      yieldTimeMs: 5,
    }),
    (error: unknown) => error instanceof ProcessOperationExistsError,
  );
});

test("legacy in-memory session numbers can repeat across server-manager instances", async () => {
  const first = new ProcessSessionManager({ processIdentityReader: () => undefined });
  const second = new ProcessSessionManager({ processIdentityReader: () => undefined });
  try {
    const firstStart = await first.start({
      workspaceId: "workspace-legacy",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 100)"`,
      yieldTimeMs: 5,
    });
    const secondStart = await second.start({
      workspaceId: "workspace-legacy",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 100)"`,
      yieldTimeMs: 5,
    });
    assert.equal(firstStart.sessionId, 1);
    assert.equal(secondStart.sessionId, 1);
  } finally {
    await Promise.all([first.shutdown(), second.shutdown()]);
  }
});

test("a reserved operation with no trustworthy spawned process becomes unknown after restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-starting-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  const reserved = store.reserve({
    operationId: "operation-reserved-only",
    serverInstanceId: "server-before-spawn",
    requestId: "request-before-spawn",
    workspaceId: "workspace-a",
  });
  assert.equal(reserved.state, "starting");

  const restarted = new ProcessSessionManager({
    serverInstanceId: "server-after-spawn-gap",
    operationStore: store,
  });
  t.after(async () => {
    await restarted.shutdown();
    store.close();
  });

  const status = restarted.status("workspace-a", reserved.operationId);
  assert.equal(status.state, "unknown");
  assert.equal(status.liveness, "unknown");
  assert.equal(status.ioAvailable, false);
});

test("store reopen preserves running and unknown operations older than terminal retention", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-old-unresolved-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(nowMs);
  const original = createProcessOperationStore(stateDir, { now: clock });
  const running = original.reserve({
    operationId: "operation-old-running",
    serverInstanceId: "server-old",
    workspaceId: "workspace-old",
  });
  original.markRunning(running.operationId, 4242, "identity-old-running");
  const unknown = original.reserve({
    operationId: "operation-old-unknown",
    serverInstanceId: "server-old",
    workspaceId: "workspace-old",
  });
  original.markUnknown(unknown.operationId);
  original.close();

  nowMs += PROCESS_OPERATION_TERMINAL_RETENTION_MS + 60 * 60 * 1_000;
  const reopened = createProcessOperationStore(stateDir, { now: clock });
  t.after(() => reopened.close());
  assert.equal(reopened.get(running.operationId)?.state, "running");
  assert.equal(reopened.get(unknown.operationId)?.state, "unknown");
  await assert.rejects(
    async () => reopened.reserve({
      operationId: running.operationId,
      serverInstanceId: "server-new",
      workspaceId: "workspace-old",
    }),
    (error: unknown) => error instanceof ProcessOperationExistsError,
  );
  await assert.rejects(
    async () => reopened.reserve({
      operationId: unknown.operationId,
      serverInstanceId: "server-new",
      workspaceId: "workspace-old",
    }),
    (error: unknown) => error instanceof ProcessOperationExistsError,
  );
});

test("terminal operation IDs are reusable only after the retention window is expired and pruned", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-terminal-retention-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(nowMs);
  const operationId = "operation-terminal-retention";
  const store = createProcessOperationStore(stateDir, { now: clock });
  const record = store.reserve({
    operationId,
    serverInstanceId: "server-retention",
    workspaceId: "workspace-retention",
  });
  store.markFinished(record.operationId, 0);

  nowMs += PROCESS_OPERATION_TERMINAL_RETENTION_MS - 1;
  await assert.rejects(
    async () => store.reserve({
      operationId,
      serverInstanceId: "server-before-expiry",
      workspaceId: "workspace-retention",
    }),
    (error: unknown) => error instanceof ProcessOperationExistsError,
  );
  store.close();

  nowMs += 2;
  const reopened = createProcessOperationStore(stateDir, { now: clock });
  t.after(() => reopened.close());
  assert.equal(reopened.get(operationId), undefined);
  const reused = reopened.reserve({
    operationId,
    serverInstanceId: "server-after-expiry",
    workspaceId: "workspace-retention",
  });
  assert.equal(reused.state, "starting");
});

test("execution events prune expired terminal records without a server restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-event-prune-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const store = createProcessOperationStore(stateDir, {
    terminalRetentionMs: 10,
    maxRecords: 4,
    now: () => new Date(nowMs),
  });
  for (let index = 0; index < 40; index += 1) {
    const record = store.reserve({
      operationId: `operation-event-prune-${index}`,
      serverInstanceId: "server-event-prune",
      workspaceId: "workspace-event-prune",
    });
    store.markFinished(record.operationId, 0);
    nowMs += 11;
  }
  store.close();

  assert.ok(operationRowCount(processOperationDatabasePath(stateDir)) <= 4);
});

test("record capacity rejects new execution instead of evicting unresolved or unexpired records", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-capacity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir, { maxRecords: 2 });
  t.after(() => store.close());
  const running = store.reserve({
    operationId: "operation-capacity-running",
    serverInstanceId: "server-capacity",
    workspaceId: "workspace-capacity",
  });
  store.markRunning(running.operationId, 4242, "identity-capacity-running");
  const unknown = store.reserve({
    operationId: "operation-capacity-unknown",
    serverInstanceId: "server-capacity",
    workspaceId: "workspace-capacity",
  });
  store.markUnknown(unknown.operationId);

  await assert.rejects(
    async () => store.reserve({
      operationId: "operation-capacity-blocked",
      serverInstanceId: "server-capacity",
      workspaceId: "workspace-capacity",
    }),
    (error: unknown) => error instanceof ProcessOperationCapacityError,
  );
  assert.equal(operationRowCount(processOperationDatabasePath(stateDir)), 2);
});

test("graceful shutdown waits for owned synthetic processes to close", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-shutdown-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  const manager = new ProcessSessionManager({
    serverInstanceId: "server-shutdown",
    operationStore: store,
    shutdownGraceMs: 2_000,
  });
  t.after(() => store.close());

  const started = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    operationId: "operation-shutdown",
    yieldTimeMs: 5,
  });
  assert.equal(started.running, true);
  assert.ok(started.pid);
  assert.ok(started.processStartIdentity);

  await manager.shutdown();
  const record = store.get("operation-shutdown");
  assert.ok(record);
  assert.ok(record.state === "signaled" || record.state === "exited");
  assert.equal(
    inspectProcessLiveness(started.pid, started.processStartIdentity),
    "not_running",
  );
});

test("restart inspection does not recover I/O and persistent session IDs do not alias stale IDs", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const operationId = "operation-forced-server-loss";
  const processOperationsUrl = new URL("./process-operations.ts", import.meta.url).href;
  const processSessionsUrl = new URL("./process-sessions.ts", import.meta.url).href;
  const workerScript = `
    import { createProcessOperationStore } from ${JSON.stringify(processOperationsUrl)};
    import { ProcessSessionManager } from ${JSON.stringify(processSessionsUrl)};
    const store = createProcessOperationStore(${JSON.stringify(stateDir)});
    const manager = new ProcessSessionManager({ serverInstanceId: "synthetic-crash-server", operationStore: store });
    const node = JSON.stringify(process.execPath);
    const snapshot = await manager.start({
      workspaceId: "workspace-restart",
      cwd: process.cwd(),
      command: node + " -e \\"setInterval(() => {}, 1000)\\"",
      operationId: ${JSON.stringify(operationId)},
      requestId: "synthetic-request",
      rpcId: "synthetic-rpc-fingerprint",
      yieldTimeMs: 5,
    });
    process.stdout.write(JSON.stringify({
      operationId: snapshot.operationId,
      sessionId: snapshot.sessionId,
      pid: snapshot.pid,
      processStartIdentity: snapshot.processStartIdentity,
      running: snapshot.running,
    }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const worker = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", workerScript],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  });

  const firstLine = await readFirstLine(worker.stdout!);
  const workerStart = JSON.parse(firstLine) as {
    sessionId: number;
    pid: number;
    processStartIdentity?: string;
    running: boolean;
  };
  assert.equal(workerStart.running, true);
  assert.ok(workerStart.sessionId > 1_000_000_000);
  assert.ok(workerStart.pid > 0);
  assert.ok(workerStart.processStartIdentity);

  worker.kill("SIGKILL");
  await once(worker, "exit");

  const store = createProcessOperationStore(stateDir);
  const restarted = new ProcessSessionManager({
    serverInstanceId: "synthetic-restarted-server",
    operationStore: store,
  });
  t.after(async () => {
    await restarted.shutdown();
    store.close();
  });

  const afterRestart = restarted.status("workspace-restart", operationId);
  assert.equal(afterRestart.ioAvailable, false);
  if (process.platform === "darwin" || process.platform === "linux") {
    assert.equal(afterRestart.liveness, "alive");
  }

  const next = await restarted.start({
    workspaceId: "workspace-restart",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => {}, 250)"`,
    operationId: "operation-after-restart",
    yieldTimeMs: 5,
  });
  assert.equal(next.running, true);
  assert.notEqual(next.sessionId, workerStart.sessionId);
  await assert.rejects(
    restarted.write({
      workspaceId: "workspace-restart",
      sessionId: workerStart.sessionId,
      yieldTimeMs: 1,
    }),
    /Unknown process session/,
  );

  // Cleanup only the synthetic process whose PID/start identity was just
  // verified. Production restart inspection intentionally performs no kill.
  if (afterRestart.liveness === "alive" && afterRestart.pid) {
    try {
      if (process.platform === "win32") process.kill(afterRestart.pid, "SIGTERM");
      else process.kill(-afterRestart.pid, "SIGTERM");
    } catch {
      // It may have exited between observation and cleanup.
    }
    await waitUntilNotAlive(afterRestart.pid, afterRestart.processStartIdentity);
  }
});

test("PID identity mismatch is reported as reuse and never becomes an attached session", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-pid-reuse-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  const record = store.reserve({
    operationId: "operation-pid-reuse",
    serverInstanceId: "old-server",
    workspaceId: "workspace-a",
  });
  store.markRunning(record.operationId, 4242, "expected-start-identity");
  const manager = new ProcessSessionManager({
    serverInstanceId: "new-server",
    operationStore: store,
    processIdentityReader: () => "different-start-identity",
  });
  t.after(async () => {
    await manager.shutdown();
    store.close();
  });

  const status = manager.status("workspace-a", record.operationId);
  assert.equal(status.liveness, "pid_reused");
  assert.equal(status.ioAvailable, false);
  assert.equal(status.state, "unknown");
});

test("operation registry schema stores no command, output, environment, or path columns", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-size-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  for (let index = 0; index < 20; index += 1) {
    const record = store.reserve({
      operationId: `operation-size-${String(index).padStart(3, "0")}`,
      serverInstanceId: "server-size",
      requestId: `request-${index}`,
      rpcId: `rpc-${index}`,
      workspaceId: "workspace-size",
    });
    store.markRunning(record.operationId, 10_000 + index, `identity-${index}`);
    store.markFinished(record.operationId, 0);
  }
  store.close();
  const databasePath = processOperationDatabasePath(stateDir);
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const columns = sqlite.prepare("pragma table_info(process_operations)").all() as Array<{ name: string }>;
    const columnNames = columns.map(({ name }) => name).sort();
    assert.deepEqual(columnNames, [
      "ended_at",
      "exit_code",
      "operation_id",
      "pid",
      "process_start_identity",
      "request_id",
      "rpc_id",
      "server_instance_id",
      "session_id",
      "signal",
      "started_at",
      "state",
      "updated_at",
      "workspace_id",
    ]);
    assert.ok(columnNames.every((name) => !/(command|output|environment|cwd|path)/i.test(name)));
  } finally {
    sqlite.close();
  }
});

test("async pipe spawn failures stay spawn_failed, block retry, and do not poison later execution", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-process-spawn-failure-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createProcessOperationStore(stateDir);
  const manager = new ProcessSessionManager({
    serverInstanceId: "server-spawn-failure",
    operationStore: store,
  });
  t.after(async () => {
    await manager.shutdown();
    store.close();
  });

  const missingCwdOperation = "operation-missing-cwd";
  await assert.rejects(
    manager.start({
      workspaceId: "workspace-spawn-failure",
      cwd: join(stateDir, "does-not-exist"),
      command: `${node} -e "process.stdout.write('unreachable')"`,
      operationId: missingCwdOperation,
      yieldTimeMs: 5,
    }),
    /ENOENT|no such file or directory/i,
  );
  assert.equal(store.get(missingCwdOperation)?.state, "spawn_failed");
  await assert.rejects(
    manager.start({
      workspaceId: "workspace-spawn-failure",
      cwd: process.cwd(),
      command: `${node} -e "process.stdout.write('must-not-run')"`,
      operationId: missingCwdOperation,
      yieldTimeMs: 5,
    }),
    (error: unknown) => error instanceof ProcessOperationExistsError,
  );
  assert.equal(manager.status("workspace-spawn-failure", missingCwdOperation).state, "spawn_failed");

  const previousShell = process.env.SHELL;
  const badShellOperation = "operation-bad-shell";
  try {
    process.env.SHELL = join(stateDir, "missing", "zsh");
    await assert.rejects(
      manager.start({
        workspaceId: "workspace-spawn-failure",
        cwd: process.cwd(),
        command: "printf unreachable",
        operationId: badShellOperation,
        yieldTimeMs: 5,
      }),
      /ENOENT|no such file or directory/i,
    );
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
  assert.equal(store.get(badShellOperation)?.state, "spawn_failed");
  assert.equal(manager.status("workspace-spawn-failure", badShellOperation).state, "spawn_failed");

  const healthyOperation = "operation-after-spawn-failure";
  const healthy = await manager.start({
    workspaceId: "workspace-spawn-failure",
    cwd: process.cwd(),
    command: `${node} -e "process.stdout.write('ok')"`,
    operationId: healthyOperation,
    yieldTimeMs: 1_000,
  });
  assert.equal(healthy.running, false);
  assert.match(healthy.output, /ok/);
  const healthyStatus = manager.status("workspace-spawn-failure", healthyOperation);
  assert.equal(healthyStatus.state, "exited");
  assert.equal(healthyStatus.liveness, "not_running");
  assert.equal(healthyStatus.ioAvailable, false);
});

async function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`worker ended before reporting readiness: ${buffer}`));
    };
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

async function waitUntilNotAlive(pid: number, startIdentity?: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = inspectProcessLiveness(pid, startIdentity);
    if (state !== "alive") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`synthetic process ${pid} remained alive after cleanup`);
}

function operationRowCount(databasePath: string): number {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const row = sqlite.prepare("select count(*) as count from process_operations").get() as { count: number };
    return row.count;
  } finally {
    sqlite.close();
  }
}
