#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PressaClient, PressaApiError } from "./client.js";

const API_KEY = process.env.PRESSA_API_KEY;
delete process.env.PRESSA_API_KEY; // Clear from env to reduce exposure
const API_URL = process.env.PRESSA_API_URL ?? "https://api.pressa.dev";

if (!API_KEY) {
  console.error("Error: PRESSA_API_KEY environment variable is required.");
  process.exit(1);
}

const client = new PressaClient(API_URL, API_KEY);

const server = new McpServer({
  name: "pressa",
  version: "0.1.0",
});

function formatError(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  if (error instanceof PressaApiError) {
    const body = error.body as Record<string, unknown> | null;
    const parts = [`Error: ${error.message}`];

    if (body?.log) parts.push(`\nCompilation log:\n${body.log}`);
    if (body?.line) parts.push(`Error on line: ${body.line}`);

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Network error: ${message}` }],
    isError: true,
  };
}

// --- compile tool ---

server.tool(
  "compile",
  "Compile LaTeX source code into a PDF document. Returns a download URL, page count, and compilation time.",
  {
    latex: z.string().min(1, "LaTeX source cannot be empty").max(512_000, "LaTeX source exceeds 500KB limit").describe("LaTeX source code to compile"),
    compiler: z
      .enum(["pdflatex", "xelatex", "lualatex"])
      .optional()
      .describe("LaTeX compiler to use (default: pdflatex)"),
  },
  async ({ latex, compiler }) => {
    try {
      const result = await client.compile({ latex, compiler });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- usage tool ---

server.tool(
  "usage",
  "Get current API usage statistics including plan info, compilation count, and limits.",
  {},
  async () => {
    try {
      const result = await client.usage();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
