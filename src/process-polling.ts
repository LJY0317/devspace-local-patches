import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
  type WriteStdinInput,
} from "./process-sessions.js";

export const PROGRESS_POLL_SLICE_MS = 8_000;
export const PROGRESS_POLL_MAX_WAIT_MS = 30_000;

interface ProcessSessionPoller {
  write(input: WriteStdinInput): Promise<ProcessSnapshot>;
}

export interface ProcessPollProgressContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

export interface ProcessPollResult {
  snapshot: ProcessSnapshot;
  mode: "single" | "progress";
  progressHeartbeats: number;
}

interface ProcessPollOptions {
  sliceMs?: number;
  maxWaitMs?: number;
}

function isInteractivePoll(input: WriteStdinInput): boolean {
  return (input.chars ?? "").length > 0
    || input.columns !== undefined
    || input.rows !== undefined;
}

/**
 * Coalesce quiet process polling only when the MCP caller supplied a progress
 * token. Each individual process wait remains below the host-facing 12 second
 * ceiling; progress notifications keep a modern MCP response active between
 * waits. Explicit yield windows and interactive writes preserve the upstream
 * one-shot behavior exactly.
 */
export async function pollProcessSession(
  processSessions: ProcessSessionPoller,
  input: WriteStdinInput,
  progress: ProcessPollProgressContext,
  options: ProcessPollOptions = {},
): Promise<ProcessPollResult> {
  const canCoalesce = input.yieldTimeMs === undefined
    && !isInteractivePoll(input)
    && progress.progressToken !== undefined
    && progress.sendNotification !== undefined;

  if (!canCoalesce) {
    return {
      snapshot: await processSessions.write(input),
      mode: "single",
      progressHeartbeats: 0,
    };
  }

  const sliceMs = Math.max(
    1,
    Math.min(Math.floor(options.sliceMs ?? PROGRESS_POLL_SLICE_MS), MAX_PROCESS_YIELD_MS),
  );
  const maxWaitMs = Math.max(sliceMs, Math.floor(options.maxWaitMs ?? PROGRESS_POLL_MAX_WAIT_MS));
  const startedAt = performance.now();
  let progressHeartbeats = 0;

  while (true) {
    const elapsedBeforeWait = performance.now() - startedAt;
    const remainingMs = Math.max(1, maxWaitMs - elapsedBeforeWait);
    const snapshot = await processSessions.write({
      ...input,
      yieldTimeMs: Math.min(sliceMs, remainingMs),
    });

    if (!snapshot.running || snapshot.output || progress.signal?.aborted) {
      return { snapshot, mode: "progress", progressHeartbeats };
    }

    if (performance.now() - startedAt >= maxWaitMs) {
      return { snapshot, mode: "progress", progressHeartbeats };
    }

    try {
      await progress.sendNotification!({
        method: "notifications/progress",
        params: {
          progressToken: progress.progressToken!,
          progress: snapshot.wallTimeMs,
          message: `Process still running (${Math.max(1, Math.round(snapshot.wallTimeMs / 1_000))}s elapsed).`,
        },
      });
      progressHeartbeats += 1;
    } catch {
      // A notification failure may mean the client cannot consume progress or
      // the response path is already unhealthy. Fall back to the ordinary
      // snapshot instead of extending the request or failing the process tool.
      return { snapshot, mode: "progress", progressHeartbeats };
    }
  }
}
