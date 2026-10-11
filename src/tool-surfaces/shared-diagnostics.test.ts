import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../config.js";
import type { LoggingConfig } from "../logger.js";
import { logFailedToolResponse, logToolCall } from "./shared.js";

test("tool logs keep fixed failure metadata without paths, working directories or tool output", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  const logging: LoggingConfig = {
    level: "info", format: "json", requests: true, toolCalls: true,
    shellCommands: false, assets: false, trustProxy: false,
  };
  const config = { logging } as ServerConfig;
  const privatePath = "/Users/private/work/profile-one";
  const privateCommand = "echo secret --token private123";
  logToolCall(config, { tool: "exec_command", success: false, durationMs: 7,
    path: privatePath, workingDirectory: privatePath,
    command: privateCommand,
    error: `private error includes ${privatePath} and ${privateCommand}`,
  });
  logFailedToolResponse(config, { tool: "read", path: privatePath }, [
    { type: "text", text: "private tool output about a secret" },
  ], performance.now());

  assert.equal(lines.length, 2);
  const rows = lines.map(line => JSON.parse(line));
  assert.equal(rows[0].failureClass, "tool_error_result");
  assert.equal(rows[0].pathPresent, true);
  assert.equal(rows[0].workingDirectoryPresent, true);
  assert.equal(rows[1].failureClass, "tool_error_result");
  assert.equal(rows[1].pathPresent, true);
  for (const line of lines) {
    assert.equal(line.includes(privatePath), false);
    assert.equal(line.includes(privateCommand), false);
    assert.equal(line.includes("private tool output"), false);
    assert.equal(line.includes("private error"), false);
  }
});
