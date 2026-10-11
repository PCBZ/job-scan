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

export interface SuspiciousFixture {
  message: FetchedMessage;
  /** Kinds a careful reader would flag; the model must flag each at least once. */
  expected_kinds: string[];
}

export const SUSPICIOUS = ["suspicious-payment", "suspicious-injection"] as const;

export function suspiciousFixture(name: (typeof SUSPICIOUS)[number]): SuspiciousFixture {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));
}
