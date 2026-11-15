// The entrypoint the harness runs as `node /bot/main.ts` on Node 22.
// It reads the case set from /input/cases.json, renders every case alone
// with parse() from parse.js, and writes the HTML strings, in the cases'
// order, to /output/html.json. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const rendered: string[] = [];
for (const c of cases) rendered.push(parse(c.markdown));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
