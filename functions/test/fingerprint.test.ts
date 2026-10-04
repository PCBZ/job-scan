import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fingerprint, type JobIdentity } from "../src/lib/fingerprint.js";

// Shared with tests/test_fingerprint.py; the Python implementation is the reference.
interface Case {
  name: string;
  job: JobIdentity;
  fingerprint: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/fingerprints.json", import.meta.url), "utf8"),
);

describe("fingerprint matches scripts/seen_jobs.py", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(fingerprint(c.job)).toBe(c.fingerprint);
  });
});
