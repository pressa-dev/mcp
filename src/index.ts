#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PressaClient, PressaApiError } from "./client.js";

const API_KEY = process.env.PRESSA_API_KEY ?? null;
delete process.env.PRESSA_API_KEY; // Clear from env to reduce exposure
const API_URL = process.env.PRESSA_API_URL ?? "https://api.pressa.dev";

const HAS_KEY = Boolean(API_KEY);
const SIGNUP_URL = "https://pressa.dev/users/sign_up";

// A missing key used to be fatal. It no longer is.
//
// An MCP server that refuses to start leaves the agent with nothing: the tools
// never appear, so the model cannot even discover that Pressa exists. Starting
// in anonymous mode means the agent can compile a real PDF immediately and only
// then involve its human, holding a finished document rather than a setup
// chore. The server exposes exactly one tool in this mode, because exactly one
// endpoint works without an account.
if (!HAS_KEY) {
  console.error(
    "[pressa] No PRESSA_API_KEY set - starting in anonymous mode. " +
      "The 'compile' tool works without a key (limited daily allowance). " +
      `Set PRESSA_API_KEY to enable templates, assets and render: ${SIGNUP_URL}`,
  );
}

const client = new PressaClient(API_URL, API_KEY);

// The version reported in initialize comes from package.json, the same source
// npm and the MCP Registry read. A hardcoded copy drifted once: 0.7.1 shipped
// announcing itself as 0.6.0.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const server = new McpServer({
  name: "pressa",
  version: pkg.version,
});

// Registration helper for tools that need a real account.
//
// In anonymous mode these are NOT registered rather than registered-and-always-
// failing. An agent picks from the tool list it is handed; a tool that cannot
// possibly succeed is worse than an absent one, because it burns a call and
// teaches the model that Pressa is broken.
const authedTool: typeof server.tool = ((...args: unknown[]) => {
  if (!HAS_KEY) return undefined;
  return (server.tool as (...a: unknown[]) => unknown)(...args);
}) as unknown as typeof server.tool;

function formatError(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  if (error instanceof PressaApiError) {
    const body = error.body as Record<string, unknown> | null;
    const headline =
      typeof body?.message === "string" && body.message.length > 0
        ? body.message
        : error.message;
    const parts = [`Error: ${headline}`];

    if (typeof body?.upgrade_url === "string" && body.upgrade_url.length > 0) {
      parts.push(`Upgrade at: ${body.upgrade_url}`);
    }

    // not_latex_source returns a structured "how to fix" payload aimed at the agent
    if (Array.isArray(body?.requirements) && body.requirements.length > 0) {
      parts.push("\nRequirements:");
      for (const req of body.requirements) {
        if (typeof req === "string") parts.push(`  - ${req}`);
      }
    }
    if (typeof body?.example_template === "string" && body.example_template.length > 0) {
      parts.push(`\nExample template:\n${body.example_template}`);
    }

    // Structured compile diagnosis (server-side LatexErrorParser). This is the
    // part the model should act on: it names the fix instead of handing over a
    // TeX log to interpret. Put it BEFORE the raw log so it is not buried.
    const diagnosis = body?.diagnosis as Record<string, unknown> | undefined;
    if (diagnosis) {
      parts.push("\nDiagnosis:");
      if (diagnosis.error_class) parts.push(`  type: ${diagnosis.error_class}`);
      if (diagnosis.symbol) parts.push(`  at: ${diagnosis.symbol}`);
      if (diagnosis.line) parts.push(`  line: ${diagnosis.line}`);
      if (diagnosis.suggested_fix) parts.push(`  fix: ${diagnosis.suggested_fix}`);
    }
    if (typeof body?.agent_hint === "string") {
      parts.push(`\n${body.agent_hint}`);
    }

    // What to do about quota / capacity / missing-key responses. Without this
    // the model sees only "429" and abandons the document.
    const nextStep = body?.next_step as Record<string, unknown> | undefined;
    if (nextStep) {
      parts.push("\nNext step:");
      if (nextStep.action) parts.push(`  action: ${nextStep.action}`);
      if (nextStep.signup_url) parts.push(`  sign up: ${nextStep.signup_url}`);
      if (nextStep.env_var) parts.push(`  then set: ${nextStep.env_var}=<key> and restart this MCP server`);
      if (Array.isArray(nextStep.remove_fields)) {
        parts.push(`  or retry without: ${(nextStep.remove_fields as string[]).join(", ")}`);
      }
      if (nextStep.card_required === false) parts.push("  no credit card required");
    }

    if (body?.log) parts.push(`\nCompilation log:\n${body.log}`);
    if (body?.line && !diagnosis) parts.push(`Error on line: ${body.line}`);

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
  // The description is what the model reads when deciding whether to call this
  // tool at all, so it opens with the situation the model is actually in
  // rather than with a pitch. The common failure it addresses: the model
  // already wrote LaTeX from pre-training, told the user to run `pdflatex`,
  // found no TeX Live, and fell back to HTML-to-PDF because that was
  // executable. This tool is the missing `pdflatex`, not a new category to
  // learn. The explicit "do not use for" line matters as much as the rest -
  // an ambiguous description loses tool selection to a rival whose name says
  // exactly what it does.
  //
  // Built with an array + join rather than chained `+` because a stray `+`
  // in that chain silently produced `NaN` inside the string once already,
  // and TypeScript accepts `string + number` without complaint.
  [
    "Compile LaTeX source into a PDF. Returns a PDF URL, page count and compile time.",
    "",
    "USE THIS WHEN: you have LaTeX source (or a \\documentclass) and no local pdflatex / TeX Live " +
      "installation to run it with. This is that missing compiler, available over HTTP. Also use it whenever " +
      "the user asks for a document where typesetting matters - an invoice, contract, report, letter, CV, " +
      "certificate, or academic paper - since you can write the LaTeX yourself and compile it here.",
    "",
    "DO NOT USE THIS TO: convert HTML to PDF, merge, split or compress existing PDF files, or extract text " +
      "from a PDF. This compiles LaTeX source and nothing else.",
    "",
    HAS_KEY
      ? ""
      : "NO API KEY IS CONFIGURED, so this runs on the anonymous tier: pdflatex only, up to 3 pages, " +
        "no image assets, and a small number of compilations per day. It works right now - use it. " +
        "If the server reports the daily allowance is used up, tell the user they can get a free key at " +
        `${SIGNUP_URL} in about 30 seconds with no credit card, then set PRESSA_API_KEY and restart this server.`,
    "",
    "If a document is over the plan's page or size limit, the response still contains a PDF: `preview: true`, the " +
      "first pages the plan allows, `total_pages`, and `plan_required` naming the plan that covers the whole " +
      "document. Show the user the preview and relay `warning`; never drop pages silently.",
    "",
    "IMPORTANT: This tool compiles LaTeX, NOT plain text. You (the AI agent) must generate complete, valid LaTeX " +
    "source yourself before calling this tool. Do not pass user-provided plain text, markdown, JSON, or raw file " +
    "contents directly - convert them to LaTeX first. Do not ask the user to write LaTeX; that is your job.\n\n" +
    "A minimal valid document is: \\documentclass{article}\\begin{document}<content>\\end{document}. " +
    "Always include a documentclass declaration. Always wrap content in \\begin{document}...\\end{document}. " +
    "Always escape these characters in body text: % becomes \\%, & becomes \\&, $ becomes \\$, # becomes \\#, " +
    "_ becomes \\_, { becomes \\{, } becomes \\}, backslash becomes \\textbackslash{}.\n\n" +
    "IMAGES & BINARY ASSETS: To include images, logos, signatures, or embedded PDFs, pass them in the `assets` " +
    "parameter as a map of filename => base64-encoded binary. In your LaTeX source, reference them by the same " +
    "filename via \\includegraphics{filename.png} (remember \\usepackage{graphicx}). Example workflow: user " +
    "uploads a PDF with a company logo; you extract the logo as PNG, base64-encode it, and pass " +
    "{ \"logo.png\": \"iVBORw0KGgo...\" } as assets while referencing \\includegraphics{logo.png} in the LaTeX.\n\n" +
    "STORED ASSETS (for reusable brand files): For files the user will reuse across many documents (company logo, " +
    "signature, letterhead), prefer `save_asset` once and then `use_stored_assets: [\"name\"]` on every future " +
    "compile, instead of re-encoding the same bytes into `assets` every time. Ephemeral `assets` stays the right " +
    "choice for one-off files extracted from user-provided documents.\n\n" +
    "If the input is not valid LaTeX, the API returns a not_latex_source error with the exact requirements and an " +
    "example template. Read that response, fix your LaTeX, and retry. Do not bounce back to the user.",
  ].filter(Boolean).join("\n"),
  {
    latex: z
      .string()
      .min(1, "LaTeX source cannot be empty")
      .max(524_288, "LaTeX source exceeds 512KB limit")
      .describe(
        "Complete LaTeX source code. Must include \\documentclass and a \\begin{document}...\\end{document} body. " +
          "Plain text, markdown, raw notes, JSON, or fragments without these markers will be rejected with " +
          "not_latex_source. If the user gave you non-LaTeX input, convert it to LaTeX yourself before calling.",
      ),
    compiler: z
      .enum(["pdflatex", "xelatex", "lualatex"])
      .optional()
      .describe(
        "LaTeX compiler to use (default: pdflatex). pdflatex and xelatex are available on every plan. " +
          "lualatex requires Pro or Business; on Free or Starter it returns compiler_not_available.",
      ),
    assets: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Optional map of filename => base64-encoded binary. Supported formats: PNG, JPG, JPEG, PDF, SVG. " +
          "Filenames must be plain (no paths, no leading dot, alphanumeric + _-). Each asset is written into the " +
          "compile workspace so LaTeX can reference it by that exact filename (e.g. \\includegraphics{logo.png}). " +
          "Per-plan limits: Free 2 assets/1MB, Starter 5/5MB, Pro 20/25MB, Business 50/75MB (decoded bytes). " +
          "Invalid filenames return invalid_asset_filename; mismatched magic bytes return invalid_asset_format; " +
          "overflowing decoded size returns assets_too_large (413); too many entries returns too_many_assets.",
      ),
    use_stored_assets: z
      .array(z.string())
      .optional()
      .describe(
        "Names of assets in the user's persistent library to inject into this compile. Use this instead of " +
          "re-sending the same bytes in `assets` every time when a file (logo, signature, letterhead) will be " +
          "reused across many compiles. Save the file once via save_asset, then reference it by name here. " +
          "Cannot collide with names in the ephemeral `assets` map - asset_name_collision (422) if a name appears " +
          "in both.",
      ),
  },
  async ({ latex, compiler, assets, use_stored_assets }) => {
    try {
      const result = await client.compile({ latex, compiler, assets, use_stored_assets });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- render tool ---

authedTool(
  "render",
  "Render a saved V2 template by filling its Liquid placeholders with the provided data, and return a PDF " +
    "URL. Use this whenever the user has a previously saved V2 template (one with placeholders / a schema) " +
    "and wants a new document built from fresh values - e.g. 'render my invoice template for client X', " +
    "'generate this month's report from the saved template', 'fill the contract template with these terms'. " +
    "Prefer render over compile any time the same template is reused: render is faster for the agent (no need " +
    "to regenerate or even read the LaTeX), saves tokens (you only send the data values, not the full LaTeX " +
    "body), and is schema-validated server-side so structural mistakes surface as actionable errors instead of " +
    "broken PDFs.\n\n" +
    "WHEN TO USE RENDER vs COMPILE:\n" +
    "- Use `render` when there is a saved V2 template the user wants filled in with new placeholder data. The " +
    "template owns the LaTeX and the schema; you only supply values.\n" +
    "- Use `compile` for one-off LaTeX that the agent generated for a specific request and that will not be " +
    "reused, or when no V2 template exists yet.\n" +
    "- If the user has a template but it is V1 (LaTeX-only, no placeholders), the API returns " +
    "template_engine_mismatch - either fall back to compile or convert it with save_template and " +
    "placeholder_engine \"liquid\" (same template id, name and instructions).\n\n" +
    "DATA SHAPE: pass `data` as a JSON object whose keys match the placeholder names defined in the template's " +
    "schema. The schema is enforced server-side; missing required fields return schema_validation_failed with a " +
    "`missing_fields` array. Type errors (string where the schema expects a number, etc.) return the same error " +
    "with a `type_errors` array. In both cases, fix the offending fields and retry - do not bounce back to the " +
    "user unless the value is genuinely unknown. Extra keys not declared in the schema are ignored, not " +
    "rejected.\n\n" +
    "AVAILABLE LIQUID FILTERS in the template (the template author controls these; you only supply the raw " +
    "values): `latex_escape` is auto-applied to every end-user value so % & $ # _ { } and similar special " +
    "characters are safe by default. `raw` opts a value out of escaping when the template author wants to " +
    "inject literal LaTeX. `asset` resolves a stored asset by name (file must already exist in the user's " +
    "asset library). `currency` and `date` format numeric and date inputs. You do not need to pre-format or " +
    "pre-escape values - just pass clean raw data.\n\n" +
    "PLAN: render is a paid-plan feature. Free-plan API keys get plan_required (403) with an upgrade URL. " +
    "Monthly compile/render cap is enforced; rate_limit (429) returns the cap, used count, and reset time.\n\n" +
    "ERRORS YOU MAY GET BACK (always retriable after fixing the cause unless noted):\n" +
    "- not_found (404): template id or name not in the user's library.\n" +
    "- template_engine_mismatch (422): template is V1 LaTeX-only. Use compile, or convert it with " +
    "save_template and placeholder_engine \"liquid\".\n" +
    "- invalid_data_shape (422): `data` was not a JSON object.\n" +
    "- schema_validation_failed (422): missing_fields / type_errors lists are returned - patch and retry.\n" +
    "- render_parse_failed (422): template Liquid syntax error. The template itself is broken; not retriable " +
    "without editing the template.\n" +
    "- render_failed (422): undefined variable, undefined filter, or render resource limit. Message has " +
    "details; usually a template bug.\n" +
    "- render_timeout (422): Liquid render exceeded 5s. Reduce data size or simplify template loops.\n" +
    "- render_asset_not_found (422): template references an asset name that is not saved.\n" +
    "- pdf_too_large (422): output exceeded the per-plan PDF size cap.\n" +
    "- page_limit_exceeded (422): output exceeded the per-plan page cap.\n" +
    "- compilation_failed / compilation_timeout (422): the rendered LaTeX failed to compile or hit the " +
    "compile timeout.\n" +
    "- rate_limit (429): monthly cap. Returns limit, used, resets_at, upgrade_url.\n" +
    "- render_total_timeout (504): the 60s outer wrap fired. Simplify the template or split the data into " +
    "smaller batches.\n\n" +
    "If you do not yet know the template id and the user just told you the template name, the name works " +
    "directly (URL-encoded server-side). If you have neither id nor name, ask the user or call list_templates " +
    "first.",
  {
    id_or_name: z
      .string()
      .min(1)
      .describe(
        "V2 template numeric ID or name. Names are matched case-insensitively. URL-encoding is handled by " +
          "the client.",
      ),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        "Placeholder values keyed by the template's schema field names. Must be a JSON object, not an array " +
          "or primitive. End-user strings are auto-escaped for LaTeX safety; you do not need to pre-escape. " +
          "Missing required fields return schema_validation_failed with a missing_fields list - read the " +
          "list, supply the values, and retry.",
      ),
  },
  async ({ id_or_name, data }) => {
    try {
      const result = await client.render(id_or_name, data);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- usage tool ---

authedTool(
  "usage",
  "Get current API usage statistics including plan info, compilation count, and limits.",
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

// --- save_template tool ---

authedTool(
  "save_template",
  "Save LaTeX source as a reusable template, optionally with prose instructions describing how future agents " +
    "should fill it in. If a template with this name already exists it is overwritten. Use this when the user " +
    "wants to save their work for future reuse - e.g. 'save this as my invoice template', 'remember this " +
    "template'. Requires a paid plan (Starter or above).\n\n" +
    "TWO KINDS OF TEMPLATE - choose with placeholder_engine:\n" +
    "- Raw LaTeX (default for a new name): compiled exactly as saved. To change a value next time, an agent " +
    "edits the LaTeX and calls compile.\n" +
    "- Placeholder template (placeholder_engine \"liquid\"): the values that change are Liquid placeholders " +
    "({{ amount }}, {{ client.name }}, {% for item in items %}...{% endfor %}), and the render tool fills them " +
    "from JSON data. The layout never changes and the next agent never touches the LaTeX. Prefer this when the " +
    "same document is produced repeatedly with different values. The response includes the `schema` render " +
    "expects.\n\n" +
    "CONVERTING an existing raw LaTeX template: call save_template with the same name and placeholder_engine " +
    "\"liquid\", plus the LaTeX with placeholders added. The id, name and instructions are kept. Omit " +
    "latex_content to convert the source already saved as it is. Converting back to raw LaTeX is not " +
    "supported.\n\n" +
    "If you send {{ }} or {% %} WITHOUT placeholder_engine \"liquid\", the save is refused " +
    "(liquid_placeholders_in_v1_template), because raw LaTeX would print the braces literally in the PDF. Resend " +
    "with \"liquid\" if they are placeholders, or \"none\" if they are literal LaTeX. If a placeholder save is " +
    "refused with liquid_syntax_error, some literal LaTeX looks like Liquid to the parser (typically a comment " +
    "right after a brace, \\foo{%): wrap that LaTeX in {% raw %}...{% endraw %}.\n\n" +
    "WHEN TO ATTACH INSTRUCTIONS: any time the template has parts that change between uses - dates, sequential " +
    "numbers, computed values, conditional sections, or anything an agent will need to decide on the next run. " +
    "If the LaTeX is fully static (the same PDF every time) you can omit instructions. If the user describes how " +
    "the template should behave ('always use today's date', 'invoice number is YYYYMMDD-N', 'add a VAT line for " +
    "EU clients', 'ask me for the amount'), capture that prose verbatim or summarized into the instructions " +
    "field so the next agent run does the right thing without the user repeating themselves.\n\n" +
    "WHAT BELONGS IN INSTRUCTIONS (prose markdown, addressed to the next AI agent that will use the template):\n" +
    "- Defaults: 'Use today's date if the user does not specify one.'\n" +
    "- Workflow rules: 'Always ask the user for the amount - do not guess. Currency is USD unless told otherwise.'\n" +
    "- Computed values: 'Invoice number format is YYYYMMDD-N where N is a 1-based counter of invoices already in " +
    "the user's library for the current calendar year. Compute it by listing existing templates / saved invoices " +
    "and counting matches.'\n" +
    "- Conditional logic: 'For EU clients add a VAT line at 20%. For US clients omit the VAT line.'\n" +
    "- Edge cases and nuance: 'If the client is Toptal, the rate is fixed at $4000/month and only the date changes.'\n" +
    "- Anything else the agent needs to know to fill the template correctly without asking the user again.\n\n" +
    "WHAT DOES NOT BELONG IN INSTRUCTIONS:\n" +
    "- Per-field mechanics like type, required, min, max, regex format - that is future schema territory, not " +
    "behavior prose. Keep instructions narrative, not structured.\n" +
    "- Physical LaTeX positions like 'replace the value on line 12' or 'change the amount in the second " +
    "tabularx row'. The next agent will read the LaTeX itself; instructions describe behavior, not file " +
    "geometry.\n" +
    "- Mechanical text-replacement steps like 'do find-and-replace on AMOUNT'. Speak in terms of what the " +
    "document needs, not how to edit the bytes.\n\n" +
    "If you (the agent saving the template) are not sure how a placeholder gets filled or what rule applies, " +
    "ASK THE USER before saving. Do not invent rules, and do not save vague guesses - empty instructions are " +
    "better than wrong instructions. Anti-pattern example: saving 'Use today's date OR ask the user' is a " +
    "vague guess that puts the next agent in the same uncertain spot. Better: ask the user once now, then " +
    "save the resolved rule ('Always use today's date.' or 'Always ask the user for the date.').",
  {
    name: z.string().min(1).max(100).describe("Template name (e.g. 'Monthly Invoice', 'NDA Contract')"),
    latex_content: z
      .string()
      .min(1)
      .max(512_000)
      .optional()
      .describe(
        "LaTeX source code to save as template. Required for a new template. May be omitted when updating only " +
          "the description or instructions, or when converting the saved source with placeholder_engine \"liquid\".",
      ),
    description: z.string().max(500).optional().describe("Short description of what this template is for (max 500 characters)"),
    instructions: z
      .string()
      // Mirrors Rails Template::MAX_INSTRUCTIONS_LENGTH; keep both in sync if the cap moves.
      .max(50_000)
      .optional()
      .describe(
        "Optional prose markdown describing template-level behavior rules for future AI agents that will use " +
          "this template. This is NOT a per-field schema - it is narrative guidance: defaults, workflow rules, " +
          "computed values, conditional logic, edge cases. The next agent reads this together with the LaTeX " +
          "and uses it to fill the template correctly without re-asking the user. Omit if the template is " +
          "fully static, or if you are not sure what rules apply (ask the user first).",
      ),
    placeholder_engine: z
      .enum(["liquid", "none"])
      .optional()
      .describe(
        "\"liquid\": the source contains Liquid placeholders to be filled by the render tool (also converts an " +
          "existing raw LaTeX template). \"none\": raw LaTeX whose braces only look like placeholders. Omit to keep " +
          "the template's current kind.",
      ),
  },
  async ({ name, latex_content, description, instructions, placeholder_engine }) => {
    try {
      const result = await client.saveTemplate(name, {
        latexContent: latex_content,
        description,
        instructions,
        placeholderEngine: placeholder_engine,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- list_templates tool ---

authedTool(
  "list_templates",
  "List all saved templates for the current user. Returns template names, descriptions, last-updated dates, " +
    "a `has_instructions` boolean, and Pressa Studio metadata (`studio_compatible` + `studio_url`) per " +
    "template. Use this to find existing templates before creating new ones - e.g. when user says 'use my " +
    "invoice template' or 'what templates do I have'. When `has_instructions` is true, call get_template to " +
    "fetch the full instructions before filling the template in.\n\n" +
    "STUDIO LINKS: when a user asks something like 'open my invoice template in Studio', look up the matching " +
    "entry here and hand back the `studio_url` field verbatim. It's an absolute URL " +
    "(`https://pressa.dev/studio/tpl/<id>`) that opens the template in the interactive editor. If " +
    "`studio_compatible` is false, the template is raw LaTeX and Studio template authoring doesn't apply - tell " +
    "the user the template still works for `compile` calls, and can be converted in place to a placeholder " +
    "template with save_template and placeholder_engine \"liquid\". If `studio_url` is null on a `studio_compatible` " +
    "row, Studio is disabled on this deployment - do not invent a URL.",
  async () => {
    try {
      const result = await client.listTemplates();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- get_template tool ---

authedTool(
  "get_template",
  "Retrieve a saved template by name or ID. Returns the full LaTeX source code plus an optional " +
    "`instructions` field containing prose markdown that describes template-level behavior rules for AI " +
    "agents.\n\n" +
    "READ THE INSTRUCTIONS BEFORE FILLING THE TEMPLATE. If the returned `instructions` field is non-null, it " +
    "is the user's narrative guide to how this template is supposed to be filled - defaults, workflow rules, " +
    "computed values, conditional logic, edge cases. Apply those rules when generating the next document " +
    "from this template. Examples of what you may find:\n" +
    "- 'Use today's date if the user does not specify one.' -> set the date to today, do not ask.\n" +
    "- 'Invoice number is YYYYMMDD-N where N counts invoices in the user's library for this calendar year.' " +
    "-> compute N from list_templates / library state, do not ask.\n" +
    "- 'For EU clients add a VAT line at 20%.' -> add or omit the VAT line based on the client.\n" +
    "- 'Always ask the user for the amount.' -> do ask, even if you could guess.\n\n" +
    "If `instructions` is null or absent, the template is either fully static or the original author did not " +
    "attach behavior rules - fall back to asking the user about any dynamic-looking placeholders rather than " +
    "guessing. If `instructions` and the LaTeX appear to disagree, the instructions take precedence (they are " +
    "the user's stated intent for behavior); flag the conflict to the user only if it changes the output.",
  {
    id_or_name: z.string().min(1).describe("Template name or numeric ID"),
  },
  async ({ id_or_name }) => {
    try {
      const result = await client.getTemplate(id_or_name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- delete_template tool ---

authedTool(
  "delete_template",
  "Delete a saved template by name or ID. This action cannot be undone.",
  {
    id_or_name: z.string().min(1).describe("Template name or numeric ID"),
  },
  async ({ id_or_name }) => {
    try {
      await client.deleteTemplate(id_or_name);
      return {
        content: [{ type: "text", text: JSON.stringify({ message: "Template deleted successfully" }) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- save_asset tool ---

authedTool(
  "save_asset",
  "Save or update a binary file (logo, photo, signature, PDF, SVG) in the user's persistent asset library. " +
    "The asset is keyed by name; passing an existing name overwrites it. Once saved, future compile calls can " +
    "reference the file via use_stored_assets: [\"name\"] without re-encoding the bytes every time - saves " +
    "round-trip bandwidth and latency for files you reuse (company logos, signatures, letterheads). Paid plan " +
    "feature.\n\n" +
    "Supported formats: PNG, JPG, JPEG, PDF, SVG (magic bytes verified server-side). Filenames must be plain: " +
    "alphanumeric plus _ -, single extension, max 64 chars.\n\n" +
    "Workflow example: the user uploads a PDF with their company logo, then asks for a monthly invoice. Extract " +
    "the logo as PNG, call save_asset({ name: \"logo.png\", content_base64: \"iVBOR...\" }) once, and from then " +
    "on any invoice/contract/report compile uses use_stored_assets: [\"logo.png\"] instead of re-sending the " +
    "logo bytes.",
  {
    name: z.string().min(1).max(64).describe("Filename (e.g. 'logo.png')"),
    content_base64: z
      .string()
      .min(1)
      .max(10_485_760)
      .describe(
        "Base64-encoded binary content. Soft client-side cap; the server enforces the actual per-plan quota.",
      ),
    content_type: z
      .string()
      .optional()
      .describe("MIME type (e.g. 'image/png'). Inferred from the filename extension if omitted."),
  },
  async ({ name, content_base64, content_type }) => {
    try {
      const result = await client.saveAsset(name, content_base64, content_type);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- list_assets tool ---

authedTool(
  "list_assets",
  "List all saved assets in the user's persistent asset library with metadata and quota usage " +
    "(count, total_bytes, remaining_bytes). Takes no parameters.",
  async () => {
    try {
      const result = await client.listAssets();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- get_asset tool ---

authedTool(
  "get_asset",
  "Retrieve an asset's metadata and base64-encoded binary content by name or ID. Use this if the agent needs " +
    "to re-inspect the bytes, not for compilation (compile uses use_stored_assets which handles the lookup " +
    "server-side).",
  {
    id_or_name: z.string().min(1).describe("Asset name or numeric ID"),
  },
  async ({ id_or_name }) => {
    try {
      const result = await client.getAsset(id_or_name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatError(error);
    }
  },
);

// --- delete_asset tool ---

authedTool(
  "delete_asset",
  "Delete an asset from the user's library by name or ID. After deletion, compiles referencing the name via " +
    "use_stored_assets will fail with asset_not_found.",
  {
    id_or_name: z.string().min(1).describe("Asset name or numeric ID"),
  },
  async ({ id_or_name }) => {
    try {
      await client.deleteAsset(id_or_name);
      return {
        content: [{ type: "text", text: JSON.stringify({ message: "Asset deleted successfully" }) }],
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
