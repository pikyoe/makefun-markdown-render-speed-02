// Fast Markdown renderer matching marked 18.1.3 with its default options
// (GFM on, breaks off, pedantic off) byte for byte. Written fresh in this
// session for the markdown-render-speed-02 competition, round 6.
//
// How it works, in two passes over one document at a time:
//   1. `lexBlocks` walks the source once and builds a small tree of block
//      nodes: headings, paragraphs, lists, blockquotes, tables, code and
//      raw HTML. Link reference definitions are collected into the
//      per-document context as they are seen.
//   2. `renderBlocks` walks that tree; every text span goes through
//      `inlineHtml`, which lexes the span into atoms (text, code spans,
//      links, emphasis delimiter runs, autolinks), pairs the delimiters
//      with `pairDelims`, and emits HTML.
// Nothing is kept between calls: each `parse` builds a fresh context.
//
// Speed comes from sticky regexes anchored at the current offset, short
// line scans with indexOf, and avoiding per-character regex tests in the
// hot loops. Correctness comes from following marked, not the spec, in
// every place the two disagree.

// ------------------------------------------------------------ escaping

const ESC_CHARS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/g;
// `&` is escaped only when it does not already start an entity or a
// numeric reference; that is marked's inline-escaping rule.
const ESC_TXT = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF = /&#(?:\d{1,7}|[Xx][a-fA-F0-9]{1,6});/;
const NUM_REF_MIX = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PCT25 = /%25/g;

// Escape HTML metacharacters. With `all`, `&` is escaped unconditionally
// (code spans and code blocks); otherwise a `&` that starts a reference
// is left alone.
function esc(s, all) {
  return all ? s.replace(ESC_ANY, (c) => ESC_CHARS[c]) : s.replace(ESC_TXT, (c) => ESC_CHARS[c]);
}

// Resolve numeric character references; a bare `&` that is not part of a
// valid reference becomes `&amp;`. Out-of-range or surrogate code points
// become U+FFFD, exactly as marked does.
function numRefs(s) {
  if (!NUM_REF.test(s) && s.indexOf('&') < 0) return s;
  return s.replace(NUM_REF_MIX, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way marked does; null when the
// destination cannot be encoded at all.
function encHref(href) {
  try { return encodeURI(href).replace(PCT25, '%'); } catch { return null; }
}

// Normalise a reference label for lookup: collapse runs of whitespace to
// one space, trim, lowercase, and fold both capital sharp-s forms to "ss".
function normLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\u00df/g, 'ss').replace(/\u1e9e/g, 'ss');
}

// ------------------------------------------------------------ character classes

const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function punctQ(ch) { return ch.length === 1 && PUNCT.indexOf(ch) >= 0; }
function spaceQ(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function uniSpaceQ(ch) { return /\s/u.test(ch); }
function uniPunctQ(ch) { return /[\p{P}\p{S}]/u.test(ch); }
function alnumQ(ch) { return /[\p{L}\p{N}]/u.test(ch); }

// Tag names from the CommonMark spec lists, used by the HTML-block rules
// and by paragraph interruption.
const BLK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const INL_TAGS = 'a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img';

// ------------------------------------------------------------ block patterns

const RX_BLANK = /^(?:[ \t]*\n)+/ym;
const RX_FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?/ym;
const RX_INDENT = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/ym;
const RX_RULE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/ym;
const RX_ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/ym;
const RX_SETEXT = /^ {0,3}(=+|-+)[ \t]*(?:\n|$)/ym;
const RX_HTML_OPEN = new RegExp(`^ {0,3}(?:<(?:${BLK_TAGS})(?: +|$|/?>)|</(?:${BLK_TAGS})[ \\t]*>|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'iy');
const RX_HTML_RAW = /^<(script|pre|style|textarea)[\s>]/i;

// ------------------------------------------------------------ line helpers

// Drop one level of indentation from a line (up to 4 spaces, or a tab).
function unindent1(line) { return line.replace(/^(?: {0,3}\t| {1,4})/, ''); }

// Expand tabs in `s` to spaces, starting at column `col0`.
function tabsToSpaces(s, col0) {
  let col = col0, out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\t') { const r = 4 - (col % 4); out += ' '.repeat(r); col += r; }
    else { out += c; col++; }
  }
  return out;
}

// Drop the first `n` columns of a line, expanding tabs to tab stops.
function dropCols(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === '\t') {
      const next = (Math.floor(col / 4) + 1) * 4;
      if (next <= n) { col = next; i++; }
      else return line.slice(i + 1);
    } else if (c === ' ') { col++; i++; }
    else break;
  }
  return line.slice(i);
}

function leadWs(line) { const m = /^[ \t]*/.exec(line); return m[0]; }

// Column (spaces, tabs expanded) of the first non-whitespace character.
function firstCol(line) {
  let col = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === ' ') col++;
    else if (c === '\t') col = (Math.floor(col / 4) + 1) * 4;
    else break;
  }
  return col;
}

// Trim trailing blank lines off an HTML block's text. Kind-1 blocks
// (comment, PI, declaration, CDATA, script/pre/style) keep the newline
// that ends the last content line when the next line is whitespace-only
// but non-empty; kind-7 blocks never keep it.
function trimRawTail(text, keepNl) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return text;
  const out = lines.slice(0, t + 1).join('\n');
  return keepNl && /^[ \t]+$/.test(lines[t + 1]) ? out + '\n' : out;
}

function ruleLineQ(line) {
  RX_RULE.lastIndex = 0;
  return RX_RULE.test(line + '\n');
}

// Does the (already dedented) text open a block that can interrupt a
// paragraph or a list item's lazy continuation?
function opensBlock(s) {
  const t = s.replace(/^ {0,3}/, '');
  if (/^(`{3,}|~{3,})/.test(t)) return true;
  if (/^#{1,6}(?:\s|$)/.test(t)) return true;
  if (/^(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(t)) return true;
  RX_HTML_OPEN.lastIndex = 0;
  return RX_HTML_OPEN.test(t);
}

// Does a raw source line open a block construct? Blockquote markers and
// list markers count here too.
function lineOpensBlock(line) {
  const s = line.replace(/^[ \t]{0,3}/, '');
  if (!s || s[0] === '\n') return false;
  if (/^(`{3,}|~{3,})/.test(s)) return true;
  if (/^(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n|$)/.test(s)) return true;
  if (/^#{1,6}(?:\s|$)/.test(s)) return true;
  if (s[0] === '>') return true;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.test(s)) return true;
  RX_HTML_OPEN.lastIndex = 0;
  return RX_HTML_OPEN.test(line);
}

// ------------------------------------------------------------ fenced code

function codeNode(content, info, fenced) {
  return {
    kind: 'code',
    text: content,
    lang: info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1'),
    fenced,
  };
}

function fenceCode(src, i) {
  RX_FENCE.lastIndex = i;
  const m = RX_FENCE.exec(src);
  if (!m) return null;
  const fence = m[1], ch = fence[0], info = m[2];
  const firstLine = src.slice(i, i + m[0].length).split('\n')[0];
  const fenceIndent = /^ */.exec(firstLine)[0].length;
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  const closeRe = new RegExp(`^ {0,3}${ch}{${fence.length},} *$`);
  let j = i + m[0].length, content = '';
  let p = j;
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const lineEnd = nl < 0 ? src.length : nl;
    const line = src.slice(p, lineEnd);
    if (closeRe.test(line)) {
      content = src.slice(j, p).split('\n').map((l) => dropCols(l, ch === '~' ? 0 : fenceIndent)).join('\n');
      j = lineEnd + (nl < 0 ? 0 : 1);
      if (content.endsWith('\n')) content = content.slice(0, -1);
      return { node: codeNode(content, info, true), next: j };
    }
    p = lineEnd + 1;
  }
  content = src.slice(j).split('\n').map((l) => dropCols(l, ch === '~' ? 0 : fenceIndent)).join('\n');
  if (content.endsWith('\n')) content = content.slice(0, -1);
  return { node: codeNode(content, info, true), next: src.length };
}

// ------------------------------------------------------------ raw HTML blocks

// Read an HTML block starting at `i`. Kind 1 blocks (script/pre/style/
// textarea, comment, PI, declaration, CDATA) end after the line holding
// their terminator; kind 7 blocks (block tags) run to the first blank
// line. Returns null when the line does not open an HTML block.
function rawHtmlBlock(src, i) {
  const lineEnd = src.indexOf('\n', i);
  const first = lineEnd < 0 ? src.slice(i) : src.slice(i, lineEnd);
  const lead = /^ {0,3}/.exec(first);
  const rest = first.slice(lead[0].length);
  if (!rest.startsWith('<')) return null;
  let end = -1, kind = 0;
  const raw = RX_HTML_RAW.exec(src.slice(i + lead[0].length));
  if (raw) {
    const close = new RegExp(`</${raw[1]}>`, 'i').exec(src.slice(i));
    if (!close) return { node: { kind: 'raw', text: src.slice(i) }, next: src.length };
    const closeEnd = i + close.index + close[0].length;
    const nl = src.indexOf('\n', closeEnd);
    end = nl < 0 ? src.length : nl + 1; kind = 1;
  } else if (rest.startsWith('<!--')) {
    const c = src.indexOf('-->', i + 4);
    if (c < 0) return { node: { kind: 'raw', text: src.slice(i) }, next: src.length };
    const nl = src.indexOf('\n', c + 3);
    end = nl < 0 ? src.length : nl + 1; kind = 1;
  } else if (rest.startsWith('<?')) {
    const c = src.indexOf('?>', i + 2);
    if (c < 0) return { node: { kind: 'raw', text: src.slice(i) }, next: src.length };
    const nl = src.indexOf('\n', c + 2);
    end = nl < 0 ? src.length : nl + 1; kind = 1;
  } else if (/^<![A-Za-z]/.test(rest)) {
    const c = src.indexOf('>', i);
    if (c < 0) return { node: { kind: 'raw', text: src.slice(i) }, next: src.length };
    const nl = src.indexOf('\n', c + 1);
    end = nl < 0 ? src.length : nl + 1; kind = 1;
  } else if (rest.startsWith('<![CDATA[')) {
    const c = src.indexOf(']]>', i + 9);
    if (c < 0) return { node: { kind: 'raw', text: src.slice(i) }, next: src.length };
    const nl = src.indexOf('\n', c + 3);
    end = nl < 0 ? src.length : nl + 1; kind = 1;
  }
  if (end < 0) {
    const tagRe = new RegExp(`^(?:<(?:${BLK_TAGS})(?:[ \\t]+|\\n|/?>|$)|</(?:${BLK_TAGS})[ \\t]*>)`, 'i');
    const fullTag = /^<[a-zA-Z][\w-]*(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^'\n]*'|[^-\s"'=<>`]+))?)*\s*\/?>[ \t]*$/;
    const closeTag = /^<\/[a-zA-Z][\w-]*\s*>[ \t]*$/;
    if (tagRe.test(rest) || fullTag.test(rest) || closeTag.test(rest)) kind = 7;
    else return null;
  }
  if (kind === 7) {
    let p = i;
    while (p < src.length) {
      const nl = src.indexOf('\n', p);
      const le = nl < 0 ? src.length : nl;
      if (/^[ \t]*$/.test(src.slice(p, le))) { end = le + 1; break; }
      p = le + 1;
    }
    if (end < 0) end = src.length;
  }
  while (end > 0 && end < src.length) {
    const nl = src.indexOf('\n', end);
    const le = nl < 0 ? src.length : nl;
    if (!/^[ \t]*$/.test(src.slice(end, le))) break;
    end = le + 1;
  }
  const text = trimRawTail(src.slice(i, end), kind === 1);
  return { node: { kind: 'raw', text }, next: end };
}

// ------------------------------------------------------------ link titles

// Parse a link title starting at `t`: "...", '...', or (...). Returns
// the unescaped title and the position just past it, or null.
function readTitle(src, t) {
  if (src[t] === '"' || src[t] === "'") {
    const q = src[t];
    let e = t + 1;
    while (e < src.length) {
      if (src[e] === '\\' && e + 1 < src.length) { e += 2; continue; }
      if (src[e] === q) return { title: src.slice(t + 1, e).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1'), next: e + 1 };
      if (q === "'" && src[e] === '\n' && src[e + 1] === '\n') return null;
      e++;
    }
    return null;
  }
  if (src[t] === '(') {
    let e = t + 1;
    while (e < src.length) {
      if (src[e] === '\\' && e + 1 < src.length) { e += 2; continue; }
      if (src[e] === '(' || src[e] === '\n') return null;
      if (src[e] === ')') return { title: src.slice(t + 1, e).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1'), next: e + 1 };
      e++;
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------------ link reference definitions

// Try to read a link reference definition starting at `i` (a line like
// `[label]: destination "title"`). Registers it in ctx.refs (first wins)
// and returns the position after the definition, or null.
function readRefDef(src, i, ctx) {
  let j = i, sp = 0;
  while (j < src.length && src[j] === ' ' && sp < 3) { j++; sp++; }
  if (src[j] !== '[') return null;
  const end = bracketEnd(src, j);
  if (end < 0) return null;
  const label = src.slice(j + 1, end);
  if (label === '' || label.indexOf('\n\n') >= 0) return null;
  if (normLabel(label) === '') return null;
  {
    let bad = false;
    for (let q = 0; q < label.length; q++) {
      if (label[q] === '\\') { q++; continue; }
      if (label[q] === '[' || label[q] === ']') { bad = true; break; }
    }
    if (bad) return null;
  }
  let k = end + 1;
  if (src[k] !== ':') return null;
  k++;
  let m = k;
  while (m < src.length && (src[m] === ' ' || src[m] === '\t')) m++;
  if (src[m] === '\n') { m++; while (m < src.length && (src[m] === ' ' || src[m] === '\t')) m++; }
  let href;
  if (src[m] === '<') {
    const e = src.indexOf('>', m + 1);
    if (e < 0) return null;
    const inner = src.slice(m + 1, e);
    if (/[\n]/.test(inner)) return null;
    href = inner; m = e + 1;
  } else {
    let d = '';
    while (m < src.length) {
      const c = src[m];
      if (c === '\\' && m + 1 < src.length && punctQ(src[m + 1])) { d += src[m + 1]; m += 2; continue; }
      if (c === ' ' || c === '\n' || c === '\t') break;
      d += c; m++;
    }
    if (d === '') return null;
    href = d;
  }
  const destLineEnd = src.indexOf('\n', m);
  const noTitleNext = destLineEnd < 0 ? src.length : destLineEnd + 1;
  let dc = m;
  while (dc < src.length && (src[dc] === ' ' || src[dc] === '\t')) dc++;
  const destLineClean = dc >= src.length || src[dc] === '\n';
  const registerNoTitle = () => {
    if (!destLineClean) return null;
    const key = normLabel(label);
    if (key && !ctx.refs.has(key)) ctx.refs.set(key, { href, title: undefined });
    return { next: noTitleNext };
  };
  let t = m;
  while (t < src.length && (src[t] === ' ' || src[t] === '\t')) t++;
  let hadWs = t > m;
  if (src[t] === '\n') {
    let t2 = t + 1;
    while (t2 < src.length && (src[t2] === ' ' || src[t2] === '\t')) t2++;
    if (src[t2] === '"' || src[t2] === "'" || src[t2] === '(') { t = t2; hadWs = true; }
    else return registerNoTitle();
  }
  if (src[t] === '"' || src[t] === "'" || src[t] === '(') {
    if (!hadWs) return null;
    const r = readTitle(src, t);
    if (!r) return registerNoTitle();
    let u = r.next;
    while (u < src.length && (src[u] === ' ' || src[u] === '\t')) u++;
    if (u < src.length && src[u] !== '\n') return registerNoTitle();
    const key = normLabel(label);
    if (key && !ctx.refs.has(key)) ctx.refs.set(key, { href, title: r.title });
    return { next: u < src.length ? u + 1 : src.length };
  }
  let u = t;
  while (u < src.length && (src[u] === ' ' || src[u] === '\t')) u++;
  if (u < src.length && src[u] !== '\n') return null;
  return registerNoTitle();
}

// ------------------------------------------------------------ setext headings

// A paragraph's lines followed by an === or --- underline become a heading.
function setextHead(src, i) {
  let p = i;
  const lines = [];
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const le = nl < 0 ? src.length : nl;
    const line = src.slice(p, le);
    if (/^[ \t]*$/.test(line)) break;
    if (lines.length > 0 && lineOpensBlock(line)) break;
    lines.push(line);
    p = le + 1;
    RX_SETEXT.lastIndex = p;
    const sm = RX_SETEXT.exec(src);
    if (sm) {
      const text = lines.join('\n').trim();
      return { node: { kind: 'h', level: sm[1][0] === '=' ? 1 : 2, text }, next: p + sm[0].length };
    }
    if (nl < 0) break;
  }
  return null;
}

// ------------------------------------------------------------ tables (GFM)

// Split one table row line into trimmed cells. `\|` is a literal pipe;
// leading/trailing empty cells from outer pipes are dropped.
function splitCells(line) {
  const cells = [];
  let cur = '', i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Try to read a GFM table starting at `i`: a header line, a delimiter
// line of dashes/colons, then body rows until a blank line or a line that
// opens another block.
function readTbl(src, i) {
  const nl1 = src.indexOf('\n', i);
  if (nl1 < 0) return null;
  const headLine = src.slice(i, nl1);
  if (/^[ \t]*$/.test(headLine)) return null;
  if (headLine[0] === ' ' && /^ {4,}/.test(headLine)) return null;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const delLine = nl2 < 0 ? src.slice(nl1 + 1) : src.slice(nl1 + 1, nl2);
  const dm = /^ {0,3}(\|? *(?::?-+:? *)(?:\| *:?-+:? *)*\|? *)[ \t]*$/.exec(delLine);
  if (!dm) return null;
  if (delLine.indexOf('|') < 0 && delLine.indexOf(':') < 0) return null;
  const delCells = splitCells(dm[1]);
  if (!delCells.length) return null;
  for (const c of delCells) if (!/^:?-+:?$/.test(c)) return null;
  const headCells = splitCells(headLine);
  if (headCells.length !== delCells.length) return null;
  const align = delCells.map((c) => (c[0] === ':' && c[c.length - 1] === ':' ? 'center' : c[c.length - 1] === ':' ? 'right' : c[0] === ':' ? 'left' : null));
  const rows = [];
  let p = nl2 < 0 ? src.length : nl2 + 1;
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const le = nl < 0 ? src.length : nl;
    const line = src.slice(p, le);
    if (/^ *$/.test(line)) break;
    if (lineOpensBlock(line)) break;
    let cells = splitCells(line);
    while (cells.length < headCells.length) cells.push('');
    if (cells.length > headCells.length) cells = cells.slice(0, headCells.length);
    rows.push(cells);
    p = le + 1;
    if (nl < 0) break;
  }
  return { node: { kind: 'tbl', align, head: headCells, rows }, next: p };
}

// ------------------------------------------------------------ lists

// Match a list marker at the start of a line (up to 3 spaces of indent).
// Returns the marker text and its indent, or null.
function listMarker(line) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(line);
  if (!m) return null;
  return { marker: m[1], indent: /^ */.exec(line)[0].length, raw: m[0] };
}

// The content indent of a list item: marker indent + marker length + the
// spaces after it (1 space when there are 0 or 5+ of them, per spec).
function itemIndent(firstLine, marker, indent) {
  const after = firstLine.slice(indent + marker.length);
  if (/^[ \t]*$/.test(after)) return indent + marker.length + 1;
  let sp = 0, j = 0;
  while (j < after.length && (after[j] === ' ' || after[j] === '\t')) { sp += after[j] === '\t' ? 4 - (sp % 4) : 1; j++; }
  if (sp === 0) return indent + marker.length;
  if (sp >= 5) return indent + marker.length + 1;
  return indent + marker.length + sp;
}

let listDepth = 0;
let linkDepth = 0;

// Read a whole list (one marker style) starting at `i`. Items are
// re-lexed as block content; a blank line between items (or a blank line
// inside an item) makes the list loose.
function readLst(src, i, ctx) {
  const firstEnd = src.indexOf('\n', i);
  const firstLine = firstEnd < 0 ? src.slice(i) : src.slice(i, firstEnd);
  const b0 = listMarker(firstLine);
  if (!b0) return null;
  const ordered = /^\d/.test(b0.marker);
  const delim = ordered ? b0.marker[b0.marker.length - 1] : b0.marker;
  const startNum = ordered ? parseInt(b0.marker, 10) : 0;
  const items = [];
  let p = i, loose = false, prevBlank = false, prevCIndent = 0, outerBlankStart = -1;
  const sameMarker = (b) => ordered
    ? /^\d/.test(b.marker) && b.marker[b.marker.length - 1] === delim
    : !/^\d/.test(b.marker) && b.marker === delim;
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const le = nl < 0 ? src.length : nl;
    const line = src.slice(p, le);
    const b = listMarker(line);
    const sameList = b && sameMarker(b);
    if (items.length > 0) {
      if (ruleLineQ(line)) break;
      if (sameList && b.indent < prevCIndent && b.indent < 4) {
        // a new item starts below
      } else if (/^[ \t]*$/.test(line)) {
        if (!prevBlank) outerBlankStart = p;
        prevBlank = true; p = le + 1; if (nl < 0) break; continue;
      } else {
        if (prevBlank && outerBlankStart >= 0) p = outerBlankStart;
        break;
      }
    }
    if (!sameList) break;
    if (prevBlank && items.length > 0) loose = true;
    prevBlank = false;
    const markerLen = b.indent + b.marker.length;
    const g = line.slice(markerLen);
    const gWs = leadWs(g);
    const m = tabsToSpaces(gWs, markerLen) + g.slice(gWs.length);
    const emptyAfter = m.trim() === '';
    let cIndent, d;
    if (emptyAfter) { cIndent = markerLen + 1; d = ''; }
    else {
      let r = m.search(/[^ ]/);
      if (r < 0) r = m.length;
      if (r > 4) r = 1;
      d = m.slice(r);
      cIndent = r + markerLen;
    }
    prevCIndent = cIndent;
    const noLazy = emptyAfter || m.search(/[^ ]/) >= 4 || opensBlock(m);
    const contentLines = d === '' ? [] : [d];
    // Track fenced code inside this item: only the FIRST content line
    // after a fence opening being dedented ends the item (the fence then
    // renders empty); once content has been gathered, later dedented lines
    // are fence content.
    let fenceCh = null, fenceLen = 0, fenceHasContent = false;
    const fenceTrack = (text) => {
      if (fenceCh) {
        const cm = new RegExp(`^ {0,3}${fenceCh}{${fenceLen},} *$`).exec(text);
        if (cm) { fenceCh = null; fenceHasContent = false; }
        else fenceHasContent = true;
        return;
      }
      const om = /^ {0,3}(`{3,}|~{3,})/.exec(text);
      if (om && !(om[1][0] === '`' && text.slice(om[0].length).indexOf('`') >= 0)) {
        fenceCh = om[1][0]; fenceLen = om[1].length; fenceHasContent = false;
      }
    };
    if (d !== '') fenceTrack(d);
    let q = le + 1, blankRun = 0, endedAtItem = false, blankStart = -1;
    while (q < src.length) {
      const nl2 = src.indexOf('\n', q);
      const le2 = nl2 < 0 ? src.length : nl2;
      const l2 = src.slice(q, le2);
      const b2 = listMarker(l2);
      if (b2 && b2.indent < cIndent && b2.indent < 4 && sameMarker(b2)) { endedAtItem = true; break; }
      if (/^[ \t]*$/.test(l2)) { if (contentLines.length === 0) break; if (blankRun === 0) blankStart = q; blankRun++; contentLines.push(''); q = le2 + 1; if (nl2 < 0) break; continue; }
      const l2Ws = leadWs(l2);
      const z = tabsToSpaces(l2Ws, 0) + l2.slice(l2Ws.length);
      const zi = z.search(/[^ ]/);
      if (zi >= cIndent) { blankRun = 0; const pl = z.slice(cIndent); contentLines.push(pl); fenceTrack(pl); q = le2 + 1; if (nl2 < 0) break; continue; }
      if (firstCol(l2) < cIndent && lineOpensBlock(l2)) break;
      if (blankRun > 0 || noLazy) break;
      // A dedented first content line of a fence opened in this item ends
      // the item; the fence (already in contentLines) renders empty.
      if (fenceCh && !fenceHasContent && zi < cIndent) break;
      if (contentLines.length > 0 && contentLines[contentLines.length - 1] !== '') {
        let dl = zi >= 4 ? z.slice(4) : (zi < cIndent - b.indent ? z : z.slice(Math.min(zi, cIndent)));
        // A lazy line that looks like a bullet must not re-lex as a list;
        // escape its marker.
        if (/^([*+-])([ \t]|$)/.test(dl)) dl = '\\' + dl;
        contentLines.push(dl); q = le2 + 1; if (nl2 < 0) break; continue;
      }
      break;
    }
    let poppedBlanks = 0;
    while (contentLines.length && contentLines[contentLines.length - 1] === '') { contentLines.pop(); poppedBlanks++; }
    if (poppedBlanks > 0 && blankStart >= 0) q = blankStart;
    if (blankRun > 0 && endedAtItem) loose = true;
    let text = contentLines.join('\n');
    let task = false, checked = false;
    const tm = /^\[[ xX]\](?:[ \t]+|$)/.exec(text);
    if (tm && text.slice(tm[0].length).trim() !== '') { task = true; checked = text[1] === 'x' || text[1] === 'X'; text = text.slice(tm[0].length); }
    listDepth++;
    const inner = lexBlocks(text, ctx);
    listDepth--;
    items.push({ task, checked, inner });
    p = q;
    if (nl < 0) break;
  }
  if (!items.length) return null;
  for (const it of items) {
    for (let k = 0; k < it.inner.length; k++) {
      if (it.inner[k].kind === 'gap') { loose = true; break; }
    }
    if (loose) break;
  }
  return { node: { kind: 'lst', ordered, start: startNum, tight: !loose, items }, next: p };
}

// Try to append `text` as a lazy continuation line to the last block of
// `blocks` (paragraph, or the last paragraph inside a quote/list).
function lazyAppend(blocks, text) {
  if (!blocks || !blocks.length) return false;
  const last = blocks[blocks.length - 1];
  if (last.kind === 'p') { last.text += '\n' + text; return true; }
  if (last.kind === 'q') return lazyAppend(last.inner, text);
  if (last.kind === 'lst' && last.items && last.items.length) {
    const it = last.items[last.items.length - 1];
    return lazyAppend(it.inner, text);
  }
  return false;
}

// ------------------------------------------------------------ blockquotes

function readQuote(src, i, ctx) {
  const out = [];
  let cur = [];
  let p = i, fenceCh = null, fenceLen = 0, lastIsPara = false, sawQuote = false;
  const trackFence = (content) => {
    if (fenceCh) {
      const cm = new RegExp(`^ {0,3}${fenceCh}{${fenceLen},} *$`).exec(content);
      if (cm) fenceCh = null;
      return;
    }
    const om = /^ {0,3}(`{3,}|~{3,})/.exec(content);
    if (om && !(om[1][0] === '`' && content.slice(om[0].length).indexOf('`') >= 0)) {
      fenceCh = om[1][0]; fenceLen = om[1].length;
    }
  };
  const isParaLine = (content) => {
    if (/^[ \t]*$/.test(content)) return false;
    if (fenceCh) return false;
    if (lineOpensBlock(content)) return false;
    if (firstCol(content) >= 4) return false;
    return true;
  };
  const flush = () => {
    if (cur.length) { lexBlocks(cur.join('\n'), ctx, out, true); cur = []; }
  };
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const le = nl < 0 ? src.length : nl;
    const line = src.slice(p, le);
    const qm = /^ {0,3}>/.exec(line);
    if (qm) {
      sawQuote = true;
      const marker = qm[0];
      const after = line.slice(marker.length);
      const ws = leadWs(after);
      const expanded = tabsToSpaces(ws, marker.length);
      const content = (expanded.length > 0 ? expanded.slice(1) : '') + after.slice(ws.length);
      if (content.trim() !== '' && !content.startsWith('>') && !lineOpensBlock(content) && !fenceCh && cur.length === 0) {
        if (lazyAppend(out, firstCol(content) >= 4 ? dropCols(content, 4) : content)) {
          lastIsPara = true;
          p = le + 1; if (nl < 0) break; continue;
        }
      }
      cur.push(content);
      trackFence(content);
      lastIsPara = isParaLine(content);
      p = le + 1; if (nl < 0) break; continue;
    }
    if (/^[ \t]*$/.test(line)) break;
    if (!fenceCh && !lineOpensBlock(line)) {
      const sm2 = /^ {0,3}((?:=+|-+)[ \t]*)$/.exec(line);
      if (sm2) {
        flush();
        if (!lazyAppend(out, '    ' + sm2[1])) lexBlocks('    ' + sm2[1], ctx, out, true);
        lastIsPara = true;
        p = le + 1; if (nl < 0) break; continue;
      }
      if (cur.length && cur[cur.length - 1] === '') break;
      flush();
      const lazyText = firstCol(line) >= 4 ? dropCols(line, 4) : line;
      if (lazyAppend(out, lazyText)) {
        lastIsPara = true;
        p = le + 1; if (nl < 0) break; continue;
      }
      break;
    }
    break;
  }
  flush();
  if (!sawQuote) return null;
  return { node: { kind: 'q', inner: out }, next: p };
}

// ------------------------------------------------------------ paragraphs

// Can `line` interrupt a paragraph? Block starts can, except an empty
// bullet and (outside a list item) an ordered marker that does not start
// with 1.
function paraBreak(line) {
  if (lineOpensBlock(line)) {
    const b = listMarker(line);
    if (b) {
      if (/^[ \t]*$/.test(line.slice(b.indent + b.marker.length))) return false;
      if (!/^\d/.test(b.marker)) return true;
      if (/^1[.)]/.test(b.marker)) return true;
      if (listDepth > 0) return true;
      return false;
    }
    return true;
  }
  return false;
}

function readPara(src, i) {
  const lines = [];
  let p = i;
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    const le = nl < 0 ? src.length : nl;
    const line = src.slice(p, le);
    if (/^[ \t]*$/.test(line)) break;
    if (lines.length > 0 && paraBreak(line)) break;
    lines.push(line);
    p = le + 1;
    if (nl < 0) break;
  }
  if (!lines.length) return null;
  return { node: { kind: 'p', text: lines.join('\n') }, next: p };
}

// Merge a following blockquote's inner blocks into the previous one when
// the two are adjacent (marked merges consecutive quote blocks).
function mergeQuotes(dst, srcNode) {
  const di = dst.inner, si = srcNode.inner;
  if (!di.length) { dst.inner = si.slice(); return; }
  const last = di[di.length - 1];
  if (last.kind === 'q') { mergeQuotes(last, srcNode); return; }
  if (last.kind === 'p' && si.length && si[0].kind === 'p') {
    last.text += '\n' + si[0].text;
    for (let k = 1; k < si.length; k++) di.push(si[k]);
    return;
  }
  for (const b of si) di.push(b);
}

// ------------------------------------------------------------ block lexer

// Turn source text into block nodes. `top` marks the document level (and
// quote content), where adjacent paragraphs merge.
function lexBlocks(src, ctx, out, top) {
  out = out || [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    RX_BLANK.lastIndex = i;
    let m = RX_BLANK.exec(src);
    if (m) { out.push({ kind: 'gap' }); i += m[0].length; continue; }
    const f = fenceCode(src, i);
    if (f) { out.push(f.node); i = f.next; continue; }
    RX_INDENT.lastIndex = i;
    m = RX_INDENT.exec(src);
    if (m) {
      let txt = m[0].split('\n').map(unindent1).join('\n');
      txt = txt.replace(/(\n[ \t]*)+$/, '\n');
      const last = out[out.length - 1];
      if (last && last.kind === 'p') {
        // An indented code block directly after a paragraph is absorbed
        // into that paragraph (marked's behaviour).
        last.text += '\n' + txt.replace(/\n$/, '');
        i += m[0].length; continue;
      }
      out.push({ kind: 'code', text: txt, lang: '', fenced: false });
      i += m[0].length; continue;
    }
    RX_RULE.lastIndex = i;
    m = RX_RULE.exec(src);
    if (m) { out.push({ kind: 'hr' }); i += m[0].length; continue; }
    RX_ATX.lastIndex = i;
    m = RX_ATX.exec(src);
    if (m) {
      const txt = m[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      out.push({ kind: 'h', level: m[1].length, text: txt });
      i += m[0].length; continue;
    }
    const q = readQuote(src, i, ctx);
    if (q) {
      const lastQ = out[out.length - 1];
      if (lastQ && lastQ.kind === 'q') mergeQuotes(lastQ, q.node);
      else out.push(q.node);
      i = q.next; continue;
    }
    const l = readLst(src, i, ctx);
    if (l) { out.push(l.node); i = l.next; continue; }
    const h = rawHtmlBlock(src, i);
    if (h) { out.push(h.node); i = h.next; continue; }
    const d = readRefDef(src, i, ctx);
    if (d) { i = d.next; continue; }
    const t = readTbl(src, i);
    if (t) { out.push(t.node); i = t.next; continue; }
    const s = setextHead(src, i);
    if (s) { out.push(s.node); i = s.next; continue; }
    const pa = readPara(src, i);
    if (pa) {
      const last = out[out.length - 1];
      if (top && last && last.kind === 'p') { last.text += '\n' + pa.node.text; i = pa.next; continue; }
      out.push(pa.node); i = pa.next; continue;
    }
    const nl = src.indexOf('\n', i);
    const txt = nl < 0 ? src.slice(i) : src.slice(i, nl);
    const last = out[out.length - 1];
    if (top && last && last.kind === 'p') { last.text += '\n' + txt; }
    else out.push({ kind: 'p', text: txt });
    i = nl < 0 ? n : nl + 1;
  }
  return out;
}

// ------------------------------------------------------------ block rendering

function renderBlocks(blocks, ctx) {
  let out = '';
  for (const b of blocks) {
    if (b.kind === 'gap') continue;
    if (b.kind === 'hr') { out += '<hr>\n'; continue; }
    if (b.kind === 'h') { out += '<h' + b.level + '>' + inlineHtml(b.text, ctx) + '</h' + b.level + '>\n'; continue; }
    if (b.kind === 'code') {
      const txt = (b.text === '' ? '' : b.text.replace(/\n$/, '') + '\n');
      const lang = b.lang ? ' class="language-' + esc(b.lang.split(/\s+/)[0]) + '"' : '';
      out += '<pre><code' + lang + '>' + esc(txt, true) + '</code></pre>\n';
      continue;
    }
    if (b.kind === 'p') { out += '<p>' + inlineHtml(b.text, ctx) + '</p>\n'; continue; }
    if (b.kind === 'raw') { out += b.text; continue; }
    if (b.kind === 'q') { out += '<blockquote>\n' + renderBlocks(b.inner, ctx) + '</blockquote>\n'; continue; }
    if (b.kind === 'tbl') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.head.length; k++) {
        out += '<th' + (b.align[k] ? ' align="' + b.align[k] + '"' : '') + '>' + inlineHtml(b.head[k], ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) out += '<tbody>';
      for (const row of b.rows) {
        out += '<tr>\n';
        for (let k = 0; k < row.length; k++) {
          out += '<td' + (b.align[k] ? ' align="' + b.align[k] + '"' : '') + '>' + inlineHtml(row[k], ctx) + '</td>\n';
        }
        out += '</tr>\n';
      }
      if (b.rows.length) out += '</tbody>';
      out += '</table>\n';
      continue;
    }
    if (b.kind === 'lst') {
      const tag = b.ordered ? 'ol' : 'ul';
      out += '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
      for (const it of b.items) {
        out += '<li>' + renderItem(it, ctx, b.tight) + '</li>\n';
      }
      out += '</' + tag + '>\n';
      continue;
    }
  }
  return out;
}

// Render one list item. Tight lists render paragraph content inline
// (no <p> wrapper); loose lists render full blocks.
function renderItem(it, ctx, tight) {
  let box = '';
  if (it.task) box = it.checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
  const inner = it.inner;
  if (tight) {
    let s = '';
    for (const b of inner) {
      if (b.kind === 'p') s += inlineHtml(b.text, ctx);
      else s += renderBlocks([b], ctx);
    }
    return box ? box + ' ' + s : s;
  }
  let s = renderBlocks(inner, ctx);
  if (box) s = s.replace(/^<p>/, '<p>' + box + ' ');
  else if (inner.length && inner[0].kind !== 'p') s = box + s;
  return s;
}

// ------------------------------------------------------------ inline lexing

const RX_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\?[\s\S]*?\?>|^<![A-Za-z][\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>|^<[a-zA-Z][\w-]*(?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|^<\/[a-zA-Z][\w-]*\s*>/;
const RX_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*|[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+)>/;
const RX_EMAIL = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RX_EMAIL_LOOSE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
const RX_MAILTO_XMPP = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)/;

// Find the `]` that closes the bracket opened at `i` (depth counts nested
// brackets; backslash-escaped brackets do not count). -1 if unbalanced.
function bracketEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// Parse a link destination (and optional title) starting just after the
// opening `(` of an inline link. Returns {href, title, next} where `next`
// is the position just past the closing `)`, or null.
function linkDest(s, i) {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\n' || s[j] === '\t')) j++;
  let dest = '', k = j;
  if (s[k] === '<') {
    let e = -1;
    for (let q = k + 1; q < s.length; q++) {
      if (s[q] === '\\' && q + 1 < s.length) { q++; continue; }
      if (s[q] === '>') { e = q; break; }
      if (s[q] === '\n') break;
    }
    if (e < 0) return null;
    const inner = s.slice(k + 1, e);
    if (/[\n]/.test(inner)) return null;
    dest = inner; k = e + 1;
  } else {
    let depth = 0;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length && punctQ(s[k + 1])) { dest += s[k + 1]; k += 2; continue; }
      if (c === ' ' || c === '\n' || c === '\t') break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      dest += c; k++;
    }
  }
  let title;
  let m = k;
  while (m < s.length && (s[m] === ' ' || s[m] === '\n' || s[m] === '\t')) m++;
  if ((s[m] === '"' || s[m] === "'") && m === k) return null;
  if (s[m] === '"' || s[m] === "'") {
    const q = s[m];
    let e = m + 1;
    while (e < s.length) {
      if (s[e] === '\\' && e + 1 < s.length) { e += 2; continue; }
      if (s[e] === q) break;
      if (q === "'" && s[e] === '\n' && s[e + 1] === '\n') return null;
      e++;
    }
    if (e >= s.length) return null;
    title = s.slice(m + 1, e).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    m = e + 1;
  } else if (s[m] === '(') {
    let e = m + 1, ok = false;
    while (e < s.length) {
      if (s[e] === '\\' && e + 1 < s.length) { e += 2; continue; }
      if (s[e] === '(' || s[e] === '\n') break;
      if (s[e] === ')') { ok = true; break; }
      e++;
    }
    if (!ok) return null;
    title = s.slice(m + 1, e).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    m = e + 1;
  }
  while (m < s.length && (s[m] === ' ' || s[m] === '\n' || s[m] === '\t')) m++;
  if (s[m] !== ')') return null;
  return { href: dest, title, next: m + 1 };
}

// Does `label` itself contain a link (inline or reference)? Marked refuses
// a link whose label already holds one.
function labelLinks(label, ctx) {
  for (let k = 0; k < label.length; k++) {
    if (label[k] !== '[') continue;
    if (k > 0 && label[k - 1] === '!') {
      const e0 = bracketEnd(label, k);
      if (e0 < 0) continue;
      k = e0;
      // Skip the image's destination/reference part: (url) or [ref].
      if (label[k + 1] === '(') {
        const r = linkDest(label, k + 2);
        if (r) k = r.next - 1;
      } else if (label[k + 1] === '[') {
        const e2 = bracketEnd(label, k + 1);
        if (e2 >= 0) k = e2;
      }
      continue;
    }
    const e = bracketEnd(label, k);
    if (e < 0) continue;
    const nx = label[e + 1];
    if (nx === '(') {
      const r = linkDest(label, e + 2);
      if (r) return true;
    } else if (nx === '[') {
      const e2 = bracketEnd(label, e + 1);
      if (e2 < 0) continue;
      const ref = label.slice(e + 2, e2);
      const key = normLabel(ref === '' ? label.slice(k + 1, e) : ref);
      if (ctx.refs.get(key)) return true;
    } else {
      const key = normLabel(label.slice(k + 1, e));
      if (ctx.refs.get(key)) return true;
    }
    k = e;
  }
  return false;
}

// Simulate marked's label regex: a code span in a label is a run of
// backticks, non-backtick content, and a run of backticks. A code span
// whose content itself holds a backtick (e.g. `` a ` b ``) makes the
// regex match a short span ending at the inner backtick, leaving a stray
// run that cannot be consumed, so the whole link fails.
function labelOk(label) {
  let k = 0;
  const n = label.length;
  while (k < n) {
    const c = label[k];
    if (c === '\\' && k + 1 < n) { k += 2; continue; }
    if (c === '[') {
      const e = bracketEnd(label, k);
      if (e < 0) return false;
      k = e + 1; continue;
    }
    if (c === '`') {
      let r1 = 1;
      while (k + r1 < n && label[k + r1] === '`') r1++;
      let j = k + r1;
      while (j < n && label[j] !== '`') j++;
      if (j < n) {
        let r2 = 1;
        while (j + r2 < n && label[j + r2] === '`') r2++;
        k = j + r2; continue;
      }
      if (r1 >= 2 && k + r1 === n) { k = n; continue; }
      return false;
    }
    k++;
  }
  return true;
}

// Try to read a link (or image, when `img`) starting at `i`. Returns
// {atom, next, phantom} on success, {failedLabelEnd} when the label's
// code-span shape fails marked's regex (which also suppresses emphasis
// inside the label), or null when no link is present.
function tryRef(s, i, ctx, img) {
  const start = img ? i + 1 : i;
  if (s[start] !== '[') return null;
  const end = bracketEnd(s, start);
  if (end < 0) return null;
  const label = s.slice(start + 1, end);
  if (label.indexOf('\n\n') >= 0) return null;
  if (!labelOk(label)) return { failedLabelEnd: end };
  if (!img && labelLinks(label, ctx)) return null;
  // A <tag with an unmatched quote (no closing quote and no > before the
  // label ends) blocks the link.
  if (!img) {
    const li = label.search(/<[A-Za-z]/);
    if (li >= 0) {
      let q = null;
      let closed = false;
      for (let k = li + 1; k < label.length; k++) {
        const ch = label[k];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (ch === '>') { closed = true; break; }
      }
      if (q && !closed) return null;
    }
  }
  // An autolink starting inside the label that closes after ] blocks it.
  {
    const ai = label.search(/<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|</);
    if (ai >= 0) {
      const ltPos = start + 1 + ai;
      const gt = s.indexOf('>', ltPos + 1);
      if (gt > end) {
        const inner = s.slice(ltPos + 1, gt);
        if (/^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)$/.test(inner)) return null;
      }
    }
  }
  // A code span starting inside the label that closes after ] blocks the
  // link. A span that marked's regex closes at a different-length run
  // leaves a "phantom" code span: the unmatched run can pair with a later
  // run of the same length, masking emphasis in between.
  let phantom = 0;
  {
    let bi = 0;
    let blocked = false;
    while (bi < label.length) {
      if (label[bi] === '\\' && bi + 1 < label.length) { bi += 2; continue; }
      if (label[bi] !== '`') { bi++; continue; }
      let run = 1;
      while (bi + run < label.length && label[bi + run] === '`') run++;
      // marked-pattern closing (ANY length) inside the label: the first
      // backtick run after non-backtick content closes the span for label
      // purposes (``guide` closes at the single backtick).
      let markedCloseEnd = -1;
      let closeRunLen = 0;
      {
        let k = bi + run;
        while (k < label.length && label[k] !== '`') k++;
        if (k < label.length) {
          let r2 = 1;
          while (k + r2 < label.length && label[k + r2] === '`') r2++;
          markedCloseEnd = k + r2;
          closeRunLen = r2;
        }
      }
      // Same-length closing inside the label (a real code span). The
      // phantom pairs same-length runs, so a marked-closed run that is
      // not same-closed is still open for phantom purposes.
      let sameClose = false;
      {
        let k = bi + run;
        while (k < label.length) {
          if (label[k] === '`') {
            let r2 = 1;
            while (k + r2 < label.length && label[k + r2] === '`') r2++;
            if (r2 === run) { sameClose = true; break; }
            k += r2;
          } else k++;
        }
      }
      const phantomLater = () => {
        if (phantom) return;
        let k3 = end + 1;
        while (k3 < s.length) {
          if (s[k3] === '`') {
            let r3 = 1;
            while (k3 + r3 < s.length && s[k3 + r3] === '`') r3++;
            if (r3 === run) { phantom = run; break; }
            k3 += r3;
          } else k3++;
        }
      };
      if (markedCloseEnd >= 0) {
        if (!sameClose) phantomLater();
        // A marked-pattern closer of a DIFFERENT length is itself an
        // unbalanced run in the raw text: it can open a phantom code span
        // that closes at a later run of ITS length (masking emphasis
        // between, e.g. ``guide` pairing with the ` before a_b).
        if (!sameClose && closeRunLen !== run && !phantom) {
          let k3 = end + 1;
          while (k3 < s.length) {
            if (s[k3] === '`') {
              let r3 = 1;
              while (k3 + r3 < s.length && s[k3 + r3] === '`') r3++;
              if (r3 === closeRunLen) { phantom = closeRunLen; break; }
              k3 += r3;
            } else k3++;
          }
        }
        bi = markedCloseEnd; continue;
      }
      // Not closed inside the label at all: look after ] for a
      // same-length closing run, only on the same line (a code span
      // crossing ] blocks the link).
      {
        let k2 = end + 1;
        while (k2 < s.length && s[k2] !== '\n') {
          if (s[k2] === '`') {
            let r2 = 1;
            while (k2 + r2 < s.length && s[k2 + r2] === '`') r2++;
            if (r2 === run) { blocked = true; break; }
            k2 += r2;
          } else k2++;
        }
        if (blocked) break;
      }
      // Not blocked: a later same-length run opens a phantom code span.
      phantomLater();
      bi += run;
    }
    if (blocked) return null;
  }
  let j = end + 1, href, title;
  if (s[j] === '(') {
    const r = linkDest(s, j + 1);
    if (r) {
      href = r.href; title = r.title; j = r.next;
    } else {
      // Inline destination invalid: fall back to shortcut reference.
      const def = ctx.refs.get(normLabel(label));
      if (!def) return null;
      href = def.href; title = def.title; j = end + 1;
    }
  } else if (s[j] === '[') {
    const e2 = bracketEnd(s, j);
    if (e2 < 0) return null;
    const ref = s.slice(j + 1, e2);
    const key = normLabel(ref === '' ? label : ref);
    const def = ctx.refs.get(key);
    if (!def) return null;
    href = def.href; title = def.title; j = e2 + 1;
  } else {
    const def = ctx.refs.get(normLabel(label));
    if (!def) return null;
    href = def.href; title = def.title;
  }
  return { atom: { type: 'l', href, title, label, img }, next: j, phantom };
}

// Trim a GFM autolink URL's trailing punctuation: strip trailing
// ?!.,:;*_~ (except a ; that ends an entity), unbalanced ) and ], and
// cut before the first unmatched (.
function trimGfmUrl(u) {
  let end = u.length;
  const trail = '?!.,:;*_~';
  while (end > 0) {
    const c = u[end - 1];
    if (trail.indexOf(c) >= 0) {
      if (c === ';') {
        const amp = u.lastIndexOf('&', end - 1);
        if (amp >= 0 && /^&\w+;$/.test(u.slice(amp, end))) { end = amp; continue; }
      }
      end--; continue;
    }
    if (c === ')') {
      // Keep the trailing ) only if it closes an open paren before it
      // (depth>0 when scanning u[0..end-1)); a total count misfires when
      // the extra ) sits mid-URL and the trailing one is the balanced one.
      let depth = 0;
      for (let q = 0; q < end - 1; q++) {
        if (u[q] === '(') depth++;
        else if (u[q] === ')' && depth > 0) depth--;
      }
      if (depth > 0) break;
      end--; continue;
    }
    if (c === ']') {
      if (u.indexOf('[', 0) < end && u.indexOf('[', 0) >= 0) break;
      end--; continue;
    }
    break;
  }
  // Cut before the first unmatched '(' (no closing ')' after it).
  {
    const stack = [];
    for (let q = 0; q < end; q++) {
      if (u[q] === '(') stack.push(q);
      else if (u[q] === ')' && stack.length) stack.pop();
    }
    if (stack.length) end = Math.min(end, stack[0]);
  }
  return u.slice(0, end);
}

// ------------------------------------------------------------ inline scanner

// Tokenise one inline span into atoms. Atom shapes:
//   {type:'t', s}        literal text (escapes already resolved)
//   {type:'c', s}        code span content
//   {type:'h', s}        raw HTML tag/comment
//   {type:'br'}          hard line break
//   {type:'d', ch, n, open, close, pos}   emphasis delimiter run
//   {type:'a'|'u', href, txt, mail?} autolink / GFM autolink
//   {type:'l', href, title, label, img} link or image
function lexInline(src, ctx) {
  const atoms = [];
  let i = 0;
  const n = src.length;
  let phantomLen = 0; // run length of an open phantom code span (from a link label); 0 = none
  let suppressEmUntil = -1; // inside a failed link label: no emphasis delimiters
  let textStart = 0;
  const flushText = (to) => {
    if (to > textStart) atoms.push({ type: 't', s: src.slice(textStart, to) });
  };
  // When a phantom code span closes inside a consumed link, clear it.
  const clearPhantomIn = (seg) => {
    let q = 0;
    while (q < seg.length) {
      if (seg[q] === '`') {
        let rl = 1;
        while (q + rl < seg.length && seg[q + rl] === '`') rl++;
        if (rl === phantomLen) { phantomLen = 0; break; }
        q += rl;
      } else q++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && punctQ(src[i + 1])) {
      flushText(i); atoms.push({ type: 't', s: src[i + 1] }); i += 2; textStart = i; continue;
    }
    if (c === '\\' && i + 1 < n && src[i + 1] === '\n') {
      flushText(i); atoms.push({ type: 'br' }); i += 2;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      textStart = i; continue;
    }
    if (c === ' ' && /^ {2,}\n/.test(src.slice(i))) {
      flushText(i); atoms.push({ type: 'br' });
      const m = /^ {2,}\n/.exec(src.slice(i)); i += m[0].length;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      textStart = i; continue;
    }
    if (c === '`') {
      let j = i; while (j < n && src[j] === '`') j++;
      const run = j - i;
      if (phantomLen && run === phantomLen) phantomLen = 0;
      let k = j, found = -1;
      while (k < n) {
        const b = src.indexOf('`', k);
        if (b < 0) break;
        let e = b; while (e < n && src[e] === '`') e++;
        if (e - b === run) { found = b; break; }
        k = e;
      }
      if (found < 0) { i = j; continue; }
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') content = content.slice(1, -1);
      flushText(i); atoms.push({ type: 'c', s: content }); i = found + run; textStart = i; continue;
    }
    if (c === '<') {
      const tm = RX_TAG.exec(src.slice(i));
      if (tm) {
        if (/^<a[\s>]/i.test(tm[0])) ctx.inLink = true;
        else if (/^<\/a[\s>]/i.test(tm[0])) ctx.inLink = false;
        flushText(i); atoms.push({ type: 'h', s: tm[0] }); i += tm[0].length; textStart = i; continue;
      }
      const am = RX_AUTOLINK.exec(src.slice(i));
      if (am) {
        const raw = am[1];
        const mail = !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(raw);
        flushText(i); atoms.push({ type: 'a', href: mail ? 'mailto:' + raw : raw, txt: raw, mail }); i += am[0].length; textStart = i; continue;
      }
      i++; continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const r = tryRef(src, i, ctx, true);
      if (r && r.atom) { flushText(i); atoms.push(r.atom); if (phantomLen) clearPhantomIn(src.slice(i, r.next)); i = r.next; textStart = i; if (r.phantom) phantomLen = r.phantom; continue; }
      if (r && r.failedLabelEnd !== undefined) suppressEmUntil = r.failedLabelEnd;
      i++; continue;
    }
    if (c === '[') {
      const r = tryRef(src, i, ctx, false);
      if (r && r.atom) { flushText(i); atoms.push(r.atom); if (phantomLen) clearPhantomIn(src.slice(i, r.next)); i = r.next; textStart = i; if (r.phantom) phantomLen = r.phantom; continue; }
      if (r && r.failedLabelEnd !== undefined) suppressEmUntil = r.failedLabelEnd;
      i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i; while (j < n && src[j] === c) j++;
      if (phantomLen) { i = j; continue; } // inside a phantom code span: plain text, no delimiter
      if (suppressEmUntil >= 0 && i < suppressEmUntil) { i = j; continue; } // inside a failed link label: plain text
      const prev = i > 0 ? src[i - 1] : '';
      const next = j < n ? src[j] : '';
      const prevWs = prev === '' || uniSpaceQ(prev);
      const nextWs = next === '' || uniSpaceQ(next);
      const prevPu = prev !== '' && uniPunctQ(prev);
      const nextPu = next !== '' && uniPunctQ(next);
      const leftFl = !nextWs && (!nextPu || prevWs || prevPu);
      const rightFl = !prevWs && (!prevPu || nextWs || nextPu);
      let open = false, close = false;
      if (c === '*') { open = leftFl; close = rightFl; }
      else if (c === '_') { open = leftFl && (!rightFl || prevPu); close = rightFl && (!leftFl || nextPu); }
      else { open = leftFl; close = rightFl; }
      flushText(i); atoms.push({ type: 'd', ch: c, n: j - i, open, close, pos: i }); i = j; textStart = i; continue;
    }
    if (linkDepth === 0 && !ctx.inLink && ((c === 'w' && src.startsWith('www.', i)) || /^(?:https?|ftp):\/\//i.test(src.slice(i)))) {
      const prev = i > 0 ? src[i - 1] : '';
      if (prev === '' || (!alnumQ(prev) && prev !== '_' && prev !== '-' && prev !== '.')) {
        const m = /^[^\s<]+/.exec(src.slice(i));
        if (m) {
          const u = trimGfmUrl(m[0]);
          if (u.length > 4) {
            flushText(i);
            atoms.push({ type: 'u', href: c === 'w' ? 'http://' + u : u, txt: u });
            i += u.length; textStart = i; continue;
          }
        }
      }
      i++; continue;
    }
    if (alnumQ(c)) {
      const prevB = i > 0 ? src[i - 1] : '';
      if (linkDepth === 0 && !ctx.inLink && ((c === 'm' && src.startsWith('mailto:', i)) || (c === 'x' && src.startsWith('xmpp:', i)))) {
        if (prevB === '' || (!alnumQ(prevB) && prevB !== '_' && prevB !== '-' && prevB !== '.')) {
          const sm = RX_MAILTO_XMPP.exec(src.slice(i));
          if (sm) {
            flushText(i);
            atoms.push({ type: 'u', href: sm[0], txt: sm[0] });
            i += sm[0].length; textStart = i; continue;
          }
        }
      }
      let em = null;
      if (linkDepth === 0 && !ctx.inLink) {
        const lm = RX_EMAIL_LOOSE.exec(src.slice(i));
        if (lm) {
          const after = src[i + lm[0].length];
          if (after === undefined || (!/[A-Za-z0-9-]/.test(after) && after !== '_' && after !== '*')) {
            em = lm;
          } else if ((after === '_' || after === '*') && atoms.some((a) => a.type === 'd' && a.ch === after && a.open)) {
            em = lm;
          } else {
            // Followed by a word char: fall back to the strict
            // (backtracking) match.
            em = RX_EMAIL.exec(src.slice(i));
          }
        }
      }
      if (em) {
        const prev = i > 0 ? src[i - 1] : '';
        const prevIsDelim = prev === '_' && atoms.length && atoms[atoms.length - 1].type === 'd' && atoms[atoms.length - 1].ch === '_';
        if (prev === '' || prevIsDelim || (!alnumQ(prev) && prev !== '_' && prev !== '-' && prev !== '.')) {
          flushText(i);
          atoms.push({ type: 'u', href: 'mailto:' + em[0], txt: em[0] });
          i += em[0].length; textStart = i; continue;
        }
      }
      i++; continue;
    }
    i++;
  }
  flushText(n);
  return atoms;
}

// ------------------------------------------------------------ emphasis pairing

// Pair delimiter atoms into em/strong/del nodes in place, following
// CommonMark's delimiter rules plus marked's quirks: the rule of 3, the
// "lone closer must not steal a ** opener" lookahead, the "strong formed
// from a both-ways closer blocks the outer em" case, and the adjacency
// rule for `*` closers after an em.
function pairDelims(atoms) {
  const stack = [];
  let idx = 0;
  while (idx < atoms.length) {
    const a = atoms[idx];
    if (a.type !== 'd') { idx++; continue; }
    let didMatch = false;
    if (a.close && a.n > 0) {
      let oi = -1;
      let leftoverInside = false;
      for (let s = stack.length - 1; s >= 0; s--) {
        const o = atoms[stack[s]];
        if (!o || o.type !== 'd' || o.ch !== a.ch || o.n <= 0) continue;
        if (a.ch === '~' && !(o.n === a.n && o.n >= 1 && o.n <= 2)) continue;
        if (a.ch !== '~' && ((o.open && o.close) || (a.open && a.close)) && ((o.n + a.n) % 3 === 0) && (o.n % 3 !== 0)) continue;
        // A strong formed from a both-ways ** closer between opener and
        // closer blocks the outer em (rule of 3); the opener is dead once
        // its natural n=1 closer is blocked, so a later ** closer must
        // not steal it either.
        if (a.ch !== '~' && o.n === 1) {
          let blocked = false;
          for (let t = stack[s] + 1; t < idx; t++) {
            const d = atoms[t];
            // Skip a strong formed from the SAME delimiter run as this
            // closer (it sits immediately before it: a *** run splits
            // into ** for the strong and * for the outer em, and must
            // not block that em).
            if (t === idx - 1) continue;
            if (d.type === 'strong' && d.blocksOuter && d.bCh === a.ch && ((o.n + 2) % 3 === 0) && (o.n % 3 !== 0)) { blocked = true; break; }
          }
          if (blocked) continue;
        }
        // A lone closer must not steal a ** opener when a later **
        // closer can make strong.
        if (a.ch !== '~' && a.n === 1 && o.n === 2) {
          let laterStrong = false;
          for (let t = idx + 1; t < atoms.length; t++) {
            const d = atoms[t];
            if (d.type === 'd' && d.ch === a.ch && d.close && d.n >= 2) { laterStrong = true; break; }
          }
          if (laterStrong) continue;
        }
        // Adjacency rule: content ending [em][text-no-space] before a **
        // closer means the em closer * and the ** closer interact: n=2
        // cannot form the strong at all, n>=3 forms it but the leftover
        // * stays inside.
        if (a.ch === '*' && a.n >= 2 && o.n >= 2) {
          const inner = atoms.slice(stack[s] + 1, idx);
          if (inner.length >= 2) {
            const last = inner[inner.length - 1];
            const prev = inner[inner.length - 2];
            if (last.type === 't' && last.s && !/^[ \t]/.test(last.s) && prev.type === 'em') {
              if (a.n >= 3) leftoverInside = true;
            }
          }
        }
        oi = s; break;
      }
      if (oi >= 0) {
        const oIdx = stack[oi];
        const o = atoms[oIdx];
        const use = a.ch === '~' ? o.n : (o.n >= 2 && a.n >= 2 ? 2 : 1);
        const kind = a.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const node = { type: kind, children: atoms.slice(oIdx + 1, idx) };
        if (kind === 'strong' && a.open && a.close && !(o.open && o.close)) { node.blocksOuter = true; node.bCh = a.ch; }
        o.n -= use; a.n -= use;
        if (leftoverInside && a.n > 0) { node.children.push({ type: 'd', ch: a.ch, n: a.n, open: a.open, close: a.close, pos: a.pos }); a.n = 0; }
        const rep = [];
        if (o.n > 0) rep.push(o);
        rep.push(node);
        if (a.n > 0) rep.push(a);
        atoms.splice(oIdx, idx - oIdx + 1, ...rep);
        for (let s = stack.length - 1; s >= 0; s--) if (stack[s] >= oIdx) stack.splice(s, 1);
        if (o.n > 0) stack.push(oIdx);
        idx = a.n > 0 ? oIdx + rep.length - 1 : oIdx + rep.length;
        didMatch = true;
      }
    }
    if (!didMatch) {
      if (a.open && a.n > 0) stack.push(idx);
      idx++;
    }
  }
}

// ------------------------------------------------------------ inline rendering

// Plain-text form of a span (used for image alt text): markup stripped,
// numeric references resolved, newlines become spaces.
function plainText(src, ctx) {
  const atoms = lexInline(src, ctx);
  pairDelims(atoms);
  const walk = (list) => {
    let s = '';
    for (const a of list) {
      if (a.type === 't') s += numRefs(a.s);
      else if (a.type === 'c') s += a.s;
      else if (a.type === 'a' || a.type === 'u') s += a.txt;
      else if (a.type === 'l') s += plainText(a.label, ctx);
      else if (a.type === 'em' || a.type === 'strong' || a.type === 'del') s += walk(a.children);
      else if (a.type === 'd') s += a.ch.repeat(a.n);
      else if (a.type === 'h') s += a.s;
    }
    return s;
  };
  return walk(atoms).replace(/\n/g, ' ');
}

function renderAtoms(atoms, ctx) {
  let out = '';
  for (const a of atoms) {
    if (a.type === 't') out += esc(numRefs(a.s));
    else if (a.type === 'c') out += '<code>' + esc(a.s, true) + '</code>';
    else if (a.type === 'h') out += a.s;
    else if (a.type === 'br') out += '<br>';
    else if (a.type === 'd') out += a.ch.repeat(a.n);
    else if (a.type === 'em' || a.type === 'strong' || a.type === 'del') {
      const tag = a.type === 'em' ? 'em' : a.type === 'strong' ? 'strong' : 'del';
      out += '<' + tag + '>' + renderAtoms(a.children, ctx) + '</' + tag + '>';
    } else if (a.type === 'a' || a.type === 'u') {
      const href = encHref(a.href);
      if (href === null) { out += esc(numRefs(a.txt)); continue; }
      out += '<a href="' + esc(href) + '">' + esc(numRefs(a.txt)) + '</a>';
    } else if (a.type === 'l') {
      const href = encHref(a.href);
      if (href === null) { out += inlineHtml(a.label, ctx); continue; }
      if (a.img) {
        out += '<img src="' + esc(href) + '" alt="' + esc(plainText(a.label, ctx)) + '"';
        if (a.title !== undefined) out += ' title="' + esc(a.title) + '"';
        out += '>';
      } else {
        out += '<a href="' + esc(href) + '"';
        if (a.title !== undefined) out += ' title="' + esc(a.title) + '"';
        linkDepth++;
        const labelHtml = inlineHtml(a.label, ctx);
        linkDepth--;
        out += '>' + labelHtml + '</a>';
      }
    }
  }
  return out;
}

function inlineHtml(src, ctx) {
  const atoms = lexInline(src, ctx);
  pairDelims(atoms);
  return renderAtoms(atoms, ctx);
}

// ------------------------------------------------------------ entry point

// Render one Markdown document to the HTML marked 18.1.3 produces with
// its default options. No state carries between calls.
export function parse(src) {
  const ctx = { refs: new Map(), inLink: false };
  src = src.replace(/\r\n|\r/g, '\n');
  return renderBlocks(lexBlocks(src, ctx), ctx);
}
