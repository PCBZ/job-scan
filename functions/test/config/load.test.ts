import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  type ConfigSource,
  loadConfig,
  parseConfig,
} from "../../src/lib/config/load.js";

const EXAMPLE = readFileSync(new URL("../../../config.example.toml", import.meta.url), "utf8");

const RESUME = `
[resume]
repo = "PCBZ/Resume"
`;

const MIN = `${RESUME}
[mail]
senders = ["linkedin.com"]

[[account]]
name = "gmail-main"
provider = "gmail"
`;

function source(text: string | null): ConfigSource {
  return { origin: "test://config.toml", read: async () => text };
}

function errorOf(text: string): string {
  try {
    parseConfig(text, "config.toml");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig on config.example.toml", () => {
  const cfg = parseConfig(EXAMPLE, "config.example.toml");

  it("populates every account from presets, [mail] defaults and overrides", () => {
    expect(
      cfg.mail.accounts.map((a) => [a.name, a.host, a.port, a.userEnv, a.passwordEnv]),
    ).toEqual([
      ["gmail-main", "imap.gmail.com", 993, "GMAIL_MAIN_USER", "GMAIL_MAIN_PASSWORD"],
      ["gmail-alt", "imap.gmail.com", 993, "GMAIL_ALT_USER", "GMAIL_ALT_PASSWORD"],
      [
        "outlook-personal",
        "outlook.office365.com",
        993,
        "OUTLOOK_PERSONAL_USER",
        "OUTLOOK_PERSONAL_PASSWORD",
      ],
    ]);
    const [main, , outlook] = cfg.mail.accounts;
    expect(outlook?.senders).toEqual(["linkedin.com", "joinhandshake.com", "careers"]);
    expect(main?.senders).not.toEqual(outlook?.senders);
    expect(main?.maxMessages).toBe(60);
  });

  it("reads the resume repository and variant globs", () => {
    expect(cfg.resume).toEqual({
      owner: "you",
      repo: "my-resume",
      ref: "main",
      variants: ["*.tex", "src/*.tex"],
      default: "resume",
    });
  });

  it("reads the run-level mail settings, profile and report", () => {
    expect(cfg.mail.days).toBe(7);
    expect(cfg.mail.maxTotalMessages).toBe(150);
    expect(cfg.profile.seniority).toBe("all");
    expect(cfg.profile.needs_sponsorship).toBe("unknown");
    expect(cfg.report.max_top_picks).toBe(5);
  });
});

describe("parseConfig defaults", () => {
  it("applies the mail_config defaults when [mail] leaves them out", () => {
    const cfg = parseConfig(MIN, "config.toml");
    expect(cfg.mail).toMatchObject({ days: 2, maxTotalMessages: 150 });
    expect(cfg.mail.accounts[0]).toMatchObject({
      folder: "INBOX",
      maxMessages: 60,
      maxCharsPerMessage: 6000,
      subjectKeywords: [],
    });
  });

  it("defaults the resume ref and variant globs", () => {
    expect(parseConfig(MIN, "c").resume).toEqual({
      owner: "PCBZ",
      repo: "Resume",
      ref: "main",
      variants: ["*.tex", "*.pdf", "*.md", "*.txt"],
      default: null,
    });
  });

  it("names unnamed accounts by position", () => {
    const cfg = parseConfig(
      `${RESUME}[mail]\nsenders = ["x"]\n[[account]]\nhost = "imap.example.com"\n`,
      "c",
    );
    expect(cfg.mail.accounts[0]).toMatchObject({
      name: "account1",
      userEnv: "ACCOUNT1_USER",
      port: 993,
    });
  });
});

describe("parseConfig rejects", () => {
  it.each([
    [
      "an unknown key (typo)",
      `${MIN}\n[profile]\nseniorty = "mid"\n`,
      'profile: Unrecognized key: "seniorty"',
    ],
    [
      "a wrong type",
      MIN.replace('senders = ["linkedin.com"]', 'senders = ["linkedin.com"]\ndays = "seven"'),
      "mail.days",
    ],
    ["a value outside an enum", `${MIN}\n[profile]\nseniority = "lead"\n`, "profile.seniority"],
    ["an unknown top-level table", `${MIN}\n[extras]\nx = 1\n`, 'Unrecognized key: "extras"'],
    ["a config with no accounts", `[mail]\nsenders = ["x"]\n`, "no [[account]] block"],
    ["an unknown provider", MIN.replace('"gmail"', '"hotmail"'), 'unknown provider "hotmail"'],
    [
      "an inherited property name as provider",
      MIN.replace('"gmail"', '"constructor"'),
      'unknown provider "constructor"',
    ],
    [
      "__proto__ as provider",
      MIN.replace('"gmail"', '"__proto__"'),
      'unknown provider "__proto__"',
    ],
    [
      "an account with neither provider nor host",
      `[mail]\nsenders = ["x"]\n[[account]]\nname = "a"\n`,
      "sets neither provider nor host",
    ],
    [
      "duplicate account names, case-insensitively",
      `${MIN}\n[[account]]\nname = "GMAIL-MAIN"\nprovider = "gmail"\n`,
      'duplicate account name "GMAIL-MAIN"',
    ],
    [
      "an account with no sender or keyword filter",
      `[[account]]\nname = "a"\nprovider = "gmail"\n`,
      "neither senders nor subject_keywords",
    ],
    [
      "two accounts sharing env vars",
      `${MIN}\n[[account]]\nname = "gmail.main"\nprovider = "gmail"\n`,
      "both resolve to GMAIL_MAIN_USER / GMAIL_MAIN_PASSWORD",
    ],
    ["invalid TOML", "[mail\nsenders = 1", "is not valid TOML"],
    [
      "a config without [resume] repo",
      MIN.replace('repo = "PCBZ/Resume"', ""),
      "[resume] repo is not set",
    ],
    [
      "a malformed resume repo",
      MIN.replace('"PCBZ/Resume"', '"PCBZ"'),
      'resume.repo: expected "owner/name"',
    ],
  ])("%s", (_name, text, expected) => {
    expect(errorOf(text)).toContain(expected);
  });
});

describe("loadConfig", () => {
  it("refuses to run without a config file", async () => {
    await expect(loadConfig(source(null))).rejects.toThrow(
      "test://config.toml not found. Refusing to run without a sender allowlist",
    );
  });

  it("parses what the source returns", async () => {
    const cfg = await loadConfig(source(MIN));
    expect(cfg.mail.accounts).toHaveLength(1);
  });
});
