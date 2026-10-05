// Port of workspace.mail_config(): accounts fully populated from [mail]
// defaults, provider presets and per-account overrides, so callers never test
// whether a key is set. Credentials are not here; an account names the
// environment variables that hold them.

import type { MailAccount, MailRunConfig } from "../mail/types.js";
import { ConfigError } from "./error.js";
import type { RawConfig } from "./schema.js";

/** Saves repeating host strings. */
export const PROVIDERS: Record<string, { host: string; port: number }> = {
  gmail: { host: "imap.gmail.com", port: 993 },
  m365: { host: "outlook.office365.com", port: 993 },
  outlook: { host: "outlook.office365.com", port: 993 },
  icloud: { host: "imap.mail.me.com", port: 993 },
  yahoo: { host: "imap.mail.yahoo.com", port: 993 },
  fastmail: { host: "imap.fastmail.com", port: 993 },
};

const SHARED_DEFAULTS = {
  senders: [] as string[],
  subjectKeywords: [] as string[],
  excludeSenders: [] as string[],
  maxMessages: 60,
  maxCharsPerMessage: 6000,
};

export function mailConfig(raw: RawConfig, origin: string): MailRunConfig {
  const mail = raw.mail ?? {};
  const shared = {
    senders: mail.senders ?? SHARED_DEFAULTS.senders,
    subjectKeywords: mail.subject_keywords ?? SHARED_DEFAULTS.subjectKeywords,
    excludeSenders: mail.exclude_senders ?? SHARED_DEFAULTS.excludeSenders,
    maxMessages: mail.max_messages ?? SHARED_DEFAULTS.maxMessages,
    maxCharsPerMessage: mail.max_chars_per_message ?? SHARED_DEFAULTS.maxCharsPerMessage,
  };

  const entries = raw.account ?? [];
  if (entries.length === 0) {
    throw new ConfigError(
      `no [[account]] block in ${origin}. Define at least one mailbox; see config.example.toml.`,
    );
  }

  const accounts: MailAccount[] = [];
  const seenNames = new Set<string>();
  const seenEnv = new Map<string, string>();
  entries.forEach((entry, index) => {
    const name = entry.name ?? `account${index + 1}`;
    if (seenNames.has(name.toLowerCase())) {
      throw new ConfigError(
        `duplicate account name "${name}" in ${origin}; names key the dedupe state, so they must be unique.`,
      );
    }
    seenNames.add(name.toLowerCase());
    const slug =
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "ACCOUNT";

    const provider = (entry.provider ?? "").trim().toLowerCase();
    if (provider && !(provider in PROVIDERS)) {
      throw new ConfigError(
        `account "${name}" has unknown provider "${provider}" in ${origin}. ` +
          `Known: ${Object.keys(PROVIDERS).sort().join(", ")}; or set host directly.`,
      );
    }
    const preset = PROVIDERS[provider];
    const host = entry.host ?? preset?.host;
    if (!host) {
      throw new ConfigError(
        `account "${name}" in ${origin} sets neither provider nor host. ` +
          "Guessing a mail server is how you end up connecting to the wrong one.",
      );
    }

    const account: MailAccount = {
      name,
      host,
      port: entry.port ?? preset?.port ?? 993,
      folder: entry.folder ?? "INBOX",
      senders: entry.senders ?? shared.senders,
      subjectKeywords: entry.subject_keywords ?? shared.subjectKeywords,
      excludeSenders: entry.exclude_senders ?? shared.excludeSenders,
      maxMessages: entry.max_messages ?? shared.maxMessages,
      maxCharsPerMessage: entry.max_chars_per_message ?? shared.maxCharsPerMessage,
      userEnv: entry.user_env ?? `${slug}_USER`,
      passwordEnv: entry.password_env ?? `${slug}_PASSWORD`,
    };

    // With neither filter the IMAP search is bare SINCE and matches every
    // recent message, which would pull ordinary personal mail in.
    if (account.senders.length === 0 && account.subjectKeywords.length === 0) {
      throw new ConfigError(
        `account "${name}" in ${origin} has neither senders nor subject_keywords. ` +
          "Set at least one filter, under [mail] or on the account.",
      );
    }

    // "gmail-work" and "gmail.work" both become GMAIL_WORK_*; two accounts
    // silently sharing credentials is worse than a startup error.
    const envKey = `${account.userEnv}\u0000${account.passwordEnv}`;
    const other = seenEnv.get(envKey);
    if (other !== undefined) {
      throw new ConfigError(
        `accounts "${other}" and "${name}" both resolve to ${account.userEnv} / ${account.passwordEnv} in ${origin}. ` +
          "Set user_env and password_env explicitly on at least one of them.",
      );
    }
    seenEnv.set(envKey, name);
    accounts.push(account);
  });

  // max_messages is per account, so the whole-run ceiling caps total volume.
  return {
    accounts,
    maxTotalMessages: mail.max_total_messages ?? 150,
    days: mail.days ?? 2,
  };
}
