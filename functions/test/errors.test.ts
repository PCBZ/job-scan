import { describe, expect, it } from "vitest";
import { appError, isAppError } from "../src/lib/errors.js";

describe("appError", () => {
  it("is a real Error, named by its code, with its fields and cause", () => {
    const cause = new Error("socket hang up");
    const err = appError("model_provider", "chat: 503", { status: 503, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "model_provider", code: "model_provider", status: 503 });
    expect(err.cause).toBe(cause);
    expect(String(err)).toBe("model_provider: chat: 503");
    expect(err.stack).toContain("errors.test.ts");
  });

  it("leaves cause unset when none is given", () => {
    expect("cause" in appError("config", "x")).toBe(false);
    expect("cause" in appError("telegram", "x", { status: 400, retryAfter: undefined })).toBe(
      false,
    );
  });

  it("keeps the code it was given, whatever fields come with it", () => {
    const fields = { status: 503, code: "model_output", name: "model_output" };
    const err = appError("model_provider", "chat: 503", fields);
    expect(err).toMatchObject({ name: "model_provider", code: "model_provider", status: 503 });
    expect(isAppError(err, "model_provider")).toBe(true);
  });
});

describe("isAppError", () => {
  it("matches the code only", () => {
    const err = appError("model_output", "cut off");
    expect(isAppError(err, "model_output")).toBe(true);
    expect(isAppError(err, "model_provider")).toBe(false);
    expect(isAppError(Object.assign(new Error("x"), { code: "ENOENT" }), "config")).toBe(false);
    expect(isAppError({ code: "config" }, "config")).toBe(false);
    expect(isAppError(null, "config")).toBe(false);
  });
});
