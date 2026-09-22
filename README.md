# @pressa/mcp

MCP (Model Context Protocol) server for [Pressa](https://pressa.dev) - LaTeX in, publication-quality PDF out. This server lets AI assistants compile documents through a standardized interface.

**No API key required to start.** Add the server, ask for a PDF, get one. A key raises the limits later.

## Setup

Add this to your MCP client configuration (e.g. Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "pressa": {
      "command": "npx",
      "args": ["-y", "@pressa/mcp"]
    }
  }
}
```

That is the whole configuration. The server starts in anonymous mode and
exposes the `compile` tool, which works with no credentials: 3 successful
compilations per day, and failed attempts do not count against that, so an
assistant can iterate on its LaTeX for free.

To unlock the rest, add a key:

```json
{
  "mcpServers": {
    "pressa": {
      "command": "npx",
      "args": ["-y", "@pressa/mcp"],
      "env": {
        "PRESSA_API_KEY": "pressa_your_key_here"
      }
    }
  }
}
```

Get a free key at [pressa.dev](https://pressa.dev/users/sign_up). Takes about
30 seconds, no credit card. It raises the limit to 50 compilations per month
and registers the template, asset and render tools.

## Hosted server (no install)

The same tools are also served over Streamable HTTP at
`https://api.pressa.dev/mcp`, so a client that supports remote MCP servers
needs no Node.js and no local process:

```bash
claude mcp add --transport http pressa https://api.pressa.dev/mcp
```

Keyless, it exposes `compile`. Send an `Authorization: Bearer <key>` header to
register the template, asset and render tools as well.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRESSA_API_KEY` | No | - | Pressa API key (starts with `pressa_`). Without it the server runs in anonymous mode and exposes only `compile`. |
| `PRESSA_API_URL` | No | `https://api.pressa.dev` | API base URL |

## Anonymous mode

With no `PRESSA_API_KEY` set, the server starts anyway rather than refusing to
run, and registers exactly one tool: `compile`. Tools that need an account are
not registered at all, because a tool that cannot succeed is worse than an
absent one.

Anonymous limits: pdflatex only, up to 3 pages, 30 KB of source, no image
assets, and PDF links that expire after 1 hour.

## Error handling

Compilation failures return a structured diagnosis rather than a raw TeX log:
the error class, the offending command, and a concrete suggested fix (often a
missing `\usepackage`). An assistant is expected to apply the fix and retry on
its own instead of showing the user a compiler log.

## Tools

### `compile`

Compile LaTeX source code into a PDF.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `latex` | string | Yes | Complete LaTeX source code. Must contain `\documentclass`, `\begin{document}`, `\input{}`, or `\include{}`. Plain text, markdown, or raw notes are rejected with `not_latex_source` (422). The AI agent should generate LaTeX itself, not bounce back to the user. |
| `compiler` | string | No | `"pdflatex"` (default), `"xelatex"`, or `"lualatex"` (Pro and Business plans only) |

Each plan has limits on pages per document, LaTeX source size, PDF output size, and compile timeout. If a compile exceeds your plan's page limit, the document does not count against your monthly quota and the MCP response includes the limit and an upgrade URL. Non-LaTeX input is rejected with a structured `requirements` list and an `example_template` so the LLM can self-correct without user intervention.

**Output (success):**

```json
{
  "job_id": "ffc2bd62-3b67-45d6-be14-b529c4b9489f",
  "pdf_url": "https://api.pressa.dev/api/v1/pdfs/ffc2bd62...?sig=xxx&exp=xxx",
  "expires_at": "2026-04-09T20:44:55Z",
  "pages": 1,
  "compilation_time_ms": 359,
  "usage": {
    "plan": "free",
    "compilations_this_month": 9,
    "monthly_limit": 50
  }
}
```

**Output (error):** Compilation log and error line number.

### `usage`

Get current API usage statistics.

**Input:** None.

**Output:**

```json
{
  "user": {
    "email": "user@example.com",
    "username": "user",
    "plan": "free"
  },
  "usage": {
    "compilations_this_month": 9,
    "monthly_limit": 50,
    "remaining": 41,
    "resets_at": "2026-04-30T23:59:59Z"
  },
  "api_key": {
    "prefix": "pressa_a",
    "name": "my-key",
    "total_requests": 15,
    "last_used_at": "2026-04-08T20:44:55Z"
  }
}
```

### `save_template`

Save or update a LaTeX template by name. Paid plans only. Upserts: a second call with the same name overwrites the first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Template name (max 100 chars). Unique per user. |
| `latex_content` | string | Yes | Full LaTeX source for the template body. |
| `description` | string | No | Short human-readable summary (max 500 chars). Shown in `list_templates`. |
| `instructions` | string | No | Agent playbook (prose markdown, max 50000 chars). Describes how to fill the template - defaults, workflow rules, edge cases, conditional logic. Optional but recommended for templates with dynamic parts. See note below. |

**`description` vs `instructions`:** `description` is the one-line UI summary ("Standard Toptal monthly invoice"). `instructions` is the longer playbook your AI agent reads alongside the LaTeX when filling the template ("Ask the user only for total amount; date is today; invoice number format YYYYMMDD-N where N is sequential count for the calendar year; for EU clients add VAT line"). They are different fields.

### `list_templates`

List the user's saved templates. Does not include `latex_content` or `instructions` to keep the response small.

**Input:** None.

Each item in the returned array carries `id`, `name`, `description`, `updated_at`, `latex_size_bytes`, and `has_instructions` (boolean). Use the `has_instructions` flag to decide whether a follow-up `get_template` call will return a useful playbook.

### `get_template`

Fetch a single template by ID or name. Returns the full `latex_content` plus `instructions` (if any) in one round trip - your agent gets the layout and the playbook together.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id_or_name` | string | Yes | Numeric ID or URL-safe template name. |

### `delete_template`

Delete a template by ID or name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id_or_name` | string | Yes | Numeric ID or URL-safe template name. |

## Development

```bash
npm install
npm run build
npm start
```

## License

MIT
