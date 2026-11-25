import { describe, expect, it } from "vitest";
import { renderHtml, renderWebHtml, view } from "../../src/lib/report/html.js";
import type { OtherPick, Report, TopPick } from "../../src/lib/report/types.js";
import { SAMPLE } from "./sample.js";

const top = SAMPLE.top[0] as TopPick;
const other = SAMPLE.others[0] as OtherPick;
const report = (over: Partial<Report> = {}): Report => ({ ...SAMPLE, ...over });

// The email and the browser copy render one view through two templates (#210),
// so both must say the same things the same safe way.
describe.each([
  ["the email", renderHtml],
  ["the browser copy", renderWebHtml],
] as const)("%s", (_, render) => {
  it("fills every section of the template", () => {
    const html = render(SAMPLE);
    for (const text of [
      "<title>Job Scan — 2026-10-08</title>",
      "⚠️ school mailbox failed to sync",
      "→ 2 worth your time.",
      "<i>38 emails skipped as already seen.",
      "salary not compared for 2 posting(s): currency unknown",
      "87/100",
      "1. Backend Engineer, Payments — Lumen Ridge",
      "Send <b>Backend</b>",
      "Send <b>Data or Backend</b>",
      "capped: no stated gap",
      "<b>Gap:</b> Experience with Kafka Streams. Lead with",
      "<b>Gap:</b> The requirements the alert lists are all met.",
      "<b>Unknown from the email:</b> team size",
      "Would have been filtered: Requires citizenship",
      "Also worth a look",
      "5+ years of Kubernetes",
      "location (1)",
      "outside locations: Toronto, ON",
      "<b>payment</b>: Talent Desk &lt;hr@quickhire.example&gt; — “Offer: remote data entry, start today”",
      "Asks for an upfront fee before any interview.",
      "pay a $49 onboarding fee to secure your position",
      "personal hit the message budget",
    ]) {
      expect(html, text).toContain(text.replace(/"/g, "&quot;"));
    }
  });

  it("escapes every string from the mail, in text and in links", () => {
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
    const html = render(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;&#x2F;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).not.toContain('"onmouseover="');
  });

  it("states an empty day honestly, and leaves out empty tables", () => {
    const html = render(report({ top: [], others: [], filtered: [], housekeeping: [] }));
    expect(html).toContain("Nothing cleared the floor today.");
    expect(html).not.toContain("Also worth a look");
    expect(html).toContain("<h2");
    expect(html.match(/Nothing\.<\/p>/g)).toHaveLength(2);
  });

  it("points to the near misses only when there are some", () => {
    const withOthers = render(report({ top: [] }));
    expect(withOthers).toContain("Nothing cleared the floor today. The near misses are below.");
    const bare = render(report({ top: [], others: [] }));
    expect(bare).toContain("Nothing cleared the floor today.</p>");
    expect(bare).not.toContain("near misses");
  });

  it("drops the button and the link when a posting has no URL", () => {
    const html = render(report({ top: [{ ...top, url: "" }], others: [{ ...other, url: "" }] }));
    expect(html).not.toContain("Open the posting");
    expect(html).not.toContain('href=""');
  });
});

describe("renderHtml, the email", () => {
  it("keeps Cerberus's mail-client fixes and its license notice", () => {
    const html = renderHtml(SAMPLE);
    expect(html).toContain("<!--[if mso]>");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("Copyright (c) 2017 Ted Goas");
    expect(html).not.toMatch(/\{\{|\}\}/);
  });

  it("links to the browser copy only when given one", () => {
    expect(renderHtml(SAMPLE, "https://reports.example/x?sig=a&b=c")).toContain(
      'href="https:&#x2F;&#x2F;reports.example&#x2F;x?sig&#x3D;a&amp;b&#x3D;c" style="color: #1d4ed8; text-decoration: underline;">View in a browser</a>',
    );
    expect(renderHtml(SAMPLE)).not.toContain("View in a browser");
  });
});

describe("renderWebHtml, the browser copy", () => {
  it("is a responsive web page, without the email's mail-client workarounds", () => {
    const html = renderWebHtml(SAMPLE);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<div class="picks">');
    expect(html).toContain("flex-wrap: wrap");
    expect(html).toContain("overflow-wrap: break-word");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).not.toContain("<!--[if mso");
    expect(html).not.toContain("View in a browser");
    expect(html).not.toMatch(/\{\{|\}\}/);
  });

  it("gives each top pick its own card", () => {
    const html = renderWebHtml(SAMPLE);
    expect(html.match(/<article class="card pick">/g)).toHaveLength(SAMPLE.top.length);
    expect(renderWebHtml(report({ top: [] }))).not.toContain('class="picks"');
  });
});

describe("view", () => {
  it("previews the best pick, colours the badge by confidence, numbers the picks", () => {
    const v = view(SAMPLE);
    expect(v.preview).toBe("Backend Engineer, Payments at Lumen Ridge, 87/100");
    expect(v.top.map((p) => [p.n, p.badge])).toEqual([
      [1, "#b54708"],
      [2, "#667085"],
    ]);
    expect(view(report({ top: [] })).preview).toBe(SAMPLE.funnel);
  });
});
