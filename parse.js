// A fast, dependency-free Markdown renderer: parse(markdown) returns exactly
// the HTML marked 18.1.3 produces with its default options (GFM on, breaks
// off, pedantic off, async off). Design: a block scanner turns the source
// into a flat list of small nodes (link reference definitions are collected
// into the context as they are met, so a definition anywhere resolves a
// reference anywhere else), and a renderer walks the nodes straight to HTML,
// parsing inline content on demand. No intermediate token objects are ever
// built; that is where most of the speed over marked comes from. The rule
// order, the emphasis and strikethrough delimiter scans, and the link,
// list and blockquote continuation rules all follow marked's published
// behaviour, so the output matches it code unit for code unit.

// Compose a regex out of named pieces: each $name in the source is spliced
// with the piece's source, with any leading ^ the piece carried dropped (a
// ^ is only an anchor at the start of the whole pattern, never mid-pattern).
const DROP_CARET = /(^|[^\[])\^/g;
function rx(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    sub(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(DROP_CARET, '$1');
      src = src.replace(name, v);
      return api;
    },
    re() {
      return new RegExp(src, flags || '');
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Shared small patterns
// ---------------------------------------------------------------------------

const P = {
  stripCodeIndent: /^(?: {0,3}\t| {1,4})/gm,
  linkBracketEscapes: /\\([\[\]])/g,
  fenceIndent: /^(\s+)(?:```)/,
  leadingWs: /^\s+/,
  trailingHash: /#$/,
  leadingSpace: /^ /,
  trailingSpace: / $/,
  trailingSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  wsRuns: /\s+/g,
  blankLine: /^[ \t]*$/,
  twoBlankLines: /\n[ \t]*\n[ \t]*$/,
  quoteStart: /^ {0,3}>/,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteMarker: /^ {0,3}>[ \t]?/gm,
  quoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  taskItem: /^\[[ xX]\][ \t]+\S/,
  taskMarker: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  angleHref: /^<(.*)>$/,
  tablePipe: /[:|]/,
  tableEdgePipes: /^\||\| *$/g,
  tableTrailingBlank: /\n[ \t]*$/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  openAnchor: /^<a /i,
  closeAnchor: /^<\/a>/i,
  openPre: /^<(pre|code|kbd|script)(\s|>)/i,
  closePre: /^<\/(pre|code|kbd|script)(\s|>)/i,
  openAngle: /^</,
  closeAngle: />$/,
  alphaNum: /[\p{L}\p{N}]/u,
  numericRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escTest: /[&<>"']/,
  escReplace: /[&<>"']/g,
  escTestRaw: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escReplaceRaw: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  pct25: /%25/g,
  pipeChar: /\|/g,
  pipeSplit: / \|/,
  escapedPipe: /\\\|/g,
  crlf: /\r\n|\r/g,
  firstWord: /^\S*/,
  trailingNl: /\n$/,
  itemHead: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
};

// Regexes parameterised by an indentation depth, cached four deep (the
// depth only ever takes the values 0..3).
function byDepth(make) {
  const cache = [];
  return (depth) => {
    const i = Math.max(0, Math.min(3, depth - 1));
    let r = cache[i];
    if (!r) {
      r = make(i);
      cache[i] = r;
    }
    return r;
  };
}
P.nextItem = byDepth((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
P.hrAt = byDepth((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
P.fenceAt = byDepth((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
P.atxAt = byDepth((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
P.quoteAt = byDepth((i) => new RegExp(`^ {0,${i}}>`));

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const TAGNAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

P.htmlAt = byDepth((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAGNAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

const BLK = {};
BLK.newline = /^(?:[ \t]*(?:\n|$))+/;
BLK.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
BLK.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
BLK.hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
BLK.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
BLK.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
BLK.blockText = /^[^\n]+/;

const SETEXT_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
BLK.lheading = rx(SETEXT_CORE)
  .sub(/bull/g, BLK.bullet)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .re();

const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const LABEL_BODY = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

BLK.def = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', LABEL_BODY)
  .sub('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .re();

BLK.list = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .sub(/bull/g, BLK.bullet)
  .re();

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
BLK.html = rx(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .sub('comment', HTML_COMMENT)
  .sub('tag', TAGNAMES)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .re();

// A paragraph inside a blockquote or list item interrupts on a narrower
// set of list markers than a top-level paragraph does.
function paraFor(listInterrupt) {
  return rx(PARA_CORE)
    .sub('hr', BLK.hr)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '')
    .sub('|table', '')
    .sub('blockquote', ' {0,3}>')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', listInterrupt)
    .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .sub('tag', TAGNAMES)
    .re();
}

const TABLE_CORE = '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
function tableRule() {
  return rx(TABLE_CORE)
    .sub('hr', BLK.hr)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('blockquote', ' {0,3}>')
    .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .sub('tag', TAGNAMES)
    .re();
}
BLK.table = tableRule();

BLK.paragraph = rx(PARA_CORE)
  .sub('hr', BLK.hr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('table', tableRule())
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAGNAMES)
  .re();

BLK.quotePara = paraFor(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
BLK.blockquote = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .sub('paragraph', BLK.quotePara)
  .re();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const INL = {};
INL.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
INL.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
INL.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_WS = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_WS = /[^\s\p{P}\p{S}]/u;
// In GFM, ~ is not punctuation inside strong and em.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_WS_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_WS_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const SKIP_INLINE = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .re();
INL.skipInline = SKIP_INLINE;

const EM_LEFT_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
INL.emLeft = rx(EM_LEFT_CORE, 'u').sub(/punct/g, PUNCT_GFM).re();

const EM_RIGHT_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // an orphan inside strong
  + '|[^*]+(?=[^*])' // run to the next delimiter
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only close
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***# can only close
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a can only open
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only open
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either
INL.emRightAst = rx(EM_RIGHT_AST, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_WS_GFM)
  .sub(/punctSpace/g, PUNCT_WS_GFM)
  .sub(/punct/g, PUNCT_GFM)
  .re();

INL.emRightUnd = rx(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_WS)
  .sub(/punctSpace/g, PUNCT_WS)
  .sub(/punct/g, PUNCT)
  .re();

INL.delLeft = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .sub(/punct/g, PUNCT)
  .re();

INL.delRight = rx(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_WS)
  .sub(/punctSpace/g, PUNCT_WS)
  .sub(/punct/g, PUNCT)
  .re();

INL.anyPunct = rx(/\\(punct)/, 'gu')
  .sub(/punct/g, PUNCT)
  .re();

// Backslash escapes outside code spans are masked for the emphasis scan;
// a backslash inside a code span is literal, so the span's backticks are
// masked instead and the span itself is left alone.
INL.punctOutsideCode = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .sub(/punct/g, PUNCT)
  .re();

INL.punctAt = rx(/^((?![*_])punctSpace)/, 'u')
  .sub(/punctSpace/g, PUNCT_WS)
  .re();

INL.autolink = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .re();

const INLINE_COMMENT = rx(HTML_COMMENT).sub('(?:-->|$)', '-->').re();
INL.tag = rx(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .sub('comment', INLINE_COMMENT)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .re();

const BRACKET_RUN = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', BRACKET_RUN)
  .re();

INL.link = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_INNER)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .re();

INL.reflink = rx(/^!?\[(label)\]\[(ref)\]/)
  .sub('label', LABEL_INNER)
  .sub('ref', LABEL_BODY)
  .re();

INL.nolink = rx(/^!?\[(ref)\](?:\[\])?/)
  .sub('ref', LABEL_BODY)
  .re();

// The search form of reflink/nolink bounds its scan: a link label is at
// most 999 characters and holds at most 999 escapes, code spans and nested
// brackets, so a candidate that can never match still cannot cost
// quadratic time over a long run of '[' characters.
const BOUNDED_DEF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', BRACKET_RUN)
  .re();

INL.reflinkSearch = rx('reflink|nolink(?!\\()', 'g')
  .sub('reflink', rx(/^!?\[(label)\]\[(ref)\]/)
    .sub('label', BOUNDED_LABEL)
    .sub('ref', BOUNDED_DEF_LABEL)
    .re())
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/)
    .sub('ref', BOUNDED_DEF_LABEL)
    .re())
  .re();

const SCHEMES = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXT_MAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
INL.url = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EXT_MAIL).re())
  .sub('protocol', SCHEMES)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .re();
INL.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
INL.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

INL.text = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', SCHEMES)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .re();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENT = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(html, encode) {
  if (encode) {
    if (P.escTest.test(html)) return html.replace(P.escReplace, (ch) => ENT[ch]);
  } else if (P.escTestRaw.test(html)) {
    return html.replace(P.escReplaceRaw, (ch) => ENT[ch]);
  }
  return html;
}

function decodeRefs(text) {
  if (!P.numericRef.test(text)) return text;
  return text.replace(P.numericRefOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanHref(href) {
  try {
    href = encodeURI(href).replace(P.pct25, '%');
  } catch {
    return null;
  }
  return href;
}

function splitRow(row, count) {
  const marked = row.replace(P.pipeChar, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(P.pipeSplit);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(P.escapedPipe, '|');
  }
  return cells;
}

// Strip trailing `c`s from a string; a /c*$/ regex is REDOS-vulnerable,
// so walk it by hand. With `invert`, strip trailing characters that are
// not `c` instead.
function stripTail(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let n = 0;
  while (n < l) {
    const curr = str.charAt(l - n - 1);
    if (curr === c && !invert) n++;
    else if (curr !== c && invert) n++;
    else break;
  }
  return str.slice(0, l - n);
}

function dropBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && P.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label folds to lower case through upper case (so ẞ meets SS),
// with leading/trailing space stripped and inner runs collapsed to one.
function foldLabel(label) {
  return label.trim().replace(P.wsRuns, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes an unbalanced run of b[0], or -1 when
// balanced, -2 when more opens than closes.
function closeBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// One scan of an inline run for the last delimiter run that can close
// emphasis/strong (* or _) and strikethrough (~). A run can close only
// when it is not preceded by ASCII whitespace or the start of the string.
function findClosers(src) {
  const last = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

// ---------------------------------------------------------------------------
// Block scanning. Builds a flat node list; link reference definitions are
// collected into ctx.refs as they are found, exactly as marked does, so a
// definition anywhere in the document resolves a reference anywhere else.
// Nodes carry `raw` (the source slice they consumed) for the continuation
// bookkeeping quotes and lists do, and `text` where they hold inline
// content. Rendering happens later, after every definition is known.
// ---------------------------------------------------------------------------

function fenceIndentFix(raw, text) {
  const mm = raw.match(P.fenceIndent);
  if (!mm) return text;
  const pad = mm[1];
  return text.split('\n').map((line) => {
    const mi = line.match(P.leadingWs);
    if (!mi) return line;
    return line.slice(Math.min(mi[0].length, pad.length));
  }).join('\n');
}

function readQuote(src, ctx) {
  const m = BLK.blockquote.exec(src);
  if (!m) return undefined;
  let lines = stripTail(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const kids = [];
  while (lines.length > 0) {
    let inQuote = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (P.quoteStart.test(lines[i])) {
        cur.push(lines[i]);
        inQuote = true;
      } else if (!inQuote) {
        cur.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const curRaw = cur.join('\n');
    const curText = curRaw
      .replace(P.quoteMarkerWs, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(P.quoteSetext, '\n    $1')
      .replace(P.quoteMarker, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;
    const top = ctx.top;
    ctx.top = true;
    scanBlocks(curText, ctx, kids, true);
    ctx.top = top;
    if (lines.length === 0) break;
    const last = kids[kids.length - 1];
    if (last && (last.t === 'code' || last.t === 'head' || last.t === 'rule' || last.t === 'raw' || last.t === 'table')) break;
    if (last && last.t === 'quote') {
      const old = last;
      const rest = lines.join('\n');
      const joined = old.raw + '\n' + rest.replace(P.quoteMarker, '');
      const nt = readQuote(joined, ctx);
      kids[kids.length - 1] = nt;
      const left = joined.substring(nt.raw.length).replace(/^\n/, '');
      const leftCount = left ? left.split('\n').length : 0;
      const used = leftCount ? lines.slice(0, -leftCount) : lines;
      if (used.length > 0) raw = raw + '\n' + used.join('\n');
      text = text.substring(0, text.length - old.text.length) + nt.text;
      lines = lines.slice(used.length);
      if (lines.length > 0 && P.quoteStart.test(lines[0])) continue;
      break;
    }
    if (last && last.t === 'list') {
      const old = last;
      const joined = old.raw + '\n' + lines.join('\n');
      const nt = readList(joined, ctx);
      kids[kids.length - 1] = nt;
      const usedCount = nt.raw.length > old.raw.length
        ? joined.slice(old.raw.length + 1, nt.raw.length).split('\n').length
        : 0;
      if (usedCount > 0) {
        const used = lines.slice(0, usedCount).join('\n');
        raw = raw + '\n' + used;
        text = text + '\n' + used;
      }
      lines = lines.slice(usedCount);
      continue;
    }
  }
  return { t: 'quote', raw, text, kids };
}

function readList(src, ctx) {
  let cap = BLK.list.exec(src);
  if (!cap) return undefined;
  const listSrc = src;
  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const headRe = P.itemHead(bull);
  let endsBlank = false;
  while (src) {
    let endEarly = false;
    let contents = '';
    if (!(cap = headRe.exec(src))) break;
    if (BLK.hr.test(src)) break;
    const itemStart = listSrc.length - src.length;
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bullIndent = cap[1].length;
    let line = firstLine.replace(P.leadingSpaceTab, (ws) => expandTabs(ws, bullIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bullIndent + 1;
    } else {
      indent = line.search(P.nonSpace);
      indent = indent > 4 ? 1 : indent;
      contents = line.slice(indent);
      indent += bullIndent;
    }
    if (blankLine && P.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextItemRe = P.nextItem(indent);
      const hrRe = P.hrAt(indent);
      const fenceRe = P.fenceAt(indent);
      const atxRe = P.atxAt(indent);
      const htmlRe = P.htmlAt(indent);
      const quoteRe = P.quoteAt(indent);
      while (src) {
        const rawLine = src.split('\n', 1)[0];
        nextLine = rawLine;
        // The six break rules all anchor their marker within `indent`
        // spaces of the raw line's start, so a line whose first content
        // sits strictly deeper than `indent` (after tab expansion) cannot
        // trigger any of them — and a blank line cannot either. Most
        // continuation lines are deep or blank, so they skip six regex
        // tests each. The leading run is scanned by hand once, giving
        // both the tab-expanded line and the first-content column.
        let col = 0, i = 0, hasTab = false;
        while (i < rawLine.length) {
          const ch = rawLine[i];
          if (ch === ' ') { col++; i++; }
          else if (ch === '\t') { col += 4 - (col % 4); i++; hasTab = true; }
          else break;
        }
        const blank = !rawLine.trim();
        const noTabs = blank ? rawLine
          : hasTab ? expandTabs(rawLine.slice(0, i)) + rawLine.slice(i) : rawLine;
        const firstContent = blank ? -1 : col;
        if (firstContent > indent || blank) {
          contents += '\n' + noTabs.slice(indent);
        } else {
          if (fenceRe.test(nextLine)) break;
          if (atxRe.test(nextLine)) break;
          if (htmlRe.test(nextLine)) break;
          if (quoteRe.test(nextLine)) break;
          if (nextItemRe.test(nextLine)) break;
          if (hrRe.test(nextLine)) break;
          if (firstContent >= indent) {
            contents += '\n' + noTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(P.tabGlobal, '    ').search(P.nonSpace) >= 4) break;
            if (fenceRe.test(line)) break;
            if (atxRe.test(line)) break;
            if (htmlRe.test(line)) break;
            if (hrRe.test(line)) break;
            const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && BLK.lheading.test(`${line}\n${nextLine}`);
            const cont = setextCont
              ? `    ${noTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            contents += '\n' + cont;
          }
        }
        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = noTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, listSrc.length - src.length);
    if (!list.loose) {
      if (endsBlank) list.loose = true;
      else if (P.twoBlankLines.test(raw)) endsBlank = true;
    }
    list.items.push({
      raw,
      task: P.taskItem.test(contents),
      loose: false,
      text: contents,
      kids: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = listSrc.slice(0, listSrc.length - src.length).trimEnd();
  // First pass: scan items, settle loose from blank-line spacers.
  for (const item of list.items) {
    ctx.top = false;
    scanBlocks(item.text, ctx, item.kids, false);
    if (!list.loose) {
      const spacers = item.kids.filter((t) => t.t === 'blank');
      list.loose = spacers.length > 0 && spacers.some((t) => P.anyLine.test(t.raw));
    }
  }
  // Second pass: place task checkboxes. A checkbox is rendered before the
  // item's content when the list is tight, and inside the first paragraph
  // when it is loose; the marker is stripped from the item's first text.
  for (const item of list.items) {
    const first = item.kids[0];
    if (item.task && first && (first.t === 'text' || first.t === 'para')) {
      item.text = item.text.replace(P.taskMarker, '');
      first.raw = first.raw.replace(P.taskMarker, '');
      first.text = first.text.replace(P.taskMarker, '');
      const box = P.taskBox.exec(item.raw);
      if (box) {
        const checked = box[0] !== '[ ]';
        item.checked = checked;
        if (list.loose) first.checkboxFirst = checked;
        else item.checkbox = checked;
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.kids) if (t.t === 'text') t.t = 'para';
    }
  }
  return list;
}

// A setext heading needs an underline line (only = or -, after at most
// 3 spaces) before the next blank line — the heading text cannot cross
// one. If no such line exists in this paragraph, the setext rule cannot
// match, so the (expensive, backtracking) rule is skipped.
function setextAhead(src) {
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const end = nl === -1 ? src.length : nl;
    let j = i;
    while (j < end && src[j] === ' ' && j - i < 3) j++;
    if (j < end && (src[j] === '=' || src[j] === '-')) {
      const ch = src[j];
      let k = j;
      while (k < end && src[k] === ch) k++;
      let ok = true;
      for (let t = k; t < end; t++) {
        if (src[t] !== ' ' && src[t] !== '\t') { ok = false; break; }
      }
      if (ok) return true;
    }
    if (nl === -1) break;
    let blank = true;
    for (let t = i; t < end; t++) {
      if (src[t] !== ' ' && src[t] !== '\t') { blank = false; break; }
    }
    if (blank) break;
    i = nl + 1;
  }
  return false;
}

function scanBlocks(src, ctx, nodes, lastClip) {
  let clip = lastClip;
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let m;
    // First non-space character: every block opener except table,
    // setext heading and paragraph needs its marker within 3 spaces
    // of the line start, so a prose line skips those regexes outright.
    let lead = 0;
    while (lead < 4 && src.charCodeAt(lead) === 32) lead++;
    const f = lead < 4 ? (src[lead] || '') : '';
    const canCode = lead === 4 || src.charCodeAt(lead) === 9;
    // blank lines
    if ((src.charCodeAt(0) === 10 || src.charCodeAt(0) === 32 || src.charCodeAt(0) === 9)
      && (m = BLK.newline.exec(src)) && m[0].length > 0) {
      const raw = m[0];
      src = src.substring(raw.length);
      const last = nodes[nodes.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else nodes.push({ t: 'blank', raw });
      continue;
    }
    // indented code (cannot interrupt a paragraph: it joins it instead)
    if (canCode && (m = BLK.code.exec(src))) {
      const raw = dropBlankTail(m[0]);
      const text = raw.replace(P.stripCodeIndent, '');
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && (last.t === 'para' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
      } else {
        nodes.push({ t: 'code', raw, text });
      }
      continue;
    }
    // fenced code
    if (lead < 4 && (f === '`' || f === '~') && (m = BLK.fences.exec(src))) {
      const raw = m[0];
      const text = fenceIndentFix(raw, m[3] || '');
      src = src.substring(raw.length);
      nodes.push({
        t: 'code',
        raw,
        text,
        lang: m[2] ? m[2].trim().replace(INL.anyPunct, '$1') : m[2],
      });
      continue;
    }
    // ATX heading
    if (lead < 4 && f === '#' && (m = BLK.heading.exec(src))) {
      let text = m[2].trim();
      if (P.trailingHash.test(text)) {
        const trimmed = stripTail(text, '#');
        if (!trimmed || P.trailingSpaceTab.test(trimmed)) text = trimmed.trim();
      }
      src = src.substring(m[0].length);
      nodes.push({ t: 'head', raw: stripTail(m[0], '\n'), depth: m[1].length, text });
      continue;
    }
    // thematic break
    if (lead < 4 && (f === '-' || f === '_' || f === '*') && (m = BLK.hr.exec(src))) {
      src = src.substring(m[0].length);
      nodes.push({ t: 'rule', raw: stripTail(m[0], '\n') });
      continue;
    }
    // blockquote
    if (lead < 4 && f === '>' && (m = readQuote(src, ctx))) {
      src = src.substring(m.raw.length);
      nodes.push(m);
      continue;
    }
    // list
    if (lead < 4 && (f === '-' || f === '+' || f === '*' || (f >= '0' && f <= '9'))
      && (m = readList(src, ctx))) {
      src = src.substring(m.raw.length);
      nodes.push(m);
      continue;
    }
    // raw HTML block
    if (lead < 4 && f === '<' && (m = BLK.html.exec(src))) {
      const raw = dropBlankTail(m[0]);
      src = src.substring(m[0].length);
      nodes.push({
        t: 'raw',
        raw,
        text: raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      });
      continue;
    }
    // link reference definition (first one wins; one after a paragraph
    // without a blank line is paragraph text, not a definition)
    if (lead < 4 && f === '[' && (m = BLK.def.exec(src))) {
      if (P.openAngle.test(m[2]) || closeBracket(m[2], '()') === -1) {
        const tag = foldLabel(m[1]);
        const href = m[2] ? m[2].replace(P.angleHref, '$1').replace(INL.anyPunct, '$1') : '';
        const title = m[3]
          ? m[3].substring(1, m[3].length - 1).replace(INL.anyPunct, '$1')
          : m[3];
        const raw = stripTail(m[0], '\n');
        src = src.substring(m[0].length);
        const last = nodes[nodes.length - 1];
        if (last && (last.t === 'para' || last.t === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
        } else {
          if (!ctx.refs[tag]) ctx.refs[tag] = { href, title };
          nodes.push({ t: 'def', raw });
        }
        continue;
      }
    }
    // table
    if ((m = BLK.table.exec(src))) {
      if (P.tablePipe.test(m[2])) {
        const headers = splitRow(m[1]);
        const aligns = m[2].replace(P.tableEdgePipes, '').split('|');
        const rows = m[3] && m[3].trim()
          ? m[3].replace(P.tableTrailingBlank, '').split('\n')
          : [];
        if (headers.length === aligns.length) {
          const align = aligns.map((a) => P.alignRight.test(a) ? 'right'
            : P.alignCenter.test(a) ? 'center'
            : P.alignLeft.test(a) ? 'left' : null);
          src = src.substring(m[0].length);
          nodes.push({
            t: 'table',
            raw: stripTail(m[0], '\n'),
            header: headers.map((h, i) => ({ text: h, align: align[i] })),
            rows: rows.map((r) => splitRow(r, headers.length)
              .map((c, i) => ({ text: c, align: align[i] }))),
          });
          continue;
        }
      }
    }
    // setext heading
    if (setextAhead(src) && (m = BLK.lheading.exec(src))) {
      src = src.substring(m[0].length);
      nodes.push({
        t: 'head',
        raw: stripTail(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text: m[1].trim(),
      });
      continue;
    }
    // paragraph (top level only; inside list items it is plain text)
    if (ctx.top && (m = BLK.paragraph.exec(src))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (clip && last && last.t === 'para') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + text;
      } else {
        nodes.push({ t: 'para', raw: m[0], text });
      }
      clip = false;
      continue;
    }
    // plain text line(s)
    if ((m = BLK.blockText.exec(src))) {
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && last.t === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
      } else {
        nodes.push({ t: 'text', raw: m[0], text: m[0] });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
}

// ---------------------------------------------------------------------------
// Inline rendering. Each inline run scans its source once for the last
// closable emphasis / strikethrough delimiter, masks links, code spans,
// HTML and escapes out of the emphasis scanner's view (keeping every
// length, so the masked source stays aligned with the real one), then
// walks the source left to right in marked's token order.
// ---------------------------------------------------------------------------

function hasLinkIn(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(INL.skipInline)) {
    if (INL.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INL.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!'
      || !Object.hasOwn(ctx.refs, foldLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && hasLinkIn(m0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, HTML and escapes so emphasis and strikethrough
// do not see delimiters inside them. Every mask keeps the length it
// replaces, so the masked source stays aligned with the real one.
function maskInline(src, ctx) {
  let masked = src;
  if (ctx.refs && src.includes('[')) {
    const search = INL.reflinkSearch;
    const maskOne = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.refs, foldLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (hasLinkIn(text, ctx)) {
          return '[' + text.replace(search, maskOne)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  masked = masked.replace(INL.punctOutsideCode, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  masked = masked.replace(INL.skipInline, (m0, _link, context) => {
    const offset = context ? context.length : 0;
    return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
  });
  return masked;
}

function labelHoldsToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INL.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INL.tag.exec(tokenSrc) || INL.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Render a link or image label now (the label is inline-scanned while the
// outer run is still going, as marked does) and decide whether the link
// stands: a link whose label already holds a link is not a link at all.
function emitLink(cap, link, raw, ctx, mode) {
  const text = cap[1].replace(P.linkBracketEscapes, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInAnchor = ctx.inAnchor;
  const outerEmitted = ctx.emittedLink;
  const outerInPre = ctx.inPre;
  ctx.inAnchor = true;
  ctx.emittedLink = false;
  const labelHtml = inlineToStr(text, ctx, isImage ? 1 : mode);
  const labelHasLink = ctx.emittedLink;
  ctx.emittedLink = outerEmitted;
  ctx.inAnchor = outerInAnchor;
  if (!isImage) {
    if (labelHasLink) {
      ctx.inPre = outerInPre;
      return undefined;
    }
    ctx.emittedLink = true;
  }
  return { isImage, raw, href: link.href, title: link.title, labelHtml };
}

function readLink(src, ctx, mode) {
  if (ctx.parenOk === false) return undefined;
  const cap = INL.link.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHoldsToken(src, cap[1], labelStart)) return undefined;
  const trimmedUrl = cap[2].trim();
  if (P.openAngle.test(trimmedUrl)) {
    if (!P.closeAngle.test(trimmedUrl)) return undefined;
    const noSlash = stripTail(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - noSlash.length) % 2 === 0) return undefined;
  } else {
    const lastParen = closeBracket(cap[2], '()');
    if (lastParen === -2) return undefined;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer.
  const unescaped = stripTail(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (P.openAngle.test(href)) href = href.slice(1, -1);
  return emitLink(cap, {
    href: href ? href.replace(INL.anyPunct, '$1') : href,
    title: title ? title.replace(INL.anyPunct, '$1') : title,
  }, cap[0], ctx, mode);
}

// Returns a link node, or { noLink: true, ch } when the reference is not
// defined: only the opening character is consumed, as plain text.
function readRefLink(src, ctx, mode) {
  const cap = INL.reflink.exec(src) || INL.nolink.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHoldsToken(src, cap[1], labelStart)) return undefined;
  const link = ctx.refs[foldLabel(cap[2] || cap[1])];
  if (!link) return { noLink: true, ch: cap[0].charAt(0) };
  return emitLink(cap, link, cap[0], ctx, mode);
}

function readAutolink(src) {
  const cap = INL.autolink.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { raw: cap[0], href, autolink: true, labelHtml: escapeHtml(text, true), labelText: text };
}

function readBareUrl(src) {
  const cap = INL.url.exec(src);
  if (!cap) return undefined;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prev = cap[0];
    do {
      prev = cap[0];
      cap[0] = INL.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { raw: cap[0], href, autolink: true, labelHtml: escapeHtml(text, true), labelText: text };
}

// Emphasis and strong emphasis, by marked's delimiter scan: the opener's
// whole run counts (rules 9-10), a mid-run opener only pairs with a
// delimiter that can only close, and the smallest delimiter decides em
// (odd) versus strong (even).
// Build a run's masked source and closer hints on first use. Most runs
// that contain * _ ~ never reach an emphasis attempt (the characters sit
// inside code spans or links), so building eagerly wastes the scan.
function needMask(state, ctx) {
  if (!state.built) {
    state.masked = maskInline(state.runSrc, ctx);
    state.hints = findClosers(state.masked);
    state.built = true;
  }
  return state;
}

function readEmStrong(src, maskState, ctx, prevChar, mode) {
  const m = INL.emLeft.exec(src);
  if (!m) return undefined;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return undefined;
  if (!maskState) return undefined;
  const { masked, hints } = needMask(maskState, ctx);
  const delim = m[0][0];
  const midRun = prevChar === delim;
  const srcStart = masked.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const runPrev = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrev === '*' || runPrev === '_'
    || !!INL.punctAt.exec(runPrev);
  if (runStart < srcStart) prevChar = runPrev;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INL.punctAt.exec(prevChar);
  // An underscore cannot open between two alphanumerics.
  if (m[4] && prevChar.match(P.alphaNum)) return undefined;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLen = [...m[0]].length - 1;
    let rDelim;
    let rLen;
    let total = lLen;
    let midTotal = 0;
    const runLen = srcStart - runStart + lLen;
    const openerCloses = !!runPrev.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const endRe = delim === '*' ? INL.emRightAst : INL.emRightUnd;
    const lastIdx = hints.last[delim];
    const winStart = masked.length - src.length + lLen;
    if (lastIdx < winStart) return undefined;
    const win = masked.slice(-src.length + lLen);
    const lastInWin = lastIdx - winStart;
    endRe.lastIndex = 0;
    let match;
    while ((match = endRe.exec(win)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLen = [...rDelim].length;
      if (match[3] || match[4]) {
        total += rLen;
        continue;
      } else if (match[5] || match[6] || openerCloses) {
        if (midRun && (match[5] || match[6])) break;
        if (runLen % 3 && !((runLen + rLen) % 3)) {
          midTotal += rLen;
          continue;
        }
      }
      total -= rLen;
      if (total > 0) continue;
      rLen = Math.min(rLen, rLen + total + midTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      if (Math.min(lLen, rLen) % 2) {
        return { raw, kind: 'em', html: inlineToStr(raw.slice(1, -1), ctx, mode) };
      }
      return { raw, kind: 'strong', html: inlineToStr(raw.slice(2, -2), ctx, mode) };
    }
  }
  return undefined;
}

// Strikethrough, by the same delimiter scan with tildes.
function readDel(src, maskState, ctx, prevChar, mode) {
  const m = INL.delLeft.exec(src);
  if (!m) return undefined;
  if (!maskState) return undefined;
  const { masked, hints } = needMask(maskState, ctx);
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || INL.punctAt.exec(prevChar)) {
    const lLen = [...m[0]].length - 1;
    let rDelim;
    let rLen;
    let total = lLen;
    const endRe = INL.delRight;
    const lastIdx = hints.lastDel;
    const winStart = masked.length - src.length + lLen;
    if (lastIdx < winStart) return undefined;
    const win = masked.slice(-src.length + lLen);
    const lastInWin = lastIdx - winStart;
    endRe.lastIndex = 0;
    let match;
    while ((match = endRe.exec(win)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLen = [...rDelim].length;
      if (rLen !== lLen) continue;
      if (match[3] || match[4]) {
        total += rLen;
        continue;
      }
      total -= rLen;
      if (total > 0) continue;
      rLen = Math.min(rLen, rLen + total);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      return { raw, kind: 'del', html: inlineToStr(raw.slice(lLen, -lLen), ctx, mode) };
    }
  }
  return undefined;
}

// Find where a plain-text run must end: the earliest position at which
// the inline scanner could stop — a construct starter, a hard-break run,
// a www. autolink (only after whitespace or * _ ~ (), as the text rule's
// lookbehind requires), an http/https/ftp scheme, a mailto:/xmpp: after a
// non-alphanumeric, or the start of an email local part. Stopping earlier
// than the text rule would is always safe (the run is just re-entered);
// stopping later would swallow a construct, so every trigger is covered.
const TRIGGERS = /[\\<!\[`*_~]|www\.|:\/\/|mailto:|xmpp:|@| {2}\n/g;
const IS_ALNUM = /[a-zA-Z0-9]/;
const MAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const SCHEME_RUN = /[a-zA-Z0-9+.-]/;
const IS_WS = /\s/;
function findStop(src) {
  TRIGGERS.lastIndex = 0;
  let m;
  while ((m = TRIGGERS.exec(src)) !== null) {
    const t = m[0];
    const i = m.index;
    if (t === '@') {
      let s = i - 1;
      while (s >= 0 && MAIL_LOCAL.test(src[s])) s--;
      return s + 1;
    }
    if (t === 'www.') {
      if (i === 0 || src[i - 1] === '*' || src[i - 1] === '_' || src[i - 1] === '~'
        || src[i - 1] === '(' || IS_WS.test(src[i - 1])) return i;
      continue;
    }
    if (t === '://') {
      let s = i - 1;
      while (s >= 0 && SCHEME_RUN.test(src[s])) s--;
      s++;
      const scheme = src.slice(s, i).toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') return s;
      continue;
    }
    if (t === 'mailto:' || t === 'xmpp:') {
      if (i === 0) return 0;
      if (!IS_ALNUM.test(src[i - 1])) return i - 1;
      continue;
    }
    if (t === '  \n') {
      let s = i;
      while (s > 0 && src[s - 1] === ' ') s--;
      return s;
    }
    // A trigger character can sit inside an email local part (the '_' in
    // a.b-c_d@a.b): the URL rule can still match the whole address from
    // the local part's start, so if a later '@' walks back to before
    // this trigger, the run must end there instead.
    const at = src.indexOf('@', i);
    if (at !== -1) {
      let s = at - 1;
      while (s >= 0 && MAIL_LOCAL.test(src[s])) s--;
      if (s + 1 < i) return s + 1;
    }
    return i;
  }
  return src.length;
}

// Render one inline run into `out`. mode 0 renders HTML; mode 1 renders
// plain text (an image's alt text), where strong, em, links and images
// flatten to their content, code spans to their text, and breaks vanish.
function inlineLoop(out, src, maskState, ctx, mode) {
  let keepPrev = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    // Plain text up to the next construct: most of a document is prose,
    // and one scan for the next trigger is far cheaper than running the
    // full text rule (and every other inline rule) per chunk.
    const stop = findStop(src);
    if (stop > 0) {
      const chunk = src.slice(0, stop);
      src = src.substring(stop);
      if (chunk.slice(-1) !== '_') prevChar = chunk.slice(-1);
      keepPrev = true;
      const rawBlock = ctx.inPre;
      const text = rawBlock ? chunk : decodeRefs(chunk);
      out.push(mode === 1 ? text : (rawBlock ? text : escapeHtml(text)));
      continue;
    }
    let m;
    // Every inline rule is anchored on its first character, so a rule
    // whose opener cannot appear here is skipped without a regex call.
    const ch = src[0];
    // backslash escape
    if (ch === '\\' && (m = INL.escape.exec(src))) {
      src = src.substring(m[0].length);
      out.push(mode === 1 ? m[1] : escapeHtml(m[1]));
      continue;
    }
    // inline HTML tag (also tracks <a> and <pre>/<code>/<kbd>/<script>)
    if (ch === '<' && (m = INL.tag.exec(src))) {
      src = src.substring(m[0].length);
      if (!ctx.inAnchor && P.openAnchor.test(m[0])) ctx.inAnchor = true;
      else if (ctx.inAnchor && P.closeAnchor.test(m[0])) ctx.inAnchor = false;
      if (!ctx.inPre && P.openPre.test(m[0])) ctx.inPre = true;
      else if (ctx.inPre && P.closePre.test(m[0])) ctx.inPre = false;
      out.push(m[0]);
      continue;
    }
    // inline link or image
    if ((ch === '[' || ch === '!') && (m = readLink(src, ctx, mode))) {
      src = src.substring(m.raw.length);
      renderLink(out, m, mode);
      continue;
    }
    // reference link, collapsed or shortcut
    if ((ch === '[' || ch === '!') && (m = readRefLink(src, ctx, mode))) {
      if (m.noLink) {
        src = src.substring(1);
        out.push(mode === 1 ? m.ch : escapeHtml(m.ch));
      } else {
        src = src.substring(m.raw.length);
        renderLink(out, m, mode);
      }
      continue;
    }
    // emphasis / strong
    if ((ch === '*' || ch === '_') && (m = readEmStrong(src, maskState, ctx, prevChar, mode))) {
      src = src.substring(m.raw.length);
      if (mode === 1) out.push(m.html);
      else out.push(m.kind === 'em' ? '<em>' + m.html + '</em>' : '<strong>' + m.html + '</strong>');
      continue;
    }
    // code span
    if (ch === '`' && (m = INL.code.exec(src))) {
      let text = m[2].replace(P.newlineGlobal, ' ');
      const hasNonSpace = P.nonSpace.test(text);
      const hasSpaceBothEnds = P.leadingSpace.test(text) && P.trailingSpace.test(text);
      if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
      src = src.substring(m[0].length);
      out.push(mode === 1 ? text : '<code>' + escapeHtml(text, true) + '</code>');
      continue;
    }
    // hard break
    if ((ch === ' ' || ch === '\\') && (m = INL.br.exec(src))) {
      src = src.substring(m[0].length);
      if (mode === 0) out.push('<br>');
      continue;
    }
    // strikethrough
    if (ch === '~' && (m = readDel(src, maskState, ctx, prevChar, mode))) {
      src = src.substring(m.raw.length);
      if (mode === 1) out.push(m.html);
      else out.push('<del>' + m.html + '</del>');
      continue;
    }
    // autolink <...>
    if (ch === '<' && (m = readAutolink(src))) {
      src = src.substring(m.raw.length);
      renderLink(out, m, mode);
      continue;
    }
    // extended autolink (bare URL, www. or email), never inside a link
    if (!ctx.inAnchor && (m = readBareUrl(src))) {
      src = src.substring(m.raw.length);
      renderLink(out, m, mode);
      continue;
    }
    // plain text up to the next special construct
    if ((m = INL.text.exec(src))) {
      src = src.substring(m[0].length);
      if (m[0].slice(-1) !== '_') prevChar = m[0].slice(-1);
      keepPrev = true;
      const rawBlock = ctx.inPre;
      const text = rawBlock ? m[0] : decodeRefs(m[0]);
      out.push(mode === 1 ? text : (rawBlock ? text : escapeHtml(text)));
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
}

function renderLink(out, node, mode) {
  if (node.isImage) {
    if (mode === 1) {
      out.push(node.labelHtml);
      return;
    }
    const clean = cleanHref(node.href);
    if (clean === null) {
      out.push(escapeHtml(node.labelHtml));
      return;
    }
    let s = '<img src="' + escapeHtml(clean) + '" alt="' + escapeHtml(node.labelHtml) + '"';
    if (node.title) s += ' title="' + escapeHtml(node.title) + '"';
    out.push(s + '>');
    return;
  }
  if (mode === 1) {
    out.push(node.labelText !== undefined ? node.labelText : node.labelHtml);
    return;
  }
  const clean = cleanHref(node.href);
  if (clean === null) {
    out.push(node.labelHtml);
    return;
  }
  const href = escapeHtml(clean, node.autolink);
  let s = '<a href="' + href + '"';
  if (node.title) s += ' title="' + escapeHtml(node.title) + '"';
  out.push(s + '>' + node.labelHtml + '</a>');
}

// Run inline parsing over `src` into `out`. A top-level run (a block's own
// text) starts with raw-HTML escaping off; a nested run (a link label, an
// emphasis span) inherits the outer run's raw-block state.
function inlineTo(out, src, ctx, mode, topLevel) {
  if (topLevel) ctx.inPre = false;
  const maskState = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? { built: false, masked: src, hints: null, runSrc: src }
    : null;
  const prevParen = ctx.parenOk;
  ctx.parenOk = prevParen && src.includes(')');
  try {
    inlineLoop(out, src, maskState, ctx, mode);
  } finally {
    ctx.parenOk = prevParen;
  }
}

function inlineToStr(src, ctx, mode) {
  const out = [];
  inlineTo(out, src, ctx, mode, false);
  return out.join('');
}

function inlineStr(src, ctx, mode) {
  const out = [];
  inlineTo(out, src, ctx, mode, true);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function checkbox(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCell(cell, header, ctx) {
  const content = inlineStr(cell.text, ctx, 0);
  const type = header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderBlocks(nodes, out, ctx) {
  for (const n of nodes) {
    switch (n.t) {
      case 'blank':
      case 'def':
        break;
      case 'code': {
        const lang = (n.lang || '').match(P.firstWord)?.[0];
        const code = n.text ? n.text.replace(P.trailingNl, '') + '\n' : '';
        if (!lang) {
          out.push('<pre><code>' + escapeHtml(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-' + escapeHtml(lang) + '">'
            + escapeHtml(code, true) + '</code></pre>\n');
        }
        break;
      }
      case 'head':
        out.push(`<h${n.depth}>` + inlineStr(n.text, ctx, 0) + `</h${n.depth}>\n`);
        break;
      case 'rule':
        out.push('<hr>\n');
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(n.kids, out, ctx);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const type = n.ordered ? 'ol' : 'ul';
        const startAttr = (n.ordered && n.start !== 1) ? ` start="${n.start}"` : '';
        out.push('<' + type + startAttr + '>\n');
        for (const item of n.items) {
          out.push('<li>');
          if (item.checkbox !== undefined) out.push(checkbox(item.checked));
          renderBlocks(item.kids, out, ctx);
          out.push('</li>\n');
        }
        out.push('</' + type + '>\n');
        break;
      }
      case 'raw':
        out.push(n.text);
        break;
      case 'table': {
        let header = '';
        for (const cell of n.header) header += renderCell(cell, true, ctx);
        let body = '';
        for (const row of n.rows) {
          let cells = '';
          for (const cell of row) cells += renderCell(cell, false, ctx);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n');
        break;
      }
      case 'para': {
        let inner = inlineStr(n.text, ctx, 0);
        if (n.checkboxFirst !== undefined) inner = checkbox(n.checkboxFirst) + inner;
        out.push('<p>' + inner + '</p>\n');
        break;
      }
      case 'text':
        out.push(inlineStr(n.text, ctx, 0));
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(P.crlf, '\n');
  const ctx = {
    refs: Object.create(null),
    inAnchor: false,
    inPre: false,
    emittedLink: false,
    parenOk: true,
    top: true,
  };
  const nodes = [];
  scanBlocks(src, ctx, nodes, false);
  const out = [];
  renderBlocks(nodes, out, ctx);
  return out.join('');
}
