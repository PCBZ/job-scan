import { describe, expect, it } from "vitest";
import { appError } from "../../src/lib/errors.js";
import type { ModelClient, StructuredRequest } from "../../src/lib/model/types.js";
import {
  MAX_DESCRIPTION_CHARS,
  READ_SYSTEM,
  type ReadAnswer,
  readStep,
} from "../../src/lib/postings/read.js";
import { posting } from "./helpers.js";

/** A scraped row as a source hands it over unread (#203). */
const scraped = (title: string, description = `We need Go for ${title}.`) =>
  posting({
    title,
    source: "linkedin",
    account: "jobspy",
    workplace: "unknown",
    salary: "",
    description,
  });

/** Answers each call from `answer`, given the request's user message as JSON. */
function client(answer: (sent: Record<string, unknown>) => ReadAnswer | Error) {
  const calls: StructuredRequest<unknown>[] = [];
  const c: ModelClient = {
    async structured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      const a = answer(JSON.parse(req.user));
      if (a instanceof Error) throw a;
      return { value: a as T, usage: { input: 100, output: 10 }, served_by: "primary" };
    },
  };
  return { c, calls };
}

const GO: ReadAnswer = {
  workplace: "hybrid",
  salary: "CAD 120,000 a year",
  requirements: ["3+ years of Go"],
  skills: ["Go"],
};

describe("readStep (#203)", () => {
  it("reads each posting's description into its fields, and drops the description", async () => {
    const { c, calls } = client(() => GO);
    const row = scraped("Backend Engineer");
    const out = await readStep(c)({ postings: [row] });

    const { description: _, ...rest } = row;
    expect(out.value).toEqual([{ ...rest, ...GO }]);
    expect(out.value[0]).not.toHaveProperty("description");
    expect(out.usage).toEqual({ input: 100, output: 10 });
    expect(out.warnings).toEqual([]);

    const [call] = calls;
    expect(call?.system).toBe(READ_SYSTEM);
    // Only what the model needs: no link, account or provenance.
    expect(JSON.parse(call?.user ?? "{}")).toEqual({
      title: "Backend Engineer",
      company: row.company,
      location: row.location,
      workplace: "unknown",
      salary: "",
      description: "We need Go for Backend Engineer.",
    });
  });

  it("cuts a long description", async () => {
    const { c, calls } = client(() => GO);
    await readStep(c)({ postings: [scraped("Backend Engineer", "x".repeat(10_000))] });
    expect(JSON.parse(calls[0]?.user ?? "{}").description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("keeps a posting it couldn't read with the board's fields, and says how many", async () => {
    const { c } = client((sent) =>
      sent.title === "Data Engineer"
        ? appError("model_provider", "429 too many requests", { status: 429 })
        : GO,
    );
    const out = await readStep(c)({
      postings: [scraped("Backend Engineer"), scraped("Data Engineer")],
    });
    expect(out.value.map((p) => p.requirements)).toEqual([["3+ years of Go"], []]);
    expect(out.value[1]).toMatchObject({ workplace: "unknown", salary: "" });
    expect(out.value[1]).not.toHaveProperty("description");
    expect(out.usage).toEqual({ input: 100, output: 10 });
    expect(out.warnings).toEqual([
      "extract_postings: 1 of 2 scraped posting(s) unread: 429 too many requests",
    ]);
  });

  it("lets anything but a model failure through, so a cancelled run stops", async () => {
    const { c } = client(() => new Error("aborted"));
    await expect(readStep(c)({ postings: [scraped("Backend Engineer")] })).rejects.toThrow(
      "aborted",
    );
  });
});
