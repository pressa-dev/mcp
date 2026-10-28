// Builds pressa.mcpb, the Claude Desktop extension: one file a person
// double-clicks, then pastes an API key into the form Claude Desktop shows.
// No Node.js install and no claude_desktop_config.json editing, which is
// where a non-technical user gives up (Claude Desktop runs the bundled
// server with its own Node).
//
//   node scripts/build-mcpb.mjs      -> build/pressa.mcpb
//
// The bundle carries dist/, package.json (the server reads its version from
// it) and production node_modules only. manifest.json must name the same
// version as package.json; test/metadata.test.mjs fails if they drift.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCPB_VERSION = "2.1.2";
const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "build", "pressa.mcpb");
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf-8"));
if (manifest.version !== pkg.version) {
  console.error(`mcpb/manifest.json is ${manifest.version}, package.json is ${pkg.version}`);
  process.exit(1);
}

run("npm", ["run", "build"]);

const stage = mkdtempSync(join(tmpdir(), "pressa-mcpb-"));
try {
  cpSync(join(ROOT, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(stage, "package.json"));
  cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(ROOT, "mcpb", "manifest.json"), join(stage, "manifest.json"));
  cpSync(join(ROOT, "mcpb", "icon.png"), join(stage, "icon.png"));
  // --ignore-scripts: "prepare" would run tsc, which is a devDependency.
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  rmSync(join(stage, "package-lock.json"), { force: true });

  mkdirSync(join(ROOT, "build"), { recursive: true });
  rmSync(OUT, { force: true });
  run("npx", ["-y", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "pack", stage, OUT]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(`\n${OUT}`);
