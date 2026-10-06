import { describe, expect, it } from "vitest";
import { GithubRestResumeSource } from "../../src/lib/resume/github-rest.js";
import { ResumeNotFoundError } from "../../src/lib/resume/source.js";

const REPO = { owner: "PCBZ", repo: "Resume", ref: "main" };

function fake(status: number, body: unknown, contentType = "application/json") {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { calls, source: new GithubRestResumeSource("t0ken", REPO, fetchFn) };
}

describe("GithubRestResumeSource", () => {
  it("lists a directory through the contents API", async () => {
    const { calls, source } = fake(200, [
      { name: "Resume.tex", path: "General/Resume.tex", type: "file", size: 10 },
      { name: "old", path: "General/old", type: "dir" },
      { name: "link", path: "General/link", type: "symlink" },
    ]);
    expect(await source.listDir("General")).toEqual([
      { name: "Resume.tex", path: "General/Resume.tex", type: "file" },
      { name: "old", path: "General/old", type: "dir" },
    ]);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/PCBZ/Resume/contents/General?ref=main",
    );
    expect(calls[0]?.headers).toMatchObject({
      Authorization: "Bearer t0ken",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("lists the repository root and encodes path segments", async () => {
    const root = fake(200, []);
    await root.source.listDir("");
    expect(root.calls[0]?.url).toBe("https://api.github.com/repos/PCBZ/Resume/contents?ref=main");
    const spaced = fake(200, []);
    await spaced.source.listDir("My Resumes/2026#1");
    expect(spaced.calls[0]?.url).toContain("/contents/My%20Resumes/2026%231?ref=main");
  });

  it("reads a file with the raw media type", async () => {
    const { calls, source } = fake(200, "\\section{Experience} é", "application/vnd.github.raw");
    expect(await source.readFile("General/Resume.tex")).toBe("\\section{Experience} é");
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.raw+json");
  });

  it("raises ResumeNotFoundError for 404, with GitHub's message", async () => {
    const { source } = fake(404, { message: "Not Found" });
    const err = await source.readFile("General/nope.tex").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeNotFoundError);
    expect((err as Error).message).toBe('GitHub contents 404 for "General/nope.tex": Not Found');
  });

  it("keeps other failures as ordinary errors", async () => {
    const { source } = fake(403, { message: "Resource not accessible by personal access token" });
    const err = await source.listDir("General").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ResumeNotFoundError);
    expect((err as Error).message).toContain("403");
  });

  it("gives up on a request that stalls", async () => {
    const stalled = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const source = new GithubRestResumeSource("t0ken", REPO, stalled, 20);
    await expect(source.readFile("General/Resume.tex")).rejects.toThrow(/timeout|aborted/i);
  });

  it("rejects listing a path that is a file", async () => {
    const { source } = fake(200, { type: "file", name: "Resume.tex", path: "Resume.tex" });
    await expect(source.listDir("Resume.tex")).rejects.toThrow('"Resume.tex" is not a directory');
  });
});
