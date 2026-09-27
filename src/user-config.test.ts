import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDevspaceFiles,
  setDevspaceConfigValue,
  setDevspaceConfigValues,
} from "./user-config.js";

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "0.0.0.0",
    port: 8787,
    tool_mode: "claude",
    allowedRoots: ["/work"],
    publicBaseUrl: "https://devspace.example.com",
    artifactsEnabled: true,
    subagents: true,
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token",
  }));

  assert.throws(
    () => loadDevspaceFiles(env),
    /Legacy configuration .*config\.json is unsupported by this current-only build/,
  );
  assert.equal(existsSync(join(configDir, "config.json")), true);
  assert.equal(existsSync(join(configDir, "config.jsonc")), false);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), `{
    // This comment must survive config updates.
    "configVersion": 1,
    "server": {
      "port": 8787,
    },
  }\n`);

  const files = loadDevspaceFiles(env);
  assert.equal(files.config.server.port, 8787);
  assert.equal(files.config.tools.mode, "codex");

  setDevspaceConfigValue(["server", "publicBaseUrl"], "https://new.example.com", env);
  const updated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(updated, /This comment must survive config updates/);
  assert.equal(loadDevspaceFiles(env).config.server.publicBaseUrl, "https://new.example.com");

  setDevspaceConfigValues([
    { path: ["server", "port"], value: 7676 },
    { path: ["tools", "mode"], value: "claude" },
  ], env);
  const multiUpdated = readFileSync(join(configDir, "config.jsonc"), "utf8");
  assert.match(multiUpdated, /This comment must survive config updates/);
  assert.equal(loadDevspaceFiles(env).config.server.port, 7676);
  assert.equal(loadDevspaceFiles(env).config.tools.mode, "claude");
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify({ configVersion: 1 }));
  writeFileSync(join(configDir, "config.json"), "{");
  assert.equal(loadDevspaceFiles(env).config.server.port, 7676);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

withConfigDir((configDir, env) => {
  writeFileSync(join(configDir, "config.jsonc"), "{");
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 8787 }));
  assert.throws(() => loadDevspaceFiles(env), /Unable to read .*config\.jsonc/);
  assert.equal(existsSync(join(configDir, "config.json")), true);
});

console.log("user config tests passed");

function withConfigDir(
  test: (configDir: string, env: NodeJS.ProcessEnv) => void,
): void {
  const configDir = mkdtempSync(join(tmpdir(), "devspace-user-config-test-"));
  const env = { DEVSPACE_CONFIG_DIR: configDir };
  try {
    test(configDir, env);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
