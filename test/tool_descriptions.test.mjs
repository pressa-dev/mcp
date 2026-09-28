// Guards the text the model actually reads when it decides whether to call a
// tool. Nothing else in the build checks it, and it is uniquely easy to break
// silently: the description is assembled from string fragments, and in
// JavaScript a stray `+` turns `+ "some text"` into `NaN` without TypeScript
// objecting, because `string + number` is perfectly legal.
//
// That exact bug shipped once. It swallowed the sentence telling the model
// WHEN to use the tool and replaced it with the literal text "NaN". Everything
// still started, listed and compiled, so every smoke test passed. Only reading
// the description caught it.
//
// Run: node --test mcp/test/tool_descriptions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// Boots the compiled server over stdio and returns its advertised tools.
function listTools({ apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PRESSA_API_URL: "https://api.pressa.dev" };
    if (apiKey) env.PRESSA_API_KEY = apiKey;
    else delete env.PRESSA_API_KEY;

    const proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("timed out waiting for tools/list"));
    }, 10_000);

    proc.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n").filter(Boolean)) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          proc.kill();
          resolve(msg.result.tools);
        }
      }
    });
    proc.on("error", reject);

    const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }, 300);
  });
}

test("no tool description contains a string-concatenation artefact", async () => {
  const tools = await listTools();

  for (const tool of tools) {
    for (const artefact of ["NaN", "undefined", "[object Object]"]) {
      assert.ok(
        !tool.description.includes(artefact),
        `${tool.name} description contains "${artefact}" - a fragment was lost to a broken concatenation`,
      );
    }
  }
});

test("compile tells the model when to use it and when not to", async () => {
  const [compile] = await listTools();
  const d = compile.description;

  // The selection signal. Without a "use this when", the model is choosing
  // between tools on the strength of the name alone.
  assert.match(d, /USE THIS WHEN/i);
  assert.match(d, /pdflatex|TeX Live/i, "must name the situation it resolves: no local compiler");

  // The exclusion. An ambiguous description loses to a rival whose name says
  // exactly what it does, and wrong calls are worse than no calls.
  assert.match(d, /DO NOT USE/i);
  assert.match(d, /HTML/i, "must say it does not convert HTML");
  assert.match(d, /merge/i, "must say it does not merge existing PDFs");

  // The agent's own job. Without this the model forwards raw markdown.
  assert.match(d, /must generate complete, valid LaTeX/i);
});

test("anonymous mode advertises exactly one tool, and says a key is not needed", async () => {
  const tools = await listTools();

  assert.equal(tools.length, 1, "keyless mode must expose only compile");
  assert.equal(tools[0].name, "compile");
  assert.match(tools[0].description, /NO API KEY IS CONFIGURED/);
});

test("a key registers the full tool set", async () => {
  // The token is syntactically valid but not real. Registration happens at
  // startup from the presence of the variable, so no network call is made.
  const tools = await listTools({ apiKey: "pressa_" + "0".repeat(48) });
  const names = tools.map((t) => t.name);

  assert.ok(tools.length > 1, "a key must register more than compile");
  for (const expected of ["compile", "render", "usage", "save_template", "list_templates", "save_asset"]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  assert.ok(
    !tools[0].description.includes("NO API KEY IS CONFIGURED"),
    "keyed mode must not carry the anonymous notice",
  );
});

// save_template is how agents reach the raw LaTeX / placeholder split. Before
// placeholder_engine existed, saving {{ amount }} into a raw LaTeX template
// answered 200 and every later compile printed the braces in the PDF.
test("save_template explains the two kinds of template and takes placeholder_engine", async () => {
  const tools = await listTools({ apiKey: "pressa_" + "0".repeat(48) });
  const save = tools.find((t) => t.name === "save_template");

  assert.match(save.description, /placeholder_engine "liquid"/);
  assert.match(save.description, /liquid_placeholders_in_v1_template/);
  assert.match(save.description, /\{% raw %\}/, "must name the fix for liquid_syntax_error");
  assert.deepEqual(save.inputSchema.properties.placeholder_engine.enum, ["liquid", "none"]);
  assert.deepEqual(save.inputSchema.required, ["name"], "latex_content is optional when converting");
});
