# open.maic-MCP — Architecture

MCP (Model Context Protocol) server that exposes the **OpenMAIC** classroom-generation
API ([open.maic.chat](https://open.maic.chat/), or any self-hosted instance) as a set of
tools usable from any MCP client (Claude Code, Claude Desktop, etc.).

- **Transport:** stdio (`StdioServerTransport`)
- **SDK:** `@modelcontextprotocol/sdk` + `zod` for input schemas
- **Runtime:** Node.js ≥ 20 (uses global `fetch` / `FormData` / `Blob`)
- **Entry point:** [src/index.ts](src/index.ts) → `dist/index.js`

---

## 1. System Context (C4 — Level 1)

```mermaid
flowchart LR
    user(["👤 User"])
    client["MCP Client<br/>(Claude Code / Desktop)"]
    mcp["open.maic-MCP<br/>(this server)"]
    api["OpenMAIC Instance<br/>open.maic.chat / self-hosted"]

    user -->|"natural-language request"| client
    client <-->|"MCP over stdio<br/>(JSON-RPC)"| mcp
    mcp <-->|"HTTPS + Bearer auth<br/>(REST/JSON)"| api

    classDef ext fill:#e8f0fe,stroke:#4285f4;
    classDef sys fill:#d9ead3,stroke:#38761d;
    class user,client,api ext;
    class mcp sys;
```

---

## 2. Container / Component View

```mermaid
flowchart TB
    subgraph CLIENT["MCP Client"]
        llm["LLM agent loop"]
    end

    subgraph SERVER["open.maic-MCP  (src/index.ts)"]
        direction TB
        transport["StdioServerTransport<br/>JSON-RPC framing"]
        mcpcore["McpServer&nbsp;'openmaic' v0.1.0"]

        subgraph TOOLS["Registered tools (zod-validated)"]
            t1["check_health"]
            t2["generate_classroom"]
            t3["get_job_status"]
            t4["parse_pdf"]
        end

        subgraph HELPERS["HTTP layer & helpers"]
            apifn["api(path, init)<br/>fetch wrapper"]
            auth["authHeaders()<br/>Bearer token"]
            err["describeError()<br/>401 / 403 / HTTP"]
            fmt["jsonContent() /<br/>errorContent()"]
        end

        cfg["Config (env)<br/>OPENMAIC_BASE_URL<br/>OPENMAIC_ACCESS_CODE"]
    end

    subgraph OPENMAIC["OpenMAIC REST API"]
        e1["GET /api/health"]
        e2["POST /api/generate-classroom"]
        e3["GET /api/generate-classroom/:jobId"]
        e4["POST /api/parse-pdf"]
    end

    llm <-->|stdio| transport
    transport --> mcpcore
    mcpcore --> TOOLS

    t1 --> apifn
    t2 --> apifn
    t3 --> apifn
    t4 --> apifn

    apifn --> auth
    apifn --> err
    TOOLS --> fmt
    auth -.reads.-> cfg
    apifn -.reads.-> cfg

    t1 --> e1
    t2 --> e2
    t3 --> e3
    t4 --> e4

    classDef tool fill:#fff2cc,stroke:#bf9000;
    classDef help fill:#f4cccc,stroke:#a61c00;
    classDef ep fill:#d9d2e9,stroke:#674ea7;
    class t1,t2,t3,t4 tool;
    class apifn,auth,err,fmt help;
    class e1,e2,e3,e4 ep;
```

### Tool → endpoint mapping

| MCP Tool | HTTP call | Purpose |
|----------|-----------|---------|
| `check_health` | `GET /api/health` | Connectivity/auth check + capability flags (`webSearch`, `imageGeneration`, `videoGeneration`, `tts`) |
| `generate_classroom` | `POST /api/generate-classroom` | Submit async job; returns `jobId` |
| `get_job_status` | `GET /api/generate-classroom/:jobId` | Poll `queued → running → succeeded/failed`; returns `result.url` |
| `parse_pdf` | `POST /api/parse-pdf` (multipart) | Reads local PDF, uploads as `Blob`, returns parsed text |

---

## 3. Request Pipeline (every tool call)

```mermaid
flowchart LR
    A["Tool handler"] --> B["api(path, init)"]
    B --> C["merge authHeaders()<br/>+ Bearer token"]
    C --> D["fetch BASE_URL + path"]
    D --> E["read body → JSON.parse<br/>(fallback: raw text)"]
    E --> F{"res.ok?"}
    F -->|yes| G["jsonContent(body)"]
    F -->|no| H["describeError(status, body)<br/>→ errorContent (isError)"]

    classDef ok fill:#d9ead3,stroke:#38761d;
    classDef no fill:#f4cccc,stroke:#a61c00;
    class G ok;
    class H no;
```

---

## 4. Typical End-to-End Flow

```mermaid
sequenceDiagram
    actor User
    participant Client as MCP Client (LLM)
    participant MCP as open.maic-MCP
    participant API as OpenMAIC API

    User->>Client: "Teach me quantum physics"

    opt PDF-based lesson
        Client->>MCP: parse_pdf(filePath)
        MCP->>API: POST /api/parse-pdf (multipart)
        API-->>MCP: parsed text
        MCP-->>Client: pdfContent
    end

    Client->>MCP: check_health()
    MCP->>API: GET /api/health
    API-->>MCP: { capabilities }
    MCP-->>Client: webSearch/image/video/tts flags

    Client->>MCP: generate_classroom(requirement, flags)
    MCP->>API: POST /api/generate-classroom
    API-->>MCP: { jobId }
    MCP-->>Client: jobId

    loop poll every 30–60s
        Client->>MCP: get_job_status(jobId)
        MCP->>API: GET /api/generate-classroom/:jobId
        API-->>MCP: { status, step, progress }
        MCP-->>Client: status
    end

    Note over Client,API: status == succeeded
    Client-->>User: result.url<br/>(open.maic.chat/classroom/:id)
```

---

## 5. Cross-cutting concerns

- **Auth:** `OPENMAIC_ACCESS_CODE` (starts with `sk-`) sent as `Authorization: Bearer <code>`
  on every request via `authHeaders()`. Optional for self-hosted instances.
- **Config:** `OPENMAIC_BASE_URL` (default `https://open.maic.chat`); trailing slashes stripped.
- **Error mapping** (`describeError`):
  - `401` → invalid/missing access code
  - `403` → daily quota exhausted (hosted: 10 generations/day, resets midnight)
  - other → `HTTP <status>: <detail>`
- **Async contract:** generation is long-running — submit once, then poll; never resubmit on a failed poll.
- **Stateless:** the server holds no session state; each tool call is an independent HTTP request.
