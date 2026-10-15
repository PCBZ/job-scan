import { describe, expect, it } from "vitest";
import { evaluationSubject } from "../../src/lib/delivery/email.js";
import { evaluate } from "../../src/lib/eval/evaluate.js";
import { duration, renderHtml, tokens, usd } from "../../src/lib/eval/html.js";
import { renderText } from "../../src/lib/eval/text.js";
import { records } from "./records.js";

const e = evaluate(records(), []);

describe("formatting", () => {
  it("writes tokens, dollars and durations short", () => {
    expect([tokens(1_520_000), tokens(122_400), tokens(950)]).toEqual(["1.52M", "122.4K", "950"]);
    expect([usd(1.714), usd(0.00126), usd(0)]).toEqual(["$1.71", "$0.0013", "$0.00"]);
    expect([duration(493_000), duration(42_000)]).toEqual(["8m 13s", "42s"]);
  });
});

describe("the evaluation email", () => {
  it("carries every section in both parts", () => {
    for (const part of [renderHtml(e), renderText(e)]) {
      for (const section of [
        "Funnel",
        "Cost (estimated)",
        "Time",
        "Quality",
        "Screen (Jev)",
        "Dropped as misaligned",
        "Recent runs",
      ]) {
        expect(part, section).toContain(section);
      }
      expect(part).toContain("Full-Stack Developer");
      expect(part).toContain("0.97");
      expect(part).toContain("Run 8m 13s");
    }
    // Mustache escapes "/" too; a mail client shows it as written.
    expect(renderText(e)).toContain("glassdoor 1/2");
    expect(renderHtml(e)).toContain("glassdoor 1&#x2F;2");
  });

  it("escapes what came from the mail in the HTML", () => {
    const html = renderHtml(
      evaluate(
        records().map((r) =>
          r.kind === "filtered" && r.reason.includes("Jev")
            ? { ...r, posting: { ...r.posting, title: "<b>Lead</b> & co" } }
            : r,
        ),
        [],
      ),
    );
    expect(html).toContain("&lt;b&gt;Lead&lt;&#x2F;b&gt; &amp; co");
    expect(html).not.toContain("<b>Lead</b>");
  });

  it("names the day, version and estimated cost in the subject, and no posting", () => {
    expect(evaluationSubject(e)).toMatch(
      /^Job Scan — evaluation 2026-10-15 \(v0\.1\.9\): ≈ \$\d+\.\d\d$/,
    );
  });
});
