/**
 * Catalina — which repo a `gh issue edit … --add-label review` edits (#27).
 *
 * A hook runs in the session's cwd, but a command can aim gh elsewhere: `cd <dir> && gh …`, `gh -R owner/name …`, or an
 * issue URL. gh reads those and nothing else (not `git -C`), so the witness gate reads the same.
 *
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

/**
 * Split into simple commands of words, quote-aware, in order: [[word…] | {open} | {close}…]. Separators: && || ; | &
 * newline. `( … )`, `$( … )`, `<( … )` and backticks are subshells: their commands come between an {open} and a
 * {close}, so a cd inside doesn't outlive them. A substitution leaves DYN in the word it sat in. `{ }` is not a subshell.
 */
function simpleCommands(command) {
  const out = [];
  const frames = [];
  let words = [];
  let word = null; // null: between words
  const s = String(command);
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const next = () => {
    end();
    if (words.length) out.push(words);
    words = [];
  };
  const open = (kind) => {
    if (kind === "sub") {
      next();
      frames.push({ kind });
    } else {
      frames.push({ kind, words, word });
      words = [];
      word = null;
    }
    out.push({ open: true });
  };
  const close = () => {
    const f = frames.pop();
    next();
    out.push({ close: true });
    if (f.kind !== "sub") {
      words = f.words;
      word = (f.word ?? "") + DYN;
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
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      end();
    } else if (c === "(") {
      open("sub");
    } else if (c === ")") {
      if (frames.length && frames[frames.length - 1].kind !== "tick") close();
      else next();
    } else if ((c === "{" || c === "}") && word === null && (i + 1 >= s.length || /[\s;&|)]/.test(s[i + 1]))) {
      next(); // a group opens or closes a command, but shares the shell
    } else {
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

/** owner/name from a -R or GH_REPO value (`owner/name` or `host/owner/name`); a value with an expansion is kept as is. */
const slugOf = (v) => {
  if (DYNAMIC.test(String(v))) return String(v);
  const parts = String(v).replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
};

const ISSUE_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)\b/;

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
  const numbers = [];
  const labels = [];
  for (let j = i + 2; j < words.length; j++) {
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
  if (!labels.includes("review")) return null;
  return { numbers, repo };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Commands that run the command after them (with their own options in between). */
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "timeout", "gtimeout", "nice", "ionice", "sudo", "doas", "xargs", "stdbuf", "caffeinate", "noglob"]);
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
    if (WRAPPERS.has(head)) {
      const j = words.findIndex((w, k) => k > 0 && isTarget(w, head === "command" || head === "builtin"));
      if (j < 0) return { words: [], assigns, chdir };
      if (head === "sudo" || head === "doas") for (const w of words.slice(1, j)) if (ASSIGN.test(w)) assigns.push(w);
      words = words.slice(j);
      continue;
    }
    break;
  }
  return { words, assigns, chdir };
}

/** The parse state a command starts in: the hook's own env can name the repo (GH_REPO) for gh too. */
const initialCtx = (env = {}) => ({ cds: [], gitC: [], exported: false, ghRepo: env.GH_REPO ? slugOf(env.GH_REPO) : null });

/**
 * Every review flip in a command: { numbers, repo, cds, allow, gitC }. cds are the `cd` arguments before it, in order
 * (unresolved, so resolveFlip can refuse what it can't resolve); allow is the bypass as a prefix, through `env`, or
 * from an earlier `export`; repo comes from -R, an issue URL or GH_REPO, in that order; gitC lists `git -C` dirs with
 * the cds they ran after. A `bash -c '<script>'` is read as a child shell (it starts where its parent is and inherits
 * what was exported); `eval` runs in the same shell. A subshell's cd, export or unset ends with it.
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
      cds.push(arg ?? "~");
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
      const c = words.findIndex((w, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (c > 0 && words[c + 1] !== undefined) {
        flips.push(...parseFlips(words[c + 1], { cds: here, gitC: [...gitC], exported: allow, ghRepo }, depth + 1));
      }
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
 * keeps the last dir it could resolve, fail closed, and pushes a note.
 */
function walk(cds, cwd, home, notes) {
  let here = cwd;
  let prev = cwd;
  const hist = [];
  for (const d of cds) {
    if (d === POPD) {
      if (hist.length) [prev, here] = [here, hist.pop()];
      continue;
    }
    if (d === "-") {
      [prev, here] = [here, prev];
      continue;
    }
    const e = expand(d, home);
    const to = DYNAMIC.test(e) ? null : path.resolve(here, e);
    if (!to || !isDir(to)) {
      notes.push(`can't resolve \`cd ${shown(d)}\` to a dir, so it doesn't move the gate (reading ${here})`);
      continue;
    }
    hist.push(here);
    [prev, here] = [here, to];
  }
  return here;
}

/**
 * Where a flip's issues live: { dir, notes } (dir a repo top level, or the dir it runs in), or { dir: null, why, notes }
 * when it names a repo with no local checkout here. notes say what the gate couldn't read and fell back on, and when a
 * `git -C` in the command is a different repo than the one gated.
 */
function resolveFlip(flip, cwd, home = os.homedir()) {
  const notes = [];
  const here = walk(flip.cds, cwd, home, notes);
  const top = topLevel(here);
  let dir = top || here;
  let repo = flip.repo;
  if (repo && DYNAMIC.test(repo)) {
    notes.push(`can't read the repo \`${shown(repo)}\` names, so the gate reads ${dir}`);
    repo = null;
  }
  if (repo) {
    const base = top ? mainCheckout(top) : here;
    const name = repo.split("/")[1];
    const candidates = [top, base, path.join(path.dirname(base), name), path.join(here, name)].filter(Boolean);
    dir = null;
    for (const c of candidates) {
      const t = topLevel(c);
      if (t && hasRemote(t, repo)) {
        dir = t;
        break;
      }
    }
    if (!dir) return { dir: null, why: `no local checkout of ${repo} found (looked at ${[...new Set(candidates)].join(", ")})`, notes };
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
  return { dir, notes };
}

module.exports = { parseFlips, resolveFlip, simpleCommands, initialCtx };
