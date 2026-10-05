import { describe, expect, it } from "vitest";
import {
  type DirEntry,
  ResumeNotFoundError,
  type ResumeSource,
} from "../../src/lib/resume/source.js";
import {
  discoverVariants,
  pickDefault,
  segmentPattern,
  variantName,
} from "../../src/lib/resume/variants.js";

/** A repository as a list of file paths. */
function repo(paths: string[]): ResumeSource & { listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    async listDir(dir) {
      listed.push(dir);
      const prefix = dir ? `${dir}/` : "";
      // Like GitHub: a directory that doesn't exist is a 404.
      if (dir && !paths.some((x) => x.startsWith(prefix))) {
        throw new ResumeNotFoundError(`GitHub contents 404 for "${dir}"`);
      }
      const entries = new Map<string, DirEntry>();
      for (const p of paths.filter((x) => x.startsWith(prefix))) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0] as string;
        entries.set(name, {
          name,
          path: prefix + name,
          type: rest.includes("/") ? "dir" : "file",
        });
      }
      return [...entries.values()];
    },
    async readFile() {
      return "";
    },
  };
}

describe("discoverVariants", () => {
  const files = [
    "General/resume.tex",
    "General/backend.tex",
    "General/preamble.tex",
    "General/notes.txt",
    "General/.draft.tex",
    "General/old/legacy.tex",
    "README.md",
    "macros.tex",
    "cv.pdf",
  ];

  it("lists the glob's directory and matches the file name", async () => {
    const source = repo(files);
    expect(await discoverVariants(source, ["General/*.tex"])).toEqual([
      "General/backend.tex",
      "General/resume.tex",
    ]);
    expect(source.listed).toEqual(["General"]);
  });

  it("drops non-variants and unsupported types, keeps supported ones across globs", async () => {
    expect(await discoverVariants(repo(files), ["*", "General/*.txt"])).toEqual([
      "General/notes.txt",
      "README.md",
      "cv.pdf",
    ]);
  });

  it("keeps a literal path only if the file exists", async () => {
    const source = repo(files);
    expect(await discoverVariants(source, ["General/resume.tex", "General/deleted.tex"])).toEqual([
      "General/resume.tex",
    ]);
    expect(source.listed).toEqual(["General", "General"]);
  });

  it("treats a missing directory as no matches and keeps the others", async () => {
    expect(await discoverVariants(repo(files), ["General/*.tex", "src/*.tex"])).toEqual([
      "General/backend.tex",
      "General/resume.tex",
    ]);
  });

  it("does not swallow errors other than not-found", async () => {
    const source: ResumeSource = {
      listDir: async () => {
        throw new Error('GitHub contents 403 for "General": Resource not accessible');
      },
      readFile: async () => "",
    };
    await expect(discoverVariants(source, ["General/*.tex"])).rejects.toThrow("403");
  });

  it("fails when nothing matches, pointing at repo, ref and token", async () => {
    await expect(discoverVariants(repo(files), ["missing/*.tex"])).rejects.toThrow(
      'no resume variants match ["missing/*.tex"]. Check [resume] repo, ref and variants',
    );
  });

  it("rejects wildcards in directory segments", async () => {
    await expect(discoverVariants(repo(files), ["*/resume.tex"])).rejects.toThrow(
      "wildcards are allowed in the file name only",
    );
  });
});

describe("segmentPattern (fnmatch)", () => {
  it.each([
    ["*.tex", "resume.tex", true],
    ["*.tex", "resume.txt", false],
    ["resume-?.tex", "resume-a.tex", true],
    ["[rc]*.tex", "cv.tex", true],
    ["[!rc]*.tex", "cv.tex", false],
    ["a.b", "axb", false],
    ["[oops", "[oops", true],
  ])("%s ~ %s → %s", (pattern, name, expected) => {
    expect(segmentPattern(pattern).test(name)).toBe(expected);
  });
});

describe("variantName and pickDefault", () => {
  const variants = ["General/backend.tex", "General/cv.tex", "General/resume.tex"];

  it("strips directories and the extension", () => {
    expect(variantName("General/resume.tex")).toBe("resume");
  });

  it("prefers the configured default, ignoring case and extension", () => {
    expect(pickDefault(variants, "Backend.tex")).toBe("General/backend.tex");
  });

  it("falls back to a conventional name, then the first variant", () => {
    expect(pickDefault(variants, "missing")).toBe("General/cv.tex");
    expect(pickDefault(["General/backend.tex"], null)).toBe("General/backend.tex");
    expect(pickDefault([], null)).toBeNull();
  });
});
