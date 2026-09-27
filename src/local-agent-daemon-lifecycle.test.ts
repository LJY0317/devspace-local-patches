import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalAgentDaemonAlreadyRunningError,
  LocalAgentDaemonLock,
  LOCAL_AGENT_DAEMON_SOCKET_NAME,
  ensureLocalAgentDaemonStateDir,
  isProcessAlive,
  localAgentDaemonPaths,
  removeLocalAgentDaemonFiles,
  ensureLocalAgentDaemonSecret,
} from "./local-agent-daemon-lifecycle.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agentd-lifecycle-test-"));
try {
  const paths = localAgentDaemonPaths(join(root, "state"));
  ensureLocalAgentDaemonStateDir(paths.stateDir);
  const lock = new LocalAgentDaemonLock(paths);
  lock.acquire();
  assert.equal(await readFile(paths.lockPath, "utf8"), `${process.pid}\n`);
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
  );
  await writeFile(paths.pidPath, "999999\n", { mode: 0o600 });
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
    "a stale diagnostic PID must not override the live lock owner",
  );
  assert.equal(ensureLocalAgentDaemonSecret(paths).length, 64);
  lock.release();

  await writeFile(paths.lockPath, "999999999\n", { mode: 0o600 });
  await writeFile(paths.pidPath, "999999999\n", { mode: 0o600 });
  const recovered = new LocalAgentDaemonLock(paths);
  recovered.acquire();
  assert.equal(await readFile(paths.lockPath, "utf8"), `${process.pid}\n`);
  assert.equal(await readFile(paths.pidPath, "utf8"), `${process.pid}\n`);
  assert.equal(isProcessAlive(process.pid), true);
  recovered.release();

  await writeFile(paths.lockPath, "not-a-pid\n", { mode: 0o600 });
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
    "an undecodable lock must fail closed instead of being deleted by age",
  );
  assert.equal(await readFile(paths.lockPath, "utf8"), "not-a-pid\n");
  await rm(paths.lockPath, { force: true });

  await writeFile(paths.secretPath, "not-a-hex-secret\n", { mode: 0o600 });
  assert.throws(
    () => ensureLocalAgentDaemonSecret(paths),
    /secret is invalid/,
    "daemon secrets must be exactly 64 hexadecimal characters",
  );
  removeLocalAgentDaemonFiles(paths);

  if (process.platform !== "win32") {
    const longStateDir = join(root, "x".repeat(120));
    const longPaths = localAgentDaemonPaths(longStateDir);
    assert.notEqual(longPaths.socketPath, join(longStateDir, LOCAL_AGENT_DAEMON_SOCKET_NAME));
    assert.ok(Buffer.byteLength(longPaths.socketPath) <= 96);
    assert.equal(ensureLocalAgentDaemonSecret(longPaths).length, 64);
    removeLocalAgentDaemonFiles(longPaths);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
