// Read config.toml (from blob storage in Azure), parse it and validate it.
// A missing or invalid file is a hard error, never a fallback to defaults:
// the config carries the sender allowlist, and without it the fetch would
// match every recent message.

import type { TokenCredential } from "@azure/identity";
import { BlobClient, RestError } from "@azure/storage-blob";
import { parse, TomlError } from "smol-toml";
import type { MailRunConfig } from "../mail/types.js";
import { ConfigError } from "./error.js";
import { mailConfig } from "./mail.js";
import { type ProfileConfig, type ReportConfig, rawConfig } from "./schema.js";

export { ConfigError } from "./error.js";

export interface AppConfig {
  mail: MailRunConfig;
  profile: ProfileConfig;
  report: ReportConfig;
}

export interface ConfigSource {
  /** Where the config comes from, for error messages. */
  readonly origin: string;
  /** The file's text, or null when it does not exist. */
  read(): Promise<string | null>;
}

export function blobConfigSource(blobUrl: string, credential: TokenCredential): ConfigSource {
  const client = new BlobClient(blobUrl, credential);
  return {
    origin: blobUrl,
    async read() {
      try {
        return (await client.downloadToBuffer()).toString("utf8");
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
    },
  };
}

export function parseConfig(text: string, origin: string): AppConfig {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    if (err instanceof TomlError) {
      throw new ConfigError(`${origin} is not valid TOML: ${err.message}`);
    }
    throw err;
  }
  const result = rawConfig.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const where = issue.path
        .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
        .join("")
        .replace(/^\./, "");
      return `  ${where || "(root)"}: ${issue.message}`;
    });
    throw new ConfigError(`${origin} is invalid:\n${problems.join("\n")}`);
  }
  const raw = result.data;
  return { mail: mailConfig(raw, origin), profile: raw.profile ?? {}, report: raw.report ?? {} };
}

export async function loadConfig(source: ConfigSource): Promise<AppConfig> {
  const text = await source.read();
  if (text === null) {
    throw new ConfigError(
      `${source.origin} not found. Refusing to run without a sender allowlist; ` +
        "that would fetch unrelated mail.",
    );
  }
  return parseConfig(text, source.origin);
}
