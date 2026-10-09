// Render the synthetic sample report to .preview/report.html, to look at the
// template in a browser: npm run report:preview. Runs the TypeScript sources
// directly (Node strips the types), so no build is needed.

import { mkdirSync, writeFileSync } from "node:fs";
import { renderHtml } from "../src/lib/report/html.ts";
import { SAMPLE } from "../test/report/sample.ts";

const out = new URL("../.preview/report.html", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, renderHtml(SAMPLE));
console.log(out.pathname);
