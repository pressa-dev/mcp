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
  const res = await client.saveTemplate("Invoice", {
    latexContent: "\\documentclass{article}\\begin{document}Hi\\end{document}",
    instructions: "Use today's date.",
  });

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
  await client.saveTemplate("Static", { latexContent: "x" });

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
  await client.saveTemplate("X", { latexContent: "x", instructions: "" });

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.instructions, "");
});

test("saveTemplate: sends placeholder_engine and may omit latex_content to convert the saved source", async () => {
  const calls = mockFetch(() =>
    jsonResponse({
      template: {
        id: 12,
        name: "Deviza",
        description: null,
        latex_content: "{{ amount }}",
        instructions: null,
        updated_at: new Date().toISOString(),
        latex_size_bytes: 12,
        placeholder_engine: "liquid",
        schema: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] },
      },
      created: false,
      promoted: true,
    }),
  );

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  const res = await client.saveTemplate("Deviza", { placeholderEngine: "liquid" });

  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { name: "Deviza", placeholder_engine: "liquid" });
  assert.equal(res.promoted, true);
});

test("saveTemplate: omits placeholder_engine when not provided", async () => {
  const calls = mockFetch(() => jsonResponse({ template: { id: 5 }, created: true, promoted: false }));

  const client = new PressaClient("https://api.example.test", "pressa_test_token");
  await client.saveTemplate("Plain", { latexContent: "x" });

  const sent = JSON.parse(calls[0].init.body);
  assert.equal(Object.prototype.hasOwnProperty.call(sent, "placeholder_engine"), false);
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
