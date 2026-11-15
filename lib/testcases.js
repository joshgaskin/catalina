/**
 * Catalina — test cases by name (#28, witness D1). A mutant line names the tests it proves as
 * `<file> > <describe…> > <title>`, the chain a vitest or jest JSON report gives (ancestorTitles + title). Each named
 * test must be new or changed since the base: this file finds the test's call in the file's text and compares its body
 * (the call's arguments after the title) with every test body in every test file at the base. A body is normalised
 * first: comments, whitespace and semicolons go (one space stays between two words), strings stay as written. So a
 * whitespace, semicolon or comment edit, a move (within the file or to another), and a rename of the test, its
 * describe or its file are not changes (witness 2 N01–N04, witness 3 W02, W03b). It reads the text, it doesn't run it:
 * comments, strings, template literals and regex literals are masked first, so a `test(` inside one doesn't count. A
 * title must be a plain string literal, and no other test call whose title is computed (`test(name, …)`) or a pattern
 * that could fill in to the same chain (`test.each(…)("adds %s", …)`, `` test(`adds ${a}`, …) ``) may be able to report
 * it, or catalina can't tell which one ran (N12, W08b).
 */
const g = require("./git");

const SEP = " > ";

/** "<file> > <describe…> > <title>" → { file, chain } or { error }. A file alone isn't a test. */
function parseName(s) {
  if (typeof s !== "string" || !s.trim()) return { error: `${JSON.stringify(s)} isn't a test name` };
  const [file, ...chain] = s.split(SEP);
  if (!file.trim()) return { error: `"${s}" has no file` };
  if (!chain.length) return { error: `"${s}" names a file, not a test` };
  if (chain.some((c) => !c.trim())) return { error: `"${s}" has an empty title` };
  return { file: file.trim(), chain };
}

const REGEX_BEFORE = new Set("(,=:[!&|?{};+-*%~^".split("")); // not < or >: a JSX closing tag isn't a regex
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

// What mask() says each character is: 0 is code.
const COMMENT = 1;
const LITERAL = 2;

/**
 * The text with every comment, string, template literal and regex literal blanked to spaces (newlines kept, quotes
 * kept), the literal strings by their start offset, and what each character is (0 for code, COMMENT or LITERAL):
 * { masked, strings: Map(offset → value), kind: Uint8Array }. A template literal with a `${}` has no value.
 */
function mask(text) {
  const out = text.split("");
  const kind = new Uint8Array(text.length);
  const strings = new Map();
  const blank = (from, to, k = LITERAL) => {
    for (let i = from; i < to; i++) {
      kind[i] = k;
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  const unescape = (s) => s.replace(/\\(.)/gs, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
  // Returns the index after the literal that starts at i.
  function quoted(i) {
    const q = text[i];
    let j = i + 1;
    while (j < text.length && text[j] !== q && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    strings.set(i, unescape(text.slice(i + 1, j)));
    blank(i + 1, j);
    return j + 1;
  }
  function template(i) {
    let j = i + 1;
    let plain = true;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "$" && text[j + 1] === "{") {
        plain = false;
        j = code(j + 2, "}");
      } else j++;
    }
    if (plain) strings.set(i, unescape(text.slice(i + 1, j)));
    blank(i + 1, j);
    return j + 1;
  }
  function regex(i) {
    let j = i + 1;
    let cls = false;
    while (j < text.length && text[j] !== "\n" && (cls || text[j] !== "/")) {
      if (text[j] === "\\") j++;
      else if (text[j] === "[") cls = true;
      else if (text[j] === "]") cls = false;
      j++;
    }
    blank(i + 1, j);
    return j + 1;
  }
  // Scans code from i to the closing `stop` at depth 0 (or the end); returns the index after it.
  function code(i, stop) {
    let depth = 0;
    let prev = ""; // the last significant character
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === "/" && text[j + 1] === "/") {
        const e = text.indexOf("\n", j);
        const end = e < 0 ? text.length : e;
        blank(j, end, COMMENT);
        j = end;
      } else if (c === "/" && text[j + 1] === "*") {
        const e = text.indexOf("*/", j + 2);
        const end = e < 0 ? text.length : e + 2;
        blank(j, end, COMMENT);
        j = end;
      } else if (c === '"' || c === "'") {
        j = quoted(j);
        prev = c;
      } else if (c === "`") {
        j = template(j);
        prev = c;
      } else if (c === "/" && (!prev || REGEX_BEFORE.has(prev) || REGEX_AFTER_WORD.test(text.slice(Math.max(0, j - 12), j).trimEnd()))) {
        j = regex(j);
        prev = ")";
      } else if (c === "\\") {
        j += 2;
      } else {
        if (stop && c === "{") depth++;
        if (stop && c === "}") {
          if (depth === 0) return j + 1;
          depth--;
        }
        if (!/\s/.test(c)) prev = c;
        j++;
      }
    }
    return j;
  }
  code(0, null);
  return { masked: out.join(""), strings, kind };
}

const WORD = /[\w$]/;

/**
 * text[from, to) with comments dropped, whitespace and semicolons outside literals dropped (one space kept between two
 * words), and a trailing comma before a closing bracket dropped, so a reformat is no change (W03b: a semicolon added).
 */
function normalise(text, kind, from, to) {
  let s = "";
  let gap = false;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (kind[i] === LITERAL) s += c;
    else if (kind[i] === COMMENT || /\s/.test(c) || c === ";") {
      gap = true;
      continue;
    } else {
      if (gap && WORD.test(c) && WORD.test(s[s.length - 1] || "")) s += " ";
      if (")]}".includes(c) && s.endsWith(",")) s = s.slice(0, -1);
      s += c;
    }
    gap = false;
  }
  return s;
}

const ANY = "[\\s\\S]*";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regex source for a title's static text: with `each`, what `.each`/`.for` fills in (`%s`, `$name`) is any text. */
function fill(text, each) {
  if (!each) return escape(text);
  return text.split(/(%%|%[sdifjoOpc#]|\$[\w$.]+)/).map((p, i) => (i % 2 ? (p === "%%" ? "%" : ANY) : escape(p))).join("");
}

/** A title `.each`/`.for` fills in, as a test for the names it could report. */
function pattern(title) {
  return new RegExp(`^${fill(title, true)}$`);
}

/**
 * A template literal title with a `${}` (the raw text between its backticks), as a test for the names it could report:
 * its static parts as written, each `${}` any text (W08b). Escapes in the static parts are read as the string has them.
 */
function templatePattern(raw, each) {
  const unescape = (s) => s.replace(/\\(.)/gs, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
  let re = "";
  let part = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      part += raw.slice(i, i + 2);
      i++;
    } else if (raw[i] === "$" && raw[i + 1] === "{") {
      re += fill(unescape(part), each) + ANY;
      part = "";
      let depth = 1;
      i += 2;
      for (; i < raw.length && depth; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") depth--;
      }
      i--;
    } else part += raw[i];
  }
  return new RegExp(`^${re}${fill(unescape(part), each)}$`);
}

const CALL = /(?<![\w$.])(describe|suite|context|test|it)((?:\.[A-Za-z_$][\w$]*)*)\s*([(`])/g;
const SUITE = new Set(["describe", "suite", "context"]);
const EACH = new Set(["each", "for"]);

/**
 * Every describe/test call in the text: { kind: "suite"|"test", title (null unless a literal), exact, matches(name),
 * body, from, to, start, end } (1-based lines). A `.each(table)(title, fn)` or ``.each`table`(title, fn)`` call spans
 * both parts; its title is a pattern, so it isn't exact. `matches` says whether the call could report `name`: a literal
 * title only itself, a pattern what it fills in, a computed title anything. `body` is the normalised arguments after the
 * title (with an `.each` table in front).
 */
function calls(text) {
  const { masked, strings, kind } = mask(text);
  const lineAt = (() => {
    const starts = [0];
    for (let k = 0; k < masked.length; k++) if (masked[k] === "\n") starts.push(k + 1);
    return (off) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= off) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
  })();
  const closing = (open) => {
    let depth = 0;
    for (let j = open; j < masked.length; j++) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")" && --depth === 0) return j;
    }
    return masked.length - 1;
  };
  const skipSpace = (k) => {
    while (/\s/.test(masked[k] || "")) k++;
    return k;
  };
  const found = [];
  for (const m of masked.matchAll(CALL)) {
    const segments = [m[1], ...m[2].split(".").filter(Boolean)];
    const each = segments.some((x) => EACH.has(x));
    let open = m.index + m[0].length - 1;
    let table = null;
    if (masked[open] === "`") {
      if (!each) continue; // a tagged template on a plain test/it isn't a test call
      const tick = masked.indexOf("`", open + 1);
      const next = skipSpace(tick + 1);
      if (tick < 0 || masked[next] !== "(") continue;
      table = [open, tick + 1];
      open = next;
    } else if (each) {
      const next = skipSpace(closing(open) + 1);
      if (masked[next] === "(") {
        table = [open, next];
        open = next;
      }
    }
    const close = closing(open);
    const k = skipSpace(open + 1);
    const templated = !strings.has(k) && masked[k] === "`"; // a template with a `${}` has no value
    const end = strings.has(k) || templated ? masked.indexOf(masked[k], k + 1) + 1 : -1;
    const alone = end > 0 && /[,)]/.test(masked[skipSpace(end)] || ""); // `"a" + b` is computed
    const title = alone && !templated ? strings.get(k) : null;
    const after = alone ? end : open + 1;
    const body = (table ? normalise(text, kind, table[0], table[1]) : "") + normalise(text, kind, after, close);
    const re = alone && templated ? templatePattern(text.slice(k + 1, end - 1), each) : title !== null && each ? pattern(title) : null;
    const matches = re ? (name) => re.test(name) : title === null ? () => true : (name) => name === title;
    found.push({ kind: segments.some((x) => SUITE.has(x)) ? "suite" : "test", title, exact: title !== null && !each, matches, body, from: m.index, to: close, start: lineAt(m.index), end: lineAt(close) });
  }
  return found;
}

/** Each test call with the suites around it, outermost first. */
function withParents(all) {
  const suites = all.filter((c) => c.kind === "suite");
  return all
    .filter((c) => c.kind === "test")
    .map((c) => ({ test: c, parents: suites.filter((s) => s.from < c.from && s.to > c.to).sort((a, b) => a.from - b.from) }));
}

/**
 * The one test whose chain (its describes from the top, then its title) is `chain`, by literal titles:
 * { start, end, body } or { error }. A test call with a computed or templated title that could report the same chain
 * makes it ambiguous: the report can't say which of them ran.
 */
function locate(text, chain) {
  const tests = withParents(calls(text)).filter(({ parents }) => parents.length + 1 === chain.length);
  const exact = tests.filter(({ test, parents }) => [...parents, test].every((c, i) => c.exact && c.title === chain[i]));
  const could = tests.filter(({ test, parents }) => [...parents, test].every((c, i) => c.matches(chain[i])));
  const other = could.find((x) => !exact.includes(x));
  if (!exact.length) return { error: other ? `no such test with literal titles (a test with a computed title at line ${other.test.start} could report it, but catalina can't tell which test that is)` : "no such test" };
  if (exact.length > 1) return { error: `${exact.length} tests have that name` };
  if (other) return { error: `a test with a computed title could report the same name (line ${other.test.start}), so catalina can't tell which one ran; give it a literal title` };
  const t = exact[0].test;
  return { start: t.start, end: t.end, body: t.body };
}

/** The normalised body of every test call in the text. */
function bodies(text) {
  return new Set(calls(text).filter((c) => c.kind === "test").map((c) => c.body));
}

/**
 * Every test file at `base` (by `isTest`) → the normalised bodies of its tests, read once per base: a test moved or
 * renamed into another file keeps its body (W02, W02b), so a named test is compared with every one.
 */
function baseBodies(base, isTest, cwd) {
  const list = (g.tryGit(["ls-tree", "-r", "-z", "--name-only", base], cwd) || "").split("\0").filter((f) => f && isTest(f));
  return list.map((f) => [f, bodies(g.show(base, f, cwd) || "")]);
}

/**
 * A named test, checked against the change: it parses, its file is one of `tests` (the changed test files), the call
 * is in the file at sha, and its body is new or changed since base: no test in any test file there (`atBase`, from
 * baseBodies) has the same normalised body. → { name, file, chain } or { error }.
 */
function changedTest(name, { tests, sha, base, atBase, cwd }) {
  const p = parseName(name);
  if (p.error) return { error: p.error };
  if (!tests.includes(p.file)) return { error: `names ${name}, which isn't in a test file this change adds or changes (${tests.join(", ")})` };
  const text = g.show(sha, p.file, cwd) || "";
  const at = locate(text, p.chain);
  if (at.error) return { error: `${name}: ${at.error} in ${p.file}` };
  const same = atBase().find(([, set]) => set.has(at.body));
  if (same) {
    return { error: `${name} isn't new or changed since the base (${base.slice(0, 7)}): ${same[0]} there has a test with the same body once comments, whitespace, semicolons and where it sits are set aside, so it proves nothing about this change` };
  }
  return { name, file: p.file, chain: p.chain };
}

module.exports = { parseName, mask, normalise, calls, locate, bodies, baseBodies, changedTest, SEP };
