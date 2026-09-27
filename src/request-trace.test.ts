import assert from "node:assert/strict";
import test from "node:test";
import {
  hostIdentityEvidence,
  logEvent,
  opaqueFingerprint,
  privateFingerprint,
  requestTrace,
  rpcIdFingerprint,
  traceTool,
  type LoggingConfig,
} from "./logger.js";
import { logProcessLifecycle, logProcessSnapshot } from "./tool-surfaces/shared.js";

test("concurrent tool logs retain HTTP identity without exposing raw RPC IDs", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };
  await Promise.all(["request-a", "request-b"].map((requestId) =>
    requestTrace.run({ requestId, logging }, () => traceTool("private-rpc-value", "read", async () => {
      await new Promise((resolve) => setTimeout(resolve, requestId === "request-a" ? 10 : 1));
      logEvent(logging, "info", "tool_call", { tool: "read", success: true });
    })),
  ));
  const entries = lines.map((line) => JSON.parse(line));
  for (const requestId of ["request-a", "request-b"]) {
    const events = entries.filter((entry) => entry.requestId === requestId);
    assert.deepEqual(events.map((entry) => entry.event), ["tool_started", "tool_call", "tool_settled"]);
    assert.equal(events[2]?.outcome, "completed");
    assert.equal(events[2]?.abortObserved, false);
    assert.ok(events.every((entry) => entry.rpcId === rpcIdFingerprint("private-rpc-value")));
  }
  assert.ok(!lines.join("").includes("private-rpc-value"));
  assert.equal(requestTrace.getStore(), undefined);
});

test("process snapshot logs retain request identity and expose timing without process output", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };

  await requestTrace.run({ requestId: "request-process", logging, rpcId: "rpc-fingerprint" }, async () => {
    logProcessSnapshot({ logging }, {
      tool: "exec_command",
      workspaceId: "workspace-1",
      snapshot: {
        operationId: "operation-test",
        serverInstanceId: "server-test",
        pid: 12345,
        processStartIdentity: "darwin:test-start",
        output: "must-not-be-logged",
        outputTruncated: false,
        running: false,
        exitCode: 0,
        wallTimeMs: 37,
      },
    });
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "process_snapshot");
  assert.equal(entry.requestId, "request-process");
  assert.equal(entry.rpcId, "rpc-fingerprint");
  assert.equal(entry.tool, "exec_command");
  assert.equal(entry.workspaceId, "workspace-1");
  assert.equal(entry.operationId, "operation-test");
  assert.equal(entry.serverInstanceId, "server-test");
  assert.equal(entry.pid, 12345);
  assert.equal(entry.processStartIdentity, "darwin:test-start");
  assert.equal(entry.processWallTimeMs, 37);
  assert.equal(entry.processRunning, false);
  assert.equal(entry.exitCode, 0);
  assert.equal(lines[0].includes("must-not-be-logged"), false);
});

test("async process lifecycle logs keep explicit originating request identity", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };

  logProcessLifecycle({ logging }, {
    phase: "settled",
    operationId: "operation-lifecycle",
    serverInstanceId: "server-lifecycle",
    sessionId: 12,
    workspaceId: "workspace-lifecycle",
    requestId: "origin-request",
    rpcId: "origin-rpc-fingerprint",
    pid: 4321,
    processStartIdentity: "darwin:opaque-start",
    wallTimeMs: 45_000,
    exitCode: 0,
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "process_settled");
  assert.equal(entry.requestId, "origin-request");
  assert.equal(entry.rpcId, "origin-rpc-fingerprint");
  assert.equal(entry.operationId, "operation-lifecycle");
  assert.equal(entry.processRunning, false);
  assert.equal(entry.processWallTimeMs, 45_000);
  assert.equal(entry.exitCode, 0);
});

test("tool trace records opaque scope and cancellation only while the request is active", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };
  const controller = new AbortController();
  await requestTrace.run({ requestId: "active", logging }, () => traceTool("raw-rpc", "read", async () => {
    controller.abort();
  }, { signal: controller.signal, sessionId: "raw-mcp-session", meta: { "openai/session": "raw-chat" } }));
  controller.abort();
  const entries = lines.map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.event), ["tool_started", "tool_abort_signalled", "tool_settled"]);
  assert.equal(entries[2]?.outcome, "completed");
  assert.equal(entries[2]?.abortObserved, true);
  assert.equal(entries[0]?.conversationScopeFingerprint, opaqueFingerprint("raw-chat"));
  assert.equal(entries[0]?.mcpSessionFingerprint, opaqueFingerprint("raw-mcp-session"));
  assert.equal(entries[0]?.signalPresent, true);
  assert.ok(!lines.join("").includes("raw-chat"));
  assert.ok(!lines.join("").includes("raw-rpc"));
});

test("abort callbacks retain request identity when cancellation is emitted outside the request context", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });

  const pending = requestTrace.run({ requestId: "external-abort", logging }, () =>
    traceTool("raw-external-rpc", "exec_command", async () => {
      started();
      await releasePromise;
    }, { signal: controller.signal }));
  await startedPromise;
  assert.equal(requestTrace.getStore(), undefined);
  controller.abort();
  release();
  await pending;

  const abort = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "tool_abort_signalled");
  assert.equal(abort?.requestId, "external-abort");
  assert.equal(abort?.rpcId, rpcIdFingerprint("raw-external-rpc"));
  assert.equal(abort?.tool, "exec_command");
  assert.ok(!lines.join("").includes("raw-external-rpc"));
});

test("failed tools settle with causal request identity and no error contents", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const logging: LoggingConfig = { level: "info", format: "json", requests: true, toolCalls: true, assets: false, shellCommands: false, trustProxy: false };
  await assert.rejects(() => requestTrace.run({ requestId: "failed-request", logging }, () =>
    traceTool("private-rpc", "read", async () => { throw new Error("private tool result"); })
  ));
  const entries = lines.map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((entry) => entry.event), ["tool_started", "tool_settled"]);
  assert.equal(entries[1]?.outcome, "failed");
  assert.equal(entries[1]?.requestId, "failed-request");
  assert.ok(!lines.join("").includes("private tool result"));
});

test("host identity evidence exposes only normalized signals and keyed pseudonyms", () => {
  const secret = "local-owner-secret";
  const evidence = hostIdentityEvidence({
    "openai/account_id": "acct-private-123",
    "x-user-id": "user-private-456",
    "openai/session": "conversation-private",
    organization: { id: "not-a-primitive" },
    arbitrary: "must-not-be-used",
  }, secret);

  assert.deepEqual(evidence.signals, ["account", "organization", "user"]);
  assert.equal(typeof evidence.fingerprint, "string");
  assert.equal(evidence.fingerprint?.length, 24);
  assert.equal(JSON.stringify(evidence).includes("acct-private-123"), false);
  assert.equal(JSON.stringify(evidence).includes("user-private-456"), false);
  assert.equal(JSON.stringify(evidence).includes("conversation-private"), false);
  assert.equal(
    evidence.fingerprint,
    hostIdentityEvidence({
      "x-user-id": "user-private-456",
      "openai/account_id": "acct-private-123",
      organization: { id: "not-a-primitive" },
    }, secret).fingerprint,
  );
  assert.notEqual(
    evidence.fingerprint,
    hostIdentityEvidence({ "openai/account_id": "acct-other" }, secret).fingerprint,
  );
});

test("host identity evidence does not confuse ordinary HTTP user-agent fields with account identity", () => {
  const evidence = hostIdentityEvidence({
    "user-agent": "Mozilla/5.0 private browser string",
    "sec-fetch-user": "?1",
    origin: "https://chatgpt.com",
  }, "local-owner-secret");
  assert.deepEqual(evidence, { signals: [] });
});

test("private fingerprints are keyed and do not expose the source identifier", () => {
  const first = privateFingerprint("oauth-client-private", "secret-a");
  assert.equal(first?.length, 24);
  assert.equal(first, privateFingerprint("oauth-client-private", "secret-a"));
  assert.notEqual(first, privateFingerprint("oauth-client-private", "secret-b"));
  assert.notEqual(first, privateFingerprint("oauth-client-other", "secret-a"));
  assert.equal(String(first).includes("oauth-client-private"), false);
});
