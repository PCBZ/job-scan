// Where resume files come from. The GitHub MCP implementation is one option;
// the REST contents API or a local directory could stand in behind this.

export interface DirEntry {
  name: string;
  /** Path from the repository root, e.g. "General/resume.tex". */
  path: string;
  type: "file" | "dir";
}

export interface ResumeSource {
  /** Entries of a directory; "" is the repository root. */
  listDir(path: string): Promise<DirEntry[]>;
  /** A file's contents as text. */
  readFile(path: string): Promise<string>;
}
