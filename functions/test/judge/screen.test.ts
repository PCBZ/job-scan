import { describe, expect, it } from "vitest";
import type { ProfileConfig } from "../../src/lib/config/schema.js";
import { decisionClientFromEnv } from "../../src/lib/decision/config.js";
import { screenStep } from "../../src/lib/judge/screen.js";
import { hardGatesStep } from "../../src/lib/postings/gates.js";
import { posting } from "../postings/helpers.js";

const ENV = { TYPESAFE_API_KEY: "test-key", JEV_MAX_RETRIES: "0" };
const VANCOUVER: ProfileConfig = {
  locations: ["Vancouver, BC", "Burnaby, BC"],
  open_to_remote: true,
  seniority: "mid",
  needs_sponsorship: false,
};

interface Sent {
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string }>;
}

/**
 * The real client over a fake HTTP layer. `yes(state, question)` is Jev's
 * probability of "yes"; "down" makes every call fail with a 503.
 */
function jev(
  yes: ((state: Sent["state"], question: string) => number) | "down",
  delayMs: (state: Sent["state"]) => number = () => 0,
) {
  const sent: Sent[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    await new Promise((r) => setTimeout(r, delayMs(body.state)));
    if (yes === "down") {
      return new Response(JSON.stringify({ detail: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, q]) => [
        name,
        { type: "noul", noul: yes(body.state, q.instructions) },
      ]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 40, output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { client: decisionClientFromEnv(ENV, { fetch: fetchFn }), sent };
}

/** The postings hard_gates keeps, with the location questions code couldn't settle. */
async function gated(...locations: string[]) {
  const postings = locations.map((location, row) =>
    posting({ location, row, title: `Role in ${location}`, workplace: "onsite", salary: "" }),
  );
  return (await hardGatesStep(async () => 1.36)(postings, { profile: VANCOUVER } as never)).kept;
}

describe("screenStep", () => {
  it("filters Montreal for a Vancouver profile, and keeps Vancouver, which code already settled (#118)", async () => {
    const postings = await gated("Montreal", "Vancouver, BC");
    // Jev: Montreal isn't within commuting distance; the seniority gate passes.
    const { client, sent } = jev((_state, q) => (q.startsWith('Is "Montreal"') ? 0.03 : 0.1));
    const out = await screenStep(client)({ postings, profile: VANCOUVER });

    expect(out.kept.map((p) => p.location)).toEqual(["Vancouver, BC"]);
    expect(out.filtered).toEqual([
      {
        posting: postings[0],
        gate: "location",
        reason: "location doesn't fit: Montreal (Jev 0.97)",
      },
    ]);
    // One call per posting, one Noul per gate; the state is what the posting says.
    expect(sent).toHaveLength(2);
    expect(Object.values(sent[0]?.questions ?? {}).map((q) => q.type)).toEqual(["noul", "noul"]);
    expect(sent[0]?.state).toMatchObject({ title: "Role in Montreal", location: "Montreal" });
    expect(out.usage).toEqual({ input: 80, output: 0 });
    expect(out.warnings).toEqual([]);
  });

  it("lists the filtered in posting order, whichever answer comes back first", async () => {
    const postings = await gated("Montreal", "Calgary");
    // Montreal's answer is slow, so Calgary's comes back first.
    const { client } = jev(
      (_state, q) => (q.startsWith("Is ") ? 0.02 : 0.1),
      (state) => (state.location === "Montreal" ? 30 : 0),
    );
    const out = await screenStep(client)({ postings, profile: VANCOUVER });
    expect(out.filtered.map((f) => f.posting.location)).toEqual(["Montreal", "Calgary"]);
  });

  it("filters a plainly unrelated title, and keeps a related one, before judge (#137)", async () => {
    const profile = {
      ...VANCOUVER,
      seniority: "all" as const,
      target_titles: ["Backend Engineer"],
    };
    const machinist = posting({ title: "CNC Mill Machinist", row: 0 });
    const developer = posting({ title: "Senior Software Developer, Data Delivery", row: 1 });
    // Jev: yes, it's near a target role, for the developer only.
    const { client } = jev((state) => (state.title === "CNC Mill Machinist" ? 0.03 : 0.9));
    const out = await screenStep(client)({ postings: [machinist, developer], profile });
    expect(out.filtered).toEqual([
      { posting: machinist, gate: "title", reason: "title far from your target roles (Jev 0.97)" },
    ]);
    expect(out.kept).toEqual([developer]);
  });

  it("keeps a posting Jev is unsure about, with a note for the report", async () => {
    const { client } = jev(() => 0.65);
    const out = await screenStep(client)({ postings: [posting()], profile: VANCOUVER });
    expect(out.filtered).toEqual([]);
    expect(out.kept[0]?.gate_notes).toEqual(['Possibly seniority far from "mid" (Jev 0.65)']);
  });

  it("notes, never filters, a sentinel gate's failure", async () => {
    const { client } = jev(() => 0.95);
    const out = await screenStep(client)({
      postings: [posting()],
      profile: { ...VANCOUVER, seniority: "all", needs_sponsorship: "unknown" },
    });
    expect(out.filtered).toEqual([]);
    expect(out.kept[0]?.gate_notes).toEqual([
      "Would have been filtered: requires citizenship or a clearance, or won't sponsor a visa (Jev 0.95)",
    ]);
  });

  it("passes a gate below the unsure line, and asks nothing of a posting with no gates", async () => {
    const { client, sent } = jev(() => 0.2);
    const out = await screenStep(client)({ postings: [posting()], profile: VANCOUVER });
    expect(out.kept).toEqual([posting()]);

    const none = jev(() => 0.99);
    const all = await screenStep(none.client)({
      postings: [posting()],
      profile: { seniority: "all", needs_sponsorship: false },
    });
    expect(all.kept).toEqual([posting()]);
    expect(none.sent).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("keeps every posting, unscreened, when Jev is down, and says so", async () => {
    const { client } = jev("down");
    const out = await screenStep(client)({
      postings: [posting(), posting({ row: 1 })],
      profile: VANCOUVER,
    });
    expect(out.kept).toHaveLength(2);
    expect(out.filtered).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(
      /^screen: Jev failed, so 2 posting\(s\) weren't screened: jev:/,
    );
  });

  it("keeps every posting, unscreened, without a key, and says so", async () => {
    const out = await screenStep(null)({ postings: [posting()], profile: VANCOUVER });
    expect(out.kept).toEqual([posting()]);
    expect(out.warnings).toEqual([
      "screen: TYPESAFE_API_KEY isn't set, so 1 posting(s) weren't screened",
    ]);
  });

  it("stops when the run is cancelled", async () => {
    const { client } = jev(() => 0.2);
    const controller = new AbortController();
    controller.abort();
    await expect(
      screenStep(client)({ postings: [posting()], profile: VANCOUVER }, controller.signal),
    ).rejects.toThrow();
  });
});
