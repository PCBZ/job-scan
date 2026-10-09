// A synthetic report: every section filled, for the HTML tests and for
// `npm run report:preview`. No real postings or people.

import type { Report } from "../../src/lib/report/types.js";

export const SAMPLE: Report = {
  day: "2026-10-08",
  outcome: "report",
  alerts: [
    "school mailbox failed to sync: AUTHENTICATIONFAILED. Today's results cover the others only.",
  ],
  funnel:
    "Scanned 14 new emails across 1 of 2 mailboxes → 62 postings → 9 new → 6 in scope → 2 worth your time.",
  counts: "38 emails skipped as already seen. 18 duplicates collapsed. 6 repeats suppressed.",
  notes: ["salary not compared for 2 posting(s): currency unknown"],
  top: [
    {
      title: "Backend Engineer, Payments",
      company: "Lumen Ridge",
      location: "Vancouver, BC · hybrid",
      salary: "$130K–$150K",
      url: "https://jobs.example/postings/1?ref=alert&src=email",
      score: 87,
      confidence: "medium",
      variant: "Backend",
      either: undefined,
      account: "personal",
      fit: {
        sentence: "You built the exact kind of ledger service this team owns, in their stack.",
        quote: "Built a payment ledger service in Go on Postgres, handling 3M transactions a day",
      },
      gap: {
        requirement: "Experience with Kafka Streams",
        advice:
          "Lead with the settlement consumers you moved to Kafka, and ask how much Streams work the role involves.",
      },
      unknown: "team size",
      caps: [],
      noted: [],
    },
    {
      title: "Data Engineer",
      company: "Quillfeather",
      location: "Vancouver, BC",
      salary: "",
      url: "https://jobs.example/postings/2",
      score: 70,
      confidence: "low",
      variant: "Data",
      either: "Backend",
      account: "personal",
      fit: {
        sentence: "Your pipelines feed models, which is what this role maintains.",
        quote: "Built Spark pipelines on Databricks that feed the fraud models",
      },
      gap: { requirement: "", advice: "The requirements the alert lists are all met." },
      unknown: "",
      caps: ["no stated gap"],
      noted: ['Requires citizenship ("US citizens only")'],
    },
  ],
  others: [
    {
      title: "Platform Engineer",
      company: "Saltmarsh Robotics",
      location: "Burnaby, BC · onsite",
      salary: "",
      url: "https://jobs.example/postings/3",
      score: 58,
      check: "5+ years of Kubernetes",
    },
  ],
  filtered: [
    {
      gate: "location",
      items: [
        {
          title: "SRE",
          company: "Northbeam",
          location: "Toronto, ON",
          reason: "outside locations: Toronto, ON",
        },
      ],
    },
    {
      gate: "sponsorship",
      items: [
        {
          title: "Software Engineer",
          company: "Saltmarsh Defense",
          location: "Seattle, WA",
          reason: 'Requires citizenship ("Must be a US citizen")',
        },
      ],
    },
  ],
  suspicious: "not checked",
  housekeeping: ["personal hit the message budget: 3 messages left for the next run."],
};
