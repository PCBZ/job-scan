import { HttpRequest, InvocationContext } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { telegram } from "../src/functions/telegram.js";

describe("telegram", () => {
  it("acknowledges a callback with 200", async () => {
    const request = new HttpRequest({
      method: "POST",
      url: "http://localhost:7071/api/telegram/webhook",
      body: { string: "{}" },
    });
    const response = await telegram(request, new InvocationContext());
    expect(response.status).toBe(200);
  });
});
