#!/usr/bin/env node
/**
 * OpenMAIC MCP server — exposes the open.maic.chat classroom generation API
 * (or any self-hosted OpenMAIC instance) as MCP tools.
 *
 * Configuration (environment variables):
 *   OPENMAIC_BASE_URL     Base URL of the OpenMAIC instance.
 *                         Default: https://open.maic.chat
 *   OPENMAIC_ACCESS_CODE  Access code (starts with sk-) from open.maic.chat.
 *                         Sent as `Authorization: Bearer <code>` on every request.
 *                         Required for the hosted instance; optional for
 *                         self-hosted instances without ACCESS_CODE set.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.OPENMAIC_BASE_URL || "https://open.maic.chat").replace(/\/+$/, "");
const ACCESS_CODE = process.env.OPENMAIC_ACCESS_CODE || "";

function authHeaders(): Record<string, string> {
  return ACCESS_CODE ? { Authorization: `Bearer ${ACCESS_CODE}` } : {};
}

interface ApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

/** Map common HTTP errors to actionable messages (per the OpenMAIC hosted-mode contract). */
function describeError(status: number, body: unknown): string {
  const detail = typeof body === "string" ? body : JSON.stringify(body);
  if (status === 401) {
    return `401 Unauthorized — the access code is invalid or missing. Set OPENMAIC_ACCESS_CODE (get one at ${BASE_URL}). Server said: ${detail}`;
  }
  if (status === 403) {
    return `403 Forbidden — likely the daily generation quota (10/day on the hosted instance) is exhausted; it resets at midnight. Server said: ${detail}`;
  }
  return `HTTP ${status}: ${detail}`;
}

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer({
  name: "openmaic",
  version: "0.1.0",
});

server.registerTool(
  "check_health",
  {
    title: "Check OpenMAIC health",
    description:
      "Verify connectivity and authentication with the OpenMAIC server, and report which optional " +
      "capabilities (webSearch, imageGeneration, videoGeneration, tts) it supports. Call this before " +
      "generate_classroom when you intend to enable optional features — only enable a feature flag if " +
      "the corresponding capability is true.",
    inputSchema: {},
  },
  async () => {
    const res = await api("/api/health");
    if (!res.ok) return errorContent(describeError(res.status, res.body));
    return jsonContent(res.body);
  },
);

server.registerTool(
  "generate_classroom",
  {
    title: "Generate an AI classroom",
    description:
      "Submit an asynchronous classroom generation job to OpenMAIC. Turns a topic description (and " +
      "optionally parsed PDF content) into a full interactive lesson with slides, quizzes, and AI " +
      "teacher/classmate agents. Returns a jobId immediately — generation takes minutes, so poll with " +
      "get_job_status until status is 'succeeded' or 'failed'. Do not submit another job while one is " +
      "still queued or running.",
    inputSchema: {
      requirement: z
        .string()
        .min(1)
        .describe(
          'What to teach, e.g. "Create an introductory classroom on quantum mechanics for high school students"',
        ),
      pdfContent: z
        .string()
        .optional()
        .describe("Parsed text content of a reference PDF (from the parse_pdf tool)"),
      language: z
        .enum(["zh-CN", "en-US"])
        .optional()
        .describe('Lesson language. Defaults to "zh-CN" on the server.'),
      enableWebSearch: z
        .boolean()
        .optional()
        .describe("Include web search context in outline generation (requires webSearch capability)"),
      enableImageGeneration: z
        .boolean()
        .optional()
        .describe("Allow generated images in slides (requires imageGeneration capability)"),
      enableVideoGeneration: z
        .boolean()
        .optional()
        .describe("Allow generated videos in slides (requires videoGeneration capability)"),
      enableTTS: z
        .boolean()
        .optional()
        .describe("Generate server-side TTS narration audio (requires tts capability)"),
      agentMode: z
        .enum(["default", "generate"])
        .optional()
        .describe(
          '"default" uses built-in agents; "generate" lets the LLM create agent profiles tailored to the course',
        ),
    },
  },
  async (input) => {
    const res = await api("/api/generate-classroom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return errorContent(describeError(res.status, res.body));
    return jsonContent(res.body);
  },
);

server.registerTool(
  "get_job_status",
  {
    title: "Check classroom generation job",
    description:
      "Poll the status of a classroom generation job. Returns status (queued | running | succeeded | " +
      "failed), step, progress, scenesGenerated/totalScenes, and — once succeeded — result.classroomId " +
      "and result.url (the shareable classroom link). Poll no more often than every 30–60 seconds; never " +
      "resubmit a job because a single poll fails.",
    inputSchema: {
      jobId: z.string().min(1).describe("Job ID returned by generate_classroom"),
    },
  },
  async ({ jobId }) => {
    const res = await api(`/api/generate-classroom/${encodeURIComponent(jobId)}`);
    if (!res.ok) return errorContent(describeError(res.status, res.body));
    return jsonContent(res.body);
  },
);

server.registerTool(
  "parse_pdf",
  {
    title: "Parse a PDF for classroom generation",
    description:
      "Upload a local PDF to the OpenMAIC server and get back its parsed text content, suitable for the " +
      "pdfContent parameter of generate_classroom. Uses the server's default parser unless a providerId " +
      "is given.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path to a local PDF file"),
      providerId: z
        .string()
        .optional()
        .describe('PDF parsing provider, e.g. "unpdf" (default) or "mineru"'),
    },
  },
  async ({ filePath, providerId }) => {
    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch (err) {
      return errorContent(`Could not read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const form = new FormData();
    form.append("pdf", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), basename(filePath));
    if (providerId) form.append("providerId", providerId);

    const res = await api("/api/parse-pdf", { method: "POST", body: form });
    if (!res.ok) return errorContent(describeError(res.status, res.body));
    return jsonContent(res.body);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`OpenMAIC MCP server connected (base URL: ${BASE_URL}, auth: ${ACCESS_CODE ? "yes" : "no"})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
