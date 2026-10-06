import type { Posting } from "../../src/lib/postings/types.js";

/** A well-formed posting; override the fields a test is about. */
export function posting(over: Partial<Posting> = {}): Posting {
  return {
    title: "Backend Engineer",
    company: "Northwind Labs",
    location: "Vancouver, BC",
    workplace: "hybrid",
    salary: "$120,000–$140,000 a year",
    posted: "2d",
    requirements: [],
    skills: [],
    link: null,
    url: "",
    source: "indeed",
    account: "personal",
    message_id: "<m0@example.test>",
    message_subject: "Backend Engineer jobs",
    row: 0,
    ...over,
  };
}
