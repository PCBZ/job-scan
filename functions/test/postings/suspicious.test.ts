import { describe, expect, it } from "vitest";
import { QUOTE_MAX, quotedIn, verifiedFlags } from "../../src/lib/postings/suspicious.js";

describe("quotedIn", () => {
  it("matches the email's words however the whitespace was wrapped", () => {
    expect(quotedIn("pay a  $49\nfee", "Please pay a $49 fee now.")).toBe(true);
  });
  it("is exact otherwise: case, punctuation and paraphrase all miss", () => {
    const text = "Please pay a $49 fee now.";
    expect(quotedIn("Pay a $49 fee", text)).toBe(false);
    expect(quotedIn("pay a 49 fee", text)).toBe(false);
    expect(quotedIn("pay the fee", text)).toBe(false);
  });
  it("never matches an empty quote", () => {
    expect(quotedIn("  ", "anything")).toBe(false);
  });
});

describe("verifiedFlags", () => {
  it("cuts a long quote to a verbatim prefix", () => {
    const long = `${"x".repeat(QUOTE_MAX + 50)}`;
    const [f] = verifiedFlags([{ kind: "scam", reason: "r", quote: long }], long, "<a@x>", []);
    expect(f?.quote).toBe(`${"x".repeat(QUOTE_MAX)}…`);
  });
});
