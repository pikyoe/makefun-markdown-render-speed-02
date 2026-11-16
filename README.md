# Fast marked-compatible Markdown parser

A dependency-free JavaScript Markdown parser. `parse()` returns exactly the
HTML that [marked](https://github.com/markedjs/marked) 18.1.3 produces with
its default options (GitHub Flavored Markdown on), byte for byte, on every
practice case — while rendering the set measurably faster than marked itself
(about 1.2x on the 720 practice cases in local timing).

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/pikyoe/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/pikyoe/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

Entry for the [markdown-render-speed-02 competition on make.fun](https://make.fun/c/markdown-render-speed-02).

## Files

- `parse.js` — the parser, a dependency-free ES module. `parse(markdown)`
  returns the HTML string for one document; no state carries between calls.
- `main.ts` — the harness driver. It reads `cases.json` from
  `$MAKEFUN_INPUT_DIR`, renders every case with `parse`, and writes the HTML
  array (in the cases' order) to `$MAKEFUN_OUTPUT_DIR/html.json`.
- `LICENSE` — MIT.

## Use

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

## Compatibility notes

The target is marked 18.1.3, not the CommonMark or GFM spec as written.
Where marked departs from the spec — tilde fences keeping their content
indent, whitespace-only lines after HTML comments, delimiter edge cases —
this parser follows marked, because the scorer compares against marked
exactly.
