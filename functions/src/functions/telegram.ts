import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";

// Placeholder for Telegram button callbacks. Telegram only needs a 200 ack;
// secret-token verification and state updates arrive with the webhook issue.
export async function telegram(
  _request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  context.log("telegram: callback received");
  return { status: 200 };
}

app.http("telegram", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "telegram/webhook",
  handler: telegram,
});
