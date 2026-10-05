// ResumeSource over the GitHub REST contents API. Auth is a fine-grained PAT
// with read-only Contents on the resume repository, so it can read that
// repository and nothing else.

import type { DirEntry, ResumeSource } from "./source.js";

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit SHA. */
  ref: string;
}

const API = "https://api.github.com";

export class GithubRestResumeSource implements ResumeSource {
  constructor(
    private readonly token: string,
    private readonly repo: RepoRef,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async get(path: string, accept: string): Promise<Response> {
    const encoded = path
      .split("/")
      .filter((p) => p !== "")
      .map(encodeURIComponent)
      .join("/");
    const url =
      `${API}/repos/${this.repo.owner}/${this.repo.repo}/contents${encoded ? `/${encoded}` : ""}` +
      `?ref=${encodeURIComponent(this.repo.ref)}`;
    const res = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "job-scan",
      },
    });
    if (!res.ok) {
      // 404 also means "this token can't see the repository".
      const body = await res.text();
      let message = body.slice(0, 200);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {}
      throw new Error(`GitHub contents ${res.status} for "${path || "/"}": ${message}`);
    }
    return res;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const data: unknown = await (await this.get(path, "application/vnd.github+json")).json();
    if (!Array.isArray(data)) throw new Error(`"${path || "/"}" is not a directory`);
    return data.flatMap((e: { name?: unknown; path?: unknown; type?: unknown }) =>
      typeof e.name === "string" &&
      typeof e.path === "string" &&
      (e.type === "file" || e.type === "dir")
        ? [{ name: e.name, path: e.path, type: e.type }]
        : [],
    );
  }

  async readFile(path: string): Promise<string> {
    // The raw media type returns the file itself: no base64, no 1 MB limit.
    return (await this.get(path, "application/vnd.github.raw+json")).text();
  }
}
