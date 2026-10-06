// A job posting as the pipeline carries it. Field names follow the local
// skill's /tmp/jobs.json (SKILL.md step 3), so both runs can be compared.

export type Workplace = "onsite" | "hybrid" | "remote" | "unknown";
export type Source = "linkedin" | "indeed" | "glassdoor" | "other";

export interface Posting {
  // Read from the alert by the model; "" when the alert doesn't say.
  title: string;
  company: string;
  location: string;
  workplace: Workplace;
  salary: string;
  /** As the alert shows it, e.g. "4d" or "2 days ago". */
  posted: string;
  requirements: string[];
  /** Canonical skill names for the requirements, e.g. K8s → Kubernetes. */
  skills: string[];
  /** Index into the message's links[] the model chose, or null. */
  link: number | null;

  // Filled in by code from the message, never by the model.
  url: string;
  source: Source;
  account: string;
  message_id: string;
  message_subject: string;
  /** Position of this row in the model's answer for its message. */
  row: number;
}
