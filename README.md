# @pressa/mcp

MCP (Model Context Protocol) server for [Pressa](https://pressa.dev) — a LaTeX-to-PDF compilation service. This server lets AI assistants compile LaTeX documents and check API usage through a standardized interface.

## Setup

Add this to your MCP client configuration (e.g. Claude Desktop, Cursor):

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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRESSA_API_KEY` | Yes | — | Your Pressa API key (starts with `pressa_`) |
| `PRESSA_API_URL` | No | `https://api.pressa.dev` | API base URL |

## Tools

### `compile`

Compile LaTeX source code into a PDF.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `latex` | string | Yes | LaTeX source code |
| `compiler` | string | No | `"pdflatex"`, `"xelatex"`, or `"lualatex"` |

**Output (success):**

```json
{
  "pdf_url": "https://api.pressa.dev/downloads/abc123.pdf",
  "pages": 3,
  "compilation_time_ms": 1250,
  "expires_at": "2026-04-04T12:00:00Z"
}
```

**Output (error):** Compilation log and error line number.

### `usage`

Get current API usage statistics.

**Input:** None.

**Output:**

```json
{
  "plan": "pro",
  "compilations_this_month": 142,
  "monthly_limit": 1000,
  "remaining": 858,
  "resets_at": "2026-05-01T00:00:00Z"
}
```

## Development

```bash
npm install
npm run build
npm start
```

## License

MIT
