// Guards the three places that must name the same release: package.json (what
// npm serves), server.json (what the MCP Registry lists) and the version the
// running server reports in initialize.
//
// They drift silently. 0.7.1 shipped announcing itself as 0.6.0, and nothing
// noticed. A server.json left one version behind is worse: the registry
// rejects the publish, because it checks that the npm package it points to
// carries a matching mcpName.
//
// Run: node --test mcp/test/metadata.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf-8"));

// Boots the compiled server over stdio and returns its initialize result.
function initialize() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PRESSA_API_URL: "https://api.pressa.dev" };
    delete env.PRESSA_API_KEY;

    const proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("timed out waiting for initialize"));
    }, 10_000);

    proc.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n").filter(Boolean)) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          clearTimeout(timer);
          proc.kill();
          resolve(msg.result);
        }
      }
    });
    proc.on("error", reject);

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }) + "\n");
  });
}

test("the server reports the version it was published as", async () => {
  const pkg = readJson("package.json");
  const { serverInfo } = await initialize();

  assert.equal(serverInfo.version, pkg.version);
});

test("server.json describes the package it points to", () => {
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const [npmPackage] = server.packages;

  assert.equal(server.name, pkg.mcpName, "the registry rejects a name that differs from the package's mcpName");
  assert.equal(server.version, pkg.version);
  assert.equal(npmPackage.identifier, pkg.name);
  assert.equal(npmPackage.version, pkg.version, "server.json must point at the version being published");
});
