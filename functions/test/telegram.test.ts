import { HttpRequest, InvocationContext } from "@azure/functions";
import { afterEach, describe, expect, it } from "vitest";
import { telegram } from "../src/functions/telegram.js";

// The HTTP wiring only: the header and body reach handleWebhook, whose rules
// test/delivery/webhook.test.ts covers.
const SECRET = "s".repeat(32);
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const request = (headers: Record<string, string>) =>
  new HttpRequest({
    method: "POST",
    url: "http://localhost:7071/api/telegram/webhook",
    headers,
    body: { string: JSON.stringify({ update_id: 1, message: { text: "hi" } }) },
  });

describe("telegram", () => {
  it("passes the secret header through: without it, 401", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    expect((await telegram(request({}), new InvocationContext())).status).toBe(401);
    const ok = await telegram(
      request({ "X-Telegram-Bot-Api-Secret-Token": SECRET }),
      new InvocationContext(),
    );
    expect(ok.status).toBe(200);
  });
});
