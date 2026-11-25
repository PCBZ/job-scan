// Render the synthetic sample report to .preview/report.html (the email) and
// .preview/report-web.html (the browser copy), to look at the templates in a
// browser: npm run report:preview. Runs the TypeScript sources
// directly (Node strips the types), so no build is needed.

import { mkdirSync, writeFileSync } from "node:fs";
import { renderHtml, renderWebHtml } from "../src/lib/report/html.ts";
import { SAMPLE } from "../test/report/sample.ts";

const dir = new URL("../.preview/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, html] of [
  ["report.html", renderHtml(SAMPLE)],
  ["report-web.html", renderWebHtml(SAMPLE)],
]) {
  const out = new URL(name, dir);
  writeFileSync(out, html);
  console.log(out.pathname);
}
