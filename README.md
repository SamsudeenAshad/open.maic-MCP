# open.maic-MCP

MCP (Model Context Protocol) server for [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) — generate AI-powered interactive classrooms at [open.maic.chat](https://open.maic.chat/) (or any self-hosted OpenMAIC instance) directly from Claude Code, Claude Desktop, or any other MCP client.

## Tools

| Tool | Description |
|------|-------------|
| `check_health` | Verify connectivity/auth and report server capabilities (`webSearch`, `imageGeneration`, `videoGeneration`, `tts`) |
| `generate_classroom` | Submit an async classroom generation job from a topic description (optionally with parsed PDF content, language, feature flags, agent mode) |
| `get_job_status` | Poll a generation job until it's `succeeded` or `failed`; returns the classroom ID and shareable URL on success |
| `parse_pdf` | Upload a local PDF and get back parsed text for use as `pdfContent` in `generate_classroom` |

## Setup

Requires Node.js >= 20.

```bash
npm install
npm run build
```

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `OPENMAIC_BASE_URL` | `https://open.maic.chat` | OpenMAIC instance to talk to (set to e.g. `http://localhost:3000` for self-hosted) |
| `OPENMAIC_ACCESS_CODE` | _(none)_ | Access code (starts with `sk-`) from [open.maic.chat](https://open.maic.chat/). Sent as `Authorization: Bearer <code>`. Required for the hosted instance's generation endpoints; optional for self-hosted instances without `ACCESS_CODE` |

### Claude Code

```bash
claude mcp add openmaic \
  -e OPENMAIC_ACCESS_CODE=sk-your-code \
  -- node /path/to/open.maic-MCP/dist/index.js
```

### Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "openmaic": {
      "command": "node",
      "args": ["/path/to/open.maic-MCP/dist/index.js"],
      "env": {
        "OPENMAIC_ACCESS_CODE": "sk-your-code"
      }
    }
  }
}
```

## Usage

Just ask your assistant, e.g.:

> Teach me quantum physics — generate an OpenMAIC classroom for it.

The typical flow the model follows:

1. `check_health` — confirm the server is reachable and see which optional capabilities are available.
2. `generate_classroom` — submit the job (only enabling feature flags the server supports). Returns a `jobId` immediately.
3. `get_job_status` — poll every 30–60 s until `status` is `succeeded`, then open `result.url` (e.g. `https://open.maic.chat/classroom/<id>`).

For PDF-based lessons, call `parse_pdf` first and pass the returned text as `pdfContent`.

### Notes

- The hosted instance allows **10 generations per day** per access code; a `403` means the quota is exhausted (resets at midnight).
- A `401` means the access code is missing or invalid — get one at [open.maic.chat](https://open.maic.chat/).
- Generation takes several minutes. Never resubmit a job because a single poll failed; keep polling the same `jobId`.

## Development

```bash
npm run dev        # run from source with tsx
npm run typecheck  # type-check without emitting
```

## License

[AGPL-3.0](LICENSE) — same as OpenMAIC.
