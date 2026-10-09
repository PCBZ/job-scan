import { describe, expect, it } from "vitest";
import { composeRun, RunConfigError } from "../../src/lib/run/compose.js";

const credential = { getToken: async () => null };
const ENV = {
  CONFIG_BLOB_URL: "https://acct.blob.core.windows.net/config/config.toml",
  RESUME_CACHE_URL: "https://acct.blob.core.windows.net/resume-cache",
  REPORTS_URL: "https://acct.blob.core.windows.net/reports",
  TABLES_URL: "https://acct.table.core.windows.net/",
  GITHUB_RESUME_PAT: "test-pat",
  MODEL_PROVIDER: "azure-openai",
  MODEL_ENDPOINT: "https://acct.openai.azure.com/",
  MODEL_NAME: "gpt-5.4-mini",
};

describe("composeRun", () => {
  it("names every missing app setting at once", () => {
    expect(() =>
      composeRun({ ...ENV, TABLES_URL: " ", GITHUB_RESUME_PAT: undefined }, credential),
    ).toThrow(new RunConfigError("missing app settings: TABLES_URL, GITHUB_RESUME_PAT"));
  });

  it("builds every node and effect without connecting to anything", () => {
    const run = composeRun(ENV, credential, {
      fetch: (async () => {
        throw new Error("no network in compose");
      }) as unknown as typeof fetch,
    });
    expect(Object.keys(run.steps).sort()).toEqual(
      [
        "dedupe",
        "fetchMail",
        "hardGates",
        "loadConfig",
        "loadResumes",
        "rank",
        "renderReport",
        "validatePostings",
        "verifyExplanations",
        "verifyJudgements",
      ].sort(),
    );
    expect(Object.keys(run.model).sort()).toEqual(["explain", "extractPostings", "judge"]);
    expect(Object.keys(run.effects).sort()).toEqual(["deliver", "markSeen"]);
  });

  it("needs the model settings too", () => {
    const { MODEL_PROVIDER: _drop, ...noModel } = ENV;
    expect(() => composeRun(noModel, credential)).toThrow("MODEL_PROVIDER is not set");
  });
});
