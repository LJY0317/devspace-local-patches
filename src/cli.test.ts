import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const serveRoot = mkdtempSync(join(tmpdir(), "devspace-cli-headless-serve-test-"));
try {
  const configDir = join(serveRoot, ".devspace");
  const stateDir = join(serveRoot, ".state");
  const worktreeRoot = join(serveRoot, "worktrees");
  const projectRoot = join(serveRoot, "project");
  mkdirSync(projectRoot, { recursive: true });

  const portProbe = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    portProbe.once("error", rejectListen);
    portProbe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = portProbe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    portProbe.close((error) => error ? rejectClose(error) : resolveClose());
  });

  const cliConfigEnv = writeTestDevspaceConfig(configDir, {
    server: {
      host: "127.0.0.1",
      port,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    },
    workspaces: { allowedRoots: [projectRoot], worktreeRoot },
    storage: { stateDir },
    ui: { enabled: false },
    skills: { enabled: false },
    logging: { level: "silent", requests: false, toolCalls: false },
  });

  const child = spawn("node", ["--import", tsxLoader, cliPath, "serve"], {
    cwd: projectRoot,
    env: { ...process.env, ...cliConfigEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  try {
    let health: unknown;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`headless devspace serve exited before health check\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // Server startup can briefly race the first health request.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.deepEqual(health, { ok: true, name: "devspace" });

    assert.equal(child.kill("SIGTERM"), true);
    const exit = await Promise.race([
      childExit,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`headless devspace serve did not exit after SIGTERM\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 10_000);
      }),
    ]);
    assert.equal(exit.code, 0, `unexpected serve exit\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.equal(exit.signal, null);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await childExit;
  }
} finally {
  rmSync(serveRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const cliConfigEnv = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [projectRoot] },
    storage: { stateDir },
    subagents: { enabled: true, instructions: "on-demand", providers: [] },
  });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "effort: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
    }).id,
    { status: "idle", latestResponse: "Review complete.", providerSessionId: "provider_secret" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const daemonSocket = localAgentDaemonPaths(stateDir).endpoint;
  const daemonRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const daemon = createNetServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        method: string;
        params?: Record<string, unknown>;
      };
      daemonRequests.push(request);
      if (request.method === "agent.start") {
        socket.end(encodeLocalAgentDaemonResponse({
          requestId: request.requestId,
          protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
          ok: false,
          error: {
            code: "UNKNOWN_TARGET",
            message: "Unknown subagent profile or provider: missing.",
            retryable: false,
            target: "missing",
          },
        }));
        return;
      }
      const result = request.method === "agent.list"
        ? [current]
        : request.method === "agent.get"
          ? current
          : request.method === "agent.wait"
            ? [
                { id: current.id, status: "completed", response: "Review complete." },
                { id: other.id, status: "running", wait: "timeout" },
              ]
        : request.method === "hello"
          ? {
              status: {
                state: "ready",
                protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
                pid: process.pid,
                endpoint: daemonSocket,
                startedAt: "now",
                activeTurns: 0,
                runtimeCount: 0,
                clientConnections: 1,
              },
              configMatches: true,
            }
          : null;
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        ok: true,
        result,
      }));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    daemon.once("error", rejectListen);
    daemon.listen(daemonSocket, resolveListen);
  });

  try {
    const { stdout: output } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...cliConfigEnv,
        DEVSPACE_WORKSPACE_ID: "ws_current",
        DEVSPACE_WORKSPACE_ROOT: projectRoot,
      },
    });

    assert.equal(
      output.trim(),
      `<agent id="${current.id}" status="completed" target="reviewer"/>`,
    );

    const { stdout: jsonOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "ls", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    );
    assert.equal(
      jsonOutput,
      `${JSON.stringify([{ id: current.id, status: "completed", target: "reviewer" }])}\n`,
    );

    const { stdout: directOutput } = await execFileAsync(
      "node",
      ["--import", tsxLoader, cliPath, "agents", "ls"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "",
          DEVSPACE_WORKSPACE_ROOT: stateDir,
        },
      },
    );
    assert.match(directOutput, new RegExp(current.id));
    const directList = [...daemonRequests].reverse().find((request) => request.method === "agent.list");
    assert.deepEqual(directList?.params, { workspaceRoot: realpathSync.native(projectRoot) });

    const { stdout: showOutput } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "agents", "show", current.id],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    );
    assert.equal(
      showOutput,
      `<agent id="${current.id}" status="completed">Review complete.</agent>\n`,
    );
    assert.equal(
      daemonRequests.filter((request) => request.method === "agent.get").length,
      1,
      "show must be an immediate snapshot",
    );

    const { stdout: waitOutput } = await execFileAsync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "agents",
        "wait",
        current.id,
        other.id,
        "--timeout",
        "0",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...cliConfigEnv,
          DEVSPACE_WORKSPACE_ID: "ws_current",
          DEVSPACE_WORKSPACE_ROOT: projectRoot,
        },
      },
    );
    assert.equal(
      waitOutput,
      [
        `<agent id="${current.id}" status="completed">Review complete.</agent>`,
        `<agent id="${other.id}" status="running" wait="timeout"/>`,
        "",
      ].join("\n"),
    );
    const waitRequest = daemonRequests.find((request) => request.method === "agent.wait");
    assert.deepEqual(waitRequest?.params, {
      ids: [current.id, other.id],
      scope: { workspaceId: "ws_current", workspaceRoot: realpathSync.native(projectRoot) },
      timeoutMs: 0,
    });

    let commandFailure: unknown;
    try {
      await execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "--json", "inspect"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
          },
        },
      );
    } catch (error) {
      commandFailure = error;
    }
    assert.ok(commandFailure, "structured CLI errors should exit non-zero");
    const stdout = (commandFailure as { stdout?: string }).stdout ?? "";
    const payload = JSON.parse(stdout) as {
      error: { code: string; message: string; retryable: boolean; target: string };
    };
    assert.equal(payload.error.code, "UNKNOWN_TARGET");
    assert.equal(payload.error.retryable, false);
    assert.equal(payload.error.target, "missing");

    let xmlCommandFailure: unknown;
    try {
      await execFileAsync(
        "node",
        ["--import", "tsx", "src/cli.ts", "agents", "run", "missing", "inspect"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
          },
        },
      );
    } catch (error) {
      xmlCommandFailure = error;
    }
    assert.ok(xmlCommandFailure, "XML CLI errors should exit non-zero");
    assert.equal(
      (xmlCommandFailure as { stderr?: string }).stderr,
      '<error code="UNKNOWN_TARGET" retryable="false">Unknown subagent profile or provider: missing.</error>\n',
    );

    await assert.rejects(
      execFileAsync(
        "node",
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "agents",
          "run",
          "codex",
          "--model",
          "--unknown",
          "inspect",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...cliConfigEnv,
            DEVSPACE_WORKSPACE_ID: "ws_current",
            DEVSPACE_WORKSPACE_ROOT: projectRoot,
          },
        },
      ),
      (error: unknown) => {
        assert.equal(
          (error as { stderr?: string }).stderr,
          '<error code="AGENT_COMMAND_ERROR" retryable="false">Unknown option: --unknown. Use -- before prompt text that starts with a dash.</error>\n',
        );
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      daemon.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  assert.equal(loadConfig(cliConfigEnv).subagents.enabled, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
