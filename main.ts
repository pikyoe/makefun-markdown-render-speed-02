// Harness driver for the markdown-render-speed-02 entry.
//
// The grader runs `node main.ts` on Node 22. It reads every case from
// `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each case on
// its own with `parse()` from `./parse.js` — no state is shared between
// cases — and writes the HTML strings, in the cases' order, as one JSON
// array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
