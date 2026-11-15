/**
 * Catalina — which repos the witness gate checks for a `gh issue edit … --add-label review` (#27).
 *
 * A hook runs in the session's cwd, but a command can aim gh elsewhere. Three witnesses showed the shell's cd can't be
 * modelled safely (quoting, CDPATH, symlinks, `set -P`, `disable cd`, a cd whose redirect fails …), so the gate doesn't
 * try: a cd never moves it.
 *
 * - A flip whose own gh argv names its repo, read the way gh ranks them (an issue URL, then the last -R/--repo), and
 *   that parses cleanly (plain ASCII words, balanced plain quotes, no expansion, no glob, gh run directly at the top
 *   level, and nothing in the text that could redefine gh or set GH_REPO) is checked in that repo's local checkouts only.
 * - Every other flip is checked in the union: the session repo and every repo the command's text mentions (a cd, pushd
 *   or `env -C` dir; a -R, GH_REPO or issue-URL repo), and blocks if any check fails. So it is never looser than the
 *   pre-#27 gate (legacyFlip, in the session repo).
 *
 * plan(command, {cwd, env, home}) is what the hook runs: it returns the issues to check and where.
 * parseFlips(command) is pure: a quote-aware read of the command into simple commands, walked in order.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/** Marks where a command substitution or arithmetic sat in a word: its value isn't known until the shell runs. */
const DYN = "\u0000";
/** A word holding an expansion the parser can't do (a variable, `$(…)`, backticks). */
const DYNAMIC = /[$`\u0000]/;

/**
 * Split into simple commands of words, quote-aware, in order: [[word…] | {open} | {close}…]. Separators: && || ; | &
 * newline; each command (and {open}) carries the one before it as .sep, and .span, its [start, end) in the source.
 * `( … )`, `$( … )`, `<( … )` and backticks are subshells: their commands come between an {open} and a {close}. A
 * substitution leaves DYN in the word it sat in. `{ }` is not a subshell. A backslash-newline is removed (outside
 * single quotes); inside double quotes a backslash escapes only $ ` " \ and newline. The result's .flags say what the
 * split doesn't model: heredoc, comment, func (a `name()` definition), group, or (`||`), pipe, bg (a lone `&`).
 */
function simpleCommands(command) {
  const out = [];
  const flags = {};
  out.flags = flags;
  const frames = [];
  let words = [];
  let word = null; // null: between words
  let sep = null;
  let start = null; // where the current command's first word starts
  let pos = 0;
  const s = String(command);
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const next = () => {
    end();
    if (words.length) {
      words.sep = sep;
      words.span = [start ?? pos, pos];
      out.push(words);
      sep = null;
    }
    words = [];
    start = null;
  };
  const open = (kind) => {
    if (kind === "sub") {
      next();
      frames.push({ kind });
      out.push({ open: true, sep });
    } else {
      frames.push({ kind, words, word, sep, start: start ?? pos });
      words = [];
      word = null;
      start = null;
      out.push({ open: true, sep: null });
    }
    sep = null;
  };
  const close = () => {
    const f = frames.pop();
    next();
    out.push({ close: true });
    if (f.kind !== "sub") {
      words = f.words;
      word = (f.word ?? "") + DYN;
      sep = f.sep;
      start = f.start;
    }
  };
  for (let i = 0; i < s.length; i++) {
    pos = i;
    const i0 = i;
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const stop = j === -1 ? s.length : j;
      word = (word ?? "") + s.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let v = "";
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1])) {
          if (s[++j] !== "\n") v += s[j];
        } else v += s[j];
      }
      word = (word ?? "") + v;
      i = j;
    } else if (c === "\\" && s[i + 1] === "\n") {
      i++; // a line continuation: gone before the shell splits words
    } else if (c === "\\" && i + 1 < s.length) {
      word = (word ?? "") + s[++i];
    } else if (c === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      word = (word ?? "") + DYN; // $(( arithmetic ))
      i = j;
    } else if (c === "<" && s[i + 1] === "<") {
      const n = s[i + 2] === "<" ? 3 : 2; // <<< is a here-string; << starts a heredoc whose body the split can't place
      if (n === 2) flags.heredoc = true;
      word = (word ?? "") + s.slice(i, i + n);
      i += n - 1;
    } else if ((c === "$" || c === "<" || c === ">") && s[i + 1] === "(") {
      open("cmdsub");
      i++;
    } else if (c === "`") {
      if (frames.length && frames[frames.length - 1].kind === "tick") close();
      else open("tick");
    } else if (c === "&" && (s[i - 1] === ">" || s[i - 1] === "<" || s[i + 1] === ">")) {
      word = (word ?? "") + c; // a redirect (2>&1, &>), not a separator
    } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
      next();
      const two = (c === "&" || c === "|") && s[i + 1] === c;
      if (c === "|") flags[two ? "or" : "pipe"] = true;
      if (c === "&" && !two) flags.bg = true;
      sep = two ? c + c : c;
      if (two) i++;
    } else if (/\s/.test(c)) {
      end();
    } else if (c === "(") {
      if (/^\(\s*\)/.test(s.slice(i, i + 16))) flags.func = true;
      open("sub");
    } else if (c === ")") {
      if (frames.length && frames[frames.length - 1].kind !== "tick") close();
      else next();
    } else if ((c === "{" || c === "}") && word === null && (i + 1 >= s.length || /[\s;&|)]/.test(s[i + 1]))) {
      flags.group = true;
      next(); // a group opens or closes a command, but shares the shell
    } else {
      if (c === "#" && word === null) flags.comment = true;
      word = (word ?? "") + c;
    }
    if (start === null && (word !== null || words.length)) start = i0;
  }
  pos = s.length;
  next();
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ALLOW = "CATALINA_WITNESS_ALLOW=1";

/** gh issue edit flags that take a value (so a number after them is not an issue). */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-project",
  "--remove-project", "-b", "--body", "-F", "--body-file", "-m", "--milestone", "-t", "--title",
]);

/**
 * owner/name from a -R or GH_REPO value, in the forms gh takes: `owner/name`, `host/owner/name`, `=owner/name` (pflag's
 * `-R=x`), `https://host/owner/name(.git)`, `git@host:owner/name(.git)`, `ssh://git@host/owner/name`. A value with an
 * expansion is kept as is.
 */
const slugOf = (v) => {
  let s = String(v ?? "");
  if (DYNAMIC.test(s)) return s;
  s = s
    .replace(/^=/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\/)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const parts = s.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
};

const PART = "[\\w.-]+";
const STRICT_R = [
  new RegExp(`^(?:${PART}/)?(${PART})/(${PART})$`),
  new RegExp(`^git@${PART}:(${PART})/(${PART}?)(?:\\.git)?$`),
  new RegExp(`^https?://${PART}/(${PART})/(${PART}?)(?:\\.git)?/?$`),
];
const STRICT_URL = new RegExp(`^https?://${PART}/(${PART})/(${PART})/issues/(\\d+)/?(?:#[\\w-]*)?$`);
const okParts = (o, n) => o && n && ![o, n].some((x) => x === "." || x === "..");

/** owner/name from a -R value only when it is unambiguous: one of gh's plain forms, no `.`/`..` parts. */
function strictSlug(v) {
  const s = String(v ?? "");
  for (const re of STRICT_R) {
    const m = s.match(re);
    if (m && okParts(m[1], m[2])) return `${m[1]}/${m[2]}`;
  }
  return null;
}

const ISSUE_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)\b/;
/** An issue number as gh reads it: `#` and leading zeros dropped. */
const num = (w) => String(w).replace(/^#/, "").replace(/^0+(?=\d)/, "");

/**
 * The arguments of `gh issue edit` from words[from]: { numbers, bare, urls: [{slug, strict}], rs: [raw -R values],
 * labels (lower case) }.
 */
function editArgs(words, from, rs = []) {
  const numbers = [];
  const labels = [];
  const urls = [];
  let bare = 0;
  for (let j = from; j < words.length; j++) {
    const w = words[j];
    const eq = w.match(/^(--?[\w-]+)=(.*)$/s);
    const flag = eq ? eq[1] : w;
    if (VALUE_FLAGS.has(flag)) {
      const v = eq ? eq[2] : words[++j];
      if (flag === "--add-label") labels.push(...String(v ?? "").split(",").map((x) => x.trim().toLowerCase()));
      if (flag === "-R" || flag === "--repo") rs.push(v ?? "");
      continue;
    }
    if (!eq && /^-R./.test(w)) {
      rs.push(w.slice(2));
      continue;
    }
    if (w.startsWith("-")) continue;
    const url = w.match(ISSUE_URL);
    if (url) {
      const strict = w.match(STRICT_URL);
      urls.push({ slug: url[1], strict: !!(strict && okParts(strict[1], strict[2])) });
      numbers.push(num(url[2]));
    } else if (/^#?\d+$/.test(w)) {
      numbers.push(num(w));
      bare++;
    }
  }
  return { numbers, bare, urls, rs, labels };
}

/**
 * A gh command's flip, or null: { numbers, repo, named } when it is `gh [-R x] issue edit … --add-label …review…`.
 * repo is what gh edits as gh ranks it: an issue URL, then the last -R/--repo (GH_REPO is the caller's). named is that
 * repo when the argv names it unambiguously: one strict issue-URL repo and no bare numbers, or else a strict last -R.
 */
function readGh(words) {
  let i = 1;
  const rs = [];
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-R" || w === "--repo") rs.push(words[++i] ?? "");
    else if (w.startsWith("--repo=")) rs.push(w.slice(7));
    else if (w.startsWith("-R=")) rs.push(w.slice(3));
    else if (/^-R./.test(w)) rs.push(w.slice(2));
    i++;
  }
  if (words[i] !== "issue" || words[i + 1] !== "edit") return null;
  const a = editArgs(words, i + 2, rs);
  if (!a.labels.includes("review")) return null;
  const lastR = a.rs.length ? a.rs[a.rs.length - 1] : null;
  const repo = a.urls.length ? a.urls[0].slug : lastR !== null ? slugOf(lastR) : null;
  let named = null;
  if (a.urls.length) {
    const slugs = new Set(a.urls.map((u) => u.slug.toLowerCase()));
    if (!a.bare && slugs.size === 1 && a.urls.every((u) => u.strict)) named = a.urls[0].slug;
  } else if (lastR !== null) named = strictSlug(lastR);
  return { numbers: a.numbers, repo, named };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Commands that run the command after them (with their own options in between). */
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "timeout", "gtimeout", "nice", "ionice", "xargs", "stdbuf", "caffeinate", "noglob"]);
/** sudo/doas options that take a value. */
const SUDO_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R"]);
const STATE = new Set(["cd", "pushd", "popd", "export", "unset"]);

/** What a wrapper runs: gh, env, eval or a shell (and, for `command`/`builtin`, a builtin that moves state). */
const isTarget = (w, builtin) => {
  const b = path.basename(w);
  return b === "gh" || b === "env" || b === "eval" || SHELLS.has(b) || (builtin && STATE.has(b));
};

/** Strip leading assignments, `env` and wrappers: { words, assigns, chdir } (chdir from `env -C`). */
function unwrap(cmd) {
  const assigns = [];
  let chdir = null;
  let words = cmd;
  for (let guard = 0; guard < 10 && words.length; guard++) {
    let i = 0;
    while (i < words.length && ASSIGN.test(words[i])) assigns.push(words[i++]);
    words = words.slice(i);
    const head = path.basename(words[0] || "");
    if (head === "env") {
      let j = 1;
      for (; j < words.length; j++) {
        const w = words[j];
        if (ASSIGN.test(w)) assigns.push(w);
        else if (w === "-u" || w === "--unset" || w === "-S" || w === "--split-string") j++;
        else if (w === "-C" || w === "--chdir") chdir = words[++j];
        else if (w.startsWith("--chdir=")) chdir = w.slice(8);
        else if (!w.startsWith("-")) break;
      }
      words = words.slice(j);
      continue;
    }
    if (head === "sudo" || head === "doas") {
      let j = 1;
      for (; j < words.length; j++) {
        const w = words[j];
        if (SUDO_VALUE.has(w)) j++;
        else if (ASSIGN.test(w)) assigns.push(w);
        else if (!w.startsWith("-")) break;
      }
      words = words.slice(j);
      continue;
    }
    if (WRAPPERS.has(head)) {
      const j = words.findIndex((w, k) => k > 0 && isTarget(w, head === "command" || head === "builtin"));
      if (j < 0) return { words: [], assigns, chdir };
      words = words.slice(j);
      continue;
    }
    break;
  }
  return { words, assigns, chdir };
}

/** The parse state a command starts in: the hook's own env can name the repo (GH_REPO) for gh too. */
const initialCtx = (env = {}) => ({ cds: [], gitC: [], exported: false, ghRepo: env.GH_REPO ? slugOf(env.GH_REPO) : null });

/** The script of `sh -c '<script>'` (any -c flag cluster), or null. */
const shellScript = (words) => {
  const c = words.findIndex((w, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(w));
  return c > 0 && words[c + 1] !== undefined ? words[c + 1] : null;
};

/**
 * Text that could make gh mean something else, or aim it by GH_REPO: then no flip in the command counts as naming its
 * repo. An alias, a function (`name()`, `function`, zsh's functions[]), `hash`, eval, source or `.`, PATH, enable.
 */
const NOT_EXPLICIT = [
  /GH_REPO/,
  /\balias\b/,
  /\bfunctions?\b/,
  /\(\s*\)/,
  /\bhash\b/,
  /\beval\b/,
  /\bsource\b/,
  /(?:^|[\s;&|(){}])\.\s/,
  /\bpath\+?=/i,
  /\benable\b/,
];

/**
 * True when a gh command's source text is plain enough that the words parseFlips read are the argv gh gets: printable
 * ASCII and tabs, balanced plain quotes; outside quotes no expansion, glob, brace, redirect, separator, subshell,
 * backslash or history char, and no word starting with # = or ~; inside double quotes no $ ` or backslash.
 */
function cleanSpan(t) {
  if (!/^[\x20-\x7e\t]*$/.test(t)) return false;
  let q = null;
  let wordStart = true;
  for (const c of t) {
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "$" || c === "`" || c === "\\") return false;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      wordStart = false;
      continue;
    }
    if (c === " " || c === "\t") {
      wordStart = true;
      continue;
    }
    if ("$`\\*?[]{}<>|&;()!".includes(c)) return false;
    if (wordStart && "#=~".includes(c)) return false;
    wordStart = false;
  }
  return q === null;
}

/**
 * Every review flip in a command: { numbers, repo, explicit, cds, allow, gitC }. repo is what gh would edit as parsed
 * (an issue URL, the last -R, then GH_REPO); explicit is the repo the flip's own argv names when the gate can trust it
 * (readGh's named repo, gh run directly at the top level of the command outside any subshell, its source cleanSpan, and
 * nothing in the text matching NOT_EXPLICIT), else null. cds are the `cd` arguments before it (kept only for the
 * reader; they never move the gate); allow is the bypass as a prefix, through `env`, or from an earlier `export`; gitC
 * lists `git -C` dirs with the cds they ran after. A `bash -c '<script>'` and `eval` are read as well, never explicit.
 */
function parseFlips(command, ctx = initialCtx(), depth = 0) {
  const flips = [];
  const scopes = [];
  const { cds, gitC } = ctx;
  const text = String(command);
  const trusted = depth === 0 && !NOT_EXPLICIT.some((re) => re.test(text));
  for (const item of simpleCommands(text)) {
    if (item.open) {
      scopes.push({ n: cds.length, exported: ctx.exported, ghRepo: ctx.ghRepo });
      continue;
    }
    if (item.close) {
      const sc = scopes.pop();
      if (sc) Object.assign(ctx, { exported: sc.exported, ghRepo: sc.ghRepo }), (cds.length = sc.n);
      continue;
    }
    const { words, assigns, chdir } = unwrap(item);
    const setsAllow = assigns.some((a) => a.startsWith("CATALINA_WITNESS_ALLOW="));
    const allow = assigns.includes(ALLOW) || (ctx.exported && !setsAllow);
    const repoAssign = assigns.filter((a) => a.startsWith("GH_REPO=")).pop();
    const ghRepo = repoAssign ? slugOf(repoAssign.slice(8)) : ctx.ghRepo;
    const here = chdir ? [...cds, chdir] : [...cds];
    const head = path.basename(words[0] || "");
    if (head === "cd" || head === "pushd") {
      const arg = words.slice(1).find((w) => w === "-" || !w.startsWith("-"));
      if (head === "cd") cds.push(arg ?? "~");
      else if (arg !== undefined) cds.push(arg);
    } else if (head === "export" || head === "unset") {
      for (const w of words.slice(1)) {
        const name = head === "unset" ? w : w.split("=")[0];
        const value = head === "unset" || !w.includes("=") ? null : w.slice(name.length + 1);
        if (name === "CATALINA_WITNESS_ALLOW" && (head === "unset" || value !== null)) ctx.exported = value === "1";
        if (name === "GH_REPO" && (head === "unset" || value !== null)) ctx.ghRepo = value === null ? null : slugOf(value);
      }
    } else if (head === "git") {
      for (let j = 1; j < words.length - 1; j++) if (words[j] === "-C") gitC.push({ cds: here, dir: words[j + 1] });
    } else if (head === "gh") {
      const flip = readGh(words);
      if (flip) {
        let k = 0;
        while (k < item.length && ASSIGN.test(item[k])) k++;
        const direct = item[k] === "gh" && !item.some((w) => DYNAMIC.test(w));
        const clean = trusted && direct && !scopes.length && item.span && cleanSpan(text.slice(item.span[0], item.span[1]));
        flips.push({ numbers: flip.numbers, repo: flip.repo || ghRepo || null, explicit: clean ? flip.named : null, cds: here, allow, gitC: [...gitC] });
      }
    } else if (head === "eval" && depth < 3) {
      const inner = assigns.length ? { ...ctx, exported: allow, ghRepo } : ctx; // same shell: its cds stay shared
      flips.push(...parseFlips(words.slice(1).join(" "), inner, depth + 1));
    } else if (SHELLS.has(head) && depth < 3) {
      const script = shellScript(words);
      if (script !== null) flips.push(...parseFlips(script, { cds: here, gitC: [...gitC], exported: allow, ghRepo }, depth + 1));
    }
  }
  return flips;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The url of each remote in a git config file, lower case, without a trailing / or .git. */
function remotesOf(config) {
  let text = "";
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {}
  return [...text.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map((m) => m[1].toLowerCase().replace(/\/+$/, "").replace(/\.git$/, ""));
}

/**
 * A memo of what the gate knows about each dir: dirInfo(dir) is { top, main, remotes } for a dir in a work tree (main
 * is the main checkout: a worktree's is the parent of its common dir), else null. One git call per dir, 2 s at most.
 */
function dirCache() {
  const memo = new Map();
  return (dir) => {
    if (memo.has(dir)) return memo.get(dir);
    let info = null;
    if (isDir(dir)) {
      try {
        const [top, common] = execFileSync("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        })
          .trim()
          .split("\n");
        if (top && common) info = { top, main: path.basename(common) === ".git" ? path.dirname(common) : top, remotes: remotesOf(path.join(common, "config")) };
      } catch {}
    }
    memo.set(dir, info);
    return info;
  };
}

/** Every local checkout of slug near the dirs in from: each one's repo, its main checkout, a sibling or child named for the repo. */
function checkouts(slug, from, info) {
  const want = slug.toLowerCase();
  const name = slug.split("/")[1];
  const found = [];
  const looked = [];
  for (const here of from) {
    const i = info(here);
    const base = i ? i.main : here;
    for (const c of [i && i.top, i && i.main, path.join(path.dirname(base), name), path.join(here, name)]) {
      if (!c || looked.includes(c)) continue;
      looked.push(c);
      if (c !== (i && i.top) && c !== (i && i.main) && !fs.existsSync(path.join(c, ".git"))) continue;
      const t = info(c);
      if (t && t.remotes.some((u) => u.endsWith(`/${want}`) || u.endsWith(`:${want}`)) && !found.includes(t.top)) found.push(t.top);
    }
  }
  return { found, looked };
}

/** The gate's pre-#27 read of a command, kept as a backstop: { n } (n may be null) when it looks like a review flip. */
function legacyFlip(command) {
  if (!/\bgh\s+issue\s+edit\b/.test(command)) return null;
  const labelMatch = command.match(/--add-label(?:=|\s+)(['"]?)([^'"\s]+)\1/);
  if (!labelMatch || !labelMatch[2].split(",").map((s) => s.trim()).includes("review")) return null;
  const nMatch = command.match(/\/issues\/(\d+)/) || command.match(/gh\s+issue\s+edit\s+#?(\d+)/) || command.match(/#(\d+)/);
  return { n: nMatch ? nMatch[1] : null };
}

/**
 * Every `gh [-R x] issue edit … --add-label review` in the raw text, wherever it sits (a quote, a heredoc, after `then`),
 * read from where it starts to the end of its line.
 */
function rawFlips(command) {
  const res = [];
  for (const m of String(command).matchAll(/\bgh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)?\s+issue\s+edit\b/gi)) {
    const rest = command.slice(m.index + m[0].length).split("\n")[0];
    const words = simpleCommands(rest).find(Array.isArray) || [];
    const a = editArgs(words, 0);
    if (a.labels.includes("review")) res.push(a);
  }
  return res;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "coproc", "!"]);
const AFTER_SEMI = new Set([";", "\n"]);

/**
 * Why a command isn't a simple script (added to reasons), read the way parseFlips reads it, child shells included. Only
 * a simple script honours the bypass written on it.
 */
function shape(command, reasons, depth = 0) {
  const items = simpleCommands(command);
  const f = items.flags;
  if (f.heredoc) reasons.add("a heredoc");
  if (f.comment) reasons.add("a # comment");
  if (f.func) reasons.add("a function definition");
  if (f.group) reasons.add("a { } group");
  if (f.or) reasons.add("`||`");
  let state = false;
  let maybe = false; // a cd/export after `&&`: it may not run, and a later `;` runs on regardless
  for (const item of items) {
    if (item.close) continue;
    if (maybe && AFTER_SEMI.has(item.sep)) reasons.add("a cd or export that may not run (after `&&`, then `;`)");
    if (item.open) continue;
    if (KEYWORDS.has(item[0])) reasons.add(`\`${item[0]}\``);
    const { words, assigns } = unwrap(item);
    const head = path.basename(words[0] || "");
    const sets = [...assigns, ...(head === "export" ? words.slice(1) : [])];
    if (sets.some((a) => /^(HOME|CDPATH)=/.test(a))) reasons.add("HOME or CDPATH set");
    if (STATE.has(head) || (!words.length && assigns.length)) {
      state = true;
      if (item.sep === "&&") maybe = true;
      if (item.some((w) => /[<>]/.test(w))) reasons.add("a cd or export with a redirect (it fails if the redirect does)");
    }
    if (head === "popd") reasons.add("`popd`");
    if (head === "pushd" && !words.slice(1).some((w) => !w.startsWith("-"))) reasons.add("`pushd` with no dir");
    if (head === "eval") reasons.add("`eval`");
    if (head === "source" || head === ".") reasons.add("`source`");
    if (KEYWORDS.has(head)) reasons.add(`\`${head}\``);
    if (SHELLS.has(head)) {
      const script = shellScript(words);
      if (script !== null) {
        if (depth >= 3) reasons.add("shells nested too deep");
        else shape(script, reasons, depth + 1);
      }
    }
  }
  if (state && (f.pipe || f.bg)) reasons.add("a cd or export beside a pipe or `&`");
}

const unquote = (w) => String(w).replace(/^(['"])(.*)\1$/s, "$2").replace(/\\(.)/gs, "$1");
/** A cd-like command anywhere in the text (a heredoc, a comment, a function body, a quote). */
const CD_HEAD = /(?:^|[\s;&|(){}`'"])(?:cd|pushd|chdir)(?=[\s;&|)}`'"]|$)/g;
const RAW_CHDIR = /\benv\b[^;&|\n]*?\s(?:-C|--chdir)(?:=|\s+)("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g;
const RAW_HOME = /(?:^|[\s;&|(])(?:export\s+)?HOME=("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g;
const RAW_CDPATH = /\bCDPATH=("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g;
const RAW_SLUGS = [
  /(?:^|\s)(?:-R|--repo)(?:=|\s+)?("[^"\n]*"|'[^'\n]*'|[^\s;&|()'"]+)/g,
  /\bGH_REPO=("[^"\n]*"|'[^'\n]*'|[^\s;&|()'"]+)/g,
  /https?:\/\/[^\s/'"]+\/([^\s/'"]+\/[^\s/'"]+)\/issues\/\d+/g,
];
const SPACE = /[\s\u00a0\u0085\u180e\u200b-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]+/;

/** Caps: above any of them the gate blocks rather than check a command built to make it slow. */
const MAX = { args: 20, bases: 60, slugs: 20, dirs: 20, numbers: 50 };

/** Every dir argument a cd, pushd, chdir or `env -C` in the text could take: [{dir} | {from, to}] (zsh's `cd old new`). */
function dirArgs(s) {
  const args = [];
  const seen = new Set();
  const add = (a) => {
    const k = JSON.stringify(a);
    if (!seen.has(k)) seen.add(k), args.push(a);
  };
  for (const m of s.matchAll(CD_HEAD)) {
    const rest = s.slice(m.index + m[0].length).split("\n")[0];
    const words = simpleCommands(rest).find(Array.isArray) || [];
    const dd = words.indexOf("--");
    const plain = dd >= 0 ? words.slice(dd + 1) : words.filter((w) => !w.startsWith("-") || w === "-");
    const dirs = plain.filter((w) => w !== "-");
    if (!dirs.length) add({ dir: "~" });
    for (const w of dirs) add({ dir: w });
    if (dirs.length === 2) add({ from: dirs[0], to: dirs[1] });
  }
  for (const m of s.matchAll(RAW_CHDIR)) add({ dir: unquote(m[1]) });
  return args;
}

/** The spellings of a dir argument worth trying: as written, without backslashes, and each whitespace-split piece. */
const variants = (a) => [...new Set([a, a.replace(/\\/g, ""), ...a.split(SPACE).filter(Boolean)])];

/** A path resolved with each `..` taken after the symlinks before it (cd -P), or null. */
function physical(base, rel) {
  let cur;
  try {
    cur = fs.realpathSync(path.isAbsolute(rel) ? "/" : base);
  } catch {
    return null;
  }
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") cur = path.dirname(cur);
    else {
      try {
        cur = fs.realpathSync(path.join(cur, seg));
      } catch {
        return null;
      }
    }
  }
  return cur;
}

/**
 * Every dir and repo a command's text could point gh at: { dirs, unchecked: [{repo, why}] } or { over } past a cap. dirs
 * holds the session repo, the cwd, and the repo (or dir) of each cd, pushd and `env -C` target, resolved from the cwd
 * and from each other, logically and physically, also through CDPATH, with ~ and $HOME as any home the text sets; then
 * every local checkout of each -R, GH_REPO and issue-URL repo the text or env names.
 */
function reachable(s, { cwd, home, env, flips, info }) {
  const homes = new Set([home]);
  for (const m of s.matchAll(RAW_HOME)) homes.add(unquote(m[1]));
  const cdpath = new Set();
  for (const v of [env.CDPATH, ...[...s.matchAll(RAW_CDPATH)].map((m) => unquote(m[1]))]) for (const e of String(v || "").split(":")) if (e) cdpath.add(e);
  const args = dirArgs(s);
  if (args.length > MAX.args) return { over: `more than ${MAX.args} cd targets in one command` };
  const expand = (a, base) => {
    const out = [];
    if (/^~-/.test(a)) return out;
    if (/^(~\+|\$PWD|\$\{PWD\})(?=\/|$)/.test(a)) out.push(a.replace(/^(~\+|\$PWD|\$\{PWD\})/, base));
    else if (/^(~|\$HOME|\$\{HOME\})(?=\/|$)/.test(a)) for (const h of homes) out.push(a.replace(/^(~|\$HOME|\$\{HOME\})/, h));
    else out.push(a);
    return out.filter((e) => !DYNAMIC.test(e) && !/^~/.test(e));
  };
  const bases = [cwd];
  let over = false;
  const push = (d) => {
    if (d && !bases.includes(d) && isDir(d)) {
      if (bases.length >= MAX.bases) over = true;
      else bases.push(d);
    }
  };
  for (let round = 0; round < 3 && !over; round++) {
    const before = bases.length;
    for (const a of args) {
      for (const b of [...bases]) {
        if (a.from !== undefined) {
          if (b.includes(a.from)) push(b.replace(a.from, a.to));
          continue;
        }
        for (const v of variants(a.dir)) {
          for (const e of expand(v, b)) {
            const roots = path.isAbsolute(e) ? ["/"] : [b, ...cdpath];
            for (const r of roots) {
              push(path.resolve(r, e));
              push(physical(r, e));
            }
          }
        }
      }
    }
    if (bases.length === before) break;
  }
  if (over) return { over: `more than ${MAX.bases} dirs reachable from one command` };
  const dirs = [];
  const add = (d) => d && !dirs.includes(d) && dirs.push(d);
  const top = (d) => (info(d) ? info(d).top : d);
  add(top(cwd));
  add(cwd);
  for (const b of bases) add(top(b));
  const slugs = new Set();
  const addSlug = (v) => {
    const slug = slugOf(v);
    if (slug && !DYNAMIC.test(slug)) slugs.add(slug);
  };
  for (const f of flips) if (f.repo) addSlug(f.repo);
  if (env.GH_REPO) addSlug(env.GH_REPO);
  for (const re of RAW_SLUGS) for (const m of s.matchAll(re)) addSlug(unquote(m[1]));
  if (slugs.size > MAX.slugs) return { over: `more than ${MAX.slugs} repos named in one command` };
  const unchecked = [];
  const from = [...new Set([cwd, ...bases.map(top)])];
  for (const slug of slugs) {
    const { found, looked } = checkouts(slug, from, info);
    for (const d of found) add(d);
    if (!found.length) unchecked.push({ repo: slug, why: `no local checkout of ${slug} found (looked at ${looked.join(", ")})` });
  }
  if (dirs.length > MAX.dirs) return { over: `more than ${MAX.dirs} repos to check for one command` };
  return { dirs, unchecked };
}

const NO_NUMBER = "this looks like a flip to `review` but the issue number couldn't be parsed";
const HINT = "to flip an issue in another repo, run `gh issue edit N -R owner/name …` (the gate then checks that repo only)";

/**
 * What the witness gate checks for a command: {
 *   flip: is there a review flip at all,
 *   mode: "explicit" (every flip names its repo cleanly: each checked in that repo's checkouts) | "union" (every issue
 *     in the session repo and every repo the text mentions),
 *   simple: no shape reasons (only then does a bypass written on the command count), reasons: why not,
 *   flips: parseFlips' read, gates: [{n, dir}] to check (block if any fails), block: [why] to block outright,
 *   unchecked: [{numbers, repo, why}] named repos with no local checkout, bypassed: issue numbers the text bypass let
 *   through, notes: what to tell the user, hint: say how to name a repo when a union check blocks,
 * }
 * The backstop counts per flip: a number the old regex or a raw scan sees that the parser didn't is checked in the union.
 */
function plan(command, { cwd = process.cwd(), env = {}, home = os.homedir() } = {}) {
  const s = String(command);
  const old = legacyFlip(s);
  const flips = parseFlips(s, initialCtx(env));
  const out = { flip: false, mode: "explicit", simple: true, reasons: [], flips, gates: [], block: [], unchecked: [], bypassed: [], notes: [], hint: false };
  const raw = rawFlips(s);
  if (!flips.length && !old && !raw.length) return out;
  out.flip = true;
  const info = dirCache();
  const gate = (n, dir) => {
    if (!out.gates.some((g) => g.n === n && g.dir === dir)) out.gates.push({ n, dir });
  };
  const blockOnce = (why) => out.block.includes(why) || out.block.push(why);
  const reasons = new Set();
  shape(s, reasons);
  const parsed = new Set(flips.flatMap((f) => f.numbers));
  const seen = [...new Set([...(old && old.n ? [num(old.n)] : []), ...raw.flatMap((r) => r.numbers)])];
  const unread = !flips.length || raw.length > flips.length || seen.some((n) => !parsed.has(n));
  if (unread) reasons.add("a flip the parser can't read");
  out.reasons = [...reasons];
  out.simple = !reasons.size;
  const noExplicit = unread || simpleCommands(s).flags.heredoc;

  const union = new Set();
  const named = [];
  for (const f of flips) {
    if (f.allow && out.simple) {
      out.bypassed.push(...(f.numbers.length ? f.numbers : ["?"]));
      continue;
    }
    if (!f.numbers.length) {
      blockOnce(NO_NUMBER);
      continue;
    }
    if (f.explicit && !noExplicit) named.push(f);
    else for (const n of f.numbers) union.add(n);
  }
  if (unread) {
    for (const n of seen) union.add(n);
    if ((old && old.n === null) || raw.some((r) => !r.numbers.length)) blockOnce(NO_NUMBER);
  }
  // One flip in the union puts every flip there: a mixed command is read as a whole.
  if (union.size) for (const f of named.splice(0)) for (const n of f.numbers) union.add(n);
  const all = new Set([...union, ...named.flatMap((f) => f.numbers)]);
  if (all.size > MAX.numbers) {
    blockOnce(`more than ${MAX.numbers} issue numbers in one command`);
    return out;
  }
  const session = info(cwd) ? info(cwd).top : cwd;

  for (const f of named) {
    const { found, looked } = checkouts(f.explicit, [cwd], info);
    if (!found.length) out.unchecked.push({ numbers: f.numbers, repo: f.explicit, why: `no local checkout of ${f.explicit} found (looked at ${looked.join(", ")})` });
    for (const d of found) for (const n of f.numbers) gate(n, d);
  }
  let dirs = [session];
  if (union.size) {
    out.mode = "union";
    const r = reachable(s, { cwd, home, env, flips, info });
    if (r.over) {
      blockOnce(r.over);
      return out;
    }
    dirs = r.dirs;
    for (const n of union) for (const d of dirs) gate(n, d);
    for (const u of r.unchecked) out.unchecked.push({ numbers: [...union], ...u });
    if (dirs.length > 1 || reasons.size) {
      out.hint = true;
      out.notes.push(`issue ${[...union].join(", ")} is checked in every repo this command could reach (a cd doesn't change it): ${dirs.join(", ")}`);
    }
  }
  if (!out.simple && flips.some((f) => f.allow)) out.notes.push("CATALINA_WITNESS_ALLOW=1 on this command is ignored: it counts only as a prefix or export in a simple script");

  // AC4: git -C doesn't change the repo gh edits; say so when it names a different repo than the one checked.
  for (const f of flips) {
    const checked = out.gates.filter((g) => f.numbers.includes(g.n)).map((g) => g.dir);
    const g = f.gitC.find((x) => !x.cds.length && !DYNAMIC.test(x.dir));
    if (!g || !checked.length) continue;
    const d = path.resolve(cwd, String(g.dir).replace(/^~(?=\/|$)/, home));
    const other = info(d) ? info(d).top : null;
    if (other && !checked.includes(other)) {
      out.notes.push(`\`git -C ${g.dir}\` doesn't change the repo gh edits: issue ${f.numbers.join(", ")} is checked in ${checked.join(", ")} (git -C names ${other})`);
      break;
    }
  }
  return out;
}

module.exports = { plan, parseFlips, simpleCommands, initialCtx, legacyFlip, slugOf, HINT };
