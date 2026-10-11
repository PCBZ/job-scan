import { describe, expect, it } from "vitest";
import { renderText } from "../../src/lib/report/text.js";
import { SAMPLE } from "./sample.js";

describe("renderText", () => {
  it("carries the same sections as the HTML, in order", () => {
    const text = renderText(SAMPLE, "https://reports.example/x");
    const order = [
      "Job Scan — 2026-10-08",
      "View in a browser: https://reports.example/x",
      "! school mailbox failed to sync",
      "→ 2 worth your time.",
      "- salary not compared",
      "## Top picks",
      "1. Backend Engineer, Payments — Lumen Ridge · 87/100 · confidence: medium",
      "Fit: You built the exact kind",
      "Gap: Experience with Kafka Streams. Lead with",
      "Unknown from the email: team size",
      "2. Data Engineer — Quillfeather · 70/100 · confidence: low (capped: no stated gap)",
      "send Data or Backend",
      "Would have been filtered: Requires citizenship",
      "## Also worth a look",
      "- Platform Engineer — Saltmarsh Robotics",
      "## Filtered out",
      "location (1)",
      "## Suspicious",
      '- payment: Talent Desk <hr@quickhire.example> — "Offer: remote data entry, start today"',
      "  Asks for an upfront fee before any interview.",
      "  > pay a $49 onboarding fee to secure your position",
      "## Housekeeping",
    ];
    let at = -1;
    for (const part of order) {
      const next = text.indexOf(part, at + 1);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
  });

  it("gives each near miss its link, as the HTML does", () => {
    expect(renderText(SAMPLE)).toContain(
      "check: 5+ years of Kubernetes\n  https://jobs.example/postings/3",
    );
    const unlinked = renderText({
      ...SAMPLE,
      others: [{ ...(SAMPLE.others[0] as (typeof SAMPLE.others)[0]), url: "" }],
    });
    expect(unlinked).toContain("check: 5+ years of Kubernetes\n");
    expect(unlinked).not.toContain("postings/3");
  });

  it("states an empty day, and leaves the link out when there is none", () => {
    const text = renderText({ ...SAMPLE, top: [], others: [], filtered: [], housekeeping: [] });
    expect(text).toContain("Nothing cleared the floor today.\n");
    expect(text).not.toContain("near misses");
    expect(text).not.toContain("View in a browser");
    expect(text.match(/^Nothing\.$/gm)).toHaveLength(2);
  });

  it.each([
    ["no mail could be read", "not checked" as const, ["Not checked: no mail could be read."]],
    ["every message checked, nothing found", { items: [], unchecked: 0 }, ["Nothing."]],
    [
      'some messages unchecked: never "Nothing"',
      { items: [], unchecked: 2 },
      ["2 messages couldn't be checked; see Housekeeping."],
    ],
  ])("says what the Suspicious check covered: %s", (_name, suspicious, lines) => {
    const text = renderText({ ...SAMPLE, suspicious });
    const section = text.slice(text.indexOf("## Suspicious\n"), text.indexOf("## Housekeeping"));
    expect(section.trim().split("\n").slice(1)).toEqual(lines);
  });
});
