import { APIUserAbortError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  choice,
  DecisionProviderError,
  DecisionRequestError,
  noul,
  score,
} from "../../src/lib/decision/client.js";
import { DecisionConfigError, decisionClientFromEnv } from "../../src/lib/decision/config.js";

const ANSWERS = {
  remote: { type: "noul", noul: 0.92 },
  seniority: {
    type: "score",
    score: 1.4,
    confidence: 0.7,
    legend: { "0": "junior", "1": "mid", "2": "senior" },
    probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
  },
  variant: {
    type: "choice",
    choice: "backend",
    confidence: 0.8,
    probabilities: { backend: 0.8, frontend: 0.2 },
  },
};

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that answers each call from `replies` in turn and records what was sent. */
function fakeFetch(...replies: (Response | Error | "hang")[]) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const reply = replies[sent.length - 1] ?? replies.at(-1);
    if (reply === "hang") {
      return new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}

const ok = (
  body: unknown = {
    model: "jev-1.13.0",
    answers: ANSWERS,
    usage: { input_tokens: 120, output_tokens: 0 },
  },
) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ detail: `status ${code}` }), {
    status: code,
    headers: { "content-type": "application/json", ...headers },
  });

const ENV = { TYPESAFE_API_KEY: "test-key", JEV_MAX_RETRIES: "0" };
const QUESTIONS = {
  remote: noul("Is this role open to someone working from Canada?"),
  seniority: score("How senior is this role?", ["junior", "mid", "senior"]),
  variant: choice("Which resume fits best?", { backend: null, frontend: null }),
};

describe("DecisionClient", () => {
  it("asks the pinned model, and returns typed answers with usage", async () => {
    const { fetchFn, sent } = fakeFetch(ok());
    const client = decisionClientFromEnv(ENV, { fetch: fetchFn });
    const r = await client.ask({ state: { posting: "Remote, Canada" }, questions: QUESTIONS });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer test-key");
    expect(sent[0]?.body).toMatchObject({
      model: "jev-1.13.0",
      state: { posting: "Remote, Canada" },
      questions: {
        remote: { type: "noul", instructions: "Is this role open to someone working from Canada?" },
        seniority: { type: "score", criteria: ["junior", "mid", "senior"] },
        variant: { type: "choice", criteria: { backend: null, frontend: null } },
      },
    });

    // The answer types follow the questions.
    const yes: number = r.answers.remote.noul;
    const pick: "backend" | "frontend" = r.answers.variant.choice;
    expect([yes, r.answers.seniority.score, pick]).toEqual([0.92, 1.4, "backend"]);
    expect(r.usage).toEqual({ input: 120, output: 0 });
    expect(r.model).toBe("jev-1.13.0");
  });

  it("uses JEV_MODEL when set", async () => {
    const { fetchFn, sent } = fakeFetch(ok());
    await decisionClientFromEnv({ ...ENV, JEV_MODEL: "jev-1.14.0" }, { fetch: fetchFn }).ask({
      state: "x",
      questions: { remote: QUESTIONS.remote },
    });
    expect(sent[0]?.body.model).toBe("jev-1.14.0");
  });

  it.each([401, 403, 422])("a %i is the request's fault, not retried", async (code) => {
    const { fetchFn, sent } = fakeFetch(status(code));
    const client = decisionClientFromEnv({ ...ENV, JEV_MAX_RETRIES: "2" }, { fetch: fetchFn });
    const err = await client.ask({ state: "x", questions: QUESTIONS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionRequestError);
    expect((err as DecisionRequestError).status).toBe(code);
    expect(sent).toHaveLength(1);
  });

  it.each([429, 500, 529])("a %i left after the retries is the provider's", async (code) => {
    const { fetchFn } = fakeFetch(status(code));
    const err = await decisionClientFromEnv(ENV, { fetch: fetchFn })
      .ask({ state: "x", questions: QUESTIONS })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionProviderError);
    expect((err as DecisionProviderError).status).toBe(code);
  });

  it("retries a rate limit, honouring retry-after", async () => {
    const { fetchFn, sent } = fakeFetch(status(429, { "retry-after-ms": "1" }), ok());
    const client = decisionClientFromEnv({ ...ENV, JEV_MAX_RETRIES: "1" }, { fetch: fetchFn });
    const r = await client.ask({ state: "x", questions: QUESTIONS });
    expect(sent).toHaveLength(2);
    expect(r.answers.remote.noul).toBe(0.92);
  });

  it("a network failure or a timeout is the provider's", async () => {
    const down = fakeFetch(new TypeError("fetch failed"));
    await expect(
      decisionClientFromEnv(ENV, { fetch: down.fetchFn }).ask({ state: "x", questions: QUESTIONS }),
    ).rejects.toBeInstanceOf(DecisionProviderError);

    const slow = fakeFetch("hang");
    await expect(
      decisionClientFromEnv({ ...ENV, JEV_TIMEOUT_MS: "5" }, { fetch: slow.fetchFn }).ask({
        state: "x",
        questions: QUESTIONS,
      }),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it("passes a cancelled run through untouched", async () => {
    const controller = new AbortController();
    const { fetchFn } = fakeFetch("hang");
    const asked = decisionClientFromEnv(ENV, { fetch: fetchFn }).ask({
      state: "x",
      questions: QUESTIONS,
      signal: controller.signal,
    });
    controller.abort();
    await expect(asked).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("an empty question set is the request's fault, and is never sent", async () => {
    const { fetchFn, sent } = fakeFetch(ok());
    await expect(
      decisionClientFromEnv(ENV, { fetch: fetchFn }).ask({ state: "x", questions: {} }),
    ).rejects.toBeInstanceOf(DecisionRequestError);
    expect(sent).toHaveLength(0);
  });
});

describe("DecisionClient response checks", () => {
  const good = {
    model: "jev-1.13.0",
    answers: ANSWERS,
    usage: { input_tokens: 120, output_tokens: 0 },
  };
  const answer = <K extends keyof typeof ANSWERS>(name: K, over: Record<string, unknown>) => ({
    ...good,
    answers: { ...ANSWERS, [name]: { ...ANSWERS[name], ...over } },
  });
  const { remote: _remote, ...withoutRemote } = ANSWERS;

  it.each([
    ["no usage", { ...good, usage: undefined }, "usage"],
    [
      "a token count that isn't a number",
      { ...good, usage: { input_tokens: "120", output_tokens: 0 } },
      "usage.input_tokens",
    ],
    ["no model", { ...good, model: "" }, "model"],
    ["a missing answer", { ...good, answers: withoutRemote }, "answers.remote"],
    ["a noul that isn't a number", answer("remote", { noul: "yes" }), "answers.remote.noul"],
    ["a noul above 1", answer("remote", { noul: 1.2 }), "answers.remote.noul"],
    ["an answer of the wrong type", answer("remote", { type: "score" }), "answers.remote.type"],
    ["a score past the top level", answer("seniority", { score: 2.5 }), "answers.seniority.score"],
    [
      "a score without confidence",
      answer("seniority", { confidence: undefined }),
      "answers.seniority.confidence",
    ],
    [
      "a choice that isn't an option",
      answer("variant", { choice: "devops" }),
      "answers.variant.choice",
    ],
    [
      "a probability out of range",
      answer("variant", { probabilities: { backend: 1.5 } }),
      "answers.variant.probabilities.backend",
    ],
  ])("rejects %s as a provider failure", async (_, body, where) => {
    const { fetchFn } = fakeFetch(ok(body));
    const err = await decisionClientFromEnv(ENV, { fetch: fetchFn })
      .ask({ state: "x", questions: QUESTIONS })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionProviderError);
    expect((err as Error).message).toContain(`malformed response at ${where}:`);
  });

  it("rejects a body that isn't JSON", async () => {
    const { fetchFn } = fakeFetch(new Response("upstream hiccup", { status: 200 }));
    await expect(
      decisionClientFromEnv(ENV, { fetch: fetchFn }).ask({ state: "x", questions: QUESTIONS }),
    ).rejects.toThrow("malformed response at body:");
  });
});

describe("decisionClientFromEnv", () => {
  it("needs the API key", () => {
    expect(() => decisionClientFromEnv({})).toThrow(DecisionConfigError);
    expect(() => decisionClientFromEnv({ TYPESAFE_API_KEY: "  " })).toThrow(
      "TYPESAFE_API_KEY is not set",
    );
  });

  it.each([
    ["JEV_TIMEOUT_MS", "0"],
    ["JEV_TIMEOUT_MS", "soon"],
    ["JEV_MAX_RETRIES", "-1"],
    ["JEV_MAX_RETRIES", "1.5"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => decisionClientFromEnv({ ...ENV, [key]: value })).toThrow(DecisionConfigError);
  });
});
