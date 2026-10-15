// CD's post-deploy smoke test (#134): ask the deployed evalReport to report
// on the latest run, then wait for its outcome on the eval-smoke queue.
// Exits 1 on a failure or after the wait, writing the outcome to the job
// summary. Touches queue data only: CD's logs are public, so no record or
// report is read here.
//
//   node scripts/smoke-eval.mjs <storage account>
//
// Signs in with DefaultAzureCredential: azure/login's session in CD, or the
// operator's az login locally. The email's arrival is checked by hand.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { DefaultAzureCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

const WAIT_MS = 10 * 60_000;
const POLL_MS = 15_000;

const account = process.argv[2];
if (!account) {
  console.error("usage: node scripts/smoke-eval.mjs <storage account>");
  process.exit(2);
}
const credential = new DefaultAzureCredential();
const queue = (name) => new QueueClient(`https://${account}.queue.core.windows.net/${name}`, credential);
const reports = queue("eval-reports");
const results = queue("eval-smoke");

const summary = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

const id = `${process.env.GITHUB_RUN_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
await reports.sendMessage(JSON.stringify({ smoke: true, id }));
console.log(`smoke ${id}: queued; waiting up to ${WAIT_MS / 60_000} minutes for evalReport`);

const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  const { receivedMessageItems } = await results.receiveMessages({
    numberOfMessages: 32,
    visibilityTimeout: 30,
  });
  for (const item of receivedMessageItems) {
    let result;
    try {
      result = JSON.parse(item.messageText);
    } catch {
      continue;
    }
    if (result.id !== id) continue;
    await results.deleteMessage(item.messageId, item.popReceipt);
    if (result.ok) {
      summary(`### Smoke test passed\n\nevalReport sent **${result.subject}** for \`${result.record}\`. Check that it arrived.`);
      process.exit(0);
    }
    summary(`### Smoke test failed\n\nevalReport: ${result.error}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
summary(
  `### Smoke test failed\n\nNo outcome from evalReport within ${WAIT_MS / 60_000} minutes. Check the function's logs in Application Insights, and eval-reports-poison.`,
);
process.exit(1);
