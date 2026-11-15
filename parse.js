// A fast, dependency-free Markdown parser: parse(markdown) returns exactly
// the HTML that marked 18.1.3 renders with its default options (GFM on,
// breaks off, pedantic off). Written from scratch as a direct renderer: the
// block pass builds a light node list (collecting link reference definitions
// as it goes, as marked does), and the render pass turns each node straight
// into HTML, running inline parsing on demand. No token objects are built,
// which is where most of the speed over marked comes from. The tokenization
// decisions (regexes, rule order, emphasis and strikethrough scans, link
// handling, list and blockquote continuation) follow marked's published
// behaviour so the output matches it code unit for code unit.

const CARET = /(^|[^\[])\^/g;

// Compose a regex from pieces, the way a grammar is built out of named
// sub-patterns: each replacement splices a pattern's source in, dropping any
// leading ^ anchor it carried so it reads correctly mid-pattern.
function edit(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    replace(name, val) {
      let vs = typeof val === 'string' ? val : val.source;
      vs = vs.replace(CARET, '$1');
      src = src.replace(name, vs);
      return api;
    },
    regex() {
      return new RegExp(src, flags || '');
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Small shared patterns
// ---------------------------------------------------------------------------

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
};

// Regexes parameterised by an indentation level, cached four deep.
function cachedIndent(create) {
  const cache = [];
  return (indent) => {
    const i = Math.max(0, Math.min(3, indent - 1));
    let r = cache[i];
    if (!r) {
      r = create(i);
      cache[i] = r;
    }
    return r;
  };
}
O.nextBulletRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
O.hrRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
O.fencesBeginRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
O.headingBeginRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
O.blockquoteBeginRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}>`));

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

O.htmlBeginRegex = cachedIndent((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

const B = {};
B.newline = /^(?:[ \t]*(?:\n|$))+/;
B.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
B.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
B.hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
B.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
B.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
B.blockText = /^[^\n]+/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
B.lheading = edit(LHEADING_CORE)
  .replace(/bull/g, B.bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .regex();

const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

B.def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .regex();

B.list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, B.bullet)
  .regex();

const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
B.html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', _comment)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .regex();

function createParagraph(listInterrupt) {
  return edit(_paragraph)
    .replace('hr', B.hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .regex();
}

B.paragraph = edit(_paragraph)
  .replace('hr', B.hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', edit(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
    .replace('hr', B.hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .regex())
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .regex();

B.table = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', B.hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .regex();

B.blockquoteParagraph = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
B.blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', B.blockquoteParagraph)
  .regex();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const I = {};
I.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
I.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
I.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
// GFM lets ~ inside strong and em, so it is not punctuation there.
const _punctGfm = /(?!~)[\p{P}\p{S}]/u;
const _punctSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;

const _blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .regex();
I.blockSkip = _blockSkip;

const _emLCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
I.emLDelim = edit(_emLCore, 'u').replace(/punct/g, _punctGfm).regex();

const _emRAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip an orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
I.emRAst = edit(_emRAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctSpaceGfm)
  .replace(/punctSpace/g, _punctSpaceGfm)
  .replace(/punct/g, _punctGfm)
  .regex();

I.emRUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .regex();

I.delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .regex();

I.delRDelim = edit(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .regex();

I.anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .regex();

// Backslash escapes outside code spans are masked for emphasis scanning; a
// backslash inside a code span is literal, so the span's backticks are
// masked instead and the span itself is left alone.
I.anyPunctOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .regex();

I.punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace)
  .regex();

I.autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .regex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').regex();
I.tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .regex();

const _labelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _labelBrackets)
  .regex();

I.link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .regex();

I.reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .regex();

I.nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .regex();

// The search form of reflink/nolink bounds its scan: a link label is at most
// 999 characters, and a label holds at most 999 escapes, code spans and
// nested brackets, so a candidate that can never match still cannot cost
// quadratic time over a long run of '[' characters.
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _labelBrackets)
  .regex();

I.reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .regex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .regex())
  .regex();

const _proto = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
I.url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, _extEmail).regex())
  .replace('protocol', _proto)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .regex();
I.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
I.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

I.text = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _proto)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .regex();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escHtml(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (ch) => ESCAPES[ch]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPES[ch]);
  }
  return html;
}

function decodeNumericRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(row, count) {
  const r = row.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = r.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's; /c*$/ is REDOS-vulnerable, so walk it by hand.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const curr = str.charAt(l - suffLen - 1);
    if (curr === c && !invert) suffLen++;
    else if (curr !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label folds to lower case through upper case (so ẞ meets SS),
// with leading/trailing space stripped and inner runs collapsed to one.
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes an unbalanced run of b[0], or -1 when
// balanced, -2 when more opens than closes.
function findClosingBracket(str, b) {
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
function scanClosers(src) {
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
// Block lexing. Builds a light node list; link reference definitions are
// collected into S.links as they are found, exactly as marked does, so a
// definition anywhere in the document resolves a reference anywhere else.
// Nodes carry `raw` (the source slice they consumed) for the continuation
// bookkeeping lists and blockquotes do, and `text` where they hold inline
// content. Rendering happens later, after every definition is known.
// ---------------------------------------------------------------------------

function indentCodeCompensation(raw, text) {
  const mm = raw.match(O.indentCodeCompensation);
  if (!mm) return text;
  const indentToCode = mm[1];
  return text.split('\n').map((node) => {
    const mi = node.match(O.beginningSpace);
    if (!mi) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function tokBlockquote(src, S) {
  const m = B.blockquote.exec(src);
  if (!m) return undefined;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const nodes = [];
  while (lines.length > 0) {
    let inBq = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        cur.push(lines[i]);
        inBq = true;
      } else if (!inBq) {
        cur.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const curRaw = cur.join('\n');
    const curText = curRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;
    const top = S.top;
    S.top = true;
    lexBlocks(curText, S, nodes, true);
    S.top = top;
    if (lines.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (last && (last.k === 'code' || last.k === 'h' || last.k === 'hr' || last.k === 'html' || last.k === 'table')) break;
    if (last && last.k === 'bq') {
      const old = last;
      const continuation = lines.join('\n');
      const newText = old.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const nt = tokBlockquote(newText, S);
      nodes[nodes.length - 1] = nt;
      const leftover = newText.substring(nt.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - old.text.length) + nt.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last && last.k === 'list') {
      const old = last;
      const newText = old.raw + '\n' + lines.join('\n');
      const nt = tokList(newText, S);
      nodes[nodes.length - 1] = nt;
      const consumedCount = nt.raw.length > old.raw.length
        ? newText.slice(old.raw.length + 1, nt.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { k: 'bq', raw, text, ch: nodes };
}

function tokList(src, S) {
  let cap = B.list.exec(src);
  if (!cap) return undefined;
  const listSrc = src;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    k: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (B.hr.test(src)) break;
    const itemStart = listSrc.length - src.length;
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
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
        const nextLineWithoutTabs = blank ? rawLine
          : hasTab ? expandTabs(rawLine.slice(0, i)) + rawLine.slice(i) : rawLine;
        const firstContent = blank ? -1 : col;
        if (firstContent > indent || blank) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (fencesBeginRegex.test(nextLine)) break;
          if (headingBeginRegex.test(nextLine)) break;
          if (htmlBeginRegex.test(nextLine)) break;
          if (blockquoteBeginRegex.test(nextLine)) break;
          if (nextBulletRegex.test(nextLine)) break;
          if (hrRegex.test(nextLine)) break;
          if (firstContent >= indent) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break;
            if (fencesBeginRegex.test(line)) break;
            if (headingBeginRegex.test(line)) break;
            if (htmlBeginRegex.test(line)) break;
            if (hrRegex.test(line)) break;
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && B.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
        }
        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, listSrc.length - src.length);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (O.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      raw,
      task: O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      ch: [],
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
  // First pass: tokenize items, finalize loose from blank-line spacers.
  for (const item of list.items) {
    S.top = false;
    lexBlocks(item.text, S, item.ch, false);
    if (!list.loose) {
      const spacers = item.ch.filter((t) => t.k === 'sp');
      list.loose = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
    }
  }
  // Second pass: place task checkboxes. A checkbox is rendered before the
  // item's content when the list is tight, and inside the first paragraph
  // when it is loose; the marker is stripped from the item's first text.
  for (const item of list.items) {
    const first = item.ch[0];
    if (item.task && first && (first.k === 't' || first.k === 'p')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      first.raw = first.raw.replace(O.listReplaceTask, '');
      first.text = first.text.replace(O.listReplaceTask, '');
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
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
      for (const t of item.ch) if (t.k === 't') t.k = 'p';
    }
  }
  return list;
}

// A setext heading needs an underline line (only = or -, after at most
// 3 spaces) before the next blank line — the heading text cannot cross
// one. If no such line exists in this paragraph, the setext rule cannot
// match, so the (expensive, backtracking) rule is skipped.
function hasSetextUnderline(src) {
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

function lexBlocks(src, S, nodes, lastClip) {
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
      && (m = B.newline.exec(src)) && m[0].length > 0) {
      const raw = m[0];
      src = src.substring(raw.length);
      const last = nodes[nodes.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else nodes.push({ k: 'sp', raw });
      continue;
    }
    // indented code (cannot interrupt a paragraph: it joins it instead)
    if (canCode && (m = B.code.exec(src))) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(O.codeRemoveIndent, '');
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && (last.k === 'p' || last.k === 't')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
      } else {
        nodes.push({ k: 'code', raw, text });
      }
      continue;
    }
    // fenced code
    if (lead < 4 && (f === '`' || f === '~') && (m = B.fences.exec(src))) {
      const raw = m[0];
      const text = indentCodeCompensation(raw, m[3] || '');
      src = src.substring(raw.length);
      nodes.push({
        k: 'code',
        raw,
        text,
        lang: m[2] ? m[2].trim().replace(I.anyPunctuation, '$1') : m[2],
      });
      continue;
    }
    // ATX heading
    if (lead < 4 && f === '#' && (m = B.heading.exec(src))) {
      let text = m[2].trim();
      if (O.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      src = src.substring(m[0].length);
      nodes.push({ k: 'h', raw: rtrim(m[0], '\n'), depth: m[1].length, text });
      continue;
    }
    // thematic break
    if (lead < 4 && (f === '-' || f === '_' || f === '*') && (m = B.hr.exec(src))) {
      src = src.substring(m[0].length);
      nodes.push({ k: 'hr', raw: rtrim(m[0], '\n') });
      continue;
    }
    // blockquote
    if (lead < 4 && f === '>' && (m = tokBlockquote(src, S))) {
      src = src.substring(m.raw.length);
      nodes.push(m);
      continue;
    }
    // list
    if (lead < 4 && (f === '-' || f === '+' || f === '*' || (f >= '0' && f <= '9'))
      && (m = tokList(src, S))) {
      src = src.substring(m.raw.length);
      nodes.push(m);
      continue;
    }
    // raw HTML block
    if (lead < 4 && f === '<' && (m = B.html.exec(src))) {
      const raw = trimTrailingBlankLines(m[0]);
      src = src.substring(m[0].length);
      nodes.push({
        k: 'html',
        raw,
        text: raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      });
      continue;
    }
    // link reference definition (first one wins; one after a paragraph
    // without a blank line is paragraph text, not a definition)
    if (lead < 4 && f === '[' && (m = B.def.exec(src))) {
      if (O.startAngleBracket.test(m[2]) || findClosingBracket(m[2], '()') === -1) {
        const tag = normalizeLabel(m[1]);
        const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '';
        const title = m[3]
          ? m[3].substring(1, m[3].length - 1).replace(I.anyPunctuation, '$1')
          : m[3];
        const raw = rtrim(m[0], '\n');
        src = src.substring(m[0].length);
        const last = nodes[nodes.length - 1];
        if (last && (last.k === 'p' || last.k === 't')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
        } else {
          if (!S.links[tag]) S.links[tag] = { href, title };
          nodes.push({ k: 'def', raw });
        }
        continue;
      }
    }
    // table
    if ((m = B.table.exec(src))) {
      if (O.tableDelimiter.test(m[2])) {
        const headers = splitCells(m[1]);
        const aligns = m[2].replace(O.tableAlignChars, '').split('|');
        const rows = m[3] && m[3].trim()
          ? m[3].replace(O.tableRowBlankLine, '').split('\n')
          : [];
        if (headers.length === aligns.length) {
          const align = aligns.map((a) => O.tableAlignRight.test(a) ? 'right'
            : O.tableAlignCenter.test(a) ? 'center'
            : O.tableAlignLeft.test(a) ? 'left' : null);
          src = src.substring(m[0].length);
          nodes.push({
            k: 'table',
            raw: rtrim(m[0], '\n'),
            header: headers.map((h, i) => ({ text: h, align: align[i] })),
            rows: rows.map((r) => splitCells(r, headers.length)
              .map((c, i) => ({ text: c, align: align[i] }))),
          });
          continue;
        }
      }
    }
    // setext heading
    if (hasSetextUnderline(src) && (m = B.lheading.exec(src))) {
      src = src.substring(m[0].length);
      nodes.push({
        k: 'h',
        raw: rtrim(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text: m[1].trim(),
      });
      continue;
    }
    // paragraph (top level only; inside list items it is plain text)
    if (S.top && (m = B.paragraph.exec(src))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (clip && last && last.k === 'p') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + text;
      } else {
        nodes.push({ k: 'p', raw: m[0], text });
      }
      clip = false;
      continue;
    }
    // plain text line(s)
    if ((m = B.blockText.exec(src))) {
      src = src.substring(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && last.k === 't') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
      } else {
        nodes.push({ k: 't', raw: m[0], text: m[0] });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  S.top = true;
}

// ---------------------------------------------------------------------------
// Inline rendering. Each inline run scans its source once for the last
// closable emphasis / strikethrough delimiter, masks links, code spans,
// HTML and escapes out of the emphasis scanner's view (keeping every
// length, so the masked source stays aligned with the real one), then
// walks the source left to right in marked's token order.
// ---------------------------------------------------------------------------

function linkInText(text, S) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(I.blockSkip)) {
    if (I.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(I.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!'
      || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), S)) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, HTML and escapes so emphasis and strikethrough
// do not see delimiters inside them. Every mask keeps the length it
// replaces, so the masked source stays aligned with the real one.
function maskSrc(src, S) {
  let masked = src;
  if (S.links && src.includes('[')) {
    const search = I.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, S)) {
          return '[' + text.replace(search, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(search, maskReflink);
  }
  masked = masked.replace(I.anyPunctOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  masked = masked.replace(I.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return masked;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = I.tag.exec(tokenSrc) || I.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Render a link or image label now (the label is inline-scanned while the
// outer run is still going, as marked does) and decide whether the link
// stands: a link whose label already holds a link is not a link at all.
function outputLink(cap, link, raw, S, mode) {
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const labelHtml = inlineToStr(text, S, isImage ? 1 : mode);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      S.inRawBlock = outerInRawBlock;
      return undefined;
    }
    S.linkEmitted = true;
  }
  return { isImage, raw, href: link.href, title: link.title, labelHtml };
}

function tokLink(src, S, mode) {
  if (S.linkParenPossible === false) return undefined;
  const cap = I.link.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) return undefined;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return undefined;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(I.anyPunctuation, '$1') : href,
    title: title ? title.replace(I.anyPunctuation, '$1') : title,
  }, cap[0], S, mode);
}

// Returns a link node, or { noLink: true, ch } when the reference is not
// defined: only the opening character is consumed, as plain text.
function tokReflink(src, S, mode) {
  const cap = I.reflink.exec(src) || I.nolink.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return { noLink: true, ch: cap[0].charAt(0) };
  return outputLink(cap, link, cap[0], S, mode);
}

function tokAutolink(src) {
  const cap = I.autolink.exec(src);
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
  return { raw: cap[0], href, autolink: true, labelHtml: escHtml(text, true), labelText: text };
}

function tokUrl(src) {
  const cap = I.url.exec(src);
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
      cap[0] = I.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { raw: cap[0], href, autolink: true, labelHtml: escHtml(text, true), labelText: text };
}

// Emphasis and strong emphasis, by marked's delimiter scan: the opener's
// whole run counts (rules 9-10), a mid-run opener only pairs with a
// delimiter that can only close, and the smallest delimiter decides em
// (odd) versus strong (even).
// Build a run's masked source and closer hints on first use. Most runs
// that contain * _ ~ never reach an emphasis attempt (the characters sit
// inside code spans or links), so building eagerly wastes the scan.
function ensureMask(state, S) {
  if (!state.built) {
    state.masked = maskSrc(state.runSrc, S);
    state.hints = scanClosers(state.masked);
    state.built = true;
  }
  return state;
}

function tokEmStrong(src, maskState, S, prevChar, mode) {
  const m = I.emLDelim.exec(src);
  if (!m) return undefined;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return undefined;
  if (!maskState) return undefined;
  const { masked, hints } = ensureMask(maskState, S);
  const delimChar = m[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = masked.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I.punctuation.exec(prevChar);
  // An underscore cannot open between two alphanumerics.
  if (m[4] && prevChar.match(O.unicodeAlphaNumeric)) return undefined;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? I.emRAst : I.emRUnd;
    const lastIdx = hints.last[delimChar];
    const windowStart = masked.length - src.length + lLength;
    if (lastIdx < windowStart) return undefined;
    const win = masked.slice(-src.length + lLength);
    const lastInWin = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(win)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        return { raw, kind: 'em', html: inlineToStr(raw.slice(1, -1), S, mode) };
      }
      return { raw, kind: 'strong', html: inlineToStr(raw.slice(2, -2), S, mode) };
    }
  }
  return undefined;
}

// Strikethrough, by the same delimiter scan with tildes.
function tokDel(src, maskState, S, prevChar, mode) {
  const m = I.delLDelim.exec(src);
  if (!m) return undefined;
  if (!maskState) return undefined;
  const { masked, hints } = ensureMask(maskState, S);
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar)) {
    const lLength = [...m[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const endReg = I.delRDelim;
    const lastIdx = hints.lastDel;
    const windowStart = masked.length - src.length + lLength;
    if (lastIdx < windowStart) return undefined;
    const win = masked.slice(-src.length + lLength);
    const lastInWin = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(win)) !== null) {
      if (match.index > lastInWin) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      return { raw, kind: 'del', html: inlineToStr(raw.slice(lLength, -lLength), S, mode) };
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
const TRIG = /[\\<!\[`*_~]|www\.|:\/\/|mailto:|xmpp:|@| {2}\n/g;
const ALNUM_CH = /[a-zA-Z0-9]/;
const EMAIL_LOCAL_CH = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const SCHEME_CH = /[a-zA-Z0-9+.-]/;
const WS_CH = /\s/;
function nextStop(src) {
  TRIG.lastIndex = 0;
  let m;
  while ((m = TRIG.exec(src)) !== null) {
    const t = m[0];
    const i = m.index;
    if (t === '@') {
      let s = i - 1;
      while (s >= 0 && EMAIL_LOCAL_CH.test(src[s])) s--;
      return s + 1;
    }
    if (t === 'www.') {
      if (i === 0 || src[i - 1] === '*' || src[i - 1] === '_' || src[i - 1] === '~'
        || src[i - 1] === '(' || WS_CH.test(src[i - 1])) return i;
      continue;
    }
    if (t === '://') {
      let s = i - 1;
      while (s >= 0 && SCHEME_CH.test(src[s])) s--;
      s++;
      const scheme = src.slice(s, i).toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') return s;
      continue;
    }
    if (t === 'mailto:' || t === 'xmpp:') {
      if (i === 0) return 0;
      if (!ALNUM_CH.test(src[i - 1])) return i - 1;
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
      while (s >= 0 && EMAIL_LOCAL_CH.test(src[s])) s--;
      if (s + 1 < i) return s + 1;
    }
    return i;
  }
  return src.length;
}

// Render one inline run into `out`. mode 0 renders HTML; mode 1 renders
// plain text (an image's alt text), where strong, em, links and images
// flatten to their content, code spans to their text, and breaks vanish.
function inlineLoop(out, src, maskState, S, mode) {
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
    const stop = nextStop(src);
    if (stop > 0) {
      const chunk = src.slice(0, stop);
      src = src.substring(stop);
      if (chunk.slice(-1) !== '_') prevChar = chunk.slice(-1);
      keepPrev = true;
      const escaped = S.inRawBlock;
      const text = escaped ? chunk : decodeNumericRefs(chunk);
      out.push(mode === 1 ? text : (escaped ? text : escHtml(text)));
      continue;
    }
    let m;
    // Every inline rule is anchored on its first character, so a rule
    // whose opener cannot appear here is skipped without a regex call.
    const ch = src[0];
    // backslash escape
    if (ch === '\\' && (m = I.escape.exec(src))) {
      src = src.substring(m[0].length);
      out.push(mode === 1 ? m[1] : escHtml(m[1]));
      continue;
    }
    // inline HTML tag (also tracks <a> and <pre>/<code>/<kbd>/<script>)
    if (ch === '<' && (m = I.tag.exec(src))) {
      src = src.substring(m[0].length);
      if (!S.inLink && O.startATag.test(m[0])) S.inLink = true;
      else if (S.inLink && O.endATag.test(m[0])) S.inLink = false;
      if (!S.inRawBlock && O.startPreScriptTag.test(m[0])) S.inRawBlock = true;
      else if (S.inRawBlock && O.endPreScriptTag.test(m[0])) S.inRawBlock = false;
      out.push(m[0]);
      continue;
    }
    // inline link or image
    if ((ch === '[' || ch === '!') && (m = tokLink(src, S, mode))) {
      src = src.substring(m.raw.length);
      renderLinkNode(out, m, mode);
      continue;
    }
    // reference link, collapsed or shortcut
    if ((ch === '[' || ch === '!') && (m = tokReflink(src, S, mode))) {
      if (m.noLink) {
        src = src.substring(1);
        out.push(mode === 1 ? m.ch : escHtml(m.ch));
      } else {
        src = src.substring(m.raw.length);
        renderLinkNode(out, m, mode);
      }
      continue;
    }
    // emphasis / strong
    if ((ch === '*' || ch === '_') && (m = tokEmStrong(src, maskState, S, prevChar, mode))) {
      src = src.substring(m.raw.length);
      if (mode === 1) out.push(m.html);
      else out.push(m.kind === 'em' ? '<em>' + m.html + '</em>' : '<strong>' + m.html + '</strong>');
      continue;
    }
    // code span
    if (ch === '`' && (m = I.code.exec(src))) {
      let text = m[2].replace(O.newLineCharGlobal, ' ');
      const hasNonSpace = O.nonSpaceChar.test(text);
      const hasSpaceBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
      if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
      src = src.substring(m[0].length);
      out.push(mode === 1 ? text : '<code>' + escHtml(text, true) + '</code>');
      continue;
    }
    // hard break
    if ((ch === ' ' || ch === '\\') && (m = I.br.exec(src))) {
      src = src.substring(m[0].length);
      if (mode === 0) out.push('<br>');
      continue;
    }
    // strikethrough
    if (ch === '~' && (m = tokDel(src, maskState, S, prevChar, mode))) {
      src = src.substring(m.raw.length);
      if (mode === 1) out.push(m.html);
      else out.push('<del>' + m.html + '</del>');
      continue;
    }
    // autolink <...>
    if (ch === '<' && (m = tokAutolink(src))) {
      src = src.substring(m.raw.length);
      renderLinkNode(out, m, mode);
      continue;
    }
    // extended autolink (bare URL, www. or email), never inside a link
    if (!S.inLink && (m = tokUrl(src))) {
      src = src.substring(m.raw.length);
      renderLinkNode(out, m, mode);
      continue;
    }
    // plain text up to the next special construct
    if ((m = I.text.exec(src))) {
      src = src.substring(m[0].length);
      if (m[0].slice(-1) !== '_') prevChar = m[0].slice(-1);
      keepPrev = true;
      const escaped = S.inRawBlock;
      const text = escaped ? m[0] : decodeNumericRefs(m[0]);
      out.push(mode === 1 ? text : (escaped ? text : escHtml(text)));
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
}

function renderLinkNode(out, node, mode) {
  if (node.isImage) {
    if (mode === 1) {
      out.push(node.labelHtml);
      return;
    }
    const clean = cleanUrl(node.href);
    if (clean === null) {
      out.push(escHtml(node.labelHtml));
      return;
    }
    let s = '<img src="' + escHtml(clean) + '" alt="' + escHtml(node.labelHtml) + '"';
    if (node.title) s += ' title="' + escHtml(node.title) + '"';
    out.push(s + '>');
    return;
  }
  if (mode === 1) {
    out.push(node.labelText !== undefined ? node.labelText : node.labelHtml);
    return;
  }
  const clean = cleanUrl(node.href);
  if (clean === null) {
    out.push(node.labelHtml);
    return;
  }
  const href = escHtml(clean, node.autolink);
  let s = '<a href="' + href + '"';
  if (node.title) s += ' title="' + escHtml(node.title) + '"';
  out.push(s + '>' + node.labelHtml + '</a>');
}

// Run inline parsing over `src` into `out`. A top-level run (a block's own
// text) starts with raw-HTML escaping off; a nested run (a link label, an
// emphasis span) inherits the outer run's raw-block state.
function inlineTo(out, src, S, mode, topLevel) {
  if (topLevel) S.inRawBlock = false;
  const maskState = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? { built: false, masked: src, hints: null, runSrc: src }
    : null;
  const prevLinkParen = S.linkParenPossible;
  S.linkParenPossible = prevLinkParen && src.includes(')');
  try {
    inlineLoop(out, src, maskState, S, mode);
  } finally {
    S.linkParenPossible = prevLinkParen;
  }
}

function inlineToStr(src, S, mode) {
  const out = [];
  inlineTo(out, src, S, mode, false);
  return out.join('');
}

function inlineStr(src, S, mode) {
  const out = [];
  inlineTo(out, src, S, mode, true);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function tableCell(cell, header, S) {
  const content = inlineStr(cell.text, S, 0);
  const type = header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderBlocks(nodes, out, S) {
  for (const n of nodes) {
    switch (n.k) {
      case 'sp':
      case 'def':
        break;
      case 'code': {
        const lang = (n.lang || '').match(O.notSpaceStart)?.[0];
        const code = n.text ? n.text.replace(O.endingNewline, '') + '\n' : '';
        if (!lang) {
          out.push('<pre><code>' + escHtml(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-' + escHtml(lang) + '">'
            + escHtml(code, true) + '</code></pre>\n');
        }
        break;
      }
      case 'h':
        out.push(`<h${n.depth}>` + inlineStr(n.text, S, 0) + `</h${n.depth}>\n`);
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'bq':
        out.push('<blockquote>\n');
        renderBlocks(n.ch, out, S);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const type = n.ordered ? 'ol' : 'ul';
        const startAttr = (n.ordered && n.start !== 1) ? ` start="${n.start}"` : '';
        out.push('<' + type + startAttr + '>\n');
        for (const item of n.items) {
          out.push('<li>');
          if (item.checkbox !== undefined) out.push(checkboxHtml(item.checked));
          renderBlocks(item.ch, out, S);
          out.push('</li>\n');
        }
        out.push('</' + type + '>\n');
        break;
      }
      case 'html':
        out.push(n.text);
        break;
      case 'table': {
        let header = '';
        for (const cell of n.header) header += tableCell(cell, true, S);
        let body = '';
        for (const row of n.rows) {
          let cells = '';
          for (const cell of row) cells += tableCell(cell, false, S);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n');
        break;
      }
      case 'p': {
        let inner = inlineStr(n.text, S, 0);
        if (n.checkboxFirst !== undefined) inner = checkboxHtml(n.checkboxFirst) + inner;
        out.push('<p>' + inner + '</p>\n');
        break;
      }
      case 't':
        out.push(inlineStr(n.text, S, 0));
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(O.carriageReturn, '\n');
  const S = {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const nodes = [];
  lexBlocks(src, S, nodes, false);
  const out = [];
  renderBlocks(nodes, out, S);
  return out.join('');
}
