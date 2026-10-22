// Installs the package the way users get it and starts it, before (and
// after) it is published. A package that passes its unit tests can still
// fail to start once installed: @pressa/mcp 0.11.0 shipped its bin without
// the executable bit and died in the Claude desktop app with
// "pressa-mcp: Permission denied", because npx does not add the bit when it
// updates a package it already has. This script refuses such a package.
//
//   node scripts/smoke-package.mjs                 the tarball npm pack makes
//   node scripts/smoke-package.mjs --registry X.Y.Z  that version from npm
//
// For each of two installs, fresh and an in-place upgrade over the version
// currently on npm, it checks that the bin is executable and that it runs:
// the MCP server answers initialize with its own version, the CLI prints
// its version. Any failure exits non-zero, which stops the publish workflow.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const [binName, binTarget] = Object.entries(pkg.bin)[0];
const registryVersion = process.argv.includes("--registry") ? process.argv[process.argv.indexOf("--registry") + 1] : null;
const expected = registryVersion ?? pkg.version;
const npm = (args, cwd) => execFileSync("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// What gets installed: the packed tarball, or the published version.
let spec;
if (registryVersion) {
  spec = `${pkg.name}@${registryVersion}`;
} else {
  const tarball = resolve(npm(["pack", "--silent"]).split("\n").pop());
  const listing = execFileSync("tar", ["-tvzf", tarball]).toString();
  const line = listing.split("\n").find((l) => l.trim().endsWith(`package/${binTarget}`));
  if (!line) fail(`${binTarget} is not in the tarball`);
  if (!line.startsWith("-rwx")) fail(`${binTarget} is packed without the executable bit: ${line.trim()}`);
  spec = tarball;
}

// The version on npm right now, to upgrade from (none before the first release).
let previous = null;
try {
  previous = npm(["view", pkg.name, "version"]);
} catch {
  previous = null;
}

function runs(bin) {
  if (binName === "pressa-mcp") {
    return new Promise((resolvePromise) => {
      const env = { ...process.env };
      delete env.PRESSA_API_KEY;
      const proc = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        proc.kill();
        resolvePromise(`no answer to initialize in 20 s; stderr: ${err.slice(0, 300)}`);
      }, 20_000);
      proc.on("error", (e) => {
        clearTimeout(timer);
        resolvePromise(`could not start: ${e.message}`);
      });
      proc.stderr.on("data", (d) => (err += d));
      proc.stdout.on("data", (d) => {
        out += d;
        const lineEnd = out.indexOf("\n");
        if (lineEnd < 0) return;
        clearTimeout(timer);
        proc.kill();
        try {
          const version = JSON.parse(out.slice(0, lineEnd)).result?.serverInfo?.version;
          resolvePromise(version === expected ? null : `initialize reported version ${version}, expected ${expected}`);
        } catch (e) {
          resolvePromise(`initialize answer is not JSON: ${out.slice(0, 200)}`);
        }
      });
      proc.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }
      }) + "\n");
    });
  }
  try {
    const printed = execFileSync(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    return Promise.resolve(printed === expected ? null : `--version printed ${printed}, expected ${expected}`);
  } catch (e) {
    return Promise.resolve(`could not run: ${e.message}`);
  }
}

const scenarios = [ [ "fresh install", null ] ];
if (previous && previous !== expected) scenarios.push([ `upgrade from ${previous}`, `${pkg.name}@${previous}` ]);

for (const [label, from] of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }));
    if (from) npm(["install", from, "--no-audit", "--no-fund"], dir);
    npm(["install", spec, "--no-audit", "--no-fund"], dir);
    const bin = join(dir, "node_modules", ".bin", binName);
    const mode = statSync(realpathSync(bin)).mode;
    if (!(mode & 0o111)) fail(`${label}: ${binName} is installed without the executable bit (${(mode & 0o777).toString(8)})`);
    const problem = await runs(bin);
    if (problem) fail(`${label}: ${problem}`);
    console.log(`ok - ${label}: ${binName} ${expected} installs executable and runs`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The packed tarball is a build artifact; leave the working tree as it was.
if (!registryVersion) rmSync(spec, { force: true });
