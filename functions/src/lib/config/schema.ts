// The shape of config.toml, the same file the local skill reads. Every table is
// strict: an unknown key is an error, so a typo like `sender =` fails loudly
// instead of silently dropping a setting.

import { z } from "zod";

const strings = z.array(z.string());
const positiveInt = z.number().int().positive();

/** Keys under [mail] that an individual [[account]] may override. */
const sharedMail = {
  senders: strings.optional(),
  subject_keywords: strings.optional(),
  exclude_senders: strings.optional(),
  max_messages: positiveInt.optional(),
  max_chars_per_message: positiveInt.optional(),
};

const account = z.strictObject({
  name: z.string().trim().min(1).optional(),
  provider: z.string().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  folder: z.string().min(1).optional(),
  user_env: z.string().min(1).optional(),
  password_env: z.string().min(1).optional(),
  ...sharedMail,
});

const mail = z.strictObject({
  ...sharedMail,
  days: positiveInt.optional(),
  max_total_messages: positiveInt.optional(),
});

// Sentinels switch a gate off: seniority "all", "unknown", 0, an empty list.
const profile = z.strictObject({
  target_titles: strings.optional(),
  seniority: z.enum(["all", "new-grad", "junior", "mid", "senior", "staff"]).optional(),
  years_experience: z.union([z.number().nonnegative(), z.literal("unknown")]).optional(),
  locations: strings.optional(),
  open_to_remote: z.boolean().optional(),
  open_to_relocation: z.boolean().optional(),
  needs_sponsorship: z.union([z.boolean(), z.literal("unknown")]).optional(),
  min_salary_usd: z.number().nonnegative().optional(),
  // Supersede min_salary_usd when set: an annual floor in salary_currency.
  min_salary: z.number().nonnegative().optional(),
  salary_currency: z.enum(["CAD", "USD"]).optional(),
  core_skills: strings.optional(),
  exclude_keywords: strings.optional(),
});

const report = z.strictObject({
  max_top_picks: positiveInt.optional(),
  min_score_to_recommend: z.number().min(0).max(100).optional(),
  repeat_suppression_days: z.number().int().nonnegative().optional(),
  suggest_variant: z.boolean().optional(),
  // The cloud run's email (#20): which Gmail [[account]] sends it, reusing its
  // app password, and to whom. Unset email_account sends no email.
  email_account: z.string().min(1).optional(),
  email_to: z.email().optional(),
  // The Telegram chat the daily summary goes to (#21); unset sends none. Not a
  // secret: a bot can only message chats that have started it.
  telegram_chat_id: z.union([z.string().min(1), z.number().int()]).optional(),
});

// `lib` is a path on the operator's machine, used only by the local skill. The
// cloud reads the same variants from the GitHub repository in `repo` at `ref`.
const resume = z.strictObject({
  lib: z.string().optional(),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"')
    .optional(),
  ref: z.string().min(1).optional(),
  variants: strings.optional(),
  default: z.string().optional(),
});

export const rawConfig = z.strictObject({
  account: z.array(account).optional(),
  mail: mail.optional(),
  profile: profile.optional(),
  report: report.optional(),
  resume: resume.optional(),
});

export type RawConfig = z.infer<typeof rawConfig>;
export type RawAccount = z.infer<typeof account>;
export type ProfileConfig = z.infer<typeof profile>;
export type ReportConfig = z.infer<typeof report>;
export type RawResume = z.infer<typeof resume>;
