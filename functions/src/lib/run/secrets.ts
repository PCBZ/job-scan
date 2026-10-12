// Secrets from Key Vault, read by the app itself at the start of a run. The
// Function App runs as a user-assigned identity, and Flex Consumption can't
// point Key Vault references at one (azurerm has no
// key_vault_reference_identity_id for it), so the app signs in and reads them.
//
// KEY_VAULT_SECRETS names the app settings to fill, comma-separated; each
// reads the secret named after it, lowercase with "_" as "-"
// (GMAIL_MAIN_PASSWORD reads gmail-main-password). Values live in memory only.

import type { TokenCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { appError } from "../errors.js";

type Env = Record<string, string | undefined>;

/** A setting's secret name: lowercase, "_" as "-" (Key Vault allows letters, digits and "-"). */
export const secretName = (setting: string) => setting.toLowerCase().replaceAll("_", "-");

export interface LoadedSecrets {
  env: Env;
  /** Settings whose secret doesn't exist; the run treats them as unset. */
  missing: string[];
}

/**
 * `env` with every KEY_VAULT_SECRETS setting filled from the vault. A missing
 * secret is reported, not thrown: a mailbox without credentials degrades the
 * report, and a required setting fails where it's checked. Any other error
 * (no access, no network) fails the run.
 */
export async function loadSecrets(
  env: Env,
  client: Pick<SecretClient, "getSecret"> | null,
): Promise<LoadedSecrets> {
  const settings = (env.KEY_VAULT_SECRETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (settings.length === 0) return { env, missing: [] };
  if (!client) throw appError("config", "KEY_VAULT_SECRETS is set but KEY_VAULT_URI isn't");

  const read = await Promise.all(
    settings.map(async (setting) => {
      try {
        return [setting, (await client.getSecret(secretName(setting))).value] as const;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404)
          return [setting, undefined] as const;
        throw err;
      }
    }),
  );
  const out: Env = { ...env };
  const missing: string[] = [];
  for (const [setting, value] of read) {
    if (value === undefined) {
      // A listed setting comes from the vault only: no value set elsewhere stands in.
      missing.push(setting);
      delete out[setting];
    } else out[setting] = value;
  }
  return { env: out, missing };
}

/** The vault's client, or null when KEY_VAULT_URI isn't set (a local run). */
export function secretClientFromEnv(env: Env, credential: TokenCredential): SecretClient | null {
  const uri = env.KEY_VAULT_URI?.trim();
  return uri ? new SecretClient(uri, credential) : null;
}
