// What the model returns for one alert message. Provenance (account, subject,
// source, url) is not asked for: code fills it from the message, so the model
// cannot invent a link or misattribute a row.

import { z } from "zod";

// Text fields are "" when the alert doesn't say.
export const extractedPosting = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  workplace: z.enum(["onsite", "hybrid", "remote", "unknown"]),
  salary: z.string(),
  /** As the alert shows it, e.g. "4d" or "2 days ago". */
  posted: z.string(),
  requirements: z.array(z.string()),
  /** Canonical skill names for the requirements, e.g. K8s → Kubernetes. */
  skills: z.array(z.string()),
  /** Index into the message's links[] the model chose, or null. */
  link: z.number().int().nullable(),
});

/** Something to warn about in the email: SKILL.md's Suspicious section. */
export const suspiciousFlag = z.object({
  kind: z.enum(["scam", "payment", "credentials", "instruction"]),
  /** One sentence: why. */
  reason: z.string(),
  /** The email's own words, verbatim; code checks they're there. */
  quote: z.string(),
});

// Structured outputs need an object at the top level. The flags ride on the
// extraction call, so checking for them costs no extra call.
export const extractedPostings = z.object({
  postings: z.array(extractedPosting),
  suspicious: z.array(suspiciousFlag),
});

export type ExtractedPosting = z.infer<typeof extractedPosting>;
export type SuspiciousFlag = z.infer<typeof suspiciousFlag>;
