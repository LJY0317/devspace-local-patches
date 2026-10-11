import * as z from "zod/v4";
import { logEvent, commandPreview } from "../logger.js";
import type { ServerConfig } from "../config.js";
import type { ProcessLifecycleEvent, ProcessSnapshot } from "../process-sessions.js";
import {
  WORKSPACE_APP_URI,
  type DiffStats,
  type ToolContent,
  type ToolLogFields,
  type ToolWidgetDescriptorMeta,
} from "./types.js";

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export function workspaceAppDescriptorMeta(config: ServerConfig): ToolWidgetDescriptorMeta {
  if (!config.uiEnabled) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  // Tool failure strings, file paths and working directories can contain
  // arbitrary model/user data. Preserve only structural presence and result.
  // Shell command previews remain a separate explicit shellCommands opt-in.
  const { command, path, workingDirectory, error, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    ...(path === undefined ? {} : { pathPresent: true }),
    ...(workingDirectory === undefined ? {} : { workingDirectoryPresent: true }),
    ...(error === undefined ? {} : { failureClass: "tool_error_result" }),
    commandPreview:
      config.logging.shellCommands && command
        ? commandPreview(command)
        : undefined,
  });
}

export function logProcessSnapshot(
  config: Pick<ServerConfig, "logging">,
  fields: {
    tool: string;
    workspaceId: string;
    snapshot: ProcessSnapshot;
    pollMode?: "single" | "progress";
    progressHeartbeats?: number;
  },
): void {
  if (!config.logging.toolCalls) return;

  const { snapshot } = fields;
  logEvent(config.logging, "info", "process_snapshot", {
    tool: fields.tool,
    workspaceId: fields.workspaceId,
    operationId: snapshot.operationId,
    serverInstanceId: snapshot.serverInstanceId,
    sessionId: snapshot.sessionId,
    pid: snapshot.pid,
    processStartIdentity: snapshot.processStartIdentity,
    processRunning: snapshot.running,
    processWallTimeMs: snapshot.wallTimeMs,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    outputTruncated: snapshot.outputTruncated,
    pollMode: fields.pollMode,
    progressHeartbeats: fields.progressHeartbeats,
  });
}

export function logProcessLifecycle(
  config: Pick<ServerConfig, "logging">,
  event: ProcessLifecycleEvent,
): void {
  if (!config.logging.toolCalls) return;
  logEvent(config.logging, "info", `process_${event.phase}`, {
    requestId: event.requestId,
    rpcId: event.rpcId,
    workspaceId: event.workspaceId,
    operationId: event.operationId,
    serverInstanceId: event.serverInstanceId,
    sessionId: event.sessionId,
    pid: event.pid,
    processStartIdentity: event.processStartIdentity,
    processRunning: event.phase === "started",
    processWallTimeMs: event.wallTimeMs,
    exitCode: event.exitCode,
    signal: event.signal,
  });
}

export async function runLoggedToolOperation<T>(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  startedAt: number,
  operation: () => Promise<T>,
  resultFields?: (result: T) => Partial<ToolLogFields>,
): Promise<T> {
  try {
    const result = await operation();
    const resultMetadata = resultFields?.(result);
    logToolCall(config, {
      ...fields,
      ...resultMetadata,
      success: resultMetadata?.success ?? true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logToolCall(config, {
      ...fields,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  _content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    // Never inspect user-visible tool error text just to produce diagnostics.
    error: "tool_error_result",
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
