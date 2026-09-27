import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ProcessLiveness = "alive" | "not_running" | "pid_reused" | "unknown";

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}

/**
 * Return a privacy-safe OS start identity for a PID when the platform exposes
 * one cheaply enough for per-process execution provenance. The identity is
 * deliberately limited to boot/process timing metadata: no command line,
 * environment, executable path, or open-file data is read.
 */
export function readProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return undefined;
      const fieldsAfterComm = stat.slice(closeParen + 2).trim().split(/\s+/);
      const startTicks = fieldsAfterComm[19];
      if (!startTicks) return undefined;
      let bootId = "boot-unknown";
      try {
        bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || bootId;
      } catch {
        // The PID start ticks are still useful within the current boot.
      }
      return `linux:${identityFingerprint(`${bootId}:${startTicks}`)}`;
    } catch {
      return undefined;
    }
  }

  if (platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 1_000,
    });
    if (result.error || result.status !== 0) return undefined;
    const started = result.stdout.trim().replace(/\s+/g, " ");
    return started ? `darwin:${identityFingerprint(`${pid}:${started}`)}` : undefined;
  }

  return undefined;
}

function identityFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function inspectProcessLiveness(
  pid: number | undefined,
  expectedStartIdentity: string | undefined,
  identityReader: (pid: number) => string | undefined = readProcessStartIdentity,
): ProcessLiveness {
  if (!pid || !expectedStartIdentity) return "unknown";
  const observed = identityReader(pid);
  if (!observed) {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? "not_running" : "unknown";
    }
  }
  return observed === expectedStartIdentity ? "alive" : "pid_reused";
}
