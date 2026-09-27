import type { Request } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";

export const DIAGNOSTIC_SCHEMA_REVISION = "2026-09-27-activity-v1";

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
  context?: { signal?: AbortSignal; sessionId?: unknown; meta?: unknown },
): Promise<T> {
  const trace = requestTrace.getStore();
  if (!trace) return operation();
  const toolTrace = { ...trace, rpcId: rpcIdFingerprint(id) };
  return requestTrace.run(toolTrace, async () => {
    const startedAt = performance.now();
    let abortObserved = context?.signal?.aborted ?? false;
    let outcome: "completed" | "failed" = "completed";
    const meta = context?.meta && typeof context.meta === "object"
      ? context.meta as Record<string, unknown> : undefined;
    if (trace.logging.toolCalls) logEvent(trace.logging, "info", "tool_started", {
      tool,
      conversationScopeFingerprint: opaqueFingerprint(meta?.["openai/session"]),
      mcpSessionFingerprint: opaqueFingerprint(context?.sessionId),
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
      return await operation();
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      context?.signal?.removeEventListener("abort", onAbort);
      if (trace.logging.toolCalls) logEvent(trace.logging, "info", "tool_settled", {
        tool,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
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
