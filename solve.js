// A fast drop-in replacement for the makefun-site 1.0.0 static site generator.
//
// run(input) takes one site ({ site, templates, files }) and returns its whole
// output tree as an object of path -> file text, exactly the tree the reference
// generator produces for the same input. The dialect is makefun-site's own:
// its front matter, its Markdown subset, its template language and its slug
// rule, all reimplemented here from the documented behaviour with speed as the
// design goal: single-pass scanners instead of regex splitting, per-build
// memoisation of slugs, and as little intermediate allocation as the hot loops
// allow. Nothing is kept between calls, so two runs never see each other.

// ---------------------------------------------------------------------------
// Small character helpers. The dialect's whitespace, where it is not plain
// JavaScript whitespace, is the space and the tab and nothing else.
// ---------------------------------------------------------------------------

const isBlankChar = (code) => code === 32 || code === 9;

/** True when every character of `line` is a space or a tab (or there are none). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) if (!isBlankChar(line.charCodeAt(i))) return false;
  return true;
}

/** `line` with the spaces and tabs at both ends dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isBlankChar(line.charCodeAt(a))) a++;
  while (b > a && isBlankChar(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** JavaScript's own whitespace test for one UTF-16 code unit (the \s class). */
function isSpaceCode(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}

/** Code-unit order, the only order the build ever sorts by. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// HTML escaping: & < > " ' become entities, everything else is itself.
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    let rep = null;
    switch (text.charCodeAt(i)) {
      case 38: rep = '&amp;'; break;
      case 60: rep = '&lt;'; break;
      case 62: rep = '&gt;'; break;
      case 34: rep = '&quot;'; break;
      case 39: rep = '&#39;'; break;
      default: continue;
    }
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Slugs and dates.
// ---------------------------------------------------------------------------

const SLUG_LIMIT = 64;
const MARK_RUN = /\p{M}/gu;

/**
 * The slug of a piece of text: decomposed (NFKD), its combining marks gone,
 * capitals lowered, every run of characters outside a-z and 0-9 folded to one
 * dash, no dash at either end, at most 64 characters (a dash left dangling by
 * the cut is dropped), and "untitled" when nothing survives.
 */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(MARK_RUN, '');
  let out = '';
  let gap = false;
  // After decomposition and mark-stripping, anything that can be kept is
  // plain ASCII, so walking code units and treating the rest as gap fodder
  // gives the same result as walking code points.
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 97 && code <= 122) keep = code;
    else if (code >= 48 && code <= 57) keep = code;
    else if (code >= 65 && code <= 90) keep = code + 32;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_LIMIT) out = out.slice(0, SLUG_LIMIT);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** The first of base, base-2, base-3, ... not in `taken`; the winner joins `taken`. */
function uniqueSlug(base, taken) {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date written out: "2026-11-09" becomes "9 November 2026". */
function longDate(date) {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return `${day} ${MONTH_NAMES[month - 1]} ${date.slice(0, 4)}`;
}

/** How many words a body holds: runs of characters other than whitespace. */
function countWords(text) {
  let words = 0;
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceCode(text.charCodeAt(i))) inside = false;
    else if (!inside) {
      inside = true;
      words++;
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// Front matter. A source opens on a line "---" and its front matter runs to
// the next such line. Between them every line is blank, a comment, or
// "key: value" for one of the seven known keys, each with its own grammar.
// The first fault met refuses the source with its reason.
// ---------------------------------------------------------------------------

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Days in month `m` (1-12) of year `y`, by the Gregorian rule. */
function monthDays(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * A string value: either double-quoted, where \" and \\ are the only escapes
 * and no other quote may appear inside, or bare — the rest of the line, which
 * may not open on a quote (handled by the first branch) or on "[".
 */
function readString(raw) {
  if (raw.charCodeAt(0) === 34) {
    // opens on a quote
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value read from its raw text, or the reason it is refused. */
function readValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = readString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (!DATE_SHAPE.test(raw)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length > 64) return { error: 'key "slug": not a slug' };
      // a-z and 0-9 in runs joined by single dashes, no dash at either end
      let ok = raw.length > 0;
      let prevDash = true; // the start behaves like a dash: a leading dash fails
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false; // a trailing dash fails too
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Splits a source (line ends already normalised) into { data, body }, or
 * { error } with the first reason the source is refused.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };

  // Find the closing line before judging any line: an unclosed block reports
  // exactly that, whatever its lines hold.
  const fmLines = [];
  let pos = firstNl + 1;
  let lineNo = 1;
  let bodyStart = -1;
  for (;;) {
    lineNo++;
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push([lineNo, line]);
    if (e === -1) break;
    pos = e + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  for (const [no, line] of fmLines) {
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // blank, or a comment
    // "key: value": a key of a-z and "_", a colon, then a space and the value
    // (or the line ends at the colon).
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    let raw = null;
    if (j > 0 && line.charCodeAt(j) === 58) {
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) {
        raw = line.slice(j + 2);
        let end = raw.length;
        while (end > 0 && isBlankChar(raw.charCodeAt(end - 1))) end--;
        if (end !== raw.length) raw = raw.slice(0, end);
      }
    }
    if (raw === null) return { error: `line ${no} is not "key: value"` };
    const key = line.slice(0, j);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = readValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------------------
// Markdown, the house subset. The body is read line by line; a block starts
// at each line that is not blank. Inline markup is scanned left to right.
// ---------------------------------------------------------------------------

/** The fence a line opens, as its language ("" for none), or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    if (!isBlankChar(line.charCodeAt(j))) return null;
    j++;
  }
  return lang;
}

/** Whether a line closes a fence: three backticks, then blanks only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) if (!isBlankChar(line.charCodeAt(j))) return false;
  return true;
}

/** A heading line read as { depth, text }, or null when it is not one. */
function headingOf(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (!isBlankChar(line.charCodeAt(n))) return null;
  let j = n;
  while (j < line.length && isBlankChar(line.charCodeAt(j))) j++;
  let end = line.length;
  while (end > j && isBlankChar(line.charCodeAt(end - 1))) end--;
  const text = line.slice(j, end);
  return text === '' ? null : { depth: n, text };
}

/** Whether a line is a thematic break: --- or ***, then blanks only. */
function isBreak(line) {
  let end = line.length;
  while (end > 0 && isBlankChar(line.charCodeAt(end - 1))) end--;
  if (end !== 3) return false;
  const a = line.charCodeAt(0);
  return a === line.charCodeAt(1) && a === line.charCodeAt(2) && (a === 45 || a === 42);
}

/** A bullet item's text, or null: "- " or "* ", then the rest of the line. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item read as { num, text }, or null: 1-9 digits, ". ", the rest. */
function orderedText(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinuation(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isSpaceCode(line.charCodeAt(j));
}

/** Whether a line is a heading, without building the heading (hot path). */
function isHeadingLine(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return false;
  if (!isBlankChar(line.charCodeAt(n))) return false;
  // there must be some non-blank text after the blanks
  for (let j = n; j < line.length; j++) if (!isBlankChar(line.charCodeAt(j))) return true;
  return false;
}

/** Whether a line ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || isHeadingLine(line) || isBreak(line);
}

// The characters a backslash takes literally, by code unit.
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** The first place from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` — one whose neighbour is not another * — or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// What a character means to the inline scanner, by code unit: 0 plain text,
// 1 backslash, 2 backtick, 3 star, 4 "[", 5 an HTML special. Anything at or
// past 128 is plain.
const INLINE_ACTION = new Uint8Array(128);
INLINE_ACTION[92] = 1;
INLINE_ACTION[96] = 2;
INLINE_ACTION[42] = 3;
INLINE_ACTION[91] = 4;
INLINE_ACTION[38] = 5;
INLINE_ACTION[60] = 5;
INLINE_ACTION[62] = 5;
INLINE_ACTION[34] = 5;
INLINE_ACTION[39] = 5;

/**
 * Text rendered inline. `link(target)` resolves a link target to its href.
 * Plain runs are copied in slices; only the construct characters and the
 * HTML specials interrupt a run.
 */
function renderInline(s, link) {
  const parts = [];
  let i = 0;
  let runStart = 0;
  const flush = (upto) => {
    if (upto > runStart) parts.push(s.slice(runStart, upto));
  };
  while (i < s.length) {
    const code = s.charCodeAt(i);
    const action = code < 128 ? INLINE_ACTION[code] : 0;
    if (action === 0) {
      i++;
      continue;
    }
    if (action === 1 && i + 1 < s.length && ESCAPABLE[s.charCodeAt(i + 1)]) {
      flush(i);
      parts.push(escapeHtml(s[i + 1]));
      i += 2;
      runStart = i;
      continue;
    }
    if (action === 2) {
      // a backtick: a code span, closed by the next backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (action === 3) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          parts.push('<strong>', renderInline(s.slice(i + 2, j), link), '</strong>');
          i = j + 2;
          runStart = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          flush(i);
          parts.push('<em>', renderInline(s.slice(i + 1, j), link), '</em>');
          i = j + 1;
          runStart = i;
        } else i++;
      }
      continue;
    }
    if (action === 4) {
      // "[": a link, when "](" follows the text and the target reads clean
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWhitespace(target)) {
        flush(i);
        parts.push('<a href="', escapeHtml(link(target)), '">', renderInline(s.slice(i + 1, k), link), '</a>');
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (action === 5) {
      flush(i);
      parts.push(escapeHtml(s[i]));
      i++;
      runStart = i;
      continue;
    }
    i++; // a backslash that escapes nothing is itself plain text
  }
  flush(s.length);
  return parts.join('');
}

/** Whether a link target holds any whitespace (which disqualifies it). */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * A body rendered: its HTML (each block followed by a newline), its table of
 * contents (the level 2 and 3 headings: level, id and inline HTML) and its
 * excerpt (the first paragraph's inline HTML, or ""). `env.link` resolves a
 * link target and `env.slug` slugifies (memoised per build by the caller).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < lines.length && !isFenceClose(lines[i])) body.push(escapeHtml(lines[i++]) + '\n');
      i++; // the closing line, or one past the end when there is none
      out.push('<pre><code', lang === '' ? '' : ` class="language-${lang}"`, '>', body.join(''), '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(env.slug(heading.text), ids);
      const html = renderInline(heading.text, env.link);
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // a blockquote: ">" lines, the ">" and one space after it dropped
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i++];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const trimmed = trimLine(stripped);
        if (trimmed !== '') kept.push(trimmed);
      }
      out.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${renderInline(kept.join('\n'), env.link)}</p>\n</blockquote>\n`,
      );
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const text = isOrdered ? orderedText(lines[i])?.text : bulletText(lines[i]);
        if (text !== undefined && text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      out.push(open, '\n');
      for (const parts of items) out.push('<li>', renderInline(parts.join('\n'), env.link), '</li>\n');
      out.push(`</${tag}>\n`);
      continue;
    }
    const para = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) para.push(trimLine(lines[i++]));
    const html = renderInline(para.join('\n'), env.link);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Templates, the house dialect:
//   {{ path }}      the value at path, HTML-escaped
//   {{{ path }}}    the value at path, raw
//   {% for x in path %} ... {% endfor %}
//   {% if path %} / {% if not path %} ... {% else %} ... {% endif %}
//   {% include "name" %}
// A {% %} tag alone on its line takes the whole line, newline included.
// A template that does not parse is reported and left out of the build.
// ---------------------------------------------------------------------------

/** How deep includes may nest; one past it renders nothing. */
const INCLUDE_LIMIT = 8;

/** A template that does not parse; the message is the report line. */
class TemplateFault extends Error {}

/** A path segment's first character: a letter or an underscore. */
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
/** A path segment's later characters: letters, digits, underscores. */
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57);

/** Whether `text` is a whole path: names joined by dots, each as above. */
function isPath(text) {
  if (text === '') return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (segStart) return false; // a dot with no name before it
      segStart = true;
    } else if (segStart ? !isNameStart(c) : !isNameChar(c)) return false;
    else segStart = false;
  }
  return !segStart; // may not end on a dot
}

/** The path `text` names, split at its dots, or a TemplateFault. */
function readPath(name, text) {
  if (!isPath(text)) throw new TemplateFault(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `text` holds any whitespace (the tag grammars forbid it in paths). */
function hasSpace(text) {
  for (let i = 0; i < text.length; i++) if (isSpaceCode(text.charCodeAt(i))) return true;
  return false;
}

/**
 * A template source split into tokens: text runs, {{ }} and {{{ }}} values
 * and {% %} tags, a standalone tag's line taken with it.
 */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateFault(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: readPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateFault(`template "${name}": a {% is not closed`);
    const end = close + 2;
    // A tag alone on its line (only blanks beside it) takes the line too.
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open && standalone; k++) standalone = isBlankChar(src.charCodeAt(k));
    for (let k = end; k < lineEnd && standalone; k++) standalone = isBlankChar(src.charCodeAt(k));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A "for x in path" tag read as { name, pathText }, or null when it is not one. */
function readFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let j = 4;
  if (!isNameStart(tag.charCodeAt(j))) return null;
  j++;
  while (j < tag.length && isNameChar(tag.charCodeAt(j))) j++;
  const name = tag.slice(4, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const pathText = tag.slice(j + 4);
  if (pathText === '' || hasSpace(pathText)) return null;
  return { name, pathText };
}

/** An "if [not] path" tag read as { not, pathText }, or null when it is not one. */
function readIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    const after = rest.slice(4);
    if (after !== '' && !hasSpace(after)) {
      not = true;
      rest = after;
    }
  }
  if (rest === '' || hasSpace(rest)) return null;
  return { not, pathText: rest };
}

/** An 'include "name"' tag's name, or null when it is not one. */
function readInclude(tag) {
  if (!tag.startsWith('include "') || tag.charCodeAt(tag.length - 1) !== 34) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

/** A template parsed into its node tree, or a TemplateFault. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    const forTag = readFor(tag);
    if (forTag !== null) {
      const node = { kind: 'for', name: forTag.name, path: readPath(name, forTag.pathText), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    const ifTag = readIf(tag);
    if (ifTag !== null) {
      const node = { kind: 'if', not: ifTag.not, path: readPath(name, ifTag.pathText), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateFault(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateFault(`template "${name}": an ${tag} with no open ${want}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      continue;
    }
    const include = readInclude(tag);
    if (include !== null) {
      body.push({ kind: 'include', name: include });
      continue;
    }
    throw new TemplateFault(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateFault(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`: its first name from the nearest scope holding it, then own properties down. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

/** Whether a value counts as true: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Nodes rendered into `buf` (an array of string pieces) in `scope`. */
function renderInto(nodes, scope, templates, depth, buf) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        buf.push(n.text);
        break;
      case 'var':
        buf.push(escapeHtml(valueText(lookupPath(scope, n.path))));
        break;
      case 'raw':
        buf.push(valueText(lookupPath(scope, n.path)));
        break;
      case 'if': {
        const branch = isTruthy(lookupPath(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, templates, depth, buf);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len },
          };
          renderInto(n.body, { vars, parent: scope }, templates, depth, buf);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_LIMIT) renderInto(t, scope, templates, depth + 1, buf);
        break;
      }
    }
  }
}

/** A parsed template rendered to its string in a fresh top-level scope. */
function renderTemplate(nodes, vars, templates) {
  const buf = [];
  renderInto(nodes, { vars, parent: null }, templates, 0, buf);
  return buf.join('');
}

// ---------------------------------------------------------------------------
// The build itself, as one pass of stages over the site's sources.
// ---------------------------------------------------------------------------

/** The top-level directories the generator writes itself. */
const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** The directory of a path: everything before its last "/", or "". */
const dirOf = (path) => {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
};

/**
 * A link's path resolved from a source's directory: "." and ".." steps
 * walked, empty steps skipped, and null when it climbs above the root.
 */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateFault)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Slugs repeat constantly across a site (tag names, headings, respelled
  // titles), so memoise them for the length of this one build.
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };

  // The sources, in code-unit order of their paths; a ".md" file is a source
  // (its line ends made "\n"), anything else is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in the reference's order; the first failure is
  // the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source
  // order; at the root the generator's own directory names are taken.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    let set = takenByDir.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved against the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link, slug: slugOf });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, equal dates by slug; each post's newer
  // and older neighbours in that order.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, each named as first met walking the posts in
  // collection order, ordered by their count of posts then by slug. A page's
  // tags link to the tag of the same slug, or to "" where no post has it.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(([name, slug]) => tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tagList = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates see.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  // A source's card is asked for several times (its own page, the index
  // pages, its tag pages, the recent list); build it once and share it —
  // the word count alone walks the whole body.
  const cardFor = (s) => {
    if (s.card === undefined) s.card = cardOf(s);
    return s.card;
  };
  const cards = new Map(posts.map((p) => [p, cardFor(p)]));
  const pageOf = (s) => ({
    ...cardFor(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderTemplate(nodes, { site, tags: allTags, recent, ...vars }, templates);
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', { tag });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported along the way and each broken link,
  // sorted, then the counts.
  const pageTotal = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
