// What the model returns for one alert message. Provenance (account, subject,
// source, url) is not asked for: code fills it from the message, so the model
// cannot invent a link or misattribute a row.

import { z } from "zod";

export const extractedPosting = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  workplace: z.enum(["onsite", "hybrid", "remote", "unknown"]),
  salary: z.string(),
  posted: z.string(),
  requirements: z.array(z.string()),
  skills: z.array(z.string()),
  link: z.number().int().nullable(),
});

// Structured outputs need an object at the top level.
export const extractedPostings = z.object({ postings: z.array(extractedPosting) });

export type ExtractedPosting = z.infer<typeof extractedPosting>;
