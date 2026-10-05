import { describe, expect, it } from "vitest";
import {
  type CallTool,
  McpResumeSource,
  type ToolResult,
} from "../../src/lib/resume/github-mcp.js";

const REPO = { owner: "PCBZ", repo: "Resume", ref: "main" };

function fake(result: ToolResult) {
  const calls: [string, Record<string, unknown>][] = [];
  const callTool: CallTool = async (name, args) => {
    calls.push([name, args]);
    return result;
  };
  return { calls, source: new McpResumeSource(callTool, REPO) };
}

describe("McpResumeSource", () => {
  it("lists a directory from the JSON contents array", async () => {
    const listing = [
      { name: "Resume.tex", path: "General/Resume.tex", type: "file", size: 10 },
      { name: "old", path: "General/old", type: "dir" },
      { name: "link", path: "General/link", type: "symlink" },
    ];
    const { calls, source } = fake({ content: [{ type: "text", text: JSON.stringify(listing) }] });
    expect(await source.listDir("General")).toEqual([
      { name: "Resume.tex", path: "General/Resume.tex", type: "file" },
      { name: "old", path: "General/old", type: "dir" },
    ]);
    expect(calls).toEqual([
      [
        "get_file_contents",
        { owner: "PCBZ", repo: "Resume", path: "General", ref: "refs/heads/main" },
      ],
    ]);
  });

  it("asks for / when listing the repository root", async () => {
    const { calls, source } = fake({ content: [{ type: "text", text: "[]" }] });
    await source.listDir("");
    expect(calls[0]?.[1]).toMatchObject({ path: "/" });
  });

  it("passes a full ref through unchanged", async () => {
    const calls: Record<string, unknown>[] = [];
    const source = new McpResumeSource(
      async (_n, args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "[]" }] };
      },
      { ...REPO, ref: "refs/tags/v2" },
    );
    await source.listDir("General");
    expect(calls[0]).toMatchObject({ ref: "refs/tags/v2" });
  });

  it("reads a file from the embedded resource, text or base64 blob", async () => {
    const text = fake({
      content: [
        { type: "text", text: "successfully downloaded text file" },
        {
          type: "resource",
          resource: { uri: "repo://x", mimeType: "text/x-tex", text: "\\section{A}" },
        },
      ],
    });
    expect(await text.source.readFile("General/Resume.tex")).toBe("\\section{A}");
    const blob = fake({
      content: [
        {
          type: "resource",
          resource: { uri: "repo://x", blob: Buffer.from("é").toString("base64") },
        },
      ],
    });
    expect(await blob.source.readFile("x.tex")).toBe("é");
  });

  it("surfaces tool errors and missing payloads", async () => {
    const err = fake({ isError: true, content: [{ type: "text", text: "404 Not Found" }] });
    await expect(err.source.readFile("nope.tex")).rejects.toThrow(
      'get_file_contents failed for "nope.tex": 404 Not Found',
    );
    const empty = fake({ content: [{ type: "text", text: "not json" }] });
    await expect(empty.source.listDir("General")).rejects.toThrow("returned no directory listing");
    await expect(empty.source.readFile("a.tex")).rejects.toThrow("returned no file content");
  });
});
