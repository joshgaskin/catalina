/**
 * Catalina — which repo a `gh issue edit … --add-label review` edits (#27).
 *
 * A hook runs in the session's cwd, but a command can aim gh elsewhere: `cd <dir> && gh …`, `gh -R owner/name …`, or an
 * issue URL. gh reads those and nothing else (not `git -C`), so the witness gate reads the same.
 *
 * The principle (second witness): the gate moves off the session repo only for a simple script, a flat list of simple
 * commands joined by && or ; where every cd and export runs and the gate can read where each lands. Anything else (a
 * heredoc, a comment, a function, control flow, `||`, eval, popd, a cd that may not run, a flip the parser can't read)
 * is checked in every repo its text could reach, the session repo among them, so it is never looser than the pre-#27
 * gate; and the bypass written on such a command is ignored.
 *
 * plan(command, {cwd, env, home}) is what the hook runs: it returns the issues to check and where.
 * parseFlips(command) is pure: a quote-aware read of the command into simple commands, walked in order.
 * resolveFlip(flip, cwd) touches git: it finds the local checkout that flip's issues live in.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/** Marks where a command substitution or arithmetic sat in a word: its value isn't known until the shell runs. */
const DYN = "\u0000";
/** A word holding an expansion the parser can't do (a variable, `$(…)`, backticks). */
const DYNAMIC = /[$`\u0000]/;
const POPD = "\u0001popd";
/** Prefixes a pushd's dir in a flip's cds: only a pushd puts a dir on the stack popd returns to. */
const PUSHD = "\u0002";

/**
 * Split into simple commands of words, quote-aware, in order: [[word…] | {open} | {close}…]. Separators: && || ; | &
 * newline; each command (and {open}) carries the one before it as .sep. `( … )`, `$( … )`, `<( … )` and backticks are
 * subshells: their commands come between an {open} and a {close}, so a cd inside doesn't outlive them. A substitution
 * leaves DYN in the word it sat in. `{ }` is not a subshell. The result's .flags say what the split doesn't model:
 * heredoc, comment, func (a `name()` definition), group, or (`||`), pipe, bg (a lone `&`).
 */
function simpleCommands(command) {
  const out = [];
  const flags = {};
  out.flags = flags;
  const frames = [];
  let words = [];
  let word = null; // null: between words
  let sep = null;
  const s = String(command);
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const next = () => {
    end();
    if (words.length) {
      words.sep = sep;
      out.push(words);
      sep = null;
    }
    words = [];
  };
  const open = (kind) => {
    if (kind === "sub") {
      next();
      frames.push({ kind });
      out.push({ open: true, sep });
    } else {
      frames.push({ kind, words, word, sep });
      words = [];
      word = null;
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
    }
  };
  for (let i = 0; i < s.length; i++) {
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
        if (s[j] === "\\" && j + 1 < s.length) v += s[++j];
        else v += s[j];
      }
      word = (word ?? "") + v;
      i = j;
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
  }
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

const ISSUE_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)\b/;

/** The arguments of `gh issue edit` from words[from]: { numbers, repo, labels }. */
function editArgs(words, from) {
  const numbers = [];
  const labels = [];
  let repo = null;
  for (let j = from; j < words.length; j++) {
    const w = words[j];
    const eq = w.match(/^(--?[\w-]+)=(.*)$/s);
    const flag = eq ? eq[1] : w;
    if (VALUE_FLAGS.has(flag)) {
      const v = eq ? eq[2] : words[++j];
      if (flag === "--add-label") labels.push(...String(v ?? "").split(",").map((x) => x.trim()));
      if (flag === "-R" || flag === "--repo") repo = slugOf(v);
      continue;
    }
    if (!eq && /^-R./.test(w)) {
      repo = slugOf(w.slice(2));
      continue;
    }
    if (w.startsWith("-")) continue;
    const url = w.match(ISSUE_URL);
    if (url) {
      repo = repo || url[1];
      numbers.push(url[2]);
    } else if (/^#?\d+$/.test(w)) numbers.push(w.replace("#", ""));
  }
  return { numbers, repo, labels };
}

/** A gh command's flip, or null: { numbers, repo } when it is `gh [-R x] issue edit … --add-label …review…`. */
function readGh(words) {
  let i = 1;
  let repo = null;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-R" || w === "--repo") repo = slugOf(words[++i]);
    else if (w.startsWith("--repo=")) repo = slugOf(w.slice(7));
    else if (/^-R./.test(w)) repo = slugOf(w.slice(2));
    i++;
  }
  if (words[i] !== "issue" || words[i + 1] !== "edit") return null;
  const a = editArgs(words, i + 2);
  if (!a.labels.includes("review")) return null;
  return { numbers: a.numbers, repo: a.repo || repo };
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
 * Every review flip in a command: { numbers, repo, cds, allow, gitC }. cds are the `cd` arguments before it, in order
 * (unresolved, so resolveFlip can refuse what it can't resolve; a pushd's carries PUSHD); allow is the bypass as a
 * prefix, through `env`, or from an earlier `export`; repo comes from -R, an issue URL or GH_REPO, in that order; gitC
 * lists `git -C` dirs with the cds they ran after. A `bash -c '<script>'` is read as a child shell (it starts where its
 * parent is and inherits what was exported); `eval` runs in the same shell. A subshell's cd, export or unset ends with
 * it. It reads every command as if it runs: plan() decides whether that reading can be trusted.
 */
function parseFlips(command, ctx = initialCtx(), depth = 0) {
  const flips = [];
  const scopes = [];
  const { cds, gitC } = ctx;
  for (const item of simpleCommands(command)) {
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
      else if (arg !== undefined) cds.push(PUSHD + arg);
    } else if (head === "popd") {
      cds.push(POPD);
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
      if (flip) flips.push({ numbers: flip.numbers, repo: flip.repo || ghRepo || null, cds: here, allow, gitC: [...gitC] });
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

const gitOut = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** The git top level of dir (its real path), or null when dir isn't in a repo. */
function topLevel(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return gitOut(["rev-parse", "--show-toplevel"], dir);
}

/** The repo's main checkout (a worktree's is the parent of its common dir), or its top level. */
function mainCheckout(top) {
  const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], top);
  return common && path.basename(common) === ".git" ? path.dirname(common) : top;
}

/** True when one of the repo's remotes is owner/name on any host (https or ssh). */
function hasRemote(top, slug) {
  const urls = gitOut(["remote", "-v"], top) || "";
  const want = slug.toLowerCase();
  return urls.split("\n").some((l) => {
    const url = (l.split(/\s+/)[1] || "").toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    return url.endsWith(`/${want}`) || url.endsWith(`:${want}`);
  });
}

/** A local checkout of slug near any of dirs (the dir's repo, its main checkout, a sibling or child named for it). */
function findCheckout(slug, dirs) {
  const name = slug.split("/")[1];
  const looked = [];
  for (const here of dirs) {
    const top = topLevel(here);
    const base = top ? mainCheckout(top) : here;
    for (const c of [top, base, path.join(path.dirname(base), name), path.join(here, name)].filter(Boolean)) {
      if (looked.includes(c)) continue;
      looked.push(c);
      const t = topLevel(c);
      if (t && hasRemote(t, slug)) return { dir: t, looked };
    }
  }
  return { dir: null, looked };
}

const expand = (p, home) => String(p).replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
/** A word as the user wrote it, for a message. */
const shown = (w) => String(w).split(DYN).join("$(…)");

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Walk cds from cwd. A cd it can't resolve to an existing dir (an expansion, a missing dir) doesn't move it: the walk
 * keeps the last dir it could resolve and records it in unresolved. Only a pushd puts a dir on the stack: popd with
 * nothing pushed fails in the shell, and stays put here.
 */
function walk(cds, cwd, home, unresolved) {
  let here = cwd;
  let prev = cwd;
  const stack = [];
  for (const raw of cds) {
    if (raw === POPD) {
      if (stack.length) [prev, here] = [here, stack.pop()];
      continue;
    }
    if (raw === "-") {
      [prev, here] = [here, prev];
      continue;
    }
    const push = raw.startsWith(PUSHD);
    const d = push ? raw.slice(1) : raw;
    const e = expand(d, home);
    const to = DYNAMIC.test(e) ? null : path.resolve(here, e);
    if (!to || !isDir(to)) {
      unresolved.push(`can't resolve \`${push ? "pushd" : "cd"} ${shown(d)}\` to a dir`);
      continue;
    }
    if (push) stack.push(here);
    [prev, here] = [here, to];
  }
  return here;
}

/**
 * Where a flip's issues live: { dir, notes, unresolved } (dir a repo top level, or the dir it runs in), or
 * { dir: null, why, notes, unresolved } when it names a repo with no local checkout here. unresolved lists the cds and
 * -R the walk couldn't read (it kept the last dir it could, fail closed); notes say so, and name a `git -C` in the
 * command that is a different repo than the one gated.
 */
function resolveFlip(flip, cwd, home = os.homedir()) {
  const notes = [];
  const unresolved = [];
  const here = walk(flip.cds, cwd, home, unresolved);
  for (const u of unresolved) notes.push(`${u}, so it doesn't move the gate (reading ${here})`);
  const top = topLevel(here);
  let dir = top || here;
  let repo = flip.repo;
  if (repo && DYNAMIC.test(repo)) {
    unresolved.push(`can't read the repo \`${shown(repo)}\` names`);
    notes.push(`can't read the repo \`${shown(repo)}\` names, so the gate reads ${dir}`);
    repo = null;
  }
  if (repo) {
    const found = findCheckout(repo, [here]);
    if (!found.dir) return { dir: null, why: `no local checkout of ${repo} found (looked at ${found.looked.join(", ")})`, notes, unresolved };
    dir = found.dir;
  }
  for (const g of flip.gitC) {
    if (DYNAMIC.test(expand(g.dir, home))) continue;
    const at = walk(g.cds, cwd, home, []);
    const other = topLevel(path.resolve(at, expand(g.dir, home)));
    if (other && other !== dir) {
      notes.push(`\`git -C ${g.dir}\` doesn't change the repo gh edits: issue ${flip.numbers.join(", ") || "?"} is in ${dir} (git -C names ${other})`);
      break;
    }
  }
  return { dir, notes, unresolved };
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
  for (const m of String(command).matchAll(/\bgh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)?\s+issue\s+edit\b/g)) {
    const rest = command.slice(m.index + m[0].length).split("\n")[0];
    const words = simpleCommands(rest).find(Array.isArray) || [];
    const a = editArgs(words, 0);
    if (a.labels.includes("review")) res.push(a);
  }
  return res;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "coproc", "!"]);
const AFTER_SEMI = new Set([";", "\n"]);

/** Why a command isn't a simple script (added to reasons), read the way parseFlips reads it, child shells included. */
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

const unquote = (w) => String(w).replace(/^(['"])(.*)\1$/s, "$2").replace(/\\(.)/g, "$1");
const RAW_CD = /(?:^|[\s;&|(){}`'"])(?:cd|pushd)(?:\s+-[A-Za-z@]+)*(?:\s+--)?\s+("[^"\n]*"|'[^'\n]*'|(?:\\.|[^\s;&|()`<>'"])+)/g;
const BARE_CD = /(?:^|[\s;&|(){}`'"])cd\s*(?=$|[;&|)}\n`'"])/m;
const RAW_CHDIR = /\benv\b[^;&|\n]*?\s(?:-C|--chdir)(?:=|\s+)("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g;
const RAW_HOME = /(?:^|[\s;&|(])(?:export\s+)?HOME=("[^"\n]*"|'[^'\n]*'|[^\s;&|()]+)/g;
const RAW_SLUGS = [
  /(?:^|\s)(?:-R|--repo)(?:=|\s+)?("[^"\n]*"|'[^'\n]*'|[^\s;&|()'"]+)/g,
  /\bGH_REPO=("[^"\n]*"|'[^'\n]*'|[^\s;&|()'"]+)/g,
  /https?:\/\/[^\s/'"]+\/([^\s/'"]+\/[^\s/'"]+)\/issues\/\d+/g,
];

/**
 * Every dir and repo a command's text could point gh at, for a script too complex to pick one: the session repo; each
 * cd, pushd and `env -C` dir (resolved from the cwd and from each other, wherever the text sits: a heredoc, a comment, a
 * function body); and a local checkout of each -R, GH_REPO and issue-URL repo. { dirs, unchecked: [{repo, why}] }
 */
function reachable(command, { cwd, home, env, flips }) {
  const s = String(command);
  const homes = new Set([home]);
  for (const m of s.matchAll(RAW_HOME)) homes.add(unquote(m[1]));
  const args = new Set();
  for (const m of s.matchAll(RAW_CD)) args.add(unquote(m[1]));
  for (const m of s.matchAll(RAW_CHDIR)) args.add(unquote(m[1]));
  if (BARE_CD.test(s)) args.add("~");
  for (const f of flips) for (const d of f.cds) if (d !== POPD && d !== "-") args.add(d.startsWith(PUSHD) ? d.slice(1) : d);
  const bases = [cwd];
  for (let round = 0; round < 3; round++) {
    const before = bases.length;
    for (const a of args) {
      for (const h of homes) {
        const e = expand(a, h);
        if (DYNAMIC.test(e)) continue;
        for (const b of path.isAbsolute(e) ? [null] : [...bases]) {
          const to = b === null ? path.resolve(e) : path.resolve(b, e);
          if (!bases.includes(to) && isDir(to)) bases.push(to);
        }
      }
    }
    if (bases.length === before) break;
  }
  const dirs = [];
  const add = (d) => d && !dirs.includes(d) && dirs.push(d);
  add(topLevel(cwd) || cwd);
  add(cwd);
  for (const b of bases) add(topLevel(b) || b);
  const slugs = new Set();
  for (const f of flips) if (f.repo && !DYNAMIC.test(f.repo)) slugs.add(f.repo);
  if (env.GH_REPO && slugOf(env.GH_REPO)) slugs.add(slugOf(env.GH_REPO));
  for (const re of RAW_SLUGS) {
    for (const m of s.matchAll(re)) {
      const slug = slugOf(unquote(m[1]));
      if (slug && !DYNAMIC.test(slug)) slugs.add(slug);
    }
  }
  const unchecked = [];
  for (const slug of slugs) {
    const found = findCheckout(slug, bases);
    if (found.dir) add(found.dir);
    else unchecked.push({ repo: slug, why: `no local checkout of ${slug} found (looked at ${found.looked.join(", ")})` });
  }
  return { dirs, unchecked };
}

const NO_NUMBER = "this looks like a flip to `review` but the issue number couldn't be parsed";

/**
 * What the witness gate checks for a command: {
 *   flip: is there a review flip at all,
 *   mode: "simple" (each flip gated where it runs) | "complex" (every issue in every repo the text could reach),
 *   reasons: why it is complex, flips: parseFlips' read,
 *   gates: [{n, dir}] to check (block if any fails), block: [why] to block outright (a flip with no number),
 *   unchecked: [{numbers, repo, why}] named repos with no local checkout, bypassed: issue numbers the text bypass let
 *   through (simple scripts only), notes: what to tell the user,
 * }
 * A complex script is gated in the session repo too, so it is never looser than the pre-#27 gate (legacyFlip, in the
 * cwd). The backstop counts per flip: a number the old regex or a raw scan sees that the parser didn't makes it complex.
 */
function plan(command, { cwd = process.cwd(), env = {}, home = os.homedir() } = {}) {
  const old = legacyFlip(command);
  const flips = parseFlips(command, initialCtx(env));
  const out = { flip: false, mode: "simple", reasons: [], flips, gates: [], block: [], unchecked: [], bypassed: [], notes: [] };
  const raw = rawFlips(command);
  if (!flips.length && !old && !raw.length) return out;
  out.flip = true;
  const gate = (n, dir) => {
    if (!out.gates.some((g) => g.n === n && g.dir === dir)) out.gates.push({ n, dir });
  };
  const reasons = new Set();
  shape(command, reasons);
  const parsed = new Set(flips.flatMap((f) => f.numbers));
  const seen = [...new Set([...(old && old.n ? [old.n] : []), ...raw.flatMap((r) => r.numbers)])];
  if (!flips.length || raw.length > flips.length || seen.some((n) => !parsed.has(n))) reasons.add("a flip the parser can't read");
  const session = topLevel(cwd) || cwd;

  if (!reasons.size) {
    const resolved = flips.map((f) => (f.allow || !f.numbers.length ? null : resolveFlip(f, cwd, home)));
    for (const r of resolved) for (const u of r ? r.unresolved : []) reasons.add(u);
    if (!reasons.size) {
      flips.forEach((f, i) => {
        const r = resolved[i];
        if (f.allow) return out.bypassed.push(...(f.numbers.length ? f.numbers : ["?"]));
        if (!f.numbers.length) return out.block.push(NO_NUMBER);
        out.notes.push(...r.notes);
        if (!r.dir) return out.unchecked.push({ numbers: f.numbers, repo: f.repo, why: r.why });
        for (const n of f.numbers) gate(n, r.dir);
        if (!f.repo && !topLevel(r.dir)) for (const n of f.numbers) gate(n, session); // gh outside a repo: as main did
      });
      return out;
    }
  }

  out.mode = "complex";
  out.reasons = [...reasons];
  const numbers = [...new Set([...parsed, ...seen])];
  if ((old && old.n === null) || flips.some((f) => !f.numbers.length) || raw.some((r) => !r.numbers.length)) out.block.push(NO_NUMBER);
  const { dirs, unchecked } = reachable(command, { cwd, home, env, flips });
  for (const n of numbers) for (const d of dirs) gate(n, d);
  for (const u of unchecked) out.unchecked.push({ numbers, ...u });
  out.notes.push(
    `this command is too complex to pick one repo (${out.reasons.join("; ")}), so issue ${numbers.join(", ") || "?"} is checked in every repo it could reach: ${dirs.join(", ")}`
  );
  if (flips.some((f) => f.allow)) out.notes.push("CATALINA_WITNESS_ALLOW=1 on this command is ignored: it counts only as a prefix or export in a simple script");
  return out;
}

module.exports = { plan, parseFlips, resolveFlip, simpleCommands, initialCtx, legacyFlip, slugOf };
