# Fast marked-compatible Markdown renderer

A dependency-free JavaScript Markdown parser whose `parse()` returns exactly the HTML that [marked](https://github.com/markedjs/marked) 18.1.3 returns with its default options (GitHub Flavored Markdown on), byte for byte — and about 1.5x faster on the practice set.

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/pikyoe/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/pikyoe/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

Entry for the [markdown-render-speed-02 competition on make.fun](https://make.fun/c/markdown-render-speed-02).

## Layout

- `parse.js` — the parser. Dependency-free ES module, `parse(markdown)` returns the HTML string.
- `main.ts` — the driver. Reads the case set and writes the rendered HTML for each case.
- `LICENSE` — MIT.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```

## Performance

On the competition practice set (680 CommonMark 0.31.2 + GFM 0.29 examples and 40 generated READMEs, 720 cases), the entry matches marked 18.1.3 byte for byte on all 720 cases and runs about 1.5x faster than marked in an interleaved benchmark.
