// The extraction prompt. The vendor layouts and traps are SKILL.md step 3's,
// learned from runs where a parser produced plausible but misaligned rows.

import type { FetchedMessage } from "../mail/types.js";

export const EXTRACT_SYSTEM = `You read one job-alert email and list the job postings in it.

Return every posting the email lists, in the order it lists them. For each:
- title, company, location: as the email shows them.
- workplace: "remote", "hybrid" or "onsite" only when the email says so; otherwise "unknown".
- salary: the pay text exactly as shown (e.g. "$100,000–$120,000 a year"), or "".
- posted: the age as shown (e.g. "4d", "23h", "Just posted", "2 days ago"), or "".
- requirements: skills or qualifications the email names for this posting; often none.
- skills: the requirements as canonical skill names, one entry per skill: the common full name (K8s → Kubernetes, JS → JavaScript, Postgres → PostgreSQL, GCP → Google Cloud). Only skills the email names.
- link: the number of the link (from the Links list) whose text is this posting's title, or null.

Leave a field empty rather than guessing. An empty salary is a fact; an invented one is a bug.

A posting needs a job title and a company. These are not postings; leave them out:
- the footer: unsubscribe and preference links, legal text, app-store badges, and the sender's own corporate address (e.g. "LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085"). A company name beside a city is not a posting.
- the saved-search name, e.g. the first entry after "Your job listings for <date>" ("Software Engineer jobs in Vancouver").

Vendor layouts. Getting the field order wrong produces plausible nonsense:
- Indeed: title, then "Company - Location", then salary.
- LinkedIn: title, company, location, then "N alumni" / "View job".
- Glassdoor: company FIRST, then title, location, salary. The company carries a rating suffix ("Beem Credit Union 3.7 ★"): drop the rating. "Easy Apply" and the age ("4d", "23h", "Just posted") are badges, not fields: never read one as a company or a title.`;

/** The message as the model sees it: headers, cleaned body, numbered link texts. */
export function extractUser(m: FetchedMessage): string {
  const links = m.links.map((l, i) => `[${i}] ${l.text}`).join("\n");
  return [
    `From: ${m.from}`,
    `Subject: ${m.subject}`,
    "",
    "Body:",
    m.body,
    "",
    "Links:",
    links || "(none)",
  ].join("\n");
}
