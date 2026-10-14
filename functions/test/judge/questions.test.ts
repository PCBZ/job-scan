import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type QuestionName, question } from "../../src/lib/judge/questions.js";

const TEMPLATES = JSON.parse(
  readFileSync(new URL("../../prompts/gates.json", import.meta.url), "utf8"),
) as Record<QuestionName, string>;

describe("question", () => {
  it("renders every question in prompts/gates.json with its values, leaving no placeholder", () => {
    const view = {
      seniority: "mid",
      years: "4",
      keywords: '"unpaid"',
      location: "Montreal",
      places: "Vancouver, BC",
      scopes: "Canada",
    };
    for (const name of Object.keys(TEMPLATES) as QuestionName[]) {
      const q = question(name, view);
      expect(q, name).not.toMatch(/\{\{|\}\}/);
      expect(q.endsWith("?") || q.endsWith("."), name).toBe(true);
    }
  });

  it("keeps quotes and ampersands as written: questions are text, not HTML", () => {
    expect(
      question("commute", { location: 'Fort St. John & "Area"', places: "Vancouver, BC" }),
    ).toBe('Is "Fort St. John & "Area"" within commuting distance of Vancouver, BC?');
  });

  it("leaves the years out when they aren't known", () => {
    expect(question("seniority", { seniority: "mid" })).not.toContain("years");
    expect(question("seniority", { seniority: "mid", years: "4" })).toContain(
      "The candidate has 4 years of experience.",
    );
  });
});
