// Minimal smoke test for the @pressa/mcp PressaClient using Node's built-in
// test runner. No external test framework is installed; this stays additive
// and runs from compiled dist output.
//
// Run: node --test mcp/test/client.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { PressaClient } from "../dist/client.js";

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("saveTemplate: passes instructions field when provided", async () => {
  const calls = mockFetch(() =>
    jsonResponse({
      template: {
        id: 1,
        name: "Invoice",
        description: null,
        latex_content: "\\documentclass{article}\\begin{document}Hi\\end{document}",
        instructions: "Use today's date.",
        updated_at: new Date().toISOString(),
        latex_size_bytes: 50,
      },
      created: true,
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  const res = await client.saveTemplate(
    "Invoice",
    "\\documentclass{article}\\begin{document}Hi\\end{document}",
    undefined,
    "Use today's date.",
  );

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.name, "Invoice");
  assert.equal(sent.instructions, "Use today's date.");
  assert.equal(res.template.instructions, "Use today's date.");
});

test("saveTemplate: omits instructions key when not provided", async () => {
  const calls = mockFetch(() =>
    jsonResponse({
      template: {
        id: 2,
        name: "Static",
        description: null,
        latex_content: "x",
        instructions: null,
        updated_at: new Date().toISOString(),
        latex_size_bytes: 1,
      },
      created: true,
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  await client.saveTemplate("Static", "x");

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(Object.prototype.hasOwnProperty.call(sent, "instructions"), false);
});

test("saveTemplate: passes empty string instructions explicitly to clear", async () => {
  const calls = mockFetch(() =>
    jsonResponse({
      template: {
        id: 3,
        name: "X",
        description: null,
        latex_content: "x",
        instructions: "",
        updated_at: new Date().toISOString(),
        latex_size_bytes: 1,
      },
      created: false,
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  await client.saveTemplate("X", "x", undefined, "");

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.instructions, "");
});

test("getTemplate: returns instructions field from response", async () => {
  mockFetch(() =>
    jsonResponse({
      template: {
        id: 4,
        name: "Toptal",
        description: null,
        latex_content: "x",
        instructions: "Ask user for amount.",
        updated_at: new Date().toISOString(),
        latex_size_bytes: 1,
      },
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  const res = await client.getTemplate("Toptal");

  assert.equal(res.template.instructions, "Ask user for amount.");
});

test("listTemplates: surfaces has_instructions per item", async () => {
  mockFetch(() =>
    jsonResponse({
      templates: [
        {
          id: 1,
          name: "A",
          description: null,
          updated_at: new Date().toISOString(),
          latex_size_bytes: 10,
          has_instructions: true,
        },
        {
          id: 2,
          name: "B",
          description: null,
          updated_at: new Date().toISOString(),
          latex_size_bytes: 5,
          has_instructions: false,
        },
      ],
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  const res = await client.listTemplates();

  assert.equal(res.templates.length, 2);
  assert.equal(res.templates[0].has_instructions, true);
  assert.equal(res.templates[1].has_instructions, false);
});
