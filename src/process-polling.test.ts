import assert from "node:assert/strict";
import test from "node:test";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ProcessSnapshot, WriteStdinInput } from "./process-sessions.js";
import { pollProcessSession } from "./process-polling.js";

function running(wallTimeMs: number, output = ""): ProcessSnapshot {
  return {
    sessionId: 7,
    operationId: "operation-7",
    serverInstanceId: "server-test",
    output,
    outputTruncated: false,
    running: true,
    wallTimeMs,
  };
}

function exited(wallTimeMs: number): ProcessSnapshot {
  return {
    operationId: "operation-7",
    serverInstanceId: "server-test",
    output: "done\n",
    outputTruncated: false,
    running: false,
    exitCode: 0,
    wallTimeMs,
  };
}

test("quiet progress-capable polls coalesce empty waits into one tool operation", async () => {
  const writes: WriteStdinInput[] = [];
  const snapshots = [running(8_000), running(16_000), exited(20_000)];
  const notifications: ProgressNotification[] = [];
  const processSessions = {
    async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
      writes.push(input);
      return snapshots.shift() ?? exited(20_000);
    },
  };

  const result = await pollProcessSession(
    processSessions,
    { workspaceId: "ws", sessionId: 7 },
    {
      progressToken: "progress-7",
      sendNotification: async (notification) => {
        notifications.push(notification);
      },
    },
    { sliceMs: 8, maxWaitMs: 100 },
  );

  assert.equal(result.mode, "progress");
  assert.equal(result.progressHeartbeats, 2);
  assert.equal(result.snapshot.running, false);
  assert.equal(writes.length, 3);
  assert.ok(writes.every((input) => input.yieldTimeMs === 8));
  assert.deepEqual(
    notifications.map((notification) => notification.params.progressToken),
    ["progress-7", "progress-7"],
  );
});

test("explicit yield windows preserve one-shot polling", async () => {
  const writes: WriteStdinInput[] = [];
  const processSessions = {
    async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
      writes.push(input);
      return running(12_000);
    },
  };

  const result = await pollProcessSession(
    processSessions,
    { workspaceId: "ws", sessionId: 7, yieldTimeMs: 12_000 },
    {
      progressToken: "progress-7",
      sendNotification: async () => undefined,
    },
  );

  assert.equal(result.mode, "single");
  assert.equal(result.progressHeartbeats, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.yieldTimeMs, 12_000);
});

test("interactive writes, PTY resize, and clients without progress preserve one-shot polling", async () => {
  const cases: Array<{
    input: WriteStdinInput;
    progressToken?: string;
    sendNotification?: (notification: ProgressNotification) => Promise<void>;
  }> = [
    {
      input: { workspaceId: "ws", sessionId: 7, chars: "x" },
      progressToken: "progress-7",
      sendNotification: async () => undefined,
    },
    {
      input: { workspaceId: "ws", sessionId: 7, columns: 120, rows: 30 },
      progressToken: "progress-7",
      sendNotification: async () => undefined,
    },
    {
      input: { workspaceId: "ws", sessionId: 7 },
      sendNotification: async () => undefined,
    },
    {
      input: { workspaceId: "ws", sessionId: 7 },
      progressToken: "progress-7",
    },
  ];

  for (const { input, progressToken, sendNotification } of cases) {
    const writes: WriteStdinInput[] = [];
    const processSessions = {
      async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
        writes.push(input);
        return running(250);
      },
    };
    const result = await pollProcessSession(
      processSessions,
      input,
      {
        progressToken,
        sendNotification,
      },
    );
    assert.equal(result.mode, "single");
    assert.equal(writes.length, 1);
  }
});

test("progress polling stops at the configured maximum wait", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const writes: WriteStdinInput[] = [];
  const notifications: ProgressNotification[] = [];
  const result = await pollProcessSession(
    {
      async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
        writes.push(input);
        now += input.yieldTimeMs ?? 0;
        return running(now);
      },
    },
    { workspaceId: "ws", sessionId: 7 },
    {
      progressToken: "progress-7",
      sendNotification: async (notification) => {
        notifications.push(notification);
      },
    },
    { sliceMs: 8, maxWaitMs: 20 },
  );

  assert.equal(result.mode, "progress");
  assert.equal(result.snapshot.running, true);
  assert.deepEqual(writes.map((input) => input.yieldTimeMs), [8, 8, 4]);
  assert.equal(result.progressHeartbeats, 2);
  assert.equal(notifications.length, 2);
});

test("progress polling returns as soon as intermediate output is available", async () => {
  const writes: WriteStdinInput[] = [];
  const notifications: ProgressNotification[] = [];
  const snapshots = [running(8_000), running(12_000, "partial output\n")];
  const result = await pollProcessSession(
    {
      async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
        writes.push(input);
        return snapshots.shift() ?? running(12_000, "partial output\n");
      },
    },
    { workspaceId: "ws", sessionId: 7 },
    {
      progressToken: "progress-7",
      sendNotification: async (notification) => {
        notifications.push(notification);
      },
    },
    { sliceMs: 8, maxWaitMs: 100 },
  );

  assert.equal(result.mode, "progress");
  assert.equal(result.snapshot.output, "partial output\n");
  assert.equal(writes.length, 2);
  assert.equal(result.progressHeartbeats, 1);
  assert.equal(notifications.length, 1);
});

test("progress polling returns after the active slice observes cancellation", async () => {
  const controller = new AbortController();
  let writes = 0;
  let notifications = 0;
  const result = await pollProcessSession(
    {
      async write(): Promise<ProcessSnapshot> {
        writes += 1;
        controller.abort();
        return running(8_000);
      },
    },
    { workspaceId: "ws", sessionId: 7 },
    {
      signal: controller.signal,
      progressToken: "progress-7",
      sendNotification: async () => {
        notifications += 1;
      },
    },
    { sliceMs: 8, maxWaitMs: 100 },
  );

  assert.equal(result.mode, "progress");
  assert.equal(result.snapshot.running, true);
  assert.equal(writes, 1);
  assert.equal(result.progressHeartbeats, 0);
  assert.equal(notifications, 0);
});

test("progress notification failure falls back without failing the process poll", async () => {
  let writes = 0;
  const result = await pollProcessSession(
    {
      async write(): Promise<ProcessSnapshot> {
        writes += 1;
        return running(8_000);
      },
    },
    { workspaceId: "ws", sessionId: 7 },
    {
      progressToken: "progress-7",
      sendNotification: async () => {
        throw new Error("client stopped accepting progress");
      },
    },
    { sliceMs: 8, maxWaitMs: 100 },
  );

  assert.equal(result.mode, "progress");
  assert.equal(result.progressHeartbeats, 0);
  assert.equal(result.snapshot.running, true);
  assert.equal(writes, 1);
});
