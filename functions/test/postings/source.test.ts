import { describe, expect, it } from "vitest";
import { sourceOf } from "../../src/lib/postings/source.js";

describe("sourceOf", () => {
  it.each([
    ["LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", "linkedin"],
    ["jobs-listings@linkedin.com", "linkedin"],
    ["Indeed <alert@indeed.com>", "indeed"],
    ["Indeed <donotreply@match.indeed.ca>", "indeed"],
    ["Glassdoor Jobs <noreply@glassdoor.com>", "glassdoor"],
    ["A Recruiter <talent@northwind.example>", "other"],
    ["Spoof <alerts@notlinkedin.com>", "other"],
    ["linkedin.com fan <me@example.com>", "other"],
    ["", "other"],
  ])("%s → %s", (from, source) => {
    expect(sourceOf(from)).toBe(source);
  });
});
