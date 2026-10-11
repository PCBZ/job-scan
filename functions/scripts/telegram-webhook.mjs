// Point the bot's webhook at the deployed function, with the secret token
// Telegram sends back on every call (#24):
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
//     npm run telegram:webhook -- https://<function-app>.azurewebsites.net/api/telegram/webhook
//
// Only button callbacks are delivered (allowed_updates), and updates queued
// before now are dropped. Prints the webhook's state, never the token or secret.

/** The Bot API endpoint: https://core.telegram.org/bots/api#setwebhook */
const TELEGRAM_API = "https://api.telegram.org";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const url = process.argv[2];
if (!token || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
  process.exit(1);
}
// The function rejects anything shorter; see src/lib/delivery/webhook.ts.
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET must be 32-256 of A-Z a-z 0-9 _ -, e.g. openssl rand -hex 32.");
  process.exit(1);
}
if (!url?.startsWith("https://")) {
  console.error("Pass the function's https URL, ending in /api/telegram/webhook.");
  process.exit(1);
}

async function call(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!body?.ok) {
    console.error(`${method}: ${body?.description ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  return body.result;
}

await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["callback_query"],
  drop_pending_updates: true,
});
const info = await call("getWebhookInfo", {});
console.log(`webhook: ${info.url}`);
console.log(`allowed updates: ${(info.allowed_updates ?? []).join(", ")}`);
console.log(`pending updates: ${info.pending_update_count}`);
if (info.last_error_message) console.log(`last error: ${info.last_error_message}`);
