import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  inspectProcessLiveness,
  readProcessStartIdentity,
  resolveShellCommand,
  terminateProcessTree,
  type ProcessLiveness,
} from "./process-platform.js";
import {
  newProcessOperationId,
  ProcessOperationExistsError,
  type ProcessOperationRecord,
  type ProcessOperationState,
  type ProcessOperationStore,
} from "./process-operations.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
export const MAX_PROCESS_YIELD_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
export const DEFAULT_COMPLETED_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  operationId?: string;
  requestId?: string;
  rpcId?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: number;
  operationId: string;
  serverInstanceId: string;
  pid?: number;
  processStartIdentity?: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
}

export interface ProcessLifecycleEvent {
  phase: "started" | "settled";
  operationId: string;
  serverInstanceId: string;
  sessionId: number;
  workspaceId: string;
  requestId?: string;
  rpcId?: string;
  pid?: number;
  processStartIdentity?: string;
  wallTimeMs: number;
  exitCode?: number;
  signal?: string;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  operationId: string;
  serverInstanceId: string;
  workspaceId: string;
  requestId?: string;
  rpcId?: string;
  process?: ManagedProcess;
  pid?: number;
  processStartIdentity?: string;
  startedAt: number;
  endedAt?: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  serverInstanceId?: string;
  operationStore?: ProcessOperationStore;
  processIdentityReader?: (pid: number) => string | undefined;
  shutdownGraceMs?: number;
  onProvenanceError?: (error: unknown, operationId: string) => void;
  onLifecycleEvent?: (event: ProcessLifecycleEvent) => void;
}

export interface ProcessOperationStatus {
  operationId: string;
  serverInstanceId: string;
  sessionId: number;
  workspaceId: string;
  pid?: number;
  processStartIdentity?: string;
  state: ProcessOperationState;
  liveness: ProcessLiveness;
  ioAvailable: boolean;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly sessionsByOperation = new Map<string, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private readonly serverInstanceId: string;
  private readonly operationStore?: ProcessOperationStore;
  private readonly processIdentityReader: (pid: number) => string | undefined;
  private readonly shutdownGraceMs: number;
  private readonly onProvenanceError?: (error: unknown, operationId: string) => void;
  private readonly onLifecycleEvent?: (event: ProcessLifecycleEvent) => void;
  private nextSessionId = 1;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? DEFAULT_COMPLETED_SESSION_TTL_MS;
    this.serverInstanceId = options.serverInstanceId ?? randomUUID();
    this.operationStore = options.operationStore;
    this.processIdentityReader = options.processIdentityReader ?? readProcessStartIdentity;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000;
    this.onProvenanceError = options.onProvenanceError;
    this.onLifecycleEvent = options.onLifecycleEvent;
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    const operationId = input.operationId ?? newProcessOperationId();
    if (input.operationId && this.sessionsByOperation.has(operationId)) {
      throw new ProcessOperationExistsError(operationId);
    }
    const operation = this.operationStore?.reserve({
      operationId,
      serverInstanceId: this.serverInstanceId,
      requestId: input.requestId,
      rpcId: input.rpcId,
      workspaceId: input.workspaceId,
    });
    const session = this.createSession(input, operationId, operation?.sessionId);
    this.sessions.set(session.id, session);
    this.sessionsByOperation.set(session.operationId, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else await this.startPipe(session, input);
    } catch (error) {
      this.removeSession(session.id);
      this.safeStoreUpdate(operationId, () => this.operationStore?.markSpawnFailed(operationId));
      throw error;
    }

    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_PROCESS_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, MAX_PROCESS_YIELD_MS);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  status(workspaceId: string, operationId: string): ProcessOperationStatus {
    const session = this.sessionsByOperation.get(operationId);
    if (session) {
      if (session.workspaceId !== workspaceId) {
        throw new Error(`Process operation ${operationId} does not belong to workspace ${workspaceId}.`);
      }
      return {
        operationId,
        serverInstanceId: session.serverInstanceId,
        sessionId: session.id,
        workspaceId,
        pid: session.pid,
        processStartIdentity: session.processStartIdentity,
        state: session.running ? "running" : session.signal ? "signaled" : "exited",
        liveness: session.running ? "alive" : "not_running",
        ioAvailable: true,
        startedAt: new Date(session.startedAt).toISOString(),
        updatedAt: new Date(session.endedAt ?? Date.now()).toISOString(),
        endedAt: session.endedAt === undefined ? undefined : new Date(session.endedAt).toISOString(),
        exitCode: session.exitCode,
        signal: session.signal,
      };
    }

    const record = this.operationStore?.get(operationId);
    if (!record) throw new Error(`Unknown process operation: ${operationId}`);
    if (record.workspaceId !== workspaceId) {
      throw new Error(`Process operation ${operationId} does not belong to workspace ${workspaceId}.`);
    }

    const terminal = isTerminalOperationState(record.state);
    let liveness: ProcessLiveness = terminal
      ? "not_running"
      : inspectProcessLiveness(record.pid, record.processStartIdentity, this.processIdentityReader);
    if (!terminal && liveness !== "alive") {
      this.safeStoreUpdate(operationId, () => this.operationStore?.markUnknown(operationId));
    }
    const refreshed = this.operationStore?.get(operationId) ?? record;
    if (isTerminalOperationState(refreshed.state)) liveness = "not_running";
    return statusFromRecord(refreshed, liveness, false);
  }

  async shutdown(): Promise<void> {
    const runningSessions = Array.from(this.sessions.values()).filter((session) => session.running);
    for (const session of runningSessions) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      this.safeStoreUpdate(
        session.operationId,
        () => this.operationStore?.markShutdownRequested(session.operationId),
      );
      session.process?.kill("SIGTERM");
    }

    await Promise.all(runningSessions.map((session) => this.waitForExit(session, this.shutdownGraceMs)));
    for (const session of runningSessions) {
      if (session.running) {
        // We own the original process, but after the grace window we no longer
        // know whether termination will complete before server exit. Preserve
        // that uncertainty rather than claiming the process stopped.
        this.safeStoreUpdate(session.operationId, () => this.operationStore?.markUnknown(session.operationId));
      }
    }
    for (const sessionId of Array.from(this.sessions.keys())) this.removeSession(sessionId);
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(
    input: StartCommandInput,
    operationId: string,
    reservedSessionId?: number,
  ): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: reservedSessionId ?? this.nextSessionId++,
      operationId,
      serverInstanceId: this.serverInstanceId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      rpcId: input.rpcId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitPromise,
      resolveExit,
    };
  }

  private async startPipe(session: ProcessSession, input: StartCommandInput): Promise<void> {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    let trackProcessClose = false;
    child.stdout.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.append(session, data.toString("utf8")));
    // Keep an error listener for the lifetime of the ChildProcess. In
    // particular, ENOENT for an invalid cwd or shell is emitted asynchronously
    // after spawn() returns; without a listener it can become an unhandled
    // EventEmitter error and affect the server process.
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => {
      if (trackProcessClose) this.finish(session, code ?? undefined, signal ?? undefined);
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    if (!child.pid) throw new Error("Spawned process did not provide a PID after the spawn event.");
    trackProcessClose = true;
    session.pid = child.pid;
    session.processStartIdentity = this.safeReadProcessIdentity(child.pid, session.operationId);

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    this.safeStoreUpdate(
      session.operationId,
      () => this.operationStore?.markRunning(session.operationId, child.pid!, session.processStartIdentity),
    );
    this.emitLifecycleEvent(session, "started");
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.pid = pty.pid;
    session.processStartIdentity = this.safeReadProcessIdentity(pty.pid, session.operationId);

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    this.safeStoreUpdate(
      session.operationId,
      () => this.operationStore?.markRunning(session.operationId, pty.pid, session.processStartIdentity),
    );
    this.emitLifecycleEvent(session, "started");
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = Date.now();
    this.safeStoreUpdate(
      session.operationId,
      () => this.operationStore?.markFinished(session.operationId, exitCode, signal),
    );
    this.emitLifecycleEvent(session, "settled");
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.removeSession(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);

    return {
      sessionId: session.running ? session.id : undefined,
      operationId: session.operationId,
      serverInstanceId: session.serverInstanceId,
      pid: session.pid,
      processStartIdentity: session.processStartIdentity,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
    if (session) this.sessionsByOperation.delete(session.operationId);
  }

  private safeReadProcessIdentity(pid: number, operationId: string): string | undefined {
    try {
      return this.processIdentityReader(pid);
    } catch (error) {
      this.onProvenanceError?.(error, operationId);
      return undefined;
    }
  }

  private safeStoreUpdate(operationId: string, update: () => void): void {
    try {
      update();
    } catch (error) {
      this.onProvenanceError?.(error, operationId);
    }
  }

  private emitLifecycleEvent(session: ProcessSession, phase: ProcessLifecycleEvent["phase"]): void {
    if (!this.onLifecycleEvent) return;
    try {
      this.onLifecycleEvent({
        phase,
        operationId: session.operationId,
        serverInstanceId: session.serverInstanceId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        requestId: session.requestId,
        rpcId: session.rpcId,
        pid: session.pid,
        processStartIdentity: session.processStartIdentity,
        wallTimeMs: Date.now() - session.startedAt,
        exitCode: session.exitCode,
        signal: session.signal,
      });
    } catch {
      // Diagnostics must never change process lifecycle behavior.
    }
  }
}

export { ProcessOperationExistsError };

function isTerminalOperationState(state: ProcessOperationState): boolean {
  return state === "exited" || state === "signaled" || state === "spawn_failed";
}

function statusFromRecord(
  record: ProcessOperationRecord,
  liveness: ProcessLiveness,
  ioAvailable: boolean,
): ProcessOperationStatus {
  return {
    operationId: record.operationId,
    serverInstanceId: record.serverInstanceId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    pid: record.pid,
    processStartIdentity: record.processStartIdentity,
    state: record.state,
    liveness,
    ioAvailable,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
  };
}
