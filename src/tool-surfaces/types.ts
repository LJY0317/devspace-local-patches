import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";

// Increment when model-visible tool titles, descriptions, or safety-relevant
// capability wording changes in a way that should be distinguishable in
// privacy-safe incident logs.
export const HOST_FACING_TOOL_CONTRACT_REVISION = "2026-09-27-neutral-v1";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  readMany: "read_many",
  write: "write",
  edit: "edit",
  shell: "bash",
} as const;

export const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspace_id.";

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  sessionId?: number;
  running?: boolean;
  exitCode?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

export type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

export interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

export interface ToolRegistrationContext {
  server: Pick<McpServer, "registerTool" | "registerResource">;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
}

export interface ToolInstructionContext {
  agents: string;
  skills: string;
}

export interface ToolSurface {
  register(context: ToolRegistrationContext): void;
  instructions(context: ToolInstructionContext): string;
}
