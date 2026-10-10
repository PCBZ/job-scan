import { describe, expect, it } from "vitest";
import type { ResumeConfig } from "../../src/lib/config/resume.js";
import { EXTRACTOR_VERSION, type Extract, loadResumes } from "../../src/lib/resume/load.js";
import type { DirEntry, ResumeSource } from "../../src/lib/resume/source.js";
import { MemoryTextStore } from "../../src/lib/resume/store.js";

const CFG: ResumeConfig = {
  owner: "PCBZ",
  repo: "Resume",
  ref: "main",
  variants: ["General/*"],
  default: "Resume",
};
const NOW = new Date("2026-10-05T15:00:00Z");

/** A repository whose files can change between loads, or go offline. */
function repo(files: Record<string, string>) {
  const state = { files, offline: false };
  const source: ResumeSource = {
    async listDir(dir) {
      if (state.offline) throw new Error("GitHub contents 503: Service Unavailable");
      return Object.keys(state.files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p): DirEntry => ({ name: p.slice(dir.length + 1), path: p, type: "file" }));
    },
    async readFile(path) {
      if (state.offline) throw new Error("GitHub contents 503: Service Unavailable");
      return state.files[path] as string;
    },
  };
  return { state, source };
}

function counting(): { extract: Extract; calls: string[] } {
  const calls: string[] = [];
  const extract: Extract = (path, src) => {
    calls.push(path);
    return `text of ${src}`;
  };
  return { calls, extract };
}

const FILES = { "General/Resume.tex": "A", "General/Backend.tex": "B" };

describe("loadResumes", () => {
  it("extracts, caches by content hash and records an index", async () => {
    const { source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    const { extract, calls } = counting();
    const set = await loadResumes(CFG, source, store, NOW, extract);
    expect(set.variants).toEqual([
      { path: "General/Backend.tex", name: "Backend", text: "text of B" },
      { path: "General/Resume.tex", name: "Resume", text: "text of A" },
    ]);
    expect(set).toMatchObject({
      defaultPath: "General/Resume.tex",
      stale: false,
      extracted: 2,
      warnings: [],
    });
    expect(calls).toHaveLength(2);
    expect(
      [...store.objects.keys()].filter((k) => k.startsWith(`text/${EXTRACTOR_VERSION}/`)),
    ).toHaveLength(2);
    expect(store.objects.has("index/PCBZ/Resume/main.json")).toBe(true);
  });

  it("does not re-extract unchanged variants, and re-extracts only what changed", async () => {
    const { state, source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    await loadResumes(CFG, source, store, NOW, counting().extract);

    const second = counting();
    expect((await loadResumes(CFG, source, store, NOW, second.extract)).extracted).toBe(0);
    expect(second.calls).toEqual([]);

    state.files["General/Backend.tex"] = "B2";
    const third = counting();
    const set = await loadResumes(CFG, source, store, NOW, third.extract);
    expect(third.calls).toEqual(["General/Backend.tex"]);
    expect(set.variants.find((v) => v.name === "Backend")?.text).toBe("text of B2");
  });

  it("falls back to the last good texts, with a warning, when GitHub fails", async () => {
    const { state, source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    await loadResumes(CFG, source, store, NOW, counting().extract);
    state.offline = true;
    const set = await loadResumes(CFG, source, store, new Date("2026-10-06T15:00:00Z"));
    expect(set.stale).toBe(true);
    expect(set.variants.map((v) => v.text)).toEqual(["text of B", "text of A"]);
    expect(set.warnings).toEqual([
      "Couldn't read resumes from GitHub (GitHub contents 503: Service Unavailable); using the versions from 2026-10-05T15:00:00.000Z.",
    ]);
  });

  it("keeps .tex and .md apart when their bytes are identical", async () => {
    const same = "\\textbf{Go} and Python";
    const { source } = repo({ "General/Resume.md": same, "General/Resume.tex": same });
    const set = await loadResumes(CFG, source, new MemoryTextStore(), NOW);
    expect(set.variants.map((v) => [v.path, v.text])).toEqual([
      ["General/Resume.md", "\\textbf{Go} and Python"],
      ["General/Resume.tex", "Go and Python"],
    ]);
  });

  it("surfaces an extraction failure instead of falling back", async () => {
    const { state, source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    await loadResumes(CFG, source, store, NOW, counting().extract);
    state.files["General/Backend.tex"] = "B2";
    const broken: Extract = () => {
      throw new Error("extractor bug");
    };
    await expect(loadResumes(CFG, source, store, NOW, broken)).rejects.toThrow("extractor bug");
  });

  it("surfaces a storage failure instead of falling back", async () => {
    const { state, source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    await loadResumes(CFG, source, store, NOW, counting().extract);
    state.files["General/Backend.tex"] = "B2";
    store.put = async () => {
      throw new Error("blob write failed");
    };
    await expect(loadResumes(CFG, source, store, NOW, counting().extract)).rejects.toThrow(
      "blob write failed",
    );
  });

  it("returns no variants, with the reason, when there is nothing to fall back to", async () => {
    const { state, source } = repo({ ...FILES });
    state.offline = true;
    expect(await loadResumes(CFG, source, new MemoryTextStore(), NOW)).toEqual({
      variants: [],
      defaultPath: "",
      warnings: [
        "Couldn't read resumes from GitHub (GitHub contents 503: Service Unavailable); no earlier versions are cached.",
      ],
      stale: false,
      extracted: 0,
    });
  });

  it("returns no variants when the index points at a text that is gone", async () => {
    const { state, source } = repo({ ...FILES });
    const store = new MemoryTextStore();
    await loadResumes(CFG, source, store, NOW, counting().extract);
    for (const k of [...store.objects.keys()]) if (k.startsWith("text/")) store.objects.delete(k);
    state.offline = true;
    const set = await loadResumes(CFG, source, store, NOW);
    expect(set.variants).toEqual([]);
    expect(set.warnings[0]).toMatch(/GitHub contents 503.*the cached versions are incomplete\.$/);
  });

  it("skips PDF variants with a warning, and fails when nothing readable is left", async () => {
    const mixed = repo({ "General/Resume.tex": "A", "General/Resume.pdf": "%PDF" });
    const set = await loadResumes(
      CFG,
      mixed.source,
      new MemoryTextStore(),
      NOW,
      counting().extract,
    );
    expect(set.variants.map((v) => v.path)).toEqual(["General/Resume.tex"]);
    expect(set.warnings).toEqual([
      "Skipped General/Resume.pdf: PDF resumes aren't read in the cloud; keep a .tex or .md variant.",
    ]);
    const pdfOnly = repo({ "General/Resume.pdf": "%PDF" });
    await expect(loadResumes(CFG, pdfOnly.source, new MemoryTextStore(), NOW)).rejects.toThrow(
      "every resume variant was skipped",
    );
  });

  it("uses the real extractor by default: LaTeX for .tex, normalised text otherwise", async () => {
    const { source } = repo({
      "General/Resume.tex": "\\begin{document}\\section{Skills} Go \\& Python\\end{document}",
      "General/Notes.md": "Line  \n\n\n\nNext",
    });
    const set = await loadResumes(CFG, source, new MemoryTextStore(), NOW);
    expect(set.variants.map((v) => [v.name, v.text])).toEqual([
      ["Notes", "Line\n\nNext"],
      ["Resume", "## Skills\nGo & Python"],
    ]);
  });
});
