import type { Posting } from "../postings/types.js";

/**
 * The posting as the model sees it. verify_judgements checks gate quotes
 * against these same fields, so the two can't drift apart.
 */
export function postingFields(p: Posting) {
  const { title, company, location, workplace, salary, posted, requirements } = p;
  return { title, company, location, workplace, salary, posted, requirements };
}
