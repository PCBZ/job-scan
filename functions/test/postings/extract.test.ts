import { describe, expect, it } from "vitest";
import type { FetchedMessage } from "../../src/lib/mail/types.js";
import {
  type ModelClient,
  ModelOutputError,
  ModelProviderError,
  type StructuredRequest,
} from "../../src/lib/model/types.js";
import { extractStep } from "../../src/lib/postings/extract.js";
import { EXTRACT_SYSTEM } from "../../src/lib/postings/prompt.js";
import type { ExtractedPosting } from "../../src/lib/postings/schema.js";
import type { Posting } from "../../src/lib/postings/types.js";
import { problemFor } from "../../src/lib/postings/validate.js";
import { fixture } from "./fixtures.js";

function row(over: Partial<ExtractedPosting> = {}): ExtractedPosting {
  return {
    title: "Backend Engineer",
    company: "Lumen Ridge",
    location: "Vancouver, BC",
    workplace: "unknown",
    salary: "",
    posted: "",
    requirements: [],
    skills: [],
    link: 0,
    ...over,
  };
}

function message(id: string, over: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    account: "personal",
    message_id: id,
    from: "Indeed <alert@indeed.com>",
    subject: `alert ${id}`,
    date: "",
    body: `body of ${id}`,
    body_source: "plain",
    links: [{ text: "Backend Engineer", url: `https://example.test/${id}` }],
    ...over,
  };
}

/** Answers each call from `answer`, keyed by the message's subject line. */
function client(answer: (user: string, req: StructuredRequest<unknown>) => ExtractedPosting[]) {
  const calls: StructuredRequest<unknown>[] = [];
  const c: ModelClient = {
    async structured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      const postings = answer(req.user, req as StructuredRequest<unknown>);
      return { value: { postings } as T, usage: { input: 100, output: 10 }, served_by: "primary" };
    },
  };
  return { c, calls };
}

describe("extractStep", () => {
  it("calls the model once per message, and fills provenance from the message", async () => {
    const { message: m } = fixture("linkedin");
    const { c, calls } = client(() => [
      row({ title: " Backend Engineer ", link: 0, skills: ["Go", " go ", "Kubernetes", ""] }),
      row({ title: "Platform Engineer, Kubernetes", link: 9 }),
      row({ title: "Software Developer II", link: null }),
    ]);
    const out = await extractStep(c)({ messages: [m] }, []);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(EXTRACT_SYSTEM);
    expect(calls[0]?.user).toContain(`Subject: ${m.subject}`);
    expect(calls[0]?.user).toContain("[0] Backend Engineer\n[1] Platform Engineer, Kubernetes");
    expect(calls[0]?.repairs).toEqual([]);

    const [first, second, third] = out.value as [Posting, Posting, Posting];
    expect(first).toMatchObject({
      title: "Backend Engineer",
      skills: ["Go", "Kubernetes"],
      url: "https://www.linkedin.com/comm/jobs/view/4000000001",
      source: "linkedin",
      account: "school",
      message_id: m.message_id,
      message_subject: m.subject,
      row: 0,
    });
    // A link the message doesn't have, or none, leaves the url empty.
    expect(second).toMatchObject({ url: "", row: 1 });
    expect(third).toMatchObject({ url: "", row: 2 });
    expect(out.usage).toEqual({ input: 100, output: 10 });
    expect(out.warnings).toEqual([]);
  });

  it("on a repair, re-asks only the messages with problems, each with its own history", async () => {
    const messages = [message("<a@x>"), message("<b@x>")];
    let round = 0;
    const { c, calls } = client(() => [row({ company: `round ${round}` })]);
    const step = extractStep(c);

    const first = await step({ messages }, []);
    expect(calls).toHaveLength(2);

    round = 1;
    const problems = [problemFor("<b@x>", 0, 'company "4d" is a badge')];
    const second = await step({ messages }, [{ previous: first.value, problems }]);

    expect(calls).toHaveLength(3);
    const repair = calls[2] as StructuredRequest<unknown>;
    expect(repair.user).toContain("Subject: alert <b@x>");
    expect(repair.repairs).toEqual([
      { previous: { postings: [row({ company: "round 0" })] }, problems },
    ]);
    // <a@x> keeps its first answer; <b@x> takes the new one. Order is kept.
    expect((second.value as Posting[]).map((p) => [p.message_id, p.company])).toEqual([
      ["<a@x>", "round 0"],
      ["<b@x>", "round 1"],
    ]);
    expect(second.usage).toEqual({ input: 100, output: 10 });
  });

  it("sends a message only the repair turns where it had problems", async () => {
    const messages = [message("<a@x>"), message("<b@x>")];
    const { c, calls } = client(() => [row()]);
    const step = extractStep(c);
    const first = (await step({ messages }, [])).value;
    const turn1 = { previous: first, problems: [problemFor("<a@x>", 0, "one")] };
    const turn2 = { previous: first, problems: [problemFor("<b@x>", 0, "two")] };
    await step({ messages }, [turn1, turn2]);
    const repair = calls.at(-1) as StructuredRequest<unknown>;
    expect(repair.user).toContain("Subject: alert <b@x>");
    expect(repair.repairs).toEqual([
      { previous: { postings: [row()] }, problems: [problemFor("<b@x>", 0, "two")] },
    ]);
  });

  it("keeps a message's earlier rows when its repair answer is unusable", async () => {
    let refuse = false;
    const c: ModelClient = {
      async structured<T>() {
        if (refuse) throw new ModelOutputError("postings: cut off");
        return {
          value: { postings: [row()] } as T,
          usage: { input: 1, output: 1 },
          served_by: "p",
        };
      },
    };
    const step = extractStep(c);
    const first = (await step({ messages: [message("<a@x>")] }, [])).value;
    refuse = true;
    const problems = [problemFor("<a@x>", 0, "bad")];
    const out = await step({ messages: [message("<a@x>")] }, [{ previous: first, problems }]);
    // Still failing, so validate drops and counts them, rather than losing them silently.
    expect(out.value).toEqual(first);
    expect(out.warnings).toEqual(["extract_postings: message <a@x>: postings: cut off"]);
  });

  it("an unusable answer costs that message's rows and is reported, not thrown", async () => {
    const c: ModelClient = {
      async structured<T>(req: StructuredRequest<T>) {
        if (req.user.includes("<b@x>")) throw new ModelOutputError("postings: the model refused");
        return {
          value: { postings: [row()] } as T,
          usage: { input: 1, output: 1 },
          served_by: "primary",
        };
      },
    };
    const out = await extractStep(c)({ messages: [message("<a@x>"), message("<b@x>")] }, []);
    expect((out.value as Posting[]).map((p) => p.message_id)).toEqual(["<a@x>"]);
    expect(out.warnings).toEqual(["extract_postings: message <b@x>: postings: the model refused"]);
  });

  it("a provider failure fails the step, so the mail is retried next run", async () => {
    const c: ModelClient = {
      async structured() {
        throw new ModelProviderError("rate limited", 429);
      },
    };
    await expect(extractStep(c)({ messages: [message("<a@x>")] }, [])).rejects.toThrow(
      "rate limited",
    );
  });

  it("passes the cancellation signal to every call", async () => {
    const controller = new AbortController();
    const { c, calls } = client(() => []);
    await extractStep(c)({ messages: [message("<a@x>")] }, [], controller.signal);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
