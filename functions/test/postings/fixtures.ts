import { readFileSync } from "node:fs";
import type { FetchedMessage } from "../../src/lib/mail/types.js";
import type { Posting } from "../../src/lib/postings/types.js";

export type Expected = Pick<
  Posting,
  "title" | "company" | "location" | "salary" | "workplace" | "posted" | "link"
>;

export interface AlertFixture {
  message: FetchedMessage;
  expected: Expected[];
}

export const VENDORS = ["glassdoor", "linkedin", "indeed"] as const;

export function fixture(vendor: (typeof VENDORS)[number]): AlertFixture {
  return JSON.parse(readFileSync(new URL(`fixtures/${vendor}.json`, import.meta.url), "utf8"));
}
