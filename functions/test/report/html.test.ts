import mjml2html from "mjml";
import { describe, expect, it } from "vitest";
import { renderHtml, reportMjml } from "../../src/lib/report/html.js";
import type { Report, TopPick } from "../../src/lib/report/types.js";

const top: TopPick = {
  title: "Backend Engineer",
  company: "Lumen Ridge",
  location: "Vancouver, BC · hybrid",
  salary: "$120K",
  url: "https://jobs.example/1?a=1&b=2",
  score: 87,
  confidence: "medium",
  variant: "Backend",
  either: "Platform",
  account: "personal",
  fit: { sentence: "Shipped it.", quote: "Built payment services in Go" },
  gap: { requirement: "8+ years required", advice: "Lead with scope." },
  unknown: "team size",
  caps: [],
  noted: [],
};

function report(over: Partial<Report> = {}): Report {
  return {
    day: "2026-10-08",
    outcome: "report",
    alerts: [],
    funnel: "Scanned 14 new emails → 4 worth your time.",
    counts: "",
    notes: [],
    top: [top],
    others: [],
    filtered: [],
    suspicious: "not checked",
    housekeeping: [],
    ...over,
  };
}

describe("renderHtml", () => {
  it("compiles under strict validation into email-safe tables", async () => {
    const html = await renderHtml(report());
    expect(html).toContain("<table");
    expect(html).toContain("Job Scan — 2026-10-08");
    expect(html).toContain("87/100 · confidence: medium");
    expect(html).toContain("send <b>Backend</b> or <b>Platform</b>");
    expect(html).toContain("Built payment services in Go");
    expect(html).toContain("8+ years required. Lead with scope.");
    expect(html).toContain('href="https://jobs.example/1?a=1&amp;b=2"');
  });

  it("is valid MJML in every section, so strict compilation never trips", async () => {
    const full = report({
      alerts: ["a"],
      notes: ["n"],
      counts: "c.",
      others: [
        {
          title: "t",
          company: "c",
          location: "l",
          salary: "s",
          url: "https://x.example",
          score: 50,
          check: "k",
        },
      ],
      filtered: [
        { gate: "location", items: [{ title: "t", company: "c", location: "l", reason: "r" }] },
      ],
      housekeeping: ["h"],
      top: [{ ...top, caps: ["no stated gap"], noted: ["n"] }],
    });
    const { errors } = await mjml2html(reportMjml(full), { validationLevel: "soft" });
    expect(errors).toEqual([]);
  });

  it("escapes every string from the mail, in text and in links", async () => {
    const hostile = report({
      top: [
        {
          ...top,
          title: '<script>alert("x")</script>',
          company: "A & B",
          url: 'https://x.example/"onmouseover="alert(1)',
        },
      ],
      filtered: [
        {
          gate: "location",
          items: [
            { title: "<img src=x onerror=alert(1)>", company: "c", location: "l", reason: "r" },
          ],
        },
      ],
    });
    const html = await renderHtml(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain('"onmouseover="');
  });

  it("states an empty day honestly, and never says Nothing for Suspicious", () => {
    const mjml = reportMjml(report({ top: [] }));
    expect(mjml).toContain("Nothing cleared the floor today.");
    expect(mjml).toContain("Not checked: no step looks for suspicious mail yet.");
    expect(mjml).not.toContain("Also worth a look");
  });

  it("shows caps, would-have-been-filtered notes, a stated no-gap, and the alerts", () => {
    const mjml = reportMjml(
      report({
        alerts: ["school mailbox failed to sync"],
        top: [
          {
            ...top,
            caps: ["no stated gap"],
            noted: ["Requires citizenship"],
            gap: { requirement: "", advice: "All listed requirements met." },
          },
        ],
      }),
    );
    expect(mjml).toContain("(capped: no stated gap)");
    expect(mjml).toContain("<b>Would have been filtered:</b> Requires citizenship");
    expect(mjml).toContain("<b>Gap:</b> All listed requirements met.");
    expect(mjml).toContain("⚠️ school mailbox failed to sync");
    const noted = reportMjml(
      report({ notes: ["salary not compared for 2 posting(s): currency unknown"] }),
    );
    expect(noted).toContain("<li>salary not compared for 2 posting(s): currency unknown</li>");
  });

  it("lays out the near misses and the filtered as tables", () => {
    const mjml = reportMjml(
      report({
        others: [
          {
            title: "Data Engineer",
            company: "Q",
            location: "Vancouver",
            salary: "",
            url: "",
            score: 55,
            check: "years required",
          },
        ],
        filtered: [
          {
            gate: "location",
            items: [
              { title: "SRE", company: "N", location: "Toronto, ON", reason: "outside locations" },
            ],
          },
        ],
      }),
    );
    expect(mjml).toContain("The one thing to check");
    expect(mjml).toContain("years required");
    expect(mjml).toContain("location (1)");
    expect(mjml).toContain("Toronto, ON");
  });
});
