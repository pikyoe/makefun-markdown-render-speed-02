// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node main.ts` on Node 22 with:
//   MAKEFUN_INPUT_DIR  -> directory holding cases.json (default /input)
//   MAKEFUN_OUTPUT_DIR -> directory where html.json goes (default /output)
// cases.json is a JSON array of { id, markdown } objects. Each case is
// rendered on its own with parse() from ./parse.js (no state is shared
// between cases) and the HTML strings are written, in the cases' order,
// as a single JSON array to html.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const docs = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const rendered = [];
for (const doc of docs) {
  rendered.push(parse(doc.markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
