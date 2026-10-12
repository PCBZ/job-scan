import { describe, expect, it } from "vitest";
import { loadSecrets, secretName } from "../../src/lib/run/secrets.js";

/** A fake of the SDK client's one method the loader uses. */
function vault(secrets: Record<string, string>, fail?: Error) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      async getSecret(name: string) {
        asked.push(name);
        if (fail) throw fail;
        if (!(name in secrets))
          throw Object.assign(new Error("SecretNotFound"), { statusCode: 404 });
        return { name, value: secrets[name], properties: {} } as never;
      },
    },
  };
}

describe("loadSecrets", () => {
  it("fills each listed setting from the secret named after it", async () => {
    const v = vault({ "gmail-main-password": "test-password-a", "github-resume-pat": "test-pat" });
    const out = await loadSecrets(
      { KEY_VAULT_SECRETS: " GMAIL_MAIN_PASSWORD, GITHUB_RESUME_PAT ,", OTHER: "kept" },
      v.client,
    );
    expect(v.asked.sort()).toEqual(["github-resume-pat", "gmail-main-password"]);
    expect(out.env).toMatchObject({
      GMAIL_MAIN_PASSWORD: "test-password-a",
      GITHUB_RESUME_PAT: "test-pat",
      OTHER: "kept",
    });
    expect(out.missing).toEqual([]);
  });

  it("reports a secret that doesn't exist, and leaves its setting unset", async () => {
    const out = await loadSecrets({ KEY_VAULT_SECRETS: "GMAIL_ALT_USER" }, vault({}).client);
    expect(out.missing).toEqual(["GMAIL_ALT_USER"]);
    expect(out.env.GMAIL_ALT_USER).toBeUndefined();
  });

  it("unsets a listed setting whose secret is gone, whatever value it had", async () => {
    const out = await loadSecrets(
      { KEY_VAULT_SECRETS: "GMAIL_ALT_PASSWORD", GMAIL_ALT_PASSWORD: "stale" },
      vault({}).client,
    );
    expect(out.missing).toEqual(["GMAIL_ALT_PASSWORD"]);
    expect("GMAIL_ALT_PASSWORD" in out.env).toBe(false);
  });

  it("fails the run on any other error, such as no access", async () => {
    const denied = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    await expect(
      loadSecrets({ KEY_VAULT_SECRETS: "GITHUB_RESUME_PAT" }, vault({}, denied).client),
    ).rejects.toThrow("Forbidden");
  });

  it("needs the vault only when there is something to read", async () => {
    const env = { CONFIG_BLOB_URL: "x" };
    expect(await loadSecrets(env, null)).toEqual({ env, missing: [] });
    await expect(loadSecrets({ KEY_VAULT_SECRETS: "A" }, null)).rejects.toMatchObject({
      code: "config",
    });
  });

  it("doesn't change the env it was given", async () => {
    const env = { KEY_VAULT_SECRETS: "TELEGRAM_BOT_TOKEN" };
    await loadSecrets(env, vault({ "telegram-bot-token": "t" }).client);
    expect(env).toEqual({ KEY_VAULT_SECRETS: "TELEGRAM_BOT_TOKEN" });
  });
});

describe("secretName", () => {
  it("lowercases and turns _ into -", () => {
    expect(secretName("GMAIL_MAIN_PASSWORD")).toBe("gmail-main-password");
  });
});
