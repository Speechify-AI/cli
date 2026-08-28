// SpeechifyAI MCP server — exposes docs search + TTS tools to MCP clients (Claude
// Code, Cursor, Claude Desktop, …).
//
// All tools are always registered so they stay discoverable regardless of auth
// state. `search_docs` needs no auth. The TTS tools resolve our auth (console
// Bearer + workspace, or an API key) FRESH per call via resolveAuth(): a server
// started before `speechifyai login` starts working the moment you log in — no
// restart — and a short-lived ID token self-heals. When auth is missing, the call
// surfaces a clear "run login" error (the MCP SDK returns the CliError message as
// an isError tool result) rather than the tool silently not existing.
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeStreamToFile } from "../audio/sink.js";
import { type AuthInput, requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { resolveTimeoutMs } from "../core/fetchWithTimeout.js";
import {
  AUDIO_FORMATS,
  AUDIO_MIME,
  DEFAULT_STREAM_FORMAT,
  DEFAULT_VOICE,
  MAX_SPEECH_INPUT,
  MAX_STREAM_INPUT,
  SPEECH_MODELS,
  STREAM_FORMATS,
  streamSpeech,
  synthesize,
} from "../core/speech.js";
import { readStreamChunks } from "../core/stream.js";
import { getVoice, listVoices } from "../core/voices.js";

/** Public, unauthenticated docs MCP server hosted by Fern for docs.speechify.ai. */
const DOCS_MCP_URL = "https://docs.speechify.ai/_mcp/server";

/**
 * Proxy a query to the public Speechify docs MCP server. We connect as an MCP
 * client, discover the search tool (resilient to its exact name/argument), call
 * it, and return the text blocks. No API key required.
 */
async function callDocsSearch(query: string): Promise<string> {
  const client = new Client({ name: "speechifyai-cli", version: __CLI_VERSION__ });
  await client.connect(new StreamableHTTPClientTransport(new URL(DOCS_MCP_URL)));
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => /search/i.test(t.name)) ?? tools[0];
    if (!tool) throw new Error("The Speechify docs MCP server exposed no tools.");

    // Use the tool's first required (or first declared) property as the query arg.
    const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const argName = schema.required?.[0] ?? Object.keys(schema.properties ?? {})[0] ?? "query";

    const result = await client.callTool({ name: tool.name, arguments: { [argName]: query } });
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return (
      blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n\n") || "(no textual results)"
    );
  } finally {
    await client.close();
  }
}

export interface ServerOptions {
  /** Per-invocation auth overrides; resolveAuth() applies flag/env/stored precedence. */
  authInput?: AuthInput;
}

/**
 * Build the SpeechifyAI MCP server. All tools are always registered; the TTS tools
 * resolve auth per call and surface a clear error when the caller isn't authed.
 */
export function buildServer({ authInput = {} }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "speechifyai", version: __CLI_VERSION__ });

  server.registerTool(
    "search_docs",
    {
      description:
        "Search the Speechify documentation (docs.speechify.ai) and return relevant excerpts. No API key required.",
      inputSchema: { query: z.string().describe("What to look up in the Speechify docs") },
    },
    async ({ query }) => ({ content: [{ type: "text", text: await callDocsSearch(query) }] }),
  );

  // Resolve auth + a TTS client per call so the ID token stays fresh and a login
  // that happens after the server starts is picked up without a restart. On
  // failure this throws a CliError whose message the SDK returns as a tool error.
  const ttsClient = async () => {
    const auth = await resolveAuth(authInput);
    requireWorkspace(auth);
    return createClient({
      bearer: auth.bearer,
      tenantId: auth.tenantId,
      apiVersion: auth.apiVersion,
      baseUrl: auth.baseUrl,
    });
  };

  server.registerTool(
    "list_voices",
    {
      description:
        "List the Speechify voices available to the authenticated account. Requires a `speechifyai login` session or SPEECHIFY_API_KEY.",
      inputSchema: {},
    },
    async () => {
      const voices = await listVoices(await ttsClient());
      return { content: [{ type: "text", text: JSON.stringify(voices, null, 2) }] };
    },
  );

  server.registerTool(
    "get_voice",
    {
      description:
        "Fetch one Speechify voice by id, with the models it supports, the locales each model covers, its tags, and its preview URLs. Use it to confirm a voice id is usable before synthesizing, instead of listing the whole catalog. Requires a `speechifyai login` session or SPEECHIFY_API_KEY.",
      inputSchema: {
        voiceId: z.string().describe("Id of the voice to fetch (see list_voices), e.g. 'george'"),
      },
    },
    async ({ voiceId }) => {
      const voice = await getVoice(await ttsClient(), voiceId);
      return { content: [{ type: "text", text: JSON.stringify(voice, null, 2) }] };
    },
  );

  server.registerTool(
    "text_to_speech",
    {
      description:
        "Synthesize speech audio from text or SSML using Speechify. Returns the audio inline, or writes it to outputPath when provided. Requires a `speechifyai login` session or SPEECHIFY_API_KEY.",
      inputSchema: {
        input: z.string().describe("Plain text or SSML to synthesize"),
        voiceId: z
          .string()
          .default(DEFAULT_VOICE)
          .describe(`Voice id (see list_voices). Defaults to '${DEFAULT_VOICE}'.`),
        model: z.enum(SPEECH_MODELS).optional().describe("Synthesis model"),
        audioFormat: z.enum(AUDIO_FORMATS).default("mp3").describe("Output audio format"),
        language: z.string().optional().describe("Input language as BCP-47 (e.g. en-US)"),
        outputPath: z
          .string()
          .optional()
          .describe("If set, write the audio to this file and return the path instead of inline audio."),
      },
    },
    async ({ input, voiceId, model, audioFormat, language, outputPath }) => {
      const result = await synthesize(await ttsClient(), {
        input,
        voiceId,
        model,
        format: audioFormat,
        language,
      });

      if (outputPath) {
        await writeFile(outputPath, result.audio);
        return {
          content: [
            {
              type: "text",
              text: `Wrote ${result.audio.length} bytes (${result.format}) to ${outputPath}. Billable characters: ${result.billableCharacters}.`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "audio", data: result.audio.toString("base64"), mimeType: AUDIO_MIME[result.format] },
          {
            type: "text",
            text: `Synthesized ${result.audio.length} bytes (${result.format}). Billable characters: ${result.billableCharacters}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "stream_text_to_speech",
    {
      description:
        `Synthesize long-form speech (up to ${MAX_STREAM_INPUT} characters) and write it to outputPath as it is generated. ` +
        `Reach for this instead of text_to_speech whenever the text exceeds ${MAX_SPEECH_INPUT} characters, or when the audio should stay out of the conversation. ` +
        "Returns the path and byte count, never the audio itself. Requires a `speechifyai login` session or SPEECHIFY_API_KEY.",
      inputSchema: {
        input: z.string().describe("Plain text or SSML to synthesize"),
        outputPath: z
          .string()
          .describe("File to write the audio to. Required: streamed audio is never returned inline."),
        voiceId: z
          .string()
          .default(DEFAULT_VOICE)
          .describe(`Voice id (see list_voices). Defaults to '${DEFAULT_VOICE}'.`),
        model: z.enum(SPEECH_MODELS).optional().describe("Synthesis model"),
        audioFormat: z
          .enum(STREAM_FORMATS)
          .default(DEFAULT_STREAM_FORMAT)
          .describe("Output audio format (wav is unavailable on the streaming route)"),
        language: z.string().optional().describe("Input language as BCP-47 (e.g. en-US)"),
      },
    },
    async ({ input, outputPath, voiceId, model, audioFormat, language }) => {
      const result = await streamSpeech(await ttsClient(), {
        input,
        voiceId,
        model,
        format: audioFormat,
        language,
      });
      const bytes = await writeStreamToFile(
        readStreamChunks(result.body, { stallTimeoutMs: resolveTimeoutMs() }),
        outputPath,
      );
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${bytes} bytes of ${result.audio.codec} audio to ${outputPath}. The streaming route reports no billable character count.`,
          },
        ],
      };
    },
  );

  return server;
}
