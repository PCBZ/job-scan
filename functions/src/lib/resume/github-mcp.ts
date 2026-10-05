// ResumeSource over GitHub's remote MCP server. Auth is a fine-grained PAT
// with read-only Contents on the resume repository; X-MCP-Tools exposes only
// get_file_contents, so the connection can't do anything else.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DirEntry, ResumeSource } from "./source.js";

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const TOOL = "get_file_contents";

/** The subset of an MCP tool result this source reads. */
export interface ToolResult {
  isError?: boolean;
  content: (
    | { type: "text"; text: string }
    | {
        type: "resource";
        resource: { uri: string; mimeType?: string; text?: string; blob?: string };
      }
    | { type: string }
  )[];
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
}

function texts(result: ToolResult): string[] {
  return result.content.flatMap((c) => (c.type === "text" && "text" in c ? [c.text] : []));
}

function failure(path: string, result: ToolResult): Error {
  return new Error(`${TOOL} failed for "${path}": ${texts(result).join(" ").slice(0, 300)}`);
}

export class McpResumeSource implements ResumeSource {
  constructor(
    private readonly callTool: CallTool,
    private readonly repo: RepoRef,
  ) {}

  private call(path: string) {
    return this.callTool(TOOL, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      path: path || "/",
      ref: this.repo.ref.startsWith("refs/") ? this.repo.ref : `refs/heads/${this.repo.ref}`,
    });
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const result = await this.call(path);
    if (result.isError) throw failure(path, result);
    // A directory comes back as a JSON array of GitHub contents entries.
    for (const text of texts(result)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      return parsed.flatMap((e: { name?: unknown; path?: unknown; type?: unknown }) =>
        typeof e.name === "string" &&
        typeof e.path === "string" &&
        (e.type === "file" || e.type === "dir")
          ? [{ name: e.name, path: e.path, type: e.type }]
          : [],
      );
    }
    throw new Error(`${TOOL} returned no directory listing for "${path}"`);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.call(path);
    if (result.isError) throw failure(path, result);
    // A file comes back as an embedded resource holding its text.
    for (const c of result.content) {
      if (c.type === "resource" && "resource" in c) {
        if (typeof c.resource.text === "string") return c.resource.text;
        if (typeof c.resource.blob === "string") {
          return Buffer.from(c.resource.blob, "base64").toString("utf8");
        }
      }
    }
    throw new Error(`${TOOL} returned no file content for "${path}"`);
  }
}

/** A connected MCP client restricted to get_file_contents. */
export async function connectGithubMcp(
  pat: string,
  url: string = GITHUB_MCP_URL,
): Promise<{ callTool: CallTool; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${pat}`, "X-MCP-Tools": TOOL } },
  });
  const client = new Client({ name: "job-scan", version: "0.1.0" });
  // The SDK's own transport fails its Transport type under our
  // exactOptionalPropertyTypes (sessionId?: string); the cast covers only that.
  await client.connect(transport as unknown as Transport);
  return {
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}
