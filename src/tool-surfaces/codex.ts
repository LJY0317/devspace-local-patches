import * as z from "zod/v4";
import { spawn } from "node:child_process";
import { applyPatch } from "../apply-patch.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessOperationStatus,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  PROCESS_OPERATION_MAX_RECORDS,
  PROCESS_OPERATION_TERMINAL_RETENTION_HOURS,
} from "../process-operations.js";
import { pollProcessSession } from "../process-polling.js";
import { requestTrace } from "../logger.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  logProcessSnapshot,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions from ${toolNames.openWorkspace}. Use ${toolNames.readMany} only for 2-8 already-known independent paths; use ${toolNames.read} when one result determines the next. Batch related read-only shell inspections, not unrelated writes. For exec_command calls that may change state or outlive one response, set operation_id first. After an uncertain response, check process_status before starting another command.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId} (operation ${snapshot.operationId}). Poll it with write_stdin using the same workspace_id and session_id. If the original response may have been lost and you supplied operation_id, query process_status with that operation_id instead of starting the command again.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    session_id: z.number().optional(),
    operation_id: z.string(),
    server_instance_id: z.string(),
    pid: z.number().int().positive().optional(),
    process_start_identity: z.string().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      session_id: snapshot.sessionId,
      operation_id: snapshot.operationId,
      server_instance_id: snapshot.serverInstanceId,
      pid: snapshot.pid,
      process_start_identity: snapshot.processStartIdentity,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
    },
  };
}

async function runPostPatchHook(
  command: string | undefined,
  cwd: string,
  files: Array<{ path: string; previousPath?: string; operation: string }>,
): Promise<string | undefined> {
  if (!command || !files.some((file) => file.path.toLowerCase().endsWith(".md"))) return undefined;

  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (output.length < 8_192) output += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", () => resolve(output.trim() || undefined));
    child.stdin.end(JSON.stringify({ cwd, files }));
  });
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style workspace file patch. The patch may add, update, delete, or move files, and all paths are relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const workspace = await workspaces.getWorkspace(workspaceId);
      const hookFeedback = await runPostPatchHook(config.postPatchHook, workspace.root, applied.files);
      const result = [
        `Applied patch to ${applied.files.length} file(s): ${paths}`,
        hookFeedback,
      ].filter(Boolean).join("\n");
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Run workspace command",
      description:
        "Run a shell command in the selected workspace using the operating-system permissions of the DevSpace process. The command itself determines what files, processes, or network resources it uses. Returns the result when it exits during the yield window; longer-running commands return a session_id that can be continued with write_stdin.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Command line to run in the selected workspace."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        operation_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            `Optional UUID that identifies this execution for deduplication and recovery. While its record is retained, the same ID refers to the existing execution rather than starting another one. Unresolved executions are retained; terminal records remain available for at least ${PROCESS_OPERATION_TERMINAL_RETENTION_HOURS} hours and may be pruned later. The registry holds up to ${PROCESS_OPERATION_MAX_RECORDS} retained records; at capacity, a new operation_id request returns without starting a process. After an uncertain response, query process_status before deciding whether a new execution is needed. Omit operation_id for an intentionally new execution.`,
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      cmd,
      tty,
      columns,
      rows,
      working_directory,
      operation_id,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const trace = requestTrace.getStore();
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            operationId: operation_id,
            requestId: trace?.requestId,
            rpcId: trace?.rpcId,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      logProcessSnapshot(config, {
        tool: "exec_command",
        workspaceId,
        snapshot,
      });

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Continue process",
      description:
        "Read new output from a process returned by exec_command and, when needed, send input or resize its terminal. For output-only polling, omit chars and usually omit yield_time_ms; on progress-capable MCP clients DevSpace coalesces quiet polling waits while keeping the response active. The standard interrupt character is \\u0003.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Optional input for the running process. Omit or pass an empty string for output-only polling.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Optional single-wait duration, maximum 12000. Omit for ordinary quiet polling so progress-capable clients can coalesce waits; clients without progress support fall back to the normal polling default.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      session_id,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }, extra) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const pollResult = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return pollProcessSession(
            processSessions,
            {
              workspaceId,
              sessionId,
              chars,
              columns,
              rows,
              yieldTimeMs,
              maxOutputTokens,
            },
            {
              signal: extra.signal,
              progressToken: extra._meta?.progressToken,
              sendNotification: extra.sendNotification,
            },
          );
        },
        (result) => processLogFields(result.snapshot),
      );
      const snapshot = pollResult.snapshot;

      logProcessSnapshot(config, {
        tool: "write_stdin",
        workspaceId,
        snapshot,
        pollMode: pollResult.mode,
        progressHeartbeats: pollResult.progressHeartbeats,
      });

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "process_status",
    {
      title: "Process status",
      description:
        `Query a retained execution by operation_id without starting or terminating anything. If the operation belongs to this live server instance and its session is still retained, io_available is true and write_stdin can continue it. After a server restart DevSpace may report OS liveness from PID/start identity, but stdin/stdout is not recovered and io_available remains false. Unresolved records are not age-pruned; terminal records are guaranteed for at least ${PROCESS_OPERATION_TERMINAL_RETENTION_HOURS} hours and may become unknown after later pruning.`,
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: z
          .string()
          .uuid()
          .describe("Operation identifier supplied to or returned by exec_command."),
      },
      outputSchema: processStatusOutputSchema(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, operation_id }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const status = await runLoggedToolOperation(
        config,
        { tool: "process_status", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.status(workspaceId, operation_id);
        },
      );
      return processStatusToolResponse(status);
    },
  );
}

function processStatusOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    operation_id: z.string(),
    server_instance_id: z.string(),
    session_id: z.number().int().positive(),
    pid: z.number().int().positive().optional(),
    process_start_identity: z.string().optional(),
    state: z.enum([
      "starting",
      "running",
      "shutdown_requested",
      "exited",
      "signaled",
      "spawn_failed",
      "unknown",
    ]),
    liveness: z.enum(["alive", "not_running", "pid_reused", "unknown"]),
    io_available: z.boolean(),
    started_at: z.string(),
    updated_at: z.string(),
    ended_at: z.string().optional(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
  });
}

function processStatusToolResponse(status: ProcessOperationStatus) {
  const io = status.ioAvailable
    ? ` Session I/O is available; continue with write_stdin using session_id ${status.sessionId}.`
    : " Session I/O is not available from this server instance; this status does not represent a recovered stdin/stdout session.";
  const result = `Operation ${status.operationId}: state=${status.state}, liveness=${status.liveness}, io_available=${status.ioAvailable}.${io}`;
  return {
    content: [textBlock(result)],
    structuredContent: {
      result,
      operation_id: status.operationId,
      server_instance_id: status.serverInstanceId,
      session_id: status.sessionId,
      pid: status.pid,
      process_start_identity: status.processStartIdentity,
      state: status.state,
      liveness: status.liveness,
      io_available: status.ioAvailable,
      started_at: status.startedAt,
      updated_at: status.updatedAt,
      ended_at: status.endedAt,
      exit_code: status.exitCode,
      signal: status.signal,
    },
  };
}

export function processLogFields<T extends Pick<ProcessSnapshot, "sessionId" | "running" | "exitCode" | "signal">>(
  result: T,
): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
