import type { Request } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";

export const DIAGNOSTIC_SCHEMA_REVISION = "2026-10-11-classified-failure-v2";

const HOST_IDENTITY_SIGNALS = [
  ["account", /(^|[/_.-])account([/_.-]|$)/i],
  ["user", /(^|[/_.-])user([/_.-]|$)/i],
  ["organization", /(^|[/_.-])(organization|org)([/_.-]|$)/i],
  ["tenant", /(^|[/_.-])tenant([/_.-]|$)/i],
  ["subject", /(^|[/_.-])(subject|sub)([/_.-]|$)/i],
] as const;

const NON_IDENTITY_KEYS = new Set([
  "user-agent",
  "sec-fetch-user",
]);

export const requestTrace = new AsyncLocalStorage<{
  requestId: string;
  logging: LoggingConfig;
  rpcId?: string;
}>();

// Correlate caller-controlled IDs without writing their contents to the log.
export function rpcIdFingerprint(id: unknown): string | undefined {
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return createHash("sha256").update(JSON.stringify(id)).digest("hex").slice(0, 24);
}

export function opaqueFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : undefined;
}

/** Return only the UTF-8 JSON byte size of a value; never return or log its contents. */
export function diagnosticSerializedBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch {
    return undefined;
  }
}

/** Closed host-side tool failure classification. No exception prose, stack,
 * request argument, local path or untrusted code is ever returned to logs. */
export function diagnosticToolFailureClass(error: unknown):
  "process_capacity" | "operation_conflict" | "aborted" | "timeout"
  | "permission_denied" | "transport_failure" | "tool_error_result"
  | "bad_file_descriptor" | "resource_exhausted" | "unknown" {
  try {
    if (!error || typeof error !== "object") return "unknown";
    const candidate = error as { readonly name?: unknown; readonly code?: unknown };
    if (candidate.name === "ProcessOperationCapacityError") return "process_capacity";
    if (candidate.name === "ProcessOperationExistsError") return "operation_conflict";
    if (candidate.code === "EBADF") return "bad_file_descriptor";
    if (candidate.code === "EAGAIN" || candidate.code === "EMFILE"
      || candidate.code === "ENFILE" || candidate.code === "ENOMEM") return "resource_exhausted";
    if (candidate.name === "AbortError") return "aborted";
    if (candidate.name === "TimeoutError" || candidate.code === "ETIMEDOUT") return "timeout";
    if (candidate.code === "EACCES" || candidate.code === "EPERM") return "permission_denied";
    if (candidate.code === "ECONNRESET" || candidate.code === "ECONNREFUSED"
      || candidate.code === "EPIPE") return "transport_failure";
  } catch {
    // A hostile Error proxy/getter must never alter the primary operation.
  }
  return "unknown";
}

function diagnosticToolErrorResult(value: unknown): boolean {
  try {
    return Boolean(value && typeof value === "object"
      && (value as { readonly isError?: unknown }).isError === true);
  } catch {
    return false;
  }
}

function diagnosticResultTruncated(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const flag = (structured as Record<string, unknown>).output_truncated;
  return typeof flag === "boolean" ? flag : undefined;
}

export function privateFingerprint(value: unknown, secret: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || secret.length === 0) return undefined;
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 24);
}

function identitySignalForKey(key: string): string | undefined {
  if (NON_IDENTITY_KEYS.has(key.toLowerCase())) return undefined;
  return HOST_IDENTITY_SIGNALS.find(([, pattern]) => pattern.test(key))?.[0];
}

function stableIdentityValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 && value.length <= 1_024 ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

export function hostIdentityEvidence(
  values: unknown,
  secret: string,
): { signals: string[]; fingerprint?: string } {
  if (!values || typeof values !== "object" || Array.isArray(values)) return { signals: [] };
  const signals = new Set<string>();
  const fingerprintParts: string[] = [];
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const signal = identitySignalForKey(key);
    if (!signal) continue;
    signals.add(signal);
    const stableValue = stableIdentityValue(value);
    if (stableValue !== undefined) fingerprintParts.push(`${key}\0${stableValue}`);
  }
  const sortedSignals = [...signals].sort();
  if (fingerprintParts.length === 0) return { signals: sortedSignals };
  const fingerprint = createHmac("sha256", secret)
    .update(fingerprintParts.sort().join("\n"))
    .digest("hex")
    .slice(0, 24);
  return { signals: sortedSignals, fingerprint };
}

export async function traceTool<T>(
  id: unknown, tool: string, operation: () => Promise<T>,
  context?: { signal?: AbortSignal; sessionId?: unknown; meta?: unknown; requestBytes?: number },
): Promise<T> {
  const trace = requestTrace.getStore();
  if (!trace) return operation();
  const toolTrace = { ...trace, rpcId: rpcIdFingerprint(id) };
  return requestTrace.run(toolTrace, async () => {
    const startedAt = performance.now();
    let abortObserved = context?.signal?.aborted ?? false;
    let outcome: "completed" | "failed" = "completed";
    let failureClass: ReturnType<typeof diagnosticToolFailureClass> | undefined;
    let resultBytes: number | undefined;
    let resultTruncated: boolean | undefined;
    const meta = context?.meta && typeof context.meta === "object"
      ? context.meta as Record<string, unknown> : undefined;
    if (trace.logging.toolCalls) logEvent(trace.logging, "info", "tool_started", {
      tool,
      conversationScopeFingerprint: opaqueFingerprint(meta?.["openai/session"]),
      mcpSessionFingerprint: opaqueFingerprint(context?.sessionId),
      requestBytes: context?.requestBytes,
      signalPresent: context?.signal !== undefined,
      signalAbortedAtStart: context?.signal?.aborted ?? false,
    });
    const onAbort = () => {
      abortObserved = true;
      if (trace.logging.toolCalls) logEvent(trace.logging, "info", "tool_abort_signalled", {
        requestId: toolTrace.requestId,
        rpcId: toolTrace.rpcId,
        tool,
      });
    };
    context?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await operation();
      if (diagnosticToolErrorResult(result)) {
        outcome = "failed";
        failureClass = "tool_error_result";
      }
      resultBytes = diagnosticSerializedBytes(result);
      resultTruncated = diagnosticResultTruncated(result);
      return result;
    } catch (error) {
      outcome = "failed";
      failureClass = diagnosticToolFailureClass(error);
      throw error;
    } finally {
      context?.signal?.removeEventListener("abort", onAbort);
      if (trace.logging.toolCalls) logEvent(trace.logging, "info", "tool_settled", {
        tool,
        outcome,
        ...(failureClass ? { failureClass } : {}),
        durationMs: Math.round(performance.now() - startedAt),
        resultBytes,
        resultTruncated,
        abortObserved,
        signalAbortedAtSettlement: context?.signal?.aborted ?? false,
      });
    }
  });
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    requestId: requestTrace.getStore()?.requestId,
    rpcId: requestTrace.getStore()?.rpcId,
    ...fields,
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
