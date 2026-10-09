// Print the chats that have messaged your bot, to find telegram_chat_id:
//
//   TELEGRAM_BOT_TOKEN=... npm run telegram:chat-id
//
// Message the bot once first (e.g. /start). Prints chat ids and names only,
// never message text, and never the token.

/** The Bot API endpoint: https://core.telegram.org/bots/api#making-requests */
const TELEGRAM_API = "https://api.telegram.org";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN first.");
  process.exit(1);
}
const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`);
// A proxy can answer with HTML, and a malformed success has no result list:
// say so rather than report "no chats".
const body = await res.json().catch(() => null);
if (!body?.ok) {
  console.error(body ? `Telegram said: ${body.description ?? res.status}` : `Unreadable reply (HTTP ${res.status}).`);
  process.exit(1);
}
if (!Array.isArray(body.result)) {
  console.error("Telegram's reply had no list of updates; try again.");
  process.exit(1);
}
const chats = new Map();
for (const update of body.result) {
  const chat = (update.message ?? update.my_chat_member ?? update.callback_query?.message)?.chat;
  if (chat) chats.set(chat.id, `${chat.type}: ${chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ")}`);
}
if (chats.size === 0) console.log("No chats yet: send your bot a message, then run this again.");
for (const [id, who] of chats) console.log(`${id}  (${who})`);
