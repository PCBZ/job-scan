import { app, type HttpRequest, type InvocationContext } from "@azure/functions";
import { handleWebhook } from "../lib/delivery/webhook.js";

// The Telegram webhook (#24), registered by `npm run telegram:webhook`. Public
// (anonymous): Telegram can't send a function key, so its secret token header
// is the authentication.
export async function telegram(request: HttpRequest, context: InvocationContext) {
  return handleWebhook(
    {
      secretHeader: request.headers.get("x-telegram-bot-api-secret-token"),
      body: await request.text(),
    },
    { env: process.env, fetch, log: context },
  );
}

app.http("telegram", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "telegram/webhook",
  handler: telegram,
});
