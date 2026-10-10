import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import type { Explanation } from "../../src/lib/explain/schema.js";
import { postingId } from "../../src/lib/judge/verify.js";
import type { FetchPayload } from "../../src/lib/mail/types.js";
import { buildReport, NO_RESUMES } from "../../src/lib/report/source.js";
import type { ReportInput } from "../../src/lib/workflow/types.js";
import { dimension, judgement, rankedOf } from "../judge/helpers.js";
import { posting } from "../postings/helpers.js";

const NOW = new Date("2026-10-08T15:00:00Z");

function payload(
  over: Partial<FetchPayload["stats"]> = {},
  failures: FetchPayload["failures"] = [],
): FetchPayload {
  return {
    fetched_at: "",
    window_days: 7,
    stats: {
      accounts_scanned: 2,
      accounts_failed: 0,
      kept: 14,
      already_seen: 38,
      filtered_out: 0,
      total_chars: 0,
      body_from_plain: 0,
      body_from_html: 0,
      budget: 0,
      dropped_for_budget: 0,
      dropped_by_account: {},
      per_account: [],
      ...over,
    },
    failures,
    messages: [],
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    outcome: "report",
    config: { report: {}, profile: {} } as AppConfig,
    resumes: null,
    mail: payload(),
    repeats: 0,
    duplicates: 0,
    filtered: [],
    dropped: {},
    top: [],
    rest: [],
    explanations: [],
    warnings: [],
    notes: [],
    ...over,
  };
}

const pick = rankedOf(
  judgement({ posting: { title: "Backend Engineer", url: "https://jobs.example/1", row: 0 } }),
  87,
);
const explained: Explanation = {
  id: postingId(pick.posting),
  fit: { sentence: "Shipped the same service.", quote: "Built payment services in Go" },
  gap: { requirement: "8+ years required", advice: "Lead with scope." },
  unknown: "",
};

describe("buildReport", () => {
  it("leads with the funnel, the counts and the run's Vancouver day", () => {
    const r = buildReport(
      input({
        top: [pick],
        rest: [rankedOf(judgement({ posting: { row: 1 } }), 50)],
        filtered: [{ posting: posting({ row: 2 }), gate: "location", reason: "outside" }],
        repeats: 6,
        duplicates: 18,
        dropped: { glassdoor: 2 },
      }),
      new Date("2026-10-09T06:30:00Z"),
    );
    expect(r.day).toBe("2026-10-08");
    // 2 in scope + 1 filtered = 3 new; + 6 repeats + 18 duplicates + 2 dropped = 29.
    expect(r.funnel).toBe(
      "Scanned 14 new emails across 2 of 2 mailboxes → 29 postings → 3 new → 2 in scope → 1 worth your time.",
    );
    expect(r.counts).toBe(
      "38 emails skipped as already seen. 18 duplicates collapsed. 6 repeats suppressed. 2 misaligned rows dropped.",
    );
  });

  it("says when there was no new mail, and singularises counts of one", () => {
    expect(
      buildReport(input({ outcome: "no_mail", mail: payload({ already_seen: 1 }) }), NOW),
    ).toMatchObject({
      funnel: "No new mail across 2 of 2 mailboxes.",
      counts: "1 email skipped as already seen.",
    });
  });

  it("puts a failed mailbox at the top, and still reports the others", () => {
    const failed = payload({ accounts_scanned: 1, accounts_failed: 1 }, [
      { account: "school", error: "AUTHENTICATIONFAILED", detail: "app password expired" },
    ]);
    const r = buildReport(input({ mail: failed }), NOW);
    expect(r.alerts).toEqual([
      "school mailbox failed to sync: AUTHENTICATIONFAILED (app password expired). Today's results cover the others only.",
    ]);
    expect(r.funnel).toContain("across 1 of 2 mailboxes");
    const all = buildReport(
      input({
        mail: { error: "all_accounts_failed", failures: [{ account: "a", error: "TIMEOUT" }] },
      }),
      NOW,
    );
    expect(all.alerts).toHaveLength(1);
    expect(all.funnel).toBe("Every mailbox failed to sync, so nothing was scanned today.");
    // Even with no failure detail to list, it still reads as a failure.
    const bare = buildReport(
      input({ outcome: "no_mail", mail: { error: "all_accounts_failed", failures: [] } }),
      NOW,
    );
    expect([bare.alerts, bare.funnel]).toEqual([
      [],
      "Every mailbox failed to sync, so nothing was scanned today.",
    ]);
  });

  it("without resumes, says first that nothing was scored, and why", () => {
    const r = buildReport(
      input({
        outcome: "no_resumes",
        mail: payload({ kept: 3 }, [{ account: "school", error: "auth_failed" }]),
      }),
      NOW,
    );
    expect(r.alerts[0]).toBe(NO_RESUMES);
    expect(r.alerts).toHaveLength(2);
    expect(r.funnel).toMatch(
      /^Scanned 3 new emails across .*; nothing was scored without resumes\.$/,
    );
  });

  it("joins each top pick with its explanation", () => {
    const [top] = buildReport(input({ top: [pick], explanations: [explained] }), NOW).top;
    expect(top).toMatchObject({
      title: "Backend Engineer",
      score: 87,
      variant: "Backend",
      url: "https://jobs.example/1",
      fit: explained.fit,
      gap: explained.gap,
      unknown: "",
    });
  });

  it("keeps only http(s) links: alert text is untrusted", () => {
    const bad = rankedOf(judgement({ posting: { url: "javascript:alert(1)" } }));
    expect(buildReport(input({ top: [bad] }), NOW).top[0]?.url).toBe("");
  });

  it("fills 'the one thing to check' from the judged gap, else the first unknown", () => {
    const gapped = rankedOf(judgement({ posting: { row: 1 } }), 50);
    const unknown = rankedOf(
      judgement({
        posting: { row: 2 },
        answer: {
          variants: [
            {
              variant: "Backend",
              skills: dimension(),
              domain: dimension(),
              seniority: dimension(),
            },
          ],
          unknowns: ["years required"],
        },
      }),
      45,
    );
    expect(buildReport(input({ rest: [gapped, unknown] }), NOW).others.map((o) => o.check)).toEqual(
      ["8+ years required", "years required"],
    );
  });

  it("groups the filtered by gate, location first", () => {
    const f = (gate: "location" | "keyword" | "sponsorship", title: string) => ({
      posting: posting({ title }),
      gate,
      reason: `${gate} reason`,
    });
    const r = buildReport(
      input({
        filtered: [
          f("sponsorship", "A"),
          f("location", "B"),
          f("keyword", "C"),
          f("location", "D"),
        ],
      }),
      NOW,
    );
    expect(r.filtered.map((g) => [g.gate, g.items.map((i) => i.title)])).toEqual([
      ["location", ["B", "D"]],
      ["keyword", ["C"]],
      ["sponsorship", ["A"]],
    ]);
  });

  it("collects housekeeping: budget overflow, a stale resume library, resume and run warnings", () => {
    const r = buildReport(
      input({
        mail: payload({ dropped_by_account: { personal: 3 } }),
        resumes: {
          variants: [],
          defaultPath: "",
          warnings: ["skipped Old.tex"],
          stale: true,
          extracted: 0,
        },
        warnings: ["judge: posting x: refused"],
      }),
      NOW,
    );
    expect(r.housekeeping).toEqual([
      "personal hit the message budget: 3 messages left for the next run.",
      "The resume library couldn't be read; the last good texts were used.",
      "skipped Old.tex",
      "judge: posting x: refused",
    ]);
  });

  it("never claims there was nothing suspicious: no step checks yet", () => {
    expect(buildReport(input(), NOW).suspicious).toBe("not checked");
  });
});
